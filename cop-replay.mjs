/*
 * cop-replay.mjs — the coprocessor's current matrix, replayed from the words the
 * i960 wrote to its FIFO.
 *
 * `dl-verify.mjs` used to apply push, pop, translate, scale and the three angle
 * ops and treat everything else as leaving the matrix alone. That is enough for
 * a stage part bracketed in its own push/pop off camera_init's view, and not for
 * anything that loads a matrix, resets one, or stores one to read back later —
 * which is how canyon_env_disp, draw_sphynx_head, giant_wing_disp and the whole
 * fighter rig are drawn. This applies every command that writes the current
 * matrix, as the firmware does it, including the four places the stream stores
 * a matrix and reads it back:
 *
 *   unit     0x35 store, 0x36 load, 0x37 compose — by (player, slot * 12)
 *   inner    0x43 store, 0x44 load, 0x45 / 0x46 compose — by index
 *   TGP      0x67 store, 0x69 load its 3x3 turned by a facing — by address,
 *            0x3A00 for P1 and 0x3B00 for P2, twelve words a slot
 *   stack    0x01 push, 0x02 pop, and the push op 0x62 makes before it builds
 *            the body
 *
 * The semantics are m2-hle2's port of the firmware (src/board/sharc_exec.h,
 * tools/lib/cop-replay.mjs), which is held word for word against SHARC-side
 * MAME captures there. Two of the listing's own comments read the wrong way and
 * are followed here as the code runs:
 *
 *   _L201EA (0x0B, 0x37, 0x45)  current · M, a post-multiply
 *   _L2021F (0x46, 0x47)        M · current
 *
 * The replay cannot know a matrix the stream does not carry: a bank entry it
 * never saw stored, a shadow projection built off a floor height in the
 * coprocessor's RAM, an IK solve. Those mark the matrix `tainted` until a pop or
 * a load clears it, and a caller comparing numbers leaves a tainted draw out
 * rather than guess at it.
 *
 * The matrix is kept the way the coprocessor keeps it — three columns, then the
 * translation — and handed out row-major with column vectors, which is
 * `dl-verify.mjs`'s convention. The default arithmetic is double precision with
 * libm trig, which is what the explorer's op lists compare against without a
 * rounding difference of their own; `trig` swaps in another sine and cosine of
 * a 16-bit angle, such as `js/pose.js`'s reading of the coprocessor ROM.
 */

const f32buf = new DataView(new ArrayBuffer(4));
export function f32(w) { f32buf.setUint32(0, w >>> 0, true); return f32buf.getFloat32(0, true); }

const s16 = (w) => (w << 16) >> 16;

/* Commands that leave the current matrix at something the stream does not say:
 * a solve or a table walk inside the coprocessor. 0x62 and 0x69 are not here,
 * because both are built entirely from their arguments and what the stream
 * stored earlier. */
const OPAQUE = new Set([0x41, 0x42, 0x4a, 0x54, 0x55, 0x6b, 0x79, 0x7a, 0x7c, 0x7e, 0x83, 0x84]);

export class CopReplay {
    /**
     * @param {object} [o]
     * @param {{sin: function, cos: function}} [o.trig]  sine and cosine of a 16-bit angle
     */
    constructor({ trig = null } = {}) {
        this.sin = trig?.sin ?? ((w) => Math.sin(s16(w) * Math.PI / 32768));
        this.cos = trig?.cos ?? ((w) => Math.cos(s16(w) * Math.PI / 32768));
        this.R = [1, 0, 0, 0, 1, 0, 0, 0, 1];
        this.T = [0, 0, 0];
        this.tainted = false;
        this.base3x3 = false;        /* the 3x3 was reset since the last load */
        this.stack = [];
        this.banks = { unit: new Map(), inner: new Map(), tgp: new Map() };
    }

    state() { return { R: this.R.slice(), T: this.T.slice(), tainted: this.tainted, base3x3: this.base3x3 }; }
    restore(s) { this.R = s.R.slice(); this.T = s.T.slice(); this.tainted = s.tainted; this.base3x3 = s.base3x3; }

    /** The current matrix, row-major 4x4. */
    matrix(R = this.R, T = this.T) {
        return [R[0], R[3], R[6], T[0], R[1], R[4], R[7], T[1], R[2], R[5], R[8], T[2], 0, 0, 0, 1];
    }
    /** The matrix at the bottom of the stack: the view, for a stage draw. */
    base() { return this.stack.length ? this.matrix(this.stack[0].R, this.stack[0].T) : this.matrix(); }
    /** A stored bank entry as { R, T, tainted }, or undefined. */
    stored(bank, key) { return this.banks[bank].get(String(key)); }

