"""Drive MAME live over claude_mame's bridge to capture a stage's texture RAM.

The autoboot-script approach could only fire-and-forget: it had no way to look at
where the game actually was, so it never reliably reached a chosen arena. The
bridge in claude_mame/ solves that — it keeps a JSON-over-TCP channel open into a
running MAME, so this can press a button, look at the screen, and decide what to
press next.

`eval` on the bridge wraps its argument in `return (...)`, so it takes an
expression rather than statements; an immediately-invoked function expression
gets around that and lets the dump run inside Lua, where writing 2 MB is one
call instead of five hundred round trips.

Two MAME flags are load-bearing and are set here rather than left to the caller:
  -rompath  pointing at zips only, because a loose roms/sfight/ folder wins over
            sfight.zip and silently gives you a different game
  -nodrc    because the SHARC recompiler fails the coprocessor self-test

Run:  claude_mame/mcp_server/.venv/Scripts/python.exe mame-drive.py <outdir>
"""

import asyncio
import json
import os
import sys

CLAUDE_MAME = r"C:\Users\bigge\source\repos\ai\claude_mame"
sys.path.insert(0, os.path.join(CLAUDE_MAME, "mcp_server"))

# mame_client defaults MAME_EXE to tn160.exe, the cut-down i960 build. The
# model2 driver — and so sfight — only exists in the full mame.exe.
os.environ.setdefault("MAME_EXE_NAME", "mame.exe")

from mame_client import MameBridge  # noqa: E402

ROMPATH = sys.argv[2] if len(sys.argv) > 2 else r"C:\Users\bigge\AppData\Local\Temp\claude\c--Users-bigge-source-repos-ai-noclip\5e876ee6-7b31-462c-8b78-9beb10961aeb\scratchpad\roms"
OUTDIR = sys.argv[1] if len(sys.argv) > 1 else "."

STAGE_NUM = 0x500064


def lua(body: str) -> str:
    """Wrap statements so the bridge's expression-only eval will take them."""
    return "(function() " + body + " end)()"


class Driver:
    def __init__(self, bridge):
        self.b = bridge

    async def ev(self, body):
        r = await self.b.call("eval", {"expr": lua(body)})
        if not r.get("ok"):
            raise RuntimeError(f"lua failed: {r}")
        return r.get("result")

    async def press(self, port, field, hold=0.15):
        await self.ev(
            f'local f = manager.machine.ioport.ports["{port}"].fields["{field}"] '
            f'if f then f:set_value(1) end return "ok"')
        await asyncio.sleep(hold)
        await self.ev(
            f'local f = manager.machine.ioport.ports["{port}"].fields["{field}"] '
            f'if f then f:set_value(0) end return "ok"')

    async def stage_num(self):
        return int(await self.ev(
            f'return manager.machine.devices[":maincpu"].spaces["program"]'
            f':read_u8({STAGE_NUM})'))

    async def texfill(self):
        """Fraction of sampled texture RAM words that are non-zero."""
        return float(await self.ev(
            'local s = manager.machine.devices[":maincpu"].spaces["program"] '
            'local nz = 0 '
            'for a = 0, 0xfffff, 0x800 do '
            '  if s:read_u32(0x11000000 + a) ~= 0 then nz = nz + 1 end '
            '  if s:read_u32(0x11200000 + a) ~= 0 then nz = nz + 1 end '
            'end '
            'return nz / 1024.0'))

    async def texhash(self):
        return await self.ev(
            'local s = manager.machine.devices[":maincpu"].spaces["program"] '
            'local h = 5381 '
            'for a = 0, 0xfffff, 0x800 do '
            '  h = (h * 33 + s:read_u32(0x11000000 + a)) % 0x7fffffff '
            '  h = (h * 33 + s:read_u32(0x11200000 + a)) % 0x7fffffff '
            'end '
            'return h')

    async def dump(self, tag):
        """Write the sheets, the two colour LUTs and palette RAM from inside Lua.

        Palette RAM matters: the fill takes a face's colour from
        palram[colorbase + 0x1000], not from the table in the data ROM, and the
        two do not agree — reading the ROM one washes several surfaces out.
        """
        out = OUTDIR.replace("\\", "/")
        await self.ev(
            'local s = manager.machine.devices[":maincpu"].spaces["program"] '
            'local function grab(path, base, size, step) '
            '  local f = assert(io.open(path, "wb")) '
            '  local c = {} '
            '  for a = 0, size - 1, step do '
            '    if step == 4 then c[#c+1] = string.pack("<I4", s:read_u32(base + a)) '
            '    else c[#c+1] = string.pack("B", s:read_u8(base + a)) end '
            '    if #c == 4096 then f:write(table.concat(c)); c = {} end '
            '  end '
            '  if #c > 0 then f:write(table.concat(c)) end '
            '  f:close() '
            'end '
            f'grab("{out}/{tag}_texram0.bin", 0x11000000, 0x100000, 4) '
            f'grab("{out}/{tag}_texram1.bin", 0x11200000, 0x100000, 4) '
            f'grab("{out}/{tag}_lumaram.bin", 0x11400000, 0x20000, 1) '
            f'grab("{out}/{tag}_colorxlat.bin", 0x01810000, 0x0C000, 1) '
            f'grab("{out}/{tag}_palram.bin", 0x01800000, 0x04000, 1) '
            'return "ok"')

    async def snap(self):
        await self.b.call("snapshot")


async def main():
    os.makedirs(OUTDIR, exist_ok=True)
    bridge = MameBridge()
    d = Driver(bridge)
    try:
        print("launching MAME (real sfight, -nodrc)…", flush=True)
        await bridge.launch_mame("sfight", extra_args=[
            "-rompath", ROMPATH,
            "-nodrc",
            "-sound", "none",
            "-nothrottle",
            "-snapview", "auto",
            "-snapsize", "496x384",
            "-snapshot_directory", OUTDIR,
        ])
        print("bridge up:", json.dumps(bridge.hello), flush=True)
        await bridge.call("continue")

        # Let it clear the warning screen and settle into attract.
        await asyncio.sleep(20)
        print("boot: stage_num=%d fill=%.2f" % (await d.stage_num(), await d.texfill()), flush=True)
        await d.snap()

        # Coin up, then walk the front end: start, pick a character, start again.
        for step, (port, field) in enumerate([
            (":IN0", "Coin 1"), (":IN0", "Coin 1"),
            (":IN0", "1 Player Start"),
            (":IN1", "P1 Punch"),
            (":IN0", "1 Player Start"),
            (":IN1", "P1 Punch"),
            (":IN0", "1 Player Start"),
        ]):
            await d.press(port, field)
            await asyncio.sleep(6)
            await d.snap()
            print("step %d %s: stage_num=%d fill=%.2f" %
                  (step, field, await d.stage_num(), await d.texfill()), flush=True)

        # Watch for the texture set to change and settle, which is the scene load.
        last, stable = None, 0
        for i in range(60):
            h = await d.texhash()
            if h == last:
                stable += 1
            else:
                stable, last = 0, h
            if stable >= 3:
                break
            await asyncio.sleep(3)
        print("settled after %ds, stage_num=%d fill=%.2f"
              % (i * 3, await d.stage_num(), await d.texfill()), flush=True)

        await d.snap()
        tag = "stage%02d" % (await d.stage_num())
        await d.dump(tag)
        print("dumped", tag, flush=True)

    finally:
        await bridge.shutdown_mame()


if __name__ == "__main__":
    asyncio.run(main())
