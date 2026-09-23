/*
 * test-head-mame.mjs — the chest and head, held against the board.
 *
 * `test-motion-mame.mjs` checks everything the command stream spells out
 * as arguments: the waist, the body euler, the four IK chains' pivots, base
 * eulers, targets and bone lengths. It stops there, because the chest and head
 * are not arguments — they are matrices the coprocessor is left holding. This
 * is the check for those.
 *
 * `dl-rig.mjs` replays the whole coprocessor stream and reads the parts the two
 * passes store (see its header). Every comparison is of one part expressed in
 * the frame of the part it hangs off, Pᵀ·C — so the facing and the fighter's
 * place in the world, which the draw pass applies to every part alike, cancel
 * out, and so does anything already wrong further up.
 *
 * Both parts are built the same way: an euler of the motion's own, then an aim.
 * They are measured apart, because they are decided apart.
 *
 *   chest euler    the body turned by object 5, off the solve pass's own two
 *                  slots: what `js/pose.js` turns slot 1 by before aiming it
 *   head position  where slot 2 stands on the chest: the spine step
 *   head euler     the chest turned by object 6, up to the head's last op 0x3F
 *
 *   chest aim      the ang_z and ang_y the solve pass sends after the chest's
 *                  euler
 *   head aim       the head's last op 0x3F, in the draw pass
 *
 * The three above are asserted. The two aims are reported and not asserted,
 * for the reason the sphynx head's aim is in `verify-stage.mjs`: each is the
 * i960's decision, made from the coprocessor's replies to a target the i960
 * hands it (op 0x6A), and that target is not always the motion's. In the
 * pre-fight intros of an m2-hle2 capture, with the fighters standing 4.0 apart,
 * it is at times a point at head height about 4 units out along the fighter's
 * own frame — as far off as the other fighter stands — rather than anywhere
 * near the motion's. The explorer has no other fighter and aims at the motion's
 * own neck and face targets (float objects 13 and 14). So the report says on how
 * many frames the board aimed where the motion says, and shows the angles where
 * it did not. On every capture measured so far the chest's aim is the motion's
 * and the head's often is not.
 *
 * Frames held back rather than compared, and counted:
 *
 *   - the first eight of a new motion — or of one started again, its frame
 *     going backwards — which `smooth_int` eases in from the pose being left,
 *     and which the viewer cuts to; `test-motion-mame.mjs` holds the same
 *     eight back;
 *   - a motion played mirrored, which `set_mirror` rewrites the sample for and
 *     the viewer does not, where the capture says so;
 *   - a frame whose parts the replay could not follow to the end (`tainted`).
 *
 * Two capture layouts are read:
 *
 *   mame-motion.py      marks [frame, word, motion, coma, char, ...], P1 only
 *   m2-hle2 capture_dl  marks [frame, word, probes...], the probes named by
 *                       address in the capture's own `probes`; both fighters,
 *                       with the state word that carries the mirror bit
 *
 * Neither is carried here — a capture is tens of megabytes and this needs the
 * whole stream, not the rows `motion-pose.csv` keeps — so with none named this
 * says so and skips, like the checks whose recording is missing.
 *
 * Run: node test-head-mame.mjs <capture-prefix> [rom.zip]
 */

import fs from 'fs';
import { loadCapture } from './dl-verify.mjs';
import { rigFrames } from './dl-rig.mjs';
import { loadRomSet } from './vendor/noclip/js/romset.js';
import { readCharacter } from './vendor/noclip/js/characters.js';
import { decodeMotion, sampleMotion } from './vendor/noclip/js/motion.js';
import { buildPose, turnedBy, useCoproTrig, coproSin, coproCos } from './vendor/noclip/js/pose.js';

const [prefix, romArg] = process.argv.slice(2);
if (!prefix) {
    console.log('SKIP: no capture named — run: node test-head-mame.mjs <capture-prefix> [rom.zip]');
    process.exit(0);
}
if (!fs.existsSync(`${prefix}.bin`) || !fs.existsSync(`${prefix}.json`)) {
    console.log(`SKIP: no capture at ${prefix}.bin / .json`);
    process.exit(0);
}

