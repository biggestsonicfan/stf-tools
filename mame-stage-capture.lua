-- Force the game into one stage, then capture what it loads.
--
-- Neither attract mode nor mashed inputs reliably reach a chosen arena, so this
-- pins stage_num (0x500064) to the wanted value every frame. change_scene reads
-- it whenever the game loads a scene, so the next fight is the stage we asked
-- for. Once texture RAM settles on something non-empty we dump both sheets, the
-- two colour LUTs, and a screenshot of the real render to compare geometry
-- against.
--
-- Run against a MAME that boots stock sfight: point -rompath at a directory
-- holding only the zips (a loose roms/sfight/ folder wins over the zip), and
-- pass -nodrc, or the SHARC recompiler fails the coprocessor self-test.
--
-- env: STAGE (slot number), OUT (dir), FRAMES (give up after this many),
--      SNAP_EVERY (also snapshot every N frames, to see where it got stuck)

local STAGE  = tonumber(os.getenv("STAGE") or "0")
local OUT    = os.getenv("OUT") or "."
local FRAMES = tonumber(os.getenv("FRAMES") or "40000")
local SNAP_EVERY = tonumber(os.getenv("SNAP_EVERY") or "0")
local MASH = os.getenv("MASH") == "1"
local STAGE_NUM = 0x500064
local SETTLE = tonumber(os.getenv("SETTLE") or "90")
local MIN_FRAME = tonumber(os.getenv("MIN_FRAME") or "600")

local frames, lastHash, settleAt, done = 0, nil, -1, false
local space

-- MAME block-buffers stdout when it is redirected, so progress also goes to a
-- file of our own that is flushed every line.
local logf = io.open(OUT .. "/capture.log", "w")
local function log(msg)
    print(msg)
    if logf then
        logf:write(msg)
        logf:write("\n")
        logf:flush()
    end
end

local function sampleHash()
    local h, nz = 5381, 0
    for a = 0, 0xfffff, 0x800 do
        local v = space:read_u32(0x11000000 + a)
        h = (h * 33 + v) % 0x7fffffff
        if v ~= 0 then nz = nz + 1 end
    end
    return h, nz / 512.0
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

local function capture(fill)
    local tag = string.format("stage%02d", STAGE)
    manager.machine.video:snapshot()
    dumpRange(string.format("%s/%s_texram0.bin", OUT, tag), 0x11000000, 0x100000, 4, "<I4")
    dumpRange(string.format("%s/%s_texram1.bin", OUT, tag), 0x11200000, 0x100000, 4, "<I4")
    dumpRange(string.format("%s/%s_lumaram.bin", OUT, tag), 0x11400000, 0x20000, 1, "B")
    dumpRange(string.format("%s/%s_colorxlat.bin", OUT, tag), 0x01810000, 0x0C000, 1, "B")
    log(string.format("[stage] captured stage %d at frame %d (%.0f%% filled)",
        STAGE, frames, fill * 100))
end

local function tick()
    if not space then space = manager.machine.devices[":maincpu"].spaces["program"] end
    if done then return end
    frames = frames + 1

    -- Pin the stage, and keep feeding coins and buttons so the game walks itself
    -- from the title through character select into a fight.
    if MASH and frames > 900 then
        space:write_u8(STAGE_NUM, STAGE)
        press(":IN0", "Coin 1", (frames % 600) < 8)
        local m = frames % 60
        press(":IN0", "1 Player Start", m < 6)
        press(":IN1", "P1 Punch", m >= 20 and m < 26)
        press(":IN1", "P1 Kick", m >= 40 and m < 46)
    end

    if frames % 30 ~= 0 then return end
    local h, fill = sampleHash()
    if h ~= lastHash then
        lastHash = h
        settleAt = frames + SETTLE
    elseif settleAt > 0 and frames >= settleAt and fill > 0.25 and frames > MIN_FRAME then
        settleAt = -1
        capture(fill)
        done = true
        manager.machine:exit()
    end

    if SNAP_EVERY > 0 and frames % SNAP_EVERY == 0 then
        manager.machine.video:snapshot()
        log(string.format("[stage] snap at frame %d stage_num=%d fill=%.0f%%",
            frames, space:read_u8(STAGE_NUM), fill * 100))
    elseif frames % 600 == 0 then
        log(string.format("[stage] frame %d stage_num=%d fill=%.0f%%",
            frames, space:read_u8(STAGE_NUM), fill * 100))
    end

    if frames >= FRAMES then
        log("[stage] gave up; texture RAM never settled")
        manager.machine:exit()
    end
end

local function safeTick()
    local ok, err = pcall(tick)
    if not ok then log('[stage] ERROR in tick: ' .. tostring(err)); done = true end
end

if emu.add_machine_frame_notifier then
    _G.__stage_sub = emu.add_machine_frame_notifier(safeTick)
else
    emu.register_frame_done(safeTick)
end
log("[stage] forcing stage " .. STAGE)
