"""Drive sfight into Canyon Cruise under MAME and record the boat's flight.

The viewer flies the boat by porting object_move's curve out of the ROM. This
records what the board itself writes to stage_xpos/ypos/zpos and the three
angles, once a frame, so test-canyon.mjs can be pointed at a real machine
rather than at the argument for the port.

Same two load-bearing flags as the other MAME drivers: -rompath must point at a
directory of zips only, and -nodrc, or the SHARC recompiler fails the copro
self-test. The set has to verify, too: MAME drops to its own menu and boots
something else entirely when it does not, so this checks what booted before it
reads a byte.

Run:  claude_mame/mcp_server/.venv/Scripts/python.exe mame-canyon-path.py <outdir> [rompath]
"""

import asyncio
import os
import sys

CLAUDE_MAME = r"C:\Users\bigge\source\repos\ai\claude_mame"
sys.path.insert(0, os.path.join(CLAUDE_MAME, "mcp_server"))
os.environ.setdefault("MAME_EXE_NAME", "mame.exe")

from mame_client import MameBridge  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
LUA = os.path.join(HERE, "mame-canyon-path.lua").replace("\\", "/")

OUTDIR = sys.argv[1]
ROMPATH = sys.argv[2] if len(sys.argv) > 2 else os.path.join(CLAUDE_MAME, "mame", "roms")
FRAMES = int(os.environ.get("FRAMES", "2600"))
# Wait for the ride to reach this count before recording. The whole run is
# nearly two thousand frames and MAME interprets the SHARC at a few frames a
# second, so recording a chosen stretch of it beats recording all of it.
WAIT_COUNT = int(os.environ.get("WAIT_COUNT", "1"))
# The ride is 1924 frames and starts wherever the round starts, so recording
# more than one lap is the only way to be sure of catching a whole one.


async def main():
    os.makedirs(OUTDIR, exist_ok=True)
    out = OUTDIR.replace("\\", "/")
    bridge = MameBridge()

    async def ev(expr, timeout=60):
        r = await bridge.call("eval", {"expr": expr}, timeout=timeout)
        if not r.get("ok"):
            raise RuntimeError(f"lua failed: {expr[:80]} -> {r}")
        return r.get("result")

    async def path(call, timeout=60):
        return await ev(f"_G.PATH.{call}", timeout=timeout)

    try:
        print("launching MAME (sfight, -nodrc)…", flush=True)
        await bridge.launch_mame("sfight", extra_args=[
            "-rompath", ROMPATH, "-nodrc", "-sound", "none", "-nothrottle",
        ])
        print(await ev(f'dofile("{LUA}")'), flush=True)
        # MAME falls back to its own menu when a set does not verify, and the
        # reads below would then be somebody else's RAM. Check the set with
        # `mame -rompath <dir> -verifyroms sfight` if this trips.
        booted = await path("system()")
        if booted != "sfight":
            raise RuntimeError(f"MAME booted {booted!r}, not sfight")
        await ev(f"(function() _G.PATH.want = {FRAMES} return 'ok' end)()")
        await path("attach()")
        await bridge.call("continue")

        # The game only talks to the coprocessor while it is drawing a scene,
        # so copro traffic is the signal that the fight has started.
        await path("watch()")
        await path("rate()")
        for i in range(150):
            await asyncio.sleep(3)
            rate = int(await path("rate()"))
            num = int(await path("stage_num()"))
            if i % 5 == 0:
                print(f"  t={i*3:3d}s stage_num={num} copro_writes/3s={rate}", flush=True)
            if rate > 2000 and num == 4 and i > 4:
                break
        else:
            raise RuntimeError("the game never started drawing a scene")
        await path("unwatch()")

        # Stop pressing buttons: the fighters standing still changes nothing
        # about the boat, and a knockout would end the round mid-recording.
        await ev("(function() _G.PATH.mash = false return 'ok' end)()")
        # Wait for the ride to reach the count asked for before recording, or
        # most of the run is spent on the frames before the round starts. A
        # count that goes backwards is the attract demo restarting rather than a
        # round running, so this waits for one that has got somewhere.
        for _ in range(600):
            if int(await path("count()")) >= WAIT_COUNT:
                break
            await asyncio.sleep(1)
        print("recording…", flush=True)
        await path("start()")
        # A whole lap is 1924 frames and MAME interprets the SHARC at a few
        # frames a second, so this is minutes, not seconds.
        for _ in range(1500):
            await asyncio.sleep(1)
            if await path("state") == "done":
                break
        await path("stop()")
        print(await path(f'write("{out}/canyon_path.csv")', timeout=180), flush=True)
    finally:
        await bridge.shutdown_mame()


if __name__ == "__main__":
    asyncio.run(main())
