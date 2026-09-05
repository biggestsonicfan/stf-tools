/*
 * test-csum.mjs — the board's own ROM checksum, against the ROM.
 *
 * This is the one check whose reference the game carries itself. The self-test
 * sums each ROM chip at boot and compares the total against a word burnt beside
 * it, so a correct port has to arrive at eight numbers that were computed by
 * Sega's mastering tools and have been sitting in the ROM ever since. Nothing
 * here is a capture, and nothing here is an argument: either the sums come out
 * or they do not.
 *
 * Nothing is given the routine's address. It is found by scanning the program
 * ROM for the four instructions it opens with, and the table it is driven from
 * by the one `call` that reaches it; the port's constants then have to be the
 * operands the routine and its caller carry:
 *
 *   - two bytes added and four stepped, which is what makes it a chip's sum
 *     rather than a region's, from the two `ldob` and the `addo 4`;
 *   - the halved count, from the `shro 1`;
 *   - the halfword the alignment argument starts on, from the `addo 2`;
 *   - the word address the skips are compared against, from the `clrbit 1`;
 *   - the 16 bits the total is cut to, from the `lda 0xffff` and the `and`;
 *   - the table's address, its stride and how many records it holds, from the
 *     caller's `ldq`, its `addo` and the count it opens with.
 *
 * Then the table has to be what the port assumes: every record addressable,
 * every span inside the region it names, every alignment one of the two halves,
 * and the two words the routine steps over exactly the two records that sum the
 * ROM those words are burnt in — a checksum cannot cover itself.
 *
 * Then the measurement: all eight sums, against all eight burnt words.
 *
 *   node test-csum.mjs [rom.zip]
 */

import fs from 'fs';
import { loadRomSet } from './vendor/noclip/js/romset.js';
import { disasm } from './i960dis.mjs';
import * as C from './csum.mjs';

