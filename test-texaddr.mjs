/*
 * test-texaddr.mjs — the tile addressing, against the board's own.
 *
 * model2rd.ipp fetch_bilinear_texel walks a texture like this, with u in 8.8
 * fixed point and tex_width the level's width in texels:
 *
 *     if (tex_mirr_x && (u & (tex_width << 8))) u = ~u;
 *     u0 = (u >> 8) & (tex_width - 1);
 *
 * — so a coordinate that has run into an odd copy of the tile is inverted, and
 * that copy reads back to front. tileTexel in js/viewer.js says the same thing
 * on the integer index instead, because that is the form a shader can work in:
 *
 *     s = p + size * 8;  q = s % size;  copy = s / size;
 *     if (mirror && (copy & 1) != 0) q = size - 1 - q;
 *
 * This checks the two agree, over every tile size the header can name and a
 * range of coordinates either side of the origin, mirrored and not.
 *
 * The shader's copy is GLSL and cannot be imported, so the mapping is restated
 * here. That means this pins the mapping to the board's, and would not notice
 * the shader drifting away from it — read them together when changing either.
 *
 *   node test-texaddr.mjs
 */

/** model2rd.ipp fetch_bilinear_texel, for one axis, at integer texel p. */
function board(p, size, mirror) {
    /* The board's coordinate is 8.8 fixed point; an integer texel is p << 8. */
    let u = (p << 8) | 0;
    if (mirror && (u & (size << 8)) !== 0) u = ~u;
    return (u >> 8) & (size - 1);
}

/** tileTexel in js/viewer.js, for one axis. */
function viewer(p, size, mirror) {
    const s = p + size * 8;
    let q = s % size;
    const copy = Math.floor(s / size);
    if (mirror && (copy & 1) !== 0) q = size - 1 - q;
    return q;
}

/* 32 << 0..7 is every width or height the size field can name. */
const SIZES = [32, 64, 128, 256, 512, 1024, 2048, 4096];
/* Far enough either side to cross several copies, and inside the eight copies
 * of headroom tileTexel adds to keep its modulo off negative numbers. */
const RANGE = [-200, 600];

let checked = 0;
let bad = 0;
const shown = [];

for (const size of SIZES) {
    for (const mirror of [false, true]) {
        for (let p = RANGE[0]; p <= RANGE[1]; p++) {
            const a = board(p, size, mirror);
            const b = viewer(p, size, mirror);
            checked++;
            if (a !== b) {
                bad++;
                if (shown.length < 8) {
                    shown.push(`size ${size} mirror ${mirror ? 1 : 0} p ${p}: board ${a}, viewer ${b}`);
                }
            }
        }
    }
}

/* The point of the flag: an odd copy has to come back reversed, or it is just a
 * repeat and the flag has done nothing. */
let reflected = 0;
for (const size of SIZES) {
    for (let q = 0; q < size; q++) {
        if (viewer(size + q, size, true) !== size - 1 - q) reflected++;
        if (viewer(size + q, size, false) !== q) reflected++;
    }
}

console.log(`${checked} coordinates over ${SIZES.length} tile sizes, mirrored and not`);
for (const s of shown) console.log('  ' + s);
if (bad === 0 && reflected === 0) {
    console.log('OK: the tile addressing matches fetch_bilinear_texel, and an odd copy reflects');
} else {
    if (bad) console.log(`FAIL: ${bad} coordinates disagree with the board`);
    if (reflected) console.log(`FAIL: ${reflected} coordinates do not reflect as they should`);
    process.exit(1);
}
