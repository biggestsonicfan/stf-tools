/* Reduce a real texture-RAM capture to the digests the checks measure against.
 *
 * Run once against a MAME capture — see texram.md for how to take one —
 * and the result, `texram-ref.json`, is what `test-texram.mjs` and
 * `test-colors.mjs` hold the ported routines to from then on. The capture
 * itself is then not needed and is not tracked.
 *
 *   node make-texref.mjs [--in texram] [--rom sfight.zip]
 *
 * Only re-run this when the capture is replaced by a better one. Regenerating
 * it from ROM-built tables would make both checks tautologies, so it refuses
 * anything that is not a full-size capture, and records where it came from.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadRomSet } from './vendor/noclip/js/romset.js';
import { readStageTable } from './vendor/noclip/js/stages.js';
import { SHEET_BYTES } from './vendor/noclip/js/texture.js';
import { LUMA_BYTES, CXLAT_BYTES, PALETTE_LUMA0 } from './vendor/noclip/js/colors.js';
import { sha, sheetDigest, cxlatRowDigest, PROVENANCE } from './texref.mjs';

const SOUTH_ISLAND = 0;
const RESIDENT_SET = 16;
const FIGHTER_ROWS = [0, 1, 2, 3, 4, 28, 29];
const CXLAT_ROWS = 32;
const FIGHTER_LUMA = 64;
const CYCLE_WIDTH = 16;
const OUT = 'texram-ref.json';

const arg = (name, dflt) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const inDir = arg('in', 'texram');
const romPath = arg('rom', 'sfight.zip');

const readExact = (p, want) => {
    if (!fs.existsSync(p)) {
        console.error(`missing ${p} — see texram.md for how to capture one`);
        process.exit(2);
    }
    const b = new Uint8Array(fs.readFileSync(p));
    if (b.length !== want) {
        console.error(`${p}: expected ${want} bytes, got ${b.length} — not a full capture`);
        process.exit(2);
    }
    return b;
};

if (fs.existsSync(path.join(inDir, PROVENANCE))) {
    console.error(inDir + ' was built by extract-texram.mjs, not captured from' +
        ' hardware. A reference made from it would be the port measuring itself.');
    process.exit(2);
}

const s0 = readExact(path.join(inDir, 'texram0.bin'), SHEET_BYTES);
const s1 = readExact(path.join(inDir, 'texram1.bin'), SHEET_BYTES);
const luma = readExact(path.join(inDir, 'lumaram.bin'), LUMA_BYTES);
const cxlat = readExact(path.join(inDir, 'colorxlat.bin'), CXLAT_BYTES);

const romBuf = fs.readFileSync(romPath);
const rom = await loadRomSet([romBuf.buffer.slice(
    romBuf.byteOffset, romBuf.byteOffset + romBuf.byteLength)]);
const stage = readStageTable(rom)[SOUTH_ISLAND];
const sets = [RESIDENT_SET, ...stage.texSets];
const cycledRows = stage.colorCycles.map((c) => c.row);
const cycleBand = [PALETTE_LUMA0, PALETTE_LUMA0 + CYCLE_WIDTH];

/* A cycled row's palette band is caught mid-rotation, so it is hashed on its
 * own and left out of the row digest the byte-exact pass uses. */
const rows = {};
for (let row = 0; row < CXLAT_ROWS; row++) {
    rows[row] = cxlatRowDigest(cxlat, row, 0, 256,
        cycledRows.includes(row) ? cycleBand : null);
}
const fighterRows = {};
for (const row of FIGHTER_ROWS) {
    fighterRows[row] = cxlatRowDigest(cxlat, row, 0, FIGHTER_LUMA, null);
}
const cycledBands = {};
for (const row of cycledRows) {
    cycledBands[row] = cxlatRowDigest(cxlat, row, cycleBand[0], cycleBand[1], null);
}

const manifest = {
    note: 'SHA-256 over a MAME capture of the real board, cut at the slices ' +
        'test-texram.mjs and test-colors.mjs compare at. Not derived from the ' +
        'ported routines — regenerating it from those would make both checks ' +
        'tautologies. See texref.mjs.',
    source: 'MAME capture, South Island on screen, set 16 left resident by the ' +
        'attract and character-select screens',
    stage: SOUTH_ISLAND,
    sets,
    cycledRows,
    cycleBand,
    lumaram: sha(luma),
    texram0: sheetDigest(s0),
    texram1: sheetDigest(s1),
    colorxlat: { rows, fighterRows, cycledBands },
};

fs.writeFileSync(OUT, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${OUT}: sets [${sets}], cycled rows [${cycledRows}], ` +
    `${Object.keys(rows).length} colorxlat rows`);