const read = (p) => {
    const b = fs.readFileSync(p);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const rom = await loadRomSet([read(romArg ?? 'sfight.zip')]);
/* Both sides take sine and cosine out of the coprocessor ROM by the whole
 * 16-bit angle, so a difference below is not a difference of tables. */
if (!useCoproTrig(rom)) {
    console.log('FAIL: this set carries no coprocessor ROM to take the trig tables from');
    process.exit(1);
}

const { frames, meta } = loadCapture(prefix);

/* Where each fighter's motion, frame, character and state sit in a mark. */
const P1_ROB = 0x510d00, P2_ROB = 0x514100;
const ROB = { motion: 0x1a8, coma: 0x1aa, char: 0x1b0, state: 0x000 };
const MIRRORED = 0x40;
function columns() {
    const named = meta.probes ?? [];
    if (named[0] === 'motion') {
        return [{ motion: 2, coma: 3, char: 4, state: null }];
    }
    const at = (addr) => {
        const i = named.findIndex((p) => parseInt(String(p).split(':')[0], 16) === addr);
        return i < 0 ? null : 2 + i;
    };
    return [P1_ROB, P2_ROB].map((base) => ({
        motion: at(base + ROB.motion), coma: at(base + ROB.coma),
        char: at(base + ROB.char), state: at(base + ROB.state),
    })).filter((c) => c.motion !== null && c.coma !== null && c.char !== null);
}
const COLS = columns();
if (!COLS.length) {
    console.log('FAIL: the capture\'s marks carry no fighter\'s motion, frame and character');
    process.exit(1);
}

const cache = new Map();
const decode = (id) => {
    if (!cache.has(id)) cache.set(id, decodeMotion(rom, id));
    return cache.get(id);
};
const chars = new Map();
const character = (i) => {
    if (!chars.has(i)) chars.set(i, readCharacter(rom, i));
    return chars.get(i);
};

/* ---- column-major 3x3s, the coprocessor's layout and pose.js's ------------- */

/** Pᵀ·C for two rotations: C expressed in P's frame. */
function rel(p, c) {
    const o = new Array(9);
    for (let j = 0; j < 3; j++) {
        for (let r = 0; r < 3; r++) {
            o[j * 3 + r] = p[r * 3] * c[j * 3] + p[r * 3 + 1] * c[j * 3 + 1] + p[r * 3 + 2] * c[j * 3 + 2];
        }
    }
    return o;
}
/** Pᵀ·(t − tp): a point expressed in P's frame. */
const relT = (p, tp, t) => [0, 1, 2].map((j) =>
    p[j * 3] * (t[0] - tp[0]) + p[j * 3 + 1] * (t[1] - tp[1]) + p[j * 3 + 2] * (t[2] - tp[2]));
const diff = (a, b) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);
/* The board's floats are 32-bit and its angles 16-bit; every genuine match
 * lands an order of magnitude inside this. */
const EPS = 2e-3;
/* An aim as the two angles that make it, ang_z then ang_y, in the board's
 * 16-bit units: from the identity those leave column 0 at (cy·cz, −cy·sz, sy). */
const aimAngles = (A) => [Math.atan2(-A[1], A[0]), Math.atan2(A[2], Math.hypot(A[0], A[1]))]
    .map((v) => Math.round((v * 32768) / Math.PI));

const rows = { chest: [], headT: [], head: [] };
const aims = { chest: { n: 0, off: 0, shown: [] }, head: { n: 0, off: 0, shown: [] } };
const held = { blend: 0, mirrored: 0, tainted: 0, noParts: 0 };
const since = COLS.map(() => ({ motion: -1, coma: 0, n: 0 }));

