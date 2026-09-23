-- Capture what the motion script and the coprocessor's afterimage ring do on
-- the board, so the explorer's port of both can be graded against it.
--
-- Three things are recorded while a fight runs:
--
--   1. Every frame edge, both fighters' script-driven state out of work RAM:
--      the motion and its frame, the part mask / life step / turn the trail
--      command leaves at +0xC60/+0xC62/+0xA1E, the propeller bit and byte at
--      +0x7F0 bit 16 / +0x7F4, and the sixteen models `rob_disp` draws each slot
--      from at +0x40 (the array op 0x10 writes the chest and hands into). With
--      those, the global `zanzou_ma` and `frame_counter`.
--
--   2. Every word the i960 writes to the coprocessor, as mame-motion-capture.lua
--      records them, so the same capture feeds test-motion-mame.mjs as well.
--
--   3. For every Fn_zanzou_reserve (0x40008080) — the one command whose
--      length is not fixed — the words the i960 sent, and the SHARC's own data
--      memory at the moment the firmware had finished the header and not yet
--      laid anything: its first store to the part-model table (DM 0x321A0 for
--      P1, 0x32200 for P2). Consecutive snapshots chain: the explorer is started
--      from one, told what the i960 told the firmware, aged by the frames in
--      between, and held against the next.
--
--      The moment has to come from the SHARC's side. MAME stalls a reader on
--      an empty FIFO by returning 0 and running the read again, so a tap on
--      either end of the FIFO fires on attempts the other processor has not
--      caught up with, and cannot tell those from a real zero word.
--
-- A fight does not lay trails of its own often enough to grade the ring, and
-- the obvious ways of making the fighter play a trail motion do not survive a
-- coined fight: a motion started under another's number stays on its first
-- frame. So, as m2-hle2 did it, the capture writes the trail fields itself —
-- P1's mask, step and turn at +0xC60/+0xC62/+0xA1E and the global `zanzou_ma` —
-- at every frame edge from a list of cases, M.period frames each. What
-- `zanzou_control` then sends, and what the firmware lays, are the board's own;
-- only the trigger is ours. Each frame and reserve records the case in force,
-- and the script grade leaves the trail fields alone on those frames.
--
-- The script is graded on whatever motions the fighters play. Neither way of
-- choosing them held: answering the fighter's action table with a motion id
-- restarts that motion every frame in a coined fight, and in attract the replay
-- starts its own motion over it within a frame or two. So which script
-- commands get graded is up to the fight.

local M = {}
_G.ZCAP = M

M.mash   = true
M.raw    = false    -- also keep every FIFO word (for test-motion-mame.mjs)
M.want   = 600
M.limit  = 12000000
M.char   = nil      -- pin P1 to this character index from the first frame
M.cases  = nil      -- { {mask, step, turn, spacing}, ... } written into P1
M.period = 120      -- frames each case is held for
M.cur    = 0        -- the case in force (1-based; 0 none)
M.state  = "idle"
M.n      = 0
M.words  = {}
M.offs   = {}
M.marks  = {}
M.frames = {}
M.reserves = {}
M.fc     = 0
M.err    = nil

local P = { 0x510D00, 0x514100 }       -- P1_PARTS, P2_PARTS
local CHAR_PARTS = 0x000C5268
local FIFO_LO, FIFO_HI = 0x00884000, 0x00887fff
local SUB_MODE = 0x500030        -- 9 is FIGHT_DSP
local MOD_FA_TOBI = 0x5008A4     -- the projectile module, zanzou_control's owner
local DEBUG_FLAG = 0x508000      -- bit 5 skips zanzou_control
local FRAME_COUNTER = 0x500020
local ZANZOU_MA = 0x50A418

local sp, scr, dm
local function space()
    if not sp then sp = manager.machine.devices[":maincpu"].spaces["program"] end
    return sp
end
local function screen()
    if not scr then scr = manager.machine.screens[":screen"] end
    return scr
end
local function dmspace()
    if not dm then dm = manager.machine.devices[":copro_adsp"].spaces["data"] end
    return dm
end
local function frameno() return screen():frame_number() end

