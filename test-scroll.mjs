/*
 * test-scroll.mjs — the 2D scroll layer's decoder, against the ROM.
 *
 * There is no capture to measure this one against: the 2D layer is tile RAM,
 * palette RAM and a name table on the board's own tile chip, and nothing in
 * this repository records what they held. So this holds `scroll.mjs` against
 * the two things a ROM set does carry — the instruction stream that fills them
 * and the tables that stream reads — the same standing as the Egg robots'
 * animations in test-motion.mjs, and it is worth being plain that it is a
 * weaker one than a capture.
 *
 * Nothing here is given the routines' addresses. The four scroll walks are
 * found by scanning the program ROM for the instruction that loads the CG
 * table's address, and the pattern blit by the one that indexes the pattern
 * table; the port's constants then have to be the operands those routines
 * carry:
 *
 *   - the set count, from the guard both CG walks open with;
 *   - 32 bytes to a tile, from the tile walk's `shli 4` on a record's count;
 *   - two colours to a word, from the colour walk's `shrdi 1` on its count;
 *   - a tile bank of `g1 << 12` and a palette bank of `g1 << 5`, from the two
 *     `…_Initialize2` variants — the second of which is 16 colours to a bank,
 *     which is the stride the composer reads a colour at;
 *   - the palette field's position in a tilemap entry, from the `g1 << 7` the
 *     pattern blit adds to every entry it writes;
 *   - the name table's row stride, and — the one the port most needs pinned —
 *     which of the record's two dimensions the blit runs in its inner loop,
 *     read off the registers the `ldl` pair loaded;
 *   - the cell count's guard, from the other caller of the pattern table.
 *
 * Then the tables, which have to be what the port assumes they are: every CG
 * set an even index of tiles and an odd one of colours, every upload inside the
 * RAM window it is addressed into, every picture a size the layer can hold, and
 * every tile a picture names one that some set uploads — that last is what
 * extract-scroll.mjs pairs a cell with a set on, and it holds for all 534.
 *
 * Finally every cell is decoded with the set that covers it: none may throw,
 * none may come out empty, and no picture may read a palette bank its set never
 * wrote.
 *
 *   node test-scroll.mjs [rom.zip]
 */

import fs from 'fs';
import { loadRomSet } from './vendor/noclip/js/romset.js';
import { disasm } from './i960dis.mjs';
import * as S from './scroll.mjs';

