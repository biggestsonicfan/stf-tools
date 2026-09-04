import {loadRomSet} from './vendor/noclip/js/romset.js';
import {decodeModel} from './vendor/noclip/js/model.js';
import fs from 'fs';
const rd=p=>{const b=fs.readFileSync(p);return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);};
const rom=await loadRomSet([rd('sfight.zip')]);
const dv=rom.mainCpuView;
console.log('palm position table @0x26790 (4 x {float,float}):');
for(let i=0;i<4;i++){
  const a=dv.getFloat32(0x26790+i*8,true), b=dv.getFloat32(0x26790+i*8+4,true);
  console.log('  ',i,a,b);
}
console.log('cage_corners @0x36001-ish: search');
console.log('stage_data +0xC8/+0xCC/+0xD0 per slot:');
for(let s=0;s<16;s++){
  const b=0x8F3D0+s*256;
  console.log('  slot',s,'soko',dv.getFloat32(b+0xC8,true).toFixed(3),
    'height',dv.getFloat32(b+0xCC,true).toFixed(3),
    'floorsize',dv.getFloat32(b+0xD0,true).toFixed(3),
    'flags 0x'+dv.getUint32(b+0,true).toString(16));
}
console.log('model bounds:');
for(const id of [493,517,518,519,554,555,1223,2833,522,1558,501,502,503,504,505,506]){
  const m=decodeModel(rom,id);
  console.log('  ',String(id).padStart(5), m?`f=${String(m.faceCount).padStart(4)} min=[${m.bounds.min.map(v=>v.toFixed(2).padStart(8)).join(',')}] max=[${m.bounds.max.map(v=>v.toFixed(2).padStart(8)).join(',')}]`:'no mesh');
}
