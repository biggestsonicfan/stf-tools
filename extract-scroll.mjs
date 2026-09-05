/* Extract the 2D scroll layer's art from a ROM set as PNGs.
 *
 * The logos, the HUD, the character-select portraits and the text are tilemaps
 * on the board's 2D layer, not geometry and not in the texture ROM, so nothing
 * else here reaches them: `scroll.mjs` is the port of the routines that build
 * them and this is what turns its output into files.
 *
 *   node extract-scroll.mjs                       # every picture, into the temp dir
 *   node extract-scroll.mjs --list                # the table, with no files written
 *   node extract-scroll.mjs --cell 240            # one picture, on every set that fits
 *   node extract-scroll.mjs --cell 240 --set 15 --out fang.png
 *   node extract-scroll.mjs --every-set           # every set that fits, not just the first
 *   node extract-scroll.mjs --loose               # every cell x set pair that paints
 *   node extract-scroll.mjs --rom /c/m2/2d/sfight.zip --out-dir /tmp/scroll
 *
 * A picture is a "cell", 1 to 534, and the tiles and colours it is drawn with
 * are a "CG set", 0 to 91 — the two arguments the game's own routines take. It
 * does not record which set goes with which cell, so a cell is paired with the
 * set that uploaded every tile it names; all 534 have one, and 363 have more
 * than one because the sets overlap. `--every-set` writes each distinct result
 * — 1753 files. `--loose` is the brute force over all 48,000 pairs, which draws
 * a picture on any set holding some of its tiles as well: 7339 files, most of
 * them the same art with the tiles a set is missing left out.
 *
 * Writes to a temp directory rather than into the checkout, like
 * extract-texram.mjs: this is the game's own art and none of it belongs here.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadRomSet } from './vendor/noclip/js/romset.js';
import { writeRGBAPNG } from './png.mjs';
import * as S from './scroll.mjs';

const SCROLL_DIR = path.join(os.tmpdir(), 'stf-scroll');

const arg = (name, dflt) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt;
};
const flag = (name) => process.argv.includes(`--${name}`);

const romPath = arg('rom', process.env.STF_ROM || 'sfight.zip');
const outDir = arg('out-dir', SCROLL_DIR);
const outFile = arg('out', null);
const bank = Number(arg('bank', 0));
const cellArg = arg('cell', null);
const setArg = arg('set', null);
const everySet = flag('every-set');
const loose = flag('loose');
const list = flag('list');

if (!fs.existsSync(romPath)) {
    console.error(`no ROM set at ${romPath} — pass --rom <sfight.zip>, or set STF_ROM`);
    process.exit(2);
}
const buf = fs.readFileSync(romPath);
const rom = await loadRomSet([buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)]);

/* Every set, loaded once: a set is 512 kB of tile RAM and reloading it per
 * picture is what makes the brute force slow rather than the drawing. */
const sets = [];
for (let s = 0; s < S.CG_SET_COUNT; s++) {
    if (!S.scrollSetPresent(rom, s)) { sets.push(null); continue; }
    const loaded = S.loadScrollSet(rom, s);
    sets.push({ loaded, have: S.setTiles(loaded) });
}

const cells = [];
for (let c = 0; c <= S.PATTERN_LIMIT; c++) {
    const pattern = S.readPattern(rom, c, bank);
    if (pattern) cells.push(pattern);
}

/** The sets that hold every tile a picture names, in order. */
const fits = (pattern) => sets
    .map((s, i) => (s && S.coverage(pattern, s.loaded, s.have) === 1 ? i : -1))
    .filter((i) => i >= 0);

if (list) {
    console.log('cell  size    sets that hold every tile it names');
    for (const p of cells) {
        const f = fits(p);
        console.log(`${String(p.cell).padStart(4)}  ${`${p.width}x${p.height}`.padEnd(7)} `
            + `${f.length ? f.join(' ') : '(none)'}`);
    }
    console.log(`\n${cells.length} pictures, ${sets.filter(Boolean).length} sets`);
    process.exit(0);
}

/* ---- one picture --------------------------------------------------------- */

if (cellArg !== null && setArg !== null) {
    const cell = Number(cellArg), set = Number(setArg);
    const pattern = cells.find((p) => p.cell === cell);
    if (!pattern) { console.error(`cell ${cell} is not a picture`); process.exit(2); }
    if (!sets[set]) { console.error(`set ${set} is empty`); process.exit(2); }
    const img = S.renderCell(rom, cell, set, { loaded: sets[set].loaded, bank });
    const out = outFile ?? path.join(outDir, `cell${String(cell).padStart(3, '0')}_set${set}.png`);
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    writeRGBAPNG(out, img.pixels, img.width, img.height);
    const cov = S.coverage(pattern, sets[set].loaded, sets[set].have);
    console.log(`cell ${cell} on set ${set}: ${img.width}x${img.height}, `
        + `${Math.round(cov * 100)}% of its tiles uploaded`
        + `${S.isEmpty(img) ? ', paints nothing' : ''}`);
    console.log(`wrote ${out}`);
    process.exit(0);
}

/* ---- a dump -------------------------------------------------------------- */

fs.mkdirSync(outDir, { recursive: true });
const index = ['cell,set,width,height,file'];
const seen = new Set();
let wrote = 0, empty = 0, unpaired = 0;

const targets = cellArg !== null
    ? cells.filter((p) => p.cell === Number(cellArg))
    : cells;
if (cellArg !== null && !targets.length) {
    console.error(`cell ${cellArg} is not a picture`);
    process.exit(2);
}

for (const pattern of targets) {
    /* Which sets to try: the ones that fit, or — asked for the brute force —
     * all of them, which is what the pairing is measured against. */
    let candidates = fits(pattern);
    if (!candidates.length) unpaired++;
    if (loose) candidates = sets.map((s, i) => (s ? i : -1)).filter((i) => i >= 0);
    else if (!everySet && cellArg === null) candidates = candidates.slice(0, 1);

    for (const set of candidates) {
        const img = S.renderCell(rom, pattern.cell, set, { loaded: sets[set].loaded, bank });
        if (S.isEmpty(img)) { empty++; continue; }

        /* Overlapping sets often draw a picture identically; one file each. */
        const digest = createHash('sha256').update(img.pixels).digest('hex');
        const key = `${pattern.cell}:${digest}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const name = `cell${String(pattern.cell).padStart(3, '0')}_set${set}.png`;
        writeRGBAPNG(path.join(outDir, name), img.pixels, img.width, img.height);
        index.push(`${pattern.cell},${set},${img.width},${img.height},${name}`);
        wrote++;
    }
    if (targets.length > 50 && pattern.cell % 100 === 0) {
        console.log(`  cell ${pattern.cell} of ${targets[targets.length - 1].cell} — ${wrote} written`);
    }
}

fs.writeFileSync(path.join(outDir, 'index.csv'), index.join('\n') + '\n');
console.log(`${wrote} PNGs from ${targets.length} pictures into ${outDir}/`);
if (empty) console.log(`  ${empty} cell/set pairs painted nothing and were skipped`);
if (unpaired) console.log(`  ${unpaired} pictures have no set holding every tile they name`);
