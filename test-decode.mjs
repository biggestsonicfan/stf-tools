import {loadRomSet} from './vendor/noclip/js/romset.js';
import {decodeModel} from './vendor/noclip/js/model.js';
import fs from 'fs';
const rd=p=>{const b=fs.readFileSync(p);return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);};
const rom=await loadRomSet([rd('sfight.zip')]);
for(const id of [517,518,501,493,520,1223,3351,456]){
  const m=decodeModel(rom,id);
  if(!m){console.log(id,'null');continue;}
  console.log(id,'faces',m.faceCount,'tris',m.positions.length/9,'vp',m.vertexPairs,'tex',m.texturedFaces,
    'min',m.bounds.min.map(v=>v.toFixed(1)).join(','),'max',m.bounds.max.map(v=>v.toFixed(1)).join(','));
}
let ok=0,fail=0,tris=0,t0=Date.now();
for(let i=0;i<5103;i++){const m=decodeModel(rom,i); if(m){ok++;tris+=m.positions.length/9;} else fail++;}
console.log('decoded all:',ok,'ok',fail,'empty,',tris,'tris in',Date.now()-t0,'ms');
