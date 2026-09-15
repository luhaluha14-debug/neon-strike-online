'use strict';
/* =========================================================================
   A headless test opponent: joins a room, strafes around its spawn and
   (with --shoot) fires validated shots at the nearest visible enemy.
     node test/dummy.js ABCD            join room ABCD
     node test/dummy.js quick           quick match
     node test/dummy.js ABCD DUMMY sniper --shoot
   URL env var overrides the server (default ws://127.0.0.1:8080/ws)
   ========================================================================= */
const WebSocket = require('ws');

const args = process.argv.slice(2);
const target = args[0] || 'quick';
const name = args[1] && !args[1].startsWith('--') ? args[1] : 'DUMMY';
const hero = args[2] && !args[2].startsWith('--') ? args[2] : 'assault';
const shoot = args.includes('--shoot');
const url = process.env.URL || 'ws://127.0.0.1:8080/ws';

const ws = new WebSocket(url);
const me = { id: 0, sq: 0, alive: false, anchor: [0, 0, 0], pos: [0, 0, 0], team: null, hp: 0 };
let others = [];                 // latest snapshot rows of everyone else
const teams = {};
const send = (o) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(o));
const log = (...a) => console.log('[' + name + ']', ...a);

ws.on('open', () => {});
ws.on('message', (data) => {
  const m = JSON.parse(data);
  switch (m.t) {
    case 'welcome':
      me.id = m.id;
      send({ t: 'hello', name });
      send(target === 'quick' ? { t: 'quick', hero } : { t: 'join', code: target, hero });
      break;
    case 'room':
      m.ps.forEach((p) => { teams[p.id] = p.team; });
      log('room', m.code, m.state, m.ps.map((p) => p.name + ':' + p.team).join(' '));
      break;
    case 'err': log('error:', m.m); break;
    case 'start': {
      m.ps.forEach((p) => { teams[p.id] = p.team; });
      const mine = m.ps.find((p) => p.id === me.id);
      Object.assign(me, { sq: mine.sq, alive: mine.alive, team: mine.team, anchor: mine.p.slice(), pos: mine.p.slice(), hp: mine.hp });
      log('match start on', m.map, 'team', me.team);
      break;
    }
    case 'joined': teams[m.p.id] = m.p.team; break;
    case 'spawn':
      teams[m.id] = m.team;
      if (m.id === me.id) Object.assign(me, { sq: m.sq, alive: true, anchor: m.p.slice(), pos: m.p.slice(), hp: m.hp });
      break;
    case 'snap': others = m.ps.filter((r) => r[0] !== me.id); break;
    case 'pos': if (m.sq === me.sq) me.pos = m.p.slice(); break;
    case 'dmg':
      if (m.v === me.id) { me.hp = m.hp; log('took', m.n, m.hd ? '(HEAD)' : '', 'hp', m.hp); }
      if (m.a === me.id) log('hit player', m.v, 'for', m.n);
      break;
    case 'kill':
      if (m.v === me.id) { me.alive = false; log('killed by', m.a); }
      if (m.a === me.id) log('killed player', m.v);
      break;
    case 'end': log('match end, winner', m.win, 'score', JSON.stringify(m.sc)); break;
  }
});
ws.on('close', () => { log('disconnected'); process.exit(0); });
ws.on('error', (e) => { log('socket error', e.message); process.exit(1); });

// strafe left and right around the spawn point
setInterval(() => {
  if (!me.alive) return;
  const t = Date.now() / 1000;
  me.pos = [me.anchor[0] + Math.sin(t * 1.3) * 2.2, me.anchor[1], me.anchor[2]];
  send({ t: 'st', sq: me.sq, p: me.pos, y: 0, pi: 0, h: 1.8, f: 0 });
}, 50);

// shoot at the nearest living enemy (the server still checks walls and distance)
if (shoot) {
  setInterval(() => {
    if (!me.alive) return;
    const eye = [me.pos[0], me.pos[1] + 1.62, me.pos[2]];
    let best = null, bestD = 1e9;
    for (const r of others) {
      if (!(r[7] & 1) || teams[r[0]] === me.team) continue;
      const cy = r[2] + r[6] * 0.55;
      const d = Math.hypot(r[1] - eye[0], cy - eye[1], r[3] - eye[2]);
      if (d < bestD) { bestD = d; best = { r, cy, d }; }
    }
    if (!best || best.d > 60) return;
    const aim = [(best.r[1] - eye[0]) / best.d, (best.cy - eye[1]) / best.d, (best.r[3] - eye[2]) / best.d];
    send({ t: 'fire', d: aim, e: [[best.r[1], best.cy, best.r[3]]], h: [{ id: best.r[0], hd: 0, d: Math.round(best.d * 100) / 100 }] });
  }, 450);
}
