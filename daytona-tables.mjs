/*
 * daytona-tables.mjs — find a Daytona USA build's own tables in its program ROM.
 *
 * There is no symbol table for this title and no decompilation, so every address
 * the explorer's profile carries was read off an instruction. Daytona shipped in
 * eight builds and MAME keeps them as one parent and seven clones; reading eight
 * program ROMs by hand would be eight chances to transcribe a number wrongly, so
 * this does what stf-tools' other checks do and finds each routine by the
 * instruction that names its table rather than by an address written down here.
 *
 * What it looks for, and the signature each is found by:
 *
 *   palette    `lda 0x1802000` — palette RAM at colorbase 0, which model2rd.ipp
 *              reads a face's colour from. The `lda` before it is the source and
 *              the one after is the end, so the count falls out of the pair.
 *   luma       `lda 0x12800000` — luma RAM. The `lda` after it is the band
 *              source and the `ld` after that the band count.
 *   texture    `lda 0x12200000` beside `lda 0x12600000` — the two sheets, which
 *              only the bank upload touches. Its callers give the bank table
 *              (`ld <table>[rX*4], g5`) and the boot bank (`lda <addr>, g5`).
 *   colorxlat  a store at +0x10000 from a base loaded with 0x1800000 — the R
 *              channel of colorxlat. The four constants of the branch taken when
 *              the mode word is zero are read out of the instructions before it.
 *   materials  a store at +0x60 from the geometry engine's base — function 6,
 *              geo_texture_parameters. The two `lda`s after it are the
 *              index/count pair and the coefficient array.
 *   view       the 24-byte records of {function, focal, focal, light x, y, z};
 *              the focal pair is 280.0 twice in every build, which is what makes
 *              the array findable at all.
 *   models     the model table, from the program ROM's own pointers into it:
 *              every one lands on a multiple of the stride from the base.
 *
 * Then it prints the block, so what goes into js/games.js is transcribed from a
 * run rather than typed.
 *
 *   node daytona-tables.mjs --rom F:/ROMs/daytona.zip
 *   node daytona-tables.mjs --rom a.zip --rom b.zip --as daytonase --check
 *
 * `--check` holds what it found against the profile the set loaded under and
 * fails on any disagreement, which is what makes it a check and not just a
 * report.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { disasm } from './i960dis.mjs';

/* The submodule by default, so a run measures the explorer this repository is
 * pinned to. $STF_SITE points it at a working checkout instead, which is what
 * deriving a new profile wants — the numbers this prints are the ones about to
 * go into that checkout's js/games.js, and the pin will not have them yet.
 * Same switch, same reason, as serve.mjs. */
const SITE = process.env.STF_SITE
    ? pathToFileURL(path.resolve(process.env.STF_SITE) + '/js/').href
    : new URL('./vendor/noclip/js/', import.meta.url).href;
const { loadRomSet } = await import(SITE + 'romset.js');

const argv = process.argv.slice(2);
const ROMS = argv.filter((a, i) => argv[i - 1] === '--rom');
const CHECK = argv.includes('--check');
/* Which build to load the set as. A merged archive is all eight at once, so
 * without this only the parent could ever be looked at. */
const AS = argv[argv.indexOf('--as') + 1];
const VERBOSE = argv.includes('--verbose');
if (!ROMS.length) {
    console.error('usage: node daytona-tables.mjs --rom <zip> [--rom <zip>] [--check]');
    process.exit(2);
}

