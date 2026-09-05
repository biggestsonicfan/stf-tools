/*
 * scroll.mjs — the 2D scroll layer, decoded out of a ROM set.
 *
 * Everything the game draws that is not a polygon — the logos, the HUD, the
 * character-select art, the text — is a tilemap on the board's 2D layer rather
 * than geometry, so none of it comes out of the model table and none of it is
 * in the texture ROM the viewer unpacks. It is built at runtime by three
 * routines in the program ROM, and this is a port of them:
 *
 *   0x2e59c  Scroll_Initialize(set)      calls the two below, colours at set+1
 *   0x2e5ac  ScrollCG_Initialize(g0)     uploads 8x8 4bpp tiles to tile RAM
 *   0x2e610  ScrollColor_Initialize(g0)  uploads BGR555 colours to palette RAM
 *   0x2e734  dsp_pattern_new(cell, bank) lays one picture into the name table
 *
 * with the two `…_Initialize2` variants at 0x2e678 and 0x2e6dc, which are the
 * same walks with a tile-RAM bank of `g1 << 12` and a palette bank of `g1 << 5`
 * added to the destination.
 *
 * Two tables drive them, both in the data ROM through the 0x06000000 window:
 *
 *   0x06480000  184 CG sets. An even index is a list of (source, destination)
 *               pairs terminated by a zero source; the source record is a tile
 *               count followed by that many 32-byte tiles. The odd index one
 *               above it is the matching colour list: (destination, count in
 *               colours) pairs with the colours inline, terminated by a zero
 *               destination. So a set is a pair of indices and there are 92.
 *   0x06480300  535 pictures ("cells"). Each record is
 *                   +0  base added to every tilemap entry (0x8000 — the
 *                       priority bit — on all but one of them)
 *                   +4  height, in tiles
 *                   +8  width, in tiles
 *                   +C  height*width 16-bit tilemap entries, in row order
 *
 * A tilemap entry is the System 24 form the board's tile chip reads, and its
 * two fields overlap: bits 13-0 are the tile number and bits 13-7 are the
 * palette bank, so a picture's palette rides in the high half of its tile
 * numbers. Bit 14 flips the tile horizontally, bit 15 is the priority bit.
 * The overlap is what dsp_pattern_new's second argument works in — it adds
 * `bank << 7`, one palette bank, to every entry it writes.
 *
 * Which CG set a cell was drawn with is not written down anywhere the tables
 * reach: the caller loads a set and then names cells, so the pairing lives in
 * the code. `coverage()` below recovers it instead — a set that uploaded every
 * tile a cell names is the set that cell was drawn with — and extract-scroll.mjs
 * pairs them off that.
 *
 * Addresses, sizes and the field order are all pinned against the instruction
 * stream by test-scroll.mjs rather than trusted from here.
 */

import { xtraToMainData } from './vendor/noclip/js/romset.js';

/* ---- the board's own numbers --------------------------------------------- */

export const CG_TABLE = 0x06480000;
/* The guard both CG walks open with: `shlo 3, 23, r13; cmpoble r13, g0`. */
export const CG_TABLE_LEN = 0xb8;
export const PATTERN_TABLE = 0x06480300;
/* The guard in the pattern blit at 0x5dcc: `lda 0x3ff, r13; cmpoble r13, g0`. */
export const PATTERN_LIMIT = 0x3ff;

/* Tile RAM is 0x80000 bytes, which is 0x4000 tiles of 32 — exactly what the
 * entry's 14-bit tile field can name. */
export const TILE_RAM = 0x01080000;
export const TILE_BYTES = 32;
export const TILE_PX = 8;
export const TILE_RAM_SIZE = 0x4000 * TILE_BYTES;

/* Palette RAM, 16 colours to a bank and 128 banks the 7-bit field can name.
 * The sets write a little past that, so the window here is not cut to it. */
export const PALETTE_RAM = 0x01800000;
export const PALETTE_BANK_BYTES = 32;
export const PALETTE_RAM_SIZE = 0x2000;

/* The name table's row stride, `shlo 7, 1, r5` in the blit: 64 entries, which
 * is also the widest picture the table holds. */
