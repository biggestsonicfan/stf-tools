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
 *   courses    256 consecutive model pointers per course, and the array that
 *              names the runs.
 *   objects    the trackside objects: the table of course tables by its shape,
 *              each routine named by the record that starts in it, and each
 *              table a routine reads by the instruction that reads it.
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

/* ---- the trackside objects ------------------------------------------------ */

/*
 * What stands along a course besides its blocks: a table per course, a pointer
 * per grid block, and behind each a count and that many 24-byte records —
 * {x, y, z, angle, id, init, arg} — each of which becomes a task that draws
 * one object. See js/daytona.js for the layout and for what each routine draws.
 *
 * The names. Sega Racing Classic's d1a.exe carries the board's own names for
 * the object routines (`ship`, `slot`, `jeffly`, `tori`, `uma` ...), and its
 * program is a later build of the same one. The builds do not keep their
 * tables at one address, so a name cannot be carried across by address. It is
 * carried by record instead: all eight builds place the same 130 records in
 * the same order, so the routine the Nth record starts in is the same routine
 * in every build. OBJECT_RUNS is that order, read once off the Ringwide build
 * with its names, and a build is only named from it if no routine ends up with
 * two names.
 *
 * Then the tables. None is found by looking at data: each is the operand of
 * the instruction in its routine that reads it, which is the one thing the
 * routine cannot be wrong about.
 */
const OBJECT_RUNS = [
    [['sub_213b0', 1], ['sub_217cc', 10], ['sub_216e4', 1], ['maku_int', 1], ['rank_int', 1],
        ['sub_20118', 1], ['rou2_int', 1], ['sub_201bc', 14], ['z_kaitenn_int', 1], ['sub_20118', 1],
        ['sub_21f0c', 1], ['sub_201bc', 1], ['slot_int', 1]],
    [['sub_213b0', 1], ['sub_217cc', 9], ['sub_21730', 3], ['sub_21764', 8], ['sub_21798', 12],
        ['sub_21764', 3], ['sub_216e4', 1], ['check_point_int', 1], ['uma_int', 5], ['uma_end_int', 1],
        ['arcade_window_int', 1], ['wall_int', 1], ['tori_int', 2], ['check_point_int', 1], ['tori_int', 2],
        ['bb_int', 1], ['ctykya_int', 1], ['check_point_int', 4], ['tori_syumi_int', 6]],
    [['sub_213b0', 1], ['sub_21730', 3], ['sub_21764', 4], ['sub_21798', 8], ['sub_216e4', 1],
        ['wing_int', 1], ['water_int', 1], ['check_point_int', 1], ['hata_3_int', 1], ['ship_int', 1],
        ['light2_int', 1], ['sub_201bc', 6], ['check_point_int', 1], ['light_int', 1], ['check_point_int', 1]],
];
/* What js/daytona.js draws for each. `none` is a routine that draws nothing in
 * any state the explorer shows; `runs` calls the routine its argument names.
 * Three are refined per routine below, by what the routine's own code does:
 * sub_201bc, check_point_int and rou2_int are written differently in 1993. */
