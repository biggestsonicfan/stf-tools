/* The slices the texture-RAM and colour-table checks measure against.
 *
 * Those two checks used to hold `js/texture.js` and `js/colors.js` against a
 * MAME capture carried in the tree: 2.2 MB of the board's own texture RAM.
 * That is the game's data, and it does not belong here. What the checks
 * actually need from it is not the bytes but the statement "the board held
 * exactly these bytes", and a digest makes that statement in 32.
 *
 * So `texram-ref.json` holds SHA-256 over the capture, cut at the granularity
 * the checks compare at, and the checks hash their own build and compare. The
 * assertion is unchanged — a single wrong texel still fails — and the file is
 * a few kB of hashes that cannot be turned back into anything. The capture
 * itself is regenerated with `extract-texram.mjs` when it is wanted, and
 * stays untracked.
 *
 * Everything here is deliberately in one place: `make-texref.mjs` writes the
 * manifest with these functions and the checks read it with the same ones, so
 * the two can never drift into hashing different slices.
 */
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

/* A sheet is hashed whole and again in 64 kB blocks. The whole digest is the
 * check; the blocks only say where a failure is, which is the one thing a
 * digest otherwise takes away. 64 bits is far more than enough to point at a
 * block, so they are truncated to keep the manifest small. */
export const BLOCK_BYTES = 0x10000;
const BLOCK_HEX = 16;

const CXLAT_CHANNEL = 0x4000;
const CXLAT_CHANNELS = 3;
const CXLAT_LUMA = 256;

export const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function sheetDigest(bytes) {
    const blocks = [];
    for (let o = 0; o < bytes.length; o += BLOCK_BYTES) {
        blocks.push(sha(bytes.subarray(o, o + BLOCK_BYTES)).slice(0, BLOCK_HEX));
    }
    return { whole: sha(bytes), blocks };
}

/** Which 64 kB blocks of a sheet disagree with the manifest's, for reporting. */
export function badBlocks(bytes, ref) {
    const ours = sheetDigest(bytes).blocks;
    const out = [];
    for (let i = 0; i < ours.length; i++) if (ours[i] !== ref.blocks[i]) out.push(i);
    return out;
}

/* colorxlat is three channels of 32 rows of 256 sixteen-bit entries, and the
 * colour check compares it row by row rather than whole: some rows are a
 * character's, some are the stage's, and two are rotating while the capture is
 * taken. So a row is hashed across all three channels at once — that is the
 * unit every one of those comparisons is made in.
 *
 * @param {Uint8Array} a      the table
 * @param {number} row        palette row, 0..31
 * @param {number} luma0      first luma slot, inclusive
 * @param {number} luma1      last luma slot, exclusive
 * @param {?number[]} skip    a [from, to) band left out of the digest
 */
export function cxlatRowBytes(a, row, luma0 = 0, luma1 = CXLAT_LUMA, skip = null) {
    const out = [];
    for (let ch = 0; ch < CXLAT_CHANNELS; ch++) {
        for (let luma = luma0; luma < luma1; luma++) {
            if (skip && luma >= skip[0] && luma < skip[1]) continue;
            const o = ch * CXLAT_CHANNEL + (row * CXLAT_LUMA + luma) * 2;
            out.push(a[o], a[o + 1]);
        }
    }
    return Uint8Array.from(out);
}

export const cxlatRowDigest = (a, row, luma0, luma1, skip) =>
    sha(cxlatRowBytes(a, row, luma0, luma1, skip));

/* Where the rebuilt binaries go by default. Deliberately outside the checkout:
 * they are the game's data, and nothing that writes 2.2 MB of it should put it
 * somewhere a stray `git add -A` can sweep up. Pass --out to override. */
export const TEXRAM_DIR = path.join(os.tmpdir(), 'stf-texram');

/* Written beside anything extract-texram.mjs produces. Those files are
 * the port own output, so a manifest built from them would be the port
 * measuring itself; make-texref.mjs refuses a directory carrying this. */
export const PROVENANCE = 'PROVENANCE.txt';
