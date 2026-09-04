-- Capture the i960 -> coprocessor command stream for one stage, frame by frame.
--
-- Loaded into a running MAME through claude_mame's bridge (`dofile`), then
-- driven by eval calls on the CAP table. It does three things the bridge cannot
-- do from outside: it pins stage_num and mashes the front end every frame so the
-- game walks itself into a chosen arena, it taps every write to the copro FIFO
-- so no command word is missed, and it writes the capture out from inside Lua —
-- a frame of display list is tens of thousands of words, and round-tripping
-- those over the bridge one at a time is not on.
--
-- The command words are self-identifying: the i960 encodes an opcode n as
-- (n<<23)|(n<<8)|n, so a word is a command iff it matches that pattern for its
-- own low byte. That is what makes the stream parseable without knowing every
-- opcode's argument count, and it is why this captures raw words and leaves the
-- decode to the reader.

local M = {}
_G.CAP = M

M.stage      = 1
M.mash       = true       -- walk the front end
M.pin        = true       -- hold stage_num, even once the mash is off
M.want       = 4          -- frames of display list to keep
M.limit      = 4000000    -- hard cap on captured words
M.state      = "idle"
M.n          = 0
M.words      = {}
M.offs       = {}
M.marks      = {}         -- {screen frame, word index, probes...} at each frame edge
M.fc         = 0
M.tap        = nil
M.sub        = nil
M.err        = nil

local sp, scr

local function space()
    if not sp then sp = manager.machine.devices[":maincpu"].spaces["program"] end
    return sp
end
local function screen()
    if not scr then scr = manager.machine.screens[":screen"] end
    return scr
end

-- frame_number is bound as a method here, not a property.
local function frameno() return screen():frame_number() end

local function press(port, name, on)
    local p = manager.machine.ioport.ports[port]
    if not p then return end
    local f = p.fields[name]
    if f then f:set_value(on and 1 or 0) end
end

-- Copro traffic since the last call. Texture RAM fills long before a round
-- starts and stays filled after it ends, so the signal that the game is
-- actually drawing a scene is that it is talking to the coprocessor at all.
M.seen = 0
function M.watch()
    if M.wtap then return "already" end
    M.wtap = space():install_write_tap(0x00880000, 0x00887fff, "dlwatch",
        function() M.seen = M.seen + 1 end)
    return "ok"
end

function M.rate()
    local n = M.seen
    M.seen = 0
    return n
end

function M.unwatch()
    if M.wtap then M.wtap:remove(); M.wtap = nil end
    return "ok"
end

-- Fraction of sampled texture RAM that is non-zero.
function M.texfill()
    local s, nz = space(), 0
    for a = 0, 0xfffff, 0x800 do
        if s:read_u32(0x11000000 + a) ~= 0 then nz = nz + 1 end
        if s:read_u32(0x11200000 + a) ~= 0 then nz = nz + 1 end
    end
    return nz / 1024.0
end

function M.stage_num() return space():read_u8(0x500064) end

-- change_scene copies the 64-word stage record it chose to 0x504800. Comparing
-- that copy against the record still sitting in the program ROM is the only
-- check that the scene the game loaded is the slot we asked for: pinning
-- stage_num sets what the draw functions branch on, but the scene itself was
-- chosen when change_scene last ran, which may have been before the pin.
local STAGE_DATA = 0x0008f3d0
function M.record_match()
    local s = space()
    local rom = STAGE_DATA + M.stage * 256
    local miss, partsmiss = 0, 0
    for i = 0, 63 do
        if s:read_u32(0x504800 + i * 4) ~= s:read_u32(rom + i * 4) then
            miss = miss + 1
            if i >= 0x19 and i < 0x32 then partsmiss = partsmiss + 1 end
        end
    end
    return string.format("%d %d", miss, partsmiss)
end

