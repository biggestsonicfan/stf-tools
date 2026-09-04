/*
 * test-carpet.mjs — checks the Flying Carpet's flight path and the sphynx head.
 *
 * The stage is the only one whose draw list is a function of where the stage
 * itself has got to, so there are two things worth holding onto:
 *
 *  - the world prologue really is the carpet's frame inverted. Push the
 *    carpet's own position through it and the origin must come back, on every
 *    frame, or the arena is not where the viewer thinks it is.
 *  - the head is aimed, not placed. draw_sphynx_head works out a yaw and a
 *    pitch and applies them last, so after the whole chain one fixed axis of
 *    the model must point at what the routine aimed it at. Which axis that is
 *    is not written down anywhere; this finds it, and having found it, the
 *    residual is the check.
 *
 *    The routine works the head's position out with a 1.6 and then draws at the
 *    unscaled constant, so on the board the head stands 1/1.6 of the way out
 *    and its aim, computed for the other position, trails the arena by as much
 *    as 162 degrees. display.js follows the probe, which is the position the
 *    routine computed for itself, and that makes the two agree: the head points
 *    exactly at what it was aimed at. So the lag is asserted to be zero here.
 *    It is not a tolerance being relaxed — a non-zero lag would mean the
 *    position and the aim had come apart again, which is the bug itself.
 */
import { loadRomSet } from './vendor/noclip/js/romset.js';
import { readStageTable } from './vendor/noclip/js/stages.js';
import { buildStageDisplayList, readFrameTables, opsAt, carpetAt } from './vendor/noclip/js/display.js';
import fs from 'fs';

const rd = (p) => { const b = fs.readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const rom = await loadRomSet([rd('sfight.zip')]);
const stage = readStageTable(rom)[1];
const list = buildStageDisplayList(stage, readFrameTables(rom));

/* Row-major 4x4, composed the way app.js composes an op list: each op
 * post-multiplies, and the rotations follow three's makeRotationX/Y. */
const I = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const mul = (a, b) => {
    const o = new Array(16).fill(0);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++)
        for (let k = 0; k < 4; k++) o[r * 4 + c] += a[r * 4 + k] * b[k * 4 + c];
    return o;
};
const apply = (m, p) => [0, 1, 2].map((r) => m[r * 4] * p[0] + m[r * 4 + 1] * p[1] + m[r * 4 + 2] * p[2] + m[r * 4 + 3]);
const rotate = (m, v) => [0, 1, 2].map((r) => m[r * 4] * v[0] + m[r * 4 + 1] * v[1] + m[r * 4 + 2] * v[2]);
function compose(ops) {
    let m = I();
    for (const [kind, v] of ops) {
        const d = (v * Math.PI) / 180, c = Math.cos(d), s = Math.sin(d);
        if (kind === 's') m = mul(m, [v[0], 0, 0, 0, 0, v[1], 0, 0, 0, 0, v[2], 0, 0, 0, 0, 1]);
        else if (kind === 'r') m = mul(m, [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1]);
        else if (kind === 'rx') m = mul(m, [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1]);
        else m = mul(m, [1, 0, 0, v[0], 0, 1, 0, v[1], 0, 0, 1, v[2], 0, 0, 0, 1]);
    }
    return m;
}

const FRAMES = 2048;                       /* one lap */
const deg = (r) => (r * 180) / Math.PI;
let bad = 0;
const fail = (msg) => { console.log('FAIL', msg); bad++; };

/* ---- the path itself ---- */
{
    let rmin = Infinity, rmax = -Infinity, ymin = Infinity, ymax = -Infinity, rises = 0;
    let prevY = carpetAt(0).pos[1], climbing = null;
    for (let f = 0; f < FRAMES; f++) {
        const { pos } = carpetAt(f);
        const r = Math.hypot(pos[0], pos[2]);
        rmin = Math.min(rmin, r); rmax = Math.max(rmax, r);
        ymin = Math.min(ymin, pos[1]); ymax = Math.max(ymax, pos[1]);
        const up = pos[1] > prevY;
        if (climbing === false && up) rises++;
        climbing = pos[1] === prevY ? climbing : up;
        prevY = pos[1];
    }
    console.log(`path   radius ${rmin.toFixed(3)}..${rmax.toFixed(3)}  height ${ymin.toFixed(3)}..${ymax.toFixed(3)}  ${rises} troughs in a lap`);
    if (Math.abs(rmin - 60) > 1e-6 || Math.abs(rmax - 60) > 1e-6) fail('the circle is not radius 60');
    if (Math.abs(ymin) > 1e-6 || Math.abs(ymax - 8) > 1e-6) fail('the bob is not 4 +/- 4');
    if (rises !== 4) fail(`${rises} troughs in a lap, wanted 4`);
    const wrap = carpetAt(FRAMES).pos;
    if (Math.hypot(...[0, 1, 2].map((i) => wrap[i] - carpetAt(0).pos[i])) > 1e-9) fail('the lap does not close after 2048 frames');
}

