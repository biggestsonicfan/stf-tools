-- DOES NOT WORK - kept for the finding, not as a tool.
--
-- Ask the game to unpack one texture set, without navigating to a stage.
--
-- send_tex_stage() (rom_code1.s) does nothing but raise busy_signal_flag and
-- drop a four-word command at 0x5502E0:
--
--   0x5502E0 = 3          command: load a stage texture set
--   0x5502E4 = texnum A   the value the stage record holds at +0x0C
--   0x5502E8 = texnum B   ...and at +0x0E
--   0x5502EC = spare
--
-- unp_send_tex_para() picks that up on its next pass and runs the Huffman
-- unpacker over the pages, filling texture RAM. Writing the command ourselves
-- gets any stage's textures in seconds, instead of trying to drive the game
-- through character select into a fight — which under -nodrc takes many minutes
-- and often does not arrive.
--
-- In practice nothing consumes the command: after poking it, 0x5502E0 still
-- reads 3 and texture RAM comes back byte-identical to its boot contents. So
-- unp_send_tex_para only services these while the game is in a state that also
-- populates the request slots at 0x550168..0x5502A8, which send_tex_stage alone
-- does not do. Reaching a stage for real is still the only route.
--
-- env: TEXA, TEXB (the stage record's two texture numbers), TAG (output name),
--      OUT (dir), FRAMES, POKE_AT (frame to issue the request on)

local TEXA    = tonumber(os.getenv("TEXA") or "2")
local TEXB    = tonumber(os.getenv("TEXB") or "0")
local TAG     = os.getenv("TAG") or string.format("tex%02d_%02d", TEXA, TEXB)
local OUT     = os.getenv("OUT") or "."
local FRAMES  = tonumber(os.getenv("FRAMES") or "12000")
local POKE_AT = tonumber(os.getenv("POKE_AT") or "1200")

local BUSY  = 0x550000
local CMD   = 0x5502E0
local SETTLE = 120

local frames, lastHash, settleAt, poked, done = 0, nil, -1, false, false
local space

local logf = io.open(OUT .. "/request.log", "w")
local function log(msg)
    print(msg)
    if logf then logf:write(msg); logf:write("\n"); logf:flush() end
end

local function sampleHash()
    local h, nz = 5381, 0
    for a = 0, 0xfffff, 0x800 do
        local v = space:read_u32(0x11000000 + a)
        h = (h * 33 + v) % 0x7fffffff
        if v ~= 0 then nz = nz + 1 end
        v = space:read_u32(0x11200000 + a)
        h = (h * 33 + v) % 0x7fffffff
        if v ~= 0 then nz = nz + 1 end
    end
    return h, nz / 1024.0
end

local function dumpRange(path, base, size, step, fmt)
    local f = assert(io.open(path, "wb"))
    local chunk = {}
    for a = 0, size - 1, step do
        chunk[#chunk + 1] = string.pack(fmt,
            step == 4 and space:read_u32(base + a) or space:read_u8(base + a))
        if #chunk == 4096 then f:write(table.concat(chunk)); chunk = {} end
    end
    if #chunk > 0 then f:write(table.concat(chunk)) end
    f:close()
end

local function capture(fill)
    dumpRange(string.format("%s/%s_texram0.bin", OUT, TAG), 0x11000000, 0x100000, 4, "<I4")
    dumpRange(string.format("%s/%s_texram1.bin", OUT, TAG), 0x11200000, 0x100000, 4, "<I4")
    dumpRange(string.format("%s/%s_lumaram.bin", OUT, TAG), 0x11400000, 0x20000, 1, "B")
    dumpRange(string.format("%s/%s_colorxlat.bin", OUT, TAG), 0x01810000, 0x0C000, 1, "B")
    log(string.format("[texset] captured %s at frame %d (%.0f%% filled)", TAG, frames, fill * 100))
end

local function tick()
    if not space then space = manager.machine.devices[":maincpu"].spaces["program"] end
    if done then return end
    frames = frames + 1

    if frames == POKE_AT then
        space:write_u32(BUSY, 1)
        space:write_u32(CMD + 0x0, 3)
        space:write_u32(CMD + 0x4, TEXA)
        space:write_u32(CMD + 0x8, TEXB)
        space:write_u32(CMD + 0xc, 0)
        poked = true
        lastHash = nil
        log(string.format("[texset] requested set (%d, %d) at frame %d", TEXA, TEXB, frames))
    end

    if frames % 30 ~= 0 then return end
    local h, fill = sampleHash()
    if h ~= lastHash then
        lastHash = h
        settleAt = frames + SETTLE
    elseif poked and settleAt > 0 and frames >= settleAt and fill > 0.25 then
        settleAt = -1
        capture(fill)
        done = true
        manager.machine:exit()
    end

    if frames % 600 == 0 then
        log(string.format("[texset] frame %d fill=%.0f%% cmd=%d", frames, fill * 100,
            space:read_u32(CMD)))
    end
    if frames >= FRAMES then
        log("[texset] gave up")
        manager.machine:exit()
    end
end

local function safeTick()
    local ok, err = pcall(tick)
    if not ok then log("[texset] ERROR: " .. tostring(err)); done = true end
end

if emu.add_machine_frame_notifier then
    _G.__texset_sub = emu.add_machine_frame_notifier(safeTick)
else
    emu.register_frame_done(safeTick)
end
log(string.format("[texset] will request (%d, %d) at frame %d", TEXA, TEXB, POKE_AT))
