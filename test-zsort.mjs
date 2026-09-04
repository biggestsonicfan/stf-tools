/*
 * test-zsort.mjs — the polygon's own depth, checked against the board's rule.
 *
 * The board sorts a whole polygon by one z: bits 10-11 of the attribute word
 * pick the nearest corner (1), the farthest (2), a fixed "very far" (3) or the
 * previous polygon's (0), and model2_v.cpp buckets on that and lets the first
 * polygon over a pixel keep it. The decoder resolves that choice per face and
 * hands the shader the corners it is measured over; the shader is GLSL and
 * cannot be imported, so the rule is written out again here against MAME's
 * rather than against the shader's copy — the same argument as test-texaddr.
 *
 * What is pinned:
 *   - every emitted face carries a resolved mode, never the "inherit" 0;
 *   - the resolved mode matches the attribute word the face was emitted for;
 *   - Casino Night's emerald comes out in front of the plate it is painted on
 *     at a camera like the game's, and does not pixel against pixel. That
 *     is the case the rule exists for.
 *
 * Run: node test-zsort.mjs [rom.zip]
 */

import fs from 'fs';
import {
    loadRomSet, readModelEntry, MODEL_TABLE_COUNT,
    MESH_PTR_SUBTRACT, MESH_PTR_ADD,
} from './vendor/noclip/js/romset.js';
import { decodeModel } from './vendor/noclip/js/model.js';

