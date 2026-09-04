-- Capture Model 2B texture RAM (plus the luma / colour-translate LUTs) every
-- time the game loads a different set.
--
-- The ROM's texture sheets are Huffman-packed (unpack_lod_data); they only
-- exist in a readable form once the game has unpacked them into texture RAM,
-- which it redoes on every scene change. Rather than guess when that happens,
-- this hashes a sample of texture RAM each frame and dumps whenever the hash
-- settles on a new, substantially non-empty value.
--
--   texram0   0x11000000  1MB     texram1   0x11200000  1MB
--   lumaram   0x11400000  0x20000 colorxlat 0x01810000  0xC000
--
-- Inputs are mashed so the game walks itself from the title through character
-- select and into fights; each stage it reaches yields another capture.
--
-- Set TEXRAM_KEY to capture on a key instead: play to whatever stage you want
-- in a normal (windowed, throttled) MAME session and press it. That is the only
-- reliable way to get a *specific* stage's set, since walking the game there
-- with scripted inputs is hit and miss.
--
-- env: TEXRAM_OUT (dir), TEXRAM_FRAMES (frames to run), TEXRAM_MAX (max dumps),
--      TEXRAM_KEY (e.g. KEYCODE_F12 — manual capture instead of automatic)

local OUT        = os.getenv("TEXRAM_OUT") or "."
local RUN_FRAMES = tonumber(os.getenv("TEXRAM_FRAMES") or "60000")
local MAX_DUMPS  = tonumber(os.getenv("TEXRAM_MAX") or "12")
local KEY        = os.getenv("TEXRAM_KEY")
local STAGE_NUM  = 0x500064
local SETTLE     = 180
local keyWasDown = false

local frames, lastHash, settleAt, dumps = 0, nil, -1, 0
local lutsDone = false
local hashes = {}
local space

local function sampleHash()
    local h, nz = 5381, 0
    for a = 0, 0xfffff, 0x400 do
        local v = space:read_u32(0x11000000 + a)
        h = (h * 33 + v) % 0x7fffffff
        if v ~= 0 then nz = nz + 1 end
        v = space:read_u32(0x11200000 + a)
        h = (h * 33 + v) % 0x7fffffff
        if v ~= 0 then nz = nz + 1 end
    end
    return h, nz / 2048.0
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

local function press(port, name, on)
    local p = manager.machine.ioport.ports[port]
    if not p then return end
    local fld = p.fields[name]
    if fld then fld:set_value(on and 1 or 0) end
end

local function dumpSet(stage, fill)
    dumps = dumps + 1
    local tag = string.format("set%02d_stage%02d", dumps, stage)
    dumpRange(string.format("%s/%s_texram0.bin", OUT, tag), 0x11000000, 0x100000, 4, "<I4")
    dumpRange(string.format("%s/%s_texram1.bin", OUT, tag), 0x11200000, 0x100000, 4, "<I4")
    if not lutsDone then
        dumpRange(OUT .. "/lumaram.bin",   0x11400000, 0x20000, 1, "B")
        dumpRange(OUT .. "/colorxlat.bin", 0x01810000, 0x0C000, 1, "B")
        lutsDone = true
        print("[texram] wrote lumaram.bin + colorxlat.bin")
    end
    print(string.format("[texram] frame %d: %s  (%.0f%% filled)", frames, tag, fill * 100))
end

local function tick()
    if not space then space = manager.machine.devices[":maincpu"].spaces["program"] end
    frames = frames + 1

    if KEY then
        local input = manager.machine.input
        local down = input:seq_pressed(input:seq_from_tokens(KEY))
        if down and not keyWasDown then
            local _, fill = sampleHash()
            dumpSet(space:read_u8(STAGE_NUM), fill)
        end
        keyWasDown = down
        return
    end

    -- Let the title and attract demos run untouched for a while (attract alone
    -- loads several texture sets), then coin up and mash so the game walks
    -- itself through character select and into fights.
    if frames > 6000 then
        press(":IN0", "Coin 1", (frames % 600) < 8)
        local m = frames % 60
        press(":IN0", "1 Player Start", m < 6)
        press(":IN1", "P1 Punch", m >= 20 and m < 26)
        press(":IN1", "P1 Kick", m >= 40 and m < 46)
    end

    if frames % 30 ~= 0 then return end          -- hashing every frame is wasteful

    local h, fill = sampleHash()
    if h ~= lastHash then
        lastHash = h
        settleAt = frames + SETTLE
    elseif settleAt > 0 and frames >= settleAt then
        settleAt = -1
        if fill > 0.25 and not hashes[h] and dumps < MAX_DUMPS then
            hashes[h] = true
            dumpSet(space:read_u8(STAGE_NUM), fill)
        end
    end

    if frames % 3000 == 0 then
        print(string.format("[texram] frame %d stage_num=%d fill=%.0f%% dumps=%d",
            frames, space:read_u8(STAGE_NUM), fill * 100, dumps))
    end
    if frames >= RUN_FRAMES or dumps >= MAX_DUMPS then manager.machine:exit() end
end

if emu.add_machine_frame_notifier then
    _G.__texram_sub = emu.add_machine_frame_notifier(tick)
else
    emu.register_frame_done(tick)
end
if KEY then
    print("[texram] press " .. KEY .. " to capture the current stage's textures")
else
    print("[texram] running " .. RUN_FRAMES .. " frames, up to " .. MAX_DUMPS .. " captures")
end
