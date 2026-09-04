/*
 * test-motion.mjs — the motion format and the pose it solves into.
 *
 * The block walk is checked against what the listing does: every motion in
 * `offset_list_motions` has to parse, and its streams have to end where the
 * next thing in the ROM begins rather than running off into it. The sampler is
 * checked at the ends of a curve, where the answer is a key's own value and no
 * interpolation is involved, and for continuity in between.
 *
 * The pose is checked against the geometry the ROM's own skeleton implies: a
 * limb that is asked for a point it can reach has to land on it, one that is
 * asked for a point it cannot has to end up straight, and every bone has to
 * keep its length whatever the frame.
 *
 * Run: node test-motion.mjs [rom.zip]
 */

import fs from 'fs';
import { loadRomSet } from './vendor/noclip/js/romset.js';
import { readCharacter, CHARACTERS, faceVariantModels } from './vendor/noclip/js/characters.js';
import {
    decodeMotion, sampleMotion, listMotions, evalChannel,
    MOTION_COUNT, LINEAR, HERMITE, TANGENT_RATE,
} from './vendor/noclip/js/motion.js';
import { buildPose, poseMatrices, turnedBy, SLOT_COUNT, SLOT_PARENT } from './vendor/noclip/js/pose.js';
import { decodeModel } from './vendor/noclip/js/model.js';
import { readOsage, osageParts } from './vendor/noclip/js/osage.js';
import { readTails, tailParts, CYCLE_LENGTH, LEAD as TAILS_LEAD } from './vendor/noclip/js/tails.js';
import {
    readExhaust, exhaustPart, exhaustDrawn, chestModel,
    CHEST_SLOT, CLOSED_CHESTS, CYCLE_LENGTH as EXHAUST_CYCLE,
} from './vendor/noclip/js/exhaust.js';
import {
    readMechArms, readRoboHead, readRoboAnims, armModel, headFrame,
    BOSS_CHARS, MINION_CHARS, HEAD_SLOT, ARM_SHIFT, ARM_COUNT, ARM_HOLD_MODEL,
    HEAD_WINDOW, HEAD_PHASE_SHIFT, HEAD_STEPS, HEAD_LAST, SPIN_STEP, SPIN_FLIP_BIT,
} from './vendor/noclip/js/eggrobo.js';
import { disasm } from './i960dis.mjs';

