/* =============================================================================
   builds a self-contained copy of the game for a static host that serves no
   websocket - a claude.ai artifact, GitHub Pages, a USB stick.

     node sigilfall/tools/build-artifact.js [outdir]

   what it does
     - inlines the stylesheet, since the host only guarantees the page itself
     - copies three.js out of node_modules so nothing is fetched from a CDN
     - copies the module tree as it is, so the build is the game, not a fork
     - sets SIGILFALL_OFFLINE, which hides online play instead of offering a
       button that cannot work
   the page is emitted as body content (no <html>/<head>), which is the shape
   the artifact host wraps; a plain static host renders it just the same.
   ========================================================================== */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const REPO = path.join(ROOT, '..');
const PUBLIC = path.join(ROOT, 'public');
const OUT = path.resolve(process.argv[2] || path.join(REPO, 'build', 'artifact'));

const THREE_CANDIDATES = [
  path.join(REPO, 'node_modules', 'three', 'build', 'three.min.js'),
  path.join(ROOT, 'node_modules', 'three', 'build', 'three.min.js')
];

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  let n = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name), dst = path.join(to, entry.name);
    if (entry.isDirectory()) n += copyTree(src, dst);
    else { fs.copyFileSync(src, dst); n++; }
  }
  return n;
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(p, base));
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

/* ---- page ---------------------------------------------------------------- */
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(PUBLIC, 'styles', 'ui.css'), 'utf8');

const bodyStart = html.indexOf('<body>') + '<body>'.length;
const bodyEnd = html.lastIndexOf('</body>');
if (bodyStart < 6 || bodyEnd < 0) throw new Error('index.html is not shaped the way this build expects');
const body = html.slice(bodyStart, bodyEnd).trim();

const page = `<title>SIGILFALL</title>
<style>
${css}
/* the host wraps this page in its own skeleton: hold the whole viewport */
html, body { width: 100%; height: 100%; margin: 0; padding: 0; overflow: hidden; background: var(--bg); }
:root { padding: 0 !important; }
</style>

<script>window.SIGILFALL_OFFLINE = true;</script>

${body}
`;

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'index.html'), page);

const modules = copyTree(path.join(PUBLIC, 'src'), path.join(OUT, 'src'));

const three = THREE_CANDIDATES.find((p) => fs.existsSync(p));
if (!three) throw new Error('three.js is not installed - run npm install first');
fs.mkdirSync(path.join(OUT, 'vendor'), { recursive: true });
fs.copyFileSync(three, path.join(OUT, 'vendor', 'three.min.js'));

const files = listFiles(OUT).filter((f) => f !== 'index.html');
const bytes = files.reduce((n, f) => n + fs.statSync(path.join(OUT, f)).size, 0) +
  Buffer.byteLength(page);

console.log('built ' + OUT);
console.log('  page      ' + (Buffer.byteLength(page) / 1024).toFixed(0) + ' KB (stylesheet inlined)');
console.log('  modules   ' + modules);
console.log('  files     ' + (files.length + 1) + ' total, ' + (bytes / 1024 / 1024).toFixed(2) + ' MB');
console.log('\nsupporting files for the artifact publish:');
console.log(JSON.stringify(Object.fromEntries(files.map((f) => [f, path.join(path.relative(REPO, OUT), f)])), null, 0).slice(0, 400) + ' …');
