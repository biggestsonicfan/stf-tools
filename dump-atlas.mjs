import {buildAtlas, ATLAS_W, ATLAS_H} from './vendor/noclip/js/atlas.js';
import {writeGrayPNG} from './png.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {TEXRAM_DIR} from './texref.mjs';
/* usage: node dump-atlas.mjs <out.png> [dir with texram0/1.bin] */
const dir=process.argv[3]||TEXRAM_DIR;
const s0=new Uint8Array(fs.readFileSync(path.join(dir,'texram0.bin')));
const s1=new Uint8Array(fs.readFileSync(path.join(dir,'texram1.bin')));
const a=buildAtlas(s0,s1);
const SC=2, w=ATLAS_W/SC, h=ATLAS_H/SC;
const small=new Uint8Array(w*h);
for(let y=0;y<h;y++) for(let x=0;x<w;x++) small[y*w+x]=a[(y*SC)*ATLAS_W+x*SC];
writeGrayPNG(process.argv[2], small, w, h);
console.log('wrote', process.argv[2], w+'x'+h);