const ROM = process.argv[2] ?? 'sfight.zip';
const read = (p) => {
    const b = fs.readFileSync(p);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

const rom = await loadRomSet([read(ROM)]);

let bad = 0;
const fail = (msg) => { console.log(`FAIL: ${msg}`); bad++; };
const near = (a, b, eps) => Math.abs(a - b) <= eps;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/* ---- the block walk ------------------------------------------------------- */

const motions = listMotions(rom);
console.log(`${motions.length} of ${MOTION_COUNT - 1} motion slots hold a block`);
if (motions.length < 400) fail(`only ${motions.length} motions decoded`);

/* Motion 278 is the idle the pose engine was originally derived against. */
const idle = decodeMotion(rom, 278);
if (!idle) fail('motion 278 does not decode');
else {
    if (idle.address !== 0x02cc3ee6) fail(`motion 278 block 0x${idle.address.toString(16)}`);
    if (idle.frames !== 80) fail(`motion 278 has ${idle.frames} frames, expected 80`);
}

/* Every block's streams have to stay inside the gap before the next block. A
 * decode that mis-sized a channel would run past its neighbour. */
{
    const starts = [...new Set(motions.map((m) => decodeMotion(rom, m.id).offset))].sort((a, b) => a - b);
    let overruns = 0;
    for (const m of motions) {
        const d = decodeMotion(rom, m.id);
        const next = starts.find((s) => s > d.offset);
        if (next !== undefined && d.end > next) overruns++;
    }
    if (overruns) fail(`${overruns} motions' key data runs past the next block`);
    else console.log('every motion\'s key data ends before the next block starts');
}

/* Frame counts should agree with the curves: no key may sit past the last
 * frame, or the block is being read at the wrong stride. */
{
    let past = 0;
    for (const m of motions) {
        const d = decodeMotion(rom, m.id);
        for (const ch of d.channels) {
            if (ch.type !== LINEAR && ch.type !== HERMITE) continue;
            const last = rom.mainDataView.getFloat32(ch.times + (ch.count - 1) * 4, true);
            if (!(last >= 0) || last > d.frames + 1) { past++; break; }
        }
    }
    if (past) fail(`${past} motions have keys outside their frame count`);
    else console.log('every keyed channel\'s last key lands inside its frame count');
}

/* Key times may not fall: the sampler's scan assumes it. They are allowed to
 * repeat — a pair of keys at one time is how the data steps, and both the ROM
 * and the sampler take the first of such a pair. */
{
    let unsorted = 0, repeats = 0;
    for (const m of motions) {
        const d = decodeMotion(rom, m.id);
        for (const ch of d.channels) {
            if (ch.type !== LINEAR && ch.type !== HERMITE) continue;
            for (let i = 1; i < ch.count; i++) {
                const a = rom.mainDataView.getFloat32(ch.times + (i - 1) * 4, true);
                const b = rom.mainDataView.getFloat32(ch.times + i * 4, true);
                if (b < a) { unsorted++; i = ch.count; } else if (b === a) repeats++;
            }
        }
    }
    if (unsorted) fail(`${unsorted} channels have key times that fall`);
    else console.log(`every keyed channel's key times are non-decreasing (${repeats} step pairs)`);
}

/* ---- the sampler ---------------------------------------------------------- */

/* At a key's own time the answer is that key's value, with nothing interpolated
 * — the one place the curve can be checked against the ROM directly. */
{
    const dv = rom.mainDataView;
    let checked = 0, wrong = 0;
    for (const m of motions.slice(0, 120)) {
        const d = decodeMotion(rom, m.id);
        for (const ch of d.channels) {
            if (ch.type !== LINEAR && ch.type !== HERMITE) continue;
            const stride = ch.type === HERMITE ? 12 : 4;
            for (let i = 0; i < ch.count; i++) {
                const t = dv.getFloat32(ch.times + i * 4, true);
                /* A step pair shares a time and only the first of the two is
                 * ever the answer there, as it is in the ROM. */
                if (i + 1 < ch.count && dv.getFloat32(ch.times + (i + 1) * 4, true) === t) continue;
                if (i > 0 && dv.getFloat32(ch.times + (i - 1) * 4, true) === t) continue;
                const v = dv.getFloat32(ch.values + i * stride, true);
                checked++;
                if (!near(evalChannel(rom, ch, t), v, Math.max(1e-3, Math.abs(v) * 1e-5))) wrong++;
            }
        }
    }
    if (wrong) fail(`${wrong} of ${checked} keys do not sample back to their own value`);
    else console.log(`${checked} keys sample back to their own value`);
}

/* An interpolated curve stays near the keys it is drawn through. Sampled across
 * its whole span, a channel should barely leave the range its own keys span —
 * which is the property the tangent scale governs, and the one that fails
 * loudly if it is wrong: reading the tangents at face value turns a typical
 * one per cent of overshoot into a hundred and forty. */
{
    const dv = rom.mainDataView;
    const over = [];
    for (const m of motions) {
        const d = decodeMotion(rom, m.id);
        for (const ch of d.channels) {
            if (ch.type !== HERMITE || ch.count < 2) continue;
            let lo = Infinity, hi = -Infinity;
            for (let i = 0; i < ch.count; i++) {
                const v = dv.getFloat32(ch.values + i * 12, true);
                lo = Math.min(lo, v); hi = Math.max(hi, v);
            }
            const range = Math.max(hi - lo, 1);
            const t0 = dv.getFloat32(ch.times, true);
            const tn = dv.getFloat32(ch.times + (ch.count - 1) * 4, true);
            let worst = 0;
            for (let s = 0; s <= 100; s++) {
                const v = evalChannel(rom, ch, t0 + ((tn - t0) * s) / 100);
                worst = Math.max(worst, v > hi ? v - hi : lo - v);
            }
            over.push(Math.max(0, worst) / range);
        }
    }
    over.sort((a, b) => a - b);
    const median = over[over.length >> 1];
    const p95 = over[Math.floor(0.95 * (over.length - 1))];
    if (!(median < 0.1 && p95 < 1)) {
        fail(`curves overshoot their own keys: median ${median.toFixed(3)}, 95% ${p95.toFixed(3)}`);
    } else {
        console.log(`${over.length} curves stay near their keys `
            + `(median overshoot ${(median * 100).toFixed(1)}% of range, 95% ${(p95 * 100).toFixed(0)}%)`);
    }
}

/* The Hermite tangent scale. The data states it twice over, in two different
 * tangent conventions, and both have to come back as TANGENT_RATE: a key whose
 * in- and out-tangent agree carries the Catmull-Rom slope through its
 * neighbours, and a segment the data draws straight carries its own secant at
 * both ends. Reading either at face value would overshoot by thirty times. */
{
    const dv = rom.mainDataView;
    const smooth = [], straight = [];
    for (const m of motions) {
        const d = decodeMotion(rom, m.id);
        for (const ch of d.channels) {
            if (ch.type !== HERMITE || ch.count < 3) continue;
            const T = (i) => dv.getFloat32(ch.times + i * 4, true);
            const V = (i) => dv.getFloat32(ch.values + i * 12, true);
            const IN = (i) => dv.getFloat32(ch.values + i * 12 + 4, true);
            const OUT = (i) => dv.getFloat32(ch.values + i * 12 + 8, true);
            for (let i = 1; i < ch.count - 1; i++) {
                if (IN(i) === OUT(i) && Math.abs(IN(i)) > 1 && T(i + 1) > T(i - 1)) {
                    const cr = (V(i + 1) - V(i - 1)) / (T(i + 1) - T(i - 1));
                    if (Math.abs(cr) > 1e-3) smooth.push(IN(i) / cr);
                }
                if (IN(i) === OUT(i - 1) && Math.abs(IN(i)) > 1 && T(i) > T(i - 1)) {
                    const sec = (V(i) - V(i - 1)) / (T(i) - T(i - 1));
                    if (Math.abs(sec) > 1e-3) straight.push(IN(i) / sec);
                }
            }
        }
    }
    for (const [name, a] of [['smooth-tangent', smooth], ['straight-segment', straight]]) {
        a.sort((x, y) => x - y);
        const median = a[a.length >> 1];
        const exact = a.filter((r) => Math.abs(r - TANGENT_RATE) < 0.01).length;
        if (!near(median, TANGENT_RATE, 1e-3)) fail(`${name} tangents scale by ${median}, not ${TANGENT_RATE}`);
        else if (exact < a.length / 2) fail(`only ${exact} of ${a.length} ${name} tangents are exactly ${TANGENT_RATE}`);
        else console.log(`${exact} of ${a.length} ${name} keys scale by exactly ${TANGENT_RATE}`);
    }
}

/* Held before the first key and after the last, as the ROM leaves them. */
{
    const d = decodeMotion(rom, 278);
    const ch = d.channels.find((c) => c.type === HERMITE && c.count > 1);
    const dv = rom.mainDataView;
    const t0 = dv.getFloat32(ch.times, true);
    const tn = dv.getFloat32(ch.times + (ch.count - 1) * 4, true);
    if (!near(evalChannel(rom, ch, t0 - 50), dv.getFloat32(ch.values, true), 1e-6))
        fail('a curve does not hold flat before its first key');
    if (!near(evalChannel(rom, ch, tn + 50), dv.getFloat32(ch.values + (ch.count - 1) * 12, true), 1e-6))
        fail('a curve does not hold flat after its last key');
    console.log('curves hold flat outside their first and last key');
}

/* ---- the pose ------------------------------------------------------------- */

const playable = CHARACTERS.filter((c) => c.index <= 16);

/* Every fighter's skeleton has to read as real geometry. */
for (const entry of playable) {
    const c = readCharacter(rom, entry.index);
    if (!c) { fail(`${entry.name}: no character record`); continue; }
    for (let k = 0; k < 4; k++) {
        if (!(c.skeleton.upper[k] > 0) || !(c.skeleton.lower[k] > 0))
            fail(`${entry.name}: limb ${k} has a non-positive bone length`);
    }
    if (!(c.skeleton.spine[0] > 0)) fail(`${entry.name}: spine offset is not positive`);
}
console.log(`${playable.length} fighters have a well-formed skeleton`);

/* The hammer-squished form is a second skeleton, picked by skeleton type 2
 * rather than derived from the first. What makes it a flattening and not just
 * another rig is that it is the same skeleton with every length along the bone
 * halved: the lateral offsets carry over untouched but for rounding, so the
 * fighter goes flat without going narrow. Eggman B is the ROM's one exception —
 * its type-2 entry is Sonic's squished skeleton rather than its own — so it is
 * asked only to be shorter. */
{
    const EGGMAN_B = 9;
    let halved = 0, shorter = 0;
    for (const entry of playable) {
        const c = readCharacter(rom, entry.index);
        if (!c) continue;
        for (let k = 0; k < 4; k++) {
            if (!(c.skeletonSquished.upper[k] > 0) || !(c.skeletonSquished.lower[k] > 0)) {
                fail(`${entry.name}: squished limb ${k} has a non-positive bone length`);
            }
            if (!(c.skeletonSquished.upper[k] < c.skeleton.upper[k])) {
                fail(`${entry.name}: squished limb ${k} is not shorter than the normal one`);
            }
        }
        if (!(c.skeletonSquished.spine[0] < c.skeleton.spine[0])) {
            fail(`${entry.name}: squished spine is not shorter`);
        }
        shorter++;
        if (entry.index === EGGMAN_B) continue;
        let worst = 0;
        for (let i = 0; i < SLOT_COUNT; i++) {
            const a = c.skeleton.offsets[i][0];
            if (Math.abs(a) < 1e-6) continue;
            worst = Math.max(worst, Math.abs(c.skeletonSquished.offsets[i][0] / a - 0.5));
        }
        if (worst > 0.01) fail(`${entry.name}: squished bones are not halved (worst ${worst.toFixed(3)} off)`);
        else halved++;
    }
    console.log(`${shorter} squished skeletons are shorter than their own, `
        + `${halved} of them halved along every bone to within 1%`);
}

/* The sway chains — Honey's pigtails, Fang's tail. The record walk is what is
 * checked here: the types and their sizes have to carry the stream from the
 * head of a character's table to its terminator and land on the chains the ROM
 * holds. Honey's are the ones an independent bake of the same table also
 * produced, so they are pinned by value. */
{
    const expect = {
        15: { chains: 3, bones: [2, 2, 1], models: [[3525, 3526, 3527], [3525, 3526, 3527], [3528]] },
        4: { chains: 1, bones: [1], models: [[428, 429, 430]] },
        7: { chains: 1, bones: [1], models: [[1192]] },
        5: { chains: 1, bones: [2], models: [[2239]] },
        10: { chains: 4, bones: [1, 1, 1, 1], models: [[1812], [1812], [1810], [1811]] },
    };
    for (const [ch, want] of Object.entries(expect)) {
        const os = readOsage(rom, +ch);
        if (!os) { fail(`char ${ch}: no sway chains, expected ${want.chains}`); continue; }
        if (os.chains.length !== want.chains) {
            fail(`char ${ch}: ${os.chains.length} sway chains, expected ${want.chains}`);
            continue;
        }
        os.chains.forEach((c, i) => {
            if (c.bone !== want.bones[i]) fail(`char ${ch} chain ${i}: attaches to ${c.bone}, expected ${want.bones[i]}`);
            const got = c.segments.map((sg) => sg.model);
            if (got.join(',') !== want.models[i].join(',')) {
                fail(`char ${ch} chain ${i}: models ${got.join(',')}, expected ${want.models[i].join(',')}`);
            }
            for (const sg of c.segments) {
                if (!(sg.length > 0)) fail(`char ${ch} chain ${i}: a segment has no length`);
            }
        });
    }
    /* Everyone else shares one empty table, so nothing is invented for them. */
    let without = 0;
    for (const entry of playable) {
        if (expect[entry.index]) continue;
        if (readOsage(rom, entry.index)) fail(`${entry.name}: has sway chains, expected none`);
        else without++;
    }
    const total = Object.values(expect).reduce((a, w) => a + w.chains, 0);
    console.log(`${total} sway chains read across 5 fighters, and ${without} others have none`);
}

/* Where a sway chain attaches. The offset is measured in the attach bone's own
 * frame, and it can be checked against the fighter's anatomy because there is
 * an unambiguous forward axis available: the eye models sit at the +X end of
 * every head mesh, so the head's first column is the direction the face points.
 *
 * Against that, every chain in the game has to hang behind its owner — they are
 * four tails, two pigtails and four feathers, and not one of them belongs on a
 * chest. Bean is the case that makes it worth checking: his four chains are the
 * only ones whose offsets run *up* the spine rather than down, so a root that
 * inverted the bone axis would put his head feathers at his hips and still
 * leave every tail looking plausible. */
{
    const col = (M, i) => [M[i * 3], M[i * 3 + 1], M[i * 3 + 2]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let chains = 0;
    for (const entry of playable) {
        const c = readCharacter(rom, entry.index);
        const os = readOsage(rom, entry.index);
        if (!os) continue;
        const head = c.slots[2].model ? decodeModel(rom, c.slots[2].model) : null;
        const eye = c.face.eyes.length ? decodeModel(rom, c.face.eyes[0]) : null;
        if (!head || !eye) continue;
        /* The premise itself, checked rather than assumed. */
        /* "+X end" means past the head's own origin, not past the middle of
         * its bounds — Bean's beak carries the head's box well forward. */
        if (!((eye.bounds.min[0] + eye.bounds.max[0]) / 2 > 0)) {
            fail(`${entry.name}: the eyes are not at the +X end of the head, so forward is unknown`);
            continue;
        }
        const id = c.motions.find((x) => decodeMotion(rom, x));
        const m = decodeMotion(rom, id ?? 278);
        if (!m) continue;
        const pose = buildPose(c.skeleton, sampleMotion(rom, m, 1));
        const fwd = col(pose[2].r, 0);
        for (const [ci, chain] of os.chains.entries()) {
            const b = pose[chain.bone], o = chain.offset;
            const rel = [0, 1, 2].map((k) =>
                o[0] * b.r[k] + o[1] * b.r[3 + k] + o[2] * b.r[6 + k]);
            chains++;
            if (dot(rel, fwd) > 0) {
                fail(`${entry.name} chain ${ci}: attaches in front of the fighter`);
            }
            /* The offset's first component runs along the bone, so its sign has
             * to survive into the world: down the spine stays down. */
            const alongBone = dot(rel, col(b.r, 0));
            if (Math.sign(alongBone) !== Math.sign(o[0]) && Math.abs(o[0]) > 1e-4) {
                fail(`${entry.name} chain ${ci}: the along-bone offset flipped sign`);
            }
        }
    }
    console.log(`${chains} sway chains attach behind their fighter, `
        + 'each on the side of its bone the offset asks for');
}

/* The sway chains against the board.
 *
 * `mame-osage.py` breakpoints `os_set_osage` in a real match and reads
 * the chain out along with the coprocessor's own bone cache. What it reads is
 * in the osage frame's local space — `ost_norm` maps the root into it with the
 * frame's inverse, which is what PM slot 1 holds — so putting those numbers
 * back through the frame gives the positions the board actually drew, and they
 * can be held against what `js/osage.js` computes from the tables alone.
 *
 * Using the board's own bone matrix rather than a pose solved here keeps the
 * comparison about the chain and not about the pose engine.
 */
{
    const cap = 'osage-fang-segments.json';
    if (!fs.existsSync(cap)) {
        console.log('no osage capture alongside — skipping the board comparison');
    } else {
        const d = JSON.parse(fs.readFileSync(cap, 'utf8'));
        const bone = d.bones[1];
        const chest = { r: bone.slice(0, 9), t: bone.slice(9, 12) };
        /* A pose carrying the board's chest and head where the chains hang. */
        const c = readCharacter(rom, d.char);
        const os = readOsage(rom, d.char);
        const pose = buildPose(c.skeleton, sampleMotion(rom, decodeMotion(rom, 278), 1));
        pose[1] = chest;
        pose[2] = { r: d.bones[2].slice(0, 9), t: d.bones[2].slice(9, 12) };

        /* The frame, and the board's local positions through it. */
        const f = os.frame;
        const F = turnedBy(chest.r, f.ax, f.ay, f.az);
        const FT = [0, 1, 2].map((k) =>
            chest.t[k] + F[k] * f.offset[0] + F[3 + k] * f.offset[1] + F[6 + k] * f.offset[2]);
        const toWorld = (p) => [0, 1, 2].map((k) =>
            FT[k] + F[k] * p[0] + F[3 + k] * p[1] + F[6 + k] * p[2]);

        const seen = new Map();
        for (const sg of d.segments) {
            if (sg.out_pos && !seen.has(sg.model)) seen.set(sg.model, toWorld(sg.out_pos));
        }
        const ours = osageParts(pose, os);
        let checked = 0, worst = 0;
        for (const p of ours) {
            const want = seen.get(p.model);
            if (!want) continue;
            /* Ours is where the segment starts; the board's is where it ends. */
            const end = [0, 1, 2].map((k) => p.t[k] + (p.end ? p.end[k] - p.t[k] : 0));
            const d3 = Math.hypot(end[0] - want[0], end[1] - want[1], end[2] - want[2]);
            worst = Math.max(worst, d3);
            checked++;
        }
        if (!checked) fail('the capture and the tables share no segment models');
        else if (worst > 0.05) fail(`sway segments are ${worst.toFixed(3)} from where the board drew them`);
        else console.log(`${checked} sway segments land where the board drew them `
            + `(worst ${worst.toFixed(3)})`);
    }
}

/* Tails' tails.
 *
 * They are not a sway chain — `readOsage` finds nothing for him — but a baked
 * 64-pose cycle drawn twice off the pelvis, eight entries apart, by
 * `tails_tail_disp`. Two things say the tables are read right without needing a
 * machine to say so.
 *
 * The cycle has to close, or a loop would jump: model 171 is 108 again, vertex
 * for vertex. And the mirror character's table is the same 64 poses in a
 * different model order — 1396, 1407, 1418, ... — which only lines up with the
 * normal table entry for entry if the stride, the base and the byte order are
 * all right. Getting any of them wrong scrambles a permutation into noise.
 */
{
    const verts = (id) => {
        const m = decodeModel(rom, id);
        return m ? Array.from(m.positions).join(',') : null;
    };

    let withTails = 0, without = 0;
    for (const entry of CHARACTERS) {
        const t = readTails(rom, entry.index);
        const wanted = entry.index === 1 || entry.index === 27;
        if (Boolean(t) !== wanted) {
            fail(`${entry.name}: ${t ? 'has' : 'has no'} tails, expected the opposite`);
            continue;
        }
        if (!t) { without++; continue; }
        withTails++;
        if (t.cycle.length !== CYCLE_LENGTH) {
            fail(`${entry.name}: ${t.cycle.length} cycle entries, expected ${CYCLE_LENGTH}`);
        }
        if (t.cycle.some((id) => !decodeModel(rom, id))) {
            fail(`${entry.name}: a cycle entry has no mesh`);
        }
        if (!t.blur.every((id) => decodeModel(rom, id))) {
            fail(`${entry.name}: a propeller model has no mesh`);
        }
        const first = verts(t.cycle[0]);
        if (!first || first !== verts(t.cycle[CYCLE_LENGTH - 1])) {
            fail(`${entry.name}: the cycle does not close — its last pose is not its first`);
        }
    }
    const a = readTails(rom, 1).cycle, b = readTails(rom, 27).cycle;
    if (a.some((id, i) => id === b[i])) fail('the two tail tables share a model, so they are not two sets');
    const paired = a.filter((id, i) => verts(id) && verts(id) === verts(b[i])).length;
    if (paired !== CYCLE_LENGTH) {
        fail(`the mirror table matches the normal one on ${paired} of ${CYCLE_LENGTH} entries`);
    }
    console.log(`${withTails} fighters carry a ${CYCLE_LENGTH}-pose tail cycle and ${without} carry none; `
        + 'both cycles close, and the mirror table is the same animation reordered');
}

/* Where the pair hangs, and how it is turned.
 *
 * Three things hold whatever the pose, because they are what the display list
 * emits. Both tails leave the same point — one `set_pos`, two turns. They splay
 * exactly 45 degrees, which is the +0x1000 and the -0x2000 accumulated. And
 * each lies 22.5 degrees off the pelvis's own -Y, which is where the 0xC000
 * roll sends a tail mesh's -X: a different roll would leave the pair splayed
 * the same and pointing somewhere else entirely.
 */
{
    const col = (M, i) => [M[i * 3], M[i * 3 + 1], M[i * 3 + 2]];
    const dot = (x, y) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
    const angle = (x, y) => (Math.acos(Math.max(-1, Math.min(1, dot(x, y)))) * 180) / Math.PI;

    const c = readCharacter(rom, 1);
    const t = readTails(rom, 1);
    let checked = 0, worstSplay = 0, worstRoll = 0;
    for (const id of new Set(c.motions)) {
        const d = decodeMotion(rom, id);
        if (!d) continue;
        for (let f = 1; f <= d.frames; f += Math.max(1, Math.floor(d.frames / 8))) {
            const pose = buildPose(c.skeleton, sampleMotion(rom, d, f));
            const [l, r] = tailParts(pose, t, f);
            if (dist(l.t, r.t) > 1e-6) fail(`motion ${id} frame ${f}: the tails leave different points`);
            /* The mesh runs along its own -X, so that is where a tail lies. */
            const dl = col(l.r, 0).map((v) => -v), dr = col(r.r, 0).map((v) => -v);
            const hang = col(pose[9].r, 1).map((v) => -v);
            worstSplay = Math.max(worstSplay, Math.abs(angle(dl, dr) - 45));
            worstRoll = Math.max(worstRoll, Math.abs(angle(dl, hang) - 22.5),
                Math.abs(angle(dr, hang) - 22.5));
            checked++;
        }
    }
    if (worstSplay > 1e-3) fail(`the tails splay ${(45 + worstSplay).toFixed(3)} degrees, expected 45`);
    if (worstRoll > 1e-3) fail(`a tail lies ${(22.5 + worstRoll).toFixed(3)} degrees off the hang axis, expected 22.5`);
    else {
        console.log(`over ${checked} frames of Tails' own motions the pair leaves one point on the `
            + 'pelvis and splays 45 degrees about the axis the roll gives it');
    }
}

/* And anatomically: on his stance they hang behind him and below the waist.
 *
 * Forward is the head's own +X, the axis the sway chains are checked against
 * and for the same reason — the eye models sit at the +X end of every head
 * mesh, so the premise can be checked rather than assumed. Nothing in the
 * tables says which end of a fighter a tail belongs on; read the pelvis offset
 * with the wrong sign and it lands on his stomach.
 */
{
    const col = (M, i) => [M[i * 3], M[i * 3 + 1], M[i * 3 + 2]];
    const dot = (x, y) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];

    const c = readCharacter(rom, 1);
    const t = readTails(rom, 1);
    const eye = c.face.eyes.length ? decodeModel(rom, c.face.eyes[0]) : null;
    if (!eye || !((eye.bounds.min[0] + eye.bounds.max[0]) / 2 > 0)) {
        fail('Tails: the eyes are not at the +X end of the head, so forward is unknown');
    } else {
        const pose = buildPose(c.skeleton, sampleMotion(rom, decodeMotion(rom, c.motions[0]), 1));
        const fwd = col(pose[2].r, 0);
        for (const [i, p] of tailParts(pose, t, 0).entries()) {
            const rel = [0, 1, 2].map((k) => p.t[k] - pose[0].t[k]);
            if (dot(rel, fwd) > 0) fail(`tail ${i} hangs in front of him`);
            if (rel[1] > 0) fail(`tail ${i} hangs above the waist`);
            /* And the tail itself runs further back still, not back at him. */
            const tip = decodeModel(rom, p.model).bounds.min[0];
            const away = [0, 1, 2].map((k) => rel[k] + p.r[k] * tip);
            if (!(dot(away, fwd) < dot(rel, fwd))) fail(`tail ${i} points back towards him`);
        }
        console.log('on his stance both tails hang behind and below the waist, '
            + 'and run further back from there');
    }
}

/* The cycle is stepped by the display counter, not by the motion frame: it
 * wraps at 64 and the second tail runs eight entries ahead of the first, so a
 * motion shorter than the cycle still shows the whole of it. */
{
    const t = readTails(rom, 1);
    const c = readCharacter(rom, 1);
    const pose = buildPose(c.skeleton, sampleMotion(rom, decodeMotion(rom, c.motions[0]), 1));
    const seen = new Set();
    for (let n = 0; n < CYCLE_LENGTH * 2; n++) {
        const [l, r] = tailParts(pose, t, n);
        if (l.phase !== n % CYCLE_LENGTH) fail(`display frame ${n}: the cycle is at ${l.phase}`);
        if (r.phase !== (n + TAILS_LEAD) % CYCLE_LENGTH) {
            fail(`display frame ${n}: the second tail leads by ${(r.phase - l.phase + CYCLE_LENGTH) % CYCLE_LENGTH}`);
        }
        if (l.model !== t.cycle[l.phase] || r.model !== t.cycle[r.phase]) {
            fail(`display frame ${n}: a tail draws a model the cycle does not hold`);
        }
        seen.add(l.model);
    }
    /* 171 is 108 again, so the loop shows 63 distinct meshes. */
    if (seen.size !== CYCLE_LENGTH) fail(`${seen.size} of ${CYCLE_LENGTH} cycle entries were drawn`);
    console.log(`${CYCLE_LENGTH} display frames step the whole cycle once, `
        + `the second tail ${TAILS_LEAD} entries ahead`);
}

/* Metal Sonic's jet exhaust.
 *
 * Two tables of four `u16` at `0x1AB24` and `0x1AB2C`, walked a table a frame:
 * `efc_metalsonic_disp` picks the table on the frame counter's bottom bit and
 * the entry on the two above it. Nothing about that reading has to be taken on
 * trust, because the ROM states the same eight ids a second time and in the
 * interleaved order — `metal_and_lunar_fox_exhaust` at `0x97568`, as `u32`.
 * Getting the stride, the base or which table goes with an even frame wrong
 * fails against it.
 */
{
    const dv = rom.mainCpuView;
    const FLAT = 0x00097568;

    let withJet = 0, without = 0;
    for (const entry of CHARACTERS) {
        const e = readExhaust(rom, entry.index);
        const wanted = entry.index === 3 || entry.index === 29;
        if (Boolean(e) !== wanted) {
            fail(`${entry.name}: ${e ? 'has' : 'has no'} jet exhaust, expected the opposite`);
            continue;
        }
        if (!e) { without++; continue; }
        withJet++;
        if (e.cycle.length !== EXHAUST_CYCLE) {
            fail(`${entry.name}: ${e.cycle.length} cycle entries, expected ${EXHAUST_CYCLE}`);
        }
        if (e.cycle.some((id) => !decodeModel(rom, id))) {
            fail(`${entry.name}: a plume has no mesh`);
        }
        if (new Set(e.cycle).size !== EXHAUST_CYCLE) {
            fail(`${entry.name}: the two tables share a model, so they are not two shapes`);
        }
    }
    const e = readExhaust(rom, 3);
    for (let i = 0; i < EXHAUST_CYCLE; i++) {
        const flat = dv.getUint32(FLAT + i * 4, true);
        if (flat !== e.cycle[i]) {
            fail(`the flat table's entry ${i} is ${flat}, the routine's is ${e.cycle[i]}`);
        }
    }
    console.log(`${withJet} roster entries carry an ${EXHAUST_CYCLE}-frame jet cycle and ${without} carry none; `
        + `its order is the one 0x${FLAT.toString(16)} states outright`);
}

/* The two shapes, and that the four entries of each are in order.
 *
 * A cone that stretches and a burst that widens: within a table every entry
 * reaches further than the one before it — the cone along the axis it runs
 * down, the burst across it. Read the tables at the wrong stride and the four
 * come out shuffled, which this sees and a decode test would not.
 */
{
    const e = readExhaust(rom, 3);
    const span = (id, axis) => {
        const b = decodeModel(rom, id).bounds;
        return b.max[axis] - b.min[axis];
    };
    /* The plume runs down the chest's +Y; a burst's width is across it. */
    const grows = (ids, axis, what) => {
        for (let i = 1; i < ids.length; i++) {
            if (!(span(ids[i], axis) > span(ids[i - 1], axis))) {
                fail(`${what} ${ids[i]} is no ${axis === 1 ? 'longer' : 'wider'} than ${ids[i - 1]}`);
            }
        }
    };
    grows(e.cone, 1, 'cone');
    grows(e.burst, 0, 'burst');
    if (!(span(e.burst[0], 0) > span(e.cone[3], 0))) {
        fail('the burst is no wider than the cone, so the two tables are the same shape');
    }
    console.log(`cone ${e.cone.join(', ')} stretches ${span(e.cone[0], 1).toFixed(2)} to `
        + `${span(e.cone[3], 1).toFixed(2)}; burst ${e.burst.join(', ')} widens `
        + `${span(e.burst[0], 0).toFixed(2)} to ${span(e.burst[3], 0).toFixed(2)}`);
}

/* The guard, which is the whole of when the flame is up.
 *
 * `efc_metalsonic_disp` returns on two chest ids and draws on anything else,
 * and the chest is swapped between exactly two by `player_body_change_action`.
 * The pair has to be the chest his part table already holds and one that is
 * neither of the two the guard rejects, or the effect could never light; and
 * the open one has to reach further down the flame's own axis than the closed
 * one, which is the vent the flame comes out of.
 */
{
    const c = readCharacter(rom, 3);
    const e = readExhaust(rom, 3);
    const [shut, open] = e.bodies;
    if (shut !== c.slots[CHEST_SLOT].model) {
        fail(`the body table's first chest is ${shut}, his part table's is ${c.slots[CHEST_SLOT].model}`);
    }
    if (!CLOSED_CHESTS.includes(shut)) fail(`chest ${shut} is not one the guard rejects`);
    if (exhaustDrawn(shut)) fail(`the flame is up on the closed chest ${shut}`);
    if (!exhaustDrawn(open)) fail(`the flame is down on the open chest ${open}`);
    if (chestModel(e, false, 0) !== shut || chestModel(e, true, 0) !== open) {
        fail('the switch does not pick the body table’s two chests');
    }
    const reach = (id) => decodeModel(rom, id).bounds.max[1];
    if (!(reach(open) > reach(shut))) {
        fail(`chest ${open} reaches no further down the flame's axis than ${shut}`);
    }
    /* The other closed chest is the same mesh under other colours: the guard
     * names it separately because an id is all it has to go on. */
    const verts = (id) => Array.from(decodeModel(rom, id).positions).join(',');
    const other = CLOSED_CHESTS.find((id) => id !== shut);
    if (verts(other) !== verts(shut)) fail(`chest ${other} is not ${shut}'s mesh`);
    console.log(`chest ${shut} closed (and ${other}, the same mesh recoloured) keeps the flame down; `
        + `${open} opens ${(reach(open) - reach(shut)).toFixed(2)} further and lights it`);
}

/* And anatomically: the flame leaves his back and runs away behind him.
 *
 * Forward is the head's own +X, the same premise the tails are checked against
 * and checked the same way — the eye models sit at the +X end of the head mesh.
 * Nothing in the routine says which way the plume points: it is drawn on the
 * chest's matrix with no `set_pos` and no turn, so if the chest's +Y ran
 * forward the flame would come out of his front.
 */
{
    const col = (M, i) => [M[i * 3], M[i * 3 + 1], M[i * 3 + 2]];
    const dot = (x, y) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];

    const c = readCharacter(rom, 3);
    const e = readExhaust(rom, 3);
    const eye = c.face.eyes.length ? decodeModel(rom, c.face.eyes[0]) : null;
    if (!eye || !((eye.bounds.min[0] + eye.bounds.max[0]) / 2 > 0)) {
        fail('Metal Sonic: the eyes are not at the +X end of the head, so forward is unknown');
    } else {
        let checked = 0, nearest = -Infinity;
        for (const id of new Set(c.motions)) {
            const d = decodeMotion(rom, id);
            if (!d) continue;
            for (let f = 1; f <= d.frames; f += Math.max(1, Math.floor(d.frames / 8))) {
                const pose = buildPose(c.skeleton, sampleMotion(rom, d, f));
                const fwd = col(pose[2].r, 0);
                for (let n = 0; n < EXHAUST_CYCLE; n++) {
                    const p = exhaustPart(pose, e, n);
                    const b = decodeModel(rom, p.model).bounds;
                    if (dist(p.t, pose[CHEST_SLOT].t) > 1e-6) {
                        fail(`motion ${id} frame ${f}: the flame does not leave the chest's own origin`);
                    }
                    /* The far end of the plume, which runs down the chest's +Y. */
                    const tip = [0, 1, 2].map((k) => p.r[3 + k] * b.max[1]);
                    if (!(dot(tip, fwd) < 0)) {
                        fail(`motion ${id} frame ${f}: the flame runs out in front of him`);
                    }
                    nearest = Math.max(nearest, dot(tip, fwd));
                    checked++;
                }
            }
        }
        if (nearest < 0) {
            console.log(`over ${checked} plumes of Metal Sonic's own motions the flame leaves the chest's `
                + `origin and runs out behind him, never closer than ${(-nearest).toFixed(2)} back`);
        }
    }
}

