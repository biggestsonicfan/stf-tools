/* The two DSP coprocessor executables the program ROM carries.
 *
 * A Model 2 board's geometry maths runs on an ADSP-21062 SHARC beside the i960,
 * and the SHARC has no ROM of its own: the i960 uploads its program at boot out
 * of two blobs sitting in the program ROM. They are the only part of the game
 * that is not i960 code, and the only part that has been disassembled back to
 * source and reassembled — `m2-hle/disassembly` holds the SHARC listings, and
 * what comes off its assembler is meant to be these two blobs exactly.
 *
 * So there are two forms of the same image and this is where the difference is
 * kept, once, for both the extractor and the check:
 *
 *   - a SHARC instruction is a 48-bit PM word, and the linker writes it big
 *     end first — the `.exe`'s `seg_pmco` bytes, and stfdecomp's `*_be.bin`;
 *   - the program ROM holds each of those words the other way round, low byte
 *     first, which is how the i960 shifts them out to the DSP — the ROM slice,
 *     and stfdecomp's `*.bin`.
 *
 * Nothing else separates them: `pmSwap` is its own inverse and turns either
 * into the other.
 */

/** A SHARC PM word is 48 bits, so six bytes, and every length here is whole. */
export const PM_WORD_BYTES = 6;

/** The section the SHARC linker puts the code in, named by `sharc.ach`. */
export const SEGMENT = 'seg_pmco';

/* Where the two blobs are, and what the decompilation links them under. The
 * offsets are `data_extract.py --cpres`'s; test-cpres.mjs does not take them on
 * trust — it searches the program ROM for the assembled image and checks that
 * the one place it turns up is the offset named here. */
export const BLOBS = [
    { name: 'cpres1', symbol: '_cpres_data', offset: 0xb6318, length: 0x741c,
      source: 'cpres1_ad_annotated_fixed.asm' },
    { name: 'cpres2', symbol: '_cpres_data2', offset: 0xbd748, length: 0x490e,
      source: 'cpres2_ad.asm' },
];

/**
 * Between the linker's byte order and the ROM's: every 48-bit PM word reversed.
 * Its own inverse, so one function covers both directions.
 */
export function pmSwap(bytes) {
    if (bytes.length % PM_WORD_BYTES)
        throw new Error(`${bytes.length} bytes is not whole ${PM_WORD_BYTES * 8}-bit words`);
    const out = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i += PM_WORD_BYTES)
        for (let j = 0; j < PM_WORD_BYTES; j++) out[i + j] = bytes[i + PM_WORD_BYTES - 1 - j];
    return out;
}

/* ---- the linked executable ----------------------------------------------- */

/** The magic word an ADSP-2106x COFF file opens with. */
export const COFF_MAGIC = 0x521c;

/**
 * The section table of a linked ADSP-21k COFF `.exe`, as
 * `{ name, addr, size, offset }`, addresses and sizes as the linker wrote them.
 *
 * This is what `extract_obj.py` shells out to `cdump` for. The header is plain
 * little-endian COFF and the file is in hand, so reading it here is a few lines
 * and one less thing that has to be installed to run a check.
 */
export function coffSections(buf) {
    if (buf.length < 20) throw new Error('too short to be a COFF file');
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const magic = dv.getUint16(0, true);
    if (magic !== COFF_MAGIC)
        throw new Error(`magic 0x${magic.toString(16)}, not an ADSP-21k COFF (0x${COFF_MAGIC.toString(16)})`);
    const count = dv.getUint16(2, true);
    const optHdr = dv.getUint16(16, true);
    const secs = [];
    for (let i = 0; i < count; i++) {
        const at = 20 + optHdr + i * 40;
        if (at + 40 > buf.length) throw new Error(`section ${i} runs past the end of the file`);
        let name = '';
        for (let j = 0; j < 8 && buf[at + j]; j++) name += String.fromCharCode(buf[at + j]);
        secs.push({
            name,
            addr: dv.getUint32(at + 8, true),
            size: dv.getUint32(at + 16, true),
            offset: dv.getUint32(at + 20, true),
        });
    }
    return secs;
}

/**
 * The PM image out of a linked `.exe`: the one `seg_pmco` section's bytes, in
 * the linker's big-end-first order. Throws rather than guessing if the file
 * does not hold exactly one.
 */
export function pmImage(buf, segment = SEGMENT) {
    const secs = coffSections(buf);
    const found = secs.filter((s) => s.name === segment);
    if (found.length !== 1)
        throw new Error(`${found.length} sections named ${segment}, expected 1`
            + ` (found ${secs.map((s) => s.name).join(', ') || 'none'})`);
    const s = found[0];
    if (s.offset + s.size > buf.length)
        throw new Error(`${segment} claims ${s.size} bytes at 0x${s.offset.toString(16)},`
            + ` past the end of a ${buf.length}-byte file`);
    return { ...s, bytes: buf.subarray(s.offset, s.offset + s.size) };
}

/**
 * Where the linker was told to put the segment, read out of an `.ach`
 * architecture file rather than assumed: `{ begin, end }` for `segment`.
 */
export function achSegment(text, segment = SEGMENT) {
    for (const line of text.split('\n')) {
        const bare = line.replace(/!.*$/, '');
        if (!bare.includes(segment)) continue;
        const begin = bare.match(/BEGIN\s*=\s*(0x[0-9a-f]+|\d+)/i);
        const end = bare.match(/END\s*=\s*(0x[0-9a-f]+|\d+)/i);
        if (begin) return { begin: Number(begin[1]), end: end ? Number(end[1]) : null };
    }
    return null;
}

/* ---- finding one in the other -------------------------------------------- */

/** Every offset in `hay` at which `needle` appears whole. */
export function occurrences(hay, needle) {
    const at = [];
    if (!needle.length || needle.length > hay.length) return at;
    const first = needle[0];
    for (let i = 0; i <= hay.length - needle.length; i++) {
        if (hay[i] !== first) continue;
        let j = 1;
        while (j < needle.length && hay[i + j] === needle[j]) j++;
        if (j === needle.length) at.push(i);
    }
    return at;
}