const ROM = process.argv[2] ?? 'sfight.zip';
const read = (p) => {
    const b = fs.readFileSync(p);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const rom = await loadRomSet([read(ROM)]);

let bad = 0;
const fail = (msg) => { console.log(`FAIL: ${msg}`); bad++; };

/* The mode the decoder resolved for a triangle, out of aFlags bits 5-6. */
const modeOf = (m, tri) => (m.flags[tri * 3] >> 5) & 3;

/* ---- every face carries a resolved mode ---- */
{
    const seen = new Map();
    let faces = 0;
    for (let i = 0; i < MODEL_TABLE_COUNT; i++) {
        const m = decodeModel(rom, i);
        if (!m) continue;
        for (let t = 0; t < m.flags.length / 3; t++) {
            const z = modeOf(m, t);
            seen.set(z, (seen.get(z) ?? 0) + 1);
            faces++;
        }
    }
    if (seen.get(0)) fail(`${seen.get(0)} triangles kept the "inherit" mode 0`);
    const spread = [...seen].sort().map(([k, n]) => `${k}:${n}`).join(' ');
    console.log(`${faces} triangles, modes ${spread}`);
}

/* ---- the mode is the one in the attribute word ---- */
{
    /* The attribute words, in the order the face loop reads them: one per
     * vertex pair, and the face emitted for group i reads pair i. */
    const attrs = (idx) => {
        const e = readModelEntry(rom, idx);
        let off = (e.meshPtr * 4 - MESH_PTR_SUBTRACT + MESH_PTR_ADD) >>> 0;
        const out = [];
        for (let i = 0; i < 4096; i++) {
            const a = rom.polygonsView.getUint32(off + 24, true) >>> 0;
            out.push(a);
            if (a === 0) break;
            off += 40;
        }
        return out;
    };
    /* Checked on a handful rather than the whole table: re-deriving which pair
     * each emitted face came from means re-running the face loop, and these
     * cover a triangle mesh, a strip-heavy one and the platform in question. */
    let checked = 0;
    for (const idx of [194, 456, 518, 1223, 3351]) {
        const m = decodeModel(rom, idx);
        const a = attrs(idx);
        const modes = new Set();
        for (let t = 0; t < m.flags.length / 3; t++) modes.add(modeOf(m, t));
        const inWord = new Set(a.map((w) => (w >>> 10) & 3).filter((z) => z !== 0));
        for (const z of modes) {
            if (!inWord.has(z)) fail(`model ${idx} emitted mode ${z}, which no pair asks for`);
        }
        checked++;
    }
    console.log(`${checked} models' modes are all modes their own records ask for`);
}

/* ---- Casino Night's emerald sits on the plate, not under it ---- */
{
    const m = decodeModel(rom, 194);
    /* The gem decal, and the near-black diamond it is painted on. */
    const EMERALD = [54, 55, 56, 57, 58];
    const PLATE = [237, 238];
    if (m.colors[54 * 9 + 1] < m.colors[54 * 9] || m.colors[54 * 9 + 1] < m.colors[54 * 9 + 2]) {
        fail('triangle 54 is not the green decal any more; the indices have moved');
    }
    /* The board's camera on this stage looks down on the platform from in
     * front. Depth is distance along the view direction, positive away. */
    const eye = [0, 6, -12];
    const fwd = (() => {
        const d = [-eye[0], -eye[1], -eye[2]];
        const n = Math.hypot(...d);
        return d.map((v) => v / n);
    })();
    const depth = (x, y, z) =>
        (x - eye[0]) * fwd[0] + (y - eye[1]) * fwd[1] + (z - eye[2]) * fwd[2];
    /* stage_dsp draws the platform at (floor_size, 1.6, floor_size); the
     * argument does not turn on the exact scale, so the record's 1.334 stands
     * in for it. */
    const S = [1.334, 1.6, 1.334];

    /* The rule: a polygon takes its farthest corner when it asks for one, may
     * only ever recede by it, may recede by at most ZSORT_RECEDE, and only
     * recedes at all while the face is itself no deeper than that along the
     * view — see the note in js/viewer.js, and Canyon Cruise's river and Aurora
     * Icefield's ice for why a deep face is left alone. The emerald is what the
     * rule exists for, so it is checked with the whole condition in place
     * rather than without it, and the plate's own depth is reported beside the
     * bound: a camera that took the plate over it would show up here as the
     * emerald losing rather than as a silent change of rule. */
    const ZSORT_RECEDE = 12.0;
    const faceSpan = (t) => {
        const zs = [0, 1, 2, 3].map((c) => depth(
            m.zCorners[c][t * 9 + 0] * S[0],
            m.zCorners[c][t * 9 + 1] * S[1],
            m.zCorners[c][t * 9 + 2] * S[2],
        ));
        return Math.max(...zs) - Math.min(...zs);
    };
    const faceDepth = (tris) => {
        let d = -Infinity;
        for (const t of tris) {
            const mode = modeOf(m, t);
            const corners = [0, 1, 2, 3].map((c) => [
                m.zCorners[c][t * 9 + 0] * S[0],
                m.zCorners[c][t * 9 + 1] * S[1],
                m.zCorners[c][t * 9 + 2] * S[2],
            ]);
            const zs = corners.map((p) => depth(...p));
            const own = depth(m.positions[t * 9] * S[0],
                              m.positions[t * 9 + 1] * S[1],
                              m.positions[t * 9 + 2] * S[2]);
            const board = mode === 2 ? Math.max(...zs)
                : mode === 3 ? 1e10 : Math.min(...zs);
            const deep = faceSpan(t) > ZSORT_RECEDE;
            d = Math.max(d, deep ? own : Math.min(Math.max(board, own), own + ZSORT_RECEDE));
        }
        return d;
    };
    /* The per-pixel comparison, at a point both cover: the emerald's centre,
     * and the plate directly above it. */
    let cx = 0, cz = 0, n = 0;
    for (const t of EMERALD) {
        for (let v = 0; v < 3; v++) { cx += m.positions[t * 9 + v * 3]; cz += m.positions[t * 9 + v * 3 + 2]; n++; }
    }
    cx = (cx / n) * S[0]; cz = (cz / n) * S[2];
    const emY = m.positions[54 * 9 + 1] * S[1];

    const em = faceDepth(EMERALD), pl = faceDepth(PLATE);
    if (!(em < pl)) {
        fail(`the emerald sorts at ${em.toFixed(2)} and the plate at ${pl.toFixed(2)}: it is still behind`);
    }
    /* And the case is real: pixel against pixel the emerald loses, because the
     * ROM models it 0.087 below the plate. */
    if (!(depth(cx, emY, cz) > depth(cx, 0, cz))) {
        fail('the emerald is no longer behind the plate per-pixel, so this test proves nothing');
    }
    const plSpan = Math.max(...PLATE.map(faceSpan));
    if (plSpan > ZSORT_RECEDE) fail(`the plate is ${plSpan.toFixed(2)} deep, over the bound`);
    console.log(`emerald sorts ${(pl - em).toFixed(2)} in front of the plate `
        + `(${(m.positions[54 * 9 + 1] * S[1]).toFixed(3)} below it in the mesh, `
        + `the plate ${plSpan.toFixed(2)} deep against a bound of ${ZSORT_RECEDE})`);
}

/* A decal and the surface under it come out as the same triangles.
 *
 * A decal here is the surface's own faces emitted a second time with a cut-out
 * texture. Both copies take their z from the same corners, so the board puts
 * them in one bucket and the later one keeps the pixel; the viewer gets that
 * from a LessEqual depth test, but only while the two are triangulated the same
 * way — a quad cut along the other diagonal is a different surface wherever it
 * has any warp, and the half that bulges the wrong way is drawn behind.
 *
 * Sonic's shouting head is the case that showed it: six quads of mouth on six of
 * muzzle, two of them cut the other way, and the right of the mouth missing. So
 * every one of its twelve triangles must have its twin in the muzzle. Across the
 * table the count is the same statement in bulk — cutting a coincident quad the
 * way the first one was cut took the number of triangles with an exact twin from
 * 4346 to 7216, and a regression would put it back.
 */
{
    const cornerKey = (m, t, k) => [0, 1, 2]
        .map((a) => Math.round(m.positions[(t * 3 + k) * 3 + a] * 4096))
        .join(',');
    const triKey = (m, t) => [0, 1, 2].map((k) => cornerKey(m, t, k)).sort().join('|');

    let stacked = 0, deepest = 0;
    for (let i = 0; i < MODEL_TABLE_COUNT; i++) {
        const m = decodeModel(rom, i);
        if (!m) continue;
        const seen = new Map();
        for (let t = 0; t < m.positions.length / 9; t++) {
            const k = triKey(m, t);
            const n = (seen.get(k) ?? 0) + 1;
            seen.set(k, n);
            if (n > 1) { stacked++; deepest = Math.max(deepest, n); }
        }
    }
    if (stacked < 7000) {
        fail(`only ${stacked} triangles land on a triangle already emitted; `
            + 'coincident quads are being cut two different ways again');
    }

    const head = decodeModel(rom, 3544);
    const tris = head.positions.length / 9;
    const where = new Map();
    for (let t = 0; t < tris; t++) {
        where.set(triKey(head, t), (where.get(triKey(head, t)) ?? []).concat(t));
    }
    let mouth = 0, paired = 0;
    for (let t = 0; t < tris; t++) {
        if (head.tiles[t * 12] !== 1152) continue;
        mouth++;
        const group = where.get(triKey(head, t));
        if (group.length === 2 && group[0] < t) paired++;
    }
    if (mouth !== 12) fail(`model 3544 has ${mouth} mouth triangles, expected 12`);
    if (paired !== mouth) {
        fail(`${mouth - paired} of the mouth's ${mouth} triangles are not cut like the muzzle under them`);
    }
    console.log(`${stacked} triangles land on one already emitted, ${deepest} deep at the worst; `
        + `all ${mouth} of model 3544's mouth triangles have their twin in the muzzle`);
}

/* South Island's floor plate and its sea are tied, so only the order can part
 * them.
 *
 * Model 517 is the four quads of ring floor `camera_init` draws; model 555 is
 * the sea. The sea carries four quads of its own over exactly the same ground,
 * and they are not merely coplanar: every one of the floor's sort groups has a
 * group in the sea with the *same four corners* and the same z-sort mode, so
 * the two resolve to one z at every camera that exists and no depth test can
 * separate them. That is what makes `js/viewer.js`'s floorMaterial necessary
 * rather than a preference — the floor stands one depth unit back because the
 * board's own answer is the submission order, and `camera_init` submits first.
 *
 * Three of the four are also cut along opposite diagonals, which is why the
 * order alone is not enough: two triangulations of one flat quad round apart
 * and speckle, which is what the slope half of the offset is for. Only the east
 * quad happens to be cut alike, and there the tie is exact and the order settles
 * it on its own. That split is pinned too, so a decoder change that moved it
 * would say so here rather than quietly making half the offset redundant.
 */
{
    const groupKey = (m, t) => [0, 1, 2, 3]
        .map((c) => [0, 1, 2]
            .map((a) => Math.round(m.zCorners[c][t * 9 + a] * 4096)).join(','))
        .filter((v, i, all) => all.indexOf(v) === i)
        .sort()
        .join(' ');
    const key3 = (m, t) => [0, 1, 2]
        .map((k) => [0, 1, 2]
            .map((a) => Math.round(m.positions[(t * 3 + k) * 3 + a] * 4096)).join(','))
        .sort()
        .join(' ');
    const groups = (idx) => {
        const m = decodeModel(rom, idx);
        const out = new Map();
        for (let t = 0; t < m.positions.length / 9; t++) {
            const k = groupKey(m, t);
            const g = out.get(k) ?? { mode: modeOf(m, t), tris: [] };
            g.tris.push(key3(m, t));
            out.set(k, g);
        }
        return out;
    };
    const floor = groups(517), sea = groups(555);
    if (floor.size !== 4) fail(`model 517 has ${floor.size} sort groups, expected 4`);
    let tied = 0, cutAlike = 0;
    for (const [k, g] of floor) {
        const other = sea.get(k);
        if (!other) { fail(`the floor's group ${k} has no twin in the sea`); continue; }
        if (other.mode !== g.mode) {
            fail(`the floor sorts a group by mode ${g.mode} and the sea by ${other.mode}`);
            continue;
        }
        tied++;
        if (g.tris.some((t) => other.tris.includes(t))) cutAlike++;
    }
    if (tied !== floor.size) {
        fail(`${floor.size - tied} of the floor's groups are not tied by the sea`);
    }
    if (cutAlike !== 1) {
        fail(`${cutAlike} of the tied quads are cut alike, not 1: the depths round apart `
            + 'over a different set of them than floorMaterial was measured against');
    }
    console.log(`all ${tied} of model 517's sort groups are tied by model 555 on the same `
        + `corners and mode; ${tied - cutAlike} are cut along the other diagonal`);
}

/* ---- the water is deep everywhere and the island standing in it is not ----
 *
 * The recede is bounded, and a face deeper than the bound along the view keeps
 * the depth the projection gave it. That splits South Island's waterline in two:
 * the sea 555 and the floor plate 517 are one plate each, hundreds of units
 * across, so they are deep from any camera and never move -- while the island
 * 518 standing on them is a box of rock faces a few units deep that recede in
 * full, and sank under the water they stand in. js/viewer.js answers that by
 * having both plates concede the bound outright (waterMaterial, floorMaterial),
 * which only holds while the island's own recede stays inside it.
 *
 * So: at a camera that showed the artifact, every face of both plates is deeper
 * than the bound, and no face of the island recedes as far as the bound. */
{
    const eye = [43.47, 12, -11.65], at = [0, -5, 0];
    const fwd = (() => {
        const d = [at[0] - eye[0], at[1] - eye[1], at[2] - eye[2]];
        const n = Math.hypot(...d);
        return d.map((v) => v / n);
    })();
    const depth = (x, y, z) =>
        (x - eye[0]) * fwd[0] + (y - eye[1]) * fwd[1] + (z - eye[2]) * fwd[2];
    const ZSORT_RECEDE = 12.0;
    /* ground_disp draws both plates at a flat 1.6; stage_dsp draws the arena
     * platform at (floor_size, 1.6, floor_size), and this record's is 2. */
    const spans = (idx, S) => {
        const m = decodeModel(rom, idx);
        const out = [];
        for (let t = 0; t < m.flags.length / 3; t++) {
            const zs = [0, 1, 2, 3].map((c) => depth(
                m.zCorners[c][t * 9 + 0] * S[0],
                m.zCorners[c][t * 9 + 1] * S[1],
                m.zCorners[c][t * 9 + 2] * S[2],
            ));
            out.push(Math.max(...zs) - Math.min(...zs));
        }
        return out;
    };
    for (const idx of [555, 517]) {
        const sp = spans(idx, [1.6, 1.6, 1.6]);
        const shallow = sp.filter((d) => d <= ZSORT_RECEDE).length;
        if (shallow) {
            fail(`${shallow} of model ${idx}'s ${sp.length} faces are inside the bound at `
                + 'this camera, so the plate is not the deep-face case the concede is for');
        }
        console.log(`model ${idx}: all ${sp.length} faces deeper than the bound `
            + `(${Math.min(...sp).toFixed(1)} at the shallowest)`);
    }
    const isl = spans(518, [2, 1.6, 2]);
    const worst = Math.max(...isl.filter((d) => d <= ZSORT_RECEDE));
    if (!(worst < ZSORT_RECEDE)) {
        fail(`the island recedes ${worst.toFixed(2)}, which a concede of `
            + `${ZSORT_RECEDE} does not clear`);
    }
    console.log(`model 518 recedes at most ${worst.toFixed(2)} of the ${ZSORT_RECEDE} `
        + 'the plates concede');
}

console.log(bad ? `\n${bad} failed` : '\nall good');
process.exit(bad ? 1 : 0);