local function press(port, name, on)
    local p = manager.machine.ioport.ports[port]
    if not p then return end
    local f = p.fields[name]
    if f then f:set_value(on and 1 or 0) end
end

-- The SHARC DM word at a firmware address. Checked on load against what
-- `send_zanzou_data` writes at boot: 3 at 0x32182, 0.1f at 0x32181.
function M.dmw(a) return dmspace():read_u32(a) end
function M.dmcheck()
    return string.format("0x32181=%08x 0x32182=%08x", M.dmw(0x32181), M.dmw(0x32182))
end

local function dmrange(lo, hi)
    local d = dmspace()
    local out = {}
    for a = lo, hi do out[#out + 1] = string.format("%x", d:read_u32(a)) end
    return table.concat(out, " ")
end

-- The DM the ring lives in (cpres1 PM 0x208E1..0x20A8E, as m2-hle2's
-- sharc_zanzou.h maps it): the unit cache the parts are drawn with, last
-- frame's copy of it, the ring's bookkeeping and the ring itself.
local function snapshot()
    return {
        units = dmrange(0x30420, 0x3059F),   -- this frame, P1 then P2
        low   = dmrange(0x32000, 0x3224F),   -- last frame's, write index, spacing, timers, attr, masks
        ring  = dmrange(0x32300, 0x332FF),   -- 128 slots of 0x20 words
    }
end

-- ---- the reserve stream ----------------------------------------------------

-- The i960 sends the reserve through the same FIFO as every other command,
-- and this does not track where commands start: that would take the argument
-- count of all 136 opcodes, and one unknown command would lose it for good. So
-- 0x40008080 is only a candidate — as a float it is 2.00785, which can turn up
-- inside a matrix or a position. A candidate is believed only once its header
-- and first part record have the shape zanzou_control gives them, and only then
-- is it queued for the SHARC. That is still in time: the firmware cannot store
-- a part's models before the i960 has sent that part's record.
local R = nil          -- the candidate being followed, or nil
local pending = {}     -- believed reserves, waiting for the SHARC to reach them
M.falseStarts = 0

local function u16ish(w) return w < 0x10000 or w >= 0xFFFF0000 end

-- Is header word k plausible? player, mask, step, bone length. Checked as each
-- word arrives, so a false start ends on the first word that gives it away —
-- which, if that word is the real command, is where the real reserve begins.
local function header_word_ok(k, w)
    if k == 1 then return w == 0 or w == 1 end
    if k == 2 then return w ~= 0 and w <= 0xFFFF end
    if k == 3 then return u16ish(w) end
    local bone = string.unpack("<f", string.pack("<I4", w))
    return bone == bone and bone > 0 and bone < 16
end

local function drop(r)
    for i, q in ipairs(pending) do
        if q == r then table.remove(pending, i); break end
    end
end

local function start(w)
    R = { phase = "header", header = {}, parts = {}, frame = frameno(),
          fc = space():read_u32(FRAME_COUNTER) }
end

local function reject(w)
    M.falseStarts = M.falseStarts + 1
    if R.queued then drop(R) end
    R = nil
    if w == 0x40008080 then start(w) end
end

local function reserve_word(w)
    if not R then
        if w == 0x40008080 then start(w) end
        return
    end
    if R.phase == "header" then
        if not header_word_ok(#R.header + 1, w) then return reject(w) end
        R.header[#R.header + 1] = w
        if #R.header == 4 then R.phase = "index" end
    elseif R.phase == "index" then
        if w == 0xFFFFFFFF then
            if #R.parts == 0 then return reject(w) end
            R.phase = "tail"
        elseif w < 16 and (R.header[2] >> w) & 1 == 1 then
            R.cur = { w }; R.parts[#R.parts + 1] = R.cur; R.phase = "body"
        else
            return reject(w)
        end
    elseif R.phase == "body" then
        if w > 0xFFFF then return reject(w) end
        R.cur[#R.cur + 1] = w
        if #R.cur == 4 then
            R.phase = "index"
            if not R.queued then R.queued = true; pending[#pending + 1] = R end
        end
    elseif R.phase == "tail" then
        if not u16ish(w) then return reject(w) end
        R.angle = w
        R.phase = "done"
        local s = space()
        local b = P[(R.header[1] == 1) and 2 or 1]
        R.state = { s:read_u16(b + 0x1A8), s:read_u16(b + 0x1AA), s:read_u8(b + 0x1B0),
                    s:read_u32(b), (R.header[1] == 1) and 0 or M.cur, s:read_u32(ZANZOU_MA),
                    s:read_u8(b + 0x84C) }
        M.reserves[#M.reserves + 1] = R
        R = nil
    end
end

-- The parser against crafted streams, run by mame-zanzou.py before every
-- capture: a real reserve, a data word that looks like one, and the ways a
-- false start can end. Returns "ok" or what went wrong.
function M.selftest()
    local saved = { M.reserves, M.falseStarts }
    local out = {}
    local function run(name, words, wantReserves, wantFalse, wantPending)
        M.reserves, M.falseStarts, pending, R = {}, 0, {}, nil
        for _, w in ipairs(words) do reserve_word(w) end
        local got = string.format("%d/%d/%d", #M.reserves, M.falseStarts, #pending)
        local want = string.format("%d/%d/%d", wantReserves, wantFalse, wantPending)
        if got ~= want then
            out[#out + 1] = string.format("%s: reserves/false/pending %s, wanted %s", name, got, want)
        end
    end
    local RES, END, HALF = 0x40008080, 0xFFFFFFFF, 0x3F000000
    local real = { RES, 0, 0x120, 0xFFFFFFFE, HALF, 8, 2220, 2221, 2222, 5, 2220, 2221, 2222, END, 0 }
    local function with(prefix)
        local t = {}
        for _, w in ipairs(prefix) do t[#t + 1] = w end
        for _, w in ipairs(real) do t[#t + 1] = w end
        return t
    end
    -- The whole of a real reserve, left queued for the SHARC.
    run("real", real, 1, 0, 1)
    -- 2.00785 inside some matrix, then ordinary words: set aside at once.
    run("stray float", { RES, 0x3F800000, 0, 0 }, 0, 1, 0)
    -- A stray one straight before a real one: the real one is still found.
    run("stray then real", with({ RES, 0x41200000 }), 1, 1, 1)
    -- The stray one's first "header" word is the real command.
    run("stray eats real", with({ RES }), 1, 1, 1)
    -- A plausible header with an impossible bone length.
    run("bad bone", { RES, 1, 0x20, 0xFFFFFFFA, 0x7F800000, 5 }, 0, 1, 0)
    -- A part the mask does not name.
    run("part off mask", { RES, 0, 0x20, 0xFFFFFFFA, HALF, 8, 2220 }, 0, 1, 0)
    -- Queued after its first part, then broken: taken back out of the queue.
    run("broken after queue", { RES, 0, 0x120, 0xFFFFFFFE, HALF, 8, 2220, 2221, 2222, 0x1234 }, 0, 1, 0)
    -- A terminator before any part.
    run("empty", { RES, 0, 0x20, 0xFFFFFFFA, HALF, END, 0 }, 0, 1, 0)
    M.reserves, M.falseStarts, pending, R = saved[1], saved[2], {}, nil
    return #out == 0 and "ok" or table.concat(out, "; ")
end

-- The SHARC's first store into a part-model table for the oldest reserve it
-- has not reached yet: the header is done and nothing has been laid. A tap runs
-- before the store lands, so the snapshot is exactly the state before it.
local function on_attr_store()
    local r = table.remove(pending, 1)
    if r then r.pre = snapshot() end
end

-- ---- the trail cases ------------------------------------------------------

function M.cases_on()
    if not M.cases or #M.cases == 0 then return "off" end
    M.caseStart = M.fc
    M.cur = 1
    local out = {}
    for _, c in ipairs(M.cases) do
        out[#out + 1] = string.format("%x/%d/%x/%g", c[1], c[2], c[3], c[4])
    end
    return table.concat(out, " ") .. string.format(", %d frames each", M.period)
end

local function write_case()
    if M.cur == 0 then return end
    local n = #M.cases
    M.cur = ((M.fc - M.caseStart) // M.period) % n + 1
    local c = M.cases[M.cur]
    local s = space()
    s:write_u16(P[1] + 0xC60, c[1])
    s:write_u16(P[1] + 0xC62, c[2] & 0xFFFF)
    s:write_u16(P[1] + 0xA1E, c[3])
    s:write_u32(ZANZOU_MA, string.unpack("<I4", string.pack("<f", c[4])))
end

-- ---- per-frame state -------------------------------------------------------

local function player(b)
    local s = space()
    local models = {}
    for i = 0, 15 do models[#models + 1] = s:read_u32(b + 0x40 + i * 4) end
    return {
        s:read_u16(b + 0x1A8),       -- 1  motion
        s:read_u16(b + 0x1AA),       -- 2  frame ("coma")
        s:read_u8(b + 0x1B0),        -- 3  character
        s:read_u8(b + 0x84C),        -- 4  skeleton type
        s:read_u32(b + 0x0),         -- 5  flags (bit 6 facing, bit 27 option)
        s:read_u32(b + 0x7F0),       -- 6  parts flag (bit 16 propeller)
        s:read_u8(b + 0x7F4),        -- 7  propeller byte
        s:read_u16(b + 0xC60),       -- 8  trail mask
        s:read_u16(b + 0xC62),       -- 9  life step (s16)
        s:read_u16(b + 0xA1E),       -- 10 turn
        s:read_u32(b + 0x7EC),       -- 11 the word zanzou_control xors with +0
        models,                      -- 12 the sixteen slot models
    }
end

-- zanzou_control runs as the projectile module's per-frame routine, so there is
-- no trail to see until that module is up: bit 31 of its header word. Attract
-- has a fight on screen without it.
function M.tobi()
    local s = space()
    local m = s:read_u32(MOD_FA_TOBI)
    if m == 0 then return 0 end
    return (s:read_u32(m) >> 31) & 1
end

function M.status()
    local s = space()
    return string.format("%d %d %d %d %d %d %d", s:read_u16(P[1] + 0x1A8), s:read_u16(P[1] + 0x1AA),
        s:read_u8(P[1] + 0x1B0), s:read_u8(P[1] + 0x84C), s:read_u8(SUB_MODE), M.tobi(),
        s:read_u32(DEBUG_FLAG))
end

M.seen = 0
function M.rate() local n = M.seen; M.seen = 0; return n end

function M.tick()
    M.fc = M.fc + 1
    if M.mash and M.fc > 300 then
        press(":IN0", "Coin 1", (M.fc % 600) < 8)
        local m = M.fc % 120
        press(":IN0", "1 Player Start", m < 6)
        press(":IN1", "P1 Left",   m >= 10 and m < 22)
        press(":IN1", "P1 Right",  m >= 26 and m < 38)
        press(":IN1", "P1 Punch",  m >= 62 and m < 70)
        press(":IN1", "P1 Kick",   m >= 76 and m < 84)
    end
    write_case()
    if M.state == "capturing" then
        local s = space()
        M.marks[#M.marks + 1] = { frameno(), M.n,
            s:read_u16(P[1] + 0x1A8), s:read_u16(P[1] + 0x1AA), s:read_u8(P[1] + 0x1B0),
            s:read_u32(FRAME_COUNTER), s:read_u8(P[1] + 0x84C) }
        M.frames[#M.frames + 1] = { frameno(), s:read_u32(FRAME_COUNTER),
            s:read_u32(ZANZOU_MA), player(P[1]), player(P[2]), M.cur }
        if #M.marks > M.want + 1 or M.n >= M.limit then M.stop() end
    end
end

local function safetick()
    local ok, e = pcall(M.tick)
    if not ok then M.err = tostring(e); M.state = "error" end
end

-- The character pin, as mame-motion-capture.lua does it: character_select
-- writes the index and action_init reads it back in the same frame, so a write
-- tap is what wins the race.
function M.pin_tap()
    if M.ptap then return "already" end
    M.ptap = space():install_write_tap(P[1] + 0x1B0, P[1] + 0x1B3, "zcharpin",
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
    M.wtap = space():install_write_tap(FIFO_LO, FIFO_HI, "zfifo_w",
        function(offset, data, mask)
            M.seen = M.seen + 1
            if M.state == "capturing" then
                if M.raw then
                    local n = M.n + 1
                    M.n = n
                    M.words[n] = data
                    M.offs[n] = offset
                end
                reserve_word(data)
            end
        end)
    -- One store starts each reserve's records; the rest of that reserve's
    -- stores find nothing pending until the i960 has sent the next one.
    local function attr(offset, data, mask)
        if M.state ~= "capturing" or #pending == 0 then return end
        local r = pending[1]
        local base = (r.header[1] == 1) and 0x32200 or 0x321A0
        if offset < base or offset > base + 0x2F then return end
        on_attr_store()
    end
    M.atap1 = dmspace():install_write_tap(0x321A0, 0x321CF, "zattr1", attr)
    M.atap2 = dmspace():install_write_tap(0x32200, 0x3222F, "zattr2", attr)
    M.sub = emu.add_machine_frame_notifier(safetick)
    M.state = "running"
    return "ok"
end

function M.start()
    M.n, M.words, M.offs, M.marks, M.frames, M.reserves = 0, {}, {}, {}, {}, {}
    R = nil
    pending = {}
    M.falseStarts = 0
    M.state = "capturing"
    return "ok"
end

function M.stop()
    if M.state == "capturing" then M.state = "captured" end
    return "ok"
end

local function jlist(t)
    local out = {}
    for _, v in ipairs(t) do
        if type(v) == "table" then out[#out + 1] = jlist(v)
        elseif type(v) == "string" then out[#out + 1] = '"' .. v .. '"'
        else out[#out + 1] = tostring(v) end
    end
    return "[" .. table.concat(out, ",") .. "]"
end

local function jreserve(r)
    local parts = {}
    for _, p in ipairs(r.parts) do parts[#parts + 1] = jlist(p) end
    local function snap(sn)
        if not sn then return "null" end
        return string.format('{"units":"%s","low":"%s","ring":"%s"}', sn.units, sn.low, sn.ring)
    end
    return string.format(
        '{"frame":%d,"fc":%d,"state":%s,"header":%s,"parts":[%s],"angle":%s,"pre":%s}',
        r.frame, r.fc, jlist(r.state or {}), jlist(r.header), table.concat(parts, ","),
        r.angle and tostring(r.angle) or "null", snap(r.pre))
end

function M.write(path)
    -- The raw stream and marks, in mame-motion-capture.lua's format.
    if M.raw then
    local f = assert(io.open(path .. ".bin", "wb"))
    local chunk = {}
    for i = 1, M.n do
        chunk[#chunk + 1] = string.pack("<I4I4", M.offs[i], M.words[i])
        if #chunk == 8192 then f:write(table.concat(chunk)); chunk = {} end
    end
    if #chunk > 0 then f:write(table.concat(chunk)) end
    f:close()
    local m = assert(io.open(path .. ".json", "w"))
    m:write('{"words":', M.n, ',"probes":["motion","coma","char","frame_counter","skeleton_type"],"marks":')
    m:write(jlist(M.marks))
    m:write("}")
    m:close()
    end

    -- The script state and the reserve oracles.
    local z = assert(io.open(path .. ".zanzou.json", "w"))
    local cases = {}
    for _, c in ipairs(M.cases or {}) do
        cases[#cases + 1] = string.format("[%d,%d,%d,%.9g]", c[1], c[2], c[3], c[4])
    end
    z:write('{"char":', tostring(M.char or -1), ',"cases":[', table.concat(cases, ","), ']',
        ',"player_fields":["motion","coma","char","skeleton_type","flags","parts_flag",',
        '"propeller","trail_mask","trail_step","trail_turn","word_7ec","models"]',
        ',"false_starts":', tostring(M.falseStarts),
        ',"frames":', jlist(M.frames), ',"reserves":[')
    for i, r in ipairs(M.reserves) do
        if i > 1 then z:write(",") end
        z:write(jreserve(r))
    end
    z:write("]}")
    z:close()
    return string.format("ok %d words, %d frames, %d reserves, %d false starts",
        M.n, #M.frames, #M.reserves, M.falseStarts)
end

return "zcap loaded"
