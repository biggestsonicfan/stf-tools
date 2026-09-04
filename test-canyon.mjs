/*
 * test-canyon.mjs — checks Canyon Cruise's flight and the canyon it flies past.
 *
 * The stage carries no ground chunks and no floor: its record's layers are the
 * boat and the sky, and everything else — the canyon, the river, the walls
 * either side — is drawn by canyon_env_disp out of a list of its own, in the
 * world's frame, while canyon_init flies the boat along a keyframed script. So
 * there are four things worth holding onto:
 *
 *  - the tables read as the routines index them. The script's keys, the trigger
 *    counts and the object runs all have to line up with each other: the run
 *    the loop rewinds to is named by an offset in the code (0x15), and the last
 *    trigger is the count canyon_init snaps the timeline back on.
 *  - the curve goes through its keys. object_move interpolates between them,
 *    and at the count a key names the interpolation must be that key exactly.
 *  - the curve is smooth across them. The slope a segment leaves on and the
 *    slope the next one enters on are the same measurement in the ROM, so the
 *    speed across a key must not jump — a kink there means the two scalings
 *    have come apart, which is the one thing the Hermite could be got wrong.
 *  - the world prologue really is the boat's frame inverted, the same check
 *    test-carpet.mjs makes of the other stage that flies.
 *
 * The heading is not checked against the path: the game does not compute it
 * from the path either — it builds one out of the frame's movement and then
 * throws it away for a table. The table is checked for what it is.
 */
import { loadRomSet } from './vendor/noclip/js/romset.js';
import { readStageTable } from './vendor/noclip/js/stages.js';
import { decodeModel } from './vendor/noclip/js/model.js';
import {
    buildStageDisplayList, readFrameTables, opsAt, canyonAt, stageWorldFrame,
    stageMaterials,
} from './vendor/noclip/js/display.js';
import fs from 'fs';