const read = (p) => {
    const b = fs.readFileSync(p);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const rom = await loadRomSet(ROMS.map(read), () => {}, AS && argv.includes('--as') ? { game: AS } : {});
const cv = rom.mainCpuView;
const code = rom.maincpu;

/* ---- the program ROM as instructions ------------------------------------- */

/* Linear, not following flow: every signature below is a literal operand, and a
 * literal is in the stream whether or not the walk would reach it. */
const ins = [];
for (let a = 0; a < code.length; ) {
    let d;
    try { d = disasm(cv, a); } catch { a += 4; continue; }
    ins.push({ a, text: d.text });
    a += d.len > 0 ? d.len : 4;
}
const at = new Map(ins.map((x, i) => [x.a, i]));

const LDA = /^lda (0x[0-9a-f]+), ([gr]\d+)$/;
const imm = (i, re = LDA) => {
    const m = ins[i] && ins[i].text.match(re);
    return m ? parseInt(m[1], 16) : null;
};
const find = (re, from = 0) => {
    for (let i = from; i < ins.length; i++) if (re.test(ins[i].text)) return i;
    return -1;
};
const findAll = (re) => ins.map((x, i) => (re.test(x.text) ? i : -1)).filter((i) => i >= 0);
/* The nearest instruction matching `re` within `n` of index i, either way. */
const near = (i, re, n = 6, dir = 1) => {
    for (let k = 1; k <= n; k++) {
        const j = i + dir * k;
        if (ins[j] && re.test(ins[j].text)) return j;
    }
    return -1;
};

const out = {};
const notes = [];

/*
 * An address the program uses, as a region and an offset in it.
 *
 * The program ROM is visible at 0 and again at 0x00220000, which is the alias
 * its own pointers use; the data ROM is at 0x02000000. Which of the two a table
 * is in is not fixed across the builds — the 1993 version keeps its luma bands
 * and its material table in the program ROM, and every build after it moved
 * both into the data ROM — so every address is resolved rather than assumed.
 */
const resolveAddr = (v) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    if (v >= 0x02000000 && v < 0x02000000 + rom.mainData.length) {
        return { source: 'mainData', off: v - 0x02000000 };
    }
    if (v >= 0x00200000 && v - 0x200000 < code.length) return { source: 'maincpu', off: v - 0x200000 };
    if (v >= 0 && v < code.length) return { source: 'maincpu', off: v };
    return null;
};
const regionView = (src) => (src === 'maincpu' ? cv : rom.mainDataView);
const regionLen = (src) => (src === 'maincpu' ? code.length : rom.mainData.length);

/* ---- the face palette ---------------------------------------------------- */

{
    const i = find(/^lda 0x1802000, /);
    if (i < 0) notes.push('palette: no store to palette RAM at colorbase 0');
    else {
        const src = imm(near(i, LDA, 4, -1));
        const end = imm(near(i, LDA, 4, 1));
        if (src !== null && end !== null && end > src) {
            out.paletteOffset = src - 0x02000000;
            out.paletteCount = (end - src) >> 1;
        } else notes.push('palette: found the destination but not both ends');
    }
}

/* ---- luma RAM ------------------------------------------------------------ */

{
    /* Two routines name luma RAM: the boot clear, which writes a ramp it
     * computes, and the upload, which copies bands out of the program ROM. Only
     * the second is followed by both a source and a count, so take whichever
     * occurrence yields the pair. */
    const LD = /^ld (0x[0-9a-f]+), ([gr]\d+)$/;
    const hits = findAll(/^lda 0x12800000, /);
    if (!hits.length) notes.push('luma: no store to luma RAM');
    else {
        for (const i of hits) {
            const data = resolveAddr(imm(near(i, LDA, 4, 1)));
            const count = resolveAddr(imm(near(i, LD, 5, 1), LD));
            if (!data || !count || data.source !== count.source) continue;
            out.luma = { source: data.source, data: data.off, count: count.off };
            break;
        }
        if (!out.luma) notes.push('luma: found the destination but not the source pair');
    }
}

/* ---- the texture bank upload and its table ------------------------------- */

{
    const i = find(/^lda 0x12200000, /);
    const j = i >= 0 ? near(i, /^lda 0x12600000, /, 3, 1) : -1;
    if (j < 0) notes.push('texture: no routine writes both sheets');
    else {
        const routine = ins[i].a;
        out.textureRoutine = routine;
        const calls = findAll(new RegExp(`^call 0x${routine.toString(16)}$`));
        for (const c of calls) {
            const t = near(c, /^ld (0x[0-9a-f]+)\[[gr]\d+\*4\], g5$/, 6, -1);
            if (t >= 0) out.bankTable = parseInt(ins[t].text.match(/0x[0-9a-f]+/)[0], 16);
            const b = near(c, /^lda (0x[0-9a-f]+), g5$/, 6, -1);
            if (b >= 0) {
                const v = imm(b, /^lda (0x[0-9a-f]+), g5$/);
                if (v >= 0x02000000) out.bootBank = v;
            }
        }
        if (out.bankTable === undefined) notes.push('texture: no caller indexes a bank table');
    }
}

/* ---- colorxlat ----------------------------------------------------------- */

