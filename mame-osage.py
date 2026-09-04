"""Capture a fighter's sway chains from the real game under MAME.

The viewer places Honey's pigtails and Fang's tail from the osage tables in ROM.
Whether that is the whole story turns on one bit: bit 0 of a chain's flag word
gates the sway integrator, and if it is ever set the chain carries momentum and
no rest pose can stand in for it. This breakpoints `os_set_osage` at 0x685FC —
the routine that places one segment — and reads the live state each time it is
hit:

    g9  + 0x18   the segment's model
    g9  + 0x24   its length
    g9  + 0x28   the "stiffness" triple, the record's +0x2C
    g13 + 0x00   chain flags
    g13 + 0xFC   the chain root
    g13 + 0x108  the running position, which is what the segment is drawn at
    g13 + 0x114  the sway direction the position was stepped along

It also reads the coprocessor's own bone cache, so the chain can be compared
against the very bone matrix the board used rather than against a pose the
viewer solved separately — which is what makes the comparison exact instead of
approximate.

Which fighter is caught is chosen by overwriting Sonic's entry in the
character-select table at 0xDACAC: whoever is written there stands in his slot,
so the cursor's default position selects them. 15 is Honey, 4 Fang, 5 Bark,
7 Espio, 10 Bean. Only these five have sway chains at all.

Set HOLD to a `:IN1` field name to keep it pressed for the whole capture, so
the chain is read while the fighter is moving rather than standing still. That
is what separates a chain that merely hangs off a moving bone from one that
carries momentum: with HOLD set, successive frames of the same segment can be
checked against a solve that has no history in it.

Each frame also records the chain's own cross-frame state -- the wind phase at
0x130, its heading at 0x134 and the wind vector at 0x138 -- and the two bone
matrices the chains hang off, so a frame can be re-solved from exactly what the
board had. Those are read once a frame rather than once a segment: they cannot
change within one, and every extra read is a round trip the bridge can time out
on.

`test-osage-mame.mjs` is what reads the result.

Run:  claude_mame/mcp_server/.venv/Scripts/python.exe mame-osage.py <outfile.json> [char]
Env:  HITS=420 HOLD="P1 Right"
"""

import asyncio
import json
import math
import os
import struct
import sys

CLAUDE_MAME = r"C:\Users\bigge\source\repos\ai\claude_mame"
sys.path.insert(0, os.path.join(CLAUDE_MAME, "mcp_server"))
os.environ.setdefault("MAME_EXE_NAME", "mame.exe")

from mame_client import MameBridge  # noqa: E402

OUT = sys.argv[1] if len(sys.argv) > 1 else "osage.json"
CHAR = int(sys.argv[2]) if len(sys.argv) > 2 else 15
ROMPATH = os.environ.get("ROMPATH")

# The routine's return, not its entry: 0x108(g13) is the running position and it
# is written on the way out, so at the entry it still holds the previous
# segment's. Both paths through os_set_osage converge on this ret.
OS_SET_OSAGE = 0x68754
CHAR_SELECT_BYTE = 0xDACAC
P1 = 0x510D00
COP_BONE_CACHE = 0x30420          # DM, 12 words per slot
HITS = int(os.environ.get("HITS", "40"))
# A `:IN1` field held down for the whole capture, so the fighter is moving.
HOLD = os.environ.get("HOLD", "")

# 0xDACAC is in PROGRAM ROM, so writing it through the address space does
# nothing — a read-only handler swallows it. The ROM region itself is writable,
# and that is what the game reads from.
# The character-select cursor lives in work RAM, so it can just be written and
# the cursor moved to whoever is wanted — no ROM patching, and the game selects
# them normally. P1_CHAR_VALUE says afterwards who was actually taken.
CURSOR = 0x5102DC
SPACE = 'manager.machine.devices[":maincpu"].spaces["program"]'
POKE = f'{SPACE}:write_u8(0x{CURSOR:X}, {CHAR})'
READBACK = f'{SPACE}:read_u8(0x{CURSOR:X})'


def asf(u):
    return struct.unpack("<f", struct.pack("<I", u & 0xFFFFFFFF))[0]


async def press(b, field, hold=0.35):
    for v in (1, 0):
        await b.call("eval", {"expr": f'manager.machine.ioport.ports[":IN0"]'
                                      f'.fields["{field}"]:set_value({v})'})
        await asyncio.sleep(hold if v else 0.3)


async def rd(b, addr, count, width=4):
    r = await b.call("read_mem", {"cpu": ":maincpu", "addr": addr, "count": count,
                                  "width": width, "space": "program"}, timeout=120.0)
    return r if isinstance(r, list) else r.get("result")


