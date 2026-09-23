/*
 * dl-rig.mjs — a fighter's own matrices, replayed out of a display list.
 *
 * `dl-verify.mjs` replays a *stage* list, where every part is placed by
 * explicit transform commands. A fighter is built in two passes, and neither is
 * a list of transforms applied to a draw.
 *
 * `calc_rob_angle_cont` (0x2FF2C) solves the rig. Op 0x62 builds the body —
 * waist position, body euler, facing, after a push of its own — and every part
 * it finishes goes into a TGP slot with op 0x67, whose one argument is the slot's
 * address: 0x3A00 for P1 and 0x3B00 for P2, stepping 0x0C, twelve words a slot.
 * The chest is a translate of nothing, an euler, and two angles that aim it at
 * the neck target; the four limbs are one op 0x6B each, which stores the two
 * bones it solves. The head is worked out here too — its euler, and the replies
 * that aim it — and then popped without being stored.
 *
 * The draw pass after it puts the fighter in the world. For each part it loads
 * the slot's 3x3 back with op 0x69, turned about world Y by the facing, over a
 * translation the stream has already set; the head is the chest's slot, stepped
 * up the spine, its euler again, and then one more op 0x3F carrying the aim
 * angles the i960 settled on. Each finished part is stored with op 0x35 into the
 * unit cache by (player, slot * 12) — body 0, chest 12, head 24 — which is what
 * the parts are drawn from.
 *
 * So the head is only ever whole in the draw pass, and only a full replay of the
 * coprocessor reaches it: loads, stores and the facing turn included, which is
 * what `cop-replay.mjs` is. This reads the unit cache it is left holding. The
 * ops in between that are not matrix ops — 0x13 fadd, 0x0F and 0x12 reading the
 * matrix back, 0x29 and 0x6A transforming a point, 0x27 atan2, 0x39, 0x5C and
 * 0x5E vector sums and scales — leave the matrix alone, as the firmware does.
 */

import { segment } from './dl-verify.mjs';
import { CopReplay } from './cop-replay.mjs';

export const TGP_P1 = 0x3a00, TGP_P2 = 0x3b00, TGP_STRIDE = 0x0c;
export const SLOT_COUNT = 16;

/** Which player and slot a TGP address names, or null if it is neither's. */
export function slotOf(addr) {
    for (const [player, base] of [[0, TGP_P1], [1, TGP_P2]]) {
        const n = (addr - base) / TGP_STRIDE;
        if (Number.isInteger(n) && n >= 0 && n < SLOT_COUNT) return { player, slot: n };
    }
    return null;
}

/* The unit-cache slots the draw pass stores the upper body into. */
export const BODY = 0, CHEST = 1, HEAD = 2;

/**
 * A replay that remembers, for every part it stores, the matrix on either side
 * of the last op 0x3F since the part's own push. Both parts that aim do it after
 * their euler: the chest in the solve pass with an ang_z and an ang_y, the head
 * in the draw pass with a second 0x3F. So for the chest's TGP slot `afterTurn`
 * is the body turned by the chest's own euler, and for the head's unit slot
 * `beforeTurn` is the chest turned by the head's — each part with its aim left
 * off. (The three zero angle ops that trail each euler turn nothing.)
 */
export class RigReplay extends CopReplay {
    constructor(o) {
        super(o);
        this.beforeTurn = null;
        this.afterTurn = null;
        this.parts = new Map();
    }
    apply(op, a) {
        if (op === 0x01 || op === 0x02) this.beforeTurn = this.afterTurn = null;
        if (op === 0x3f) this.beforeTurn = this.state();
        super.apply(op, a);
        if (op === 0x3f) this.afterTurn = this.state();
        const at = { ...this.state(), beforeTurn: this.beforeTurn, afterTurn: this.afterTurn };
        if (op === 0x35) this.parts.set(`unit ${(a[0] & 0xff) === 1 ? 1 : 0},${a[1] / 12}`, at);
        if (op === 0x67) {
            const s = slotOf(a[0] & 0xffff);
            if (s) this.parts.set(`tgp ${s.player},${s.slot}`, at);
        }
    }
    /**
     * This frame's upper body for one player, or null: the parts the draw pass
     * stored (`body`, `chest`, `head`) and the two the solve pass did
     * (`solvedBody`, `solvedChest`), which are the same matrices before the
     * facing turns them.
     */
    upperBody(player) {
        const get = (k, s) => this.parts.get(`${k} ${player},${s}`);
        const o = {
            body: get('unit', BODY), chest: get('unit', CHEST), head: get('unit', HEAD),
            solvedBody: get('tgp', BODY), solvedChest: get('tgp', CHEST),
        };
        return Object.values(o).every(Boolean) ? o : null;
    }
}

/**
 * Replay a capture's coprocessor stream frame by frame, with one replay carried
 * across the marks, since the draw pass reads slots the solve stored earlier in
 * the same frame and nothing clears them between frames.
 *
 * @param {Array<{words:number[]}>} frames  from `loadCapture`
 * @param {object} [o]  passed to CopReplay — `trig` in particular
 * @yields {RigReplay} the replay, holding that frame's stored parts
 */
export function* rigFrames(frames, o) {
    const r = new RigReplay(o);
    for (const f of frames) {
        r.parts.clear();
        for (const c of segment(f.words)) r.apply(c.op, c.args);
        yield r;
    }
}