/* The cycle is stepped by the display counter, not by the motion frame: it
 * wraps at eight and alternates the two tables, so a motion shorter than the
 * cycle still shows both shapes. */
{
    const c = readCharacter(rom, 3);
    const e = readExhaust(rom, 3);
    const pose = buildPose(c.skeleton, sampleMotion(rom, decodeMotion(rom, c.motions[0]), 1));
    const seen = new Set();
    for (let n = 0; n < EXHAUST_CYCLE * 2; n++) {
        const p = exhaustPart(pose, e, n);
        if (p.phase !== n % EXHAUST_CYCLE) fail(`display frame ${n}: the cycle is at ${p.phase}`);
        const table = n & 1 ? e.burst : e.cone;
        if (p.model !== table[(n >> 1) & 3]) {
            fail(`display frame ${n}: draws ${p.model}, not the ${n & 1 ? 'burst' : 'cone'} the counter picks`);
        }
        seen.add(p.model);
    }
    if (seen.size !== EXHAUST_CYCLE) fail(`${seen.size} of ${EXHAUST_CYCLE} plumes were drawn`);
    console.log(`${EXHAUST_CYCLE} display frames step the whole jet cycle once, cone and burst alternating`);
}

/* The Egg robots' two timed animations.
 *
 * Neither is in a keyframe block, so nothing about them can be checked the way
 * a motion is. What stands in for that is the instruction stream: both are
 * short routines in the program ROM, and `i960dis.mjs` reads it, so the
 * port's constants can be held against the operands the board's own code
 * carries rather than against the comment that quotes them.
 *
 * The tables are pinned without naming an address at all. Each routine is
 * walked, every address its instructions mention is collected, and the table
 * the port produced has to be readable at exactly one of them. A wrong base or
 * stride does not survive sixteen exact ids, and a table nobody's operand
 * points at is not the table the routine reads.
 */
{
    const dv = rom.mainCpuView;
    /* Fixed spans: far enough to cover each routine, and a walk that overruns
     * one only adds addresses nothing matches. */
    const MUNE_CHG = 0x00033758, HEAD_DISP = 0x0001a024;
    const walk = (addr, bytes) => {
        const out = [];
        for (let a = addr; a < addr + bytes;) {
            const d = disasm(dv, a);
            out.push(d);
            a += d.len;
        }
        return out;
    };
    const namedBy = (addr, bytes) => new Set(
        walk(addr, bytes).map((d) => d.target).filter((t) => t !== null));
    const says = (addr, bytes, text, what) => {
        if (!walk(addr, bytes).some((d) => d.text.startsWith(text))) {
            fail(`${what}: no '${text}' at 0x${addr.toString(16)}`);
        }
    };
    /* Read a table of `count` little-endian values of `width` bytes, or null
     * where it would run off the end of the program ROM. */
    const tableAt = (addr, count, width) => {
        if (addr + count * width > rom.maincpu.length) return null;
        const get = width === 2 ? 'getUint16' : 'getUint32';
        return Array.from({ length: count }, (_, i) => dv[get](addr + i * width, true));
    };

    const arms = readMechArms(rom);
    const heads = readRoboHead(rom);
    const anims = readRoboAnims(rom);
    if (!arms) fail('the arm table does not read');
    if (!heads) fail('the head table does not read');

    /* Each table has to sit at an address its own routine names, and at one. */
    const found = (name, named, want, width) => {
        const hits = [...named].filter((a) => {
            const got = tableAt(a, want.length, width);
            return got && got.every((v, i) => v === want[i]);
        });
        if (hits.length !== 1) {
            fail(`${name}: ${hits.length} of the addresses the routine names hold it, expected 1`);
            return null;
        }
        return hits[0];
    };
    const armsNamed = namedBy(MUNE_CHG, 0x60);
    const dispNamed = namedBy(HEAD_DISP, 0x34);
    const quarterNamed = new Set([...namedBy(anims[0], 0x14), ...namedBy(anims[1], 0x30)]);
    const armsAt = found('egg_mech_arms', armsNamed, arms, 2);
    const animsAt = found('egg_robo_anims', dispNamed, anims, 4);
    const headsAt = found('egg_robo_head_anim', quarterNamed, heads, 4);

    /* And the counter both of them step off is the board's own frame counter. */
    const FRAME_COUNTER = 0x00500020;
    if (!armsNamed.has(FRAME_COUNTER)) fail('the arm routine does not read frame_counter');
    if (!dispNamed.has(FRAME_COUNTER)) fail('the head routine does not read frame_counter');

    /* The arithmetic the port reimplements, spelled out of the port's own
     * constants so that changing one here fails against the ROM there. */
    says(MUNE_CHG, 0x60, `shro ${ARM_SHIFT},`, 'the arm shift');
    says(MUNE_CHG, 0x60, `mov ${ARM_COUNT - 1},`, 'the arm mask');
    says(MUNE_CHG, 0x60, `lda 0x${ARM_HOLD_MODEL.toString(16)},`, 'the held arm model');
    says(HEAD_DISP, 0x34, `shro ${HEAD_PHASE_SHIFT},`, 'the head phase shift');
    says(HEAD_DISP, 0x34, `and ${HEAD_STEPS - 1},`, 'the head step mask');
    says(HEAD_DISP, 0x34, `cmpibne ${HEAD_SLOT},`, 'the head slot');
    for (let bit = 0; bit < 8; bit++) {
        if (HEAD_WINDOW & (1 << bit)) says(HEAD_DISP, 0x34, `bbs ${bit},`, 'the head window');
    }
    says(anims[0], 0x14, `cmpobge ${HEAD_LAST},`, "stretch's clamp");
    says(anims[2], 0x08, `subo r6, ${HEAD_STEPS - 1}, r6`, "shrink's reversed step");
    says(anims[1], 0x30, `bbs ${SPIN_FLIP_BIT},`, "spin's direction bit");
    says(anims[1], 0x30, `shlo ${Math.log2(SPIN_STEP)}, 1,`, "spin's step");
    says(anims[1], 0x30, `shlo ${Math.log2(SPIN_STEP)}, ${(-1) & 0xf},`, "spin's negated step");
    /* Opcode 0x0A, ang_z: the turn is about the head's own Z and no other axis. */
    if (!namedBy(anims[1], 0x30).has(0x05000a0a)) fail('spin does not write the ang_z op');

    /* The two routines reach the mirror half by different means, which is why
     * the port names two indices for one and derives the other. The boss's
     * reads the raw character at +0x1B0 and compares both; the minion's reads
     * the folded one at +0x1B1, where a mirror entry has already come down
     * onto its base, and compares one. */
    says(MUNE_CHG, 0x60, 'ldob 0x1b0(g7)', "the boss's character byte");
    says(MUNE_CHG, 0x60, `mov ${BOSS_CHARS[0]},`, 'the boss');
    says(MUNE_CHG, 0x60, `addo 31, ${BOSS_CHARS[1] - 31},`, "the boss's mirror");
    says(HEAD_DISP, 0x34, 'ldob 0x1b1(g7)', "the minion's character byte");
    says(HEAD_DISP, 0x34, `cmpobne ${MINION_CHARS[0]},`, 'the minion');
    for (const [name, pair] of [['boss', BOSS_CHARS], ['minion', MINION_CHARS]]) {
        if (pair[1] - pair[0] !== 26) fail(`the ${name}'s mirror is not 26 past it`);
        for (const c of pair) {
            if (!CHARACTERS.some((e) => e.index === c)) fail(`character ${c} is not in the roster`);
        }
    }

    console.log(`egg_mech_arms 0x${armsAt?.toString(16)}, egg_robo_anims 0x${animsAt?.toString(16)}, `
        + `egg_robo_head_anim 0x${headsAt?.toString(16)} — each at an address its own routine names`);
}

