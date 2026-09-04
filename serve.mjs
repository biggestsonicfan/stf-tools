/* Minimal static server for the explorer: no dependencies, correct MIME types
 * for ES modules, and a flat refusal to serve a .zip, so that refusal has one
 * implementation. The site itself lives in the explorer checkout rather than
 * here, so ROOT is the submodule — serving this repo instead would put the ROM
 * sitting beside these tools on a public port. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'vendor/noclip');
const PORT = Number(process.env.PORT) || 8173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

http.createServer((req, res) => {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.join(ROOT, rel);
  /* The URL parser resolves `..` segments itself, but only unencoded ones, so a
   * path can still arrive here as `%2e%2e%2f` and climb out of ROOT. Comparing
   * against ROOT alone is not enough either: `path.join('/app', '/../app.env')`
   * is `/app.env`, which starts with ROOT while sitting outside it. Compare
   * against ROOT plus a separator, so only what is genuinely under it passes. */
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  /* The explorer takes its ROM set from the user, so the server never hands one
   * out even if the zips happen to be sitting in the repo. */
  if (path.extname(file).toLowerCase() === '.zip') { res.writeHead(403).end('forbidden'); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': 'no-cache',
      /* Served publicly, so do not let a browser second-guess the type above. */
      'x-content-type-options': 'nosniff',
    });
    fs.createReadStream(file).pipe(res);
  });
}).listen(PORT, () => console.log(`serving ${ROOT} on http://localhost:${PORT}`));
