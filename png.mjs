import zlib from 'node:zlib';
function crc32buf(b){let t=[];for(let i=0;i<256;i++){let c=i;for(let j=0;j<8;j++)c=(c>>>1)^((c&1)?0xedb88320:0);t[i]=c>>>0;}
 let c=0xffffffff;for(const x of b)c=t[(c^x)&255]^(c>>>8);return (c^0xffffffff)>>>0;}
function chunk(type,data){const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const td=Buffer.concat([Buffer.from(type,'ascii'),data]);
 const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32buf(td));return Buffer.concat([len,td,crc]);}
/** gray: Uint8Array w*h */
export function writeGrayPNG(path,gray,w,h){
 const raw=Buffer.alloc((w+1)*h);
 for(let y=0;y<h;y++){raw[y*(w+1)]=0;Buffer.from(gray.buffer,gray.byteOffset+y*w,w).copy(raw,y*(w+1)+1);}
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=0;
 const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
 import('node:fs').then(fs=>fs.writeFileSync(path,png));
 return png;
}
