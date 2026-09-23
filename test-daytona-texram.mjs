/*
 * test-daytona-texram.mjs — the explorer's Daytona USA texture RAM against the
 * board's.
 *
 * Daytona's sheets are raw in the data ROM and dealt into texture RAM by a
 * routine of the game's own (js/texture.js, uploadDaytonaBank): the first
 * 0x60000 halfwords of a bank straight into one sheet, and nine mip levels
 * after that shared between the two, a run at a time. The shares are where a
 * port can go wrong without anything looking wrong up close, since a mip level
 * is only ever sampled at a distance — the first level was dealt onto the
 * wrong sheet for every course until this check existed, and the only symptom
 * was a distant tree showing a shrunken piece of some other texture.
 *
 * What it measures against is texture RAM captured out of MAME running the
 * game (mame-daytona-texram.lua), one capture per course, held here only as
 * SHA-256 digests per sheet region — daytona-texram-ref.json — the way
 * texram-ref.json holds Sonic The Fighters'. A region is the full-size rows,
 * 0..767, or one mip level's rows, so a failure says which level is wrong.
 *
 *   node test-daytona-texram.mjs                          daytona.zip, Revision A
 *   node test-daytona-texram.mjs --rom a.zip --rom b.zip --as daytona93
 *   node test-daytona-texram.mjs --make --as daytona <capture dir>...
 *
 * `--make` reads captures named daytona_*_c<course>_sheet{0,1}.bin, as the
 * Lua script writes them, and puts their digests under the build in the
 * manifest. With no ROM to hand the check says so and skips.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const SITE = process.env.STF_SITE
    ? pathToFileURL(path.resolve(process.env.STF_SITE) + '/js/').href
    : new URL('./vendor/noclip/js/', import.meta.url).href;

const REF = new URL('./daytona-texram-ref.json', import.meta.url);
const argv = process.argv.slice(2);
const MAKE = argv.includes('--make');
const AS = argv.includes('--as') ? argv[argv.indexOf('--as') + 1] : null;
const ROMS = argv.filter((a, i) => argv[i - 1] === '--rom');

/* The rows of a sheet the upload fills, by what fills them: 1024 rows of
 * 0x400 bytes, the full-size half and then the nine mip levels. */
const ROW = 0x400;
const LEVEL_ROWS = [0x80, 0x40, 0x20, 0x10, 8, 4, 2, 1, 1];
const REGIONS = (() => {
    const out = [['full', 0, 0x300]];
    let row = 0x300;
    LEVEL_ROWS.forEach((n, i) => { out.push([`mip${i + 1}`, row, row + n]); row += n; });
    return out;
})();
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const digest = (sheet) => Object.fromEntries(REGIONS.map(([k, a, b]) => [k, sha(sheet.subarray(a * ROW, b * ROW))]));

if (MAKE) {
    if (!AS) { console.error('--make needs --as <build>'); process.exit(2); }
    const dirs = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--as' && argv[i - 1] !== '--rom');
    const ref = fs.existsSync(REF) ? JSON.parse(fs.readFileSync(REF, 'utf8')) : {};
    ref.source ??= 'texture RAM captured from MAME running the game (mame-daytona-texram.lua), '
        + 'one capture per course; SHA-256 per sheet region';
    ref.builds ??= {};
    ref.builds[AS] ??= {};
    for (const dir of dirs) {
        for (const f of fs.readdirSync(dir)) {
            const m = f.match(/^daytona_\d+_f\d+_c(\d+)_sheet0\.bin$/);
            if (!m) continue;
            const sheets = [0, 1].map((s) => fs.readFileSync(path.join(dir, f.replace('_sheet0', `_sheet${s}`))));
            ref.builds[AS][m[1]] = { sheet0: digest(sheets[0]), sheet1: digest(sheets[1]) };
            console.log(`${AS} course ${m[1]}: ${f}`);
        }
    }
    fs.writeFileSync(REF, JSON.stringify(ref, null, 2) + '\n');
    process.exit(0);
}

const zips = ROMS.length ? ROMS : ['daytona.zip'];
if (zips.some((z) => !fs.existsSync(z))) {
    console.log(`skip: ${zips.filter((z) => !fs.existsSync(z)).join(', ')} not here`);
    process.exit(0);
}
const { loadRomSet } = await import(SITE + 'romset.js');
const { buildTexram } = await import(SITE + 'texture.js');
const read = (p) => { const b = fs.readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const rom = await loadRomSet(zips.map(read), () => {}, AS ? { game: AS } : {});
const id = rom.game.id;
const ref = JSON.parse(fs.readFileSync(REF, 'utf8'));
const want = ref.builds?.[id];
if (!want) { console.log(`skip: no capture of ${id} in the manifest`); process.exit(0); }

let bad = 0, checked = 0;
for (const [course, sheets] of Object.entries(want)) {
    const t = buildTexram(rom, [+course]);
    const got = { sheet0: digest(t.sheet0), sheet1: digest(t.sheet1) };
    const wrong = [];
    for (const s of ['sheet0', 'sheet1']) {
        for (const [k] of REGIONS) {
            checked++;
            if (got[s][k] !== sheets[s][k]) wrong.push(`${s} ${k}`);
        }
    }
    bad += wrong.length;
    console.log(`${id} course ${course}: ${wrong.length ? `FAIL — ${wrong.join(', ')}` : 'both sheets match the board, full size and all nine mip levels'}`);
}
console.log(bad ? `\n${bad} of ${checked} regions differ` : `\nall ${checked} regions match`);
process.exit(bad ? 1 : 0);
