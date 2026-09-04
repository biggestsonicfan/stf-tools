-- Record Canyon Cruise's own flight, frame by frame, off the board.
--
-- The viewer computes the boat's position by porting object_move's curve out of
-- the ROM; this reads what the game actually writes, so the port can be held
-- against it rather than against an argument. Everything sampled is a word the
-- draw functions read: stage_xpos/ypos/zpos and the three angles are what every
-- world-space draw's prologue is built from, and the object's own counter at
-- +6 is the timeline the whole stage runs off.
--
-- Loaded into a running MAME through claude_mame's bridge, and driven by eval
-- calls on the PATH table. The pin and the mash are mame-dl-capture.lua's, for
-- the same reasons set out there: a write tap on stage_num is the only thing
-- that wins the race against change_scene.

local M = {}
_G.PATH = M

M.stage  = 4
M.mash   = true
M.pin    = true
M.want   = 2600           -- frames to record
M.state  = "idle"
M.fc     = 0
M.rows   = {}
M.err    = nil

local sp, scr
local function space()
    if not sp then sp = manager.machine.devices[":maincpu"].spaces["program"] end
    return sp
end
local function screen()
    if not scr then scr = manager.machine.screens[":screen"] end
    return scr
end

local function press(port, name, on)
    local p = manager.machine.ioport.ports[port]
    if not p then return end
    local f = p.fields[name]
    if f then f:set_value(on and 1 or 0) end
end

M.seen = 0
function M.watch()
    if M.wtap then return "already" end
    M.wtap = space():install_write_tap(0x00880000, 0x00887fff, "dlwatch",
        function() M.seen = M.seen + 1 end)
    return "ok"
end
function M.rate() local n = M.seen; M.seen = 0; return n end
function M.unwatch() if M.wtap then M.wtap:remove(); M.wtap = nil end return "ok" end

function M.stage_num() return space():read_u8(0x500064) end

-- The boat's timeline counter, so the driver can wait for the ride to start
-- rather than spending the recording on the frames before it.
function M.count() return space():read_u16(0x543106) end

-- The live material table set_material uploads: 32 packed words at
-- material_num_floats. What the geometry engine is actually lighting with,
-- rather than what the stage record holds.
function M.materials()
    local s, out = space(), {}
    for i = 0, 31 do out[#out + 1] = string.format("%08X", s:read_u32(0x530080 + i * 4)) end
    return table.concat(out, ",")
end

-- Which machine actually booted. MAME drops to its own menu when a set fails to
-- verify, and everything below would then be reading somebody else's RAM.
function M.system() return manager.machine.system.name end

-- One frame of the stage's own state. Floats are kept as their bits and
-- converted by the reader; Lua would only round them on the way out.
local function sample()
    local s = space()
    return {
        screen():frame_number(),
        s:read_u32(0x500020),          -- frame_counter
        s:read_u16(0x543106),          -- the boat object's counter, +6
        s:read_u8(0x543148),           -- its segment count, +0x48
        s:read_u32(0x50A014),          -- stage_xpos
        s:read_u32(0x50A018),          -- stage_ypos
        s:read_u32(0x50A01C),          -- stage_zpos
        s:read_u16(0x50A020),          -- ang_x
        s:read_u16(0x50A022),          -- ang_y, the heading
        s:read_u16(0x50A024),          -- ang_z, the roll
        s:read_u16(0x5004AA),          -- canyon_env_disp's trigger index
        s:read_u16(0x5004AC),          -- its cursor into canyon_env_objects
        s:read_u16(0x5004AE),          -- the cursor it rewinds to
        s:read_u16(0x530200),          -- the material scale the tunnel walks
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
    if M.state == "recording" then
        M.rows[#M.rows + 1] = sample()
        if #M.rows >= M.want then M.state = "done" end
    end
end

local function safetick()
    local ok, e = pcall(M.tick)
    if not ok then M.err = tostring(e); M.state = "error" end
end

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

function M.start() M.rows = {}; M.state = "recording"; return "ok" end
function M.stop() M.state = "stopped"; return #M.rows end

function M.write(path)
    local f = io.open(path, "wb")
    f:write("screen,frame_counter,count,segs,xbits,ybits,zbits,angx,angy,angz,trig,cursor,mark,scale\n")
    for _, r in ipairs(M.rows) do
        f:write(table.concat(r, ",") .. "\n")
    end
    f:close()
    return #M.rows .. " rows -> " .. path
end

return "PATH loaded"
