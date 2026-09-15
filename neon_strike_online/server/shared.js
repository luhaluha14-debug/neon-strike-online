'use strict';
/* =========================================================================
   Loads the game data (heroes, modes, maps) and the collision code straight
   out of public/index.html, so the server always judges shots with exactly
   the same arenas and stats the players see.  Nothing is duplicated.
   ========================================================================= */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML_PATH = path.join(__dirname, '..', 'public', 'index.html');
const START = 'part 2 : hero definitions';
const END = '/* ---------------- scene construction ---------------- */';

const html = fs.readFileSync(HTML_PATH, 'utf8').replace(/\r\n/g, '\n');
const a = html.indexOf(START), b = html.indexOf(END);
if (a < 0 || b < 0 || b < a) {
  throw new Error('shared.js: could not find the game data section in public/index.html');
}
// start at the beginning of the comment line that holds the marker
const CODE = html.slice(html.lastIndexOf('/*', a), b);

// the few helpers that section uses from the utils part of the client
const PRELUDE = [
  'function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }',
  'function lerp(a, b, t) { return a + (b - a) * t; }',
  'function rnd(a, b) { return a + Math.random() * (b - a); }',
  'function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }',
  ''
].join('\n');

/* collision uses module-level arrays, so every map gets its own sandbox */
function makeContext(mapId) {
  const ctx = vm.createContext({});
  vm.runInContext(PRELUDE + CODE, ctx, { filename: 'index.html:game-data' });
  vm.runInContext(
    'ARENA = MAPS[' + JSON.stringify(mapId) + ']; COLORS = ARENA.colors; buildCollision();',
    ctx
  );
  return ctx;
}

const base = makeContext('plaza');
const MAP_LIST = Array.from(base.MAP_LIST);
const maps = {};
for (const id of MAP_LIST) maps[id] = id === 'plaza' ? base : makeContext(id);

for (const need of ['HEROES', 'MODES', 'HERO_LIST', 'MODE_LIST', 'MAPS']) {
  if (!base[need]) throw new Error('shared.js: ' + need + ' missing from the game data section');
}

module.exports = {
  maps,                                   // map id -> sandbox with ARENA, supportAt, segBlocked, ...
  HEROES: base.HEROES,
  MODES: base.MODES,
  HERO_LIST: Array.from(base.HERO_LIST),
  MODE_LIST: Array.from(base.MODE_LIST),
  MAP_LIST
};