-- The texture sets the loaded scene declares, against the ones this stage's
-- record names in ROM. This is the gate rather than the whole-record compare:
-- change_scene copies the record, but the game goes on writing to that copy --
-- cage_clip_m clears panels it has destroyed, and the Flying Carpet rewrites
-- VECTER_Y every frame -- so a scene that is genuinely the right one can differ
-- in a couple of dozen words. What it cannot differ in is which textures it
-- asked for.
function M.tex_match()
    local s = space()
    local rom = STAGE_DATA + M.stage * 256
    return string.format("%d %d %d %d",
        s:read_u16(0x504800 + 0x0c), s:read_u16(0x504800 + 0x0e),
        s:read_u16(rom + 0x0c), s:read_u16(rom + 0x0e))
end

-- Texture RAM as the board holds it, so the sets the stage actually uses can be
-- established from the hardware rather than guessed at from the record.
function M.dump_texram(path)
    local s = space()
    local function grab(name, base, size, step)
        local f = assert(io.open(path .. name, "wb"))
        local c = {}
        for a = 0, size - 1, step do
            c[#c + 1] = step == 4 and string.pack("<I4", s:read_u32(base + a))
                                   or string.pack("B", s:read_u8(base + a))
            if #c == 4096 then f:write(table.concat(c)); c = {} end
        end
        if #c > 0 then f:write(table.concat(c)) end
        f:close()
    end
    grab("_texram0.bin", 0x11000000, 0x100000, 4)
    grab("_texram1.bin", 0x11200000, 0x100000, 4)
    -- Palette RAM as well. A face's colour is taken from palram[colorbase +
    -- 0x1000], not from the table in the data ROM, and the two do not agree --
    -- so this is the only way to see what the board actually shades with.
    grab("_palram.bin", 0x01800000, 0x04000, 1)
    grab("_colorxlat.bin", 0x01810000, 0x0C000, 1)
    return "ok"
end

-- Probes recorded at every frame edge, so the capture can be tied to the game's
-- own clock afterwards without trusting a guess about where that clock lives.
local function probes()
    local s = space()
    return {
        s:read_u16(0x50A020),          -- carpet ang_x
        s:read_u16(0x50A022),          -- carpet heading
        s:read_u16(0x50A024),          -- carpet roll
        s:read_u16(0x500464),          -- backdrop yaw
        s:read_u8(0x500064),           -- stage_num
        s:read_u32(0x500020),           -- frame_counter (found by scan_delta)
    }
end

