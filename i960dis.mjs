/*
 * i960dis.mjs — a small i960 KB disassembler, enough to read the game's draw
 * routines out of the program ROM.
 *
 * Formats are picked by the top byte: CTRL 0x08-0x1F, COBR 0x20-0x3F,
 * REG 0x58-0x7F, MEM 0x80-0xCF. Only the operand forms the game actually uses
 * are spelled out; anything else prints as its raw word.
 */

const CTRL = {
    0x08: 'b', 0x09: 'call', 0x0a: 'ret', 0x0b: 'bal',
    0x10: 'bno', 0x11: 'bg', 0x12: 'be', 0x13: 'bge',
    0x14: 'bl', 0x15: 'bne', 0x16: 'ble', 0x17: 'bo',
};
const COBR = {
    0x20: 'testno', 0x21: 'testg', 0x22: 'teste', 0x23: 'testge',
    0x24: 'testl', 0x25: 'testne', 0x26: 'testle', 0x27: 'testo',
    0x30: 'bbc', 0x31: 'cmpobg', 0x32: 'cmpobe', 0x33: 'cmpobge',
    0x34: 'cmpobl', 0x35: 'cmpobne', 0x36: 'cmpoble', 0x37: 'bbs',
    0x38: 'cmpibno', 0x39: 'cmpibg', 0x3a: 'cmpibe', 0x3b: 'cmpibge',
    0x3c: 'cmpibl', 0x3d: 'cmpibne', 0x3e: 'cmpible', 0x3f: 'cmpibo',
};
const MEM = {
    0x80: 'ldob', 0x82: 'stob', 0x84: 'bx', 0x85: 'balx', 0x86: 'callx',
    0x88: 'ldos', 0x8a: 'stos', 0x8c: 'lda', 0x90: 'ld', 0x92: 'st',
    0x98: 'ldl', 0x9a: 'stl', 0xa0: 'ldt', 0xa2: 'stt',
    0xb0: 'ldq', 0xb2: 'stq', 0xc0: 'ldib', 0xc2: 'stib',
    0xc8: 'ldis', 0xca: 'stis',
};
const STORES = new Set([0x82, 0x8a, 0x92, 0x9a, 0xa2, 0xb2, 0xc2, 0xca]);

/* REG opcode is 12 bits: the top byte shifted up four, plus bits 10-7. */
const REG = {
    0x580: 'notbit', 0x581: 'and', 0x582: 'andnot', 0x583: 'setbit',
    0x584: 'notand', 0x586: 'xor', 0x587: 'or', 0x588: 'nor',
    0x589: 'xnor', 0x58a: 'not', 0x58b: 'ornot', 0x58c: 'clrbit',
    0x58d: 'notor', 0x58e: 'nand', 0x58f: 'alterbit',
    0x590: 'addo', 0x591: 'addi', 0x592: 'subo', 0x593: 'subi',
    0x598: 'shro', 0x59a: 'shrdi', 0x59b: 'shri', 0x59c: 'shlo',
    0x59d: 'rotate', 0x59e: 'shli',
    0x5a0: 'cmpo', 0x5a1: 'cmpi', 0x5a2: 'concmpo', 0x5a3: 'concmpi',
    0x5a4: 'cmpinco', 0x5a5: 'cmpinci', 0x5a6: 'cmpdeco', 0x5a7: 'cmpdeci',
    0x5ac: 'scanbyte', 0x5ae: 'chkbit',
    0x5b0: 'addc', 0x5b2: 'subc',
    0x5cc: 'mov', 0x5d8: 'eshro', 0x5dc: 'movl', 0x5ec: 'movt', 0x5fc: 'movq',
    0x600: 'synmov', 0x601: 'synmovl', 0x602: 'synmovq', 0x603: 'cmpstr',
    0x610: 'atmod', 0x612: 'atadd',
    0x640: 'spanbit', 0x641: 'scanbit', 0x642: 'daddc', 0x645: 'modac',
    0x650: 'modify', 0x651: 'extract', 0x654: 'modtc', 0x655: 'modpc',
    0x660: 'calls', 0x66b: 'mark', 0x66c: 'fmark', 0x66d: 'flushreg',
    0x66f: 'syncf',
    0x670: 'emul', 0x671: 'ediv',
    0x674: 'cvtir', 0x675: 'cvtilr', 0x676: 'scalerl', 0x677: 'scaler',
    0x680: 'atanr', 0x681: 'logepr', 0x682: 'logr', 0x683: 'remr',
    0x684: 'cmpor', 0x685: 'cmpr', 0x688: 'sqrtr', 0x689: 'expr',
    0x68a: 'logbnr', 0x68b: 'roundr', 0x68c: 'sinr', 0x68d: 'cosr',
    0x68e: 'tanr', 0x68f: 'classr',
    0x690: 'atanrl', 0x693: 'remrl', 0x694: 'cmporl', 0x695: 'cmprl',
    0x698: 'sqrtrl', 0x69b: 'roundrl', 0x69c: 'sinrl', 0x69d: 'cosrl',
    0x6c0: 'cvtri', 0x6c1: 'cvtril', 0x6c2: 'cvtzri', 0x6c3: 'cvtzril',
    0x6c9: 'movr', 0x6d9: 'movrl', 0x6e1: 'movre',
    0x6e2: 'cpysre', 0x6e3: 'cpyrsre',
    0x701: 'mulo', 0x708: 'remo', 0x70b: 'remi', 0x70c: 'divo', 0x70e: 'divi',
    0x741: 'muli',
    /* The floating-point block the 3D maths runs in. */
    0x78b: 'divr', 0x78c: 'divrl',
    
};

