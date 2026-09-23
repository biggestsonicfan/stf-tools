/*
 * test-decode.mjs — the polygon decoder over a whole ROM set.
 *
 * The decoder is the board's, not one game's: js/model.js reads the same
 * polygon format for every Model 2 set the viewer knows, and takes where the
 * model table sits and how a mesh pointer resolves off js/games.js. So this
 * walks every entry of whatever set it is given and says how much of it came
 * back, which is the one check that costs nothing and catches a games.js entry
 * whose table offset, count or mesh-pointer arithmetic is wrong — a wrong
 * `subtract` decodes to noise rather than to nothing, so the triangle count
 * matters as much as the success count.
 *
 *   node test-decode.mjs                     # sfight.zip beside this file
 *   node test-decode.mjs ../roms/hotd.zip    # any set js/games.js identifies
 *   node test-decode.mjs a.zip b.zip         # a set split over several archives
 *
 * The named models below are Sonic The Fighters', and are only printed when
 * that is the set — they are a hand check that the numbers are the ones the
 * explorer has always drawn, not just that the decode did not throw.
 */

import {loadRomSet} from './vendor/noclip/js/romset.js';
import {decodeModel} from './vendor/noclip/js/model.js';
import fs from 'fs';

/* Several, because a set is not always one archive: MAME splits Daytona USA's
 * 1993 version between the clone and its parent, and loadRomSet looks a member
 * up across every zip it is handed. */
const ROMS = process.argv.slice(2).length ? process.argv.slice(2) : ['sfight.zip'];
const rd=p=>{const b=fs.readFileSync(p);return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);};

for (const r of ROMS) {
  if (!fs.existsSync(r)) { console.error(`no ROM set at ${r}`); process.exit(1); }
}

const rom=await loadRomSet(ROMS.map(rd));
const {count} = rom.game.modelTable;
console.log(`${rom.game.name} — ${count} model table entries`);

if (rom.game.id === 'sfight') {
  for(const id of [517,518,501,493,520,1223,3351,456]){
    const m=decodeModel(rom,id);
    if(!m){console.log(id,'null');continue;}
    console.log(id,'faces',m.faceCount,'tris',m.positions.length/9,'vp',m.vertexPairs,'tex',m.texturedFaces,
      'min',m.bounds.min.map(v=>v.toFixed(1)).join(','),'max',m.bounds.max.map(v=>v.toFixed(1)).join(','));
  }
}

let ok=0,fail=0,tris=0,t0=Date.now();
for(let i=0;i<count;i++){const m=decodeModel(rom,i); if(m){ok++;tris+=m.positions.length/9;} else fail++;}
console.log('decoded all:',ok,'ok',fail,'empty,',tris,'tris in',Date.now()-t0,'ms');

/* An entry that decodes to nothing is ordinary — the tables are sparse. A set
 * where almost nothing decodes is a games.js entry that is wrong. */
if (ok < count / 10) {
  console.log(`FAIL: only ${ok} of ${count} entries decoded — the model table or the `
    + 'mesh-pointer arithmetic for this set is wrong');
  process.exit(1);
}
