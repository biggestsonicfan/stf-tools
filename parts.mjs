import {loadRomSet} from './vendor/noclip/js/romset.js';
import {decodeModel} from './vendor/noclip/js/model.js';
import fs from 'fs';
const rd=p=>{const b=fs.readFileSync(p);return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);};
const rom=await loadRomSet([rd('sfight.zip')]);
const SONIC=[0,8,3027,11,13,15,10,12,16,0,19,21,23,18,20,22,0,1160,1150,1153,1164,1162,1152,1163,1161,0,1159,1149,1147,1158,1148,1146];
SONIC.forEach((id,i)=>{
  if(!id){console.log(String(i).padStart(2),'---');return;}
  const m=decodeModel(rom,id);
  console.log(String(i).padStart(2), String(id).padStart(5), m? `f=${String(m.faceCount).padStart(4)} min=[${m.bounds.min.map(v=>v.toFixed(1).padStart(7)).join(',')}] max=[${m.bounds.max.map(v=>v.toFixed(1).padStart(7)).join(',')}]`:'no mesh');
});