/* The boss's arms: a ping-pong, and what the held pose is the middle of.
 *
 * Nine models out and the same nine back with neither end repeated, so the
 * walk steps one model at a time in both directions and closes at the wrap.
 * Read the table at the wrong stride and that contiguity is the first thing to
 * go. The pose the motion-kind bit pins it at is the middle of the nine the
 * table ramps through — not the middle of the sixteen entries, which is the
 * far end of the swing, and which is the answer a reader who never counted
 * would give.
 */
{
    const arms = readMechArms(rom);
    for (let i = 0; i < ARM_COUNT; i++) {
        const step = arms[(i + 1) % ARM_COUNT] - arms[i];
        if (Math.abs(step) !== 1) {
            fail(`the arm walk steps ${step} from entry ${i}, so the table is not contiguous`);
        }
    }
    const peak = arms.indexOf(Math.max(...arms));
    for (let k = 1; k < ARM_COUNT - peak; k++) {
        if (arms[peak + k] !== arms[peak - k]) fail(`the arm table does not fold at ${k} past its peak`);
    }
    if (new Set(arms).size !== ARM_COUNT / 2 + 1) {
        fail(`${new Set(arms).size} distinct arm models, expected ${ARM_COUNT / 2 + 1}`);
    }
    if (arms.some((id) => !decodeModel(rom, id)?.positions.length)) fail('an arm model has no mesh');

    const ramp = arms.slice(0, peak + 1);
    if (ARM_HOLD_MODEL !== ramp[(ramp.length - 1) / 2]) {
        fail(`the held arm ${ARM_HOLD_MODEL} is not the middle of the ${ramp.length} the table ramps through`);
    }
    if (ARM_HOLD_MODEL === arms[ARM_COUNT / 2]) {
        fail('the held arm is the middle entry of the sixteen, so this proves nothing');
    }

    /* A model every second frame, and the whole swing in 32 displayed frames. */
    const cycle = Array.from({ length: ARM_COUNT << ARM_SHIFT }, (_, f) => armModel(arms, f));
    if (new Set(cycle).size !== new Set(arms).size) fail('the cycle does not draw every arm model');
    for (let f = 0; f < cycle.length; f++) {
        if (armModel(arms, f) !== armModel(arms, f + cycle.length)) {
            fail(`the arm cycle does not close at ${f}`);
        }
        if (f % (1 << ARM_SHIFT) !== 0 && cycle[f] !== cycle[f - 1]) {
            fail(`the arm changes on frame ${f}, which is not a step`);
        }
    }
    if (armModel(arms, 7, true) !== ARM_HOLD_MODEL) fail('the motion-kind bit does not pin the arms');
    console.log(`${new Set(arms).size} arm models ${Math.min(...arms)}–${Math.max(...arms)} ping-pong over `
        + `${cycle.length} frames and close; held at ${ARM_HOLD_MODEL}, the middle of the ramp `
        + `and not of the sixteen (${arms[ARM_COUNT / 2]})`);
}

