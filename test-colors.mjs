/* Verify the ported colour-table routines against a capture of the real board.
 *
 * js/colors.js reproduces what the game's own code writes into luma RAM and
 * colorxlat. The capture this measures against was taken from MAME while South
 * Island was on screen, so it is an exact statement of what the board held for
 * that scene. It is not in the tree — it is the game's data — so what is here
 * is `texram-ref.json`, SHA-256 over it cut row by row, which is the unit every
 * comparison below is made in anyway. See texref.mjs.
 *
 * Luma RAM has to match outright, and so now does every byte of colorxlat:
 *
 *   rows 0..27, luma 0..47    the ramp                   chg_pol_color_send
 *   all rows,   luma 64..127  the flat band              chg_scr_color_req
 *   rows 14..27, luma 48..63  the stage's own colours    send_tex_col_stage
 *   rows 5, 6, 12, 13         two tables written at boot 0x7b4
 *   rows 0..4,   luma 48..63  player 1's part colours    send_tex_col_part
 *   rows 28..29, luma 0..63   player 1's skin            send_tex_col_skin
 *
 * The fighter rows used to be reported rather than asserted, because the port
 * did not write them: they came out zero, and 210 models that carry a face on
 * a palette luma band read one of them — Eggman's glasses are row 0, and were
 * black. The capture does not record who was on screen, so the check is put the
 * other way round below: some character has to reproduce those seven rows
 * exactly, and the set that does has to be the twelve fighters who share one
 * block rather than one lucky character.
 *
 * Player 2's rows — 7..11 and 30..31 — are zero in the capture and zero in the
 * build, so they are covered by the byte-exact pass without naming a second
 * character.
 *
 * One group is still expected to differ and is checked separately:
 *
 *   rows 18 and 19 — the sea and the waterfall. `sub_2435C` rotates those two
 *     sixteen-colour bands as the frame counter advances, which is the
 *     scrolling water, so the capture caught them part way round. They are
 *     checked against cycleStageColors instead: each has to match at exactly
 *     one rotation, and both rotations have to be explained by a single value
 *     of frame_counter. That is a stronger statement than "some rotation
 *     matches" — it says the port agrees with the board on which colour goes
 *     in which slot at which moment. Those bands are left out of the row
 *     digests the byte-exact pass uses, and hashed on their own.
 *
 *   node test-colors.mjs
 */
import fs from 'node:fs';
import { loadRomSet } from './vendor/noclip/js/romset.js';
import { readStageTable } from './vendor/noclip/js/stages.js';
import {
    buildLumaram, buildColorxlat, cycleStageColors, LUMA_BYTES, CXLAT_BYTES,
} from './vendor/noclip/js/colors.js';
import { sha, cxlatRowDigest } from './texref.mjs';

const REF = JSON.parse(fs.readFileSync('texram-ref.json', 'utf8'));

/* The rows send_tex_col_part and send_tex_col_skin give player 1, and the
 * characters that have to be the ones reproducing them: the twelve fighters,
 * who share one part block and one skin block between them. */
const FIGHTER_CHARS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const CHAR_COUNT = 52;
const CXLAT_ROWS = 32;
const CXLAT_LUMA = 256;
const FIGHTER_LUMA = 64;
/* The bands the game cycles are not hardcoded: they come out of the stage
 * record, the same list sub_2435C walks. */
const [CYCLED_LUMA0, CYCLED_LUMA1] = REF.cycleBand;
const FIGHTER_ROWS = Object.keys(REF.colorxlat.fighterRows).map(Number);

