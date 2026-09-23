/*
 * dl-verify.mjs — compare the stage the viewer builds against the stage the
 * board draws.
 *
 * mame-capture-dl.py records every word the i960 writes to the
 * coprocessor FIFO while a stage is on screen. That stream is the display list:
 * a run of commands, each of which is a matrix op, a draw, or a stack push/pop.
 * This replays it, so every draw comes out as (model, 4x4 matrix) — what the
 * hardware actually placed and where — and holds that against what
 * buildStageDisplayList() produces from the ROM tables alone.
 *
 * Two things make the comparison exact rather than approximate.
 *
 * The command words are self-identifying: the i960 encodes opcode n as
 * (n<<23)|(n<<8)|n, so a word is a command iff it matches that pattern for its
 * own low byte. Segmenting on that needs no table of argument counts, and the
 * result is checkable — every opcode in a frame comes out with one consistent
 * argument count.
 *
 * A draw carries the model table entry verbatim: args 2..4 are the uv, mat and
 * mesh pointers romset.js reads out of the model table, so a draw names its
 * model with no guesswork.
 *
 * Not every part goes through the coprocessor. South Island's sea is handed
 * straight to the geometry processor's port at 0x804000 — ground_disp calls
 * set_obj_thd to pass it with a per-frame texture header, and no draw for it
 * ever reaches the coprocessor. Its transform does, though: it is pushed on the
 * coprocessor between the last ground chunk and the pop that ends the pass. So
 * both ports have to be read, in write order, and the matrix in effect when the
 * object reaches the geometry processor is the one it is drawn under. Reading
 * only the coprocessor makes such a part look culled, which is exactly the kind
 * of silence this tool exists to avoid.
 *
 * Everything is compared in the board's own space. The viewer negates Z when it
 * reads geometry, so its matrix is F·M·F for F = diag(1,1,-1) — which leaves
 * scales and X/Y rotations alone and flips the Z of a translation, and that is
 * the only place the two conventions differ. Undoing it on the viewer's ops
 * puts both sides in one frame; see the comment above ANGLE_DEG in display.js.
 */

import fs from 'fs';
import { CopReplay } from './cop-replay.mjs';
import { loadRomSet, readModelEntry } from './vendor/noclip/js/romset.js';
import { readStageTable } from './vendor/noclip/js/stages.js';
import {
    buildStageDisplayList, readFrameTables, opsAt, frameModel, stageWorldFrame,
} from './vendor/noclip/js/display.js';

/* ---- the command stream -------------------------------------------------- */

export const CMD = {
    PUSH: 1, POP: 2, TRANSLATE: 6, SCALE: 7, ANG_X: 8, ANG_Y: 9, ANG_Z: 10,
    DRAW: 120,
};

/* The two ports a stage part can be drawn through. */
export const COPRO_FIFO = [0x884000, 0x888000];
export const GEO_FIFO = [0x804000, 0x808000];
const inRange = (o, r) => o >= r[0] && o < r[1];

const f32buf = new DataView(new ArrayBuffer(4));
export function f32(w) { f32buf.setUint32(0, w >>> 0, true); return f32buf.getFloat32(0, true); }
export function ang(w) { const v = w & 0xffff; return (v >= 0x8000 ? v - 0x10000 : v) * (360 / 65536); }

export const isCmd = (w) => {
    const op = w & 0xff;
    return op !== 0 && w === ((((op << 23) >>> 0) | (op << 8) | op) >>> 0);
};

/** Split a run of FIFO words into {op, args} — see the header on why this works. */
export function segment(words) {
    const out = [];
    for (let i = 0; i < words.length; i++) {
        if (!isCmd(words[i])) continue;
        const op = words[i] & 0xff;
        const args = [];
        let j = i + 1;
        while (j < words.length && !isCmd(words[j])) args.push(words[j++]);
        out.push({ op, args, at: i });
        i = j - 1;
    }
    return out;
}

/* ---- 4x4 matrices, row-major, column-vector convention ------------------- */

export const I4 = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function mul(a, b) {
    const o = new Array(16);
    for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
            let s = 0;
            for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c];
            o[r * 4 + c] = s;
        }
    }
    return o;
}

export const scaleM = (x, y, z) => [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
export const transM = (x, y, z) => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1];

/*
 * The board's rotations are the transpose of the ones the same angle names in a
 * right-handed system — ang_y builds columns (c,0,s) and (-s,0,c). Both sides of
 * the comparison are built from these, so the convention is stated once here
 * rather than guessed at twice.
 */