/* The minion's head: 48 frames of movement in every 256.
 *
 * The window is `frame_counter & 0xC0 == 0` split four ways, and the fourth
 * quarter's routine is the address the guards branch to when the robot is not
 * the minion at all — so it draws nothing, and the head is as still for that
 * quarter of the window as it is for the 192 frames outside it. That is the
 * whole of the claim, and it is arithmetic over one 256-frame period.
 */
{
    const heads = readRoboHead(rom);
    const anims = readRoboAnims(rom);
    const PERIOD = 0x100;

    if (heads.length !== HEAD_LAST + 1) fail(`${heads.length} head models, expected ${HEAD_LAST + 1}`);
    for (let i = 1; i < heads.length; i++) {
        if (heads[i] !== heads[i - 1] + 1) fail(`the head table jumps at ${i}, so it is not one run`);
    }
    if (heads.some((id) => !decodeModel(rom, id)?.positions.length)) fail('a head model has no mesh');

    const drawn = [];
    for (let f = 0; f < PERIOD; f++) if (headFrame(heads, anims, f)) drawn.push(f);
    if (drawn.some((f) => f & HEAD_WINDOW)) fail('the head draws outside its window');
    const quarters = [0, 1, 2, 3].map(
        (q) => drawn.filter((f) => ((f >>> HEAD_PHASE_SHIFT) & 3) === q).length);
    if (quarters.slice(0, 3).some((n) => n !== HEAD_STEPS)) {
        fail(`the moving quarters draw ${quarters.slice(0, 3).join('/')} frames, expected ${HEAD_STEPS} each`);
    }
    if (quarters[3] !== 0) fail(`the fourth quarter draws ${quarters[3]} frames, expected none`);
    /* And it draws none because its routine is the guards' own way out. */
    const exits = new Set(
        [0x0001a02c, 0x0001a038, 0x0001a03c].map((a) => disasm(rom.mainCpuView, a).target));
    if (exits.size !== 1 || !exits.has(anims[3])) {
        fail('the fourth quarter is not the address the head guards branch to');
    }

    /* Stretch walks the table forward and holds at its end; shrink is the same
     * walk with the step read backwards, so the two are reverses of each other
     * over the sixteen steps and both end on a real model. */
    const modelsOf = (base) => Array.from(
        { length: HEAD_STEPS }, (_, s) => headFrame(heads, anims, base + s).model);
    const stretch = modelsOf(0), shrink = modelsOf(HEAD_STEPS * 2);
    if (stretch.join() !== shrink.slice().reverse().join()) fail('shrink is not stretch reversed');
    if (stretch[0] !== heads[0]) fail('stretch does not start at the first model');
    if (stretch.slice(HEAD_LAST).some((m) => m !== heads[HEAD_LAST])) {
        fail('stretch does not reach its last model and clamp there');
    }

    console.log(`${drawn.length} of ${PERIOD} frames move the head, ${quarters.slice(0, 3).join('+')} over three `
        + `quarters and none in the fourth, whose routine 0x${anims[3].toString(16)} is the guards' own exit`);
}

