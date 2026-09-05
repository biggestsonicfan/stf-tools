/*
 * test-cpres.mjs — the SHARC coprocessor images, against the ROM.
 *
 * Everything else here is a port measured against the board. This one is the
 * other way round: the two blobs the program ROM uploads to the ADSP-21062 have
 * been disassembled back to SHARC source in `m2-hle/disassembly`, and the claim
 * that source makes is that assembling and linking it produces those blobs
 * again — not equivalent code, the same bytes. That is a claim a ROM can settle
 * on its own, so this settles it.
 *
 * What is compared is the linked `.exe`, never the `.obj`. The assembler emits
 * a relocatable object in which every absolute jump, call and dm address is
 * still segment-relative; it is `ld21k`, driven by `sharc.ach` placing
 * `seg_pmco` at PM 0x20000, that resolves them. An unlinked image differs from
 * the ROM's in every address it carries, so the link is part of the claim.
 *
 * The section is read out of the COFF file here rather than by shelling out to
 * `cdump`, so a checkout with the disassembly but not the toolchain still runs
 * this. `--build` is the stronger form: run the disassembly's own
 * `build_obj.bat` first, so what is measured was assembled a moment ago rather
 * than whenever the `.exe` on disk was last written — which is worth having,
 * since a stale `.exe` sitting beside an edited listing agrees with nothing.
 *
 * Nothing is given a blob's address in the program ROM. The two offsets in
 * `cpres.mjs` are not asserted: the assembled image is searched for across the
 * whole megabyte, has to turn up exactly once, and that one place has to be the
 * offset named — so a wrong offset and a wrong build both fail, and neither can
 * hide the other.
 *
 * Then, before any of that, what the linker was asked for has to be what it
 * did: one `seg_pmco`, at the address `sharc.ach` names rather than at 0x20000
 * because this file says so, inside the window it names, a whole number of
 * 48-bit PM words, and as many of them as the ROM carries.
 *
 * With no disassembly to hand this says so and skips, like the checks whose
 * capture is missing. It is the disassembly that is being measured; the ROM
 * alone has nothing to disagree with.
 *
 *   node test-cpres.mjs [rom.zip]
 *   node test-cpres.mjs --disasm ../m2-hle/disassembly
 *   node test-cpres.mjs --build            # assemble and link it again first
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { loadRomSet } from './vendor/noclip/js/romset.js';
import { BLOBS, PM_WORD_BYTES, SEGMENT, pmSwap, pmImage, achSegment, occurrences } from './cpres.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes(`--${name}`);
const build = flag('build');
/* `--disasm` is the only option that takes a value, so it is the only one whose
 * next argument is not the ROM. */
const VALUED = ['--disasm'];
const ROM = argv.find((a, i) => !a.startsWith('--') && !VALUED.includes(argv[i - 1])) ?? 'sfight.zip';

let bad = 0;
const fail = (msg) => { console.log(`FAIL: ${msg}`); bad++; };
const hex = (n) => `0x${n.toString(16)}`;

/* ---- where the disassembly is -------------------------------------------- */

const here = (f) => decodeURIComponent(new URL(f, import.meta.url).pathname).replace(/^\/(\w:)/, '$1');
/* A disassembly directory is one with a `sharc.ach` in it, since that is the
 * file this has to read to know what the link was asked for. */
const isDisasm = (d) => fs.existsSync(path.join(d, 'sharc.ach'));
const given = arg('disasm', null) ?? process.env.STF_DISASM ?? null;
const disasm = given ?? [here('../m2-hle/disassembly'), here('../../m2-hle/disassembly')].find(isDisasm);

if (!disasm) {
    console.log('no SHARC disassembly to hand — pass --disasm <m2-hle/disassembly>, or set STF_DISASM');
    process.exit(0);
}
/* One that was named and is not there is a mistake rather than an absence, so
 * it fails instead of skipping. */
if (!isDisasm(disasm)) {
    console.error(`no sharc.ach in ${disasm} — that is not a SHARC disassembly`);
    process.exit(2);
}
console.log(`disassembly  ${disasm}`);