{
    const i = find(/^stos [gr]\d+, 0x10000\([gr]\d+\)$/);
    if (i < 0) notes.push('colorxlat: nothing writes the R channel');
    else {
        /* The zero branch of the mode test, which is what work RAM holds at
         * power-on: `mov step, 0, r9 / shlo a, b, r11 / lda bias / lda flat`. */
        let step = null, span = null, bias = null, flat = null;
        for (let k = i; k > i - 40 && k >= 0; k--) {
            const t = ins[k].text;
            let m;
            if (flat === null && (m = t.match(/^lda (0x[0-9a-f]+), r13$/))) flat = parseInt(m[1], 16);
            else if (bias === null && (m = t.match(/^lda (0x[0-9a-f]+), r12$/))) bias = parseInt(m[1], 16);
            else if (span === null && (m = t.match(/^shlo (\d+), (\d+), r11$/))) span = Number(m[2]) << Number(m[1]);
            else if (step === null && (m = t.match(/^mov (\d+), 0, r9$/))) step = Number(m[1]);
            if (step !== null && span !== null && bias !== null && flat !== null) break;
        }
        if (step !== null && span !== null && bias !== null && flat !== null) {
            out.ramp = { step, span, bias, flat };
        } else notes.push(`colorxlat: read step=${step} span=${span} bias=${bias} flat=${flat}`);
    }
}

/* ---- the material table -------------------------------------------------- */

{
    /* The engine's base is in g10 in every build seen, but take any register:
     * what identifies the upload is the function number in the displacement and
     * an index/count pair behind it. */
    const hits = findAll(/^st [gr]\d+, 0x60\([gr]\d+\)$/);
    if (!hits.length) notes.push('materials: nothing writes geometry-engine function 6');
    else {
        for (const i of hits) {
            const h = near(i, LDA, 4, 1);
            const head = resolveAddr(imm(h));
            if (!head || head.off + 8 > regionLen(head.source)) continue;
            const view = regionView(head.source);
            const index = view.getUint32(head.off, true);
            const count = view.getUint32(head.off + 4, true);
            /* geo_texture_parameters takes the index shifted up two and a count
             * of at most the engine's 32 slots. */
            if (index !== 0 || count === 0 || count > 32) continue;
            out.materials = { source: head.source, at: head.off + 8, count, stride: 4 };
            break;
        }
        if (!out.materials) notes.push('materials: found an upload but no index/count pair behind it');
    }
}

/* ---- the view records, and the light the main view uses ------------------ */

{
    const F280 = 0x438c0000;
    const hits = [];
    for (let a = 0; a + 24 <= code.length; a += 4) {
        if (cv.getUint32(a + 4, true) === F280 && cv.getUint32(a + 8, true) === F280) hits.push(a);
    }
    /* A run of them 24 apart is the array; the longest such run is it. */
    let best = null;
    for (const h of hits) {
        if (hits.includes(h - 24)) continue;
        let n = 0, a = h;
        while (hits.includes(a)) { n++; a += 24; }
        if (!best || n > best.n) best = { base: h, n };
    }
    if (!best || best.n < 2) notes.push('view: no array of records with a 280.0 focal pair');
    else {
        out.viewRecords = { at: best.base, count: best.n };
        const L = [0, 4, 8].map((k) => cv.getFloat32(best.base + 12 + k, true));
        out.light = [L[0], L[1], -L[2]];
    }
}

/* ---- the model table ----------------------------------------------------- */

