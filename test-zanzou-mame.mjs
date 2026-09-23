/*
 * test-zanzou-mame.mjs — hold the explorer's motion script and afterimage ring
 * against the board.
 *
 * `mame-zanzou.py` runs a real fight under MAME, writes a list of trail cases
 * into P1's trail fields so `zanzou_control` has something to send, and
 * records three things (see mame-zanzou-capture.lua). This grades the explorer
 * on each:
 *
 *   script   Every frame, both fighters' work RAM against what
 *            `scriptStateAt` / `trailCommandAt` answer for the same motion at
 *            the same frame: the trail mask, step and turn at +0xC60/+0xC62/
 *            +0xA1E, the propeller at +0x7F0 bit 16 and +0x7F4, and Metal
 *            Sonic's chest at slot 1 of +0x40 while the script has named it.
 *            P1's trail fields are skipped on a frame the capture wrote them.
 *
 *   reserve  Every Fn_zanzou_reserve the i960 sent: the mask (swapped left for
 *            right on a fighter facing the other way), step, turn and spacing
 *            against the case written or the motion's own command, and the bone
 *            length and three models per part against `trailTables`.
 *
 *   ring     The SHARC's own ring. Each reserve carries the DM as the firmware
 *            held it with the header done and nothing laid; the explorer's
 *            `reserve` is started from one, told what the i960 told the
 *            firmware, aged by `age` once a frame, and held against the next
 *            slot by slot — part, life, step, the three models, and the twelve
 *            words of the matrix — with the write index and the timers.
 *
 * The ring grade is the one m2-hle2 could not do: its port was only ever held
 * against its own FIFO tests, since attract never plays a trail.
 *
 * Run: node test-zanzou-mame.mjs [capture-prefix] [rom.zip]
 *      STF_EXPLORER=../noclip to grade another explorer checkout
 */

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const EXPLORER = path.resolve(process.env.STF_EXPLORER ?? 'vendor/noclip');
const load = (m) => import(pathToFileURL(path.join(EXPLORER, 'js', m)).href);
const { loadRomSet } = await load('romset.js');
const { useCoproTrig } = await load('pose.js');
const { readMotionScript, scriptStateAt } = await load('motion.js');
let Z;
try {
    Z = await load('zanzou.js');
} catch {
    console.log(`SKIP: ${EXPLORER} has no js/zanzou.js — point STF_EXPLORER at an explorer with the trail port`);
    process.exit(0);
}
const { readExhaust } = await load('exhaust.js');

const args = process.argv.slice(2);
const PREFIX = args[0] ?? 'zanzou';
const ROM = args[1] ?? 'sfight.zip';
const CAPTURE = `${PREFIX}.zanzou.json`;
if (!fs.existsSync(CAPTURE)) {
    console.log(`SKIP: no capture at ${CAPTURE} — make one with mame-zanzou.py`);
    process.exit(0);
}