async def rd3f(b, addr):
    return [asf(x) for x in await rd(b, addr, 3, 4)]


async def rd_cop(b, base, n):
    """The coprocessor's data space, which the bridge cannot address directly."""
    expr = ('(function() local sp=manager.machine.devices[":copro_adsp"].spaces["data"] '
            "local o={} for i=0,%d do o[#o+1]=string.format('%%08x',sp:read_u32(0x%X+i)) end "
            "return table.concat(o,',') end)()" % (n - 1, base))
    r = await b.call("eval", {"expr": expr}, timeout=120.0)
    return [asf(int(h, 16)) for h in r.get("result").split(",")]


async def settle(b, seconds, label=""):
    """Sleep in short steps, touching the bridge so it does not time out. A
    single long sleep drops the connection."""
    left = seconds
    while left > 0:
        step = min(2.0, left)
        await asyncio.sleep(step)
        left -= step
        try:
            await b.call("status", timeout=10.0)
        except Exception:
            try:
                await b.call("ping", timeout=10.0)
            except Exception:
                pass
    if label:
        print(f"  ({label})", flush=True)


def regi(regs, name):
    v = regs.get(name)
    if v is None:
        return None
    return v if isinstance(v, int) else int(v, 16)


def finite(o):
    """Replace NaN and the infinities with null, recursively."""
    if isinstance(o, float):
        return o if math.isfinite(o) else None
    if isinstance(o, dict):
        return {k: finite(v) for k, v in o.items()}
    if isinstance(o, list):
        return [finite(v) for v in o]
    return o


def dump(segs, frames, bones=None):
    """Write what has been gathered so far.

    Called from the capture's failure path as well as its end. A bridge timeout
    150 hits into a 300-hit run used to throw the whole capture away, and a
    partial time series is still a usable one.
    """
    if not segs:
        print("nothing captured", flush=True)
        return
    out = {"char": CHAR, "hold": HOLD, "segments": segs,
           "frames": frames, "bones": bones}
    with open(OUT, "w") as f:
        # Python writes bare NaN and Infinity, which no other reader accepts.
        # An occasional hit catches a stale g9 and reads garbage floats out of
        # it, so this is not hypothetical.
        json.dump(finite(out), f, indent=1)
    print(f"\nwrote {OUT}: {len(segs)} segment hits over {len(frames)} frames",
          flush=True)


