/*
 * test-objects.mjs — the per-stage object routines, checked against what the
 * decompilation says they do.
 *
 * These draws are the one part of a stage with no capture behind them yet, so
 * what can be checked is the arithmetic: that each stage runs the routines its
 * own record names, that the clocks come out at the rates the listing sets
 * (a blimp lap in 2048 frames, a reel turn in 64, a propeller blade on for one
 * frame in two), that the values that walk a range come back to where they
 * started, and that every model named actually carries geometry.
 *
 * Run: node test-objects.mjs [rom.zip]
 */

import fs from 'fs';
import { loadRomSet, readModelEntry } from './vendor/noclip/js/romset.js';
import { readStageTable } from './vendor/noclip/js/stages.js';
import {
    buildStageDisplayList, readFrameTables, opsAt, frameModel, giantWingRoll,
    stageWorldFrame, frameScroll, scrollPeriod,
} from './vendor/noclip/js/display.js';
import { decodeModel } from './vendor/noclip/js/model.js';

const ROM = process.argv[2] ?? 'sfight.zip';
const read = (p) => {
    const b = fs.readFileSync(p);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

const rom = await loadRomSet([read(ROM)]);
const stages = readStageTable(rom);
const frames = readFrameTables(rom);

let bad = 0;
const fail = (msg) => { console.log(`FAIL: ${msg}`); bad++; };
const objectsOf = (slot) =>
    buildStageDisplayList(stages[slot], frames).filter((e) => e.layer === 'objects');
/* The position a draw's op list puts the model's origin at. */
function at(entry, frame) {
    let p = [0, 0, 0];
    for (const [kind, v] of [...opsAt(entry, frame)].reverse()) {
        if (kind === 't') p = [p[0] + v[0], p[1] + v[1], p[2] + v[2]];
        else if (kind === 's') p = [p[0] * v[0], p[1] * v[1], p[2] * v[2]];
        else {
            const t = (v * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
            if (kind === 'r') p = [c * p[0] + s * p[2], p[1], -s * p[0] + c * p[2]];
            else if (kind === 'rx') p = [p[0], c * p[1] - s * p[2], s * p[1] + c * p[2]];
            else p = [c * p[0] - s * p[1], s * p[0] + c * p[1], p[2]];
        }
    }
    return p;
}
/* The angle of one op, at a frame — for the draws whose whole point is that it
 * turns. */
const angle = (entry, frame, kind) =>
    (opsAt(entry, frame).find((op) => op[0] === kind) ?? [, 0])[1];
const turns = (a, b) => Math.abs(((b - a) % 360 + 540) % 360 - 180) < 1e-9;

/* ---- every stage runs what its own record asks for ---- */
{
    const want = { 1: 6, 2: 31, 3: 6, 4: 1, 5: 8, 6: 7, 7: 16, 8: 8 };
    for (const st of stages) {
        const n = objectsOf(st.slot).length;
        const w = want[st.slot] ?? 0;
        if (n !== w) fail(`slot ${st.slot} draws ${n} object parts, wanted ${w}`);
    }
    const named = stages.filter((s) => s.objects.length).map((s) => s.slot);
    console.log(`objects on slots ${named.join(', ')}`);
}

/* ---- Casino Night: the blimp orbits, the reels turn, the cards deal ---- */
{
    const list = objectsOf(5);
    const blimp = list[0];
    const r = at(blimp, 0);
    if (Math.abs(Math.hypot(r[0], r[2]) - 40) > 1e-9 || Math.abs(r[1] - 20) > 1e-9) {
        fail(`the blimp flies at ${r.map((v) => v.toFixed(2))}, wanted radius 40 at height 20`);
    }
    /* 0x10 angle units a frame off a counter that steps twice: a lap in 2048. */
    const lap = 2048;
    for (const f of [0, 37, 500]) {
        const a = at(blimp, f), b = at(blimp, f + lap);
        if (Math.hypot(a[0] - b[0], a[2] - b[2]) > 1e-6) fail(`the blimp's lap is not ${lap} frames`);
        if (Math.hypot(a[0] - r[0], a[2] - r[2]) < 1e-9 && f) fail('the blimp is not moving');
    }
    /* Three reels a sixth and a third of a turn apart, all on X, all 64 frames
     * to the turn. */
    const reels = list.filter((e) => e.model === 177);
    if (reels.length !== 3) fail(`${reels.length} slot reels, wanted 3`);
    const spread = reels.map((e) => at(e, 0)[0]);
    if (spread.join() !== [0, 9.6, -9.6].join()) fail(`the reels stand at ${spread}`);
    for (const e of reels) {
        if (!turns(angle(e, 0, 'rx'), angle(e, 64, 'rx'))) fail('a reel does not turn in 64 frames');
        if (Math.abs(angle(e, 0, 'rx') - angle(e, 1, 'rx')) < 1e-9) fail('a reel is not turning');
    }
    const off = reels.map((e) => Math.round(angle(e, 0, 'rx') / (360 / 65536)) - 0x400);
    if (off.join() !== [0, 0x6000, 0xb000].join()) fail(`the reels start at ${off}`);
    /* One card a frame, all thirty-two of them. */
    const cards = list.find((e) => e.anim?.frames === frames.cards);
    const dealt = new Set(Array.from({ length: 32 }, (_, f) => frameModel(cards.anim, f)));
    if (dealt.size !== 32) fail(`${dealt.size} of the 32 floating cards are ever drawn`);
    console.log('casino blimp lap 2048 frames, three reels 64, 32 cards');
}

/* ---- Dynamite Plant: the swing turns round at both ends ---- */
{
    const bombs = objectsOf(6).filter((e) => e.model === 1862);
    let lo = Infinity, hi = -Infinity, seen = null, period = 0;
    for (let f = 0; f < 4096; f++) {
        const y = at(bombs[0], f)[1];
        lo = Math.min(lo, y); hi = Math.max(hi, y);
        if (seen === null) seen = y;
        else if (!period && Math.abs(y - seen) < 1e-9 && f > 1) period = f;
    }
    /* The value walks 0 to 5.4 in steps of 0.05, 108 of them each way; the draw
     * sits it 0.5 up and stage_dsp's 1.6 multiplies the lot. */
    if (Math.abs(lo - 1.6 * 0.5) > 1e-6 || Math.abs(hi - 1.6 * 5.9) > 1e-6) {
        fail(`the swing covers ${lo.toFixed(3)}..${hi.toFixed(3)}, wanted 0.8..9.44`);
    }
    if (period !== 216) fail(`the swing repeats every ${period} frames, wanted 216`);
    /* The two are counterweights: one is high where the other is low, and the
     * pair always add up to the ends of the range. */
    for (const f of [0, 61, 140]) {
        const sum = at(bombs[0], f)[1] + at(bombs[1], f)[1];
        if (Math.abs(sum - 1.6 * 6.4) > 1e-6) fail(`the pair do not sum to 5.4 + 1.0 at frame ${f}`);
    }
    /* Two gears on one face, turning opposite ways at the same rate. */
    const gears = objectsOf(6).filter((e) => e.model === 2265);
    const step = gears.map((e) => angle(e, 1, 'rz') - angle(e, 0, 'rz'));
    if (Math.abs(step[0] + step[1]) > 1e-9 || !step[0]) fail(`the gears turn at ${step}`);
    console.log(`dynamite swing 0.5..5.9 over ${period} frames, gears ±${Math.abs(step[0]).toFixed(3)}°`);
}

/* ---- Giant Wing: the plane banks, the clouds come round again ---- */
{
    const roll = Array.from({ length: 4096 }, (_, f) => giantWingRoll(f));
    const amp = Math.max(...roll.map(Math.abs));
    /* Two sine terms, 411 and 133 angle units — under three degrees all told. */
    if (amp > 411 + 133 || amp < 411) fail(`the plane rolls ${amp} angle units`);
    /* Nothing has run on the frame the stage loads, so it starts level and the
     * roll's second term steps in with its own phase a frame later. */
    if (roll[0] !== 0) fail('the plane starts banked');
    if (roll[1] === 0) fail('the plane never starts rolling');
    if (!stageWorldFrame(stages[7], 100)) fail('Giant Wing does not move its world');
    if (stageWorldFrame(stages[7], 100)[0][0] !== 'rz') fail('the plane banks about the wrong axis');

    /* Each cloud walks toward the plane and starts over at the far limit; the
     * one that steps 12.5 through 12000 units is back where it began in 960. */
    const clouds = objectsOf(7).filter((e) => [3086, 3087, 3673].includes(e.model));
    for (const c of clouds) {
        const z = (f) => at(c, f)[2];
        let jumps = 0;
        for (let f = 1; f < 2000; f++) if (Math.abs(z(f) - z(f - 1)) > 100) jumps++;
        if (!jumps) fail(`a cloud never wraps`);
        if (Math.abs(z(0) - z(960)) > 1e-6 && Math.abs(z(0) - z(800)) > 1e-6) {
            fail(`a cloud's sweep does not close in 960 or 800 frames`);
        }
    }
    /* The blade is drawn on one frame in two. */
    const blade = objectsOf(7).find((e) => e.anim?.frames === frames.blade);
    const shown = Array.from({ length: 4 }, (_, f) => frameModel(blade.anim, f));
    if (shown.join() !== [2863, 2846, 2863, 2846].join()) fail(`the blade shows ${shown}`);
    console.log(`giant wing rolls ±${amp} units, ${clouds.length} clouds, blade every other frame`);
}

/* ---- Aurora Icefield: eight pillars, each with a diamond turning on top ---- */
{
    const pillars = objectsOf(2).filter((e) => e.model === 4278);
    if (pillars.length !== 8) fail(`${pillars.length} ice pillars, wanted 8`);
    const spun = objectsOf(2).filter((e) => typeof e.ops === 'function');
    if (spun.length !== 8) fail(`${spun.length} turning diamonds, wanted 8`);
    for (const d of spun) {
        if (!turns(angle(d, 0, 'r'), angle(d, 256, 'r'))) fail('a diamond does not turn in 256 frames');
    }
    /* A pillar and its two diamonds stand on the same spot, the diamonds up the
     * pillar's own height. */
    const foot = at(pillars[0], 0), head = at(spun[0], 0);
    if (Math.hypot(foot[0] - head[0], foot[2] - head[2]) > 1e-6) fail('a diamond is off its pillar');
    if (head[1] <= foot[1]) fail('a diamond is not above its pillar');
    console.log(`aurora ${pillars.length} pillars, diamonds turning in 256 frames`);
}

/* ---- Aurora Icefield: the ring floor is drawn once, by the object ---------
 *
 * The stage takes two skips no other record does — flag bit 2 turns off
 * camera_init's stage_floor, and stage_dsp returns on the slot before it draws
 * stage_platform — so 559 reaches the screen exactly once, out of aurora_disp,
 * and 558 not at all.
 */
{
    const stage = stages[2];
    if (!(stage.flags & (1 << 2))) fail('Aurora Icefield does not set flag bit 2');
    /* Two records set it: this one and slot 15, the attract-mode ADV_MOV2. No
     * arena a fight is held in does. */
    const skips = stages.filter((st) => st.flags & (1 << 2)).map((st) => st.slot);
    if (skips.join() !== [2, 15].join()) fail(`flag bit 2 is set on slots ${skips}`);
    const list = buildStageDisplayList(stage, frames);
    const layers = list.filter((e) => e.layer === 'floor' || e.layer === 'platform');
    if (layers.length) fail(`Aurora draws ${layers.length} floor/platform parts, wanted 0`);
    const floors = list.filter((e) => e.model === 559);
    if (floors.length !== 1) fail(`${floors.length} draws of 559, wanted 1`);
    if (floors[0].layer !== 'objects') fail(`559 is drawn on ${floors[0].layer}`);
    if (list.some((e) => e.model === 558)) fail('Aurora draws its record floor 558');
    console.log('aurora ring floor drawn once, by the object');
}

/* ---- Aurora Icefield: the walrus statues and their reflection -------------
 *
 * aurora_disp draws model 1601 at the matrix object_control leaves it, and
 * 2319 through the same negative Y the sky's reflection uses. So what is worth
 * pinning is that 2319 really is 1601's reflection and not some other object:
 * a lighter model standing on the same footprint, which mirroring therefore
 * drops directly under the pair rather than somewhere else on the ice. And
 * that the pair stands outside the ring, on the +Z side the barrier panel the
 * ROM's bit 0 names covers — which is the whole reason the draw is gated at
 * all.
 */
const AURORA_WALRUSES = 1601;
const AURORA_WALRUSES_REFLECTED = 2319;
{
    const objects = objectsOf(2);
    const draw = (m) => objects.filter((e) => e.model === m);
    const stand = draw(AURORA_WALRUSES), under = draw(AURORA_WALRUSES_REFLECTED);
    if (stand.length !== 1) fail(`${stand.length} walrus draws, wanted 1`);
    if (under.length !== 1) fail(`${under.length} walrus reflections, wanted 1`);
    if (stand[0].ops.length) fail('the walruses are drawn with a transform of their own');
    const mirror = JSON.stringify(under[0].ops);
    if (mirror !== JSON.stringify([['s', [1, -1, 1]]])) fail(`the reflection is drawn at ${mirror}`);

    const box = (m) => {
        const p = decodeModel(rom, m).positions;
        const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < p.length; i += 3) {
            for (let k = 0; k < 3; k++) {
                lo[k] = Math.min(lo[k], p[i + k]);
                hi[k] = Math.max(hi[k], p[i + k]);
            }
        }
        return { lo, hi, verts: p.length / 3 };
    };
    const a = box(AURORA_WALRUSES), b = box(AURORA_WALRUSES_REFLECTED);
    if (b.verts >= a.verts) fail(`the reflection carries ${b.verts} vertices against ${a.verts}`);
    /* The same footprint, to within a unit on a pair fourteen across. */
    for (const k of [0, 1, 2]) {
        if (Math.abs(a.lo[k] - b.lo[k]) > 1.1 || Math.abs(a.hi[k] - b.hi[k]) > 1.1) {
            fail(`the reflection's bounds do not match the walruses' on axis ${k}`);
        }
    }
    /* Standing on the ice and mirrored below it, not floating either way. */
    if (a.lo[1] > 0.1 || a.hi[1] < 5) fail('the walruses do not stand on the floor');

    /* Outside the ring, on the side barrier panel 0 covers. The decoder has
     * already negated Z, so the board's +Z is the viewer's -Z. */
    const floor = objects.find((e) => e.model === 559);
    const reach = box(559).hi[0] * floor.ops[0][1][0];
    if (!(a.hi[2] < -reach)) fail(`the walruses stand at z ${a.hi[2]}, inside the floor's ${reach}`);
    console.log(`aurora walruses ${a.verts} vertices, reflected as ${b.verts}, `
        + `at z ${a.lo[2].toFixed(1)}..${a.hi[2].toFixed(1)} outside the floor's ${(-reach).toFixed(1)}`);
}

/* ---- Aurora Icefield: the curtain's texture points ------------------------
 *
 * aurora_init hands move_tpd_req a block of thirty-six (v, u) pairs and one
 * offset, and set_obj_tpd draws model 1604 with them instead of its own. So
 * check the two things that makes true: that the block really does replace the
 * model's points rather than merely repeat them — two of the nine panels have
 * their v the other way round, and left alone they would scroll against the
 * other seven — and that the offset walks v half a texel a frame, wrapping on a
 * whole tile so the curtain comes back to itself.
 */
const AURORA_BOREALIS = 1604;
{
    const draws = objectsOf(2).filter((e) => e.model === AURORA_BOREALIS);
    if (draws.length !== 2) fail(`${draws.length} aurora draws, wanted 2`);
    if (!draws.every((e) => e.scroll?.points)) fail('an aurora draw has no texture points');

    const points = frames.auroraPoints;
    if (points.length !== 36 * 2) fail(`${points.length / 2} texture points, wanted 36`);

    /* The model's own stream, read the way the decoder reads it: (v, u) shorts
     * per face-loop vertex at uvPtr*2 of the texture ROM. */
    const tex = rom.textures;
    const uv = readModelEntry(rom, AURORA_BOREALIS).uvPtr * 2;
    const own = Array.from(points, (_, i) => tex[uv + i * 2] | (tex[uv + i * 2 + 1] << 8));
    const differ = [];
    for (let i = 0; i < points.length; i++) if (points[i] !== own[i]) differ.push(i);
    /* Every difference is a v — an even index — and every one is the mirror of
     * the model's within the tile. Two panels' worth, eight pairs. */
    if (differ.length !== 8) fail(`${differ.length} points differ from the model, wanted 8`);
    for (const i of differ) {
        if (i % 2) fail(`texture point ${i} differs in u, not v`);
        if (points[i] !== 2048 - own[i]) fail(`texture point ${i} is not the model's mirrored`);
    }
    /* And they land on two whole panels, four points each. */
    const panels = new Set(differ.map((i) => (i >> 1) >> 2));
    if (panels.size !== 2) fail(`the differences cover ${panels.size} panels, wanted 2`);

    /* The decode takes them: the two panels come out with the block's v. */
    const flipped = decodeModel(rom, AURORA_BOREALIS, points);
    const plain = decodeModel(rom, AURORA_BOREALIS);
    if (flipped.uvs.length !== plain.uvs.length) fail('the override changes the mesh');
    let moved = 0;
    for (let i = 0; i < flipped.uvs.length; i++) if (flipped.uvs[i] !== plain.uvs[i]) moved++;
    if (moved !== 2 * 6) fail(`${moved} decoded UVs move, wanted 12`);

    /* Half a texel a frame, backwards, and the wrap is one whole 256-texel
     * tile — so it comes back to zero rather than to a seam. */
    const { scroll } = draws[0];
    const step = frameScroll(scroll, 1) - frameScroll(scroll, 2);
    if (step !== 0.5) fail(`the aurora slides ${step} texels a frame`);
    if (frameScroll(scroll, 0) !== 0) fail('the aurora does not rest at zero');
    const period = scrollPeriod(scroll);
    if (period !== 512) fail(`the aurora's cycle is ${period} frames`);
    if (frameScroll(scroll, period) !== 0) fail('the aurora does not come back');
    for (let f = 1; f < period; f++) {
        const v = frameScroll(scroll, f);
        if (v <= 0 || v >= 256) fail(`the aurora leaves the tile at frame ${f}: ${v}`);
    }
    console.log(`aurora ${panels.size} panels turned round, v sliding in ${period} frames`);
}

/* ---- the Death Egg: the Earth, and the floor's texture points -------------
 *
 * boss_disp draws two things besides the five wobbling panels, and both are
 * easy to lose because neither is a model standing where it is modelled. The
 * Earth is a flat card blown up a thousand times and hung 42000 units out,
 * which only reads as a globe because the routine ends its transform with the
 * coprocessor's face-the-camera command. And the floor never moves at all: what
 * moves is its texture, through the same move_tpd_req the aurora uses — with
 * the offset in the other of the request's two fields, so what walks is u.
 */
const BOSS_EARTH = 1124;
const BOSS_FLOOR = 1165;
{
    const list = objectsOf(8);

    const earth = list.filter((e) => e.model === BOSS_EARTH);
    if (earth.length !== 1) fail(`the Earth is drawn ${earth.length} times`);
    else {
        const ops = opsAt(earth[0], 0);
        const kinds = ops.map((op) => op[0]).join(',');
        if (kinds !== 't,b,s') fail(`the Earth's transform is ${kinds}, wanted t,b,s`);
        /* The board's (-5750, -3190, 42000), with the decoder's Z. */
        const at = ops[0][1];
        if (at.join() !== [-5750, -3190, -42000].join()) fail(`the Earth stands at ${at}`);
        if (ops[2][1].join() !== [1000, 1000, 1000].join()) fail(`the Earth is ×${ops[2][1]}`);
        /* A card, not a globe: one tile, and no depth to it at all. */
        const d = decodeModel(rom, BOSS_EARTH);
        const thick = d.bounds.max[2] - d.bounds.min[2];
        if (thick > 1e-3) fail(`the Earth is ${thick} deep, wanted a card`);
        /* Which is why the billboard has to survive: 8000 units of card seen
         * edge-on is nothing. */
        if (ops[1][0] !== 'b') fail('the Earth has lost its billboard');
    }

    const floor = list.filter((e) => e.model === BOSS_FLOOR);
    if (floor.length !== 1) fail(`the floor is drawn ${floor.length} times`);
    else if (!floor[0].scroll?.points) fail('the floor has no texture points');
    else {
        const { scroll } = floor[0];
        const points = frames.bossFloorPoints;
        /* 48 faces at four corners each — the plate's own point count, which is
         * what says the block covers the whole model the way the sea's does. */
        if (points.length !== 192 * 2) fail(`${points.length / 2} floor points, wanted 192`);
        if (decodeModel(rom, BOSS_FLOOR).faceCount !== 48) fail('the floor is not 48 faces');
        /* u, not v — the request puts its offset in g2. */
        if (scroll.axis !== 'u') fail(`the floor scrolls ${scroll.axis}, wanted u`);
        /* Four texels every eighth frame, and nothing at all in between. */
        if (frameScroll(scroll, 0) !== 0) fail('the floor does not rest at zero');
        if (frameScroll(scroll, 7) !== 0) fail('the floor moves before its eighth frame');
        if (frameScroll(scroll, 8) !== 4) fail(`the floor steps ${frameScroll(scroll, 8)} texels`);
        const period = scrollPeriod(scroll);
        if (period !== 512) fail(`the floor's cycle is ${period} frames`);
        if (frameScroll(scroll, period) !== 0) fail('the floor does not come back');
        /* The wrap is one whole 256-texel tile, so it is seamless. */
        for (let f = 1; f < period; f++) {
            const u = frameScroll(scroll, f);
            if (u < 0 || u >= 256) fail(`the floor leaves the tile at frame ${f}: ${u}`);
        }
        console.log(`deathegg Earth ×1000 at 42000, floor's u sliding in ${period} frames`);
    }
}

/* ---- every model an object names carries geometry ---- */
{
    const missing = [];
    for (const st of stages) {
        for (const e of objectsOf(st.slot)) {
            for (const m of e.anim ? e.anim.frames : [e.model]) {
                if (m && !decodeModel(rom, m)) missing.push(`${st.slot}:${m}`);
            }
        }
    }
    if (missing.length) fail(`empty models named by an object routine: ${missing.join(' ')}`);
    console.log('every model the object routines name decodes');
}

console.log(bad ? `\n${bad} failed` : '\nall good');
process.exit(bad ? 1 : 0);