export function rotY(deg) {
    const t = deg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
    return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
}
export function rotX(deg) {
    const t = deg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
    return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
}
export function rotZ(deg) {
    const t = deg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
    return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/** Inverse of an affine matrix; the display list never emits a projective row. */
export function inv(m) {
    const a = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
    const d = a[0] * (a[4] * a[8] - a[5] * a[7])
            - a[1] * (a[3] * a[8] - a[5] * a[6])
            + a[2] * (a[3] * a[7] - a[4] * a[6]);
    if (Math.abs(d) < 1e-20) return null;
    const c = [
        (a[4] * a[8] - a[5] * a[7]) / d, -(a[1] * a[8] - a[2] * a[7]) / d, (a[1] * a[5] - a[2] * a[4]) / d,
        -(a[3] * a[8] - a[5] * a[6]) / d, (a[0] * a[8] - a[2] * a[6]) / d, -(a[0] * a[5] - a[2] * a[3]) / d,
        (a[3] * a[7] - a[4] * a[6]) / d, -(a[0] * a[7] - a[1] * a[6]) / d, (a[0] * a[4] - a[1] * a[3]) / d,
    ];
    const t = [m[3], m[7], m[11]];
    return [
        c[0], c[1], c[2], -(c[0] * t[0] + c[1] * t[1] + c[2] * t[2]),
        c[3], c[4], c[5], -(c[3] * t[0] + c[4] * t[1] + c[5] * t[2]),
        c[6], c[7], c[8], -(c[6] * t[0] + c[7] * t[1] + c[8] * t[2]),
        0, 0, 0, 1,
    ];
}

/** Largest absolute difference between two matrices. */
export const maxdiff = (a, b) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);

/* ---- replaying the display list ------------------------------------------ */

/**
 * Replay one frame across both ports, in write order, returning every draw as
 * {model, m, base, at, depth, via, tainted, base3x3}.
 *
 * `m` is the full accumulated matrix, camera included. `base` is the matrix at
 * the bottom of the stack — what the draw would have been placed at with none
 * of its own transforms — and every stage draw shares one, because camera_init
 * pushes the view once and each draw brackets its own ops in push/pop. That
 * shared base is the view matrix, recovered from the display list alone with no
 * reference to what the viewer thinks any part's transform should be.
 *
 * The matrix is `cop-replay.mjs`'s: every command that writes it, not only the
 * push, pop, translate, scale and three angles this once applied. With only
 * those, a part drawn from a matrix the stream loads or reads back out of a
 * bank — canyon_env_disp's, draw_sphynx_head's, giant_wing_disp's — came out at
 * whatever the last explicit transforms happened to leave, and a part after
 * Fn_base_3x3 still turned with the world. `tainted` marks a draw whose matrix
 * the stream does not carry (see there); `base3x3` one drawn after that reset.
 * Pass one `replay` for a whole capture so a bank stored in one frame is there
 * to be read in the next.
 *
 * A word on the geometry processor's port that is some model's mesh pointer is
 * that model being handed over directly, and is recorded as a draw at whatever
 * matrix the coprocessor has built by that point in the stream — which is why
 * the two have to be walked together rather than one after the other.
 */
export function replayFrame(records, modelByEntry, modelByMesh, replay = new CopReplay()) {
    const cw = [], cg = [], gw = [], gg = [], handed = [];
    for (let i = 0; i < records.length; i++) {
        const [o, w] = records[i];
        if (inRange(o, COPRO_FIFO)) { cw.push(w); cg.push(i); }
        else if (inRange(o, GEO_FIFO)) { gw.push(w >>> 0); gg.push(i); }
    }
    for (let k = 2; k < gw.length; k++) {
        const hit = modelByMesh.get(gw[k]);
        /* oba, with the same model's tpa two words back: an object_data, not a
         * word that merely looks like a mesh pointer. Or the model's header
         * pointer one word back with a tpa in geometrizer RAM (bit 23): texture
         * points uploaded by command 4, which is how the aurora hands over its
         * scrolled ones. */
        if (hit && (gw[k - 2] === hit.uvPtr || (gw[k - 1] === hit.matPtr && (gw[k - 2] & 0x800000)))) {
            handed.push({ at: gg[k], model: hit.model });
        }
    }
    const cmds = segment(cw);
    const draws = [];
    const at = (extra) => ({
        m: replay.matrix(), base: replay.base(), depth: replay.stack.length,
        tainted: replay.tainted, base3x3: replay.base3x3, ...extra,
    });
    const depth0 = replay.stack.length;
    let h = 0;
    /* Everything handed over before this point in the stream is drawn at the
     * matrix standing now, so this runs before the command is applied. */
    const upto = (g) => {
        while (h < handed.length && handed[h].at < g) {
            const x = handed[h++];
            draws.push(at({ model: x.model, key: null, at: x.at, via: 'geo' }));
        }
    };
    for (const c of cmds) {
        upto(cg[c.at]);
        if (c.op === CMD.DRAW) {
            const key = `${c.args[2]}/${c.args[3]}/${c.args[4]}`;
            draws.push(at({ model: modelByEntry.get(key) ?? -1, key, at: cg[c.at], via: 'copro' }));
        }
        replay.apply(c.op, c.args);
    }
    upto(Infinity);
    return { draws, stackLeft: replay.stack.length - depth0, commands: cmds.length };
}

/* ---- the viewer's side ---------------------------------------------------- */

/**
 * One op list as the board would have accumulated it — the Z flip undone.
 * display.js's CAMERA_YAW (['cy']) is an ang_y by the camera's heading, which
 * an op list does not know: `cameraYaw`, in degrees, supplies it.
 */
