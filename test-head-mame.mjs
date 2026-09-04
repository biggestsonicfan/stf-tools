/*
 * test-head-mame.mjs — the chest and head, held against the board.
 *
 * `test-motion-mame.mjs` checks everything the command stream spells out
 * as arguments: the waist, the body euler, the four IK chains' pivots, base
 * eulers, targets and bone lengths. It stops there, because the chest and head
 * are not arguments — they are a matrix the coprocessor is left holding. So
 * until this, nothing above the waist was ever compared with the hardware, and
 * `js/pose.js` could aim the head however it liked without a check noticing.
 *
 * `dl-rig.mjs` rebuilds those two matrices out of the stream: the body
 * from op 0x62's own arguments, then the explicit translate / 0x3F / angle ops
 * the board stacks on it. Taking the body from its arguments is not circular —
 * those are already pinned frame for frame by the check above — so what is
 * being compared here is only what is built on top of the body.
 *
 * INCOMPLETE -- do not read its output as a verdict on js/pose.js.
 *
 * The replay in dl-rig.mjs models push, pop, translate, the three angle ops,
 * op 0x3F and op 0x62, and those are enough to find and split the blocks. They
 * are not enough to arrive at the block with the right matrix: between the
 * set_body and the head, the stream also carries 0x07 (scale) and the ops 0x29,
 * 0x39, 0x35, 0x0F, 0x69, 0x12, 0x5E and 0x5C, of which at least 0x29 and 0x39
 * carry angles. Until those are decoded the replayed matrix has already drifted
 * before the head is reached, so every frame compares BAD and that says nothing
 * about the viewer.
 *
 * What is finished and worth keeping: the blocks are located (the head by its
 * translate of the fighter's own spine, the chest by the zero translate before
 * it), the frame is split per fighter on op 0x62, and the fighter is picked out
 * by the waist his set_body carried — with his facing, which a comparable pose
 * has to be built with. Decode the eight ops above and this becomes the check
 * that finally covers everything above the waist.
 *
 * Deliberately not in `npm test` while that is true.
 *
 * Run: node test-head-mame.mjs <capture-prefix> <char> [rom.zip]
 */

import fs from 'fs';
import { loadCapture } from './dl-verify.mjs';
import { upperBodies } from './dl-rig.mjs';
import { loadRomSet } from './vendor/noclip/js/romset.js';
import { readCharacter } from './vendor/noclip/js/characters.js';
import { decodeMotion, sampleMotion } from './vendor/noclip/js/motion.js';
import { buildPose } from './vendor/noclip/js/pose.js';

const [prefix, charArg, romArg] = process.argv.slice(2);
if (!prefix) {
    console.log('usage: node test-head-mame.mjs <capture-prefix> <char> [rom.zip]');
    process.exit(2);
}
const read = (p) => {
    const b = fs.readFileSync(p);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const rom = await loadRomSet([read(romArg ?? 'sfight.zip')]);
const ci = Number(charArg);
const c = readCharacter(rom, ci);
const spine = c.skeleton.spine[0];

const { frames, meta } = loadCapture(prefix);
const cache = new Map();
const decode = (id) => {
    if (!cache.has(id)) cache.set(id, decodeMotion(rom, id));
    return cache.get(id);
};

/* The board's basis is the one js/pose.js calls the board frame, so the two are
 * compared without conversion; `worst` is the largest single element apart. */
const cmp = (a, b) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);

let n = 0, badChest = 0, badHead = 0, worstChest = 0, worstHead = 0;
const shown = [];
for (let i = 0; i + 1 < meta.marks.length; i++) {
    const mk = meta.marks[i + 1];
    const motion = mk[2], coma = mk[3], char = mk[4];
    if (!motion || char !== ci) continue;
    const d = decode(motion);
    if (!d || coma < 1 || coma > d.frames) continue;
    /* Both fighters are in the frame; this one is the block whose set_body
     * carried the waist the motion puts him at. */
    const s = sampleMotion(rom, d, coma);
    const mine = upperBodies(frames[i].words, spine).filter((b) =>
        Math.abs(b.body.pos[1] - s.targets[1]) < 2e-3);
    if (mine.length !== 1) continue;
    const board = mine[0];
    const pose = buildPose(c.skeleton, s, { world: board.body.world });
    n++;
    const dc = cmp(pose[1].r, board.chest.r);
    const dh = cmp(pose[2].r, board.head.r);
    worstChest = Math.max(worstChest, dc);
    worstHead = Math.max(worstHead, dh);
    if (dc > 0.02) badChest++;
    if (dh > 0.02) {
        badHead++;
        if (shown.length < 3) shown.push(
            `  f${coma}: head worst ${dh.toFixed(3)}\n` +
            `     board  [${board.head.r.map((v) => v.toFixed(3)).join(', ')}]\n` +
            `     viewer [${pose[2].r.map((v) => v.toFixed(3)).join(', ')}]`);
    }
}

if (!n) { console.log('no comparable frames in this capture'); process.exit(1); }
console.log(`compared ${n} frames of char ${ci} (${c.name}) against the board:`);
console.log('  (INCOMPLETE: the replay is missing ops 0x07 0x29 0x39 0x35 0x0F 0x69 0x12 0x5E 0x5C,');
console.log('   so a mismatch here is the replay drifting, not the viewer)');
console.log(`  chest orientation  worst ${worstChest.toFixed(4)}   ${badChest ? `${badChest} BAD` : 'all match'}`);
console.log(`  head orientation   worst ${worstHead.toFixed(4)}   ${badHead ? `${badHead} BAD` : 'all match'}`);
for (const s of shown) console.log(s);
/* Exit 0 regardless: this cannot fail the viewer until the replay is complete. */
process.exit(0);
