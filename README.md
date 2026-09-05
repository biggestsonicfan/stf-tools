# stf-tools

Development and verification tools for the Sonic The Fighters explorer. None of
them are needed to *run* the explorer — that is a static site and lives in its
own repository. These are what hold the port to the board: the checks, the MAME
capture drivers, the ROM dumpers and the disassembler.

## Setup

The tools decode the ROM through the explorer's own modules, so they read them
rather than keeping a second copy. The explorer is a submodule:

```sh
git clone --recursive https://github.com/biggestsonicfan/stf-tools.git
cd stf-tools
npm install            # only for the four browser tools; the checks need nothing
```

An existing checkout that was cloned without `--recursive`:

```sh
git submodule update --init
```

`vendor/noclip` is pinned to a commit, so a check is always measured against a
known explorer rather than against whatever `master` happens to be. To move it
forward, `git -C vendor/noclip pull`, run `npm test`, and commit the new pointer.

Everything is run from the repository root — `node test-decode.mjs`, not from a
subdirectory — since that is where a check looks for `sfight.zip` and for the
captures beside it.

`npm start` serves the pinned submodule. To work on the explorer itself, point
the server at that working checkout instead, or the fixed commit is what you
will see:

```sh
STF_SITE=../noclip npm start
```

### The ROM

`npm test` needs `sfight.zip` in the repository root and nothing else. It is
never carried here and `.gitignore` refuses it. Neither is any of the game's own
data: the texture-RAM and colour checks measure against `texram-ref.json`,
SHA-256 over a MAME capture rather than the capture itself, and the binaries are
rebuilt from a ROM by `extract-texram.mjs` when they are wanted. The remaining
captures — `canyon-path.csv`, `motion-pose.csv` and the osage JSON — are
recordings of board state, and a check whose recording is missing says so and
skips rather than failing.

`npm test` runs every `test-*.mjs` below except `test-head-mame.mjs`, which is
incomplete and says so.

### Reading the table

Where the notes below name `js/something.js` or `TECHNICAL.md`, they mean the
explorer's, at `vendor/noclip/js/something.js` and `vendor/noclip/TECHNICAL.md`.
The imports in the scripts themselves spell the full path out.

## The tools