const ROM = process.argv[2] ?? 'sfight.zip';
const read = (p) => {
    const b = fs.readFileSync(p);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const rom = await loadRomSet([read(ROM)]);
const dv = rom.mainCpuView;

let bad = 0;
const fail = (msg) => { console.log(`FAIL: ${msg}`); bad++; };

/* ---- reading the routines out of the program ROM ------------------------- */

/** Every aligned instruction whose address operand is `value`. */
function sites(value) {
    const out = [];
    for (let a = 0; a + 8 <= rom.maincpu.length; a += 4) {
        const d = disasm(dv, a);
        if (d.target === value) out.push({ addr: a, text: d.text });
    }
    return out;
}

/** `count` instructions from `addr`, as text. */
function listing(addr, count) {
    const out = [];
    let a = addr;
    for (let i = 0; i < count; i++) {
        const d = disasm(dv, a);
        out.push({ addr: a, text: d.text, target: d.target });
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

/* ---- 1. the four scroll walks -------------------------------------------- */

/* Every routine that walks the CG table opens the same way:
 *
 *     shlo 3, 23, r13          ; the set count
 *     cmpoble r13, g0, <ret>
 *     lda 0x6480000, r3        ; <- what is scanned for
 *
 * so a routine starts two instructions before the load, and that is how its
 * address is come by rather than being written down here.
 */
const cgLoads = sites(S.CG_TABLE).filter((s) => /^lda /.test(s.text));
console.log(`CG table 0x${S.CG_TABLE.toString(16)} is loaded at `
    + `${cgLoads.map((s) => '0x' + s.addr.toString(16)).join(', ') || 'nowhere'}`);
if (cgLoads.length !== 4) {
    fail(`expected the four scroll walks to load it, found ${cgLoads.length}`);
}

const walks = [];
for (const s of cgLoads) {
    const start = s.addr - 8;
    const lines = listing(start, 24);
    const guard = find(lines, /^shlo (\d+), (\d+), r\d+$/);
    if (!guard || !has(lines, /^cmpoble /)) {
        fail(`the walk at 0x${start.toString(16)} does not open with the guard the port assumes`);
        continue;
    }
    const bound = Number(guard[2]) << Number(guard[1]);
    const bank = find(lines, /^shlo (\d+), g1, r\d+$/);
    walks.push({
        start,
        bound,
        indexed: has(lines, /\[g0\*4\]/),
        tiles: !!find(lines, /^shli (\d+), r\d+, r\d+$/) && has(lines, /^stis /),
        colours: has(lines, /^shrdi 1, /) && has(lines, /^st r\d+, \(r\d+\)$/),
        shli: find(lines, /^shli (\d+), r\d+, r\d+$/),
        bankShift: bank ? Number(bank[1]) : null,
    });
}

for (const w of walks) {
    if (w.bound !== S.CG_TABLE_LEN) {
        fail(`the walk at 0x${w.start.toString(16)} guards on ${w.bound} sets, `
            + `scroll.mjs carries ${S.CG_TABLE_LEN}`);
    }
    if (!w.indexed) {
        fail(`the walk at 0x${w.start.toString(16)} does not index the CG table by 4`);
    }
}

const tileWalks = walks.filter((w) => w.tiles);
const colourWalks = walks.filter((w) => w.colours);
if (tileWalks.length !== 2 || colourWalks.length !== 2) {
    fail(`expected two tile walks and two colour walks, found ${tileWalks.length} and `
        + `${colourWalks.length}`);
}

/* A tile record's count is in tiles and the copy runs in halfwords: the shift
 * says how many, and that is where 32 bytes to a tile comes from. */
for (const w of tileWalks) {
    const halves = 1 << Number(w.shli[1]);
    if (halves * 2 !== S.TILE_BYTES) {
        fail(`the tile walk at 0x${w.start.toString(16)} copies ${halves} halfwords a tile, `
            + `scroll.mjs carries ${S.TILE_BYTES} bytes`);
    }
}
console.log(`both tile walks copy ${S.TILE_BYTES} bytes a tile, both guard on `
    + `${S.CG_TABLE_LEN} indices — ${S.CG_SET_COUNT} sets of two`);

/* The banked variants: one adds g1 << 12 to a tile destination, the other
 * g1 << 5 to a palette destination, which is 16 colours — the stride the
 * composer reads a colour at, and the width of the entry's palette field. */
const tileBank = tileWalks.map((w) => w.bankShift).filter((s) => s !== null);
const colourBank = colourWalks.map((w) => w.bankShift).filter((s) => s !== null);
if (tileBank.length !== 1 || tileBank[0] !== 12) {
    fail(`expected one tile walk banked by g1 << 12, found ${JSON.stringify(tileBank)}`);
}
if (colourBank.length !== 1 || (1 << colourBank[0]) !== S.PALETTE_BANK_BYTES) {
    fail(`expected one colour walk banked by ${S.PALETTE_BANK_BYTES} bytes, found `
        + `${JSON.stringify(colourBank.map((s) => 1 << s))}`);
}
console.log(`a palette bank is ${S.PALETTE_BANK_BYTES} bytes — 16 colours, `
    + 'which is the stride readColour uses');

/* Scroll_Initialize is whoever calls the plain tile walk: it must take the
 * colours from the index above, which is the parity loadScrollSet assumes. */
{
    const plainTile = tileWalks.find((w) => w.bankShift === null);
    const plainColour = colourWalks.find((w) => w.bankShift === null);
    let paired = 0;
    if (plainTile && plainColour) {
        for (const s of sites(plainTile.start)) {
            if (!/^call /.test(s.text)) continue;
            const [, inc, next] = listing(s.addr, 3);
            if (/^addo 1, g0, g0$/.test(inc.text) && next.target === plainColour.start) paired++;
        }
    }
    if (paired < 1) {
        fail('nothing calls the tile walk and then the colour walk one index up, '
            + 'so the even/odd pairing loadScrollSet assumes is not in the code');
    } else {
        console.log(`${paired} caller takes tiles from a set and colours from the index above`);
    }
}

/* ---- 2. the pattern blit ------------------------------------------------- */

const patternLoads = sites(S.PATTERN_TABLE);
const blits = [];
for (const s of patternLoads) {
    const lines = listing(s.addr, 20);
    if (!has(lines, /^shlo 7, g1, r\d+$/)) continue;   /* the one that takes a bank */
    blits.push({ addr: s.addr, lines });
}
if (blits.length !== 1) {
    fail(`expected one pattern blit taking a palette bank, found ${blits.length}`);
}

if (blits.length) {
    const { lines } = blits[0];

    /* The bank is added at bit 7 — the entry's palette field, which is what
     * entryBank shifts down by. */
    const probe = 1;
    if (S.entryBank(probe << 7) !== probe) {
        fail('entryBank does not read the field the blit adds g1 << 7 into');
    }

    /* +0 is the base, +4 and +8 are a pair loaded together, +C the entries. */
    if (!has(lines, /^ldos \(g\d+\), r\d+$/)) fail('the blit does not read a base at +0');
    const pair = find(lines, /^ldl 0x4\(g\d+\), r(\d+)$/);
    if (!pair) fail('the blit does not load the two dimensions as a pair at +4');
    if (!has(lines, /^addo 12, g\d+, r\d+$/)) fail('the blit does not take its entries from +0xC');

    /* The row stride, `shlo 7, 1, r5`. */
    const stride = find(lines, /^shlo (\d+), 1, r(\d+)$/);
    if (!stride || (1 << Number(stride[1])) !== S.NAME_STRIDE) {
        fail(`the blit's row stride is not the ${S.NAME_STRIDE} bytes scroll.mjs carries`);
    }

    /* Which dimension is the inner loop. `ldl 0x4(g0), r6` loads the height
     * into r6 and the width into r7; the inner loop must count the width down
     * and the outer the height, or a picture comes out transposed — which is
     * the one thing the port cannot tell from the tables, since a record does
     * not say which of its two numbers is which. */
    if (pair) {
        const height = `r${pair[1]}`;
        const width = `r${Number(pair[1]) + 1}`;
        const counted = lines.map((l) => l.text.match(/^mov (r\d+), 0, r\d+$/))
            .filter(Boolean).map((m) => m[1]);
        if (!counted.includes(width)) {
            fail(`the blit's inner loop does not count the width (${width}) down; `
                + `it moves ${JSON.stringify(counted)}`);
        }
        const outer = lines.map((l) => l.text.match(/^cmpdeco 1, (r\d+), r\d+$/))
            .filter(Boolean).map((m) => m[1]);
        if (!outer.includes(height)) {
            fail(`the blit's outer loop does not count the height (${height}) down; `
                + `it decrements ${JSON.stringify(outer)}`);
        }
        if (counted.includes(width) && outer.includes(height)) {
            console.log(`the blit runs ${width} (the record's +8) across a row of `
                + `${S.NAME_STRIDE} bytes and ${height} (+4) down`);
        }
    }
}

/* The cell count: the pattern table's other caller guards on it. */
{
    const guards = [];
    for (const s of patternLoads) {
        const before = listing(s.addr - 8, 2);
        const m = before[0].text.match(/^lda 0x([0-9a-f]+), r\d+$/);
        if (m && /^cmpoble /.test(before[1].text)) guards.push(parseInt(m[1], 16));
    }
    if (!guards.includes(S.PATTERN_LIMIT)) {
        fail(`no caller of the pattern table guards on ${S.PATTERN_LIMIT} cells; `
            + `found ${JSON.stringify(guards.map((g) => '0x' + g.toString(16)))}`);
    } else {
        console.log(`the pattern table is guarded at 0x${S.PATTERN_LIMIT.toString(16)} cells`);
    }
}

/* ---- 3. the tables ------------------------------------------------------- */

/* Tile RAM is exactly what an entry's 14-bit tile field can name. */
if (S.TILE_RAM_SIZE !== 0x4000 * S.TILE_BYTES || S.entryTile(0xffff) !== 0x3fff) {
    fail('tile RAM is not the 0x4000 tiles the entry field names');
}

let cgSets = 0, colourSets = 0, tileSpans = 0, colourSpans = 0, outside = 0;
for (let g = 0; g < S.CG_TABLE_LEN; g++) {
    if (!S.readWord(rom, S.CG_TABLE + g * 4)) continue;
    const tiles = new Uint8Array(S.TILE_RAM_SIZE);
    const palette = new Uint8Array(S.PALETTE_RAM_SIZE);
    if (g % 2 === 0) {
        const spans = S.scrollCgInitialize(rom, g, tiles);
        cgSets++; tileSpans += spans.length;
        for (const s of spans) {
            if (s.outside) {
                outside++;
                fail(`CG index ${g} uploads ${s.bytes} bytes to 0x${s.dest.toString(16)}, `
                    + 'which is not in tile RAM');
            }
        }
        if (!spans.length) fail(`CG index ${g} has a list but uploads no tiles`);
    } else {
        const spans = S.scrollColorInitialize(rom, g, palette);
        colourSets++; colourSpans += spans.length;
        for (const s of spans) {
            if (s.outside) {
                outside++;
                fail(`CG index ${g} writes ${s.bytes} bytes of colour to `
                    + `0x${s.dest.toString(16)}, which is not in palette RAM`);
            }
        }
        if (!spans.length) fail(`CG index ${g} has a list but writes no colours`);
    }
}
console.log(`${cgSets} even indices upload tiles in ${tileSpans} spans, ${colourSets} odd `
    + `indices write colours in ${colourSpans} — ${outside} outside the RAM they address`);

/* The pictures: a run of records at the front of the table and zero after. */
{
    let live = 0, firstDead = -1;
    for (let c = 1; c <= S.PATTERN_LIMIT; c++) {
        const rec = S.patternRecord(rom, c);
        if (rec) {
            live++;
            if (firstDead >= 0) fail(`cell ${c} is a record but ${firstDead} was not`);
            if (rec.width > S.NAME_ROW_ENTRIES) {
                fail(`cell ${c} is ${rec.width} tiles wide, more than a row holds`);
            }
        } else if (firstDead < 0 && c > 1) {
            firstDead = c;
        }
    }
    const trailing = [];
    for (let c = firstDead; c <= S.PATTERN_LIMIT; c++) {
        if (S.readWord(rom, S.PATTERN_TABLE + c * 4)) trailing.push(c);
    }
    if (trailing.length) {
        fail(`${trailing.length} entries past cell ${firstDead - 1} are not zero`);
    }
    console.log(`${live} pictures, cells 1 to ${firstDead - 1}, and the rest of the table is zero`);
}

/* ---- 4. every picture decodes, with a set that holds all of its tiles ----- */

const sets = [];
for (let s = 0; s < S.CG_SET_COUNT; s++) {
    if (!S.scrollSetPresent(rom, s)) { sets.push(null); continue; }
    const loaded = S.loadScrollSet(rom, s);
    sets.push({ loaded, have: S.setTiles(loaded), colours: colourMask(loaded) });
}

/** The palette bytes a set actually wrote, so a pixel can be held to them. */
function colourMask(loaded) {
    const mask = new Uint8Array(S.PALETTE_RAM_SIZE / S.PALETTE_BANK_BYTES);
    for (const s of loaded.colourSpans) {
        if (s.outside) continue;
        const first = (s.dest - S.PALETTE_RAM) / S.PALETTE_BANK_BYTES;
        for (let i = 0; i <= s.bytes / S.PALETTE_BANK_BYTES; i++) mask[first + i] = 1;
    }
    return mask;
}

{
    let decoded = 0, empty = 0, black = 0, unpaired = 0, strayTile = 0, strayBank = 0;
    for (let c = 1; c <= S.PATTERN_LIMIT; c++) {
        const pattern = S.readPattern(rom, c);
        if (!pattern) continue;

        /* Every tile the picture names has to be inside tile RAM, whoever
         * uploaded it, and every bank inside the field's 128. */
        for (const e of pattern.entries) {
            if (e === 0) continue;
            if (S.entryTile(e) * S.TILE_BYTES + S.TILE_BYTES > S.TILE_RAM_SIZE) strayTile++;
            if (S.entryBank(e) * S.PALETTE_BANK_BYTES >= S.PALETTE_RAM_SIZE) strayBank++;
        }

        const set = sets.findIndex((s) => s && S.coverage(pattern, s.loaded, s.have) === 1);
        if (set < 0) { unpaired++; continue; }

        const img = S.renderCell(rom, c, set, { loaded: sets[set].loaded });
        decoded++;
        if (S.isEmpty(img)) {
            empty++;
            fail(`cell ${c} paints nothing on set ${set}, which uploaded every tile it names`);
        } else if (S.isBlank(img)) {
            black++;
        }
        /* No pixel may be lit out of a bank the set never wrote. */
        for (const e of pattern.entries) {
            if (e === 0) continue;
            if (!sets[set].colours[S.entryBank(e)]) {
                fail(`cell ${c} reads palette bank ${S.entryBank(e)}, which set ${set} `
                    + 'never wrote');
                break;
            }
        }
    }
    if (strayTile) fail(`${strayTile} entries name a tile outside tile RAM`);
    if (strayBank) fail(`${strayBank} entries name a palette bank outside palette RAM`);
    if (unpaired) fail(`${unpaired} pictures have no set holding every tile they name`);
    console.log(`${decoded} pictures decoded against the set that covers them, `
        + `${empty} painting nothing, ${unpaired} unpaired`);
    if (black) {
        console.log(`  ${black} of them are painted only in black, which is art and not a `
            + 'failure to decode');
    }
}

console.log(bad ? `\n${bad} failed` : '\nall good');
process.exit(bad ? 1 : 0);
