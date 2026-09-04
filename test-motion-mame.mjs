/*
 * test-motion-mame.mjs — hold the decoded motion against the board itself.
 *
 * `mame-motion.py` records every word the i960 writes to the coprocessor
 * while a real fight is on screen, and the motion number and motion frame the
 * game was on at each frame edge. Two of those commands carry the whole pose,
 * with the argument order `calc_rob_angle_cont` at 0x2FF2C emits them in:
 *
 *   0x62  set_body   args 0..2 the waist position, 3..5 the body euler
 *                    (j4.z, j4.y, j4.x), 6..8 the fighter's facing
 *   0x6B  ik_2bone   args 0..2 the limb's pivot, 3..5 its base euler
 *                    (j.z, j.y, j.x), 6..8 a world adjust, 9..11 the IK target,
 *                    12 the lower bone, 13 the upper, 14/15 TGP slots, 16 flip
 *
 * Those are the numbers `js/motion.js` samples and `js/pose.js` solves with, so
 * this compares them one for one at the same motion and the same frame. It is
 * the empirical check behind the format: the keyframe walk, the interpolation
 * and the tangent scale all have to be right for a Hermite channel to land on
 * the same 16-bit angle the board computed, on every frame of a real motion.
 *
 * A capture is tens of megabytes, so what is kept in the tree is `motion-pose.csv`
 * — one row per captured frame holding just those arguments. Run with a capture
 * prefix and `--save` to remake it; run with no arguments to check against it.
 *
 * Run: node test-motion-mame.mjs [capture-prefix|csv] [rom.zip] [--save]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadRomSet } from './vendor/noclip/js/romset.js';
import { readCharacter } from './vendor/noclip/js/characters.js';
import { decodeMotion, sampleMotion } from './vendor/noclip/js/motion.js';
import { segment, f32, COPRO_FIFO } from './dl-verify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSV = path.join(HERE, 'motion-pose.csv');

const args = process.argv.slice(2);
const save = args.includes('--save');
const rest = args.filter((a) => a !== '--save');
const SOURCE = rest[0] ?? CSV;
const ROM = rest[1] ?? 'sfight.zip';

const read = (p) => {
    const b = fs.readFileSync(p);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

/* The four IK chains in the order calc_rob_angle_cont emits them, with the
 * motion objects each takes its base euler and target from, and the TGP slot
 * word that names it. Both fighters are in the stream; an ik_2bone says which
 * player and which limb it is by the pair of slots it writes into — P1's are
 * 0x3Axx — so nothing here depends on the order they were emitted in. */
const CHAINS = [
    { name: 'L arm', slot: 0x3a30, baseAngle: 7, target: 3, flip: 0 },
    { name: 'R arm', slot: 0x3a54, baseAngle: 8, target: 4, flip: 0 },
    { name: 'L leg', slot: 0x3a84, baseAngle: 10, target: 6, flip: 1 },
    { name: 'R leg', slot: 0x3aa8, baseAngle: 11, target: 7, flip: 1 },
];
const SLOT_OF = new Map(CHAINS.map((c, i) => [c.slot, i]));

/* When the game starts a new motion it does not cut to it: `play_motion` calls
 * `smooth_int` at 0x2F2B0, which eases out of the pose the fighter was already
 * in over the first few frames. The viewer plays a motion outright, so those
 * frames are held back and reported rather than asserted on. */
const BLEND = 8;

/* ---- rows: what the board posed with, per frame -------------------------- */

/** Pull the rows out of a display-list capture. */
function rowsFromCapture(prefix) {
    const bin = fs.readFileSync(`${prefix}.bin`);
    const meta = JSON.parse(fs.readFileSync(`${prefix}.json`, 'utf8'));
    const offs = [], words = [];
    for (let i = 0; i * 8 < bin.length; i++) {
        offs.push(bin.readUInt32LE(i * 8));
        words.push(bin.readUInt32LE(i * 8 + 4));
    }
    const inCopro = (o) => o >= COPRO_FIFO[0] && o < COPRO_FIFO[1];

    /* A slice runs between two frame edges. The motion state read at the edge
     * that closes it is the one the commands in it were computed from, so that
     * is the label; a slice in which the motion restarted straddles the reset
     * and is dropped, since which side its commands fell on is not something
     * the capture can say. */
    const out = [];
    let since = Infinity, lastMotion = -1, lastComa = -1;
    for (let i = 0; i + 1 < meta.marks.length; i++) {
        const a = meta.marks[i], b = meta.marks[i + 1];
        const motion = b[2], coma = b[3], char = b[4];
        if (motion !== lastMotion || coma < lastComa) since = 0; else since++;
        lastMotion = motion; lastComa = coma;
        if (!motion) continue;
        if (motion !== a[2] || coma < a[3]) continue;

        const w = [];
        for (let k = a[1]; k < b[1]; k++) if (inCopro(offs[k])) w.push(words[k]);
        if (!w.length) continue;

        /* One block per fighter: a set_body, then the limbs that follow it. */
        const blocks = [];
        let cur = null;
        for (const c of segment(w)) {
            if (c.op === 0x62 && c.args.length >= 9) { cur = { body: c, iks: new Map() }; blocks.push(cur); }
            else if (c.op === 0x6b && c.args.length >= 17 && cur) {
                const k = SLOT_OF.get(c.args[14] & 0xffff);
                if (k !== undefined) cur.iks.set(k, c);
            }
        }
        const block = blocks.find((x) => x.iks.size === 4);
        if (!block) continue;

        const row = { motion, coma, char, since, pos: [], euler: [], limbs: [] };
        for (let k = 0; k < 3; k++) row.pos.push(f32(block.body.args[k]));
        for (const k of [3, 4, 5]) row.euler.push(block.body.args[k] & 0xffff);
        for (let k = 0; k < 4; k++) {
            const a2 = block.iks.get(k).args;
            row.limbs.push({
                pivot: [0, 1, 2].map((i) => f32(a2[i])),
                euler: [3, 4, 5].map((i) => a2[i] & 0xffff),
                target: [9, 10, 11].map((i) => f32(a2[i])),
                lower: f32(a2[12]), upper: f32(a2[13]), flip: a2[16] & 0xff,
            });
        }
        out.push(row);
    }
    return out;
}