| script | what it does |
|--------|--------------|
| `serve.mjs` | zero-dependency static server on :8173, serving the explorer out of `vendor/noclip` rather than this repository — `$STF_SITE` points it at a working explorer checkout instead, `$PORT` moves it. Refuses `.zip` so the app can only ever get a ROM set from the user, and so a ROM sitting in this checkout is not on the port either |
| `shot.mjs` | one headless screenshot + console capture, via the system Edge |
| `shots.mjs` | several screenshots in one browser session, each after a snippet of page JS |
| `gl-check.mjs` | boots the viewer headlessly and reports the GL context, renderer string and any shader errors — first thing to run when the page comes up blank |
| `shot-upload.mjs` | drives the drop-zone path end to end and asserts the page never requests a `.zip` |
| `extract-rom.mjs` | splits a ROM set into the board's five regions as files, under the decompilation's own names, so they can be handed to a tool that wants files rather than a module. The interleave is `romset.js`'s — a Model 2 region is two 16-bit EPROMs a halfword at a time, and every region written here is a slice of what that module already assembles, so there is no second copy of which chips make up which — and its CRC-32 check over each member is what this refuses to write past. `--cpres` cuts the two DSP coprocessor executables out of the program ROM as i960 `.byte` arrays; `--split` goes the other way, a region back into the two chips, printing each half's CRC-32 and MD5. `--rom` (repeatable), `--out`, `--region`, `--list`, `--force`. Writes to a temp directory rather than into the checkout, like `extract-texram.mjs` |
| `extract-labels.mjs` | recovers the board's own symbol table out of a Lost Judgment / YAMP port DLL. Sega shipped those ports with the original i960 symbol table still inside the host binary — a run of 16-byte `.rdata` records, each a board offset beside a pointer to the C string naming it, `start_ip` at `0xB0` first and 799 more after it in ascending order. Nothing in the DLL points at those strings, so a string search finds the names and loses the addresses; this walks the records. The table is found by shape rather than by address — a plausible board offset next to an identifier-shaped string, the longest unbroken run whose offsets never go backwards — so the same command works on the other Model 2 port DLLs beside it, each of which yields exactly one table: Fighting Vipers 742, Virtua Fighter 2 301, Cyber Troopers Virtual-On 276 and Motor Raid 15249, that last one a whole linker map rather than a function list. A DLL carrying no such run says so rather than guessing. What it recovers was measured against the hand-transcribed label files that predate it, and is a superset of them: Sonic the Fighters, Fighting Vipers and Virtual-On come out byte for byte identical, and the two that differ do so only by symbols the hand pass had dropped — Virtua Fighter 2's `0x313D8 chk_input`, and Motor Raid's first two records and its last. `--json` (the default) emits `labels.segment.<segment>.offset-label`; `--merge` splices that object into an existing per-game JSON and leaves the rest alone; `--list`, `--pairs` and `--names` are the other three renderings; `--check <json>` compares against one already written; `--tables` lists every run found and emits nothing. Every format comes out byte for byte identical to the hand-made copies, so a rewrite is an empty diff. `--dll` (required), `--out` |
| `csum.mjs` | the board's own ROM checksum, ported. The self-test sums a chip at a time rather than a region at a time — a region is two 16-bit EPROMs interleaved, so the routine adds two bytes, steps four, and its `alignment` argument is which half it starts on — and what it sums is a table of eight records naming the program ROM and both data ROMs as their two chips each. The two words the routine steps over are the program ROM's own two checksums, which cannot be inside the sum that produces them |
| `test-csum.mjs` | the check, and the one whose reference the game carries itself: eight numbers burnt beside the ROMs by Sega's mastering tools, which a correct port has to arrive at. Nothing is given the routine's address — it is found by the four instructions it opens with, and its table by the one `call` that reaches it — and then every constant the port carries has to be an operand they carry: the two bytes added and four stepped that make it a chip's sum, the halved count, the halfword the alignment starts on, the word address the skips compare against, the 16 bits the total is cut to, and the table's address, stride and length. Then the records: each addressable, each span inside the region it names, each pair the two halves of one region, and the two skipped words exactly the two records that sum the ROM those words are burnt in. Then all eight sums against all eight burnt words |
| `test-decode.mjs` | decodes every model-table entry and reports counts — the polygon decoder's smoke test |
| `test-texram.mjs` | verifies the ported unpack routines (`js/texture.js`) byte for byte against a MAME capture of texture RAM, via the digests in `texram-ref.json`. With a real capture on disk (`$STF_TEXRAM`) it reports the differing bytes too |
| `test-colors.mjs` | verifies the ported colour tables (`js/colors.js`) against the same capture, row by row — which is the unit every one of its comparisons is made in |
| `texram.md` | how texture RAM is come by without keeping any of it here: rebuilding the binaries from a ROM, what the checks measure against instead, and how to take a fresh MAME capture |
| `texref.mjs` | the slices both of those hash, in one place so the manifest and the checks cannot drift into hashing different ones |
| `texram-ref.json` | the reference itself: SHA-256 over a MAME capture of texture RAM, luma RAM and colorxlat. A few kB of hashes in place of 2.2 MB of the game's data, making the same statement — a single wrong texel still fails |
| `make-texref.mjs` | rebuilds that manifest from a real capture. Refuses a directory `extract-texram.mjs` wrote, since a reference built from the port would be the port measuring itself |
| `extract-texram.mjs` | rebuilds `texram0/1.bin`, `lumaram.bin` and `colorxlat.bin` from a ROM set, so none of them have to be carried here. Writes to a temp directory rather than into the checkout. `--rom`, `--out`, `--stage`, `--fighter` |
| `test-texaddr.mjs` | checks the tile addressing in the fill shader against `fetch_bilinear_texel` — every tile size, mirrored and not. The shader's copy is GLSL and cannot be imported, so this pins the mapping to the board's rather than to the shader |
| `scroll.mjs` | the 2D scroll layer — the logos, the HUD, the character-select portraits and the text, none of which are geometry or in the texture ROM. A port of the four `Scroll…_Initialize` walks and the pattern blit that build tile RAM, palette RAM and the name table at runtime, plus the tilemap and 4bpp tile decode on top. Which of the 92 tile-and-colour sets a picture was drawn with is in the code rather than in the tables, so `coverage()` recovers it: the set that uploaded every tile a picture names |
| `extract-scroll.mjs` | that as files: every one of the 534 pictures as a PNG, paired with the set that covers it. `--list`, `--cell`, `--set`, `--every-set` for each distinct pairing, `--loose` for the brute force over all 48,000 cell/set pairs, `--rom`, `--out-dir`. Writes to a temp directory rather than into the checkout, like `extract-texram.mjs` |
| `test-scroll.mjs` | the check, and it has no capture to measure against — nothing here records what the board's tile chip held — so it holds the port against the ROM two ways. The routines are not named by address but found, by scanning the program ROM for the instruction that loads each table; then every constant the port carries has to be an operand those routines carry: the 92 sets, 32 bytes to a tile, two colours to a word, the two `…_Initialize2` banks, the palette field's position in a tilemap entry, the name table's row stride and — the one thing a record cannot say, since it holds two bare numbers — which of its dimensions the blit runs across a row. Then the tables: every even index tiles and every odd one colours, every upload inside the RAM it is addressed into, every picture a size a row can hold, and every tile some set uploads. Then all 534 decode against the set that covers them, none painting nothing and none reading a colour its set never wrote |
| `test-carpet.mjs` | checks the Flying Carpet's flight path, that its world prologue really is the arena's frame, and that the sphynx head follows the look-at `draw_sphynx_head` builds |
| `test-objects.mjs` | checks the per-stage object routines: that every stage runs what its record's object table names, that the blimp, the reels, the gears, the diamonds and the propellers turn at the rates the listing sets, that the swing and the clouds come back to where they started, that the aurora's texture-point override really does replace the model's own points and slides them half a texel a frame, that its walrus statues are drawn untransformed with their reflection mirrored under them and stand outside the ring, that the Death Egg's Earth is the flat card its transform assumes and its floor's texture points walk u four texels every eighth frame, and that every model named decodes |
| `canyon-path.csv` | one recording made by `mame-canyon-path.py` below, kept so that check runs without a MAME: what the board wrote into the prologue on every frame of a real ride. `test-canyon.mjs` reads it if it is there |
| `test-canyon.mjs` | checks Canyon Cruise: that the flight script, the heading table and the object runs read as the routines index them, that the interpolated path goes through its keys with no kink in the speed across one, that the run loops back to where `canyon_init` snaps it, that the tunnel light dims the boat and not the canyon and comes back to the record's own materials, and that the world prologue is the boat's frame inverted. With a recording alongside it (`canyon-path.csv`) it also holds the flight against the board frame for frame |
| `test-eggman.mjs` | checks the Final Eggman Boss: that the record's ground chunks, backdrop and corner post — all of them the Death Egg's, copied — are the ones the slot's own branches throw away, and that what `sub_2731C` puts there instead arrives in the one transform it draws everything in |
| `test-zsort.mjs` | checks the polygon's own depth: that every emitted face resolves the attribute word's z-sort mode, that the mode is one its own records ask for, and that Casino Night's emerald comes out in front of the plate it is modelled under, that a decal is cut the way the surface under it was cut, and that South Island's floor plate 517 is tied by the sea 555 on the same four corners and mode — the pair nothing but the order can part, which is why `js/viewer.js` stands the floor a depth unit back. The shader's copy of the rule is GLSL and cannot be imported, so this pins it to `model2_v.cpp` rather than to the shader |
| `i960dis.mjs` | an i960 KB disassembler over the program ROM: `node i960dis.mjs <hex addr> [hex len]`, with the routines every stage record names labelled. Enough of the instruction set to read the game's own draw routines, which is where the coprocessor command words and the constants a routine hands them come from — the Death Egg's Earth and its floor's texture scroll were read off it |
| `stages.mjs` | dumps all 16 `stage_data` records; used to verify the field offsets against stfdecomp |
| `parts.mjs` | dumps a fighter's part meshes and their bounds; used to work out the rig convention |
| `motions.mjs` | resolves `offset_list_motions` and dumps motion record headers |
| `test-motion.mjs` | checks the motion format against the ROM: that every one of the 518 blocks parses and its key streams end before the next block starts, that key times rise and stay inside the frame count, that a key samples back to its own value, that curves stay near the keys they are drawn through, and that the Hermite tangent scale is the 30 the data states twice over. Then the pose: every fighter's skeleton reads as real geometry, a posed limb keeps both its bone lengths on every frame, and no limb ends further from its pivot than it can reach. Then the parts that are not on the skeleton — the sway chains, and Tails' tails: that only Tails and his mirror double carry a tail cycle, that both cycles close and the mirror table is the normal one reordered vertex for vertex, that the pair leaves one point on the pelvis and splays the 45° the display list's two turns accumulate to, and that on his stance both tails hang behind and below the waist. Then Metal Sonic's jet: that only he and his mirror entry carry a plume cycle, that the two tables read in the order the flat copy at `0x97568` states, that each table's four are in order, that the chest the body table opens is the one his part table holds and the one the flame's guard rejects, and that on every one of his own motions the plume leaves the chest's origin and runs out behind him. Then the Egg robots' two frame-counter animations, which have no capture to measure against and are held against the instruction stream instead — `i960dis.mjs` walks both routines, and the port's shift, mask, window bits, clamp, spin step, direction bit and character indices all have to be the operands the board's own code carries; the three tables are pinned by having to be readable at one of the addresses their routine names, no address being written down here. Then their arithmetic: that the arms fold and close, that the held pose is the middle of the ramp and not of the sixteen, that 48 of every 256 frames move the head and the fourth quarter's routine is the address the guards branch to, that the spin closes a full turn and reverses on bit 8, and that no arm or head model is on anybody's part table. Then the faces the part tables do not name: that the base face table really is a copy of variant 0 pointer for pointer, that every id the twenty-one variant tables give decodes, and that Honey's open-mouthed head 3580 is among the ones no part table reaches; and the eyes' own texture points, that each block is exactly as long as the stream its eye model walks and that Espio's second eye is one of the ones that really do differ from the model's own |
| `mame-motion.py` | drives MAME into a real fight and captures the display list with the motion number and motion frame beside each frame's slice, so the decoded motion can be held against the board rather than against the argument for it. `FRAMES` and `KEEP_MASH` in the environment |
| `mame-motion-capture.lua` | the in-MAME half of that: walks the front end into a fight, taps the FIFO, and records `p1_motion_num` / `p1_motion_coma` / the character on every frame notifier |
| `motion-pose.csv` | one recording made by the pair above, kept so that check runs without a MAME: what the board actually posed P1 with on 328 frames of two motions on two characters |
| `test-motion-mame.mjs` | the check itself: pulls the `set_body` and `ik_2bone` arguments out of a capture — the waist position, the body and limb eulers, the four IK targets, the pivots and bone lengths — and holds every one against what `js/motion.js` and `js/pose.js` produce for the same motion at the same frame. Reads `motion-pose.csv` by default; `--save` remakes it from a fresh capture. The eight frames `smooth_int` eases a new motion in over are reported rather than asserted on, since the viewer cuts to a motion instead |
| `dl-rig.mjs` | rebuilds a fighter's own matrices out of a display list, which `dl-verify.mjs` cannot: a fighter's parts are not placed by explicit transforms but handed to the coprocessor with op `0x67` into a TGP matrix slot (`0x3A00` for P1, `0x3B00` for P2, `0x0C` a slot). Nothing in either ADSP's data space holds them as floats, so they are replayed from the stream instead. Splits a frame per fighter on `set_body` and carries each one's waist and facing |
| `test-head-mame.mjs` | the chest and head against the board — the one part of the rig `test-motion-mame.mjs` does not reach, since those are a matrix rather than arguments. **Incomplete**: the replay still lacks ops `0x07`, `0x29`, `0x39`, `0x35`, `0x0F`, `0x69`, `0x12`, `0x5E`, `0x5C`, so it drifts before the head and its mismatches are its own. Not in `npm test` |
| `mame-osage.py` | drives MAME into a real fight as one of the five fighters that have sway chains and breakpoints the return of `os_set_osage`, reading the chain's own state at every segment of every frame. `HITS` and `HOLD` in the environment: `HOLD` names a `:IN1` field kept pressed for the whole capture, so the chain is read while the fighter is moving — the only condition under which the capture can tell a chain that carries momentum from one that does not. Reads the bones and the chain state once a frame rather than once a segment, and writes whatever it has if the bridge times out partway |
| `osage-fang-segments.json` | a second recording, of Fang's tail: the three segments' own state with the bone matrices the board drew them off, which `test-motion.mjs` puts back through the osage frame and holds against what `js/osage.js` builds from the tables alone |
| `osage-honey-motion.json` | one recording made by it, kept so that check runs without a MAME: 36 frames of Honey walking across two motions, with her three chains' state and the two bones they hang off |
| `test-osage-mame.mjs` | the check itself, and it settles whether the pigtails flow with the motion: that bit 0 of every chain's flag word — the bit gating the sway integrator in both `os_set_matrix` and `os_set_osage` — is clear, that the running position never leaves the chain root, that the sway direction never changes and is exactly the gravity constant long, that the wind vector is zero, and that its phase steps `0x11C7` a frame driving nothing. All six hold while the chest bone moves 0.388 and the head 0.124, so the sway is in the ROM and switched off, and the rest pose the viewer draws is what the board draws |
| `mame-drive.py` | drives MAME live over claude_mame's bridge into an actual fight and dumps texture RAM, palette RAM and the colour LUTs — the one that reliably reaches a chosen stage |
| `mame-capture-dl.py` | drives MAME into a chosen stage and captures the display list itself — every word the i960 writes to the coprocessor *and* the geometry processor, split into frames, with the game's frame counter beside each. `FRAMES`, `KEEP_MASH` and `SETTLE` in the environment |
| `mame-dl-capture.lua` | the in-MAME half of that: pins stage_num, walks the front end, taps the FIFO, and verifies the loaded stage record against the one in ROM before anything is captured |
| `dl-verify.mjs` | decodes a captured display list into (model, matrix) draws — command segmentation, the matrix stack, and the board/viewer coordinate conventions in one place. Walks both ports in write order, since a part handed straight to the geometry processor is drawn at the matrix the coprocessor has built by that point |
| `verify-stage.mjs` | the check itself: every arena draw the board emitted must equal `C · M` for the viewer's own `M` and one view matrix `C` read out of the display list. Prints the residual transform for any part that disagrees |
| `dl-order.mjs` | reads the board's own submission order for two models out of a display-list capture, walking both ports in write order. For the pair that needs it — South Island's floor plate (517) and the sea (555), which sort on the same four corners and so tie at every camera — the order is the only thing that decides which one is on screen, and this reads it off the board rather than guessing |
| `mame-canyon-path.py` | drives MAME into Canyon Cruise and records the boat's own flight — `stage_xpos/ypos/zpos`, the three prologue angles and the object's timeline counter, once a frame — so the ported curve can be held against the board rather than against the argument for it. `FRAMES` in the environment |
| `mame-canyon-path.lua` | the in-MAME half of that: pins `stage_num`, walks the front end, and samples the stage's own state on every frame notifier |
| `mame-stage-capture.lua` | pins stage_num and drives inputs toward one stage, dumping when texture RAM settles |
| `mame-request-texset.lua` | a dead end, kept for the finding: poking send_tex_stage's command at 0x5502E0 does not make the game unpack that set |
| `mame-dump-texram.lua` | MAME autoboot script that captures texture RAM plus the luma / colorxlat LUTs — see the Textures section of TECHNICAL.md |
| `dump-atlas.mjs` | decode a sheet pair into a PNG, to check a dump before loading it: `node dump-atlas.mjs out.png [dir]` |
| `find-texels.mjs` | scan every ROM region for image-like 4-bit blocks; this is what showed the sheets are not stored raw |
| `dump-texram.mjs` | same capture over m2-hle2's MCP bridge instead of MAME |
| `mcp.mjs` | one-shot command against m2-hle2's MCP bridge |
| `inspect-si.mjs` | dumps the South Island tables and model bounds used to work out the stage draw list |
| `dump-linear.mjs` | renders a linear 4-bit block of any ROM region as a PNG, for looking at a block whose layout is not yet known |
| `dumpbank.mjs`, `png.mjs` | decode each 1 MB window of the texture ROM as a Model 2 sheet and write it as a PNG (`png.mjs` writes the greyscale one that wants and the RGBA one `extract-scroll.mjs` does). This is what established that the sheets are packed rather than raw — see the Textures section of TECHNICAL.md |