const s32 = (v, bits) => (v << (32 - bits)) >> (32 - bits);
export const reg = (n) => (n < 16 ? `r${n}` : `g${n - 16}`);
/* A literal operand: the M bit turns a register field into the value 0..31. */
const op = (n, m) => (m ? `${n}` : reg(n));

export function disasm(dv, addr) {
    const w = dv.getUint32(addr, true);
    const top = w >>> 24;
    let len = 4, text, target = null;

    if (top >= 0x08 && top <= 0x1f) {
        const name = CTRL[top] ?? `ctrl_${top.toString(16)}`;
        if (top === 0x0a) {
            text = 'ret';
        } else {
            target = addr + s32((w >>> 2) & 0x3fffff, 22) * 4;
            text = `${name} 0x${target.toString(16)}`;
        }
    } else if (top >= 0x20 && top <= 0x3f) {
        const name = COBR[top] ?? `cobr_${top.toString(16)}`;
        const src1 = (w >>> 19) & 0x1f, src2 = (w >>> 14) & 0x1f;
        const m1 = (w >>> 13) & 1;
        target = addr + s32((w >>> 2) & 0x7ff, 11) * 4;
        text = top < 0x28
            ? `${name} ${reg(src1)}`
            : `${name} ${op(src1, m1)}, ${reg(src2)}, 0x${target.toString(16)}`;
    } else if (top >= 0x58 && top <= 0x7f) {
        const opc = (top << 4) | ((w >>> 7) & 0xf);
        const name = REG[opc] ?? `reg_${opc.toString(16)}`;
        const srcdst = (w >>> 19) & 0x1f, src2 = (w >>> 14) & 0x1f, src1 = w & 0x1f;
        const m1 = (w >>> 11) & 1, m2 = (w >>> 12) & 1, m3 = (w >>> 13) & 1;
        text = `${name} ${op(src1, m1)}, ${op(src2, m2)}, ${op(srcdst, m3)}`;
    } else if (top >= 0x80 && top <= 0xcf) {
        const name = MEM[top] ?? `mem_${top.toString(16)}`;
        const srcdst = (w >>> 19) & 0x1f, abase = (w >>> 14) & 0x1f;
        let ea;
        if (((w >>> 12) & 1) === 0) {                       /* MEMA */
            const offset = w & 0xfff;
            ea = ((w >>> 13) & 1)
                ? `0x${offset.toString(16)}(${reg(abase)})`
                : `0x${offset.toString(16)}`;
            if (!((w >>> 13) & 1)) target = offset;
        } else {                                            /* MEMB */
            const mode = (w >>> 10) & 0xf;
            const scale = 1 << ((w >>> 7) & 7);
            const index = w & 0x1f;
            const needsDisp = mode >= 0xc || mode === 5;
            const disp = needsDisp ? dv.getUint32(addr + 4, true) : 0;
            if (needsDisp) len = 8;
            const ix = `[${reg(index)}*${scale}]`;
            switch (mode) {
                case 0x4: ea = `(${reg(abase)})`; break;
                case 0x5: target = (addr + 8 + disp) >>> 0; ea = `0x${target.toString(16)}(IP)`; break;
                case 0x7: ea = `(${reg(abase)})${ix}`; break;
                case 0xc: target = disp; ea = `0x${disp.toString(16)}`; break;
                case 0xd: ea = `0x${disp.toString(16)}(${reg(abase)})`; break;
                case 0xe: target = disp; ea = `0x${disp.toString(16)}${ix}`; break;
                case 0xf: ea = `0x${disp.toString(16)}(${reg(abase)})${ix}`; break;
                default: ea = `?mode${mode.toString(16)}`;
            }
        }
        if (top === 0x84 || top === 0x86) text = `${name} ${ea}`;
        else if (STORES.has(top)) text = `${name} ${reg(srcdst)}, ${ea}`;
        else text = `${name} ${ea}, ${reg(srcdst)}`;
    } else {
        text = `.word 0x${w.toString(16).padStart(8, '0')}`;
    }
    return { text, len, word: w, top, target };
}

