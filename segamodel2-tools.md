# stf-tools and segamodel2-tools

A comparison of this repository (with the explorer it checks, `vendor/noclip`
at `edf32b0`) and
[xandoxan65/segamodel2-tools](https://github.com/xandoxan65/segamodel2-tools)
at `94e2b4b`. The point is what each could take from the other.

The two repositories come at the board from different directions.
segamodel2-tools reads Sega Rally (`srallyc`, Model 2A) statically. It has a
lifter that turns i960 code into C, and a C runtime for the geometry, TGP,
sound and hardware that the lifted code runs on. This repository holds a port
to MAME: texture RAM, the colour tables, display lists and motion are measured
against captures of a running machine, over Sonic The Fighters, Fighting Vipers,
House of the Dead and Daytona USA. So where the two disagree about what the
board does, this side usually has a measurement and that side has a reading.
It goes the other way on code: segamodel2-tools can run game code, and nothing
here can.

Paths below: plain names are this repository's, and `js/…` and `TECHNICAL.md`
are the explorer's. `B:` marks paths in segamodel2-tools.

## What segamodel2-tools could take from here

### Texture RAM

- **A sheet is 1 MB, not 2 MiB, and a bank is not copied flat.**
  `B:tools/extract/textures.py:125` copies main_data `0x02200000` and
  `0x02400000` straight in as two 2 MiB sheets (`B:tools/i960_memory.py`,
  `TEXTURERAM_BANK_SIZE`). `get_texel` only ever addresses 1 MB per sheet
  (`js/atlas.js`, `SHEET_BYTES`). No game handled here uploads by straight copy:
  - Daytona puts rows 0–767 on one sheet, then deals nine mip levels out in runs
    of `0x200>>k` (`js/texture.js`). `test-daytona-texram.mjs` holds this
    against MAME region by region.
  - House of the Dead puts the full-size half on one sheet and deals the mip
    half between both sheets by rectangle.
  - Sonic The Fighters decompresses Huffman pages (TECHNICAL.md).

  segamodel2-tools already names Sega Rally's upload routine (`0x3940`, jump
  table `0x5A2880`) but does not port it. The Daytona and HOTD ports are the
  pattern to follow.
- **Header bit `0x1000` selects a sheet.** It means the full-size level is on
  sheet 1, and the mip chain alternates sheets level by level (TECHNICAL.md,
  `js/viewer.js`). segamodel2-tools strips the bit and adds a +4 Y fix for
  billboards (`B:tools/model2_texture.py:183-200`), which looks like a symptom
  of the flat bank copy above. `stored_to_logical` (`:225`) is not the inverse
  of the x≥1024 fold that `get_texel` makes either.
- **Mip levels and LOD.** segamodel2-tools reads only level 0.

### Colour

- **Gamma after colorxlat.** `B:tools/model2_palette.py:8-11` says not to
  apply it, because gamma is "baked into colorxlat". The explorer applies
  `max(c-64,0)*255/191` after colorxlat (`js/viewer.js:354`), and that matched
  MAME's pixels exactly (the ring canvas rgb(48,120,0), the backdrop `0xF0C0` →
  rgb(0,0,184)). One of the two readings is wrong. Setting a Sega Rally frame
  beside a MAME screenshot would settle it.
- **Flat palette colours go through colorxlat at luma `0x40`**, then gamma
  (`js/atlas.js`). segamodel2-tools' `lookup_rgb15` uses `luma>>2`.
- **colorxlat is not a ramp.** Luma 48–63 of a row is a 16-colour scene
  palette, so those bands cannot be shaded. Per-polygon luma comes from the
  material slot in attr bits 18–22 (TECHNICAL.md, `js/viewer.js`).
- **Build the tables from ROM.** segamodel2-tools' default colorxlat and
  lumaram are synthetic (`B:tools/model2_palette.py:135-160`). The explorer
  runs the game's own routines (`js/colors.js`), and `test-colors.mjs` holds
  the result byte-exact against a capture. Its CGM work (the colorxlat DEF-table
  build at `0x33454`) is most of the way to the same place for Sega Rally.
- The docstring at `B:tools/model2_palette.py:103` gives the colour word as
  `xGGGGGRRRRRBBBBB`, and its own code reads R from bits 0–4.

### Geometry

- **A link-0 at the head of a mesh is drawn.**
  `B:tools/model2_geo.py:172-192` drops every link-type-0 face. At the head of
  a mesh there is no previous strip to end, and the four vertices are the first
  polygon the board draws: the 2×2 shadow card at y = −2. Dropping it leaves 70
  Sonic The Fighters models, 110 Fighting Vipers models and 813 Daytona models
  empty (`js/model.js:116-140`). A link-0 in the middle of a mesh does end the
  strip, as segamodel2-tools has it.
- **Find meshes through the model table, not by scanning.**
  segamodel2-tools scans the polygon ROM with plausibility filters
  (`B:tools/model2_geo.py:417-462`). main_data carries a model table of
  `{uv, material, mesh}` entries, with the mesh at `meshPtr*4 - 0x02000010 + 0x10`
  (`js/romset.js`, `js/games.js`). The entry is 20 bytes with the fields
  reordered on the original Model 2.
