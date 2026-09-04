/* Rebuild the texture-RAM binaries from a ROM set, so none of them have to be
 * carried in the tree.
 *
 * About 85% of the texture pages are compressed, so the sheets do not exist in
 * ROM in a readable form: the game unpacks them into texture RAM on every scene
 * change, and js/texture.js and js/colors.js are ports of the routines that do
 * it. That means a ROM set plus this repository is enough to produce exactly
 * what the board holds — which is why the binaries need not be stored.
 *
 *   node extract-texram.mjs                    # South Island, into the temp dir
 *   node extract-texram.mjs --stage 5 --fighter 0
 *   node extract-texram.mjs --rom /c/m2/2d/sfight.zip --out /tmp/tex
 *
 * Writes texram0.bin, texram1.bin, lumaram.bin and colorxlat.bin — the four
 * files `dump-atlas.mjs` reads and the viewer's Textures panel accepts.
 *
 * These are *derived* files, not a capture of hardware. They are what the port
 * believes the board would hold, so they cannot be used to check the port:
 * `make-texref.mjs` refuses a directory carrying the PROVENANCE.txt written
 * here, because a reference built from them would make both checks tautologies.
 * A real capture comes from MAME — see texram.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadRomSet } from './vendor/noclip/js/romset.js';
import { readStageTable } from './vendor/noclip/js/stages.js';
import { buildTexram } from './vendor/noclip/js/texture.js';
import { buildLumaram, buildColorxlat } from './vendor/noclip/js/colors.js';
import { PROVENANCE, TEXRAM_DIR } from './texref.mjs';

/* Set 16 goes in first because the attract and character-select screens leave
 * it resident, and the stage sets do not overwrite its deepest mip levels. */
const RESIDENT_SET = 16;

const arg = (name, dflt) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt;
};

const romPath = arg('rom', process.env.STF_ROM || 'sfight.zip');
const outDir = arg('out', TEXRAM_DIR);
const stageNum = Number(arg('stage', 0));
const fighterArg = arg('fighter', null);
const fighter = fighterArg === null ? null : Number(fighterArg);

if (!fs.existsSync(romPath)) {
    console.error(`no ROM set at ${romPath} — pass --rom <sfight.zip>, or set STF_ROM`);
    process.exit(2);
}

const buf = fs.readFileSync(romPath);
const rom = await loadRomSet([buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)]);
const stages = readStageTable(rom);
if (!(stageNum >= 0 && stageNum < stages.length)) {
    console.error(`--stage must be 0..${stages.length - 1}`);
    process.exit(2);
}
const stage = stages[stageNum];

const sets = [RESIDENT_SET, ...stage.texSets];
const { sheet0, sheet1, pages } = buildTexram(rom, sets);
const luma = buildLumaram(rom);
/* No stage model names a fighter, so with none given those rows stay zero —
 * which is what a scene with nobody in it holds. */
const cxlat = buildColorxlat(rom, {
    colorSet: stage.texSet[1],
    tint: stage.tint,
    fighters: fighter === null ? [] : [fighter],
});

fs.mkdirSync(outDir, { recursive: true });
const wrote = [];
for (const [name, bytes] of [
    ['texram0.bin', sheet0], ['texram1.bin', sheet1],
    ['lumaram.bin', luma], ['colorxlat.bin', cxlat],
]) {
    const p = path.join(outDir, name);
    fs.writeFileSync(p, bytes);
    wrote.push(`${name} (${bytes.length} bytes)`);
}

fs.writeFileSync(path.join(outDir, PROVENANCE),
    `Built by extract-texram.mjs from ${path.basename(romPath)}.\n` +
    `stage ${stageNum}, texture sets [${sets}], fighter ${fighter === null ? 'none' : fighter}.\n\n` +
    'These are derived from the ported routines in js/texture.js and js/colors.js,\n' +
    'not captured from hardware. Do not build texram-ref.json from them: the\n' +
    'checks that read it would then be measuring the port against itself.\n');

console.log(`stage ${stageNum}: sets [${sets}] -> ${pages} pages`);
console.log(`wrote ${outDir}/: ${wrote.join(', ')}`);