/* ---- the world prologue is the carpet's frame, inverted ---- */
{
    const ground = list.find((e) => e.layer === 'ground' && e.model !== 322);
    /* A world-space draw carries the prologue first and its own transform
     * after: for a scenery chunk that is the 1.6 ground_disp pushes, which the
     * board emits inside the prologue's translate, so the carpet's orbit is in
     * the scaled arena's units. Only the prologue is supposed to invert the
     * carpet's frame, so take it on its own — the way the head's probe does
     * below — and check the tail separately rather than assume it is empty. */
    const own = opsAt(ground, 0).slice(3);
    if (own.length !== 1 || own[0][0] !== 's' || own[0][1].some((v) => v !== 1.6)) {
        fail(`a scenery chunk should carry the prologue then ground_disp's 1.6, got ${JSON.stringify(own)}`);
    }
    let worst = 0;
    for (let f = 0; f < FRAMES; f += 7) {
        const { pos } = carpetAt(f);
        /* The board's Z runs the other way, so the carpet's own position
         * reaches the viewer's world with its Z negated. */
        const at = apply(compose(opsAt(ground, f).slice(0, 3)), [pos[0], pos[1], -pos[2]]);
        worst = Math.max(worst, Math.hypot(...at));
    }
    console.log(`world  carpet lands ${worst.toExponential(1)} from the origin at worst`);
    if (worst > 1e-9) fail('the world prologue does not put the carpet at the origin');
}

/* ---- the head is aimed ---- */
{
    const head = list.find((e) => e.model === 322);
    if (!head) fail('no sphynx head in the draw list');
    const AXES = { '+x': [1, 0, 0], '-x': [-1, 0, 0], '+y': [0, 1, 0], '-y': [0, -1, 0], '+z': [0, 0, 1], '-z': [0, 0, -1] };
    const worst = {};
    for (const k of Object.keys(AXES)) worst[k] = 0;
    let lag = 0;
    for (let f = 0; f < FRAMES; f += 7) {
        const at = carpetAt(f);
        const m = compose(opsAt(head, f));
        const here = apply(m, [0, 0, 0]);
        /* Where the routine thinks the head is, in the same frame it is drawn
         * in: the probe's 1.6x point, carried through the prologue. */
        const probe = apply(compose(opsAt(head, f).slice(0, 3)),
            [-7.85 * 1.6, 7.0 * 1.6, -52.0 * 1.6]);
        const aimed = probe.map((v) => -v);              /* probe -> the arena */
        const truly = here.map((v) => -v);               /* head  -> the arena */
        const ang = (a, b) => deg(Math.acos(Math.max(-1, Math.min(1,
            (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b))))));
        for (const [k, v] of Object.entries(AXES)) worst[k] = Math.max(worst[k], ang(rotate(m, v), aimed));
        lag = Math.max(lag, ang(aimed, truly));
    }
    const [axis, err] = Object.entries(worst).sort((a, b) => a[1] - b[1])[0];
    console.log(`head   faces model ${axis}, off the angle it was aimed at by at most ${err.toFixed(4)} deg`);
    console.log(`       drawn at the position its own probe worked out, so it trails what it aims at by ${lag.toFixed(4)} deg`);
    if (err > 1e-3) fail(`no model axis follows the look-at (best ${axis} at ${err.toFixed(2)} deg)`);
    /* Drawn where the probe put it, the head aims at the arena exactly. Any lag
     * means the draw and the probe have come apart — the ROM's own bug, back. */
    if (lag > 1e-3) fail(`the head trails the arena by ${lag.toFixed(2)} deg; its position and its aim disagree`);
}

console.log(bad ? `\n${bad} failed` : '\nall good');
process.exit(bad ? 1 : 0);
