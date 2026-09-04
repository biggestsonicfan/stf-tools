/*
 * test-eggman.mjs — the Final Eggman Boss's hangar, checked against sub_2731C.
 *
 * The slot's record is the Death Egg's, copied: the same sixteen ground chunks,
 * the same backdrop, a post at +0x1C. None of that is what the stage shows.
 * Everything on screen comes out of the routine stage_dsp runs for the slot,
 * which is its parent stage's — Death Egg's Eye falls into the same code once
 * its own transition has finished — under one transform of its own. So what is
 * checked here is that the parts arrive, that they arrive in that transform,
 * and that the record's own draws the routine stands in for do not.
 *
 * There is no capture of this stage yet, so this is the arithmetic and the
 * listing rather than the board: run verify-stage.mjs against one when
 * there is.
 *
 * Run: node test-eggman.mjs [rom.zip]
 */

import fs from 'fs';
import { loadRomSet } from './vendor/noclip/js/romset.js';
import { readStageTable } from './vendor/noclip/js/stages.js';
import { buildStageDisplayList, readFrameTables, opsAt, frameModel } from './vendor/noclip/js/display.js';
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

const EGGMAN = 10;
const stage = stages[EGGMAN];
const list = buildStageDisplayList(stage, frames);
const size = stage.floorSize;
const drawsOf = (model) => list.filter((e) => e.model === model);
/* The quarter turns a model is repeated on, in the order it is drawn. */
const turnsOf = (model) => drawsOf(model).map(
    (e) => (opsAt(e, 0).find((op) => op[0] === 'r') ?? [, 0])[1]);
const near = (a, b) => Math.abs(a - b) < 1e-6;
/* Every part of the hangar shares one frame: the flat scale the rest of the
 * stage is drawn at, then the lift, which the scale is emitted before and so
 * multiplies. A part may add its own quarter turn after that and nothing else. */
function inHangar(entry) {
    const ops = opsAt(entry, 0);
    if (ops.length < 2 || ops.length > 3) return false;
    const [s, t] = ops;
    return s[0] === 's' && near(s[1][0], size) && near(s[1][1], 1.6) && near(s[1][2], size)
        && t[0] === 't' && near(t[1][0], 0) && near(t[1][1], 35) && near(t[1][2], 0)
        && (ops.length === 2 || ops[2][0] === 'r');
}

/* ---- the record's own draws, which the routine stands in for ---- */
{
    /* Flag bit 13 makes ground_disp skip area_clip, so the sixteen chunks at
     * +0x64 — the ones slot 8 draws — are never reached. */
    if (!(stage.flags & (1 << 0xd))) fail('slot 10 no longer skips area_clip');
    const chunks = new Set(stage.layers.ground);
    const drawn = list.filter((e) => chunks.has(e.model));
    if (drawn.length) fail(`${drawn.length} of the record's ground chunks are drawn`);
    /* doom_cnt returns on the slot before it reads the record's backdrop. */
    if (!stage.sky.length) fail('the record has no backdrop to have skipped');
    if (list.some((e) => e.layer === 'sky')) fail('the backdrop ring is drawn');
    /* And Mushroom Hill, the other slot doom_cnt names. */
    const mushroom = buildStageDisplayList(stages[3], frames);
    if (mushroom.some((e) => e.layer === 'sky')) fail("Mushroom Hill's backdrop is drawn");
    /* But not the stages that do show one. */
    const island = buildStageDisplayList(stages[0], frames);
    if (!island.some((e) => e.layer === 'sky')) fail("South Island's backdrop is gone");
    console.log('record  16 ground chunks and a backdrop, none of them drawn');
}

/* ---- the floor, which is the one part drawn outside the hangar's frame ---- */
{
    const floor = drawsOf(2709);
    if (floor.length !== 1) fail(`E-MECH floor drawn ${floor.length} times`);
    else {
        const ops = opsAt(floor[0], 0);
        const ok = ops.length === 1 && ops[0][0] === 's'
            && near(ops[0][1][0], size) && near(ops[0][1][1], 1.0) && near(ops[0][1][2], size);
        if (!ok) fail(`E-MECH floor at ${JSON.stringify(ops)}`);
        if (floor[0].layer !== 'floor') fail(`E-MECH floor on layer ${floor[0].layer}`);
        /* And it is filed there without being camera_init's plate, which is the
         * distinction js/app.js hands floorMaterial on. Slot 10's stage_floor
         * is zero — camera_init lays down nothing here — so this panel must
         * carry no mark, or it concedes the whole z-sort bound and sinks past
         * the wall of the drum 1122 it is lying inside. */
        if (floor[0].groundPlate) fail('E-MECH floor is marked as camera_init\'s ground plate');
        if (stage.layers.floor.length) {
            fail(`slot 10 names ${stage.layers.floor.length} stage_floor models`);
        }
    }
    console.log(`floor   E-MECH floor at ${size.toFixed(3)}/1/${size.toFixed(3)}, no lift, no ground plate`);
}