export function boardMatrix(ops, cameraYaw = null) {
    let m = I4();
    for (const [kind, v] of ops) {
        if (kind === 's') m = mul(m, scaleM(v[0], v[1], v[2]));
        else if (kind === 'r') m = mul(m, rotY(v));
        else if (kind === 'rx') m = mul(m, rotX(v));
        /* An ang_z is the one angle that changes sign between the two spaces —
         * see the ANGLE_DEG note in display.js — so it goes back negated, the
         * way a translation's Z does. */
        else if (kind === 'rz') m = mul(m, rotZ(-v));
        else if (kind === 't') m = mul(m, transM(v[0], v[1], -v[2]));
        else if (kind === 'cy' && cameraYaw !== null) m = mul(m, rotY(cameraYaw));
        else if (kind === 'cy') throw new Error('boardMatrix: CAMERA_YAW needs the heading of the camera');
        else throw new Error(`boardMatrix: op '${kind}' is not a matrix — split on BILLBOARD with placeAt`);
    }
    return m;
}

/**
 * Where the board draws an op list under a view C: C times its matrix, except
 * that display.js's BILLBOARD (['b']) is the coprocessor's Fn_base_3x3, which
 * sets the 3x3 of everything accumulated so far — view included — to the
 * identity and keeps the position it has reached. What follows it applies to
 * that. So a list is cut at its first BILLBOARD, the part before it placed and
 * squared up, and the part after it multiplied on. `cameraYaw` is passed to
 * boardMatrix for a CAMERA_YAW.
 */
export function placeAt(C, ops, cameraYaw = null) {
    const b = ops.findIndex((op) => op[0] === 'b');
    if (b < 0) return mul(C, boardMatrix(ops, cameraYaw));
    const p = mul(C, boardMatrix(ops.slice(0, b), cameraYaw));
    return mul(transM(p[3], p[7], p[11]), boardMatrix(ops.slice(b + 1).filter((op) => op[0] !== 'b'), cameraYaw));
}

/* ---- loading -------------------------------------------------------------- */

export function loadCapture(prefix) {
    const bin = fs.readFileSync(`${prefix}.bin`);
    const meta = JSON.parse(fs.readFileSync(`${prefix}.json`, 'utf8'));
    const words = [], offs = [];
    for (let i = 0; i * 8 < bin.length; i++) {
        offs.push(bin.readUInt32LE(i * 8));
        words.push(bin.readUInt32LE(i * 8 + 4));
    }
    /* marks: [screen frame, word index, ang_x, heading, roll, sky angle,
     *         stage_num, frame_counter] — one per frame edge, so a pair of
     *         marks brackets exactly one frame of display list. */
    const frames = [];
    for (let i = 0; i + 1 < meta.marks.length; i++) {
        const a = meta.marks[i], b = meta.marks[i + 1];
        const records = [];
        const coproWords = [];
        for (let k = a[1]; k < b[1]; k++) {
            records.push([offs[k], words[k]]);
            if (inRange(offs[k], COPRO_FIFO)) coproWords.push(words[k]);
        }
        frames.push({
            /* `words` is the coprocessor stream on its own, so a capture taken
             * before the tap was widened reads back identically. */
            screen: a[0], records, words: coproWords,
            carpet: { angX: a[2], yaw: a[3], roll: a[4] },
            skyAngle: a[5], stageNum: a[6], frameCounter: a[7],
        });
    }
    return { meta, offs, frames };
}

export async function loadRom(zip) {
    const b = fs.readFileSync(zip);
    return loadRomSet([b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)]);
}

/**
 * Mesh pointer -> {model, uvPtr, matPtr}, for objects handed to the geometry processor.
 * The uv pointer comes along so a match can be corroborated: the geometry
 * processor's object_data is (tpa, tha, oba, obc), so a real object has the
 * model's uv pointer two words ahead of its mesh pointer. Matching the mesh
 * pointer alone would take any word that happened to collide with one.
 */
export function meshIndex(rom) {
    const byMesh = new Map();
    for (let i = 0; i < rom.game.modelTable.count; i++) {
        const e = readModelEntry(rom, i);
        if (e.meshPtr && !byMesh.has(e.meshPtr)) {
            byMesh.set(e.meshPtr, { model: i, uvPtr: e.uvPtr, matPtr: e.matPtr });
        }
    }
    return byMesh;
}

/** Model table entry -> model index, so a draw can name its model. */
export function modelIndex(rom) {
    const byEntry = new Map();
    for (let i = 0; i < rom.game.modelTable.count; i++) {
        const e = readModelEntry(rom, i);
        if (!e.meshPtr) continue;
        const k = `${e.uvPtr}/${e.matPtr}/${e.meshPtr}`;
        if (!byEntry.has(k)) byEntry.set(k, i);
    }
    return byEntry;
}

export {
    opsAt, frameModel, buildStageDisplayList, readFrameTables, readStageTable,
    stageWorldFrame,
};
