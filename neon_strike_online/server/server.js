'use strict';
/* =========================================================================
   NEON STRIKE online server
   serves the game from /public and runs rooms over WebSocket at /ws
     npm install
     npm start            -> http://localhost:8080  (PORT env var overrides)
   ========================================================================= */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Room, HERO_LIST, MODE_LIST, MAP_LIST } = require('./game');

const PORT = Number(process.env.PORT) || 8080;
const PUBLIC = path.join(__dirname, '..', 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png',
  '.ico': 'image/x-icon', '.svg': 'image/svg+xml'
};

/* ---------------- static files ---------------- */
const server = http.createServer((req, res) => {
  let url;
  try { url = decodeURIComponent((req.url || '/').split('?')[0]); } catch (e) { res.writeHead(400); res.end(); return; }
  if (url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  if (url === '/') url = '/index.html';
  const file = path.normalize(path.join(PUBLIC, url));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

/* ---------------- rooms ---------------- */
const rooms = new Map();          // code -> Room
let nextId = 1;

function makeCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';     // no 0/O or 1/I look-alikes
  let c;
  do { c = ''; for (let i = 0; i < 4; i++) c += A[(Math.random() * A.length) | 0]; } while (rooms.has(c));
  return c;
}
function newRoom(isPublic, mode, map) {
  const code = makeCode();
  const room = new Room(code, isPublic, mode, map, () => rooms.delete(code));
  rooms.set(code, room);
  return room;
}
function cleanName(s) {
  const n = String(s || '').replace(/[^0-9A-Za-z가-힣_\- ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 12);
  return n || 'PLAYER';
}
function leaveRoom(c) {
  if (!c.room) return;
  const r = c.room;
  c.room = null;
  r.removePlayer(c.id);
}
function joinRoom(c, room, hero) {
  c.room = room;
  room.addPlayer(c, hero);
}

function handle(c, m) {
  switch (m.t) {
    case 'hello':
      if (!c.room) c.name = cleanName(m.name);
      break;
    case 'ping':
      c.send({ t: 'pong', c: m.c, s: Date.now() });
      break;
    case 'create': {
      leaveRoom(c);
      const mode = MODE_LIST.includes(m.mode) ? m.mode : 'tdm';
      const map = MAP_LIST.includes(m.map) || m.map === 'random' ? m.map : 'plaza';
      joinRoom(c, newRoom(false, mode, map), m.hero);
      break;
    }
    case 'join': {
      const room = rooms.get(String(m.code || '').toUpperCase().trim());
      if (!room || room.isPublic) return c.send({ t: 'err', m: '방을 찾을 수 없습니다' });
      if (c.room === room) return;
      if (room.isFull()) return c.send({ t: 'err', m: '방이 가득 찼습니다' });
      leaveRoom(c);
      joinRoom(c, room, m.hero);
      break;
    }
    case 'quick': {
      leaveRoom(c);
      let room = null;
      for (const r of rooms.values()) {
        if (r.isPublic && !r.isFull() && (!room || r.players.size > room.players.size)) room = r;
      }
      joinRoom(c, room || newRoom(true, 'tdm', 'random'), m.hero);
      break;
    }
    case 'leave':
      leaveRoom(c);
      break;
    default:
      if (c.room) c.room.onMessage(c, m);
  }
}

/* ---------------- websocket ---------------- */
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

wss.on('connection', (ws) => {
  const c = { id: nextId++, name: 'PLAYER', room: null, msgCount: 0, msgWindow: Date.now() };
  c.send = (obj) => {
    if (ws.readyState === ws.OPEN) ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
  };
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data) => {
    const t = Date.now();
    if (t - c.msgWindow > 1000) { c.msgWindow = t; c.msgCount = 0; }
    if (++c.msgCount > 150) return;                  // flood guard
    let m;
    try { m = JSON.parse(data); } catch (e) { return; }
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
    try { handle(c, m); } catch (e) { console.error('message error', m.t, e); }
  });
  ws.on('close', () => leaveRoom(c));
  ws.on('error', () => {});
  c.send({ t: 'welcome', id: c.id });
});

// drop connections that stopped answering (closed laptops, dead Wi-Fi)
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 15000);

// 20 Hz simulation tick for every room
setInterval(() => {
  for (const r of rooms.values()) {
    try { r.tick(); } catch (e) { console.error('room tick error', r.code, e); }
  }
}, 50);

server.listen(PORT, () => {
  console.log('NEON STRIKE online server running');
  console.log('  this computer : http://localhost:' + PORT);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) console.log('  same Wi-Fi    : http://' + a.address + ':' + PORT);
    }
  }
});

module.exports = { server, rooms };
