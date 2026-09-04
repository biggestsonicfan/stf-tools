/*
 * dl-rig.mjs — the fighter's own matrices, replayed out of a display list.
 *
 * `dl-verify.mjs` replays a *stage* list, where every part is placed by
 * explicit transform commands. A fighter is not: `calc_rob_angle_cont` builds
 * each part and hands it to the geometry coprocessor with op 0x67, whose one
 * argument is a TGP matrix slot — 0x3A00 for P1 and 0x3B00 for P2, stepping
 * 0x0C a slot, which is twelve words, a 3x4. So the slots cannot be read back
 * out of memory (nothing in either ADSP's data space holds them as floats), but
 * they can be rebuilt: replay the matrix ops and snapshot the current matrix
 * every time a 0x67 goes past.
 *
 * The ops that move the matrix, and nothing else does:
 *
 *   0x01 push          0x02 pop
 *   0x06 translate     three floats
 *   0x08 0x09 0x0A     ang_x, ang_y, ang_z, one 16-bit binary radian each
 *   0x3F               a whole euler, three angles, sent back to front
 *                      (`ldis 4(g5), 2(g5), 0(g5)` in 0x30FE8) so the args
 *                      arrive as (z, y, x)
 *
 * Everything else in the stream is material, texture or geometry and leaves the
 * matrix alone — which this checks rather than assumes, by holding the body
 * slot's translation against the motion's own waist position.
 *
 * This is what lets the chest and head be checked at all. The limbs arrive as
 * `ik_2bone` arguments and `test-motion-mame.mjs` compares those
 * directly, but the chest and head are only ever a matrix, so until now nothing
 * above the waist was held against the board.
 */

import { segment, f32, ang, loadCapture } from './dl-verify.mjs';

export const TGP_P1 = 0x3a00, TGP_P2 = 0x3b00, TGP_STRIDE = 0x0c;
export const SLOT_COUNT = 16;

/** Which player and slot a TGP address names, or null if it is neither's. */
export function slotOf(addr) {
    for (const [player, base] of [[0, TGP_P1], [1, TGP_P2]]) {
        const n = (addr - base) / TGP_STRIDE;
        if (Number.isInteger(n) && n >= 0 && n < SLOT_COUNT) return { player, slot: n };
    }
    return null;
}

const I = () => [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];   /* 3x3 then translation */

/* Column-major post-multiplies, the coprocessor's own order — the same three
 * `js/pose.js` uses, so a matrix from here can be compared with one from there
 * element for element. */
function rotZ(m, c, s) { for (let i = 0; i < 3; i++) { const x = m[i], y = m[i + 3]; m[i] = c * x - s * y; m[i + 3] = s * x + c * y; } }
function rotY(m, c, s) { for (let i = 0; i < 3; i++) { const x = m[i], z = m[i + 6]; m[i] = c * x + s * z; m[i + 6] = c * z - s * x; } }
function rotX(m, c, s) { for (let i = 0; i < 3; i++) { const y = m[i + 3], z = m[i + 6]; m[i + 3] = c * y - s * z; m[i + 6] = s * y + c * z; } }

const COS = new Float32Array(256), SIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
    COS[i] = Math.fround(Math.cos((i * 2 * Math.PI) / 256));
    SIN[i] = Math.fround(Math.sin((i * 2 * Math.PI) / 256));
}
const cosA = (a) => COS[(a >>> 8) & 0xff], sinA = (a) => SIN[(a >>> 8) & 0xff];
const raw = (w) => w & 0xffff;

/*
 * Op 0x62, the body matrix, built exactly as `js/pose.js` builds it: args 0..2
 * the waist position, 3..5 the body euler as (z, y, x), 6..8 the fighter's
 * facing. Those arguments are already held against the board frame for frame by
 * `test-motion-mame.mjs`, so taking them here is not circular -- what is
 * being checked is everything the stream builds *on top* of the body, which is
 * the chest and the head.
 */
function setBody(a) {
    const c3 = cosA(raw(a[3])), s3 = sinA(raw(a[3]));
    const c4 = cosA(raw(a[4])), s4 = sinA(raw(a[4]));
    const c5 = cosA(raw(a[5])), s5 = sinA(raw(a[5]));
    const m = new Array(12).fill(0);
    m[0] = c4 * c3;                 m[1] = -c4 * s3;                m[2] = s4;
    m[3] = s3 * c5 + c3 * s4 * s5;  m[4] = c3 * c5 - s3 * s4 * s5;  m[5] = -c4 * s5;
    m[6] = s3 * s5 - c3 * s4 * c5;  m[7] = c3 * s5 + s3 * s4 * c5;  m[8] = c4 * c5;
    rotY(m, cosA(raw(a[6])), sinA(raw(a[6])));
    rotX(m, cosA(raw(a[7])), sinA(raw(a[7])));
    rotZ(m, cosA(raw(a[8])), sinA(raw(a[8])));
    m[9] = f32(a[0]); m[10] = f32(a[1]); m[11] = f32(a[2]);
    return m;
}

