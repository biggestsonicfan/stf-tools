/*
 * test-layers.mjs — decals that only the coplanar ranking can part from the
 * surface they are painted on.
 *
 * test-zsort.mjs pins the per-polygon recede. These two models are the cases
 * the recede cannot reach, which is why sfight turns on js/layers.js:
 *
 *   - Flying Carpet's sand, model 580: the pyramid and Sphinx shadows are 32
 *     checker triangles at z-mode 1 lying exactly in the sand's plane, and the
 *     262 sand triangles are mode 2 and up to ~160 units long. From most views
 *     the sand is too deep to recede, ties with the shadows, and the GPU's
 *     tie-break draws them in shards.
 *   - Casino Night's slot machine, model 188: the JACKPOT art (faces 25 and 26)
 *     stands 0.02 and 0.03 in front of the faces under it. Seen square on the
 *     recede does not move those faces, and at the stage camera's distance the
 *     gap is under one step of the depth buffer, so the orange shows through.
 *
 * What is pinned:
 *   - the ranking puts every decal triangle above layer 0, and leaves every
 *     other triangle of the model at layer 0;
 *   - the sfight profile asks for the ranking at all: if `depth.layers` is
 *     dropped the viewer never uses it, though the ranking itself still passes.
 *
 * Run: node test-layers.mjs [rom.zip]
 * STF_EXPLORER points at another explorer checkout (default vendor/noclip).
 */

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const ROM = process.argv[2] ?? 'sfight.zip';
const EXPLORER = path.resolve(process.env.STF_EXPLORER ?? 'vendor/noclip');
const js = (f) => import(pathToFileURL(path.join(EXPLORER, 'js', f)).href);
const { loadRomSet } = await js('romset.js');
const { decodeModel } = await js('model.js');
const { coplanarLayers } = await js('layers.js');

const read = (p) => {
    const b = fs.readFileSync(p);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const rom = await loadRomSet([read(ROM)]);

let bad = 0;
const fail = (msg) => { console.log(`FAIL: ${msg}`); bad++; };

if (!rom.game.depth?.layers) {
    fail(`the ${rom.game.id ?? 'sfight'} profile does not set depth.layers, `
        + 'so the viewer never ranks these decals');
}

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/* [model, what, is this triangle a decal, decals, the rest] */
const CASES = [
    [580, 'Flying Carpet sand shadows',
        (d, t) => d.flags[t * 3] === 34 && d.tiles[t * 12] === 1216 && d.tiles[t * 12 + 1] === 0,
        32, 262],
    [188, 'Casino Night JACKPOT panels',
        (d, t) => d.faces[t] === 25 || d.faces[t] === 26,
        4, 60],
];

for (const [idx, what, isDecal, wantDecals, wantRest] of CASES) {
    const d = decodeModel(rom, idx);
    if (!d) { fail(`model ${idx} does not decode`); continue; }
    const t0 = performance.now();
    const [{ layer }] = coplanarLayers([{ decoded: d, matrix: I }]);
    const ms = performance.now() - t0;
    let decals = 0, raised = 0, rest = 0, flat = 0;
    for (let t = 0; t < d.positions.length / 9; t++) {
        if (isDecal(d, t)) {
            decals++;
            if (layer[t * 3] > 0) raised++;
        } else {
            rest++;
            if (layer[t * 3] === 0) flat++;
        }
    }
    if (decals !== wantDecals) fail(`model ${idx} has ${decals} decal triangles, expected ${wantDecals}; the indices have moved`);
    if (rest !== wantRest) fail(`model ${idx} has ${rest} other triangles, expected ${wantRest}`);
    if (raised !== decals) fail(`model ${idx}: only ${raised} of ${decals} decal triangles rank above the surface under them`);
    if (flat !== rest) fail(`model ${idx}: ${rest - flat} of ${rest} other triangles were ranked above layer 0`);
    console.log(`model ${idx} (${what}): ${raised}/${decals} decal triangles above layer 0, `
        + `${flat}/${rest} others at 0, ${ms.toFixed(1)} ms`);
}

console.log(bad ? `\n${bad} failed` : '\nall good');
process.exit(bad ? 1 : 0);
