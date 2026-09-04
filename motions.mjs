import {loadRomSet, xtraToMainData} from './vendor/noclip/js/romset.js';
import fs from 'fs';
const rd=p=>{const b=fs.readFileSync(p);return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);};
const rom=await loadRomSet([rd('sfight.zip')]);
const dv=rom.mainDataView;
const TBL=xtraToMainData(0x6400004);
console.log('offset_list_motions -> main_data 0x'+TBL.toString(16));
for(let i=0;i<12;i++){
  const v=dv.getUint32(TBL+i*4,true);
  console.log(' motion',i,'ptr 0x'+v.toString(16));
}
// Sonic's animation table entries: 0x116, 0xDA, 0x115...
for(const m of [0x116,0xDA,0x115,0x108,0x71]){
  const ptr=dv.getUint32(TBL+m*4,true);
  const off=xtraToMainData(ptr);
  const len=dv.getUint16(off,true);
  console.log(`motion 0x${m.toString(16)}: ptr=0x${ptr.toString(16)} -> md 0x${off.toString(16)} len=${len}`);
  const bytes=[...rom.mainData.slice(off,off+48)].map(b=>b.toString(16).padStart(2,'0')).join(' ');
  console.log('   ',bytes);
}
