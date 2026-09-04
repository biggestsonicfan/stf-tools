/*
 * test-osage-mame.mjs — hold the sway chains against the board itself.
 *
 * The question this settles is whether an osage chain has memory. If Honey's
 * pigtails carry momentum and lag behind her head, no function of the current
 * frame can reproduce them and `js/osage.js` can only ever draw a rest pose. If
 * they do not, nothing is being left out.
 *
 * There is an integrator in the ROM, and it is switched off. Both halves of the
 * sway are gated on bit 0 of the chain's flag word at `0x0(g13)`:
 *
 *   os_set_matrix  0x67E74   bbc 0 -> skip storing the sway direction at 0x114
 *   os_set_osage   0x68600   bbc 0 -> skip the integration, taking the static
 *                                    path at 0x686EC instead, which never
 *                                    advances the running position at 0x108
 *
 * and the end of `osage_dsp` at 0x67D1C does `clrbit 0` on that word every
 * frame. Nowhere in the osage module is there a matching `setbit 0`. So the
 * sway path is unreachable, and the five predictions below all follow. Each is
 * checked against a capture of a real fight rather than argued from the
 * listing:
 *
 *   1  bit 0 is clear on every chain, every frame
 *   2  0x108, the running position, never leaves the chain root
 *   3  0x114, the sway direction, never changes -- it holds whatever
 *      `osage_init` left, and its length is exactly the gravity constant
 *   4  the wind vector at 0x138 is zero, because the amplitude every character
 *      is pointed at in the table at 0x68914 is 0.0f
 *   5  the wind phase at 0x130 steps by 0x11C7 a frame regardless, driving
 *      nothing
 *
 * The capture must be taken while the fighter is moving -- `HOLD` set, and the
 * frames spanning more than one motion -- or the test proves nothing: a chain
 * with momentum looks exactly like one without it when its owner stands still.
 *
 * Run: node test-osage-mame.mjs [capture.json] [rom.zip]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadRomSet } from './vendor/noclip/js/romset.js';
import { readOsage, GRAVITY } from './vendor/noclip/js/osage.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const CAPTURE = args[0] ?? path.join(HERE, 'osage-honey-motion.json');
const ROM = args[1] ?? 'sfight.zip';

const read = (p) => {
    const b = fs.readFileSync(p);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

const cap = JSON.parse(fs.readFileSync(CAPTURE, 'utf8'));
const rom = await loadRomSet([read(ROM)]);
const osage = readOsage(rom, cap.char);
if (!osage) {
    console.log(`character ${cap.char} has no sway chains`);
    process.exit(1);
}

const len = (v) => Math.hypot(v[0], v[1], v[2]);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/* The breakpoint occasionally catches a stale g9 and reads a model number out
 * of it that no chain has. Those hits are dropped rather than trusted. */
const MODELS = new Set(osage.chains.flatMap((c) => c.segments.map((s) => s.model)));
const hits = (cap.segments ?? []).filter((h) => MODELS.has(h.model));
const frames = new Map((cap.frames ?? []).map((f) => [f.frame, f]));
if (!hits.length || !frames.size) {
    console.log(`${CAPTURE} holds no usable segment hits`);
    process.exit(1);
}

console.log(`${path.basename(CAPTURE)}: char ${cap.char}, ${hits.length} of `
    + `${cap.segments.length} hits usable, over ${frames.size} frames`);
console.log(`${osage.chains.length} chains, ${MODELS.size} distinct segment models`
    + `${cap.hold ? `, holding ${cap.hold}` : ''}`);

const chars = [...new Set([...frames.values()].map((f) => f.char))];
if (chars.length !== 1 || chars[0] !== cap.char) {
    console.log(`FAIL: capture is character ${chars.join(', ')}, wanted ${cap.char}`);
    process.exit(1);
}

/* The capture is only evidence if the fighter was moving in it. */
const motions = [...new Set([...frames.values()].map((f) => f.motion))];
const boneSpread = (which) => {
    const all = [...frames.values()].map((f) => f[which]).filter(Boolean);
    let worst = 0;
    for (const m of all) {
        for (let i = 0; i < 9; i++) worst = Math.max(worst, Math.abs(m[i] - all[0][i]));
    }
    return worst;
};
const chestMoved = boneSpread('bone1'), headMoved = boneSpread('bone2');
console.log(`motions ${motions.join(', ')}; over the capture the chest bone moved by `
    + `${chestMoved.toFixed(3)} and the head bone by ${headMoved.toFixed(3)}`);

