"""Drive sfight into a fight under MAME and capture the motion script and the
coprocessor's afterimage ring.

test-zanzou-mame.mjs grades the explorer against what this records: the script
state the board's work RAM holds at every frame (the trail command, the
propeller, the models op 0x10 installs), what `zanzou_control` sends with each
Fn_zanzou_reserve, and the SHARC's own ring before and after every one of them.
See mame-zanzou-capture.lua for what is read where.

A fight lays too few trails of its own to grade the ring, so once one is up the
capture writes P1's trail fields itself, case by case (CASES), the way m2-hle2
exercised its port: what zanzou_control sends and what the SHARC firmware lays
are then the board's own. The script grade skips those fields on those frames.

Same two load-bearing MAME flags as the other capture drivers: -rompath must
point at a directory of zips only (sfight, schamp and segabill), and -nodrc, or
the SHARC recompiler fails the coprocessor self-test.

Run:  claude_mame/mcp_server/.venv/Scripts/python.exe mame-zanzou.py <outdir> [rompath]

  CHAR=0            the fighter to pin as P1 (default Sonic)
  CASES=mask:step:turn:spacing,...  trail cases written into P1, hex mask and
                    turn; empty to only watch the fighters' own
  PERIOD=120        frames each case is held for
  FRAMES=600        frames to record
  RAW=1             also keep every FIFO word, for test-motion-mame.mjs
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
LUA = os.path.join(HERE, "mame-zanzou-capture.lua").replace("\\", "/")

OUTDIR = sys.argv[1]
ROMPATH = sys.argv[2] if len(sys.argv) > 2 else os.path.join(OUTDIR, "..", "roms")
FRAMES = int(os.environ.get("FRAMES", "600"))
CHAR = int(os.environ.get("CHAR", "0"))
# The shapes the ROM's own 134 trail commands take: one hand, both hands, both
# feet, the pelvis; steps -6, -2 and -40; the one motion that turns its copies
# (44); and the wider spacing of 164 and 167.
CASES_DEFAULT = "20:-6:0:0.1,120:-2:0:0.1,9000:-6:0:0.1,200:-2:0:0.1,20:-40:4500:0.1,30:-3:0:0.2"


def parse_case(c):
    m, st, t, sp = c.split(":")
    return (int(m, 16), int(st), int(t, 16), float(sp))


CASES = [parse_case(c) for c in os.environ.get("CASES", CASES_DEFAULT).split(",") if c.strip()]
PERIOD = int(os.environ.get("PERIOD", "120"))
RAW = os.environ.get("RAW", "0") == "1"
NAME = os.environ.get("NAME", "zanzou")


class Driver:
    def __init__(self, bridge):
        self.b = bridge

    async def ev(self, expr, timeout=60):
        r = await self.b.call("eval", {"expr": expr}, timeout=timeout)
        if not r.get("ok"):
            raise RuntimeError(f"lua failed: {expr[:80]} -> {r}")
        return r.get("result")

    async def cap(self, call, timeout=60):
        return await self.ev(f"_G.ZCAP.{call}", timeout=timeout)

    async def set(self, field, value):
        await self.ev(f"(function() _G.ZCAP.{field} = {value} return 'ok' end)()")


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
        print(await d.ev(f'dofile("{LUA}")'), flush=True)
        # The reserve parser against crafted streams, before anything rides on it.
        check = await d.cap("selftest()")
        print("parser self-test:", check, flush=True)
        if check != "ok":
            raise RuntimeError("the reserve parser failed its self-test")
        await d.set("want", FRAMES)
        await d.set("char", CHAR)
        await d.set("raw", "true" if RAW else "false")
        await d.set("period", PERIOD)
        if CASES:
            await d.set("cases", "{" + ",".join("{%d,%d,%d,%r}" % c for c in CASES) + "}")

        await d.cap("attach()")
        print(f"pinning P1 to character {CHAR}; {len(CASES)} trail cases", flush=True)
        await bridge.call("continue")

        # The SHARC's DM as the capture reads it: send_zanzou_data puts 0.1f
        # at 0x32181 and 3 at 0x32182 at boot, so a wrong address space or word
        # size shows here before anything else is measured.
        await asyncio.sleep(10)
        print("DM check:", await d.cap("dmcheck()"), flush=True)

        # Wait for a coined fight with the pinned fighter in it, then start
        # writing the cases. zanzou_control is the projectile module's per-frame
        # routine, and attract's replay fight never brings that module up, so a
        # fight on screen (sub_mode 9) is not enough. Not gated on the skeleton
        # type: set_mot_dat copies it from each motion, and stance (278) is
        # type 0 in a real fight too.
        for i in range(200):
            await asyncio.sleep(3)
            rate = int(await d.cap("rate()"))
            motion, coma, ch, ty, mode, tobi, dbg = (int(x) for x in (await d.cap("status()")).split())
            if i % 5 == 0:
                print(f"  t={i*3:3d}s copro_writes/3s={rate} motion={motion} frame={coma}"
                      f" char={ch} type={ty} sub_mode={mode} tobi={tobi} debug={dbg:x}", flush=True)
            if motion > 0 and ch == CHAR and mode == 9 and tobi and not (dbg >> 5) & 1:
                print(f"  t={i*3:3d}s fight up: motion={motion} sub_mode={mode} tobi={tobi}", flush=True)
                break
        else:
            raise RuntimeError("the pinned fighter never started a fight")
        if CASES:
            print("cases:", await d.cap("cases_on()"), flush=True)

        await asyncio.sleep(2)
        await bridge.call("snapshot")

        print("capturing…", flush=True)
        await d.cap("start()")
        for _ in range(1200):
            await asyncio.sleep(1)
            st = await d.cap("state")
            if st != "capturing":
                break
        await d.cap("stop()")
        err = await d.ev("_G.ZCAP.err or 'none'")
        if err != "none":
            print("capture error:", err, flush=True)
        print(await d.cap(f'write("{out}/{NAME}")', timeout=600), flush=True)
        with open(os.path.join(OUTDIR, f"{NAME}.zanzou.json")) as f:
            meta = json.load(f)
        motions = sorted({fr[3][0] for fr in meta["frames"]})
        print(f"frames: {len(meta['frames'])}, P1 motions: {motions}", flush=True)
        print(f"reserves: {len(meta['reserves'])}", flush=True)
    finally:
        await bridge.shutdown_mame()


if __name__ == "__main__":
    asyncio.run(main())
