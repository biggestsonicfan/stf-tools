/*
 * csum.mjs — the board's own ROM checksum, ported.
 *
 * The game checks its own ROMs at boot, in a self-test that prints GOOD or NOW
 * (the failure string) per chip. One routine does the summing:
 *
 *   0x5c080  rom_checksum(start, length, alignment)
 *
 * and it is a chip-at-a-time sum, not a region-at-a-time one. A Model 2 region
 * is two 16-bit EPROMs interleaved into 32-bit words, so the two bytes at each
 * word's low half are one chip and the two at its high half are the other: the
 * routine adds two bytes, steps four, and `alignment` is which half it starts
 * on. `length` is therefore one chip's size, and the span it walks is twice
 * that. The 32-bit total is cut to 16 bits at the end.
 *
 * What it sums is not hardcoded either — a table of eight records drives it,
 * loaded four words at a time by the caller at 0x5bf4c:
 *
 *   0x58f9c  8 records of 24 bytes
 *              +0x00  start, an i960 address
 *              +0x04  length, one chip's worth of bytes
 *              +0x08  alignment: 0 for the low chip, 1 for the high one
 *              +0x0C  the checksum it must come to
 *              +0x10  a pointer the self-test prints the chip's name from
 *
 * which is the program ROM and both data ROMs, each as its two chips. The
 * polygon and texture ROMs are not on it; the i960 cannot address them.
 *
 * Two words are skipped: the routine holds 0x59038 and 0x59050 as addresses to
 * step over, and those are records 6 and 7's own `+0x0C` fields — the program
 * ROM's two checksums, which cannot be inside the sum that produces them. The
 * other six records' checksums are not skipped, because they were known before
 * the program ROM was burnt.
 *
 * Addresses, field order and every constant here are pinned against the
 * instruction stream by test-csum.mjs rather than trusted from here.
 */

/* ---- the board's own numbers --------------------------------------------- */

export const CSUM_ROUTINE = 0x5c080;
export const CSUM_TABLE = 0x58f9c;
export const CSUM_ENTRIES = 8;
/* The caller's `addo 24, r5, r5`; the `ldq` at its head reads the first four. */
export const CSUM_ENTRY_BYTES = 24;
/* The routine's two `lda` operands: the words it steps over. */
export const CSUM_SKIP = [0x59038, 0x59050];
/* Its `lda 0xffff, r5`, applied to the total by the `and` before the `ret`. */
export const CSUM_MASK = 0xffff;

/* ---- where an i960 address lands ----------------------------------------- */

/**
 * The region buffer an address is in, and the i960 address that buffer's
 * offset 0 sits at. A record's span lies wholly inside one of these, so a
 * checksum can walk the buffer and still compare addresses against the skips.
 */
export function regionFor(rom, addr) {
    if (addr >= 0 && addr < rom.maincpu.length) {
        return { bytes: rom.maincpu, base: 0, region: 'maincpu' };
    }
    /* main_data proper. */
    if (addr >= 0x02000000 && addr < 0x04000000) {
        return { bytes: rom.mainData, base: 0x02000000, region: 'mainData' };
    }
    /* The XTRA_DATA window, which mirrors main_data from offset 0x01000000 on
     * and repeats every megabyte. A record stays inside one repeat, so the
     * mapping is linear over its span. */
    if (addr >= 0x06000000 && addr < 0x07000000) {
        const off = 0x01000000 + ((addr - 0x06000000) & 0x000fffff);
        return { bytes: rom.mainData, base: addr - off, region: 'mainData' };
    }
    return null;
}

/* ---- the table ----------------------------------------------------------- */

/** One record of the self-test's table. */
export function readCsumEntry(rom, index) {
    const at = CSUM_TABLE + index * CSUM_ENTRY_BYTES;
    const dv = rom.mainCpuView;
    return {
        index,
        start: dv.getUint32(at + 0, true),
        length: dv.getUint32(at + 4, true),
        alignment: dv.getUint32(at + 8, true),
        expected: dv.getUint32(at + 12, true),
        namePtr: dv.getUint32(at + 16, true),
        /* The address the expected value is stored at, which is what the
         * routine's two skips are. */
        expectedAt: at + 12,
    };
}

/** All eight, in order. */
export function readCsumTable(rom) {
    const out = [];
    for (let i = 0; i < CSUM_ENTRIES; i++) out.push(readCsumEntry(rom, i));
    return out;
}

/* ---- the routine --------------------------------------------------------- */

/**
 * rom_checksum(start, length, alignment) — one chip's sum.
 *
 * `bytes`/`base` are the region the record lands in, from `regionFor`. The walk
 * is the routine's: two bytes added, four stepped, `length / 2` times, with any
 * word whose address is in `skip` stepped over rather than added.
 */
export function romChecksum(bytes, base, start, length, alignment, skip = CSUM_SKIP) {
    const skips = new Set(skip);
    /* `cmpobe 0, g2, …; addo 2, r3, r3`: a non-zero alignment starts one
     * halfword in, which is the other chip. */
    let off = (start - base) + (alignment !== 0 ? 2 : 0);
    /* `shro 1, r4, r4`: the count is in bytes and two are added a step. */
    let n = length >>> 1;
    let sum = 0;
    while (n > 0) {
        /* `clrbit 1, r3, r15`: the skips are word addresses, and the high
         * chip's pointer is two into the word. */
        if (!skips.has((base + off) & ~2)) sum += bytes[off] + bytes[off + 1];
        off += 4;
        n--;
    }
    return sum & CSUM_MASK;
}

/**
 * One record checked: its own sum, the sum the table says, and whether the
 * record is addressable at all.
 */
export function checkCsumEntry(rom, entry, skip = CSUM_SKIP) {
    const region = regionFor(rom, entry.start);
    if (!region) return { ...entry, region: null, actual: null, ok: false };
    const off = entry.start - region.base;
    /* The routine steps four bytes for every two it adds, so it walks twice
     * the length it is given. */
    const span = entry.length * 2;
    if (off < 0 || off + span > region.bytes.length) {
        return { ...entry, region: region.region, actual: null, ok: false };
    }
    const actual = romChecksum(region.bytes, region.base, entry.start,
        entry.length, entry.alignment, skip);
    return { ...entry, region: region.region, span, actual, ok: actual === entry.expected };
}
