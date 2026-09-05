/* Split a ROM set into the board's regions, as files.
 *
 * A Model 2 board reads 32-bit words out of pairs of 16-bit EPROMs, so every
 * region on it is two chips interleaved a halfword at a time — MAME's
 * `ROM_LOAD32_WORD`, and the same thing the decompilation's `data_extract.py`
 * calls interleaving and its Makefile calls splitting, going the other way.
 * `vendor/noclip/js/romset.js` already does the join, because nothing in this
 * repository can read a byte of the game without it; this is that written out,
 * so the regions can be handed to a tool that wants files rather than a module.
 *
 *   node extract-rom.mjs                          # the five regions, into the temp dir
 *   node extract-rom.mjs --list                   # the regions and their sizes, nothing written
 *   node extract-rom.mjs --out ../stfdecomp/rom   # where the decompilation looks for them
 *   node extract-rom.mjs --region rom_code1.bin   # just one
 *   node extract-rom.mjs --rom sfight.zip --rom schamp.zip
 *   node extract-rom.mjs --cpres --out ../stfdecomp/src/include
 *   node extract-rom.mjs --split rom_code1.bin    # back into the two EPROMs it was built from
 *
 * The names are the decompilation's, since they are what its `rom` folder and
 * its Makefile expect: `rom_code1.bin` is the program ROM, `rom_data.bin` the
 * model and palette data, `rom_ep.bin` the megabyte the 0x06000000 window
 * mirrors, `rom_pol.bin` the polygon ROM and `rom_tex.bin` the texture ROM.
 *
 * Which chips make up which region is not restated here. `romset.js` carries
 * that table because the explorer cannot run without it, and a second copy is a
 * second thing to be wrong: every region below is a slice of what it assembles,
 * and its own CRC-32 check over each member is what this refuses to write past.
 *
 * `--cpres` cuts the two DSP coprocessor executables out of the program ROM.
 * They are the SHARC's, not the i960's, so each comes out three ways: the `.S`
 * of bytes the decompilation links, the raw blob in the ROM's own word order,
 * and `_be.bin` — the same 48-bit words big end first, which is the order a
 * SHARC linker writes and so the form the disassembly's own build has to come
 * out as. test-cpres.mjs is the check that holds one against the other.
 *
 * `--split` is the inverse — a region back into the two chips, which is what
 * the decompilation's Makefile does to a linked program ROM before checking it
 * against the real EPROMs. It prints each half's CRC-32 and MD5, the two forms
 * that check is stated in.
 *
 * Writes to a temp directory rather than into the checkout, like
 * extract-texram.mjs: this is the game's own data and none of it belongs here.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadRomSet } from './vendor/noclip/js/romset.js';
import { BLOBS, pmSwap } from './cpres.mjs';

const ROM_DIR = path.join(os.tmpdir(), 'stf-rom');

/* The regions, as slices of what romset.js assembles. A region's length is left
 * to the buffer it is cut from, so a recipe changing there changes it here. */
const REGIONS = [
    { file: 'rom_code1.bin', region: 'maincpu', start: 0x0000000, end: null,
      what: 'program ROM' },
    { file: 'rom_data.bin', region: 'mainData', start: 0x0000000, end: 0x1000000,
      what: 'model table, motion data and the face palette' },
    { file: 'rom_ep.bin', region: 'mainData', start: 0x1000000, end: 0x1100000,
      what: 'the megabyte the 0x06000000 window mirrors' },
    { file: 'rom_pol.bin', region: 'polygons', start: 0x0000000, end: null,
      what: 'polygon ROM' },
    { file: 'rom_tex.bin', region: 'textures', start: 0x0000000, end: null,
      what: 'texture ROM' },
];

/* Where the two DSP coprocessor executables are and what they are is
 * `cpres.mjs`'s, since test-cpres.mjs measures the same two blobs and a second
 * copy is a second thing to be wrong. */
const CPRES_BYTES_PER_LINE = 16;

const args = (name) => process.argv
    .flatMap((a, i) => (a === `--${name}` && process.argv[i + 1] !== undefined ? [process.argv[i + 1]] : []));
const arg = (name, dflt) => args(name)[0] ?? dflt;
const flag = (name) => process.argv.includes(`--${name}`);

const romPaths = args('rom');
if (!romPaths.length) romPaths.push(process.env.STF_ROM || 'sfight.zip');
const outDir = arg('out', ROM_DIR);
const regionArg = arg('region', null);
const splitArg = arg('split', null);
const cpres = flag('cpres');
const list = flag('list');
const force = flag('force');

const md5 = (b) => createHash('md5').update(b).digest('hex');

/* The CRC-32 the zip directory and MAME both state a chip in. */
function crc32(bytes) {
    const table = [];
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0);
        table[i] = c >>> 0;
    }
    let c = 0xffffffff;
    for (const b of bytes) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

/* ---- a region back into the two chips it was built from ------------------ */

/**
 * The inverse of ROM_LOAD32_WORD: every 32-bit word is the low chip's halfword
 * followed by the high chip's, so a region unzips into two halves of its length.
 */
export function splitRegion(bytes) {
    const half = bytes.length >> 1;
    const lo = new Uint8Array(half);
    const hi = new Uint8Array(half);
    for (let i = 0; i < half; i += 2) {
        const d = i * 2;
        lo[i] = bytes[d]; lo[i + 1] = bytes[d + 1];
        hi[i] = bytes[d + 2]; hi[i + 1] = bytes[d + 3];
    }
    return { lo, hi };
}