/* ---- assembling it again, if asked --------------------------------------- */

if (build) {
    const bat = path.join(disasm, 'build_obj.bat');
    if (!fs.existsSync(bat)) {
        fail(`--build given but there is no build_obj.bat in ${disasm}`);
    } else {
        /* When it was linked is the only reliable signal that it was: the batch
         * file reports its own failures by echoing them and still exits 0, so
         * an exit code says nothing, and a toolchain that is not installed and
         * a build that ran and failed have to be told apart by hand. */
        const stamp = () => Object.fromEntries(BLOBS.map((b) => {
            const exe = path.join(disasm, `${b.name}.exe`);
            return [b.name, fs.existsSync(exe) ? fs.statSync(exe).mtimeMs : 0];
        }));
        const before = stamp();
        console.log(`build        running ${path.basename(bat)}`);
        /* A `.bat` cannot be spawned directly — node refuses it — so it is run
         * through the command interpreter, which is what a shell would do. */
        try {
            const out = execFileSync(process.env.ComSpec || 'cmd.exe', ['/c', bat],
                { cwd: disasm, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
            for (const l of out.split('\n')) if (l.trim()) console.log(`             ${l.trimEnd()}`);
        } catch (e) {
            console.log(`             ${e.message.split('\n')[0]}`);
        }
        const after = stamp();
        const stale = BLOBS.filter((b) => after[b.name] === before[b.name]).map((b) => b.name);
        if (stale.length === BLOBS.length) {
            /* Nothing was relinked, so nothing below was freshly assembled and
             * saying otherwise would be the one thing this check must not do. */
            fail('--build relinked nothing — the SHARC toolchain build_obj.bat drives'
                + ' (its C:\\sharc and its awk) is not where it looks for it;'
                + ' what follows measures the .exe already on disk');
        } else if (stale.length) {
            fail(`--build relinked ${BLOBS.length - stale.length} of ${BLOBS.length}:`
                + ` ${stale.join(', ')} came out of the build unchanged on disk`);
        } else {
            console.log(`             relinked ${BLOBS.map((b) => `${b.name}.exe`).join(', ')}`);
        }
    }
}

/* ---- what sharc.ach asked the linker for --------------------------------- */

const ach = achSegment(fs.readFileSync(path.join(disasm, 'sharc.ach'), 'utf8'));
if (!ach) {
    console.log(`FAIL: sharc.ach names no ${SEGMENT} segment, so there is nothing to hold the link against`);
    process.exit(1);
}
console.log(`sharc.ach    ${SEGMENT} at PM ${hex(ach.begin)}..${hex(ach.end)}`);

/* ---- the ROM ------------------------------------------------------------- */

if (!fs.existsSync(ROM)) {
    console.error(`no ROM set at ${ROM}`);
    process.exit(2);
}
const read = (p) => {
    const b = fs.readFileSync(p);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const rom = await loadRomSet([read(ROM)]);
const code = rom.maincpu;
console.log(`${path.basename(ROM).padEnd(12)} program ROM ${code.length} bytes`);
console.log('');

/* ---- and the comparison -------------------------------------------------- */

/** One 48-bit PM word of a byte stream, as the assembler's listing prints it. */
const word = (bytes, i) => [...bytes.subarray(i * PM_WORD_BYTES, (i + 1) * PM_WORD_BYTES)]
    .map((v) => v.toString(16).padStart(2, '0').toUpperCase()).join('');

for (const b of BLOBS) {
    if (b !== BLOBS[0]) console.log('');
    console.log(b.name);

    /* The ROM's own copy, in the ROM's own word order. */
    if (b.offset + b.length > code.length) {
        fail(`${b.name}: the program ROM ends before ${hex(b.offset + b.length)}`);
        continue;
    }
    const romBytes = code.subarray(b.offset, b.offset + b.length);
    if (b.length % PM_WORD_BYTES) {
        fail(`${b.name}: ${b.length} bytes is not whole ${PM_WORD_BYTES * 8}-bit PM words`);
        continue;
    }
    const words = b.length / PM_WORD_BYTES;

    /* What a fresh assembly produces. The `.exe` is what carries the link, so
     * it is what is read; a bare `.bin` beside it is somebody's extraction and
     * says nothing about whether the linker was ever run. */
    const exe = path.join(disasm, `${b.name}.exe`);
    if (!fs.existsSync(exe)) {
        fail(`${b.name}: no ${b.name}.exe in ${disasm} — run build_obj.bat, or pass --build`);
        continue;
    }
    let img;
    try {
        img = pmImage(fs.readFileSync(exe), SEGMENT);
    } catch (e) {
        fail(`${b.name}.exe: ${e.message}`);
        continue;
    }

    /* An `.exe` older than the listing it was built from is not that listing's
     * image, whatever it then compares as. */
    const src = path.join(disasm, b.source);
    if (fs.existsSync(src) && fs.statSync(src).mtimeMs > fs.statSync(exe).mtimeMs)
        console.log(`  note   ${b.source} is newer than ${b.name}.exe — pass --build to assemble it again`);

    /* 1. the link is the one sharc.ach asked for */
    if (img.addr !== ach.begin)
        fail(`${b.name}: ${SEGMENT} linked at ${hex(img.addr)}, but sharc.ach places it at ${hex(ach.begin)}`);
    if (img.size % PM_WORD_BYTES)
        fail(`${b.name}: ${SEGMENT} is ${img.size} bytes, not whole ${PM_WORD_BYTES * 8}-bit PM words`);
    const linkedWords = Math.floor(img.size / PM_WORD_BYTES);
    if (ach.end !== null && img.addr + linkedWords - 1 > ach.end)
        fail(`${b.name}: ${linkedWords} PM words from ${hex(img.addr)} runs past`
            + ` the segment's end ${hex(ach.end)}`);

    /* 2. and it is as long as what the ROM carries */
    if (img.size !== b.length) {
        fail(`${b.name}: assembled ${img.size} bytes (${linkedWords} PM words),`
            + ` the ROM carries ${b.length} (${words})`);
        continue;
    }

    /* 3. and the same bytes, once the word order is accounted for */
    const want = pmSwap(romBytes);
    const wrong = new Set();
    let diff = 0;
    for (let i = 0; i < want.length; i++) {
        if (img.bytes[i] === want[i]) continue;
        diff++;
        wrong.add(Math.floor(i / PM_WORD_BYTES));
    }
    if (diff) {
        const first = Math.min(...wrong);
        fail(`${b.name}: ${diff} bytes differ, in ${wrong.size} of ${words} PM words;`
            + ` first at PM ${hex(img.addr + first)}`
            + ` — assembled ${word(img.bytes, first)}, ROM ${word(want, first)}`);
    } else {
        console.log(`  image  ${words} PM words at ${hex(img.addr)}, byte for byte the ROM's`);
    }

    /* 4. and the offset it was cut from is measured rather than taken on trust:
     *    the image, put back into the ROM's word order, has to turn up in the
     *    program ROM exactly once — and there. */
    const inRom = occurrences(code, pmSwap(img.bytes));
    if (inRom.length !== 1) {
        fail(`${b.name}: the assembled image appears ${inRom.length} times in the program ROM`
            + (inRom.length ? ` (at ${inRom.map(hex).join(', ')})` : ''));
    } else if (inRom[0] !== b.offset) {
        fail(`${b.name}: the assembled image is at ${hex(inRom[0])} in the program ROM,`
            + ` but cpres.mjs cuts it from ${hex(b.offset)}`);
    } else {
        console.log(`  found  once in the program ROM, at ${hex(inRom[0])} — the offset cpres.mjs names`);
    }
}
console.log('');

console.log(bad ? `${bad} failure(s)` : 'the disassembly assembles to the two blobs the ROM carries');
process.exit(bad ? 1 : 0);