const CSV_HEAD = 'motion,coma,char,since,px,py,pz,ez,ey,ex'
    + CHAINS.map((c, k) => [`vx${k}`, `vy${k}`, `vz${k}`, `bz${k}`, `by${k}`, `bx${k}`,
        `tx${k}`, `ty${k}`, `tz${k}`, `lo${k}`, `up${k}`, `fl${k}`].join(',')).join(',');

function writeCsv(rows, file) {
    const n = (v) => (Number.isInteger(v) ? String(v) : v.toPrecision(9));
    const lines = [CSV_HEAD];
    for (const r of rows) {
        const f = [r.motion, r.coma, r.char, r.since, ...r.pos.map(n), ...r.euler];
        for (const L of r.limbs) f.push(...L.pivot.map(n), ...L.euler, ...L.target.map(n),
            n(L.lower), n(L.upper), L.flip);
        lines.push(f.join(','));
    }
    fs.writeFileSync(file, lines.join('\n') + '\n');
}

function readCsv(file) {
    const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
    const rows = [];
    for (const line of lines.slice(1)) {
        const v = line.split(',').map(Number);
        let i = 0;
        const row = {
            motion: v[i++], coma: v[i++], char: v[i++], since: v[i++],
            pos: [v[i++], v[i++], v[i++]], euler: [v[i++], v[i++], v[i++]], limbs: [],
        };
        for (let k = 0; k < 4; k++) {
            row.limbs.push({
                pivot: [v[i++], v[i++], v[i++]], euler: [v[i++], v[i++], v[i++]],
                target: [v[i++], v[i++], v[i++]],
                lower: v[i++], upper: v[i++], flip: v[i++],
            });
        }
        rows.push(row);
    }
    return rows;
}

/* ---- run ------------------------------------------------------------------ */

let rows;
if (SOURCE.endsWith('.csv')) {
    if (!fs.existsSync(SOURCE)) {
        console.log(`no ${path.basename(SOURCE)} — run mame-motion.py, then this with --save`);
        process.exit(0);
    }
    rows = readCsv(SOURCE);
    console.log(`${rows.length} frames recorded from the board (${path.basename(SOURCE)})`);
} else {
    rows = rowsFromCapture(SOURCE);
    console.log(`${rows.length} frames pulled out of ${path.basename(SOURCE)}`);
    if (save) { writeCsv(rows, CSV); console.log(`wrote ${CSV}`); }
}

const rom = await loadRomSet([read(ROM)]);

console.log(`motions: ${[...new Set(rows.map((r) => r.motion))].join(', ')}`
    + ` · characters: ${[...new Set(rows.map((r) => r.char))].join(', ')}`);

let bad = 0;
const fail = (msg) => { if (bad < 20) console.log(`FAIL: ${msg}`); bad++; };
/* Compare binary radians the short way round: 0xFFFF and 0 are one apart. */
const angDiff = (a, b) => { const d = Math.abs((a - b) & 0xffff); return Math.min(d, 0x10000 - d); };

const stats = { body: 0, bodyAng: 0, base: 0, target: 0, pivot: 0, bone: 0, flip: 0 };
const worst = { pos: 0, ang: 0, tgt: 0 };
const blend = [];
let comparedFrames = 0, comparedIK = 0;
const charCache = new Map(), motionCache = new Map();

