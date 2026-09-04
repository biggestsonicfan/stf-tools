# Texture RAM

None of the game's data is in this repository, texture RAM included. The
binaries are rebuilt from a ROM set on demand, and the checks that hold the port
to real hardware measure against digests rather than against the capture they
were taken from.

## Rebuilding the binaries

About 85% of the texture pages are compressed, so the sheets do not exist in
ROM in a readable form — the game unpacks them into texture RAM on every scene
change. `js/texture.js` and `js/colors.js` are ports of the routines that do
that, so a ROM set is enough to rebuild all four files:

```
node extract-texram.mjs                          # South Island, into the temp dir
node extract-texram.mjs --stage 5 --fighter 0
node extract-texram.mjs --rom path/to/sfight.zip --out /tmp/tex
```

That writes `texram0.bin`, `texram1.bin`, `lumaram.bin` and `colorxlat.bin` —
what `dump-atlas.mjs` reads (pass the same directory as its second
argument), and what the viewer's **Textures** panel accepts from the sidebar.
The default output directory is under the system temp directory rather than in
the checkout, deliberately: this is the game's data, and 2.2 MB of it should not
be sitting somewhere a stray `git add -A` can sweep up.

The viewer does not need any of it: it builds the same sheets from the ROM in
the browser. These files are for looking at a sheet outside it.

They are *derived*. They are what the port believes the board would hold, which
is why `make-texref.mjs` refuses to build a reference from them.

## Checking the port against real hardware

`test-texram.mjs` and `test-colors.mjs` hold the ported routines
against a MAME capture of the actual board. The capture is not here; what is
tracked is `texram-ref.json`, SHA-256 over it, cut at the slices those
checks compare at — 64 kB blocks for the sheets, row by row for colorxlat,
which is the unit every one of the colour comparisons is made in anyway. A
single wrong texel still fails, and the manifest is a few kB of hashes rather
than 2.2 MB of the game's bytes.

To replace the reference with a fresh capture, take one and run
`node make-texref.mjs --in <dir>`.

## Taking a capture

`mame-stage-capture.lua` forces a stage and dumps once texture RAM
settles; `mame-dump-texram.lua` with `TEXRAM_KEY=KEYCODE_F12` dumps
whatever is on screen when you press the key. Both need a MAME that actually
boots stock `sfight` — point `-rompath` at a directory holding only the zips, or
the loose folder wins:

```
mame.exe sfight -rompath <dir-with-only-zips> \
  -autoboot_script mame-dump-texram.lua
```

Two things are easy to get wrong, and both give you a dump that looks fine and
is from the wrong place:

- A loose `roms/sfight/` folder wins over `sfight.zip`, so if it holds hacked
  program ROMs you capture a different game. Give `-rompath` a directory with
  only the zips and check `-verifyroms sfight` says *good*. The reference in
  this tree was very nearly taken that way round: an early set of dumps turned
  out to be a homebrew's textures, because `claude_mame/mame/roms/sfight/` is a
  directory of hacked program ROMs and MAME loaded it in preference to the zip.
- `-nodrc` is required. Without it the SHARC recompiler fails the coprocessor
  self-test and the game sits on "CO-PROCESSOR ERROR!! 50E000" having uploaded
  nothing. It makes emulation much slower, so capture early.