const read = (p) => {
    const b = fs.readFileSync(p);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

const rom = await loadRomSet([read('sfight.zip')]);
const stage = readStageTable(rom)[REF.stage];

let failed = false;

/* ---- luma RAM ---- */
{
    const ours = buildLumaram(rom);
    if (ours.length === LUMA_BYTES && sha(ours) === REF.lumaram) {
        console.log(`lumaram: OK, ${LUMA_BYTES} bytes byte-exact`);
    } else {
        console.log('lumaram: FAIL, does not match the capture');
        failed = true;
    }
}

/* ---- colorxlat ---- */
{
    const opts = { colorSet: stage.texSet[1], tint: stage.tint };
    const cycledRows = stage.colorCycles.map((c) => c.row);
    if (cycledRows.join() !== REF.cycledRows.join()) {
        console.log(`colorxlat: FAIL, stage cycles rows [${cycledRows}], ` +
            `capture was taken with [${REF.cycledRows}]`);
        process.exit(1);
    }

    /* ---- who was on screen ----
     * The capture cannot say, so ask which characters could have been: the ones
     * whose part and skin blocks reproduce all seven of player 1's rows. If the
     * block stride or the row bases were misread the answer would be nobody, or
     * one character by accident; the twelve fighters coming back together is
     * the twelve of them sharing one block, which is a fact about the tables
     * rather than about this capture. */
    const candidates = [];
    for (let c = 0; c < CHAR_COUNT; c++) {
        const t = buildColorxlat(rom, { ...opts, fighters: [c] });
        const same = FIGHTER_ROWS.every((row) =>
            cxlatRowDigest(t, row, 0, FIGHTER_LUMA, null) ===
                REF.colorxlat.fighterRows[row]);
        if (same) candidates.push(c);
    }
    if (candidates.join() === FIGHTER_CHARS.join()) {
        console.log(`fighter rows: OK, ${FIGHTER_ROWS.length} rows exact for ` +
            `characters ${candidates[0]}..${candidates[candidates.length - 1]}`);
    } else {
        console.log(`fighter rows: FAIL, reproduced by [${candidates.join(', ')}], ` +
            `expected [${FIGHTER_CHARS.join(', ')}]`);
        failed = true;
    }

    /* Any of them gives the same bytes, so the byte-exact pass takes the first.
     * Player 2 is left out: its rows are zero in the capture and zero here. */
    const ours = buildColorxlat(rom, { ...opts, fighters: [FIGHTER_CHARS[0]] });
    if (ours.length !== CXLAT_BYTES) {
        console.log(`colorxlat: FAIL, built ${ours.length} bytes, expected ${CXLAT_BYTES}`);
        process.exit(1);
    }

    let bad = 0;
    for (let row = 0; row < CXLAT_ROWS; row++) {
        /* The cycled rows' palette slots are checked below instead. */
        const skip = cycledRows.includes(row) ? REF.cycleBand : null;
        if (cxlatRowDigest(ours, row, 0, CXLAT_LUMA, skip) === REF.colorxlat.rows[row]) continue;
        bad++;
        if (bad < 8) console.log(`  row ${row} differs`);
    }

    /* ---- the cycled rows, against the routine that cycles them ---- */
    const found = [];
    for (const c of stage.colorCycles) {
        const hits = [];
        for (let phase = 0; phase < 16; phase++) {
            const t = Uint8Array.from(ours);
            cycleStageColors(rom, t, { ...opts, row: c.row, phase });
            if (cxlatRowDigest(t, c.row, CYCLED_LUMA0, CYCLED_LUMA1, null) ===
                REF.colorxlat.cycledBands[c.row]) hits.push(phase);
        }
        if (hits.length !== 1) {
            console.log(`  row ${c.row}: ${hits.length === 0 ? 'no rotation matches the capture'
                : `ambiguous, matches at ${hits.join(', ')}`}`);
            bad++;
        }
        found.push({ ...c, phase: hits.length === 1 ? hits[0] : -1 });
    }

    /* One frame_counter has to explain every row at once. The list repeats
     * every 16 << max(shift) frames, so that whole period is searched. */
    const period = 16 << Math.max(0, ...found.map((c) => c.shift));
    const frames = [];
    for (let f = 0; f < period; f++) {
        if (found.every((c) => ((f >>> c.shift) & 15) === c.phase)) frames.push(f);
    }
    if (found.length && !frames.length) {
        console.log('  no single frame_counter explains the captured rotations');
        bad++;
    }

    const rot = found.map((c) => `row ${c.row} at ${c.phase}`).join(', ');
    console.log(`colorxlat: ${CXLAT_BYTES} bytes; cycled ${rot || 'n/a'}` +
        (frames.length ? ` — frame_counter ${frames[0]} mod ${period}` : ''));
    if (bad === 0) {
        console.log('colorxlat: OK, every entry byte-exact bar the cycled rows');
    } else {
        console.log(`colorxlat: FAIL, ${bad} rows differ`);
        failed = true;
    }
}

process.exit(failed ? 1 : 0);