let bad = 0;
const fail = (msg) => { console.log(`FAIL: ${msg}`); bad++; };
const verdict = (n) => (n ? `${n} MISMATCHED` : 'ok');

if (chestMoved < 0.05 && headMoved < 0.05) {
    fail('the fighter barely moved in this capture, so it cannot show whether a'
        + ' chain lags — retake it with HOLD set');
}

/* ---- 1. bit 0, the bit that would run the integrator ---------------------- */
const flagged = hits.filter((h) => h.flag !== undefined);
const flags = [...new Set(flagged.map((h) => h.flag >>> 0))];
const swaying = flagged.filter((h) => h.flag & 1);
console.log(`\nchain flags: ${flags.map((f) => '0x' + f.toString(16)).join(', ')}`);
if (swaying.length) fail(`bit 0 set on ${swaying.length} chains — the integrator does run`);

/* ---- 2. the running position never leaves the root ------------------------ */
let worstStep = 0;
for (const h of hits) {
    if (!h.root || !h.pos) continue;
    worstStep = Math.max(worstStep, len(sub(h.pos, h.root)));
}
if (worstStep > 1e-6) fail(`0x108 moved off the root by ${worstStep.toExponential(2)}`);

/* ---- 3. the sway direction never changes ---------------------------------- */
let worstDrift = 0, worstMag = 0;
const first = hits[0].dir;
for (const h of hits) {
    if (!h.dir) continue;
    worstDrift = Math.max(worstDrift, len(sub(h.dir, first)));
    worstMag = Math.max(worstMag, Math.abs(len(h.dir) - GRAVITY));
}
if (worstDrift > 0) fail(`0x114 drifted by ${worstDrift.toExponential(2)} — it is being written`);
if (worstMag > 1e-6) fail(`|0x114| is ${worstMag.toExponential(2)} off the gravity constant`);

/* ---- 4/5. the wind, and the phase that drives nothing --------------------- */
const windy = [...frames.values()].filter((f) => f.wind && len(f.wind) > 0);
if (windy.length) fail(`wind vector 0x138 is non-zero on ${windy.length} frames`);

const ordered = [...frames.values()].sort((a, b) => a.frame - b.frame);
const steps = [...new Set(ordered.slice(1).map((f, i) => f.phase - ordered[i].phase))];
const PHASE_STEP = 0x11c7;
if (steps.length !== 1 || steps[0] !== PHASE_STEP) {
    fail(`wind phase 0x130 steps by ${steps.join(', ')}, wanted ${PHASE_STEP}`);
}

console.log(`\nchecked ${hits.length} segment placements against the board:`);
console.log(`  bit 0 clear on every chain        ${verdict(swaying.length)}`);
console.log(`  0x108 pinned to the chain root    worst ${worstStep.toExponential(2)}   ${verdict(worstStep > 1e-6 ? 1 : 0)}`);
console.log(`  0x114 frozen at its init value    drift ${worstDrift.toExponential(2)}   ${verdict(worstDrift > 0 ? 1 : 0)}`);
console.log(`  |0x114| is the gravity constant   off by ${worstMag.toExponential(2)}   ${verdict(worstMag > 1e-6 ? 1 : 0)}`);
console.log(`  wind vector 0x138 zero            ${verdict(windy.length)}`);
console.log(`  wind phase 0x130 steps 0x${PHASE_STEP.toString(16)}      ${verdict(steps.length !== 1 || steps[0] !== PHASE_STEP ? 1 : 0)}`);

if (!bad) {
    console.log('\nThe integrator never ran: across these frames the chest bone moved by'
        + `\n${chestMoved.toFixed(3)} and the head by ${headMoved.toFixed(3)}, and the chain's own state did not`
        + '\nchange at all. The pigtails carry no momentum in the shipped game — the sway'
        + '\nis in the ROM but gated off, so a rest pose that tracks the bone is not an'
        + '\napproximation of what the board does, it is what the board does.');
}
process.exit(bad ? 1 : 0);