const read = (p) => { const b = fs.readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const rom = await loadRomSet([read(ROM)]);
useCoproTrig(rom);
const cap = JSON.parse(fs.readFileSync(CAPTURE, 'utf8'));

const f32buf = new DataView(new ArrayBuffer(4));
const f32 = (w) => { f32buf.setUint32(0, w >>> 0, true); return f32buf.getFloat32(0, true); };
const s16 = (w) => (w << 16) >> 16;
const hexw = (s) => s.split(' ').map((h) => parseInt(h, 16) >>> 0);

let failures = 0;
const fail = (msg) => { failures++; if (failures <= 40) console.log('  FAIL ' + msg); };

/* ---- 1. the script, frame by frame --------------------------------------- */

const P = ['P1', 'P2'];
const FIELD = Object.fromEntries(cap.player_fields.map((k, i) => [k, i]));
const scripts = new Map();
const scriptOf = (id) => {
    if (!scripts.has(id)) scripts.set(id, readMotionScript(rom, id));
    return scripts.get(id);
};
const trailsOf = new Map();
const trailsFor = (id, ch) => {
    const k = `${id}:${ch}`;
    if (!trailsOf.has(k)) trailsOf.set(k, Z.readTrails(rom, id, ch));
    return trailsOf.get(k);
};

const CASES = cap.cases ?? [];

const tally = { frames: 0, trail: [0, 0], prop: [0, 0], chest: [0, 0], skew: 0, written: 0 };
for (const [, , , p1, p2, caseNo] of cap.frames) {
    [p1, p2].forEach((p, pi) => {
        const motion = p[FIELD.motion], coma = p[FIELD.coma], ch = p[FIELD.char];
        if (!motion || !coma) return;
        tally.frames++;
        const where = `${P[pi]} motion ${motion} f${coma}`;

        const t = trailsFor(motion, ch);
        const cmd = t ? Z.trailCommandAt(t, coma) : null;
        const want = cmd ? [cmd.mask, cmd.step, cmd.turn] : [0, null, null];
        const got = [p[FIELD.trail_mask], s16(p[FIELD.trail_step]), p[FIELD.trail_turn]];
        /* A motion that never set the trail leaves step and turn as the last
         * one did; only the mask is cleared when a motion starts. */
        const same = want[0] === got[0] && (!cmd || (want[1] === got[1] && want[2] === got[2]));
        const written = pi === 0 && caseNo > 0;
        if (written) tally.written++;
        else tally.trail[same ? 0 : 1]++;
        if (!same && !written) {
            const ahead = t ? Z.trailCommandAt(t, coma + 1) : null;
            if (ahead && ahead.mask === got[0]) tally.skew++;
            fail(`${where}: trail board ${got.join('/')} explorer ${want.join('/')}`);
        }

        const st = scriptStateAt(rom, scriptOf(motion), coma);
        const on = (p[FIELD.parts_flag] >>> 16) & 1;
        const byte = (p[FIELD.propeller] << 24) >> 24;
        const propOk = on ? st.propeller === byte : st.propeller === 0;
        tally.prop[propOk ? 0 : 1]++;
        if (!propOk) fail(`${where}: propeller board ${on ? byte : 'off'} explorer ${st.propeller || 'off'}`);

        const jet = readExhaust(rom, ch);
        const entry = st.parts[1];
        if (jet?.bodies.length && entry != null) {
            const chest = p[FIELD.models][1] & 0xffff;
            const ok = chest === jet.bodies[entry];
            tally.chest[ok ? 0 : 1]++;
            if (!ok) fail(`${where}: chest board ${chest} explorer ${jet.bodies[entry]}`);
        }
    });
}
console.log(`script: ${tally.frames} fighter-frames`
    + ` · trail ${tally.trail[0]} agree, ${tally.trail[1]} differ`
    + (tally.written ? ` (${tally.written} written by the capture, not graded)` : '')
    + (tally.skew ? ` (${tally.skew} of them one frame early)` : '')
    + ` · propeller ${tally.prop[0]}/${tally.prop[1]}`
    + ` · chest ${tally.chest[0]}/${tally.chest[1]}`);

/* ---- 2. what zanzou_control sent ------------------------------------------ */

/* zanzou_control's mirror: 0xE1C0 down three, 0x1C38 up three, 0x207 stays. */
const mirror = (m) => ((m & 0xe1c0) >>> 3) | ((m & 0x1c38) << 3) | (m & 0x207);

const rtally = { n: 0, ok: 0, bad: 0, oracle: 0 };
for (const r of cap.reserves) {
    if (r.bad) { fail(`reserve at frame ${r.frame}: stream broke (${r.bad})`); continue; }
    rtally.n++;
    const [player, mask, step, boneW] = r.header;
    /* The sender's motion, frame and flags as the reserve went out. */
    const [motion, coma, ch, flags, caseNo, maW, skel] = r.state;
    const where = `reserve ${P[player]} motion ${motion} f${coma}` + (caseNo ? ` case ${caseNo}` : '');
    let cmd;
    if (caseNo) {
        const [cm, cs, ct, csp] = CASES[caseNo - 1];
        cmd = { mask: cm, step: cs, turn: ct, spacing: csp };
    } else {
        const tr = trailsFor(motion, ch);
        cmd = tr ? Z.trailCommandAt(tr, coma) : null;
    }
    if (!cmd) { fail(`${where}: the explorer has no trail on`); rtally.bad++; continue; }
    const t = Z.trailTables(rom, ch, skel);
    const flipped = (flags >>> 6) & 1;
    const errs = [];
    /* A written case goes through zanzou_control's mirror like the script's. */
    const wantMask = flipped ? mirror(cmd.mask) : cmd.mask;
    if ((mask & 0xffff) !== wantMask) errs.push(`mask ${mask.toString(16)} vs ${wantMask.toString(16)}`);
    if (s16(step) !== cmd.step) errs.push(`step ${s16(step)} vs ${cmd.step}`);
    if (Math.abs(f32(boneW) - t.bone) > 1e-6) errs.push(`bone ${f32(boneW)} vs ${t.bone}`);
    if ((r.angle & 0xffff) !== cmd.turn) errs.push(`turn ${r.angle & 0xffff} vs ${cmd.turn}`);
    /* The models are the fighter's own for the part the board names — which on
     * a mirrored fighter is the other side's, and the tables are symmetric. */
    for (const [idx, a0, a1, a2] of r.parts) {
        const m = t.models[idx];
        if (m[0] !== a0 || m[1] !== a1 || m[2] !== a2) errs.push(`part ${idx} models ${[a0, a1, a2]} vs ${m}`);
    }
    const ma = f32(maW);
    if (Math.abs(ma - cmd.spacing) > 1e-6) errs.push(`zanzou_ma ${ma} vs ${cmd.spacing}`);
    if (errs.length) { rtally.bad++; fail(`${where}: ${errs.join('; ')}`); } else rtally.ok++;
}
console.log(`reserve: ${rtally.n} sent · ${rtally.ok} match the explorer's · ${rtally.bad} differ`);

/* ---- 3. the ring, command by command -------------------------------------- */

const RING = 0x32300, LOW = 0x32000;
const low = (sn, a) => sn.low[a - LOW];

function decode(sn) {
    return { units: hexw(sn.units), low: hexw(sn.low), ring: hexw(sn.ring) };
}
const unitsOf = (words, base) => Array.from({ length: 16 }, (_, b) =>
    Float64Array.from({ length: 12 }, (_, k) => f32(words[base + b * 12 + k])));

/* The explorer's sim, stood up on the firmware's DM as the header left it. */
function simFrom(sn, player, parts, bone) {
    const models = Array.from({ length: 16 }, () => [0, 0, 0]);
    for (const [idx, a0, a1, a2] of parts) models[idx] = [a0, a1, a2];
    const sim = Z.createTrailSim({ records: [], bone, models, skeletonType: 0 });
    sim.write = low(sn, 0x32180) & 0x7f;
    sim.spacing = f32(low(sn, 0x32181));
    sim.life0 = low(sn, 0x32182) | 0;
    const tb = player ? 0x321f0 : 0x32190;
    for (let b = 0; b < 16; b++) sim.timers[b] = low(sn, tb + b) | 0;
    sim.lastMask = low(sn, player ? 0x32240 : 0x321e0);
    const ab = player ? 0x32200 : 0x321a0;
    for (let b = 0; b < 16; b++) sim.attr[b] = [low(sn, ab + b), low(sn, ab + b + 16), low(sn, ab + b + 32)];
    sim.prev = unitsOf(sn.low, player ? 0xc0 : 0);
    sim.ring.forEach((s, n) => {
        const w = sn.ring.slice(n * 0x20, n * 0x20 + 0x20);
        s.part = w[0];
        s.turnOwed = (w[1] >>> 31) === 1;
        s.life = w[2] | 0;
        s.step = w[3] | 0;
        s.objs = [w[4], w[5], w[6]];
        for (let k = 0; k < 12; k++) s.m[k] = f32(w[0x14 + k]);
    });
    return sim;
}

function compareRing(sim, sn, where) {
    let slots = 0, lifeOff = 0, matWorst = 0, wrong = 0;
    sim.ring.forEach((s, n) => {
        const w = sn.ring.slice(n * 0x20, n * 0x20 + 0x20);
        const life = w[2] | 0;
        if (life === 0 && s.life === 0) return;
        slots++;
        const same = s.life === life && s.part === w[0] && s.step === (w[3] | 0)
            && s.objs[0] === w[4] && s.objs[1] === w[5] && s.objs[2] === w[6];
        if (!same) {
            wrong++;
            if (wrong <= 3) fail(`${where} slot ${n}: board part ${w[0]} life ${life} step ${w[3] | 0} objs ${w.slice(4, 7)}`
                + ` · explorer part ${s.part} life ${s.life} step ${s.step} objs ${s.objs}`);
            if (s.life !== life) lifeOff++;
            return;
        }
        for (let k = 0; k < 12; k++) matWorst = Math.max(matWorst, Math.abs(s.m[k] - f32(w[0x14 + k])));
    });
    return { slots, wrong, lifeOff, matWorst };
}

/*
 * Each snapshot is the firmware's DM with a reserve's header done and nothing
 * laid, so they chain: start the explorer from one, run the reserve it was
 * sent, age the ring once per frame until the next reserve, and the result has
 * to be the next snapshot — the write index, and every slot with life in it.
 * A fighter whose mask was zero in between had his timers killed by 0x86, which
 * touches only his, and the next reserve's header has already zeroed the timers
 * of any part its mask changed; so the timers are held against the next
 * snapshot only when it is the same fighter's, a frame on, with the same mask.
 */
const otally = { n: 0, exact: 0, slotsWrong: 0, matWorst: 0, writeOff: 0, timerOff: 0 };
const chain = cap.reserves.filter((r) => !r.bad && r.pre);
for (let i = 0; i + 1 < chain.length; i++) {
    const r = chain[i], next = chain[i + 1];
    const pre = decode(r.pre), after = decode(next.pre);
    const [player, mask, step, boneW] = r.header;
    const where = `ring @${r.frame} ${P[player]} -> @${next.frame}`;

    const sim = simFrom(pre, player, r.parts, f32(boneW));
    Z.reserve(sim, { mask: mask & 0xffff, step: s16(step), turn: r.angle & 0xffff },
        unitsOf(pre.units, player ? 0xc0 : 0));
    for (let k = 0; k < next.fc - r.fc; k++) Z.age(sim);

    const c = compareRing(sim, after, where);
    otally.n++;
    otally.slotsWrong += c.wrong;
    otally.matWorst = Math.max(otally.matWorst, c.matWorst);
    const wantWrite = low(after, 0x32180) & 0x7f;
    const writeOk = sim.write === wantWrite;
    if (!writeOk) {
        otally.writeOff++;
        fail(`${where}: write index board ${wantWrite} explorer ${sim.write}`
            + ` (${(wantWrite - sim.write + 128) % 128} more copies on the board)`);
    }
    let timersOk = true;
    if (next.header[0] === player && next.fc === r.fc + 1 && next.header[1] === mask) {
        const tb = player ? 0x321f0 : 0x32190;
        for (let b = 0; b < 16; b++) {
            if ((low(after, tb + b) | 0) !== sim.timers[b]) timersOk = false;
        }
        if (!timersOk) {
            otally.timerOff++;
            fail(`${where}: timers board ${Array.from({ length: 16 }, (_, b) => low(after, tb + b) | 0)}`
                + ` explorer ${Array.from(sim.timers)}`);
        }
    }
    if (!c.wrong && writeOk && timersOk) otally.exact++;
}
const life0 = new Set(chain.map((r) => decode(r.pre).low[0x182] | 0));
console.log(`ring: the firmware's first-copy life (DM 0x32182) read ${[...life0].join(', ')};`
    + ` the explorer starts from ${Z.createTrailSim({ records: [], bone: 0, models: [] }).life0}`);
if (life0.size && ![...life0].every((v) => v === Z.createTrailSim({ records: [], bone: 0, models: [] }).life0)) {
    fail(`the explorer's first-copy life is not the firmware's`);
}
console.log(`ring: ${otally.n} reserves chained · ${otally.exact} reproduce the firmware's next state exactly`
    + ` · ${otally.writeOff} laid a different number · ${otally.slotsWrong} slots differ`
    + ` · ${otally.timerOff} timer sets differ · worst matrix word ${otally.matWorst.toExponential(2)}`);

if (!tally.frames) console.log('SKIP: the capture has no fighter frames');
console.log(failures ? `${failures} failures` : 'all agree');
process.exit(failures ? 1 : 0);