/* The spin: a full turn over the quarter, and the other way round the next.
 *
 * Sixteen steps of 0x1000 binary radians is 0x10000, which is one revolution
 * and closes exactly. The direction comes off frame_counter bit 8 — the next
 * bit up from the window — so consecutive spins go opposite ways and the pair
 * cancels step for step. Both are why the step is a shift of the constant
 * rather than a division of a turn, and both fail if it is not.
 */
{
    const heads = readRoboHead(rom);
    const anims = readRoboAnims(rom);
    /* The quarter whose routine turns the head rather than swapping it. */
    const spinBase = anims.indexOf(anims[1]) << HEAD_PHASE_SHIFT;
    const turn = (base) => Array.from(
        { length: HEAD_STEPS }, (_, s) => headFrame(heads, anims, base + s));

    const fwd = turn(spinBase);
    const back = turn(spinBase + (1 << SPIN_FLIP_BIT));
    if (fwd.some((h) => h.model !== heads[HEAD_LAST])) fail('spin does not hold the last model');
    for (let s = 0; s < HEAD_STEPS; s++) {
        if (fwd[s].spin !== ((s * SPIN_STEP) & 0xffff)) {
            fail(`spin step ${s} is 0x${fwd[s].spin.toString(16)}`);
        }
        if ((fwd[s].spin + back[s].spin) & 0xffff) fail(`the two directions do not cancel at step ${s}`);
    }
    if (fwd[0].spin !== 0) fail('spin does not start square');
    if ((HEAD_STEPS * SPIN_STEP) & 0xffff) fail('the sixteen steps do not close a turn');
    if (new Set(fwd.map((h) => h.spin)).size !== HEAD_STEPS) fail('the spin repeats an angle');
    console.log(`spin holds ${heads[HEAD_LAST]} and turns it 0x${SPIN_STEP.toString(16)} a step, `
        + `${HEAD_STEPS} steps to the full 0x10000, reversing on frame_counter bit ${SPIN_FLIP_BIT}`);
}

