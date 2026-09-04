"""Walk sfight into a chosen stage under MAME and capture its display list.

The viewer builds each stage's draws by hand from the ROM tables; this captures
what the board actually emits, so the two can be compared word for word. It
drives claude_mame's bridge — see mame-drive.py for why the bridge is
needed at all rather than an autoboot script — loads mame-dl-capture.lua into
the running MAME, and lets that pin the stage and mash the front end until
texture RAM says a scene is loaded.

Two MAME flags are load-bearing, as in mame-drive.py: -rompath must point at a
directory of zips only, and -nodrc, or the SHARC recompiler fails the
coprocessor self-test.

Run:  claude_mame/mcp_server/.venv/Scripts/python.exe mame-capture-dl.py <outdir> [stage] [rompath]
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
LUA = os.path.join(HERE, "mame-dl-capture.lua").replace("\\", "/")

OUTDIR = sys.argv[1]
STAGE = int(sys.argv[2]) if len(sys.argv) > 2 else 1
ROMPATH = sys.argv[3] if len(sys.argv) > 3 else os.path.join(OUTDIR, "..", "roms")
# How many frames of display list to keep, and whether to go on driving inputs
# while they are captured. A long run with the mash left on is how you catch a
# draw the board only emits when its own camera happens to be pointed at it.
FRAMES = int(os.environ.get("FRAMES", "4"))
KEEP_MASH = os.environ.get("KEEP_MASH") == "1"
# Driving the front end only reaches a stage by winning your way to it, and the
# later ones need more wins than a random mash lands. Attract mode loads a fresh
# scene every half minute on its own, and change_scene reads the pinned
# stage_num when it does, so for those it is quicker to keep hands off and wait.
NO_MASH = os.environ.get("NO_MASH") == "1"
SETTLE = float(os.environ.get("SETTLE", "3"))


class Driver:
    def __init__(self, bridge):
        self.b = bridge

    async def ev(self, expr, timeout=60):
        r = await self.b.call("eval", {"expr": expr}, timeout=timeout)
        if not r.get("ok"):
            raise RuntimeError(f"lua failed: {expr[:80]} -> {r}")
        return r.get("result")

    async def cap(self, call, timeout=60):
        return await self.ev(f"_G.CAP.{call}", timeout=timeout)


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
        await d.ev(f"(function() _G.CAP.stage = {STAGE} _G.CAP.want = {FRAMES} "
                   f"_G.CAP.mash = {'false' if NO_MASH else 'true'} return 'ok' end)()")
        await d.cap("attach()")
        await bridge.call("continue")

        # Wait for the fight itself. Texture RAM fills long before a round
        # starts, so the signal is copro traffic: the game only builds a display
        # list while it is drawing a scene, and the front end draws none.
        await d.cap("watch()")
        await d.cap("rate()")
        for i in range(150):
            await asyncio.sleep(3)
            rate = int(await d.cap("rate()"))
            num = int(await d.cap("stage_num()"))
            miss, partsmiss = (int(x) for x in (await d.cap("record_match()")).split())
            la, lb, ra, rb = (int(x) for x in (await d.cap("tex_match()")).split())
            texok = (la, lb) == (ra, rb)
            if i % 5 == 0 or (rate > 2000 and texok):
                print(f"  t={i*3:3d}s stage_num={num} copro_writes/3s={rate}"
                      f" tex=({la},{lb}) want=({ra},{rb})"
                      f" record_miss={miss}/{partsmiss}", flush=True)
            # The loaded scene must be this stage's, not merely the pinned
            # stage_num. The texture sets it asked for are the identifier that
            # survives the game writing to its own copy of the record.
            if rate > 2000 and num == STAGE and texok and i > 4:
                break
        else:
            raise RuntimeError("the game never started drawing a scene")
        await d.cap("unwatch()")

        # Stop pressing buttons so the fighters stand still, but keep holding
        # stage_num — the game rewrites it whenever it changes scene. Leaving
        # the mash on instead keeps the fight moving, which swings the board's
        # camera around and is the only way to see a draw it culls when still.
        if not KEEP_MASH:
            await d.ev("(function() _G.CAP.mash = false return 'ok' end)()")
        await asyncio.sleep(SETTLE)
        await bridge.call("snapshot")

        # Confirm the frame counter before leaning on it: the words that
        # advance by exactly the elapsed frame count, over three intervals.
        print("confirming frame_counter…", flush=True)
        for gap in (1.0, 2.0, 3.0):
            await d.cap("snap_ram()", timeout=180)
            await asyncio.sleep(gap)
            print("  ", await d.cap("scan_delta()", timeout=180), flush=True)

        print("capturing…", flush=True)
        await d.cap("start()")
        for _ in range(600):
            await asyncio.sleep(1)
            if await d.cap("state") != "capturing":
                break
        await d.cap("stop()")
        print(await d.cap(f'write("{out}/stage{STAGE:02d}_dl")', timeout=180), flush=True)
        print('texram:', await d.cap(f'dump_texram("{out}/stage{STAGE:02d}")', timeout=300), flush=True)
        with open(os.path.join(OUTDIR, f"stage{STAGE:02d}_dl.json")) as f:
            meta = json.load(f)
        print("marks:", json.dumps(meta["marks"]), flush=True)

    finally:
        await bridge.shutdown_mame()


if __name__ == "__main__":
    asyncio.run(main())