const OBJECT_KIND = {
    sub_213b0: 'none', sub_216e4: 'runs', sub_217cc: 'pylon', sub_21730: 'pylon', sub_21764: 'pylon',
    sub_21798: 'pylon', maku_int: 'world', rank_int: 'rank', sub_20118: 'static', rou2_int: 'spinY',
    sub_201bc: 'cycle', z_kaitenn_int: 'spinZ', sub_21f0c: 'window', slot_int: 'slot',
    check_point_int: 'checkpoint', uma_int: 'horse', uma_end_int: 'curtainCall', arcade_window_int: 'window',
    wall_int: 'world', tori_int: 'birds', bb_int: 'bigBird', ctykya_int: 'crowd', tori_syumi_int: 'flock',
    wing_int: 'windmill', water_int: 'light', hata_3_int: 'flags', ship_int: 'ship', light2_int: 'light',
    light_int: 'light', jeffly_int: 'jeffry',
};
{
    const ALIAS = 0x200000;
    const P = (v) => (v >= ALIAS && v < ALIAS + code.length ? v - ALIAS : -1);
    const CODE = (v) => P(v) >= 0x20000;
    /* One course's records: 256 pointers to count-prefixed runs of records
     * whose init field is code — null if that is not what is there. */
    const records = (tab) => {
        if (tab < 0 || tab + 1024 > code.length) return null;
        const recs = [];
        for (let b = 0; b < 256; b++) {
            const g = cv.getUint32(tab + b * 4, true);
            if (!g) continue;
            const ga = P(g);
            if (ga < 0) return null;
            const n = cv.getUint32(ga, true);
            if (n < 1 || n > 64) return null;
            for (let i = 0; i < n; i++) {
                const r = ga + 4 + i * 24;
                const init = cv.getUint32(r + 16, true);
                if (!CODE(init)) return null;
                recs.push({ init: P(init), arg: cv.getUint32(r + 20, true) });
            }
        }
        return recs;
    };
    /* The table of course tables, by that shape alone. */
    let at = null, courses = null;
    for (let a = 0; a + 16 <= code.length && at === null; a += 4) {
        const t = [0, 1, 2].map((k) => P(cv.getUint32(a + k * 4, true)));
        if (t.some((x) => x < 0)) continue;
        const r = t.map(records);
        if (r.every((x) => x && x.length)) { at = a; courses = r; }
    }
    const want = OBJECT_RUNS.map((runs) => runs.reduce((n, [, k]) => n + k, 0));
    if (at === null) notes.push('objects: no four-course table of object records');
    else if (courses.some((c, i) => c.length !== want[i])) {
        notes.push(`objects: table at 0x${at.toString(16)} holds ${courses.map((c) => c.length).join('/')} `
            + `records where the named order has ${want.join('/')}`);
    } else {
        /*
         * Name each routine by the records that start in it. A name may cover
         * more than one routine — the 1993 build gives every check point a
         * routine of its own — but no routine may have two names, which would
         * mean the order does not fit this build at all.
         */
        const byName = new Map(), byInit = new Map();
        let clash = null;
        const name = (n, init) => {
            if ((byInit.get(init) ?? n) !== n) clash ??= `0x${init.toString(16)} is both ${byInit.get(init)} and ${n}`;
            if (!byName.has(n)) byName.set(n, []);
            if (!byName.get(n).includes(init)) byName.get(n).push(init);
            byInit.set(init, n);
        };
        courses.forEach((recs, c) => {
            let i = 0;
            for (const [n, count] of OBJECT_RUNS[c]) for (let k = 0; k < count; k++, i++) name(n, recs[i].init);
        });
        /* The one argument of sub_216e4's that is code is jeffly_int. */
        for (const recs of courses) {
            for (const r of recs) if (byInit.get(r.init) === 'sub_216e4' && CODE(r.arg)) name('jeffly_int', P(r.arg));
        }
        if (clash) {
            notes.push(`objects: the records do not name one routine each (${clash}) — `
                + 'this build does not lay its objects out as the others do, and has none in the profile');
        } else {
            /* A routine as instructions, from its entry to the ret no branch
             * seen so far jumps past. */
            /* 0x2000 is room for the longest there is, 1993's crowd, which is
             * written out an instruction at a time. */
            const routine = (a0) => {
                const list = [];
                if (a0 === null || a0 === undefined || a0 < 0) return list;
                let furthest = a0;
                for (let a = a0; a < a0 + 0x2000;) {
                    const d = disasm(cv, a);
                    list.push({ a, text: d.text });
                    if (d.target !== null && d.top >= 0x08 && d.top <= 0x3f && d.top !== 0x09) {
                        furthest = Math.max(furthest, d.target);
                    }
                    a += d.len > 0 ? d.len : 4;
                    if (d.text === 'ret' && a > furthest) break;
                }
                return list;
            };
            /* The display routine an init installs: the code address it
             * stores as the task's next step. */
            const displayOf = (init) => {
                const r = routine(init);
                for (let k = 0; k + 1 < r.length; k++) {
                    const m = r[k].text.match(/^lda (0x[0-9a-f]+), (r\d+)$/);
                    if (m && CODE(parseInt(m[1], 16))
                        && new RegExp(`^st ${m[2]}, 0x(c|14)\\(g13\\)$`).test(r[k + 1].text)) {
                        return P(parseInt(m[1], 16));
                    }
                }
                return null;
            };
            const inits = (n) => byName.get(n) ?? [];
            const display = (n) => displayOf(inits(n)[0]);
            /* Every operand of `re` in a routine, as numbers. */
            const operands = (a, re) => routine(a)
                .map((x) => x.text.match(re)).filter(Boolean).map((m) => parseInt(m[1], 16));
            const one = (what, list) => {
                list = [...new Set(list)];
                if (list.length !== 1) { notes.push(`objects: ${what}: ${list.length} candidates`); return null; }
                return list[0];
            };
            const PT = '(0x2[0-9a-f]{5})';        /* the program ROM, through its alias */
            const DT = '(0x2[89][0-9a-f]{5})';    /* the data ROM's model records */
            const ld = (reg) => new RegExp(`^ld ${PT}\\[r\\d+\\*4\\], ${reg}$`);
            const f32 = (u) => { const b = new DataView(new ArrayBuffer(4)); b.setUint32(0, u, true); return b.getFloat32(0, true); };
            const s16 = (u) => (u << 16) >> 16;

            const O = { at, kinds: {} };
            for (const [n, list] of byName) for (const init of list) O.kinds[init] = OBJECT_KIND[n];

            /* sub_201bc: `ld <array>[sel_course*4]` — a table per course of
             * {list, count, divisor}. 1993 has a second routine by this name
             * that reads no table and walks a four-model list of its own. */
            const cycleTables = [];
            for (const init of inits('sub_201bc')) {
                const table = operands(init, ld('r\\d+'));
                if (table.length) { cycleTables.push(...table); continue; }
                O.kinds[init] = 'cycle4';
                (O.lists ??= {})[init] = one(`cycle4 0x${init.toString(16)}`, operands(displayOf(init), ld('g0')));
            }
            O.cycles = one('cycles', cycleTables);

            /* check_point_int: from Revision A on, one routine and a table
             * indexed by the record's id; in 1993, a routine per check point
             * with its numbers inline — a scale `lda`'d into r6 before the X/Z
             * scale, the list the record names or one the routine does, or no
             * matrix at all. */
            const checkTables = [];
            for (const init of inits('check_point_int')) {
                const table = operands(init, new RegExp(`^lda ${PT}\\[r\\d+\\*4\\], r\\d+$`));
                if (table.length) { checkTables.push(...table); continue; }
                const d = routine(displayOf(init)).map((x) => x.text);
                const scale = d.map((t) => t.match(/^lda (0x[0-9a-f]+), r6$/)).find(Boolean);
                const list = d.map((t) => t.match(ld('g0'))).find(Boolean);
                const world = !d.includes('lda 0x1212, g14');
                O.kinds[init] = 'checkpointAt';
                (O.checkpointsAt ??= {})[init] = {
                    scale: world || !scale ? 1 : Math.round(f32(parseInt(scale[1], 16)) * 1e6) / 1e6,
                    list: list ? parseInt(list[1], 16) : null,
                    world,
                };
            }
            if (checkTables.length) O.checkpoints = one('checkpoints', checkTables);

            /* rou2: which way the dice turn, as the routine writes it — a
             * `subi` of 0x100 from Revision A on, an `addi` in 1993. The first
             * one decides: 1993 lays an unused copy that subtracts straight
             * after its own, and the walk runs on into it. */
            {
                const d = routine(display('rou2_int')).map((x) => x.text)
                    .find((x) => x === 'subi r7, r6, r6' || x === 'addi r7, r6, r6');
                O.spinY = d === 'subi r7, r6, r6' ? -0x100 : d ? 0x100 : null;
                if (O.spinY === null) notes.push('objects: rou2 neither adds nor takes its turn');
            }

            /* rank: its five places, walked 12 bytes at a time, and the table
             * of each car's number, indexed by car id. */
            O.rankBoard = one('rankBoard', operands(display('rank_int'), new RegExp(`^lda ${PT}, r14$`)));
            O.rankCars = one('rankCars', operands(display('rank_int'), new RegExp(`^lda ${PT}\\[r6\\*4\\], r6$`)));
            /* wing: the sails' list and the two parts that do not turn. Its
             * attract and race branches draw the same three. */
            O.windmill = {
                sails: one('windmill sails', operands(display('wing_int'), ld('g0'))),
                still: [...new Set(operands(display('wing_int'), new RegExp(`^lda ${DT}, g0$`)))],
            };
            /* bb draws the flock's own wing table. */
            O.birds = one('birds', operands(display('bb_int'), ld('g0')));
            O.horses = one('horses', operands(display('uma_int'), ld('g0')));
            O.jeffry = one('jeffry', operands(display('jeffly_int'), new RegExp(`^lda ${DT}, g0$`)));

            /*
             * ctykya: the crowds. The Special Edition keeps them in a table of
             * {from, to, count, list} walked by `cmpinco <last>`; Revision A
             * has one, its count a `mov` and its list an `lda`; and 1993 writes
             * both out an instruction at a time, which is traced — each push to
             * pop is a group, its translate and turns the registers the TGP
             * calls were handed, its list the `ld` that picks the model.
             */
            {
                const r = routine(display('ctykya_int'));
                const texts = r.map((x) => x.text);
                const table = texts.map((t) => t.match(new RegExp(`^lda ${PT}\\[r\\d+\\*16\\], r\\d+$`))).find(Boolean);
                const last = texts.map((t) => t.match(/^cmpinco (\d+), r\d+, r\d+$/)).find(Boolean);
                const count = texts.map((t) => t.match(/^mov (\d+), 0, r10$/)).find(Boolean);
                const list = texts.map((t) => t.match(new RegExp(`^lda ${PT}\\[r\\d+\\*4\\], r11$`))).find(Boolean);
                if (table && last) {
                    const t = parseInt(table[1], 16);
                    O.crowds = [];
                    for (let s = 0; s <= +last[1]; s++) {
                        O.crowds.push({
                            list: cv.getUint32(P(t) + s * 16 + 12, true),
                            count: cv.getUint32(P(t) + s * 16 + 8, true),
                        });
                    }
                } else if (count && list) {
                    O.crowds = [{ list: parseInt(list[1], 16), count: +count[1] }];
                } else {
                    const groups = traceGroups(texts, PT);
                    if (groups.length) O.crowds = [{ groups }];
                    else notes.push('objects: crowds: no form of ctykya this knows');
                }
            }
            /* The four pylon kinds differ in the descriptor each installs at
             * +0x5C, whose second float is how high the model stands. Each is
             * a few instructions and a branch into the code they share, which
             * is laid out after all four — so the walk from one reaches the
             * others' too, and only the first store is its own. */
            O.pylons = {};
            for (const n of ['sub_217cc', 'sub_21730', 'sub_21764', 'sub_21798']) {
                for (const init of inits(n)) {
                    const r = routine(init);
                    for (let k = 0; k + 1 < r.length; k++) {
                        const m = r[k].text.match(new RegExp(`^lda ${DT}, r3$`));
                        if (m && r[k + 1].text === 'st r3, 0x5c(g13)') {
                            O.pylons[init] = parseInt(m[1], 16);
                            break;
                        }
                    }
                }
            }
            out.objects = O;
            out.objectRecords = courses.map((c) => c.length);

            /* The trace: registers loaded with `lda`, a TGP call opened by its
             * function number in g14 and closed by clearing g14, its arguments
             * the registers stored to the port in between. */
            function traceGroups(lines, pt) {
                const regs = {};
                const groups = [];
                let cur = null, fn = null, args = [];
                const close = () => {
                    if (fn !== null && cur) cur.calls.push([fn, args]);
                    fn = null;
                    args = [];
                };
                for (const text of lines) {
                    let m;
                    if ((m = text.match(/^lda (0x[0-9a-f]+), g14$/))) {
                        close();
                        const v = parseInt(m[1], 16);
                        if ((v & 0xff) !== v >> 8) continue;
                        if ((v & 0xff) === 5) cur = { calls: [], list: null };
                        else if ((v & 0xff) === 6) {
                            if (cur && cur.list !== null) groups.push(cur);
                            cur = null;
                        } else fn = v & 0xff;
                        continue;
                    }
                    if ((m = text.match(/^lda (0x[0-9a-f]+), ([rg]\d+)$/))) { regs[m[2]] = parseInt(m[1], 16); continue; }
                    if ((m = text.match(/^mov (\d+), 0, ([rg]\d+)$/)) && m[2] !== 'g14') { regs[m[2]] = +m[1]; continue; }
                    if ((m = text.match(/^st ([rg]\d+), \(g11\)\[g12\*1\]$/)) && fn !== null) { args.push(regs[m[1]]); continue; }
                    if (text === 'mov 0, 0, g14') { close(); continue; }
                    if ((m = text.match(new RegExp(`^ld ${pt}\\[r\\d+\\*4\\], g0$`))) && cur) cur.list = parseInt(m[1], 16);
                }
                const AXIS = { 0x14: 'x', 0x15: 'y', 0x16: 'z' };
                return groups.flatMap((g) => {
                    const move = g.calls.find(([f]) => f === 0x12);
                    if (!move || move[1].length !== 3 || move[1].some((v) => v === undefined)) return [];
                    return [{
                        at: move[1].map((u) => Math.round(f32(u) * 1e4) / 1e4),
                        turns: g.calls.filter(([f]) => AXIS[f]).map(([f, a]) => [AXIS[f], s16(a[0])]),
                        list: g.list,
                    }];
                });
            }
        }
    }
}

