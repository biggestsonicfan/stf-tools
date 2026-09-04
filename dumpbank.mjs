import {loadRomSet} from './vendor/noclip/js/romset.js';
import {writeGrayPNG} from './png.mjs';
import fs from 'fs';
const rd = p => { const b = fs.readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset+b.byteLength); };
const rom = await loadRomSet([rd('sfight.zip')]);
/* Decode a 1MB bank as the Model 2 texram sheet: 2048x1024 4-bit luma with the
 * 16-bit halfword 2x2 nibble swizzle from geo3d.h. */
function decodeSheet(bank, scale=4){
  const base = bank*0x100000;
  const u32 = new Uint32Array(rom.textures.buffer, base, 0x100000/4);
  const W=2048,H=1024, ow=W/scale, oh=H/scale;
  const out=new Uint8Array(ow*oh);
  for(let y=0;y<H;y+=scale) for(let x=0;x<W;x+=scale){
    let x2=x,y2=y; if(x2>=1024){x2-=1024;y2^=1024;}
    const off=((y2>>1)*512)+(x2>>1);
    let w=u32[off>>1]; if(off&1)w>>>=16; if((y&1)===0)w>>>=8; if((x&1)===0)w>>>=4;
    out[(y/scale)*ow+(x/scale)]=(w&15)*17;
  }
  writeGrayPNG(process.argv[2]+`/bank${String(bank).padStart(2,'0')}.png`, out, ow, oh);
}
for(const b of process.argv.slice(3).map(Number)) decodeSheet(b);
console.log('done');
