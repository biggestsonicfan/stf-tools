/*
 * verify-stage.mjs — check the viewer puts every stage part where the board does.
 *
 * The board draws a part at C·M: C is the view matrix camera_init pushed for the
 * frame, M is the part's own transform. The viewer builds M from the ROM tables
 * and supplies a C of its own, because the whole point of it is a free camera.
 * So the two agree exactly when
 *
 *     M_board(part) = C · M_viewer(part)
 *
 * holds for one single C across every part in the frame. That is stronger than
 * checking a part on its own: a shared C cannot absorb a mistake in one part,
 * because it has to fit all the others at the same time.
 *
 * C is not fitted to the viewer. Every stage draw brackets its own transforms in
 * a push/pop, so the matrix at the bottom of the stack is the same for all of
 * them, and that is C — read straight out of the display list. What is left,
 * D = M_viewer⁻¹·C⁻¹·M_board, is the transform the viewer is missing for that
 * part: identity when it agrees, and otherwise the error itself, in a form that
 * says what is wrong rather than just how much.
 *
 * One difference is expected and is predicted rather than waved through. The
 * backdrop's slow drift is an angle the game accumulates at 0x500464 and zeroes
 * when it loads a scene; display.js accumulates the same two units per frame off
 * frame_counter, which in the viewer starts at zero when a stage is opened. Both
 * are right, and they differ by whatever the two clocks are apart — a quantity
 * the capture records, so the check subtracts exactly (2·frame_counter − the
 * angle at 0x500464) from the backdrop and holds it to the same tolerance as
 * everything else. Nothing is being excused: a backdrop off by any other amount
 * still fails.
 *
 * The Flying Carpet needs more than that. Its arena is drawn in a frame the
 * board pushes first — three ops built from the carpet's position and heading —
 * and those go over as a 16-bit angle and a 32-bit float computed with the
 * board's own trigonometry. Rebuilding that frame in double precision and
 * comparing the product leaves a tenth of an angle unit of noise on every part
 * standing in it, which says nothing about whether the part is in the right
 * place. So the prologue is divided out of both sides instead: the parts that
 * carry it share one matrix exactly as the whole arena shares the view matrix,
 * that shared matrix is recovered from the draws the same way, and what is left
 * is each part's own transform, compared exactly. The frame itself is then
 * checked on its own terms, as the three numbers the board emitted against the
 * three carpetAt() computes, to the precision the board can represent.
 *
 * The Flying Carpet needs the same treatment for a second clock. Its arena is
 * pinned to an object that keeps its own 16-bit heading, stepped 32 a frame and
 * readable at 0x50A022, and that object is created when the round starts rather
 * than when the counter did — so the flight is at heading/32 while the frame
 * tables are still at frame_counter, and the two are a constant apart. The
 * viewer has one clock and starts both at zero, which is right on its own terms.
 * The capture records the heading, so the matrices are built at heading/32 and
 * the model choices at frame_counter, and the offset is measured rather than
 * fitted: it has to come out constant across the capture or the run is bad.
 *
 * One part is deliberately drawn where the board does not draw it.
 * draw_sphynx_head builds a probe matrix carrying a 1.6 (0x72214), transforms
 * (-7.85, 7, 52) through it to get the head's world position (0x72244), reads
 * that back (0x7225C) — and then draws at the raw constants (0x7237C), with no
 * scale. display.js follows the probe, because that is the position the routine
 * worked out for itself. So the board's own draw sits 1/1.6 as far out, and the
 * comparison undoes that here rather than letting the one part the ROM gets
 * wrong read as a fault in the port. Everything else about the head — the frame
 * in front of it and both aim angles — is still checked exactly.
 *
 * The head is also checked for what it can be against a live capture.
 * draw_sphynx_head aims it at the midpoint of the two fighters;
 * display.js has no fighters, so it aims at the middle of the carpet, where a
 * midpoint sits when they are not moving. In a captured fight they are moving.
 * What must still hold is that only the aim differs: the head has to stand in
 * exactly the place the routine puts it, so the transform left over is required
 * to be a rotation about Y and nothing else. A scale or an offset there would be
 * a real fault and still fails.
 *
 * A part the board did not draw this frame is not a disagreement. ground_disp
 * runs area_clip and doom_cnt tests each backdrop segment, so the board draws
 * the subset of the arena its own camera can see; the viewer draws all of it
 * because its camera can be anywhere. Nor are the draws for models the stage
 * record does not name: those are the two fighters and their shadows, which
 * come from the character rigs, not from the stage.
 *
 * Run:  node verify-stage.mjs <capture-prefix> [stage] [rom.zip]
 */

