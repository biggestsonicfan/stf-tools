import {loadRomSet} from './vendor/noclip/js/romset.js';
import fs from 'fs';
const rd=p=>{const b=fs.readFileSync(p);return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);};
const rom=await loadRomSet([rd('sfight.zip')]);
const dv=rom.mainCpuView, BASE=0x8F3D0;
for(let s=0;s<20;s++){
  const b=BASE+s*256;
  if(b+256>rom.maincpu.length) break;
  const parts=[];for(let i=0;i<16;i++)parts.push(dv.getUint16(b+0x64+i*2,true));
  const cage=[];for(let i=0;i<24;i++)cage.push(dv.getUint16(b+0x84+i*2,true));
  const sky=[0,1,2,3].map(i=>dv.getUint16(b+0xC0+i*2,true));
  console.log(`stage ${s}: NUM=${rom.maincpu[b+0x13]} tex=(${dv.getUint16(b+0xC,true)},${dv.getUint16(b+0xE,true)}) rgb=${rom.maincpu[b+16]},${rom.maincpu[b+17]},${rom.maincpu[b+18]} bg=${dv.getUint16(b+0x16,true).toString(16)} floor=${dv.getUint16(b+0x18,true)} plat=${dv.getUint16(b+0x1a,true)} pole=${dv.getUint16(b+0x1c,true)} extra=${dv.getUint16(b+0x1e,true)}`);
  console.log(`   parts=[${parts.join(',')}] cage=[${[...new Set(cage)].join(',')}] sky=[${sky.join(',')}] bright=${dv.getFloat32(b+4,true)}`);
}