/* Neither animation is on the sixteen slots.
 *
 * The arms are hung on the chest's matrix by `set_obj` and the head's models
 * stand in for what slot 2 draws, so none of them is a part-table entry for
 * anybody — if one were, it would be a mesh some fighter wears and the port
 * would be drawing it twice. The minion's own head is in its part table and is
 * not one of the eleven, which is what says the eleven are an animation rather
 * than the head itself.
 */
{
    const arms = readMechArms(rom);
    const heads = readRoboHead(rom);
    const parts = new Set();
    for (const entry of CHARACTERS) {
        const c = readCharacter(rom, entry.index);
        if (!c) continue;
        for (const m of [...c.partsNormal, ...c.partsSquished]) parts.add(m);
    }
    const worn = [...arms, ...heads].filter((m) => parts.has(m));
    if (worn.length) fail(`${worn.join(', ')} are in a part table, so they are not extra objects`);
    const minion = readCharacter(rom, MINION_CHARS[0]);
    if (heads.includes(minion.partsNormal[HEAD_SLOT])) {
        fail("the minion's own head is one of the eleven, so the table is not an animation");
    }
    console.log(`${arms.length + heads.length} arm and head models are on no part table; `
        + `the minion wears ${minion.partsNormal[HEAD_SLOT]} and animates ${heads[0]}–${heads[HEAD_LAST]}`);
}

/* Knuckles is the case that says the skeleton comes from SKELETON_TYPE_DATA and
 * not from the character record: his record's +0x04 points at Sonic's skeleton,
 * and only the type-0 entry has his own narrower hips. */
{
    const k = readCharacter(rom, 6);
    if (k.normalPtr === k.bonesPtr) {
        fail('Knuckles: the type-0 skeleton and the record agree, so this check has gone stale');
    } else if (Math.abs(k.skeleton.pivot[2][2]) > 0.15) {
        fail(`Knuckles: hip pivot ${k.skeleton.pivot[2][2]} looks like Sonic's, not his own`);
    } else {
        console.log(`Knuckles takes his own skeleton (0x${k.normalPtr.toString(16)}) rather than `
            + `the one his record names (0x${k.bonesPtr.toString(16)})`);
    }
}

/* Bone lengths must survive posing: whatever the frame, the distance from a
 * limb's pivot to its mid joint is the upper bone, and mid to end the lower. */
{
    let checked = 0;
    for (const entry of playable) {
        const c = readCharacter(rom, entry.index);
        const m = decodeMotion(rom, c.motions.find((id) => decodeMotion(rom, id)) ?? 278);
        if (!m) continue;
        for (let f = 0; f <= m.frames; f += Math.max(1, m.frames / 8)) {
            const pose = buildPose(c.skeleton, sampleMotion(rom, m, f));
            if (pose.length !== SLOT_COUNT) fail(`${entry.name}: pose has ${pose.length} slots`);
            for (const s of pose) {
                if (s.t.some((v) => !Number.isFinite(v))) fail(`${entry.name}: non-finite slot position`);
            }
            for (let k = 0; k < 4; k++) {
                const up = [3, 6, 10, 13][k], lo = up + 1, end = up + 2;
                if (!near(dist(pose[up].t, pose[lo].t), c.skeleton.upper[k], 1e-3))
                    fail(`${entry.name} limb ${k}: upper bone changed length at frame ${f}`);
                if (!near(dist(pose[lo].t, pose[end].t), c.skeleton.lower[k], 1e-3))
                    fail(`${entry.name} limb ${k}: lower bone changed length at frame ${f}`);
                checked++;
            }
        }
    }
    console.log(`${checked} posed limbs keep both bone lengths`);
}

/* A limb asked for a point it can reach has to land on it — that is what the
 * two-bone solve is for. Out of reach, it has to come out straight instead. */
{
    let reached = 0, straight = 0, missed = 0;
    for (const entry of playable) {
        const c = readCharacter(rom, entry.index);
        const m = decodeMotion(rom, c.motions.find((id) => decodeMotion(rom, id)) ?? 278);
        if (!m) continue;
        for (let f = 0; f <= m.frames; f += Math.max(1, m.frames / 8)) {
            const s = sampleMotion(rom, m, f);
            const pose = buildPose(c.skeleton, s);
            for (let k = 0; k < 4; k++) {
                const tgtObj = [3, 4, 6, 7][k];
                if (!s.targetUsed[tgtObj]) continue;
                const up = [3, 6, 10, 13][k], lo = up + 1, end = up + 2;
                /* The target is in the body frame the pose was solved in, so
                 * compare in the posed frame: reach is what is checkable here. */
                const span = c.skeleton.upper[k] + c.skeleton.lower[k];
                const fromPivot = dist(pose[up].t, pose[end].t);
                if (fromPivot > span + 1e-3) { missed++; continue; }
                /* Straight means mid sits on the pivot-to-end line. */
                const d1 = dist(pose[up].t, pose[lo].t) + dist(pose[lo].t, pose[end].t);
                if (near(d1, fromPivot, 1e-4)) straight++; else reached++;
            }
        }
    }
    if (missed) fail(`${missed} limbs end further from their pivot than they can reach`);
    else console.log(`no limb over-extends (${reached} bent, ${straight} straight)`);
}

/* The pose has to actually move: a played motion that returned the same numbers
 * every frame would mean the sampler is not reading the curves. */
{
    const c = readCharacter(rom, 0);
    const m = decodeMotion(rom, 278);
    const a = buildPose(c.skeleton, sampleMotion(rom, m, 0));
    const b = buildPose(c.skeleton, sampleMotion(rom, m, m.frames / 2));
    let moved = 0;
    for (let i = 0; i < SLOT_COUNT; i++) if (dist(a[i].t, b[i].t) > 1e-4) moved++;
    if (moved < 4) fail(`only ${moved} slots move between frame 0 and ${m.frames / 2}`);
    else console.log(`${moved} of ${SLOT_COUNT} slots move across motion 278`);
}

