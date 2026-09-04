-- Capture what the board actually poses a fighter with, frame by frame.
--
-- The viewer decodes a motion out of the ROM and solves it into sixteen bone
-- matrices. This records the other side of that: the arguments the i960 hands
-- the geometry coprocessor while a real fight is on screen, together with the
-- motion number and motion frame the game was on when it sent them. The two can
-- then be compared directly — the same motion at the same frame has to produce
-- the same body position, the same joint angles, the same IK targets.
--
-- Two ops carry the pose (their argument order is `calc_rob_angle_cont` at
-- 0x2FF2C, and the sim's header documents the microcode side):
--
--   0x31006262  set_body   position, body euler, world angles
--   0x35806B6B  ik_2bone   pivot, base angles, world adjust, target,
--                          the two bone lengths, two TGP slots, flip
--
-- Command words are self-identifying — opcode n is encoded (n<<23)|(n<<8)|n —
-- so the stream segments without a table of argument counts, and this captures
-- raw words and leaves the decode to the reader, as mame-dl-capture.lua does.
--
-- The per-frame marks also carry the motion state read straight out of work
-- RAM, so the capture ties itself to the game's own clock:
--   0x510EA8  p1_motion_num    the motion id play_motion is running
--   0x510EAA  p1_motion_coma   its frame, which starts at 1
--   0x510EB0  p1 char index    which fighter's skeleton is posing it
-- P1's structure base is 0x510D00 (p1_motion_num is g7+0x1A8).

local M = {}
_G.MCAP = M

M.mash   = true
M.want   = 90          -- frames of display list to keep
M.limit  = 6000000
M.char   = nil         -- pin P1 to this character index; nil leaves the game's
M.reload = false       -- force calc_rob_angle_int to re-resolve the rig
M.state  = "idle"
M.n      = 0
M.words  = {}
M.offs   = {}
M.marks  = {}
M.fc     = 0
M.tap    = nil
M.sub    = nil
M.err    = nil

local P1 = 0x510D00

local sp, scr
local function space()
    if not sp then sp = manager.machine.devices[":maincpu"].spaces["program"] end
    return sp
end
local function screen()
    if not scr then scr = manager.machine.screens[":screen"] end
    return scr
end
local function frameno() return screen():frame_number() end

local function press(port, name, on)
    local p = manager.machine.ioport.ports[port]
    if not p then return end
    local f = p.fields[name]
    if f then f:set_value(on and 1 or 0) end
end

M.seen = 0
function M.watch()
    if M.wtap then return "already" end
    M.wtap = space():install_write_tap(0x00880000, 0x00887fff, "mdlwatch",
        function() M.seen = M.seen + 1 end)
    return "ok"
end
function M.rate() local n = M.seen; M.seen = 0; return n end
function M.unwatch()
    if M.wtap then M.wtap:remove(); M.wtap = nil end
    return "ok"
end

-- Is a fighter actually posing? A motion number of zero means play_motion has
-- nothing to run, which is what the front end looks like.
function M.motion() return space():read_u16(P1 + 0x1A8) end
function M.coma()   return space():read_u16(P1 + 0x1AA) end
function M.charno() return space():read_u8(P1 + 0x1B0) end

-- The rig the board is actually posing with, read straight out of P1's state
-- rather than inferred from the command stream.
--
-- calc_rob_angle_cont resolves SKELETON_TYPE_DATA[type][char] and then, at
-- 0x2FFBC, overrides it: `ld 0x860(g7),r15; bbc 12,r15,<skip>; lda 0x8c(g7),g6`
-- -- with bit 12 of P1+0x860 set the skeleton is P1+0x8C, a copy in work RAM,
-- and the table is not consulted at all. So this is the authority on which rig
-- a fighter has, and the 15 triples are the same layout as the ROM tables.
local function f32(w) return (string.unpack("<f", string.pack("<I4", w))) end
function M.rig()
    local s = space()
    local out = { string.format("char=%d type=%d last=%d flags=%08x ram_skel=%s",
        s:read_u8(P1 + 0x1B0), s:read_u8(P1 + 0x84C), s:read_u8(P1 + 0x85B),
        s:read_u32(P1 + 0x860),
        (s:read_u32(P1 + 0x860) & 0x1000) ~= 0 and "yes" or "no") }
    for i = 0, 14 do
        local b = P1 + 0x8C + i * 12
        out[#out + 1] = string.format("%d %.7f %.7f %.7f", i,
            f32(s:read_u32(b)), f32(s:read_u32(b + 4)), f32(s:read_u32(b + 8)))
    end
    return table.concat(out, "|")
end

function M.type()   return space():read_u8(P1 + 0x84C) end

-- The skeleton type says which state the machine is in, and it matters for a
-- pin: in attract the type is 0, and SKELETON_TYPE_DATA's type-0 table hands
-- every character Sonic's skeleton, so a character pinned there poses on
-- Sonic's bones whoever it names. A real fight runs at type 1, whose table is
-- per-character -- and calc_rob_angle_cont re-reads the index every frame at
-- 0x2FFB4, so a pin applied there switches the rig as well as the meshes.
-- The rig as matrices, read out of the coprocessor rather than inferred.
--
-- `calc_rob_angle_cont` builds each part and then hands it to the geometry
-- coprocessor with op 0x67, whose one argument is a TGP matrix slot: 0x3A00 for
-- P1 and 0x3B00 for P2, stepping 0x0C a slot -- twelve words, a 3x4. The slots
-- run in the sixteen-part order, so slot n is at base + n * 0x0C, and the head
-- is 0x3A18. Reading them back is the only way to check the parts the command
-- stream does not spell out: the limbs arrive as ik_2bone arguments and can be
-- compared from those, but the chest and head are built inside the coprocessor
-- and only exist as the matrix it ends up holding.
local cop
local function codata()
    if not cop then cop = manager.machine.devices[":copro_adsp"].spaces["data"] end
    return cop
end

M.TGP_P1 = 0x3A00
M.TGP_P2 = 0x3B00
M.TGP_STRIDE = 0x0C

-- One slot as twelve floats, in the order the coprocessor holds them.
function M.mat(slot)
    local s = codata()
    local out = {}
    for i = 0, 11 do
        local w = s:read_u32(slot + i)
        out[#out + 1] = string.format("%.7g", (string.unpack("<f", string.pack("<I4", w))))
    end
    return table.concat(out, ",")
end

-- All sixteen of a player's slots, semicolon separated.
function M.mats(base)
    local out = {}
    for n = 0, 15 do out[#out + 1] = M.mat(base + n * M.TGP_STRIDE) end
    return table.concat(out, ";")
end

-- Scan a device's data space for anything shaped like a rig matrix: twelve
-- consecutive words whose first nine make three unit-length columns. The TGP
-- slot ids `calc_rob_angle_cont` quotes (0x3A00 for P1) are the coprocessor's
-- own, and which of its two address spaces they land in is not obvious from the
-- command stream, so this finds them rather than assuming.
function M.scan(dev, lo, hi)
    local sp = manager.machine.devices[dev].spaces["data"]
    local hits = {}
    for a = lo, hi do
        local v = {}
        local ok = true
        for i = 0, 8 do
            local w = sp:read_u32(a + i)
            local f = (string.unpack("<f", string.pack("<I4", w)))
            if f ~= f or math.abs(f) > 1e6 then ok = false break end
            v[#v + 1] = f
        end
        if ok then
            local good = true
            for c = 0, 2 do
                local l = math.sqrt(v[c+1]^2 + v[c+4]^2 + v[c+7]^2)
                if math.abs(l - 1.0) > 0.02 then good = false break end
            end
            if good then
                hits[#hits + 1] = string.format("0x%X", a)
                if #hits >= 24 then break end
            end
        end
    end
    return table.concat(hits, " ")
end

function M.status()
    return string.format("%d %d %d %d", M.motion(), M.coma(), M.charno(), M.type())
end

-- Recorded at every frame edge so each slice of display list is tied to the
-- motion and frame that produced it.
local function probes()
    local s = space()
    return {
        s:read_u16(P1 + 0x1A8),        -- motion number
        s:read_u16(P1 + 0x1AA),        -- motion frame ("coma")
        s:read_u8(P1 + 0x1B0),         -- character index
        s:read_u32(0x500020),          -- frame_counter
        s:read_u8(P1 + 0x84C),         -- skeleton type
    }
end

function M.tick()
    M.fc = M.fc + 1
    -- Walk the front end into a fight. Coin and start get it out of attract;
    -- the punch and kick keep a round alive so motions keep being played.
    if M.mash and M.fc > 300 then
        press(":IN0", "Coin 1", (M.fc % 600) < 8)
        local m = M.fc % 120
        press(":IN0", "1 Player Start", m < 6)
        -- Walk, guard, punch and kick on different phases. A fighter that only
        -- ever gets punch plays two or three motions; moving it about and
        -- letting it be hit is what turns up the rest.
        press(":IN1", "P1 Left",   m >= 10 and m < 22)
        press(":IN1", "P1 Right",  m >= 26 and m < 38)
        press(":IN1", "P1 Up",     m >= 42 and m < 48)
        press(":IN1", "P1 Down",   m >= 52 and m < 58)
        press(":IN1", "P1 Punch",  m >= 62 and m < 70)
        press(":IN1", "P1 Kick",   m >= 76 and m < 84)
        press(":IN1", "P1 Escape", m >= 90 and m < 96)
        press(":IN1", "P1 Guard",  m >= 102 and m < 114)
    end
    if M.char and M.fc > 300 then space():write_u8(P1 + 0x1B0, M.char) end
    -- Pinning the index alone switches the meshes and not the rig: rob_disp
    -- reads the character every frame, but the skeleton is resolved once and
    -- kept. calc_rob_angle_int (0x2EF38) opens `ldob 0x84c(g7),r8; ldob
    -- 0x85b(g7),r9; cmpobe r8,r9,<end>` -- it re-resolves only when the live
    -- skeleton type differs from the one last loaded for. Spoiling the second
    -- byte makes that compare fail, so the routine runs again and picks the rig
    -- up from the pinned character.
    if M.reload and M.fc > 300 then space():write_u8(P1 + 0x85B, 0xFF) end
    if M.state == "capturing" then
        M.marks[#M.marks + 1] = { frameno(), M.n, table.unpack(probes()) }
        if #M.marks > M.want + 1 or M.n >= M.limit then M.stop() end
    end
end

local function safetick()
    local ok, e = pcall(M.tick)
    if not ok then M.err = tostring(e); M.state = "error" end
end

-- Hold P1's character index against the game itself.
--
-- The roster's last entries -- the Final Eggman Boss and the three robots -- are
-- not on the select screen, so the only way to see one posed by the board is to
-- substitute the index the front end chose. Same reason as the stage pin in
-- mame-dl-capture.lua: character_select writes the index and action_init reads
-- it back inside the same frame, so a once-a-frame poke loses the race. A write
-- tap sees the store as it happens, and `calc_rob_angle_cont` re-reads the byte
-- every frame (0x2FFB4), so the skeleton follows the pin without a reload.
--
-- P1+0x1B0 is byte 0x510EB0, lane 0 of an aligned word, hence the arithmetic on
-- the low byte.
function M.pin_tap()
    if M.ptap then return "already" end
    M.ptap = space():install_write_tap(P1 + 0x1B0, P1 + 0x1B3, "charpin",
        function(offset, data, mask)
            if not M.char then return end
            if mask % 256 == 0 then return end
            return data - (data % 256) + M.char
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

function M.start()
    if M.tap then return "already" end
    M.n, M.words, M.offs, M.marks = 0, {}, {}, {}
    local words, offs = M.words, M.offs
    M.tap = space():install_write_tap(0x00800000, 0x008cffff, "mdlcap",
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

    local m = assert(io.open(path .. ".json", "w"))
    m:write('{"words":', M.n, ',"probes":["motion","coma","char","frame_counter","skeleton_type"],"marks":[')
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

return "mcap loaded"