for (const r of rows) {
    if (!charCache.has(r.char)) charCache.set(r.char, readCharacter(rom, r.char));
    if (!motionCache.has(r.motion)) motionCache.set(r.motion, decodeMotion(rom, r.motion));
    const c = charCache.get(r.char), m = motionCache.get(r.motion);
    if (!c || !m) { fail(`motion ${r.motion} char ${r.char} does not decode`); continue; }

    const s = sampleMotion(rom, m, r.coma);

    if (r.since < BLEND) {
        let e = 0;
        for (let i = 0; i < 3; i++) e = Math.max(e, Math.abs(r.pos[i] - s.targets[i]));
        for (let k = 0; k < 4; k++) {
            for (let i = 0; i < 3; i++) {
                e = Math.max(e, Math.abs(r.limbs[k].target[i] - s.targets[CHAINS[k].target * 3 + i]));
            }
        }
        (blend[r.since] ??= []).push(e);
        continue;
    }
    comparedFrames++;

    /* The waist position is float object 12, and the body euler object 4 — the
     * board sends it (z, y, x). */
    for (let i = 0; i < 3; i++) {
        const d = Math.abs(r.pos[i] - s.targets[i]);
        if (d > 1e-3) { stats.body++; fail(`f${r.coma} waist[${i}] board ${r.pos[i]} viewer ${s.targets[i]}`); }
        worst.pos = Math.max(worst.pos, d);
    }
    for (const [k, axis] of [[0, 2], [1, 1], [2, 0]]) {
        const d = angDiff(r.euler[k], s.angles[4 * 3 + axis]);
        if (d > 1) { stats.bodyAng++; fail(`f${r.coma} body euler axis ${axis} board ${r.euler[k]} viewer ${s.angles[12 + axis]}`); }
        worst.ang = Math.max(worst.ang, d);
    }

    /* Each limb: its pivot and bone lengths are the skeleton the viewer reads
     * out of the character record, its base euler and target are the motion. */
    for (let k = 0; k < 4; k++) {
        const L = r.limbs[k], ch = CHAINS[k];
        comparedIK++;
        for (let i = 0; i < 3; i++) {
            if (Math.abs(L.pivot[i] - c.skeleton.pivot[k][i]) > 1e-4) {
                stats.pivot++; fail(`f${r.coma} ${ch.name} pivot[${i}] board ${L.pivot[i]} viewer ${c.skeleton.pivot[k][i]}`);
            }
        }
        for (const [k2, axis] of [[0, 2], [1, 1], [2, 0]]) {
            const want = s.angles[ch.baseAngle * 3 + axis];
            const d = angDiff(L.euler[k2], want);
            if (d > 1) { stats.base++; fail(`f${r.coma} ${ch.name} euler axis ${axis} board ${L.euler[k2]} viewer ${want}`); }
            worst.ang = Math.max(worst.ang, d);
        }
        for (let i = 0; i < 3; i++) {
            const want = s.targets[ch.target * 3 + i];
            const d = Math.abs(L.target[i] - want);
            if (d > 1e-3) { stats.target++; fail(`f${r.coma} ${ch.name} target[${i}] board ${L.target[i]} viewer ${want}`); }
            worst.tgt = Math.max(worst.tgt, d);
        }
        if (Math.abs(L.lower - c.skeleton.lower[k]) > 1e-5 || Math.abs(L.upper - c.skeleton.upper[k]) > 1e-5) {
            stats.bone++;
            fail(`f${r.coma} ${ch.name} bones board ${L.lower}/${L.upper} viewer ${c.skeleton.lower[k]}/${c.skeleton.upper[k]}`);
        }
        if (L.flip !== ch.flip) { stats.flip++; fail(`f${r.coma} ${ch.name} flip board ${L.flip} viewer ${ch.flip}`); }
    }
}

if (!comparedFrames) {
    console.log('FAIL: no frame outside the blend window to compare');
    process.exit(1);
}

const verdict = (n) => (n ? `${n} BAD` : 'all match');
console.log(`\ncompared ${comparedFrames} frames and ${comparedIK} IK chains against the board:`);
console.log(`  waist position   worst ${worst.pos.toExponential(2)}   ${verdict(stats.body)}`);
console.log(`  joint angles     worst ${worst.ang} brad   ${verdict(stats.bodyAng + stats.base)}`);
console.log(`  IK targets       worst ${worst.tgt.toExponential(2)}   ${verdict(stats.target)}`);
console.log(`  limb pivots      ${verdict(stats.pivot)}`);
console.log(`  bone lengths     ${verdict(stats.bone)}`);
console.log(`  bend direction   ${verdict(stats.flip)}`);

if (blend.some(Boolean)) {
    console.log('\nthe frames `smooth_int` eases into a new motion over, which the viewer cuts to');
    console.log('(reported, not asserted: how big the ease is depends on the pose being left):');
    for (let i = 0; i < BLEND; i++) {
        const v = (blend[i] ?? []).sort((a, b) => a - b);
        if (!v.length) continue;
        console.log(`  frame ${i} of the blend: worst ${v[v.length - 1].toExponential(2)}`
            + `  median ${v[v.length >> 1].toExponential(2)}  n=${v.length}`);
    }
}

console.log(bad ? `\n${bad} disagreement(s) with the board` : '\nthe board and the viewer agree on every frame');
process.exit(bad ? 1 : 0);