import {
    loadCapture, loadRom, modelIndex, meshIndex, replayFrame, boardMatrix,
    readStageTable, readFrameTables, buildStageDisplayList, opsAt, frameModel,
    stageWorldFrame,
    mul, inv, maxdiff, rotY, I4,
} from './dl-verify.mjs';

const PREFIX = process.argv[2];
const SLOT = Number(process.argv[3] ?? 0);
const ROM = process.argv[4] ?? 'sfight.zip';
/* The board's floats are 32-bit and its angles a 16-bit table, so exact
 * equality is the wrong test. Every genuine match below lands three orders of
 * magnitude inside this; nothing sits near it. */
const EPS = 1e-5;
/* draw_sphynx_head's model — the one draw in the game that aims at something. */
const SPHYNX_HEAD = 322;
/* The scale its probe applies and its draw omits; see the header. */
const SPHYNX_SCALE = 1.6;

if (!PREFIX) {
    console.error('usage: node verify-stage.mjs <capture-prefix> [stage] [rom.zip]');
    process.exit(2);
}

const cap = loadCapture(PREFIX);
const rom = await loadRom(ROM);
const byEntry = modelIndex(rom);
const byMesh = meshIndex(rom);
const stage = readStageTable(rom)[SLOT];
const frameTables = readFrameTables(rom);

/*
 * Board angles are 16-bit — 0x10000 to the turn — so an angle the viewer holds
 * as a float reaches the coprocessor rounded to 1/65536 of a turn, and a stage
 * whose transform carries one can only ever agree to that. Rounding the
 * viewer's angles the same way before building the matrix compares like with
 * like; without it the Flying Carpet's arena sits about 1e-4 out, which is half
 * an angle unit and not a mistake anyone made.
 */
const ANGLE_UNIT = 360 / 65536;
const quantise = (ops) => ops.map(([kind, v]) => (kind[0] === 'r'
    ? [kind, Math.round(v / ANGLE_UNIT) * ANGLE_UNIT]
    : [kind, v]));

/* Which draws push the arena's frame before drawing: camera_init's floor,
 * ground_disp's chunks, doom_cnt's backdrop, and the one object drawn in the
 * world rather than on the arena — the sphynx head. Read off the front of the
 * op list rather than off the layer, because the prologue is not the same
 * length on every stage that has one: the Flying Carpet's is three ops and
 * Giant Wing's is a single roll. On a stage that does not move there is no
 * prologue and none of this signifies. */
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const carriesWorld = (ops, pro) => pro.length > 0 && same(ops.slice(0, pro.length), pro);

/**
 * The viewer's draw list at one value of the game's frame counter.
 * With `strip`, the arena frame is taken off the front of the parts that carry
 * it, leaving each part's own transform — see the header.
 */
function viewerList(frame, strip = false) {
    const pro = stageWorldFrame(stage, frame, frameTables) ?? [];
    return buildStageDisplayList(stage, frameTables).map((e, i) => {
        let ops = opsAt(e, frame);
        const world = carriesWorld(ops, pro);
        /* Put the head back where the board actually draws it, so the check is
         * against the hardware and not against our correction of it. */
        if (e.model === SPHYNX_HEAD) {
            ops = ops.map((op, k) => (k === pro.length && op[0] === 't'
                ? ['t', op[1].map((c) => c / SPHYNX_SCALE)]
                : op));
        }
        if (strip && world) ops = ops.slice(pro.length);
        return {
            i,
            layer: e.layer,
            world,
            model: e.anim ? frameModel(e.anim, frame) : e.model,
            m: boardMatrix(quantise(ops)),
        };
    });
}

const key = (m) => m.map((v) => (Math.abs(v) < 1e-9 ? 0 : v).toFixed(6)).join(',');

/** The matrix most draws share at the bottom of the stack: the view matrix. */
function viewMatrix(draws) {
    const tally = new Map();
    for (const d of draws) {
        const k = key(d.base);
        const e = tally.get(k) ?? { m: d.base, n: 0 };
        e.n++;
        tally.set(k, e);
    }
    let best = null;
    for (const e of tally.values()) if (!best || e.n > best.n) best = e;
    return best;
}

