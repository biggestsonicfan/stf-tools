/* Pull texture RAM out of a running m2-hle2 over its MCP bridge.
 *
 * The ROM's texture sheets are Huffman-packed (unpack_lod_data); the game
 * unpacks them into texture RAM itself on every scene change. This grabs the
 * result so the viewer can build its atlas from it.
 *
 * usage: node dump-texram.mjs <outdir> [waitSeconds] [port]
 */
import net from 'node:net';
import fs from 'node:fs';

const OUT = process.argv[2] || 'texram';
const WAIT = Number(process.argv[3] ?? 25);
const PORT = Number(process.argv[4] ?? 7172);

const TEXRAM = [
  { name: 'texram0.bin', base: 0x11000000 },
  { name: 'texram1.bin', base: 0x11200000 },
];
const SIZE = 0x100000;
const CHUNK = 4096;

function connect() {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ host: '127.0.0.1', port: PORT });
    s.setNoDelay(true);
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
}

/* One in-flight request at a time, replies are newline-delimited. */
function makeRpc(sock) {
  let buf = '';
  const queue = [];
  sock.on('data', (d) => {
    buf += d.toString('latin1');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const cb = queue.shift();
      if (cb) { try { cb(null, JSON.parse(line)); } catch (e) { cb(e); } }
    }
  });
  return (cmd, extra = {}) => new Promise((res, rej) => {
    queue.push((err, v) => (err ? rej(err) : res(v)));
    sock.write(JSON.stringify({ cmd, ...extra }) + '\n');
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let sock;
for (let attempt = 0; ; attempt++) {
  try { sock = await connect(); break; }
  catch { if (attempt > 40) throw new Error('MCP bridge never opened on :' + PORT); await sleep(500); }
}
const rpc = makeRpc(sock);
console.log('status:', JSON.stringify(await rpc('get_status')));

console.log(`letting the game run ${WAIT}s so it unpacks a scene's textures…`);
for (let t = 0; t < WAIT; t += 5) {
  await sleep(5000);
  const st = await rpc('get_status');
  console.log(`  t+${t + 5}s ip=${st.ip} steps/s=${st.steps_per_second}`);
}

fs.mkdirSync(OUT, { recursive: true });
for (const sheet of TEXRAM) {
  const out = Buffer.alloc(SIZE);
  let nonzero = 0;
  for (let off = 0; off < SIZE; off += CHUNK) {
    const r = await rpc('read_memory', { addr: '0x' + (sheet.base + off).toString(16).padStart(8, '0'), size: CHUNK });
    if (!r.ok) throw new Error(`read_memory failed at +${off.toString(16)}: ${r.error}`);
    const bytes = Buffer.from(r.data, 'hex');
    bytes.copy(out, off);
    for (const b of bytes) if (b) nonzero++;
    if ((off & 0x3ffff) === 0) process.stdout.write(`\r  ${sheet.name} ${(off / SIZE * 100).toFixed(0)}%`);
  }
  fs.writeFileSync(`${OUT}/${sheet.name}`, out);
  console.log(`\r  ${sheet.name}: ${(nonzero / SIZE * 100).toFixed(1)}% non-zero -> ${OUT}/${sheet.name}`);
}
sock.end();