/* ---- the sky --------------------------------------------------------------- */

/*
 * The sky is not geometry but the tile layer's panorama, and each course's is
 * reached through the four-course table change_course_bank indexes by
 * sel_course: the first word of a row is the course's sky — a CG list, a
 * palette list and eight patterns of 32 tiles, each pattern headed {0x10000,
 * rows, 32}. The work RAM address the row is stored at moves from build to
 * build, so the table is found by the shape of what it points at instead.
 */
{
    const D = 0x02000000;
    const word = (a) => {
        if (a >= D && a - D + 4 <= rom.mainData.length) return rom.mainDataView.getUint32(a - D, true);
        const o = a >= 0x200000 ? a - 0x200000 : a;
        return o >= 0 && o + 4 <= code.length ? cv.getUint32(o, true) : NaN;
    };
    const isSky = (s) => {
        for (let k = 0; k < 8; k++) {
            const g = word(s + 8 + k * 4);
            if (!(g >= D) || word(g) !== 0x10000 || word(g + 8) !== 32) return false;
            const rows = word(g + 4);
            if (!(rows > 0 && rows < 128)) return false;
        }
        return true;
    };
    const hits = [];
    for (let a = 0; a + 16 <= code.length; a += 4) {
        let ok = true;
        for (let c = 0; c < 4 && ok; c++) {
            const row = word(a + c * 4);
            ok = row >= D && isSky(word(row));
        }
        if (ok) hits.push(a);
    }
    if (hits.length === 1) out.sky = { table: hits[0] };
    else notes.push(`sky: ${hits.length} four-course tables of skies`);
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
if (out.sky) console.log(`sky          { table: ${hex(out.sky.table)} }`);
if (out.objects) {
    /* The block as js/games.js writes it: addresses in hex (as keys too),
     * counts, angles and floats as they are. */
    const lit = (v, key = '') => {
        if (Array.isArray(v)) return `[${v.map((x) => lit(x, key)).join(', ')}]`;
        if (v && typeof v === 'object') {
            return `{ ${Object.entries(v).map(([k, x]) => `${/^\d+$/.test(k) ? hex(+k) : k}: ${lit(x, k)}`).join(', ')} }`;
        }
        if (typeof v === 'string') return `'${v}'`;
        const plain = ['count', 'scale', 'at', 'turns', 'spinY'].includes(key) || !Number.isInteger(v) || Math.abs(v) < 0x100;
        return typeof v === 'number' && !plain ? hex(v) : String(v);
    };
    console.log(`objects      ${lit(out.objects).replace(/^\{ at: (\d+)/, (m, a) => `{ at: ${hex(+a)}`)}`);
    console.log(`             ${out.objectRecords.join('/')} records on the three courses`);
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
    /* A build this finds no objects in has to carry none, and the other way
     * round; the keys of `kinds` and `pylons` are numbers in the profile and
     * strings once they have been through an object, so both go through one. */
    const canon = (v) => (Array.isArray(v) ? v.map(canon)
        : v && typeof v === 'object'
            ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
            : v);
    const objs = (o) => (o ? JSON.stringify(canon(o)) : null);
    eq('sky', out.sky, g.sky);
    const gotObj = objs(out.objects), wantObj = objs(g.objects);
    if (gotObj !== wantObj) {
        console.log(`FAIL: objects: found ${gotObj}, profile has ${wantObj}`);
        bad++;
    }
    console.log(bad ? `\n${bad} failed` : '\nevery number the profile carries is one this run found');
    process.exit(bad ? 1 : 0);
}