/*
 * The table ends where the palette begins — that holds in every build — so the
 * question is only its stride and how far back it runs. Both come off the data:
 * step down from the palette by a candidate stride while what is there is still
 * a model record, and take the smallest stride that gives a long run. A record
 * is the four words the draw routine reads followed by the zero that ends the
 * list, and the filler in front of the table is neither.
 *
 * The pointers then have to agree: every word of the program ROM that points
 * into the range found must land on an entry of that stride, or the stride is
 * wrong.
 */
{
    const palAddr = out.paletteOffset !== undefined ? out.paletteOffset + 0x02000000 : null;
    const dv = rom.mainDataView;
    const pw = rom.polygons.length / 4;
    const unitNormal = (off) => {
        if (off < 0 || off + 40 > rom.polygons.length) return false;
        let m = 0;
        for (const k of [28, 32, 36]) { const v = rom.polygonsView.getFloat32(off + k, true); m += v * v; }
        return Math.abs(m - 1) < 0.02;
    };
    /* A record the draw routine would walk: the list terminator at the end of
     * the entry, and an object address that is either nothing, a mesh in the
     * polygon ROM opening on a unit normal, or a slow-polygon-RAM address for
     * something built at run time. */
    const isEntry = (addr, stride) => {
        const o = addr - 0x02000000;
        if (o < 0 || o + stride > rom.mainData.length) return false;
        if (dv.getUint32(o + stride - 4, true) !== 0) return false;
        const mesh = dv.getUint32(o, true);
        if (mesh === 0) return true;
        if (mesh >= 0x800000 && mesh < 0x800000 + pw) return unitNormal((mesh - 0x800000) * 4);
        return mesh < 0x8000;
    };

    const words = [];
    for (let a = 0; a + 4 <= code.length; a += 4) words.push(cv.getUint32(a, true));

    if (palAddr === null) notes.push('models: no palette, so no end to work back from');
    else {
        let found = null;
        for (let stride = 4; stride <= 64 && !found; stride += 4) {
            /* An empty entry is ordinary — the table is sparse — but a long run
             * of them is not a table at all, it is the zero padding in front of
             * one. Daytona USA Special Edition has 1192 zero entries below its
             * table and the Saturn-advert build 200, and taking them would have
             * given those two a table a thousand entries longer than the models
             * they carry. So the walk stops at a run this long and the base is
             * the lowest entry that names a mesh. */
            const EMPTY_RUN = 64;
            let a = palAddr, n = 0, run = 0, lastReal = palAddr, realN = 0;
            while (a - stride > 0x02000000 && isEntry(a - stride, stride) && n < 0x20000) {
                a -= stride;
                n++;
                if (dv.getUint32(a - 0x02000000, true) === 0) {
                    if (++run >= EMPTY_RUN) break;
                } else {
                    run = 0;
                    lastReal = a;
                    realN = n;
                }
            }
            a = lastReal;
            n = realN;
            if (n < 64) continue;
            const inRange = [...new Set(words.filter((v) => v >= a && v <= palAddr))];
            if (inRange.length < 8) continue;
            if (inRange.some((v) => (palAddr - v) % stride !== 0)) continue;
            found = { base: a, stride, count: n, pointers: inRange.length };
        }
        if (!found) notes.push('models: no stride steps back from the palette over a run of records');
        else {
            out.modelTable = {
                offset: found.base - 0x02000000,
                stride: found.stride,
                count: found.count,
                pointers: found.pointers,
            };
        }
    }
}

/* ---- the courses -------------------------------------------------------- */

/*
 * A course is a 16x16 grid of 128-unit blocks and one model per block, drawn
 * with no matrix at all (dsp_area_block). So a course table is 256 consecutive
 * pointers into the model table and nothing else is, which makes it findable
 * without reading a line of code: find the run, then find the array that names
 * the runs. The array is in the data ROM for every build but the 1993 one,
 * which keeps it in the program ROM, so both are looked in.
 */
{
    const dv = rom.mainDataView;
    const t = rom.game.modelTable;
    const M = out.modelTable ?? { offset: t.offset, stride: t.stride, count: t.count };
    const base = 0x02000000 + M.offset;
    const end = base + M.count * M.stride;
    const isEntryPtr = (p) => p >= base && p < end && (p - base) % M.stride === 0;

    /* The longest run of consecutive entry pointers; a course is 256 of them
     * and the builds all keep their courses back to back. */
    let best = null, run = -1;
    for (let off = 0; off + 4 <= rom.mainData.length; off += 4) {
        if (isEntryPtr(dv.getUint32(off, true))) { if (run < 0) run = off; continue; }
        if (run >= 0) {
            const n = (off - run) / 4;
            if (n >= 256 && (!best || n > best.n)) best = { off: run, n };
            run = -1;
        }
    }
    if (!best) notes.push('courses: no run of 256 model pointers in the data ROM');
    else {
        const count = Math.floor(best.n / 256);
        out.courseBlocks = { at: best.off, tables: count };
        /* The array that names them: a word equal to the first table's address,
         * in either region. */
        const want = 0x02000000 + best.off;
        let at = null, source = null;
        for (let o = 0; o + 4 <= rom.mainData.length && at === null; o += 4) {
            if (dv.getUint32(o, true) === want) { at = o; source = 'mainData'; }
        }
        for (let o = 0; o + 4 <= code.length && at === null; o += 4) {
            if (cv.getUint32(o, true) === want) { at = o; source = 'maincpu'; }
        }
        if (at === null) notes.push('courses: found the block tables but not the array that names them');
        else out.courses = { source, at };
    }
}

/* ---- report -------------------------------------------------------------- */