function M.tick()
    M.fc = M.fc + 1
    if M.pin and M.fc > 300 then space():write_u8(0x500064, M.stage) end
    if M.mash and M.fc > 300 then
        press(":IN0", "Coin 1", (M.fc % 600) < 8)
        local m = M.fc % 60
        press(":IN0", "1 Player Start", m < 6)
        press(":IN1", "P1 Punch", m >= 20 and m < 26)
        press(":IN1", "P1 Kick", m >= 40 and m < 46)
    end
    if M.state == "capturing" then
        M.marks[#M.marks + 1] = { frameno(), M.n, table.unpack(probes()) }
        if #M.marks > M.want + 1 or M.n >= M.limit then M.stop() end
    end
end

local function safetick()
    local ok, e = pcall(M.tick)
    if not ok then M.err = tostring(e); M.state = "error" end
end

-- Hold stage_num against the game itself.
--
-- Writing it once a frame is not enough: the front end sets stage_num and calls
-- change_scene inside the same frame, so a periodic pin loses the race and the
-- scene that loads is whichever one the attract sequence wanted. A write tap
-- sees the store as it happens and can substitute the value, so change_scene
-- never reads anything but the stage we asked for. stage_num is byte 0x500064,
-- lane 0 of an aligned word, hence the arithmetic on the low byte.
function M.pin_tap()
    if M.ptap then return "already" end
    M.ptap = space():install_write_tap(0x500064, 0x500067, "stagepin",
        function(offset, data, mask)
            if not M.pin then return end
            if mask % 256 == 0 then return end
            return data - (data % 256) + M.stage
        end)
    return "ok"
end

function M.attach()
    if M.sub then return "already" end
    M.pin_tap()
    M.sub = emu.add_machine_frame_notifier(safetick)
    M.state = "running"
    return "ok"
end

-- The tap sees every write the i960 makes to the function port and the FIFO,
-- in order, which is exactly the command stream the coprocessor sees.
function M.start()
    if M.tap then return "already" end
    M.n, M.words, M.offs, M.marks = 0, {}, {}, {}
    local words, offs = M.words, M.offs
    -- Wide enough to take in the geometry processor as well as the
    -- coprocessor: 0x800000 geo, 0x804000 geo program memory (where
    -- transmap_change puts its texture-header quads), 0x840000 geo IOP,
    -- 0x880000 copro function port, 0x884000 copro FIFO, 0x8C0000 copro IOP.
    -- The offset is recorded with every word, so the streams separate again
    -- on the way out.
    M.tap = space():install_write_tap(0x00800000, 0x008cffff, "dlcap",
        function(offset, data, mask)
            local n = M.n + 1
            M.n = n
            words[n] = data
            offs[n] = offset
        end)
    M.state = "capturing"
    return "ok"
end

function M.stop()
    if M.tap then M.tap:remove(); M.tap = nil end
    if M.state == "capturing" then M.state = "captured" end
    return "ok"
end

function M.write(path)
    local f = assert(io.open(path .. ".bin", "wb"))
    local chunk = {}
    for i = 1, M.n do
        chunk[#chunk + 1] = string.pack("<I4I4", M.offs[i], M.words[i])
        if #chunk == 8192 then f:write(table.concat(chunk)); chunk = {} end
    end
    if #chunk > 0 then f:write(table.concat(chunk)) end
    f:close()

    -- change_scene copies the stage record it chose to 0x504800; dumping it
    -- lets the reader check the loaded scene really is the slot it asked for,
    -- rather than trusting that pinning stage_num took.
    local s2 = space()
    local r = assert(io.open(path .. "_record.bin", "wb"))
    local rc = {}
    for a = 0, 0x1ff, 4 do rc[#rc + 1] = string.pack("<I4", s2:read_u32(0x504800 + a)) end
    r:write(table.concat(rc))
    r:close()

    local m = assert(io.open(path .. ".json", "w"))
    m:write('{"stage":', M.stage, ',"words":', M.n, ',"marks":[')
    for i, mk in ipairs(M.marks) do
        if i > 1 then m:write(",") end
        m:write("[")
        for j, v in ipairs(mk) do
            if j > 1 then m:write(",") end
            m:write(tostring(v))
        end
        m:write("]")
    end
    m:write("]}")
    m:close()
    return "ok " .. M.n
end

-- ---- frame_counter search -------------------------------------------------
-- Sample work RAM, run N frames, sample again, and keep the words that advanced
-- by exactly N. Repeated with a different N it pins the counter outright.
M.scan = { base = 0x500000, size = 0x40000, snap = nil, cands = nil }

function M.snap_ram()
    local s, t = space(), {}
    for a = 0, M.scan.size - 4, 4 do t[a] = s:read_u32(M.scan.base + a) end
    M.scan.snap = t
    M.scan.at = frameno()
    return "ok"
end

function M.scan_delta()
    local s = space()
    local d = frameno() - M.scan.at
    local out = {}
    local prev = M.scan.cands
    for a = 0, M.scan.size - 4, 4 do
        if prev == nil or prev[a] then
            local v = s:read_u32(M.scan.base + a)
            if (v - M.scan.snap[a]) % 0x100000000 == d then out[a] = true end
        end
    end
    M.scan.cands = out
    local n, list = 0, {}
    for a in pairs(out) do n = n + 1; if n <= 24 then list[#list + 1] = string.format("%X", M.scan.base + a) end end
    return string.format("d=%d n=%d %s", d, n, table.concat(list, " "))
end

return "CAP loaded"
