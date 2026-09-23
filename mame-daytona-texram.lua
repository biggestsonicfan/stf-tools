-- Capture Daytona USA's texture RAM, for grading the explorer's sheets.
--
-- The original Model 2 keeps its two sheets at 0x12000000 and 0x12400000, a
-- halfword to every 32-bit word the i960 writes (model2.cpp, tex0_w/tex1_w),
-- and MAME packs them into the shares `textureram0` and `textureram1`, 1MB
-- each, in the order the halfwords arrive — which is the order js/texture.js
-- builds its sheets in. So a share read out as little-endian words is directly
-- comparable with the explorer's sheet.
--
-- The game uploads the bank every course shares at boot and the course's own
-- bank when a course starts, so this hashes a sample of both sheets every frame
-- and dumps whenever the hash settles on a new value, writing sel_course
-- (work RAM 0x501460) beside each dump so the grader knows which bank to
-- expect. Inputs are left alone: the attract loop reaches a course by itself.
--
-- The attract loop opens on the Three-Seven Speedway, so to reach another
-- course's bank TEXRAM_COURSE holds sel_course at that course from the first
-- frame until the first dump; send_tex_map picks the bank by sel_course alone.
--
-- env: TEXRAM_OUT (dir), TEXRAM_FRAMES (frames to run), TEXRAM_MAX (max dumps),
--      TEXRAM_COURSE (0-2, optional)

local COURSE     = tonumber(os.getenv("TEXRAM_COURSE") or "")
local OUT        = os.getenv("TEXRAM_OUT") or "."
local RUN_FRAMES = tonumber(os.getenv("TEXRAM_FRAMES") or "20000")
local MAX_DUMPS  = tonumber(os.getenv("TEXRAM_MAX") or "6")
local SEL_COURSE = 0x501460
local SETTLE     = 30

local frames, lastHash, settleAt, dumps = 0, nil, -1, 0
local dumped = {}
local space, sheets

local function sampleHash()
    local h, nz = 5381, 0
    for _, s in ipairs(sheets) do
        for a = 0, 0xfffff, 0x800 do
            local v = s:read_u32(a)
            h = (h * 33 + v) % 0x7fffffff
            if v ~= 0 then nz = nz + 1 end
        end
    end
    return h, nz
end

local function dumpShare(path, share)
    local f = assert(io.open(path, "wb"))
    local chunk = {}
    for a = 0, 0xfffff, 4 do
        chunk[#chunk + 1] = string.pack("<I4", share:read_u32(a))
        if #chunk == 4096 then f:write(table.concat(chunk)); chunk = {} end
    end
    if #chunk > 0 then f:write(table.concat(chunk)) end
    f:close()
end

emu.register_frame_done(function()
    if not space then
        space = manager.machine.devices[":maincpu"].spaces["program"]
        sheets = { manager.machine.memory.shares[":textureram0"], manager.machine.memory.shares[":textureram1"] }
    end
    frames = frames + 1
    if COURSE and dumps == 0 then space:write_u8(SEL_COURSE, COURSE) end
    if frames % 600 == 0 then
        print(string.format("[texram] frame %d, sel_course %d, dumps %d", frames, space:read_u8(SEL_COURSE), dumps))
    end
    local h, nz = sampleHash()
    if h ~= lastHash then lastHash = h; settleAt = frames + SETTLE end
    if frames == settleAt and nz > 64 and not dumped[h] then
        dumped[h] = true
        dumps = dumps + 1
        local course = space:read_u8(SEL_COURSE)
        local base = string.format("%s/daytona_%02d_f%d_c%d", OUT, dumps, frames, course)
        dumpShare(base .. "_sheet0.bin", sheets[1])
        dumpShare(base .. "_sheet1.bin", sheets[2])
        print(string.format("[texram] dump %d at frame %d, sel_course %d, %d nonzero samples", dumps, frames, course, nz))
    end
    if dumps >= MAX_DUMPS or frames >= RUN_FRAMES then manager.machine:exit() end
end)
