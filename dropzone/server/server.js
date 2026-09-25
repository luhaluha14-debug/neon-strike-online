/* =========================================================================
   DROPZONE dev / release server.
   Phase 1: serves the client (offline play vs bots).  Online rooms come in
   STEP 10 and will reuse /shared for authoritative simulation.

     npm install
     npm start                      -> http://localhost:8090  (dev build)
     NODE_ENV=production npm start  -> release build (debug tools disabled)
   ========================================================================= */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8090;
const RELEASE = process.env.NODE_ENV === 'production';

const MOUNTS = [
  ['/client/', path.join(ROOT, 'client')],
  ['/shared/', path.join(ROOT, 'shared')],
  ['/vendor/three/', path.join(ROOT, 'node_modules', 'three')]
];
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json'
};

function send(res, code, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, ...extra });
  res.end(body);
}

function serveFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) { send(res, 404, 'not found'); return; }
    send(res, 200, data, TYPES[path.extname(file)] || 'application/octet-stream',
      { 'Cache-Control': RELEASE ? 'public, max-age=300' : 'no-cache' });
  });
}

export function createServer() {
  return http.createServer((req, res) => {
    let url;
    try { url = decodeURIComponent((req.url || '/').split('?')[0]); } catch { send(res, 400, 'bad request'); return; }
    if (url === '/health') { send(res, 200, 'ok'); return; }
    if (url === '/build-config.js') {
      // debug tools only exist in dev builds
      send(res, 200, `export const BUILD = ${JSON.stringify({ dev: !RELEASE, version: '0.1.0-phase1' })};\n`, TYPES['.js'], { 'Cache-Control': 'no-cache' });
      return;
    }
    if (url === '/' || url === '/index.html') { serveFile(res, path.join(ROOT, 'client', 'index.html')); return; }
    for (const [prefix, dir] of MOUNTS) {
      if (!url.startsWith(prefix)) continue;
      const file = path.normalize(path.join(dir, url.slice(prefix.length)));
      if (!file.startsWith(dir + path.sep)) { send(res, 403, 'forbidden'); return; }
      serveFile(res, file);
      return;
    }
    send(res, 404, 'not found');
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createServer();
  server.listen(PORT, () => {
    console.log(`DROPZONE ${RELEASE ? 'release' : 'dev'} server on http://localhost:${PORT}`);
    for (const list of Object.values(os.networkInterfaces())) {
      for (const n of list || []) if (n.family === 'IPv4' && !n.internal) console.log(`  LAN / mobile: http://${n.address}:${PORT}`);
    }
  });
}