export const NAME_STRIDE = 0x80;
export const NAME_ROW_ENTRIES = NAME_STRIDE / 2;

/* ---- reading the data ROM ------------------------------------------------ */

/** The i960 address of a data word, as an offset into rom.mainData. */
export function dataOffset(addr) {
    /* main_data proper, and the 0x06000000 window that mirrors its last MB. */
    if (addr >= 0x02000000 && addr < 0x04000000) return addr - 0x02000000;
    if (addr >= 0x06000000 && addr < 0x07000000) return xtraToMainData(addr);
    return -1;
}

const mapped = (rom, addr, n) => {
    const off = dataOffset(addr);
    return off >= 0 && off + n <= rom.mainData.length ? off : -1;
};

/** 32-bit read, or null where the address is not in the data ROM. */
export function readWord(rom, addr) {
    const off = mapped(rom, addr, 4);
    return off < 0 ? null : rom.mainDataView.getUint32(off, true);
}

/** 16-bit read, or null where the address is not in the data ROM. */
export function readHalf(rom, addr) {
    const off = mapped(rom, addr, 2);
    return off < 0 ? null : rom.mainDataView.getUint16(off, true);
}

/* ---- the CG sets --------------------------------------------------------- */

/**
 * ScrollCG_Initialize / ScrollCG_Initialize2 — walk one CG index's list and
 * upload its tiles. `bank` is the `g1` of the 2 variant, worth `g1 << 12`.
 *
 * Returns the spans it wrote, so a caller can say which tiles a set covers.
 */
export function scrollCgInitialize(rom, g0, tiles, bank = 0) {
    const spans = [];
    if (g0 >= CG_TABLE_LEN) return spans;
    let list = readWord(rom, CG_TABLE + g0 * 4);
    if (!list) return spans;

    const dstBank = bank << 12;
    for (;;) {
        const src = readWord(rom, list); list += 4;
        if (!src) break;
        const dst = readWord(rom, list) + dstBank; list += 4;

        const count = readWord(rom, src);
        if (count === null) break;
        /* `shli 4, r4, r4`: the record's count is in tiles, and the copy runs
         * in halfwords — 16 of them to a tile, which is 32 bytes. */
        const halves = count << 4;
        let from = src + 4;
        let to = dst - TILE_RAM;
        if (to < 0 || to + halves * 2 > tiles.length) {
            spans.push({ dest: dst, bytes: halves * 2, outside: true });
            continue;
        }
        for (let i = 0; i < halves; i++) {
            const h = readHalf(rom, from);
            if (h === null) break;
            tiles[to] = h & 0xff;
            tiles[to + 1] = h >> 8;
            from += 2; to += 2;
        }
        spans.push({ dest: dst, bytes: halves * 2, outside: false });
    }
    return spans;
}

/**
 * ScrollColor_Initialize / …2 — walk one CG index's colour list. `bank` is the
 * `g1` of the 2 variant, worth `g1 << 5`: one palette bank of 16 colours.
 */
export function scrollColorInitialize(rom, g0, palette, bank = 0) {
    const spans = [];
    if (g0 >= CG_TABLE_LEN) return spans;
    let list = readWord(rom, CG_TABLE + g0 * 4);
    if (!list) return spans;

    const dstBank = bank * PALETTE_BANK_BYTES;
    for (;;) {
        let dst = readWord(rom, list); list += 4;
        if (!dst) break;
        dst += dstBank;
        const count = readWord(rom, list); list += 4;
        if (count === null) break;
        /* `shrdi 1, r4, r4`: the count is in colours and the copy runs in
         * words, so half as many of them. */
        const words = count >>> 1;
        let to = dst - PALETTE_RAM;
        const outside = to < 0 || to + words * 4 > palette.length;
        for (let i = 0; i < words; i++) {
            const v = readWord(rom, list);
            if (v === null) break;
            if (!outside) {
                palette[to] = v & 0xff;
                palette[to + 1] = (v >> 8) & 0xff;
                palette[to + 2] = (v >> 16) & 0xff;
                palette[to + 3] = (v >>> 24) & 0xff;
                to += 4;
            }
            list += 4;
        }
        spans.push({ dest: dst, bytes: words * 4, outside });
    }
    return spans;
}

