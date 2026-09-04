"""Drive sfight into a fight under MAME and capture how it poses the fighter.

The viewer decodes a motion out of the ROM and solves it into sixteen bone
matrices. This records what the board does with the same data: every word the
i960 writes to the coprocessor while a real fight is on screen, with the motion
number and motion frame beside each frame's slice. `test-motion-mame.mjs` then
pulls the set_body and ik_2bone arguments out of that stream and holds them
against what `js/motion.js` and `js/pose.js` produce for the same motion and
frame — position, joint angles, IK targets and bone lengths, one by one.

Same two load-bearing MAME flags as the other capture drivers: -rompath must
point at a directory of zips only, and -nodrc, or the SHARC recompiler fails the
coprocessor self-test.

Run:  claude_mame/mcp_server/.venv/Scripts/python.exe mame-motion.py <outdir> [rompath]
"""

import asyncio
import json
import os
import sys

CLAUDE_MAME = r"C:\Users\bigge\source\repos\ai\claude_mame"
sys.path.insert(0, os.path.join(CLAUDE_MAME, "mcp_server"))
os.environ.setdefault("MAME_EXE_NAME", "mame.exe")

from mame_client import MameBridge  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
LUA = os.path.join(HERE, "mame-motion-capture.lua").replace("\\", "/")

OUTDIR = sys.argv[1]
ROMPATH = sys.argv[2] if len(sys.argv) > 2 else os.path.join(OUTDIR, "..", "roms")
FRAMES = int(os.environ.get("FRAMES", "90"))
# The roster's last entries -- the Final Eggman Boss (11) and the three robots
# (12-14) -- have no place on the select screen, so CHAR substitutes the index
# the front end chose and the board poses that one instead. Unset leaves the
# game's own choice alone.
#
# The pin goes on only once a real fight is running. Attract runs at skeleton
# type 0, whose table in SKELETON_TYPE_DATA is every character pointed at
# Sonic's skeleton, so a character pinned during attract draws its own meshes on
# Sonic's bones -- true of the pin, not of the game. A fight runs at type 1,
# where the table is per-character.
CHAR = os.environ.get("CHAR")
# Where the pin goes on. Late (the default) lets the front end start a real
# fight with a selectable character and then substitutes the index, which
# switches whatever is re-read per frame. Early pins from the first frame, so
# character select itself resolves to the pinned index and action_init loads
# that fighter outright -- the closer thing to making him selectable, when the
# match will still start with him in it.
PIN_EARLY = os.environ.get("PIN_EARLY", "0") == "1"
# Leaving the mash on is the point here: a fighter standing idle plays one
# motion, and what this is for is catching many.
KEEP_MASH = os.environ.get("KEEP_MASH", "1") == "1"


class Driver:
    def __init__(self, bridge):
        self.b = bridge

    async def ev(self, expr, timeout=60):
        r = await self.b.call("eval", {"expr": expr}, timeout=timeout)
        if not r.get("ok"):
            raise RuntimeError(f"lua failed: {expr[:80]} -> {r}")
        return r.get("result")

    async def cap(self, call, timeout=60):
        return await self.ev(f"_G.MCAP.{call}", timeout=timeout)


async def main():
    os.makedirs(OUTDIR, exist_ok=True)
    out = OUTDIR.replace("\\", "/")
    bridge = MameBridge()
    d = Driver(bridge)
    try:
        print("launching MAME (sfight, -nodrc)…", flush=True)
        await bridge.launch_mame("sfight", extra_args=[
            "-rompath", ROMPATH,
            "-nodrc", "-sound", "none", "-nothrottle",
            "-snapview", "auto", "-snapsize", "496x384",
            "-snapshot_directory", OUTDIR,
        ])
        print("bridge up:", json.dumps(bridge.hello), flush=True)

        print(await d.ev(f'dofile("{LUA}")'), flush=True)
        await d.ev(f"(function() _G.MCAP.want = {FRAMES} return 'ok' end)()")
        if CHAR is not None and PIN_EARLY:
            await d.ev(f"(function() _G.MCAP.char = {int(CHAR)} return 'ok' end)()")
            print(f"pinning P1 to character {int(CHAR)} from the first frame", flush=True)
        await d.cap("attach()")
        await bridge.call("continue")

        # Wait for a fighter to actually be posing. Copro traffic says a scene
        # is being drawn; a non-zero motion number says play_motion is running
        # one, which is the thing this capture is about.
        await d.cap("watch()")
        await d.cap("rate()")
        for i in range(150):
            await asyncio.sleep(3)
            rate = int(await d.cap("rate()"))
            motion, coma, ch, ty = (int(x) for x in (await d.cap("status()")).split())
            if i % 5 == 0 or (rate > 2000 and motion):
                print(f"  t={i*3:3d}s copro_writes/3s={rate} motion={motion}"
                      f" frame={coma} char={ch} type={ty}", flush=True)
            if not (rate > 2000 and motion > 0 and i > 4):
                continue
            if CHAR is None:
                break
            # Only the late pin needs to wait for a fight to swap into. Pinned
            # early the character is loaded from the select screen, and the type
            # it ends up at is the game's answer, not a precondition: a
            # selectable fighter reaches type 1, while the boss stays at 0
            # through a real vs-CPU match. Gating on type 1 would wait forever
            # for him.
            if not PIN_EARLY and ty != 1:
                continue
            if ch != int(CHAR):
                if not PIN_EARLY:
                    await d.ev(f"(function() _G.MCAP.char = {int(CHAR)} return 'ok' end)()")
                    print(f"fight is up at type {ty}; pinning P1 to character {int(CHAR)}",
                          flush=True)
                continue
            break
        else:
            raise RuntimeError("no fighter ever started playing a motion")
        await d.cap("unwatch()")

        if not KEEP_MASH:
            await d.ev("(function() _G.MCAP.mash = false return 'ok' end)()")
        await asyncio.sleep(1)
        await bridge.call("snapshot")

        print("capturing…", flush=True)
        await d.cap("start()")
        for _ in range(600):
            await asyncio.sleep(1)
            if await d.cap("state") != "capturing":
                break
        await d.cap("stop()")
        print(await d.cap(f'write("{out}/motion_dl")', timeout=300), flush=True)
        with open(os.path.join(OUTDIR, "motion_dl.json")) as f:
            meta = json.load(f)
        seen = sorted({m[2] for m in meta["marks"] if m[2]})
        chars = sorted({m[4] for m in meta["marks"] if m[2]})
        types = sorted({m[6] for m in meta["marks"] if m[2]})
        print(f"marks: {len(meta['marks'])} frames, motions seen: {seen}", flush=True)
        print(f"characters posed: {chars}, skeleton types: {types}", flush=True)

    finally:
        await bridge.shutdown_mame()


if __name__ == "__main__":
    asyncio.run(main())
