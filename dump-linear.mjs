/* Render a linear 4-bit block of a ROM region as a PNG.
 * usage: node dump-linear.mjs <outdir> <region> <hexOffset> <width> <height> */
import {loadRomSet} from './vendor/noclip/js/romset.js';
import {writeGrayPNG} from './png.mjs';
import fs from 'fs';
const rd=p=>{const b=fs.readFileSync(p);return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);};
const rom=await loadRomSet([rd('sfight.zip')]);
const [outDir]=process.argv.slice(2,3);
for(const spec of process.argv.slice(3)){
  const [region,offHex,wS,hS,swapS]=spec.split(':');
  const buf=rom[region]; const off=parseInt(offHex,16); const w=+wS,h=+hS; const swap=swapS==='1';
  const stride=w>>1; const out=new Uint8Array(w*h);
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){
    const b=buf[off+y*stride+(x>>1)];
    const lo=b&15, hi=(b>>4)&15;
    out[y*w+x]=((x&1)? (swap?lo:hi) : (swap?hi:lo))*17;
  }
  const name=`${region}_${offHex}_w${w}${swap?'_s':''}.png`;
  writeGrayPNG(`${outDir}/${name}`, out, w, h);
  console.log('wrote', name);
}