/** How many CG sets the table holds: a set is an even index and the odd one above. */
export const CG_SET_COUNT = CG_TABLE_LEN >> 1;

/**
 * Scroll_Initialize(set * 2) — one set's tiles and colours, as the RAM the
 * board would be holding. `set` is 0..91; the routine's own argument is `g0`,
 * which is twice that, and the colours come from `g0 + 1`.
 */
export function loadScrollSet(rom, set, { tileBank = 0, colourBank = 0 } = {}) {
    const g0 = set * 2;
    const tiles = new Uint8Array(TILE_RAM_SIZE);
    const palette = new Uint8Array(PALETTE_RAM_SIZE);
    const tileSpans = scrollCgInitialize(rom, g0, tiles, tileBank);
    const colourSpans = scrollColorInitialize(rom, g0 + 1, palette, colourBank);
    return { set, g0, tiles, palette, tileSpans, colourSpans };
}

/** True where the set's index has a list at all — 81 of the 92 do. */
export function scrollSetPresent(rom, set) {
    return !!readWord(rom, CG_TABLE + set * 2 * 4);
}

/* ---- the pictures -------------------------------------------------------- */

/**
 * One cell's record, read but not laid out. Returns null where the table entry
 * is not a record — cell 0's is not, and everything from 535 on is zero.
 */
export function patternRecord(rom, cell) {
    if (cell < 0 || cell > PATTERN_LIMIT) return null;
    const rec = readWord(rom, PATTERN_TABLE + cell * 4);
    if (!rec) return null;
    const base = readHalf(rom, rec);
    const height = readWord(rom, rec + 4);
    const width = readWord(rom, rec + 8);
    if (base === null || height === null || width === null) return null;
    /* The blit writes `width` entries into a row of NAME_ROW_ENTRIES and steps
     * a row per `height`, so a record naming more than a row's worth of
     * columns is not one. */
    if (width < 1 || width > NAME_ROW_ENTRIES || height < 1) return null;
    if (mapped(rom, rec + 12 + width * height * 2, 0) < 0) return null;
    return { cell, address: rec, base, width, height };
}

/**
 * dsp_pattern_new — one picture's tilemap entries, in row order.
 *
 * The board writes them into the name table at a row stride of 0x80 bytes and
 * the layer is read back from there; the rows are contiguous here instead,
 * which is the same picture without carrying 0x7c000 bytes of mostly-empty RAM.
 * `bank` is the routine's `g1`, added to every entry as `bank << 7` — one
 * palette bank, in the field the entry shares with its tile number.
 */
export function readPattern(rom, cell, bank = 0) {
    const rec = patternRecord(rom, cell);
    if (!rec) return null;
    const add = (rec.base + (bank << 7)) & 0xffff;
    const entries = new Uint16Array(rec.width * rec.height);
    let from = rec.address + 12;
    for (let i = 0; i < entries.length; i++) {
        const v = readHalf(rom, from);
        if (v === null) return null;
        entries[i] = (v + add) & 0xffff;
        from += 2;
    }
    return { ...rec, entries };
}

/* ---- turning that into pixels -------------------------------------------- */

/** A tilemap entry, as the tile chip reads it. */
export const entryTile = (e) => e & 0x3fff;
export const entryBank = (e) => (e >> 7) & 0x7f;
export const entryFlipX = (e) => (e >> 14) & 1;

/** One 32-byte tile as 64 4-bit indices. */
export function decodeTile(tiles, index) {
    const out = new Uint8Array(TILE_PX * TILE_PX);
    const off = index * TILE_BYTES;
    if (off + TILE_BYTES > tiles.length) return out;
    for (let i = 0; i < TILE_BYTES; i++) {
        /* The upload moved halfwords, so a tile's bytes are in the board's
         * order and come back a pair at a time. */
        const b = tiles[off + (i ^ 1)];
        out[i * 2] = b >> 4;
        out[i * 2 + 1] = b & 0x0f;
    }
    return out;
}

