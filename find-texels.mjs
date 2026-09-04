/* Scan every ROM region for blocks that behave like a 4-bit image: rows at the
 * candidate width should resemble the row above far more than a shuffled row. */
import {loadRomSet} from './vendor/noclip/js/romset.js';
import fs from 'fs';
const rd=p=>{const b=fs.readFileSync(p);return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);};
const rom=await loadRomSet([rd('sfight.zip')]);

function nib(buf,off,i){const b=buf[off+(i>>1)];return (i&1)?(b>>4)&15:b&15;}

function score(buf, off, widthTexels, rows){
  const stride=widthTexels>>1;           // bytes per row
  if(off+stride*rows>buf.length) return -1;
  let vert=0, far=0, n=0, nz=0;
  for(let y=1;y<rows;y++){
    for(let x=0;x<widthTexels;x+=4){
      const a=nib(buf,off+y*stride,x), b=nib(buf,off+(y-1)*stride,x);
      const c=nib(buf,off+((y*7)%rows)*stride,x);
      vert+=Math.abs(a-b); far+=Math.abs(a-c); n++;
      if(a) nz++;
    }
  }
  if(!n||nz<n*0.05) return -1;
  return far>0 ? (far-vert)/far : -1;    // 1 = perfectly smooth rows, 0 = noise
}

const regions={mainData:rom.mainData, polygons:rom.polygons, textures:rom.textures};
for(const [name,buf] of Object.entries(regions)){
  for(const w of [256,512,1024,2048]){
    let best=[];
    const stride=w>>1, rows=64, step=0x10000;
    for(let off=0;off+stride*rows<buf.length;off+=step){
      const s=score(buf,off,w,rows);
      if(s>0.25) best.push([s,off]);
    }
    best.sort((a,b)=>b[0]-a[0]);
    if(best.length) console.log(`${name} w=${w}: ${best.length} blocks, best ${best.slice(0,6).map(([s,o])=>`0x${o.toString(16)}(${s.toFixed(2)})`).join(' ')}`);
    else console.log(`${name} w=${w}: none`);
  }
}