if (splitArg !== null) {
    if (!fs.existsSync(splitArg)) {
        console.error(`no region file at ${splitArg}`);
        process.exit(2);
    }
    const bytes = fs.readFileSync(splitArg);
    if (bytes.length % 4) {
        console.error(`${splitArg} is ${bytes.length} bytes, which is not whole 32-bit words`);
        process.exit(2);
    }
    const { lo, hi } = splitRegion(bytes);
    fs.mkdirSync(outDir, { recursive: true });
    /* `.bin.00` and `.bin.01` are what the decompilation's Makefile renames to
     * the EPROMs' own names, and what its .gitignore already refuses. */
    const base = path.basename(splitArg);
    for (const [suffix, part] of [['00', lo], ['01', hi]]) {
        const p = path.join(outDir, `${base}.${suffix}`);
        fs.writeFileSync(p, part);
        console.log(`${base}.${suffix}  ${part.length} bytes  crc32 ${crc32(part)}  md5 ${md5(part)}`);
    }
    console.log(`wrote ${outDir}/`);
    process.exit(0);
}

/* ---- the ROM set --------------------------------------------------------- */

for (const p of romPaths) {
    if (!fs.existsSync(p)) {
        console.error(`no ROM set at ${p} — pass --rom <sfight.zip>, or set STF_ROM`);
        process.exit(2);
    }
}
const buffers = romPaths.map((p) => {
    const b = fs.readFileSync(p);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
});
const rom = await loadRomSet(buffers);

/* romset.js checks every member it reads against the CRC-32 the recipe carries
 * and collects the ones that disagree. A ROM set that fails that is not the one
 * anything here is written against, so nothing is written from it. */
if (rom.warnings.length) {
    for (const w of rom.warnings) console.error(`checksum failed: ${w}`);
    if (!force) {
        console.error(`${rom.warnings.length} member(s) failed — pass --force to write anyway`);
        process.exit(1);
    }
    console.error('--force given; writing from a ROM set that does not check out');
} else {
    console.log(`${romPaths.map((p) => path.basename(p)).join(', ')}: every member's CRC-32 matched`);
}

const slice = (r) => rom[r.region].subarray(r.start, r.end ?? rom[r.region].length);

if (list) {
    console.log('file           bytes      region     what');
    for (const r of REGIONS) {
        console.log(`${r.file.padEnd(14)} ${String(slice(r).length).padStart(9)}  `
            + `${r.region.padEnd(9)}  ${r.what}`);
    }
    for (const c of BLOBS) {
        console.log(`${`${c.name}.S`.padEnd(14)} ${String(c.length).padStart(9)}  maincpu    `
            + `DSP coprocessor executable at 0x${c.offset.toString(16)}, as ${c.symbol}`);
        console.log(`${`${c.name}.bin`.padEnd(14)} ${String(c.length).padStart(9)}  maincpu    `
            + `  the same bytes raw, in the ROM's own word order`);
        console.log(`${`${c.name}_be.bin`.padEnd(14)} ${String(c.length).padStart(9)}  maincpu    `
            + `  and as the SHARC linker writes it, big end of the word first`);
    }
    process.exit(0);
}

fs.mkdirSync(outDir, { recursive: true });

/* ---- the DSP coprocessor executables ------------------------------------- */

/** One blob as an i960 assembler `.byte` array, the form the decompilation links. */
export function assemblyData(bytes, symbol, bytesPerLine = CPRES_BYTES_PER_LINE) {
    const out = ['\t.data', `\t.global ${symbol}`, `${symbol}:`];
    for (let i = 0; i < bytes.length; i += bytesPerLine) {
        const line = [...bytes.subarray(i, i + bytesPerLine)]
            .map((b) => `0x${b.toString(16).padStart(2, '0')}`);
        out.push(`\t.byte ${line.join(', ')}`);
    }
    return out.join('\n') + '\n';
}

if (cpres) {
    for (const c of BLOBS) {
        const bytes = rom.maincpu.subarray(c.offset, c.offset + c.length);
        if (bytes.length < c.length) {
            console.error(`${c.name}: the program ROM ends before 0x${(c.offset + c.length).toString(16)}`);
            process.exit(1);
        }
        /* Three renderings of one blob, under the names the decompilation's
         * `src/include` already holds them by: the `.S` it links, the raw
         * bytes in the ROM's own order, and the same words the other way
         * round — which is the order a SHARC linker writes, and so the form
         * test-cpres.mjs holds a freshly assembled image against. */
        const write = (file, data) => {
            fs.writeFileSync(path.join(outDir, file), data);
            console.log(`${file.padEnd(14)} ${String(c.length).padStart(6)} bytes`
                + `  md5 ${md5(data)}`);
        };
        write(`${c.name}.S`, assemblyData(bytes, c.symbol));
        write(`${c.name}.bin`, bytes);
        write(`${c.name}_be.bin`, pmSwap(bytes));
    }
    console.log(`wrote ${outDir}/`);
    process.exit(0);
}

/* ---- the regions --------------------------------------------------------- */

const targets = regionArg === null ? REGIONS : REGIONS.filter((r) => r.file === regionArg);
if (!targets.length) {
    console.error(`--region must be one of ${REGIONS.map((r) => r.file).join(', ')}`);
    process.exit(2);
}

for (const r of targets) {
    const bytes = slice(r);
    fs.writeFileSync(path.join(outDir, r.file), bytes);
    console.log(`${r.file.padEnd(14)} ${String(bytes.length).padStart(9)} bytes  ${r.what}`);
}
console.log(`wrote ${outDir}/`);
