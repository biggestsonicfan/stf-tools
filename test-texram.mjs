/* Verify the ported unpack routines against a capture of the real hardware.
 *
 * js/texture.js reproduces what the game's own code writes into texture RAM.
 * The capture this measures against was taken from MAME while South Island was
 * on screen, so it is an exact statement of what the board holds for those
 * sets — anything short of a byte-for-byte match is a bug in the port.
 *
 * The capture itself is not in the tree: it is the game's data. What is here
 * is `texram-ref.json`, SHA-256 over it, which makes the same statement in a
 * form that is not the game's bytes and cannot be turned back into them. A
 * single wrong texel still fails. `extract-texram.mjs` rebuilds the
 * binaries from a ROM if you want to look at one, and if a real capture is
 * sitting where it puts them — or in $STF_TEXRAM — this reports the differing
 * bytes as well.
 *
 * Set 16 is listed first because the attract and character-select screens
 * leave it resident: the stage sets overwrite everything except the deepest
 * corner of its mip chain, 96 bytes that are still visible in the capture.
 *
 *   node test-texram.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadRomSet } from './vendor/noclip/js/romset.js';
import { readStageTable } from './vendor/noclip/js/stages.js';
import { buildTexram, SHEET_BYTES } from './vendor/noclip/js/texture.js';
import { sheetDigest, badBlocks, BLOCK_BYTES, TEXRAM_DIR } from './texref.mjs';

const REF = JSON.parse(fs.readFileSync('texram-ref.json', 'utf8'));
const SHEETS = [['texram0', 0], ['texram1', 1]];
const CAPTURE = process.env.STF_TEXRAM || TEXRAM_DIR;

const read = (p) => {
    const b = fs.readFileSync(p);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

const t0 = Date.now();
const rom = await loadRomSet([read('sfight.zip')]);
const t1 = Date.now();
/* Taken from the stage record rather than written down here, so this checks the
 * rule that turns g0/g1 into a set list as well as the unpack itself — and the
 * list it produces has to be the one the capture was taken with. */
const SETS = [16, ...readStageTable(rom)[REF.stage].texSets];
if (SETS.join() !== REF.sets.join()) {
    console.error(`sets [${SETS}] do not match the capture's [${REF.sets}]`);
    process.exit(1);
}
const { sheet0, sheet1, pages } = buildTexram(rom, SETS);
const t2 = Date.now();

let failed = false;
for (const [name, which] of SHEETS) {
    const ours = which === 0 ? sheet0 : sheet1;
    if (ours.length !== SHEET_BYTES) {
        console.error(`${name}: built ${ours.length} bytes, expected ${SHEET_BYTES}`);
        process.exit(2);
    }
    if (sheetDigest(ours).whole === REF[name].whole) continue;

    failed = true;
    const blocks = badBlocks(ours, REF[name]);
    console.log(`${name}: FAIL, ${blocks.length} of ${REF[name].blocks.length} ` +
        `${BLOCK_BYTES / 1024}kB blocks differ, first at ` +
        `0x${(blocks[0] * BLOCK_BYTES).toString(16)}`);

    /* A real capture alongside turns that back into byte offsets. */
    const cap = path.join(CAPTURE, `${name}.bin`);
    if (fs.existsSync(cap)) {
        const ref = new Uint8Array(fs.readFileSync(cap));
        let bad = 0;
        let first = -1;
        for (let i = 0; i < SHEET_BYTES; i++) {
            if (ours[i] !== ref[i]) { if (first < 0) first = i; bad++; }
        }
        console.log(`  against ${cap}: ${bad} bytes differ, first at 0x${first.toString(16)}`);
    }
}

console.log(`sets [${SETS}] -> ${pages} pages, ${t1 - t0}ms rom + ${t2 - t1}ms unpack`);
if (!failed) {
    console.log(`OK: ${2 * SHEET_BYTES} bytes byte-exact against the MAME capture`);
}
process.exit(failed ? 1 : 0);