const ROM = process.argv[2] ?? 'sfight.zip';
const read = (p) => {
    const b = fs.readFileSync(p);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const rom = await loadRomSet([read(ROM)]);
const dv = rom.mainCpuView;

let bad = 0;
const fail = (msg) => { console.log(`FAIL: ${msg}`); bad++; };

/** `count` instructions from `addr`, as text. */
function listing(addr, count) {
    const out = [];
    let a = addr;
    for (let i = 0; i < count; i++) {
        const d = disasm(dv, a);
        out.push({ addr: a, text: d.text, target: d.target, len: d.len });
        a += d.len;
    }
    return out;
}

const has = (lines, re) => lines.some((l) => re.test(l.text));
const find = (lines, re) => {
    for (const l of lines) {
        const m = l.text.match(re);
        if (m) return m;
    }
    return null;
};
const hex = (n) => `0x${n.toString(16)}`;

/* ---- 1. finding the routine ---------------------------------------------- */

/* It opens by taking its three arguments and the two words it must step over:
 *
 *     mov g0, 0, r3            ; start
 *     mov g1, 0, r4            ; length
 *     lda 0x59038, r9          ; <- what is scanned for, as a shape
 *     lda 0x59050, r10
 *
 * so the routine's address and both skips come out of the scan rather than
 * being written down here.
 */
const found = [];
for (let a = 0; a + 32 <= rom.maincpu.length; a += 4) {
    if (disasm(dv, a).text !== 'mov g0, 0, r3') continue;
    if (disasm(dv, a + 4).text !== 'mov g1, 0, r4') continue;
    const first = disasm(dv, a + 8);
    const second = disasm(dv, a + 8 + first.len);
    const m1 = first.text.match(/^lda 0x([0-9a-f]+), r9$/);
    const m2 = second.text.match(/^lda 0x([0-9a-f]+), r10$/);
    if (m1 && m2) found.push({ addr: a, skip: [parseInt(m1[1], 16), parseInt(m2[1], 16)] });
}

if (found.length !== 1) {
    fail(`expected one routine opening with the checksum's four instructions, found ${found.length}`);
    console.log(bad ? `\n${bad} failed` : '\nall good');
    process.exit(1);
}
const routine = found[0];
console.log(`rom_checksum found at ${hex(routine.addr)}, stepping over `
    + `${routine.skip.map(hex).join(' and ')}`);

if (routine.addr !== C.CSUM_ROUTINE) {
    fail(`the routine is at ${hex(routine.addr)}, csum.mjs carries ${hex(C.CSUM_ROUTINE)}`);
}
if (routine.skip.join() !== C.CSUM_SKIP.join()) {
    fail(`the routine steps over ${routine.skip.map(hex).join(', ')}, csum.mjs carries `
        + `${C.CSUM_SKIP.map(hex).join(', ')}`);
}

/* ---- 2. the operands the port carries ------------------------------------ */

const body = listing(routine.addr, 24);

/* The mask, and that it is what the total is cut by before the `ret`. */
const mask = find(body, /^lda 0x([0-9a-f]+), r5$/);
if (!mask || parseInt(mask[1], 16) !== C.CSUM_MASK) {
    fail(`the routine's mask is ${mask ? '0x' + mask[1] : 'not loaded'}, csum.mjs carries `
        + hex(C.CSUM_MASK));
}
if (!has(body, /^and r5, g0, g0$/)) {
    fail('the routine does not mask its total with the value it loaded');
}

/* A non-zero alignment starts one halfword in — which is the other chip. */
const align = find(body, /^addo (\d+), r3, r3$/);
if (!align || Number(align[1]) !== 2) {
    fail(`the alignment offset is ${align ? align[1] : 'absent'}, and the port assumes 2`);
}
if (!has(body, /^cmpobe 0, g2, /)) {
    fail('the routine does not branch on g2, so the port has the alignment argument wrong');
}

/* The count is in bytes and two are added a step, so it is halved. */
if (!has(body, /^shro 1, r4, r4$/)) {
    fail('the routine does not halve its length, so the port has the count wrong');
}

/* Two bytes read, and the second one byte on. */
const reads = body.filter((l) => /^ldob /.test(l.text)).map((l) => l.text);
if (reads.length !== 2 || !/\(r3\)/.test(reads[0]) || !/0x1\(r3\)/.test(reads[1])) {
    fail(`the routine reads ${reads.length} bytes a step (${reads.join('; ')}), and the `
        + 'port adds the two at r3 and r3+1');
}

/* Four stepped, which is one 32-bit word: the other chip's two bytes are what
 * lies between them, and this is why a chip's sum is not a region's. */
const strides = body.filter((l) => /^addo \d+, r3, r3$/.test(l.text))
    .map((l) => Number(l.text.match(/^addo (\d+),/)[1]));
if (!strides.includes(4)) {
    fail(`the routine steps ${strides.join(', ')} a time, and the port steps 4`);
}

/* The skips are word addresses, and the high chip's pointer is two into one. */
const clr = find(body, /^clrbit (\d+), r3, r\d+$/);
if (!clr || Number(clr[1]) !== 1) {
    fail(`the skip compares on ${clr ? `clrbit ${clr[1]}` : 'no clrbit'}, and the port `
        + 'clears bit 1 to get the word address');
}
if (body.filter((l) => /^cmpobe r(9|10), r\d+, /.test(l.text)).length !== 2) {
    fail('the routine does not compare that address against both skips');
}

/* ---- 3. the table -------------------------------------------------------- */

/* The one `call` that reaches the routine is the self-test's loop. Its `ldq`
 * names the table, its `addo` gives the stride and the `mov` it opens with the
 * number of records — none of which is written down in csum.mjs untested.
 */
const callers = [];
for (let a = 0; a + 4 <= rom.maincpu.length; a += 4) {
    const d = disasm(dv, a);
    if (d.top === 0x09 && d.target === routine.addr) callers.push(a);
}
if (callers.length !== 1) {
    fail(`expected one caller of the checksum routine, found ${callers.length}`);
}

if (callers.length === 1) {
    /* The loop opens a few instructions before the `ldq` that feeds the call. */
    const loop = listing(callers[0] - 0x10, 20);
    const load = find(loop, /^ldq 0x([0-9a-f]+)\[r\d+\*1\], g0$/);
    const count = find(loop, /^mov (\d+), 0, r4$/);
    const step = find(loop, /^addo (\d+), r5, r5$/);

    if (!load) {
        fail('the caller does not load four words of a table into g0, so the record '
            + 'layout the port assumes is not the one it reads');
    } else {
        const table = parseInt(load[1], 16);
        console.log(`driven from a table at ${hex(table)}`);
        if (table !== C.CSUM_TABLE) {
            fail(`the table is at ${hex(table)}, csum.mjs carries ${hex(C.CSUM_TABLE)}`);
        }
    }
    /* `cmpdeci 0, r4, r4; bl` runs the body once more than the count it opens
     * with, which is the i960's loop idiom. */
    if (!count || Number(count[1]) + 1 !== C.CSUM_ENTRIES) {
        fail(`the caller runs ${count ? Number(count[1]) + 1 : 'an unread number of'} `
            + `records, csum.mjs carries ${C.CSUM_ENTRIES}`);
    }
    if (!step || Number(step[1]) !== C.CSUM_ENTRY_BYTES) {
        fail(`a record is ${step ? step[1] : 'an unread number of'} bytes, csum.mjs `
            + `carries ${C.CSUM_ENTRY_BYTES}`);
    }
    /* The result is compared against the record's fourth word, which is what
     * makes +0x0C the expected checksum rather than any other field. */
    if (!has(listing(callers[0] + 4, 2), /^cmpobe g3, g0, /)) {
        fail('the caller does not compare the sum against the record\'s fourth word');
    }
}

/* ---- 4. the records ------------------------------------------------------ */

const entries = C.readCsumTable(rom);
for (const e of entries) {
    const region = C.regionFor(rom, e.start);
    if (!region) {
        fail(`record ${e.index} sums ${hex(e.start)}, which is not a ROM the port maps`);
        continue;
    }
    const off = e.start - region.base;
    if (off < 0 || off + e.length * 2 > region.bytes.length) {
        fail(`record ${e.index} runs ${hex(e.length * 2)} from ${hex(e.start)}, past the `
            + `end of ${region.region}`);
    }
    if (e.alignment !== 0 && e.alignment !== 1) {
        fail(`record ${e.index} has alignment ${e.alignment}, and a region has two halves`);
    }
    if (e.expected > 0xffff) {
        fail(`record ${e.index} expects ${hex(e.expected)}, which does not fit the mask`);
    }
    if (e.length % 2) {
        fail(`record ${e.index} is ${hex(e.length)} bytes, which is not whole halfwords`);
    }
}

/* Every record is one half of a region, so they come in pairs that name the
 * same span and differ only in which chip they read. */
for (let i = 0; i < entries.length; i += 2) {
    const [lo, hi] = [entries[i], entries[i + 1]];
    if (lo.start !== hi.start || lo.length !== hi.length
        || lo.alignment !== 0 || hi.alignment !== 1) {
        fail(`records ${i} and ${i + 1} are not the two chips of one region`);
    }
}

/* The skipped words are the two records that sum the ROM those words are in:
 * a checksum cannot be inside the sum that produces it, and the other six are
 * not skipped because they were known before that ROM was burnt. */
const selfSumming = entries.filter((e) => {
    const region = C.regionFor(rom, e.start);
    return region && region.region === 'maincpu';
});
const skipped = selfSumming.map((e) => e.expectedAt).sort((a, b) => a - b);
if (skipped.join() !== [...routine.skip].sort((a, b) => a - b).join()) {
    fail(`the routine steps over ${routine.skip.map(hex).join(', ')}, and the records that `
        + `sum the program ROM keep their checksums at ${skipped.map(hex).join(', ')}`);
} else {
    console.log(`the two words it steps over are records ${selfSumming.map((e) => e.index).join(' and ')}`
        + "'s own checksums, which sum the ROM they are burnt in");
}

/* ---- 5. the sums --------------------------------------------------------- */

console.log('\n#  region    start       chip bytes  align  expected  actual');
for (const e of entries) {
    const r = C.checkCsumEntry(rom, e, routine.skip);
    const actual = r.actual === null ? '  ----' : `0x${r.actual.toString(16).padStart(4, '0')}`;
    console.log(`${e.index}  ${(r.region ?? '?').padEnd(9)} ${hex(e.start).padEnd(11)} `
        + `${hex(e.length).padEnd(11)} ${e.alignment}      `
        + `0x${e.expected.toString(16).padStart(4, '0')}    ${actual}  ${r.ok ? '' : '  <- MISMATCH'}`);
    if (!r.ok) {
        fail(`record ${e.index} sums to ${actual}, and the ROM says `
            + `0x${e.expected.toString(16).padStart(4, '0')}`);
    }
}

console.log(bad ? `\n${bad} failed` : '\nall good');
process.exit(bad ? 1 : 0);