/* The pose has to be in the same frame as the meshes it moves.
 *
 * `buildPose` works in the board's frame, but `js/model.js` negates Z as it
 * reads geometry, so the matrix that places a part has to be conjugated —
 * F·M·F for F = diag(1, 1, -1) — and `poseMatrices` is where that happens.
 * Nothing about the pose on its own can catch getting this wrong: the
 * conjugate of a rotation is still a rotation, bones still keep their lengths
 * and feet still reach their targets. It only shows against the geometry, as
 * every part reflected through the XY plane.
 *
 * So this is checked where it shows: put each part's own bounding box through
 * the matrix the viewer would use, and the head has to end up over the waist
 * rather than hanging under it. Applying the board's matrix straight puts
 * Sonic's head centroid at 1.02 against a waist at 1.07 — upside down, which
 * is what the check is here to stop coming back. */
{
    const corners = (b) => {
        const out = [];
        for (let k = 0; k < 8; k++) {
            out.push([(k & 1) ? b.max[0] : b.min[0], (k & 2) ? b.max[1] : b.min[1],
                (k & 4) ? b.max[2] : b.min[2]]);
        }
        return out;
    };
    /* m is the flat column-major 4x4 poseMatrices hands three.js. */
    const applyY = (m, p) => m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];

    let checked = 0, caught = 0;
    for (const entry of playable) {
        const c = readCharacter(rom, entry.index);
        const headModel = c.slots[2].model;
        const head = headModel ? decodeModel(rom, headModel) : null;
        if (!head) continue;                      /* Super Sonic's head slot is a sentinel */
        const id = c.motions.find((x) => decodeMotion(rom, x));
        const m = decodeMotion(rom, id ?? 278);
        if (!m) continue;
        for (const f of [1, Math.max(1, Math.floor(m.frames / 2))]) {
            const pose = buildPose(c.skeleton, sampleMotion(rom, m, f));
            const mats = poseMatrices(pose);
            const waistY = mats[0][13];
            const ys = corners(head.bounds).map((p) => applyY(mats[2], p));
            const mid = ys.reduce((a, v) => a + v, 0) / ys.length;
            if (!(mid > waistY)) {
                fail(`${entry.name}: posed head sits at ${mid.toFixed(3)}, not above the waist `
                    + `at ${waistY.toFixed(3)} — the pose and the meshes are in different frames`);
            }
            checked++;
            /* Would the unconjugated matrix have been caught here? */
            const raw = [...mats[2]];
            raw[2] = -raw[2]; raw[6] = -raw[6]; raw[8] = -raw[8];
            raw[9] = -raw[9]; raw[14] = -raw[14];
            const rys = corners(head.bounds).map((p) => applyY(raw, p));
            if (!(rys.reduce((a, v) => a + v, 0) / rys.length > waistY)) caught++;
        }
    }
    console.log(`${checked} posed heads sit above the waist `
        + `(${caught} of them would not, applied in the board's frame)`);
}

/* The slot tree has to be connected — every slot but the waist has a parent. */
{
    if (SLOT_PARENT[0] !== -1) fail('slot 0 should be the root');
    for (let i = 1; i < SLOT_COUNT; i++) {
        if (!(SLOT_PARENT[i] >= 0 && SLOT_PARENT[i] < i)) fail(`slot ${i} has a bad parent`);
    }
}

/* Sampling every frame of every motion must not throw or produce NaN. */
{
    let frames = 0, bogus = 0;
    const c = readCharacter(rom, 0);
    for (const mm of motions) {
        const d = decodeMotion(rom, mm.id);
        for (let f = 0; f <= d.frames; f += Math.max(1, Math.floor(d.frames / 4))) {
            const s = sampleMotion(rom, d, f);
            if (s.targets.some((v) => !Number.isFinite(v))) bogus++;
            const pose = buildPose(c.skeleton, s);
            if (pose.some((p) => p.r.some((v) => !Number.isFinite(v)))) bogus++;
            frames++;
        }
    }
    if (bogus) fail(`${bogus} of ${frames} sampled frames produced non-finite values`);
    else console.log(`${frames} sampled frames across every motion are finite`);
}

/* The faces no part table names.
 *
 * `faceVariantModels` reads an array of twenty-one face tables, each indexed by
 * character exactly as the base table is. Three things say it is the right
 * array rather than a plausible-looking one nearby.
 *
 * The base table has to be a copy of one of them — it is entry 0, pointer for
 * pointer across all 52 slots, and a wrong array would not line up. Every id
 * the twenty-one give has to decode, and a mis-strided read would produce
 * numbers that mostly do not. And they have to name faces the roster does not
 * already carry: they are only worth reading for the heads no part table
 * reaches, of which Honey's open-mouthed 3580 is one.
 */
{
    const dv = rom.mainCpuView;
    const FACE_TABLE = 0x000c533c, VARIANTS = 0x000c540c, ENTRIES = 52;

    const table0 = dv.getUint32(VARIANTS, true);
    let sameAsBase = 0;
    for (let c = 0; c < ENTRIES; c++) {
        if (dv.getUint32(FACE_TABLE + c * 4, true) === dv.getUint32(table0 + c * 4, true)) sameAsBase++;
    }
    if (sameAsBase !== ENTRIES) {
        fail(`the base face table matches variant 0 on ${sameAsBase} of ${ENTRIES} entries`);
    }

    const variants = faceVariantModels(rom);
    const noMesh = [...variants].filter((id) => !decodeModel(rom, id));
    if (noMesh.length) fail(`${noMesh.length} variant face models have no mesh: ${noMesh.slice(0, 8).join(', ')}`);

    const roster = new Set();
    for (const entry of CHARACTERS) {
        const c = readCharacter(rom, entry.index);
        if (!c) continue;
        for (const m of [...c.partsNormal, ...c.partsSquished, ...c.face.heads, ...c.face.eyes]) roster.add(m);
    }
    const extra = [...variants].filter((id) => !roster.has(id));
    if (!extra.includes(3580)) fail("Honey's open-mouthed head 3580 is not among the variant faces");
    if (extra.length < 200) fail(`only ${extra.length} variant faces are new to the roster`);
    console.log(`${variants.size} face models across 21 variant tables, all with meshes, `
        + `${extra.length} of them named by no part table`);
}

/* The eyes' own texture points.
 *
 * Every face record carries two texture-point blocks, one per eye model, in the
 * shape move_tpd_req's blocks are. Two things say they are read as blocks and
 * not as whatever happens to sit at that offset: each is exactly as long as the
 * stream its eye model walks, and for most fighters it is byte-identical to the
 * points already in the model — a block that was being read at the wrong offset
 * would be neither. The ones that differ are the reason to read them at all, so
 * the check names them: Espio's second eye keeps every u and moves v.
 */
{
    const dv = rom.mainCpuView;
    let withBlock = 0, sameLength = 0, identical = 0;
    const differ = [];
    for (const entry of CHARACTERS) {
        const c = readCharacter(rom, entry.index);
        if (!c) continue;
        c.face.eyes.forEach((id, i) => {
            const pts = c.face.eyePoints[i];
            if (!pts) return;
            withBlock++;
            const own = decodeModel(rom, id);
            const ovr = decodeModel(rom, id, pts);
            if (!own || !ovr) { fail(`eye ${id} does not decode`); return; }
            /* Same mesh either way: only the texture points are replaced. */
            if (own.positions.length !== ovr.positions.length) {
                fail(`eye ${id}: the override changes the geometry, not just the points`);
            }
            /* A block that ran out early would leave the faces past its end
             * with no coordinates at all, so the two decodes must zero the same
             * corners — which for these models is none of them. */
            const zeros = (m) => m.uvs.reduce((n, v, k) => n + (v === 0 && m.uvs[k ^ 1] === 0 ? 1 : 0), 0);
            if (zeros(ovr) === zeros(own)) sameLength++;
            const same = own.uvs.every((v, k) => Math.abs(v - ovr.uvs[k]) < 0.001);
            if (same) identical++;
            else differ.push(id);
        });
    }
    if (!withBlock) fail('no face record carries eye texture points');
    if (sameLength !== withBlock) {
        fail(`${withBlock - sameLength} eye blocks run out before the model's faces do`);
    }
    if (!differ.includes(1183)) fail("Espio's second eye does not take different points from its own");
    console.log(`${withBlock} eye texture-point blocks, ${identical} identical to the model's own points, `
        + `${differ.length} different (${differ.join(', ')})`);
}

console.log(bad ? `\n${bad} failure(s)` : '\nall motion checks passed');
process.exit(bad ? 1 : 0);