/** Palette RAM is BGR555: 5 bits of red at the bottom, one bank of 16 colours. */
export function readColour(palette, bank, index) {
    const off = (bank * 16 + index) * 2;
    if (off + 1 >= palette.length) return [0, 0, 0, 0];
    const v = palette[off] | (palette[off + 1] << 8);
    return [
        Math.round((v & 0x1f) * 255 / 31),
        Math.round(((v >> 5) & 0x1f) * 255 / 31),
        Math.round(((v >> 10) & 0x1f) * 255 / 31),
        255,
    ];
}

/**
 * One picture as RGBA pixels. Colour 0 of any bank is the transparent one, and
 * an entry of 0 is a cell the picture never wrote.
 */
export function composeCell(pattern, tiles, palette) {
    const w = pattern.width * TILE_PX;
    const h = pattern.height * TILE_PX;
    const px = new Uint8Array(w * h * 4);

    for (let ty = 0; ty < pattern.height; ty++) {
        for (let tx = 0; tx < pattern.width; tx++) {
            const entry = pattern.entries[ty * pattern.width + tx];
            if (entry === 0) continue;
            const tile = decodeTile(tiles, entryTile(entry));
            const bank = entryBank(entry);
            const flip = entryFlipX(entry);
            for (let y = 0; y < TILE_PX; y++) {
                for (let x = 0; x < TILE_PX; x++) {
                    const ci = tile[y * TILE_PX + (flip ? 7 - x : x)];
                    if (ci === 0) continue;
                    const [r, g, b, a] = readColour(palette, bank, ci);
                    const o = ((ty * TILE_PX + y) * w + tx * TILE_PX + x) * 4;
                    px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = a;
                }
            }
        }
    }
    return { width: w, height: h, pixels: px };
}

/** Everything above in one call: a cell drawn with one set's tiles and colours. */
export function renderCell(rom, cell, set, opts = {}) {
    const pattern = readPattern(rom, cell, opts.bank ?? 0);
    if (!pattern) return null;
    const loaded = opts.loaded ?? loadScrollSet(rom, set, opts);
    return { pattern, ...composeCell(pattern, loaded.tiles, loaded.palette) };
}

/** True where the picture painted nothing at all: every pixel transparent. */
export function isEmpty(image) {
    const p = image.pixels;
    for (let i = 3; i < p.length; i += 4) if (p[i]) return false;
    return true;
}

/**
 * True where no pixel has any colour in it. That takes in the empty picture but
 * also the one painted entirely in black — cell 105 is a strip of colour
 * 0x8000, which is black and opaque — so a dump filtered on this drops art the
 * board really draws, and extract-scroll.mjs filters on isEmpty instead. This
 * is here because it is the test the decoder was ported from skipped on, and
 * test-scroll.mjs reports the one picture the two disagree about.
 */
export function isBlank(image) {
    const p = image.pixels;
    for (let i = 0; i < p.length; i += 4) {
        if (p[i] || p[i + 1] || p[i + 2]) return false;
    }
    return true;
}

/* ---- pairing a cell with the set it was drawn with ------------------------ */

/** The tile numbers a picture names, and the palette banks it reads. */
export function cellDemand(pattern) {
    const tiles = new Set();
    const banks = new Set();
    for (const e of pattern.entries) {
        if (e === 0) continue;
        tiles.add(entryTile(e));
        banks.add(entryBank(e));
    }
    return { tiles, banks };
}

/** The tile numbers a loaded set uploaded, as a byte-level mask over tile RAM. */
export function setTiles(loaded) {
    const have = new Set();
    for (const s of loaded.tileSpans) {
        if (s.outside) continue;
        const first = (s.dest - TILE_RAM) / TILE_BYTES;
        for (let i = 0; i < s.bytes / TILE_BYTES; i++) have.add(first + i);
    }
    return have;
}

/**
 * How much of what a cell names a set actually uploaded, 0..1. A cell was drawn
 * with the set that scores 1: the pairing is in the code rather than the tables,
 * so this is what recovers it.
 */
export function coverage(pattern, loaded, have = setTiles(loaded)) {
    const { tiles } = cellDemand(pattern);
    if (tiles.size === 0) return 0;
    let hit = 0;
    for (const t of tiles) if (have.has(t)) hit++;
    return hit / tiles.size;
}
