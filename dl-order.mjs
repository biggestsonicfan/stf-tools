/*
 * dl-order.mjs — which of two models the board submits first.
 *
 * The board has no depth buffer and no per-pixel tie-break. A polygon carries
 * one z, polygons bucket on it, and the fill writes a pixel only if nothing has
 * written it yet (model2rd.ipp: `if (fill[x] == 0)`). Two polygons that land in
 * the same bucket are therefore settled by nothing but the order — and for one
 * pair on South Island that is the whole story.
 *
 * The order runs backwards from submission. `model2_v.cpp` *prepends* to a
 * bucket's list, so the list is newest first and the last polygon submitted is
 * the first rasterized — and with a fill that keeps its first writer, the last
 * submission keeps the pixel. (This file said the opposite until the decal
 * work; see the decal section of TECHNICAL.md, which is where the prepend was
 * pinned down.)
 *
 * Model 517 is the stage's floor plate: four quads at y = -6.4 forming a frame
 * round the ring. Model 555 is the sea, and it carries four quads of its own
 * over exactly the same ground — not merely coplanar, but sorted on the *same
 * four corners*, so both resolve to the same z for any camera that exists. All
 * four of the floor's sort groups are tied that way. No depth test anywhere can
 * separate them; only the order can.
 *
 * The viewer now has a rule for it, and the rule is the board's: `camera_init`
 * draws `stage_floor` before any other pass, a bucket is rasterized newest
 * first, and the fill keeps the first writer — so the floor loses every tie it
 * is in, and `js/viewer.js`'s floorMaterial says so by standing one depth unit
 * and one slope unit back. What it replaced was no rule at all: three.js sorts
 * opaque draws on the geometry's bounding-sphere centre, and the sea's plate is
 * lopsided enough that its centre put the sea before or after the floor
 * depending on where the camera stood. Top-down that landed the sea first and
 * the floor took the whole ring off it — 222,389 pixels of still plate through
 * the scrolling sea at one frame.
 *
 * That argument is from the fill rule, not from a capture. This reads the
 * submission order itself, so a capture can confirm or overturn it.
 *
 * What makes the question answerable at all is that the capture keeps *both*
 * ports in write order. The sea is the one part of the arena the i960 hands
 * straight to the geometry processor rather than through the coprocessor, so it
 * never appears in the coprocessor's draw list — but dl-verify's replay merges
 * the two streams and stamps every draw with its index in the merged stream.
 * Sorting on that index is the board's submission order, which is the tie-break
 * itself.
 *
 * A model the board did not draw in a frame is not a disagreement: ground_disp
 * runs area_clip, so the board emits the subset its own camera can see. Frames
 * that carry only one of the pair are reported and skipped rather than counted.
 *
 * Run:  node dl-order.mjs <capture-prefix> [modelA] [modelB] [rom.zip]
 *       node dl-order.mjs cap/south 517 555
 */

import fs from 'fs';
import {
    loadCapture, loadRom, modelIndex, meshIndex, replayFrame,
} from './dl-verify.mjs';
import { CopReplay } from './cop-replay.mjs';

const PREFIX = process.argv[2];
const A = Number(process.argv[3] ?? 517);
const B = Number(process.argv[4] ?? 555);
const ROM = process.argv[5] ?? 'sfight.zip';

if (!PREFIX) {
    console.error('usage: node dl-order.mjs <capture-prefix> [modelA] [modelB] [rom.zip]');
    process.exit(2);
}

/* loadCapture reads <prefix>.bin and <prefix>.json; say which is missing rather
 * than letting an ENOENT stack stand in for it. */
for (const ext of ['.bin', '.json']) {
    if (!fs.existsSync(PREFIX + ext)) {
        console.error(`no capture at ${PREFIX}${ext}`);
        console.error('Take one with mame-capture-dl.py — see README.md.');
        process.exit(2);
    }
}

const cap = loadCapture(PREFIX);
const rom = await loadRom(ROM);
const byEntry = modelIndex(rom);
const byMesh = meshIndex(rom);
/* One replay across the capture, as verify-stage.mjs keeps. */
const cop = new CopReplay();

/* The first draw of a model in a frame is the one that claims the pixels; a
 * model drawn more than once is reported so that assumption stays visible. */
const firstOf = (draws, model) => {
    const hits = draws.filter((d) => d.model === model).sort((x, y) => x.at - y.at);
    return hits.length ? { ...hits[0], count: hits.length } : null;
};

let aFirst = 0, bFirst = 0, skipped = 0;
const rows = [];

for (const frame of cap.frames) {
    const { draws } = replayFrame(frame.records, byEntry, byMesh, cop);
    const da = firstOf(draws, A), db = firstOf(draws, B);
    if (!da || !db) {
        skipped++;
        rows.push(`  frame_counter ${String(frame.frameCounter).padStart(6)}  `
            + `${!da ? `model ${A}` : `model ${B}`} not drawn this frame — skipped`);
        continue;
    }
    const winner = da.at < db.at ? A : B;
    if (winner === A) aFirst++; else bFirst++;
    rows.push(`  frame_counter ${String(frame.frameCounter).padStart(6)}  `
        + `${A} at ${String(da.at).padStart(6)} (${da.via}${da.count > 1 ? `, ${da.count}x` : ''})  `
        + `${B} at ${String(db.at).padStart(6)} (${db.via}${db.count > 1 ? `, ${db.count}x` : ''})  `
        + `-> ${winner} first`);
}

console.log(`${cap.frames.length} frames captured, stage_num ${cap.frames[0]?.stageNum}`);
for (const r of rows) console.log(r);

const counted = aFirst + bFirst;
console.log();
if (!counted) {
    console.log(`neither order observed: no frame drew both ${A} and ${B}.`);
    console.log('Capture more frames (FRAMES=…), or with KEEP_MASH=1 so the board\'s');
    console.log('camera sweeps far enough to emit both.');
    process.exit(2);
}
if (aFirst && bFirst) {
    console.log(`INCONSISTENT: ${A} first in ${aFirst} frames, ${B} first in ${bFirst}.`);
    console.log('The order is not a property of the stage, so it cannot be ported as one.');
    process.exit(1);
}
const won = aFirst ? A : B;
const lost = aFirst ? B : A;
console.log(`${won} is submitted before ${lost} in all ${counted} frames that drew both`
    + `${skipped ? ` (${skipped} skipped)` : ''}.`);
console.log(`So where the two tie, the bucket is walked newest first and the board keeps`);
console.log(`${lost} — the later submission — while ${won} never reaches those pixels.`);
console.log();
console.log(`The viewer expects the sea, 555, to be the one that keeps them: it stands the`);
console.log('floor plate one depth unit and one slope unit back, so everything submitted');
console.log(`after the floor wins a tie with it. This capture ${lost === 555 ? 'agrees' : 'DISAGREES'}`
    + `${lost === 555 ? '.' : ' — floorMaterial in js/viewer.js is the thing to revisit.'}`);