/** Describe a residual transform in the terms the display list is written in. */
function describe(d) {
    const col = (i) => Math.hypot(d[i], d[4 + i], d[8 + i]);
    const s = [col(0), col(1), col(2)];
    const t = [d[3], d[7], d[11]];
    /* The rotation left after the scale is divided out; every discrepancy on
     * these stages is about Y, so report that angle and the residue. */
    const r = [d[0] / s[0], d[2] / s[2], d[8] / s[0], d[10] / s[2]];
    const yaw = Math.atan2(-r[1], r[0]) * 180 / Math.PI;
    const parts = [];
    if (s.some((v) => Math.abs(v - 1) > 1e-4)) parts.push(`scale ${s.map((v) => v.toFixed(4)).join('/')}`);
    if (Math.abs(yaw) > 1e-3) parts.push(`yaw ${yaw.toFixed(3)}°`);
    if (t.some((v) => Math.abs(v) > 1e-4)) parts.push(`offset ${t.map((v) => v.toFixed(4)).join(',')}`);
    return parts.length ? parts.join(', ') : 'identity';
}

let allOk = true;
const summary = [];

for (const fr of cap.frames) {
    const { draws, stackLeft, commands } = replayFrame(fr.records, byEntry, byMesh);
    /* Matrices at the arena's clock, model choices at the frame counter — see
     * the header. Off the Flying Carpet the two are the same thing. */
    /* Three clocks, and which one a part is on follows the draw function that
     * placed it. The arena's frame moves with the carpet's object, whose heading
     * the capture records; the frame tables and the flames' one-frame flicker
     * run off frame_counter; the backdrop drifts on its own accumulator. The
     * viewer has one clock and starts all of them at zero, which is right on its
     * own terms — nothing in the game fixes a phase between them.
     *
     * Every op list here is built at frame_counter. The arena frame does not
     * appear in them at all: it is stripped, and recovered from the board. */
    const moving = Boolean(fr.carpet.yaw);
    const arenaFrame = moving ? fr.carpet.yaw / 32 : fr.frameCounter;
    const opsFrame = fr.frameCounter;
    const view = viewerList(fr.frameCounter, moving);
    /* draw_sphynx_head works its two angles out of the carpet's own position, so
     * unlike the rest of the arena its transform still needs the arena clock
     * once the frame in front of it has been stripped. */
    if (moving) {
        const atArena = viewerList(arenaFrame, moving);
        for (const v of view) if (v.model === SPHYNX_HEAD) v.m = atArena[v.i].m;
    }

    const found = viewMatrix(draws);
    const C = found.m;
    const Ci = inv(C);
    /* Draws sharing the view matrix are the ones camera_init placed — the
     * arena. The fighters carry their own base and drop out here. */
    const stageDraws = draws.filter((d) => key(d.base) === key(C));

    /* The backdrop's two clocks, in degrees — see the header. */
    const driftDeg = (fr.skyAngle - 2 * opsFrame) * (360 / 65536);
    /* Everything that stands to the left of a part's own matrix: the view, and
     * for the backdrop the drift between the two clocks. Kept separate from
     * predict() so the residual can divide by exactly it — folding the drift
     * into the prediction and not into the residual is how this printed
     * nonsense for a while. */
    /* The arena frame, recovered from the draws that carry it exactly as C is
     * recovered from all of them: for a correct pairing M_board·M_viewer⁻¹ is
     * the same matrix every time, so the value the most pairings agree on is it.
     * On a stage that does not move this comes back as C and changes nothing. */
    const worldBase = (() => {
        if (!moving) return C;
        const tally = new Map();
        for (const g of stageDraws) {
            for (const v of view) {
                if (!v.world || v.model !== g.model) continue;
                const vi = inv(v.m);
                if (!vi) continue;
                const w = mul(g.m, vi);
                const k = key(w);
                const e = tally.get(k) ?? { m: w, n: 0 };
                e.n++;
                tally.set(k, e);
            }
        }
        let best = null;
        for (const e of tally.values()) if (!best || e.n > best.n) best = e;
        return best ? best.m : C;
    })();

    const pre = (v) => {
        const base = v.world ? worldBase : C;
        return v.layer === 'sky' ? mul(base, rotY(driftDeg)) : base;
    };
    const predict = (v) => mul(pre(v), v.m);

    const claimed = new Set();
    const matched = [];
    const aimed = [];
    const off = [];
    const unknown = [];
    for (const g of stageDraws) {
        let hit = null, bestErr = Infinity;
        for (const v of view) {
            if (claimed.has(v.i) || v.model !== g.model) continue;
            const err = maxdiff(g.m, predict(v));
            if (err < bestErr) { bestErr = err; hit = v; }
        }
        if (!hit) { unknown.push(g); continue; }
        claimed.add(hit.i);
        const D = mul(inv(hit.m), mul(inv(pre(hit)), g.m));
        if (bestErr <= EPS) { matched.push({ g, v: hit, err: bestErr, D }); continue; }
        /* The aimed head: a pure Y rotation is the fighters, anything else is a
         * fault. See the header. */
        /* The head is allowed to face somewhere else, and nothing more: a pure
         * rotation means it is standing where the routine puts it. */
        const col = (i) => Math.hypot(D[i], D[4 + i], D[8 + i]);
        const rotationOnly = hit.model === SPHYNX_HEAD
            && [col(0), col(1), col(2)].every((v) => Math.abs(v - 1) < 1e-4)
            && [D[3], D[7], D[11]].every((v) => Math.abs(v) < 1e-3);
        (rotationOnly ? aimed : off).push({ g, v: hit, err: bestErr, D });
    }
    const culled = view.filter((v) => !claimed.has(v.i));
    const worst = matched.reduce((m, x) => Math.max(m, x.err), 0);

    console.log(`\n=== screen frame ${fr.screen} · frame_counter ${fr.frameCounter} · `
        + `stage_num ${fr.stageNum} · sky angle ${fr.skyAngle} ===`);
    const viaGeo = draws.filter((d) => d.via === 'geo').length;
    console.log(`  ${commands} commands, ${draws.length} draws `
        + `(${viaGeo} handed straight to the geometry processor), stack balance ${stackLeft}`);
    console.log(`  view matrix shared by ${found.n} draws; ${stageDraws.length} of them are arena parts`);
    console.log(`  agree exactly: ${matched.length}   disagree: ${off.length}   `
        + `viewer parts the board culled: ${culled.length}`);
    for (const x of aimed) {
        console.log(`  ~ ${x.v.layer} model ${x.v.model}: standing exactly where the `
            + `routine puts it, facing ${describe(x.D)} away — it is aimed at the `
            + `fighters, which the viewer has none of`);
    }
    console.log(`  ${unknown.length} further draws are not stage parts (the fighters and their shadows)`);
    console.log(`  worst residual among the parts that agree: ${worst.toExponential(2)}`);
    console.log(`  backdrop drift: the two clocks are `
        + `${(2 * opsFrame - fr.skyAngle)} angle units `
        + `(${(-driftDeg).toFixed(4)}°) apart, and that is taken off the backdrop`);
    if (opsFrame !== fr.frameCounter) {
        console.log(`  arena clock: heading ${fr.carpet.yaw} -> frame ${opsFrame}, `
            + `${opsFrame - fr.frameCounter} from the frame counter`);
    }

    for (const x of off) {
        console.log(`    x ${x.v.layer.padEnd(9)} model ${String(x.v.model).padStart(5)}`
            + ` ${x.g.via === 'geo' ? '(geo)' : '     '}`
            + `  viewer is short by: ${describe(x.D)}`);
    }
    if (process.env.DETAIL) {
        for (const x of matched.sort((a, b) => a.v.i - b.v.i)) {
            console.log(`    = ${x.v.layer.padEnd(9)} model ${String(x.v.model).padStart(5)}`
                + ` ${x.g.via === 'geo' ? '(geo)' : '     '}`
                + `  residual ${x.err.toExponential(2)}`);
        }
        console.log(`    culled: ${culled.map((v) => `${v.layer}:${v.model}`).join(' ')}`);
    }

    if (off.length || worst > EPS) allOk = false;
    summary.push({
        frame: fr.screen, matched: matched.length, off: off.length,
        stageDraws: stageDraws.length, culled: culled.length, worst,
    });
}

console.log('\n--- summary ---');
for (const s of summary) {
    console.log(`frame ${s.frame}: ${s.matched}/${s.stageDraws} arena draws at the viewer's matrix `
        + `(worst residual ${s.worst.toExponential(2)}), ${s.off} disagree, ${s.culled} culled`);
}
console.log(allOk
    ? '\nEvery arena part the board drew is at exactly the matrix the viewer builds for it.'
    : '\nSome parts disagree — listed above.');
process.exit(allOk ? 0 : 1);