console.log(`set          ${ROMS.join(' + ')}`);
console.log(`loaded as    ${rom.game.name} (${rom.game.id})`);
console.log('');
const hex = (v) => (typeof v === 'number' ? `0x${v.toString(16)}` : String(v));
const M = out.modelTable;
if (M) {
    console.log(`modelTable   { offset: ${hex(M.offset)}, count: ${M.count}, stride: ${M.stride} }`);
    console.log(`             ${M.pointers} of the program ROM's pointers land on an entry`);
}
if (out.paletteOffset !== undefined) {
    console.log(`palette      offset ${hex(out.paletteOffset)}, ${out.paletteCount} entries`);
}
if (out.bankTable !== undefined) {
    const banks = [];
    for (let s = 0; s < 8 && out.bankTable + s * 4 + 4 <= code.length; s++) {
        const v = cv.getUint32(out.bankTable + s * 4, true);
        if (v < 0x02000000 || v >= 0x02000000 + rom.mainData.length) break;
        banks.push(hex(v));
    }
    console.log(`texture      raw: { bankTable: ${hex(out.bankTable)}, bootBank: ${hex(out.bootBank)} }`);
    console.log(`             routine at ${hex(out.textureRoutine)}, banks ${banks.join(' ')}`);
}
if (out.luma) {
    console.log(`luma         { source: '${out.luma.source}', count: ${hex(out.luma.count)}, `
        + `data: ${hex(out.luma.data)} }`);
}
if (out.ramp) {
    console.log(`ramp         { step: ${out.ramp.step}, span: ${hex(out.ramp.span)}, `
        + `bias: ${hex(out.ramp.bias)}, flat: ${hex(out.ramp.flat)} }`);
}
if (out.materials) {
    console.log(`materials    { source: '${out.materials.source}', at: ${hex(out.materials.at)}, `
        + `count: ${out.materials.count}, stride: 4 }`);
}
if (out.light) {
    console.log(`light        [${out.light.map((v) => v.toFixed(4)).join(', ')}]  `
        + `(${out.viewRecords.count} view records at ${hex(out.viewRecords.at)})`);
}
if (out.courses) {
    const av = out.courses.source === 'maincpu' ? cv : rom.mainDataView;
    const seen = new Set();
    const ids = [];
    for (let c = 0; c < 4; c++) {
        const p = av.getUint32(out.courses.at + c * 4, true);
        ids.push(seen.has(p) ? 'repeat' : `${((rom.mainDataView.getUint32(p - 0x02000000, true)
            - 0x02000000 - (out.modelTable?.offset ?? 0)) / 20)}`);
        seen.add(p);
    }
    console.log(`courses      { source: '${out.courses.source}', at: ${hex(out.courses.at)} } — `
        + `${out.courseBlocks.tables} block tables at ${hex(out.courseBlocks.at)}, opening on models ${ids.join(', ')}`);
}
for (const n of notes) console.log(`note         ${n}`);

if (VERBOSE) console.log('\n' + JSON.stringify(out, null, 2));

/* ---- held against the profile the set loaded under ----------------------- */

if (CHECK) {
    let bad = 0;
    const g = rom.game;
    /* Key order is not a difference, so compare the sorted shape. */
    const norm = (v) => (v && typeof v === 'object' && !Array.isArray(v)
        ? JSON.stringify(Object.keys(v).sort().map((k) => [k, v[k]]))
        : JSON.stringify(v));
    const eq = (what, got, want) => {
        const ok = norm(got) === norm(want);
        if (!ok) { console.log(`FAIL: ${what}: found ${JSON.stringify(got)}, profile has ${JSON.stringify(want)}`); bad++; }
        return ok;
    };
    console.log('');
    eq('modelTable.offset', M?.offset, g.modelTable.offset);
    eq('modelTable.count', M?.count, g.modelTable.count);
    eq('modelTable.stride', M?.stride, g.modelTable.stride);
    eq('paletteOffset', out.paletteOffset, g.paletteOffset);
    eq('paletteCount', out.paletteCount, g.paletteCount);
    eq('texture.raw.bankTable', out.bankTable, g.texture.raw.bankTable);
    eq('texture.raw.bootBank', out.bootBank, g.texture.raw.bootBank);
    eq('colors.luma', out.luma,
        { source: g.colors.luma.source ?? 'mainData', count: g.colors.luma.count, data: g.colors.luma.data });
    eq('colors.ramp', out.ramp, g.colors.ramp);
    eq('lighting.materials', out.materials,
        { source: g.lighting.materials.source ?? 'maincpu', at: g.lighting.materials.at,
            count: g.lighting.materials.count, stride: g.lighting.materials.stride });
    eq('lighting.light', out.light?.map((v) => Math.round(v * 1e6) / 1e6),
        g.lighting.light.map((v) => Math.round(v * 1e6) / 1e6));
    eq('stageTable.courses', out.courses,
        { source: g.stageTable.courses.source, at: g.stageTable.courses.at });
    console.log(bad ? `\n${bad} failed` : '\nevery number the profile carries is one this run found');
    process.exit(bad ? 1 : 0);
}
