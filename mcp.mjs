/* One-shot MCP bridge command: node mcp.mjs '<json>' [more...] */
import net from 'node:net';
const sock = net.createConnection({ host: '127.0.0.1', port: 7172 });
sock.setNoDelay(true);
let buf = '', queue = [];
sock.on('data', d => { buf += d.toString('latin1'); let i;
  while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0,i); buf = buf.slice(i+1);
    const cb = queue.shift(); if (cb) cb(l); } });
const rpc = (o) => new Promise(r => { queue.push(r); sock.write(JSON.stringify(o) + '\n'); });
await new Promise(r => sock.once('connect', r));
for (const a of process.argv.slice(2)) {
  const res = await rpc(JSON.parse(a));
  console.log(a, '->', res.length > 900 ? res.slice(0, 900) + '…' : res);
}
sock.end();
