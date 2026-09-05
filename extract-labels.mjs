/* Recover the board's own symbol table out of a Lost Judgment / YAMP port DLL.
 *
 * Sega shipped these ports with the original i960 symbol table still inside the
 * host DLL: a run of 16-byte records in `.rdata`, each one a board-side offset
 * and a pointer to the C string that names it. `start_ip` is the first, at
 * offset 0xB0, and 799 more follow it in ascending order. Nothing in the DLL
 * points at those strings — they are reached through the table — so a string
 * search finds the names and loses the addresses, which is why this walks the
 * records instead.
 *
 *   node extract-labels.mjs --dll stf-pxd-w64-d3d12_retail.dll
 *   node extract-labels.mjs --dll <dll> --list          # the .list rendering
 *   node extract-labels.mjs --dll <dll> --pairs         # offset-labels/*.txt
 *   node extract-labels.mjs --dll <dll> --names         # just the names
 *   node extract-labels.mjs --dll <dll> --merge sfight.json --out sfight.json
 *   node extract-labels.mjs --dll <dll> --check sfight.json
 *   node extract-labels.mjs --dll <dll> --tables        # every run found, nothing emitted
 *
 * The output is the `labels` object of `generate-json`'s per-game JSON —
 * `labels.segment.<segment>.offset-label`, keyed by `0x` and upper-case hex
 * with no padding, in table order. `--merge` splices exactly that object into
 * an existing file and leaves the rest of it alone.
 *
 * The table is found by shape rather than by address, so the same command works
 * on the other ports beside it: a record is a plausible board offset next to a
 * pointer to an identifier-shaped string, and the table is the longest unbroken
 * run of them whose offsets never go backwards. Nothing here is keyed to a
 * build, and a DLL with no such run says so rather than guessing.
 *
 * What comes out was measured against the hand-transcribed label files that
 * predate this, and is a superset of them. Sonic the Fighters, Fighting Vipers
 * and Virtual-On reproduce byte for byte; the two that differ differ only by
 * records the hand pass had dropped, each checked back against the DLL —
 * Virtua Fighter 2's `0x313D8 chk_input`, sitting in order between `yasi_disp`
 * and `sel_disp`, and Motor Raid's first two records and its last. Nothing is
 * missing from any of the five.
 */
import fs from 'node:fs';

/* Where a board offset lands. Model 2 program ROM is at 0 and work RAM at
 * 0x500000; `generate-json` lists every symbol under `maincpu` and repeats the
 * RAM ones under `workram`, so a segment here is a filter, not a partition. */
const SEGMENTS = [
    { name: 'maincpu', from: 0x000000, to: 0x1000000 },
    { name: 'workram', from: 0x500000, to: 0x600000 },
];

/* A record is (u64 offset, u64 name pointer). The offset is a board address, so
 * the bound is the i960's whole 32-bit space rather than the size of any one
 * region — Motor Raid's table reaches 0x6CD4AC0, and anything tighter cuts it
 * off partway. It still excludes a host pointer, which is above 0x180000000. */
const MAX_OFFSET = 0x100000000;
/* Shorter than this is a coincidence, not a symbol table. */
const MIN_RUN = 32;
/* A name is an assembler label, which is wider than a C identifier: Motor
 * Raid's table carries `LFC0._am1_users2_yasuda_mb_src_tachoput` and Fighting
 * Vipers' carries `kanban_dsp:` with the colon still on it. Both are real
 * symbols and dropping them would split the table in two. */
const NAME = /^[A-Za-z_][A-Za-z0-9_.$@]*:?$/;
const MAX_NAME = 79;
/* What separates a symbol table from the other (value, string) tables a C++
 * runtime leaves in .rdata: the locale tables next door are the same shape but
 * every name in them is one letter. A symbol table's names are words. */
const MIN_MEAN_NAME = 4;

/* ---- the PE image ---- */

/* Just enough of a PE32+ to map a virtual address back to a file offset. */
function readPE(buf) {
    if (buf.readUInt16LE(0) !== 0x5a4d) throw new Error('not a PE: no MZ');
    const pe = buf.readUInt32LE(0x3c);
    if (buf.readUInt32LE(pe) !== 0x00004550) throw new Error('not a PE: no PE signature');
    const nSections = buf.readUInt16LE(pe + 6);
    const optSize = buf.readUInt16LE(pe + 20);
    const opt = pe + 24;
    const magic = buf.readUInt16LE(opt);
    if (magic !== 0x20b) throw new Error(`not PE32+ (optional header magic 0x${magic.toString(16)})`);
    const imageBase = buf.readBigUInt64LE(opt + 24);
    const sections = [];
    for (let i = 0; i < nSections; i++) {
        const s = opt + optSize + i * 40;
        const vsize = buf.readUInt32LE(s + 8);
        const rawSize = buf.readUInt32LE(s + 16);
        sections.push({
            name: buf.subarray(s, s + 8).toString('latin1').replace(/\0+$/, ''),
            va: imageBase + BigInt(buf.readUInt32LE(s + 12)),
            raw: buf.readUInt32LE(s + 20),
            /* Only what the file actually carries is addressable here: a .bss
             * that is longer virtually than on disk would otherwise read the
             * section that follows it. */
            size: Math.min(vsize || rawSize, rawSize),
        });
    }
    return { imageBase, sections };
}

/* The file offset a virtual address names, or null if it is outside the image
 * or in a part of a section the file does not carry. */
function at(pe, va) {
    for (const s of pe.sections) {
        if (va >= s.va && va < s.va + BigInt(s.size)) {
            return { off: s.raw + Number(va - s.va), end: s.raw + s.size };
        }
    }
    return null;
}

