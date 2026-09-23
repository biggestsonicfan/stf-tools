/*
 * test-romset.mjs — what the suite is about to measure, before it measures it.
 *
 * Every other check here reads a ROM set through the explorer and reports a
 * number. None of them says where that number came from, and two of those
 * facts decide whether the number means anything at all:
 *
 *   - which explorer. `vendor/noclip` is pinned to a commit so a check is
 *     measured against a known explorer rather than against whatever `master`
 *     happens to be, and a run that does not name the commit cannot be held
 *     against a later one.
 *   - which ROM set. `loadRomSet` CRC-checks every member it assembles against
 *     the numbers in `js/games.js` and collects the failures in `rom.warnings`
 *     — and then nothing reads them. A set that is not the one the explorer was
 *     written against still loads, still decodes and still produces numbers;
 *     they are simply about a different pile of bytes.
 *
 * That last one is not hypothetical. A House of the Dead set to hand here has
 * all twenty-four of its members mismatched, and `test-decode.mjs` reported
 * "decoded all: 799 ok" over it without complaint.
 *
 * So this runs first and says both, and fails rather than letting fourteen
 * checks measure a set nobody vouched for. `--force` downgrades a mismatch to a
 * warning, the same escape `extract-rom.mjs` gives.
 *
 *   node test-romset.mjs [rom.zip] [--force]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRomSet } from './vendor/noclip/js/romset.js';

const argv = process.argv.slice(2);
const force = argv.includes('--force');
/* Several paths, because a set is not always one archive — MAME splits Daytona
 * USA's 1993 version between the clone and its parent, and loadRomSet looks a
 * member up across every zip it is handed. */
const ROMS = argv.filter((a) => !a.startsWith('--'));
if (!ROMS.length) ROMS.push('sfight.zip');
const ROM = ROMS.join(' + ');

let bad = 0;
const fail = (msg) => { console.log(`FAIL: ${msg}`); bad++; };

/* ---- the explorer -------------------------------------------------------- */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOCLIP = path.join(HERE, 'vendor', 'noclip');

/* The submodule's HEAD, read off the git files rather than by running git, so a
 * check does not need one on PATH. A submodule's `.git` is a file pointing at
 * the superproject's module directory. */
function noclipVersion() {
    try {
        const dot = path.join(NOCLIP, '.git');
        const head = fs.readFileSync(dot, 'utf8').trim();
        const dir = head.startsWith('gitdir:') ? path.resolve(NOCLIP, head.slice(7).trim()) : dot;
        const ref = fs.readFileSync(path.join(dir, 'HEAD'), 'utf8').trim();
        if (!ref.startsWith('ref:')) return ref.slice(0, 12);
        return fs.readFileSync(path.join(dir, ref.slice(4).trim()), 'utf8').trim().slice(0, 12);
    } catch { return 'unknown'; }
}

if (!fs.existsSync(path.join(NOCLIP, 'js', 'romset.js'))) {
    console.error('vendor/noclip is empty — run `git submodule update --init`');
    process.exit(1);
}
console.log(`explorer     vendor/noclip at ${noclipVersion()}`);

/* ---- the set ------------------------------------------------------------- */

for (const r of ROMS) {
    if (!fs.existsSync(r)) {
        console.error(`no ROM set at ${r} — every check here wants one beside it`);
        process.exit(1);
    }
}

const read = (p) => {
    const b = fs.readFileSync(p);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

let rom;
try {
    rom = await loadRomSet(ROMS.map(read));
} catch (e) {
    console.error(`${ROM}: ${e.message}`);
    process.exit(1);
}

console.log(`rom set      ${ROM} — ${rom.game.name} (${rom.game.id})`);

/* ---- every member the explorer asked for, against its burnt CRC ---------- */

/* `loadRomSet` splits its complaints between three shapes: a CRC that did not
 * match, a member whose label in this set is not the one the recipe names but
 * whose checksum is, and a region it left null because the set does not carry
 * its chips. Only the first is a failure. The second is how a set spelling its
 * chips the way an older MAME did still loads, and saying which member was
 * taken for which is the whole point of reporting it; the third is allowed by
 * design — `optional: true` is there so a set without the coprocessor's data
 * ROM still opens. */
const crc = rom.warnings.filter((w) => w.includes('CRC'));
const spelled = rom.warnings.filter((w) => w.includes('this set spells it'));
const absent = rom.warnings.filter((w) => !crc.includes(w) && !spelled.includes(w));

for (const w of spelled) console.log(`renamed      ${w}`);
for (const w of absent) console.log(`optional     ${w}`);

if (crc.length) {
    for (const w of crc) console.log(`  ${w}`);
    const msg = `${crc.length} member(s) are not the bytes js/games.js was written against`;
    if (force) console.log(`WARNING: ${msg} — --force given, going on anyway`);
    else fail(`${msg} — every number this suite reports would be about a different set `
        + '(pass --force to measure it anyway)');
} else {
    const members = Object.values(rom.game.regions)
        .reduce((a, r) => a + r.parts.length * 2, 0);
    console.log(`every one of the ${members} members the explorer assembles matches its CRC`);
}

/* ---- and that the regions came out the size the profile declares ---------- */

for (const [key, spec] of Object.entries(rom.game.regions)) {
    const got = rom[key];
    if (got === null) continue;                 /* optional, already reported */
    if (!got) fail(`region ${key} did not assemble`);
    else if (got.length !== spec.size) {
        fail(`region ${key} is ${got.length} bytes, and the profile declares ${spec.size}`);
    }
}

/* The one number every model-side check is bounded by, so a run says it. */
const { count, offset } = rom.game.modelTable;
console.log(`model table  ${count} entries at 0x${offset.toString(16)}`);

console.log(bad ? `\n${bad} failed` : '\nall good');
process.exit(bad ? 1 : 0);