const rd = (p) => { const b = fs.readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const rom = await loadRomSet([rd('sfight.zip')]);
const frames = readFrameTables(rom);
const stage = readStageTable(rom)[4];
const list = buildStageDisplayList(stage, frames);
const canyon = frames.canyon;

/* Row-major 4x4, composed the way app.js composes an op list. */
const I = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const mul = (a, b) => {
    const o = new Array(16).fill(0);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++)
        for (let k = 0; k < 4; k++) o[r * 4 + c] += a[r * 4 + k] * b[k * 4 + c];
    return o;
};
const apply = (m, p) => [0, 1, 2].map((r) => m[r * 4] * p[0] + m[r * 4 + 1] * p[1] + m[r * 4 + 2] * p[2] + m[r * 4 + 3]);
function compose(ops) {
    let m = I();
    for (const [kind, v] of ops) {
        const d = (v * Math.PI) / 180, c = Math.cos(d), s = Math.sin(d);
        if (kind === 's') m = mul(m, [v[0], 0, 0, 0, 0, v[1], 0, 0, 0, 0, v[2], 0, 0, 0, 0, 1]);
        else if (kind === 'r') m = mul(m, [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1]);
        else if (kind === 'rx') m = mul(m, [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1]);
        else if (kind === 'rz') m = mul(m, [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        else m = mul(m, [1, 0, 0, v[0], 0, 1, 0, v[1], 0, 0, 1, v[2], 0, 0, 0, 1]);
    }
    return m;
}

/* The count canyon_init flies at on a given frame — object_cont steps it after
 * the boat has moved, so it is one behind the count canyon_disp draws at. */
const LOOP = [0x7e, 0x784];
const frameOf = (count) => count;          /* count c is flown on frame c */
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

let bad = 0;
const fail = (msg) => { console.log('FAIL', msg); bad++; };

/* ---- the tables ---- */
{
    const keys = canyon.keys;
    console.log(`script ${keys.length} keys, ${keys[0].frame}..${keys[keys.length - 1].frame}, types ${[...new Set(keys.map((k) => k.type))].join('/')}`);
    if (keys.length !== 20) fail(`${keys.length} keys, wanted 20`);
    if (keys.some((k, i) => i && k.frame <= keys[i - 1].frame)) fail('the keys are not in order');
    if (keys[keys.length - 1].type !== 4) fail('the last key does not end the script');
    if (keys.slice(0, -1).some((k) => k.type !== 2)) fail('a key other than the last is not an interpolated one');

    /* Every trigger but the last is a count the object list moves on at; the
     * last is the count the timeline itself snaps back on. */
    const last = canyon.triggers[canyon.triggers.length - 1];
    console.log(`env    ${canyon.groups.length} runs, ${canyon.triggers.length} triggers ending ${last}, ${canyon.scenery.length} pieces in the union`);
    if (last !== LOOP[1]) fail(`the last trigger is ${last}, not the count the run loops on`);
    if (canyon.groups.length !== canyon.triggers.length + 1) fail('the runs and the triggers do not pair up');
    /* canyon_env_disp rewinds to offset 0x15 on the loop, which is the second
     * run: the first is 5 objects of 4 words plus the -1 that ends it. */
    if (canyon.groups[0].length * 4 + 1 !== 0x15) fail('the first run does not end where the loop rewinds to');
    if (canyon.groups.some((g) => !g.length)) fail('an empty run');

    /* Nothing is drawn that has no geometry, and the heading is a real angle. */
    for (const o of canyon.scenery) {
        if (!decodeModel(rom, o.model)) fail(`scenery model ${o.model} has no geometry`);
    }
    const steps = [];
    for (let c = 2; c <= LOOP[1]; c++) {
        const d = ((canyon.heading[c] - canyon.heading[c - 1] + 0x18000) % 0x10000) - 0x8000;
        steps.push(Math.abs(d));
    }
    const worst = Math.max(...steps);
    console.log(`head   ${LOOP[1]} counts, at most ${(worst * 360 / 65536).toFixed(2)} deg of turn in a frame`);
    if (worst > 0x400) fail('the heading table jumps: it is probably not being read as one angle per count');
    /* The loop rejoins at 0x7E, so the table has to say the same thing there as
     * it does at the count the run snaps back from. */
    if (canyon.heading[LOOP[0]] !== canyon.heading[LOOP[1] - (LOOP[1] - LOOP[0])]) {
        fail('the heading table does not repeat over the loop');
    }
}

/* ---- the curve goes through its keys, and is smooth across them ---- */
{
    let worst = 0;
    for (const key of canyon.keys) {
        if (key.frame < 1 || key.frame > LOOP[1]) continue;
        const { pos } = canyonAt(canyon, frameOf(key.frame));
        /* The board keeps the fall in a running height of its own from 0x60F,
         * so the keys inside it are not points on the curve any more. */
        if (key.frame >= 0x60f && key.frame < 0x654) continue;
        worst = Math.max(worst, dist(pos, key.pos));
    }
    console.log(`keys   the curve passes within ${worst.toExponential(1)} of every key it is not falling through`);
    if (worst > 1e-4) fail('the curve does not pass through its keys');

    /* Speed either side of a key. A kink is a step change in it, so compare the
     * step across the key with the steps just before and after. */
    const step = (c) => dist(canyonAt(canyon, frameOf(c)).pos, canyonAt(canyon, frameOf(c - 1)).pos);
    let kink = 0;
    for (const key of canyon.keys) {
        const c = key.frame;
        if (c < 0x82 || c > 0x5d0) continue;             /* clear of both ends */
        const before = step(c - 1), across = step(c), after = step(c + 1);
        kink = Math.max(kink, Math.abs(across - (before + after) / 2) / ((before + after) / 2));
    }
    console.log(`smooth the speed across a key is within ${(kink * 100).toFixed(2)}% of the speed either side of it`);
    if (kink > 0.05) fail('the speed jumps at a key: the two ends of the Hermite disagree');
}

/* ---- the fall, and the loop ---- */
{
    const ys = [];
    for (let c = 0x5f0; c < 0x660; c++) ys.push(canyonAt(canyon, frameOf(c)).pos[1]);
    const drop = Math.min(...ys) - canyonAt(canyon, frameOf(0x5f0)).pos[1];
    const pitch = canyonAt(canyon, frameOf(0x60e)).pitch;
    console.log(`fall   ${drop.toFixed(1)} down over the fall, nose ${(pitch * 360 / 65536).toFixed(1)} deg at the lip`);
    if (drop > -10) fail('the boat does not go over the fall');
    if (pitch >= 0) fail('the boat does not nose down into the fall');
    for (const c of [0x5f9, 0x64a, 0x700]) {
        if (canyonAt(canyon, frameOf(c)).pitch !== 0) fail(`the nose is not level at count ${c}`);
    }

    /* The timeline snaps back mid-canyon rather than running out: the count
     * after the last is the one the loop rejoins on, not the next key. */
    const end = canyonAt(canyon, frameOf(LOOP[1])).pos;
    const wrap = canyonAt(canyon, frameOf(LOOP[1]) + 1).pos;
    const rejoin = canyonAt(canyon, frameOf(LOOP[0])).pos;
    console.log(`loop   ${dist(end, wrap).toFixed(1)} from the end of the run back to where it rejoins`);
    if (dist(wrap, rejoin) > 1e-9) fail('the loop does not rejoin at the count canyon_init snaps back to');
}

/* ---- the world prologue is the boat's frame, inverted ---- */
{
    const chunk = list.find((e) => e.layer === 'ground');
    if (!chunk) fail('no canyon in the draw list');
    const pro = stageWorldFrame(stage, 0, frames).length;
    let worst = 0;
    for (let f = 0; f < LOOP[1]; f += 7) {
        const { pos } = canyonAt(canyon, f);
        /* The board's Z runs the other way, so the boat's own position reaches
         * the viewer's world with its Z negated. */
        const at = apply(compose(opsAt(chunk, f).slice(0, pro)), [pos[0], pos[1], -pos[2]]);
        worst = Math.max(worst, Math.hypot(...at));
    }
    console.log(`world  boat lands ${worst.toExponential(1)} from the origin at worst`);
    if (worst > 1e-9) fail('the world prologue does not put the boat at the origin');

    /* doom_cnt skips the translate on this stage and only this stage, so the
     * backdrop must carry the boat's angles and none of its position. */
    const sky = list.find((e) => e.layer === 'sky');
    const skyOps = opsAt(sky, 900);
    console.log(`sky    the backdrop carries ${skyOps.map(([k]) => k).join(' ')}`);
    if (skyOps.some(([kind]) => kind === 't')) fail('the backdrop carries a translate doom_cnt skips');
    if (skyOps[0][0] !== 'rx' || skyOps[1][0] !== 'r') fail('the backdrop does not turn with the boat');

    const layers = {};
    for (const e of list) layers[e.layer] = (layers[e.layer] ?? 0) + 1;
    console.log(`list   ${Object.entries(layers).map(([k, n]) => `${k} ${n}`).join(', ')}`);
    if ((layers.ground ?? 0) !== canyon.scenery.length) fail('the canyon is not all on the ground layer');
    if ((layers.water ?? 0) !== 5) fail('the river is not five plates on the water layer');
    if (list.filter((e) => e.layer === 'water').some((e) => !e.band)) {
        fail('a river plate is drawn without the band its texture header walks');
    }
}

/* ---- the tunnel light ---- */
{
    /* Six material slots, dimmed to 116/256 and back. What the check is worth
     * is the arithmetic being exact at both ends: the walk is kept in RAM on
     * the board and read back as a scale, so it has to land on 0x100 again or
     * the boat would come out of the tunnel a little darker every lap. */
    const at = (c) => stageMaterials(stage, c, frames);
    const full = at(1);
    const record = full.map((m) => stage.materials[m.slot]);
    if (full.some((m, i) => m.diffuse !== record[i].diffuse || m.ambient !== record[i].ambient)) {
        fail('the stage does not start on its own materials');
    }
    const deepest = at(0x513);
    const ratio = deepest[0].diffuse / record[0].diffuse;
    console.log(`light  slots ${full.map((m) => m.slot).join(',')} dim to ${(ratio * 100).toFixed(0)}% `
        + `over counts 0x4CE..0x513 and come back over 0x596..0x5DB`);
    if (Math.abs(ratio - 116 / 256) > 0.02) fail(`the tunnel dims to ${ratio.toFixed(3)}, not 116/256`);
    for (const c of [1, 0x4cd, 0x5db, 0x5dc, 0x600, LOOP[1]]) {
        const m = at(c);
        const back = c >= 0x5db;
        if (m.some((s, i) => (s.diffuse === record[i].diffuse) !== (back || c < 0x4ce))) {
            fail(`the material slots are not the record's at count ${c}`);
        }
    }
    /* What it dims is the boat: every slot it touches that any of these models
     * names at all is one of the arena's own, and the canyon keeps four slots
     * of its own that the run never reaches. Slot 18 is the exception in both
     * directions — most of the deck is drawn with it and so are a few dozen
     * canyon faces — so the count, not the fact, is what is pinned. */
    const facesOn = (models) => {
        const n = new Map();
        for (const m of models) {
            const d = decodeModel(rom, m);
            for (let i = 0; i < d.mats.length; i += 3) {
                const s = d.mats[i] | 0;
                n.set(s, (n.get(s) ?? 0) + 1);
            }
        }
        return n;
    };
    const dimmed = new Set(full.map((m) => m.slot));
    const onCanyon = facesOn(canyon.scenery.map((o) => o.model));
    const onBoat = facesOn([2263, 2262]);
    const canyonDimmed = [...onCanyon].filter(([s]) => dimmed.has(s));
    const boatLit = [...onBoat].filter(([s]) => !dimmed.has(s));
    const canyonFaces = [...onCanyon].reduce((a, [, n]) => a + n, 0);
    const dimFaces = canyonDimmed.reduce((a, [, n]) => a + n, 0);
    console.log(`       ${dimFaces} of the canyon's ${canyonFaces} faces go with it (slots `
        + `${canyonDimmed.map(([s]) => s).join(',') || 'none'}), and ${boatLit.reduce((a, [, n]) => a + n, 0)} of the boat's stay lit`);
    if (dimFaces / canyonFaces > 0.05) fail('the tunnel is dimming the canyon, not the boat');
    if (!dimmed.size || [...onBoat].every(([s]) => !dimmed.has(s))) fail('the tunnel dims nothing the boat is made of');
}

/* ---- and the board's own flight, from recordings of one ---- */
{
    /* mame-canyon-path.py writes these: what the game itself put in the
     * prologue on every frame of a real ride. Two of them, because MAME
     * interprets the coprocessor at a few frames a second and the ride is
     * nineteen hundred — one covers the run up to the fall and the other the
     * fall and what follows. A path given on the command line replaces both. */
    const here = (f) => decodeURIComponent(new URL(f, import.meta.url).pathname).replace(/^\/(\w:)/, '$1');
    const given = process.argv.slice(2);
    const paths = (given.length ? given : ['canyon-path.csv', 'canyon-fall.csv'].map(here))
        .filter((p) => fs.existsSync(p));
    if (!paths.length) {
        console.log('board  no recording to hand — mame-canyon-path.py makes one');
    } else {
        const bits = new DataView(new ArrayBuffer(4));
        const f32 = (u) => { bits.setUint32(0, u >>> 0, false); return bits.getFloat32(0, false); };
        const i16 = (v) => (v > 32767 ? v - 65536 : v);
        const wrap = (v) => ((v % 65536) + 98304) % 65536 - 32768;
        let n = 0, worst = 0, worstAt = 0, worstYaw = 0, worstPitch = 0, lit = 0, badLight = 0;
        const seen = new Set();
        for (const path of paths) {
            const csv = fs.readFileSync(path, 'utf8').trim().split(/\r?\n/);
            const head = csv[0].split(',');
            const rows = csv.slice(1)
                .map((l) => Object.fromEntries(l.split(',').map((v, i) => [head[i], Number(v)])))
                /* The counter is read after object_cont has stepped it, so the
                 * count in a row is one past the count the continuation flew. */
                .map((r) => ({ ...r, c: r.count - 1 }))
                .filter((r) => r.c >= 1 && r.c <= LOOP[1]);
            for (const r of rows) {
                const at = canyonAt(canyon, r.c);
                const d = dist(at.pos, [f32(r.xbits), f32(r.ybits), f32(r.zbits)]);
                if (d > worst) { worst = d; worstAt = r.c; }
                worstYaw = Math.max(worstYaw, Math.abs(wrap(at.yaw - i16(r.angy))));
                worstPitch = Math.max(worstPitch, Math.abs(wrap(at.pitch - i16(r.angx))));
            /* A recording made before the scale was sampled has no column for
             * it; one made since carries what the board had in 0x530200, and
             * the slots the port hands back have to be that scale applied to
             * the record. */
            if (Number.isFinite(r.scale)) {
                lit++;
                const want = stageMaterials(stage, r.c, frames);
                for (const s of want) {
                    const m = stage.materials[s.slot];
                    if (s.diffuse !== ((m.diffuse * r.scale) >> 8)
                        || s.ambient !== ((m.ambient * r.scale) >> 8)) {
                        if (!badLight++) fail(`slot ${s.slot} is not the board's scale at count ${r.c}`);
                    }
                }
            }
                seen.add(r.c);
                n++;
            }
        }
        const counts = [...seen].sort((a, b) => a - b);
        if (lit) console.log(`board  ${lit} of those frames also recorded the tunnel scale, and the slots follow it`);
        console.log(`board  ${n} recorded frames over counts ${counts[0]}..${counts[counts.length - 1]}, `
            + `${counts.length} of them distinct: worst |Δpos| ${worst.toExponential(1)}`
            + `${worst ? ` at ${worstAt}` : ''}, |Δyaw| ${worstYaw}, |Δang_x| ${worstPitch}`);
        /* The board keeps these in float32 and the port in float64, so they
         * agree to the precision the capture is written at, not exactly. */
        if (worst > 1e-3) fail(`the flight is ${worst.toFixed(3)} off the board at count ${worstAt}`);
        if (worstYaw) fail('the heading does not match the board');
        if (worstPitch) fail('the nose angle does not match the board');
    }
}

console.log(bad ? `\n${bad} failed` : '\nall good');
process.exit(bad ? 1 : 0);