/* ---- and the mark is on camera_init's plate wherever there is one ---- */
{
    let plates = 0;
    let marked = 0;
    for (let slot = 0; slot < stages.length; slot++) {
        const st = stages[slot];
        if (!st) continue;
        for (const e of buildStageDisplayList(st, frames)) {
            if (e.layer !== 'floor') continue;
            plates++;
            if (e.groundPlate) marked++;
            else if (!(slot === EGGMAN && e.model === 2709)) {
                fail(`slot ${slot} floor draw ${e.model} carries no groundPlate`);
            }
        }
    }
    if (!marked) fail('no stage marks camera_init\'s ground plate at all');
    console.log(`plate   ${marked} of ${plates} floor draws are camera_init's, across 16 stages`);
}

/* ---- the hangar itself ---- */
{
    const parts = [2449, 2426, 2446, 2447, 2448, 2450, 2429, 2425, 2462];
    for (const m of parts) {
        const draws = drawsOf(m);
        if (!draws.length) fail(`model ${m} is not drawn`);
        for (const d of draws) {
            if (!inHangar(d)) fail(`model ${m} at ${JSON.stringify(opsAt(d, 0))}`);
            if (d.layer !== 'ground') fail(`model ${m} on layer ${d.layer}`);
        }
    }
    /* The shell is the one that does not go all the way round: the quarter it
     * leaves out is the wall the doors are in. */
    const shell = turnsOf(2426);
    if (shell.join() !== '0,180,270') fail(`hangar shell at ${shell.join()} degrees`);
    for (const m of [2429, 2425]) {
        const turns = turnsOf(m);
        if (turns.join() !== '0,90,180,270') fail(`model ${m} at ${turns.join()} degrees`);
    }
    /* Three doors stand; the fourth is the shutter Eggman came through, and it
     * is up by the time the stage is loaded. Which one that is is the player's
     * side, and 2445 is player 1's. */
    if (drawsOf(2445).length) fail('the shutter is drawn standing');
    console.log('hangar  ceiling, shell ×3, 3 doors, tubes, surround ×4, bridge ×4');
}

/* ---- the iris in the ceiling ---- */
{
    const iris = list.filter((e) => e.anim && e.anim.frames === frames.hangarIris);
    if (iris.length !== 1) fail(`ceiling iris drawn ${iris.length} times`);
    const table = frames.hangarIris;
    if (table.length !== 128) fail(`iris table is ${table.length} entries`);
    /* A run out and the same run back, walked a frame at a time — so it opens
     * and shuts once every 128 frames, and the fold repeats at both ends. */
    for (let i = 0; i < 64; i++) {
        if (table[i] !== table[127 - i]) fail(`iris table is not a fold at ${i}`);
    }
    const anim = iris[0]?.anim;
    if (anim && frameModel(anim, 0) !== frameModel(anim, 128)) fail('iris does not close its loop');
    if (anim && frameModel(anim, 0) === frameModel(anim, 32)) fail('iris does not move');
    console.log(`iris    ${new Set(table).size} models, out and back over ${table.length} frames`);
}

/* ---- pole_disp, which branches on the slot before it reads the record ---- */
{
    const poles = list.filter((e) => e.layer === 'poles');
    if (poles.length !== 4) fail(`${poles.length} posts`);
    if (poles.some((e) => e.model !== 2428)) fail("a post is not the Death Egg's 2428");
    if (stage.cagePole === 2428) fail('the record carries 2428 after all, so this proves nothing');
    if (poles.some((e) => e.model === stage.cagePole)) fail("the record's post is drawn");
    const turns = turnsOf(2428);
    if (turns.join() !== '0,90,180,270') fail(`posts at ${turns.join()} degrees`);
    console.log(`poles   2428 ×4, not the record's ${stage.cagePole}`);
}

/* ---- and every model named carries geometry ---- */
{
    const named = new Set(list.map((e) => e.model));
    for (const e of list) for (const m of e.anim?.frames ?? []) named.add(m);
    let empty = 0;
    for (const m of named) {
        if (!m) continue;
        const model = decodeModel(rom, m);
        if (!model || !model.positions.length) { fail(`model ${m} decodes empty`); empty++; }
    }
    console.log(`models  ${named.size} named, ${named.size - empty} with geometry`);
}

console.log(bad ? `\n${bad} failed` : '\nall good');
process.exit(bad ? 1 : 0);