`shot.mjs` / `shots.mjs` need `npm install` (they use `puppeteer-core` against
the installed Edge) and a running `serve.mjs`.

## AI usage

This repository's own log is six commits, all on 2026-09-04 and all carrying a
`Co-Authored-By: Claude Opus 5` trailer. The first three are only the split —
lifting these files out of the explorer, repointing their imports at the
submodule and moving the pin; the three after them are the scroll layer, the
ROM splitter and checksum, and the symbol-table recovery, written here. The rest were written before that, in
the explorer's repository, across the 35 commits of 2026-08-31 to 2026-09-03
that are AI co-authored without exception. That per-commit record is in neither
repository: every commit before the last carried 2 MB of the game's own texture
RAM, so rather than publish it the explorer starts at a single commit, and these
files arrived here in one more.

**What AI did.** Wrote all of it. The fifteen `test-*.mjs`, the i960
disassembler, the five MAME drivers and the six Lua scripts that are their
in-emulator halves, the display-list decoders, the texture-RAM manifest and the
server were written in Claude Code sessions, and so was the split that made them
a repository.

**What AI did not provide.**

- *The reverse engineering.* No model touched it. `stfdecomp` is 100% human
  reversed and written, and it predates all of this. Every ROM address, table
  layout and routine name these checks assert against was worked out by hand;
  when `test-objects.mjs` says a stage runs what its record's object table
  names, that table was read by a person first. Take that away and there is
  nothing here to check anything with.
- *The verdict on whether any of it is right.* This is the part worth being
  plain about, because these files **are** the measuring apparatus, and a check
  written by the same model that wrote the code it checks proves nothing on its
  own. What makes them worth anything is that they do not measure the port
  against itself. They measure it against MAME: texture RAM and both colour
  tables byte-exact against a capture of a running machine, the viewer's draw
  list against display lists captured off the board, the decoded motion against
  the arguments the board actually posed a fighter with. `make-texref.mjs`
  refuses any directory `extract-texram.mjs` wrote, for exactly this reason — a
  reference rebuilt from the port would be the port grading itself. Where there
  is no capture to measure against — the Egg robots' two animations — the check
  says so and holds the port against the instruction stream instead.
  `test-head-mame.mjs` is incomplete, says so in its own header, and is kept out
  of `npm test` rather than reported as a pass.
- *The recordings.* `canyon-path.csv`, `motion-pose.csv` and the osage JSON are
  not generated. Each is a capture of a real board under MAME, kept so a check
  runs without one; a check whose recording is missing skips rather than
  inventing it.
- *Direction.* Which result was worth believing, which was a plausible first
  answer that measurement refused, and what to build next was mine.