/** Every 0x67 store in one frame, as { player, slot, r:[9], t:[3] }. */
export function rigFrame(words) {
    const cmds = segment(words);
    let m = I();
    const stack = [];
    const out = [];
    for (const c of cmds) {
        const a = c.args ?? [];
        switch (c.op) {
            case 0x01: stack.push(m.slice()); break;
            case 0x02: if (stack.length) m = stack.pop(); break;
            case 0x06: {
                const v = [f32(a[0]), f32(a[1]), f32(a[2])];
                for (let i = 0; i < 3; i++)
                    m[9 + i] += v[0] * m[i] + v[1] * m[i + 3] + v[2] * m[i + 6];
                break;
            }
            case 0x08: rotX(m, cosA(raw(a[0])), sinA(raw(a[0]))); break;
            case 0x09: rotY(m, cosA(raw(a[0])), sinA(raw(a[0]))); break;
            case 0x0a: rotZ(m, cosA(raw(a[0])), sinA(raw(a[0]))); break;
            case 0x3f: {
                /* sent (z, y, x) */
                rotZ(m, cosA(raw(a[0])), sinA(raw(a[0])));
                rotY(m, cosA(raw(a[1])), sinA(raw(a[1])));
                rotX(m, cosA(raw(a[2])), sinA(raw(a[2])));
                break;
            }
            case 0x62: m = setBody(a); break;
            case 0x67: {
                const at = slotOf(raw(a[0]) | 0);
                if (at) out.push({ ...at, r: m.slice(0, 9), t: m.slice(9, 12) });
                break;
            }
            default: break;
        }
    }
    return out;
}

/** Per frame, the slots each player's rig was stored into. */
export function rigFrames(prefix) {
    const { frames, meta } = loadCapture(prefix);
    return frames.map((f, i) => ({
        marks: meta.marks[i + 1] ?? meta.marks[i],
        slots: rigFrame(f.words),
    }));
}

/**
 * The chest and head matrices the board built, for one frame.
 *
 * The head block is a translate of the fighter's spine offset followed by op
 * 0x3F; the chest is the 0x3F before it, whose translate is zero. Both are
 * snapshotted after the angle ops that trail them, which is where the board has
 * finished with the part.
 *
 * @param {number[]} words one frame of coprocessor stream
 * @param {number} spine the character's spine offset
 * @returns {{chest:?object, head:?object}} each { r:[9], t:[3] }
 */
export function upperBodyFromCmds(cmds, spine) {
    let m = I();
    const stack = [];
    /* Both fighters are in one frame, so a block is only this one's if the
     * set_body that opens it carried this fighter's waist. `world` comes back
     * with it: the board's matrices include the fighter's facing, and a pose
     * built without it is turned away from them by exactly that. */
    let chest = null, head = null, pending = null, body = null;
    for (let i = 0; i < cmds.length; i++) {
        const c = cmds[i], a = c.args ?? [];
        switch (c.op) {
            case 0x01: stack.push(m.slice()); break;
            case 0x02: if (stack.length) m = stack.pop(); break;
            case 0x06: {
                const v = [f32(a[0]), f32(a[1]), f32(a[2])];
                for (let k = 0; k < 3; k++)
                    m[9 + k] += v[0] * m[k] + v[1] * m[k + 3] + v[2] * m[k + 6];
                pending = Math.abs(v[0] - spine) < 1e-3 ? 'head'
                        : Math.abs(v[0]) < 1e-6 && Math.abs(v[1]) < 1e-6 ? 'chest' : null;
                break;
            }
            case 0x08: rotX(m, cosA(raw(a[0])), sinA(raw(a[0]))); break;
            case 0x09: rotY(m, cosA(raw(a[0])), sinA(raw(a[0]))); break;
            case 0x0a: rotZ(m, cosA(raw(a[0])), sinA(raw(a[0]))); break;
            case 0x62:
                m = setBody(a);
                body = { pos: [f32(a[0]), f32(a[1]), f32(a[2])],
                         world: [raw(a[6]), raw(a[7]), raw(a[8])] };
                chest = null; head = null;      /* a new fighter starts here */
                break;
            case 0x3f: {
                rotZ(m, cosA(raw(a[0])), sinA(raw(a[0])));
                rotY(m, cosA(raw(a[1])), sinA(raw(a[1])));
                rotX(m, cosA(raw(a[2])), sinA(raw(a[2])));
                /* swallow the angle ops that trail the euler, then snapshot */
                let j = i + 1;
                while (j < cmds.length && [0x08, 0x09, 0x0a].includes(cmds[j].op)) {
                    const w = raw((cmds[j].args ?? [])[0]);
                    if (cmds[j].op === 0x08) rotX(m, cosA(w), sinA(w));
                    else if (cmds[j].op === 0x09) rotY(m, cosA(w), sinA(w));
                    else rotZ(m, cosA(w), sinA(w));
                    j++;
                }
                i = j - 1;
                const snap = { r: m.slice(0, 9), t: m.slice(9, 12) };
                if (pending === 'head' && !head) head = { ...snap, body };
                else if (pending === 'chest' && !chest) chest = { ...snap, body };
                pending = null;
                break;
            }
            default: break;
        }
    }
    return { chest, head, body };
}

/**
 * Every fighter's chest and head in one frame.
 *
 * Both are in the same stream, so the frame is split on op 0x62 — each set_body
 * opens one fighter's build — and each piece solved on its own. `body.pos` is
 * that fighter's waist and `body.world` its facing, which is what tells the two
 * apart and what a pose has to be built with to be comparable: the board's
 * matrices carry the facing, and one built without it is turned away by exactly
 * that much.
 *
 * @param {number[]} words one frame of coprocessor stream
 * @param {number} spine the spine offset of the fighter being looked for
 * @returns {Array<{chest:object, head:object, body:object}>}
 */
export function upperBodies(words, spine) {
    const cmds = segment(words);
    const cuts = [];
    for (let i = 0; i < cmds.length; i++) if (cmds[i].op === 0x62) cuts.push(i);
    const out = [];
    for (let k = 0; k < cuts.length; k++) {
        const piece = cmds.slice(cuts[k], cuts[k + 1] ?? cmds.length);
        const r = upperBodyFromCmds(piece, spine);
        if (r.head && r.chest && r.body) out.push(r);
    }
    return out;
}

/** One frame's stream, for callers that have words rather than commands. */
export function upperBody(words, spine) {
    return upperBodyFromCmds(segment(words), spine);
}

export { ang, f32 };