- **Lighting uses the ROM normal** at +0x1C, not the plane of the face
  (TECHNICAL.md).

### i960 lifter bugs

Each of these gives a different result from the board. Fixing them against
checks tied to the ROM would catch them.

1. **`cmpib*`/`cmpob*` compare only the low byte.** The `b` means *branch*;
   these compare all 32 bits. `B:tools/decomp/i960_ops.py:30-51` casts both
   sides to `(signed char)` or `(unsigned char)` (via `i960_regs.py`), and so
   does the copy in `B:liftkit/src/liftkit/arch/i960/i960_ops.py`.
2. **`ldl`/`ldq` write one register.** `B:tools/decomp/i960_mem_emit.py:90`
   emits `dst = (u32)i960_ld_u64(...)` and never writes the odd register(s).
   `ldq` is mapped to 64 bits. `stl`/`stq` store only `(u64)` of the first
   register.
3. **`movl` moves one register** (`B:tools/decomp/i960_ops.py:214`).
4. **Registers are `uintptr_t`** (`B:runtime/host/i960_lift.h`), and
   `addo`/`subo`/`shro` are emitted without a 32-bit mask. So `0 - 1` followed
   by `shro` does not give the i960's answer. A shift count of 32 or more is
   undefined in C, where the i960 gives 0.
5. `B:tools/decomp/asm_rom_diff.py` checks less than it seems to.
   `use_raw_words` (`B:tools/decomp/mame_to_gas960.py:106-139`) emits every
   multi-word instruction, every `cmp*`/`test*`/`call*`/`bal` and the byte
   memory ops as raw `.word`s, so those instructions match the ROM by
   construction.

### How to check the work

segamodel2-tools' tests are two liftkit smoke tests. The checks here that
carry over to another game are:

- **Captures from a running machine.** The MAME Lua scripts dump texture RAM,
  the colour tables and display lists (`mame-dump-texram.lua`,
  `mame-dl-capture.lua`, `mame-daytona-texram.lua`), and the checks store
  hashes (`texram-ref.json`) rather than the game's data.
- **Tests anchored to the ROM.** A routine is located by its instruction
  pattern with a standalone i960 decoder (`i960dis.mjs`), and the tests assert
  that the port's constants are the operands the code carries. Examples are
  `test-csum.mjs`, which checks against the eight checksums burnt into the ROM,
  and `test-motion.mjs`. segamodel2-tools has no decoder of its own: everything
  goes through MAME's `dasm` output for a hard-coded `srallycb`
  (`B:tools/disasm/mame_dasm.py`), and the result is parsed back out of text.
- **Chip recipes with CRCs** per set, including holes (`js/games.js`), and a
  check that names which set a run is about (`test-romset.mjs`).

## What this repository could take from segamodel2-tools

- **Running game code instead of hand-porting it.** Once the bugs above are
  fixed, the lifter (control-flow graph and ABI recovery, fused
  compare-and-branch, float emit with MAME semantics) and the host runtime
  would let a routine run as lifted code. Candidates are the texture uploads,
  the colour-table builds and the object routines that are ported by hand
  here, with the MAME captures that exist here as the check.
- **The original Model 2 and 2A coprocessor.** `B:tools/tgp/mb86233_dasm.py`
  is a full port of MAME's MB86233 disassembler, and it knows where the program
  is uploaded (`0x5F9E94`) and the FIFO dispatch table. This repository only
  knows the 2B SHARC. Daytona runs on the TGP.
- **Its display-list interpreter** (`B:tools/model2_geo_dl.py`) covers the
  whole 2A geometry command set, including the 24-bit raster floats. The
  display-list tools here replay captured FIFOs and only need the commands a
  capture carries.
- **Texture details the explorer does not have:** wrap bits 6/7 are ignored
  under mirroring, and colorbase falls back to `attr>>16` when th3 gives 0
  (`B:tools/model2_texture.py:120-164`). Both are worth checking against a
  capture here.
- **Sega Rally's CGM palette container** ("CGM 1.0", the `0x1111` bytecode).
  The explorer does not read Sega Rally yet. If it ever does, this is the
  starting point.

### What `i960dis.mjs` gets wrong, and MAME does not

- **Signed MEMB displacements.** They are never sign-extended, so
  `-0x10(g4)` prints as `0xfffffff0(g4)`.
- **Floating-point literals and registers print as integers.** A set M bit on
  a real op means fp0–3, +0.0 or +1.0.
- **Missing mnemonics** fall through to `reg_xxx`:
  - `fault*`
  - `dsubc` and `dmovt`
  - the `logeprl`/`logrl`/`exprl`/`logbnrl`/`tanrl`/`classrl` group
- **`bal` counts as a branch.** `disasmRange` and `callTargets` count `bal`
  targets towards the furthest branch, so a walk can go past a `ret` into the
  next function.
- **The Daytona alias.** The `+0x200000` fix for Daytona's alias assumes no
  other game branches below zero.

Every REG instruction prints three operands (`mov g0, 0, r3`), and
`test-csum.mjs` matches on that text. Any cleanup of the operand count has to
move that test with it.
