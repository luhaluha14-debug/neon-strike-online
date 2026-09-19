/* =============================================================================
   serves a static build the way a host would, wrapping the page in the same
   skeleton the artifact platform adds around it, so the build can be checked
   before it is published.

     node sigilfall/tools/build-artifact.js
     node sigilfall/tools/preview-artifact.js build/artifact   ->  :8090
   ========================================================================== */
import http from 'http';
import fs from 'fs';
import path from 'path';
const DIR = process.argv[2] || 'build/artifact';
const PORT = Number(process.env.PORT) || 8090;
const TYPES = { '.js':'text/javascript; charset=utf-8', '.css':'text/css', '.html':'text/html; charset=utf-8' };
http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') {
    const body = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
    const page = '<!doctype html><html><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
      '<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}' +
      'body{margin:0;font:14px system-ui;background:#faf9f7}img{max-width:100%}[hidden]{display:none!important}</style>' +
      '</head><body>' + body + '</body></html>';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(page);
  }
  if (url === '/favicon.ico') {
    // the real host supplies the tab icon; serve one so the console stays clean
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    return res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
      '<rect width="32" height="32" fill="#0b0e12"/>' +
      '<path d="M16 4 L27 16 L16 28 L5 16 Z" fill="none" stroke="#c8632f" stroke-width="2.4"/></svg>');
  }
  const file = path.join(DIR, url);
  fs.readFile(file, (err, data) => {
    if (err) { console.log('404 ' + url); res.writeHead(404); return res.end('nope'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => console.log('static build preview on http://localhost:' + PORT));