async def main():
    b = MameBridge()
    segs, frames = [], []
    try:
        args = ["-nodrc", "-sound", "none"]
        if ROMPATH:
            args = ["-rompath", ROMPATH] + args
        print(f"launching MAME (sfight, char {CHAR}) ...", flush=True)
        await b.launch_mame("sfight", extra_args=args)
        await b.call("continue")
        await settle(b, 60.0, "attract")
        print("coin + start ...", flush=True)
        await press(b, "Coin 1")
        await settle(b, 3.0)
        await press(b, "1 Player Start")
        await settle(b, 35.0, "character select")
        await b.call("snapshot")

        # Drive the cursor to the fighter we want and take them. The cursor is
        # written rather than walked with the stick because the grid order is
        # not the roster order, and it is held across several frames because the
        # select screen rewrites it as it animates.
        print(f"selecting character {CHAR} ...", flush=True)
        for _ in range(40):
            await b.call("eval", {"expr": POKE})
            await asyncio.sleep(0.1)
        await press(b, "1 Player Start")
        await settle(b, 6.0)
        for _ in range(20):
            await b.call("eval", {"expr": POKE})
            await asyncio.sleep(0.1)
        await press(b, "1 Player Start")
        await settle(b, 12.0, "match starting")
        got = (await rd(b, P1 + 0x1B0, 1, 1))[0]
        print(f"  P1_CHAR_VALUE reads {got} (wanted {CHAR})", flush=True)

        if HOLD:
            # Held, not tapped: the port keeps its value while the emulation is
            # paused at each hit, so the fighter goes on moving across the whole
            # capture instead of settling back to idle between reads.
            print(f"holding {HOLD!r} ...", flush=True)
            await b.call("eval", {"expr": f'manager.machine.ioport.ports[":IN1"]'
                                          f'.fields["{HOLD}"]:set_value(1)'})
            await settle(b, 2.0)

        print(f"breakpointing os_set_osage @0x{OS_SET_OSAGE:05X} ...", flush=True)
        await b.call("set_bp", {"cpu": ":maincpu", "addr": OS_SET_OSAGE,
                                "pause_on_hit": True, "tag": 941, "name": "os_set_osage_ret"})
        await b.call("continue")

        if not await b.wait_for_hits(since_seq=0, timeout=45.0):
            await b.call("snapshot")
            raise RuntimeError("os_set_osage never ran - no fighter with sway chains is posing")

        # A chain's struct pointer is the same for all of its own segments, so
        # the step back to the first chain is the frame edge. The bones and the
        # chain's cross-frame state are read once there rather than once a
        # segment: they cannot change within a frame, and every extra read is a
        # round trip the bridge can time out on.
        first_g13 = None
        prev_g13 = None
        frame = -1

        for _ in range(HITS):
            await b.call("pause")
            regs = await b.call("read_regs", {"cpu": ":maincpu"})
            g13, g9 = regi(regs, "g13"), regi(regs, "g9")
            if g13 is None or g9 is None:
                await b.call("continue")
                continue
            if first_g13 is None:
                first_g13 = g13
            if g13 == first_g13 and prev_g13 != first_g13:
                frame += 1
                frames.append({
                    "frame": frame,
                    # The only osage state that survives a frame: an integer
                    # phase that steps once a frame, the heading it is turned
                    # to, and the vector the two produce. If a chain has any
                    # memory at all, it is here.
                    "phase": (await rd(b, g13 + 0x130, 1, 4))[0],
                    "heading": (await rd(b, g13 + 0x134, 1, 4))[0],
                    "wind": await rd3f(b, g13 + 0x138),
                    # The bones the chains hang off, as the board has them this
                    # frame: slot 1 the chest, slot 2 the head.
                    "bone1": await rd_cop(b, COP_BONE_CACHE + 12, 12),
                    "bone2": await rd_cop(b, COP_BONE_CACHE + 24, 12),
                    "motion": (await rd(b, P1 + 0x1A8, 1, 2))[0],
                    "coma": (await rd(b, P1 + 0x1AA, 1, 2))[0],
                    "char": (await rd(b, P1 + 0x1B0, 1, 1))[0],
                })
            prev_g13 = g13

            rec = {
                "frame": frame, "g13": g13,
                "model": (await rd(b, g9 + 0x18, 1, 4))[0],
                "pos": await rd3f(b, g13 + 0x108),
                "dir": await rd3f(b, g13 + 0x114),
                "root": await rd3f(b, g13 + 0xFC),
            }
            # The record's own fields are the same every frame, so they are read
            # on the first pass over the chains and no more.
            if frame == 0:
                rec["length"] = asf((await rd(b, g9 + 0x24, 1, 4))[0])
                rec["stiffness"] = await rd3f(b, g9 + 0x28)
                rec["flag"] = (await rd(b, g13 + 0x00, 1, 4))[0]
            segs.append(rec)
            print("  f%-4d model %-5d  pos (%+.4f,%+.4f,%+.4f)  dir (%+.5f,%+.5f,%+.5f)"
                  % (frame, rec["model"], *rec["pos"], *rec["dir"]), flush=True)
            await b.call("continue")
            if not await b.wait_for_hits(since_seq=0, timeout=10.0):
                print("  (no more hits)", flush=True)
                break

        await b.call("pause")
        if HOLD:
            await b.call("eval", {"expr": f'manager.machine.ioport.ports[":IN1"]'
                                          f'.fields["{HOLD}"]:set_value(0)'})
        try:
            await b.call("clear_bp", {"tag": 941})
        except Exception as e:
            print("  (clear_bp:", e, ")", flush=True)
        # The bone cache the chains hang off, in the board's own words.
        w = await rd_cop(b, COP_BONE_CACHE, 16 * 12)
        bones = [w[i * 12:(i + 1) * 12] for i in range(16)]

        dump(segs, frames, bones)
        for s in (1, 2):
            m = bones[s]
            print("  bone slot %d  c0 (%+.3f,%+.3f,%+.3f)  c1 (%+.3f,%+.3f,%+.3f)  T (%+.3f,%+.3f,%+.3f)"
                  % (s, m[0], m[1], m[2], m[3], m[4], m[5], m[9], m[10], m[11]), flush=True)
    except Exception as e:
        # The bridge times out now and then on a long run. Keep the hits that
        # did land rather than losing the whole capture with them.
        print(f"\ncapture stopped early: {type(e).__name__}: {e}", flush=True)
        dump(segs, frames)
        raise
    finally:
        await b.shutdown_mame()


asyncio.run(main())