/* The NUL-terminated identifier at a virtual address, or null. */
function nameAt(pe, buf, va) {
    const p = at(pe, va);
    if (!p) return null;
    const end = buf.indexOf(0, p.off);
    if (end < 0 || end === p.off || end > p.off + MAX_NAME || end >= p.end) return null;
    const s = buf.toString('latin1', p.off, end);
    return NAME.test(s) ? s : null;
}

/* ---- the table ---- */

/* Every run of consecutive well-formed records, longest first. Records are 16
 * bytes and 8-byte aligned, so both alignments are walked. */
function findTables(pe, buf) {
    const runs = [];
    for (const s of pe.sections) {
        if (!s.size) continue;
        const limit = s.raw + s.size;
        for (const phase of [0, 8]) {
            let run = null;
            const close = () => {
                if (run && run.rows.length >= MIN_RUN
                    && run.rows.reduce((n, r) => n + r.name.length, 0) / run.rows.length >= MIN_MEAN_NAME) {
                    runs.push(run);
                }
                run = null;
            };
            for (let off = s.raw + phase; off + 16 <= limit; off += 16) {
                const value = buf.readBigUInt64LE(off);
                const name = value < BigInt(MAX_OFFSET)
                    ? nameAt(pe, buf, buf.readBigUInt64LE(off + 8)) : null;
                if (name === null) { close(); continue; }
                /* An offset that goes backwards ends the run and starts a new
                 * one at the same record, rather than dropping it. */
                if (run && value < run.last) close();
                if (!run) run = { va: s.va + BigInt(off - s.raw), section: s.name, rows: [] };
                run.rows.push({ offset: Number(value), name });
                run.last = value;
            }
            close();
        }
    }
    return runs.sort((a, b) => b.rows.length - a.rows.length);
}

/* ---- rendering ---- */

const hex = (n) => '0x' + n.toString(16).toUpperCase();

function labels(rows) {
    const segment = {};
    for (const seg of SEGMENTS) {
        const inSeg = rows.filter((r) => r.offset >= seg.from && r.offset < seg.to);
        if (!inSeg.length) continue;
        const map = {};
        for (const r of inSeg) map[hex(r.offset)] = r.name;
        segment[seg.name] = { 'offset-label': map };
    }
    return { segment };
}

/* `generate-json`'s .list rendering of the same object. */
function renderList(rows) {
    const out = ['labels', '  segment'];
    for (const [seg, body] of Object.entries(labels(rows).segment)) {
        out.push(`    ${seg}`, '      offset-label');
        for (const [k, v] of Object.entries(body['offset-label'])) out.push(`        ${k} = ${v}`);
    }
    return out.join('\n');
}

/* ---- the command ---- */

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d = null) => { const i = argv.indexOf(n); return i < 0 || i + 1 >= argv.length ? d : argv[i + 1]; };

/* The header comment above is the help text; there is no second copy of it. */
const usage = () => fs.readFileSync(new URL(import.meta.url), 'utf8')
    .split('*/')[0].replace(/^\/\* ?/, '').replace(/^ \*[ ]?/gm, '').trimEnd() + '\n';

const dll = opt('--dll');
if (!dll || flag('--help')) {
    process.stdout.write(usage());
    process.exit(dll ? 0 : 1);
}

const buf = fs.readFileSync(dll);
const tables = findTables(readPE(buf), buf);

if (flag('--tables')) {
    if (!tables.length) console.log('no symbol table found');
    for (const t of tables) {
        const [a, z] = [t.rows[0], t.rows.at(-1)];
        console.log(`${t.va.toString(16)} in ${t.section}: ${t.rows.length} records, ` +
            `${hex(a.offset)} ${a.name} .. ${hex(z.offset)} ${z.name}`);
    }
    process.exit(0);
}

if (!tables.length) {
    console.error(`${dll}: no run of at least ${MIN_RUN} symbol records — this DLL does not carry a table, or it is not shaped like one`);
    process.exit(1);
}
const rows = tables[0].rows;

/* No trailing newline: the files this reproduces do not carry one, and every
 * format below comes out byte for byte identical to the hand-made copy in
 * `generate-json`, so a rewrite of one of them is an empty diff. */
const write = (text) => {
    const out = opt('--out');
    if (out) { fs.writeFileSync(out, text); console.error(`${out}: ${rows.length} symbols`); }
    else process.stdout.write(text);
};

if (flag('--check')) {
    const want = JSON.parse(fs.readFileSync(opt('--check'), 'utf8'))?.labels?.segment ?? {};
    const got = labels(rows).segment;
    let bad = 0;
    for (const seg of new Set([...Object.keys(want), ...Object.keys(got)])) {
        const a = want[seg]?.['offset-label'] ?? {};
        const b = got[seg]?.['offset-label'] ?? {};
        let differed = 0;
        for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
            if (a[k] !== b[k]) {
                console.log(`${seg} ${k}: reference ${a[k] ?? '(absent)'} != recovered ${b[k] ?? '(absent)'}`);
                differed++;
            }
        }
        if (!differed) console.log(`${seg}: ${Object.keys(b).length} symbols, all matching`);
        bad += differed;
    }
    process.exit(bad ? 1 : 0);
}

if (flag('--merge')) {
    const doc = JSON.parse(fs.readFileSync(opt('--merge'), 'utf8'));
    doc.labels = labels(rows);
    write(JSON.stringify(doc, null, 2));
} else if (flag('--list')) {
    write(renderList(rows));
} else if (flag('--pairs')) {
    write(rows.map((r) => `${hex(r.offset)}\n${r.name}`).join('\n'));
} else if (flag('--names')) {
    write(rows.map((r) => r.name).join('\n'));
} else {
    write(JSON.stringify({ labels: labels(rows) }, null, 2));
}