    setRowMajor(m) {
        this.R = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]];
        this.T = [m[3], m[7], m[11]];
    }

    #col(c) { return this.R.slice(c * 3, c * 3 + 3); }
    #setCol(c, v) { this.R[c * 3] = v[0]; this.R[c * 3 + 1] = v[1]; this.R[c * 3 + 2] = v[2]; }
    /* Post-multiply by a rotation in the plane of columns i and j (cpres1 PM
     * 0x201AA..0x201D4): ang_x is (1, 2, -1), ang_y (0, 2, +1), ang_z (0, 1, -1). */
    #rot(w, i, j, sign) {
        const c = this.cos(w), s = this.sin(w);
        const a = this.#col(i), b = this.#col(j);
        this.#setCol(i, a.map((v, k) => c * v + sign * s * b[k]));
        this.#setCol(j, a.map((v, k) => -sign * s * v + c * b[k]));
    }
    /* Pre-multiply by ang_y: every column turned about world Y. */
    #preRotY(w) {
        const c = this.cos(w), s = this.sin(w);
        for (let col = 0; col < 3; col++) {
            const x = this.R[col * 3], z = this.R[col * 3 + 2];
            this.R[col * 3] = c * x - s * z;
            this.R[col * 3 + 2] = s * x + c * z;
        }
    }

    /** Apply one command: its opcode byte and its argument words. */
    apply(op, a) {
        const cols12 = () => this.matrix(a.slice(0, 9).map(f32), a.slice(9, 12).map(f32));
        switch (op) {
            case 0x01: this.stack.push(this.state()); break;                          /* Fn_push_matrix */
            case 0x02: if (this.stack.length) this.restore(this.stack.pop()); break;   /* Fn_pop_matrix */
            case 0x03:                                                                 /* Fn_base_matrix */
                this.R = [1, 0, 0, 0, 1, 0, 0, 0, 1]; this.T = [0, 0, 0];
                this.tainted = false; this.base3x3 = false; break;
            case 0x04:                                                                 /* Fn_load_matrix: the slot's raw words */
                this.R = a.slice(0, 9).map(f32); this.T = a.slice(9, 12).map(f32);
                this.tainted = false; this.base3x3 = false; break;
            case 0x06:                                                                 /* Fn_trans */
                for (let c = 0; c < 3; c++) {
                    const v = f32(a[c]);
                    for (let w = 0; w < 3; w++) this.T[w] += v * this.R[c * 3 + w];
                }
                break;
            case 0x07:                                                                 /* Fn_scale: column by column */
                for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) this.R[c * 3 + r] *= f32(a[c]);
                break;
            case 0x08: this.#rot(a[0], 1, 2, -1); break;                               /* Fn_x_rot */
            case 0x09: this.#rot(a[0], 0, 2, 1); break;                                /* Fn_y_rot */
            case 0x0a: this.#rot(a[0], 0, 1, -1); break;                               /* Fn_z_rot */
            case 0x0b: this.setRowMajor(mul4(this.matrix(), cols12())); break;         /* Fn_mul_matrix */
            case 0x0c: { const m = inv4(this.matrix()); if (m) this.setRowMajor(m); break; } /* Fn_inv_matrix */
            case 0x0d: this.T = [0, 0, 0]; break;                                      /* Fn_base_point */
            case 0x0e: this.T = a.slice(0, 3).map(f32); break;                         /* Fn_load_point */
            case 0x10: this.R = [1, 0, 0, 0, 1, 0, 0, 0, 1]; this.base3x3 = true; break; /* Fn_base_3x3 */
            case 0x11: this.R = a.slice(0, 9).map(f32); break;                         /* Fn_load_3x3 */
            case 0x3f: this.#rot(a[0], 0, 1, -1); this.#rot(a[1], 0, 2, 1); this.#rot(a[2], 1, 2, -1); break; /* Fn_zyx_rot, sent (z, y, x) */
            case 0x47: this.setRowMajor(mul4(cols12(), this.matrix())); break;         /* Fn_mul_matrix_rev */
            case 0x62: {
                /* set_body_matrix (cpres1 PM 0x211E1): an internal push, then the
                 * waist position, the body euler built outright from args 3..5,
                 * and the facing post-multiplied as ang_y, ang_x, ang_z. */
                this.stack.push(this.state());
                const [c3, s3] = [this.cos(a[3]), this.sin(a[3])];
                const [c4, s4] = [this.cos(a[4]), this.sin(a[4])];
                const [c5, s5] = [this.cos(a[5]), this.sin(a[5])];
                this.R = [
                    c4 * c3, -c4 * s3, s4,
                    s3 * c5 + c3 * s4 * s5, c3 * c5 - s3 * s4 * s5, -c4 * s5,
                    s3 * s5 - c3 * s4 * c5, c3 * s5 + s3 * s4 * c5, c4 * c5,
                ];
                this.T = a.slice(0, 3).map(f32);
                this.#rot(a[6], 0, 2, 1); this.#rot(a[7], 1, 2, -1); this.#rot(a[8], 0, 1, -1);
                this.tainted = false; this.base3x3 = false;
                break;
            }
            case 0x69: {
                /* load_anim_frame (cpres1 PM 0x21237): the 3x3 a TGP slot was
                 * stored with, turned about world Y by the fighter's facing. The
                 * translation stays where the stream has put it. */
                const e = this.banks.tgp.get(String(a[0]));
                if (!e) { this.tainted = true; break; }
                this.R = e.R.slice();
                this.#preRotY(a[1]);
                this.tainted = e.tainted; this.base3x3 = false;
                break;
            }
            case 0x35: case 0x43: case 0x67: {                                         /* store into a bank */
                const bank = op === 0x35 ? this.banks.unit : op === 0x43 ? this.banks.inner : this.banks.tgp;
                bank.set(op === 0x67 ? String(a[0]) : a.join(','), this.state());
                break;
            }
            case 0x36: case 0x44: {                                                    /* load from a bank */
                const e = (op === 0x36 ? this.banks.unit : this.banks.inner).get(a.join(','));
                if (e) { this.restore(e); this.base3x3 = false; } else this.tainted = true;
                break;
            }
            case 0x37: case 0x45: case 0x46: {                                         /* compose with a bank entry */
                const e = (op === 0x37 ? this.banks.unit : this.banks.inner).get(a.join(','));
                if (!e) { this.tainted = true; break; }
                const M = this.matrix(e.R, e.T), C = this.matrix();
                this.setRowMajor(op === 0x46 ? mul4(M, C) : mul4(C, M));
                this.tainted = this.tainted || e.tainted;
                break;
            }
            case 0x6b:
                /* Fn_calc_unit_2_fast: the two-bone IK. It stores the two bones it
                 * solves to the TGP addresses in args 14 and 15, and leaves the
                 * current matrix at the solve. */
                for (const k of [a[14], a[15]]) if (k !== undefined) this.banks.tgp.set(String(k), { ...this.state(), tainted: true });
                this.tainted = true;
                break;
            case 0x73:                                                                 /* Fn_kage_mat */
                /* Pushes and pops round its own work; inner slots 0..2 take shadow
                 * projections off the floor height in the coprocessor's RAM. */
                for (const k of ['0', '1', '2']) this.banks.inner.set(k, { ...this.state(), tainted: true });
                break;
            case 0x74:                                                                 /* Fn_kage_poly */
                /* Leaves a part's shadow matrix pushed for the draw; the i960 pops. */
                this.stack.push(this.state());
                this.tainted = true;
                break;
            default:
                if (OPAQUE.has(op)) this.tainted = true;
        }
    }
}

function mul4(a, b) {
    const o = new Array(16);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c];
        o[r * 4 + c] = s;
    }
    return o;
}

function inv4(m) {
    const a = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
    const d = a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]);
    if (!(Math.abs(d) > 1e-20)) return null;
    const c = [(a[4] * a[8] - a[5] * a[7]) / d, -(a[1] * a[8] - a[2] * a[7]) / d, (a[1] * a[5] - a[2] * a[4]) / d,
        -(a[3] * a[8] - a[5] * a[6]) / d, (a[0] * a[8] - a[2] * a[6]) / d, -(a[0] * a[5] - a[2] * a[3]) / d,
        (a[3] * a[7] - a[4] * a[6]) / d, -(a[0] * a[7] - a[1] * a[6]) / d, (a[0] * a[4] - a[1] * a[3]) / d];
    const t = [m[3], m[7], m[11]];
    return [c[0], c[1], c[2], -(c[0] * t[0] + c[1] * t[1] + c[2] * t[2]), c[3], c[4], c[5], -(c[3] * t[0] + c[4] * t[1] + c[5] * t[2]),
        c[6], c[7], c[8], -(c[6] * t[0] + c[7] * t[1] + c[8] * t[2]), 0, 0, 0, 1];
}
