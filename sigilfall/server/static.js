/* =============================================================================
   static file serving.  the game itself is plain files under /public; three.js
   is served straight out of node_modules so nothing has to be vendored in.
   ========================================================================== */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = path.join(HERE, '..', 'public');
const ROOT = path.join(HERE, '..', '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2'
};

function threePath() {
  const candidates = [
    path.join(ROOT, 'node_modules', 'three', 'build', 'three.min.js'),
    path.join(HERE, '..', 'node_modules', 'three', 'build', 'three.min.js')
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return null;
}

export function serveStatic(req, res) {
  let url;
  try { url = decodeURIComponent((req.url || '/').split('?')[0]); }
  catch (e) { res.writeHead(400); res.end('bad request'); return true; }

  if (url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return true; }

  if (url === '/vendor/three.min.js') {
    const p = threePath();
    if (!p) { res.writeHead(404); res.end('three.js not installed - run npm install'); return true; }
    send(res, p, 'text/javascript; charset=utf-8', 'public, max-age=604800');
    return true;
  }

  if (url === '/') url = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, url));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); res.end('forbidden'); return true; }
  send(res, file, TYPES[path.extname(file)] || 'application/octet-stream', 'no-cache');
  return true;
}

function send(res, file, type, cache) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache });
    res.end(data);
  });
}