/**
 * Disassemble from `addr` up to a `ret` no branch seen so far jumps past.
 * `names` annotates any address the instruction mentions.
 */
export function disasmRange(dv, addr, limit = 0x600, names = {}) {
    const out = [];
    let a = addr, furthest = addr;
    while (a < addr + limit) {
        const d = disasm(dv, a);
        const label = names[a] ? `\n${names[a]}:\n` : '';
        const note = d.target !== null && names[d.target] ? `        ; ${names[d.target]}` : '';
        out.push(`${label}  ${a.toString(16)}: ${d.text}${note}`);
        if (d.target !== null && d.top >= 0x08 && d.top <= 0x3f && d.top !== 0x09) {
            furthest = Math.max(furthest, d.target);
        }
        a += d.len;
        if (d.text === 'ret' && a > furthest) break;
    }
    return out.join('\n');
}

/** Every `call` target in a routine, in order, with duplicates kept. */
export function callTargets(dv, addr, limit = 0x600) {
    const out = [];
    let a = addr, furthest = addr;
    while (a < addr + limit) {
        const d = disasm(dv, a);
        if (d.top === 0x09) out.push(d.target);
        else if (d.target !== null && d.top >= 0x08 && d.top <= 0x3f) {
            furthest = Math.max(furthest, d.target);
        }
        a += d.len;
        if (d.text === 'ret' && a > furthest) break;
    }
    return out;
}

/* ---- run it ---------------------------------------------------------------
 *
 * node i960dis.mjs <hex address> [hex length] [rom.zip]
 *
 * Routines the stage records name are labelled, since those are the ones worth
 * reading: a stage's own objects are dispatched by the address its record holds
 * and nothing else says which routine that is.
 */
if (import.meta.filename === process.argv[1]) {
    const fs = await import('node:fs');
    const { loadRomSet } = await import('./vendor/noclip/js/romset.js');
    const { readStageTable } = await import('./vendor/noclip/js/stages.js');

    const [addrArg, lenArg, romArg] = process.argv.slice(2);
    if (!addrArg) {
        console.error('usage: node i960dis.mjs <hex address> [hex length] [rom.zip]');
        process.exit(2);
    }
    const buf = fs.readFileSync(romArg ?? 'sfight.zip');
    const rom = await loadRomSet([buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)]);

    const names = {};
    for (const st of readStageTable(rom)) {
        st.objects.forEach((o, i) => {
            if (o.init) names[o.init] = `slot${st.slot}_obj${i}_init`;
            if (o.disp) names[o.disp] = `slot${st.slot}_obj${i}_disp`;
        });
    }
    const at = parseInt(addrArg, 16);
    console.log(disasmRange(rom.mainCpuView, at, parseInt(lenArg ?? '600', 16), names));
}