function aimed(kind, board, viewer, what) {
    const a = aims[kind];
    a.n++;
    if (diff(board, viewer) <= EPS) return;
    a.off++;
    if (a.shown.length < 4) {
        const [b, v] = [aimAngles(board), aimAngles(viewer)];
        a.shown.push(`    ${what}: board (z ${b[0]}, y ${b[1]}), viewer (z ${v[0]}, y ${v[1]})`);
    }
}

let i = 0;
for (const r of rigFrames(frames, { trig: { sin: coproSin, cos: coproCos } })) {
    const mk = meta.marks[i + 1];
    for (const [p, col] of COLS.entries()) {
        const motion = mk[col.motion], coma = mk[col.coma], ci = mk[col.char];
        const s = since[p];
        /* A motion started again under the same number is still a new one. */
        if (motion !== s.motion || coma < s.coma) { s.motion = motion; s.n = 0; } else s.n++;
        s.coma = coma;
        if (!motion) continue;
        const d = decode(motion);
        if (!d || coma < 1 || coma > d.frames) continue;
        const parts = r.upperBody(p);
        if (!parts) { held.noParts++; continue; }
        if (s.n < 8) { held.blend++; continue; }
        if (col.state !== null && (mk[col.state] & MIRRORED)) { held.mirrored++; continue; }
        const { chest, head, solvedBody, solvedChest } = parts;
        if (Object.values(parts).some((x) => x.tainted) || !solvedChest.afterTurn || !head.beforeTurn) {
            held.tainted++;
            continue;
        }

        const sample = sampleMotion(rom, d, coma);
        const A = (obj) => [0, 1, 2].map((ax) => sample.angles[obj * 3 + ax]);
        const pose = buildPose(character(ci).skeleton, sample);
        const [B, C, H] = [pose[0].r, pose[1].r, pose[2].r];
        /* Each part with its aim left off, turned by its euler with pose.js's own
         * routine. */
        const chestE = turnedBy(B, ...A(5));
        const headE = turnedBy(C, ...A(6));
        const what = `P${p + 1} char ${ci} motion ${motion} frame ${coma}`;

        rows.chest.push(diff(rel(solvedBody.R, solvedChest.afterTurn.R), rel(B, chestE)));
        rows.headT.push(diff(relT(chest.R, chest.T, head.T), relT(C, pose[1].t, pose[2].t)));
        rows.head.push(diff(rel(chest.R, head.beforeTurn.R), rel(C, headE)));
        aimed('chest', rel(solvedChest.afterTurn.R, solvedChest.R), rel(chestE, C), what);
        aimed('head', rel(head.beforeTurn.R, head.R), rel(headE, H), what);
    }
    i++;
}

const n = rows.chest.length;
if (!n) {
    console.log('FAIL: no comparable frame in this capture');
    process.exit(1);
}
const worst = (a) => a.reduce((m, v) => Math.max(m, v), 0);
console.log(`${n} fighter-frames compared against the board (${COLS.length === 2 ? 'both fighters' : 'P1'}); `
    + `held back: ${held.blend} easing into a motion, ${held.mirrored} mirrored, `
    + `${held.tainted} the replay could not follow, ${held.noParts} with no parts stored`);
let ok = true;
for (const [name, a] of [['chest euler', rows.chest], ['head position', rows.headT], ['head euler', rows.head]]) {
    const bad = a.filter((v) => v > EPS).length;
    if (bad) ok = false;
    console.log(`  ${bad ? 'FAIL' : 'ok  '} ${name.padEnd(14)} worst ${worst(a).toExponential(2)}`
        + `${bad ? `, ${bad} frames past ${EPS}` : ''}`);
}
console.log('the aims, which the i960 decides and the viewer takes from the motion (reported, not asserted):');
for (const [name, a] of Object.entries(aims)) {
    console.log(`  ${name} aim: at the motion's own target on ${a.n - a.off} of ${a.n} frames`);
    for (const s of a.shown) console.log(s);
}
process.exit(ok ? 0 : 1);
