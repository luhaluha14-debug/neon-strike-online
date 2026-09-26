/* =========================================================================
   Online play: lobby, rooms and the authoritative match loop.

   - quick match: joins the open public room of the chosen mode (or makes one);
     the match starts after a short countdown, bots fill the empty seats
   - private room: 4-letter code, the host starts it, players can pick a team
   - the server owns the Match: clients only send input commands and requests
     (pick up / drop).  Positions, ammo, damage, items, deaths, zone, vehicles
     and the winner are decided here.
   - a player who disconnects mid-match is taken over by a bot
   ========================================================================= */
import { WebSocketServer } from 'ws';
import { Match, TICK, emptyCommand, EDGE_KEYS } from '../shared/game.js';
import { BotBrain } from '../shared/ai.js';
import { PROTOCOL, SNAP_EVERY, ROOM_MAX, ROOM_FILL, MODES, packWorld, packMe, enrichEvent } from '../shared/net.js';

const QUICK_WAIT = Number(process.env.QUICK_WAIT) || 20;     // seconds a quick room waits for more players
const MAX_ROOMS = 40;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);

export class NetServer {
  constructor(httpServer, { world, nav, log = console.log }) {
    this.world = world; this.nav = nav; this.log = log;
    this.rooms = new Map();
    this.nextConn = 1;
    this.wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: 16 * 1024 });
    this.wss.on('connection', (ws) => this.onConnect(ws));
    this.timer = setInterval(() => this.lobbyTick(), 250);
  }

  close() {
    clearInterval(this.timer);
    for (const r of this.rooms.values()) this.closeRoom(r);
    for (const ws of this.wss.clients) ws.terminate();
    this.wss.close();
  }

  /* ---------------- connections ---------------- */
  onConnect(ws) {
    const c = { id: this.nextConn++, ws, name: 'PLAYER', room: null, pid: null, queue: [], ack: 0, last: emptyCommand(), alive: true, rate: 0, rateT: Date.now() };
    ws.on('message', (data) => {
      // simple flood guard: 200 messages per second is far more than a 60 Hz client sends
      const now = Date.now();
      if (now - c.rateT > 1000) { c.rateT = now; c.rate = 0; }
      if (++c.rate > 200) return;
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (msg && typeof msg.t === 'string') this.onMessage(c, msg);
    });
    ws.on('close', () => this.onClose(c));
    ws.on('error', () => {});
    this.send(c, { t: 'welcome', id: c.id, protocol: PROTOCOL });
  }

  send(c, msg) { if (c.ws.readyState === 1) c.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); }

  onMessage(c, m) {
    switch (m.t) {
      case 'hello': c.name = clean(m.name, 12) || 'PLAYER'; c.opts = { autoPickup: m.autoPickup !== false, autoReload: m.autoReload !== false }; break;
      case 'ping': this.send(c, { t: 'pong', c: m.c }); break;
      case 'quick': this.quick(c, m.mode); break;
      case 'create': this.create(c, m.mode); break;
      case 'join': this.join(c, String(m.code || '').toUpperCase()); break;
      case 'leave': this.leave(c); break;
      case 'start': { const r = c.room; if (r && !r.public && r.host === c && r.state === 'lobby') this.countdown(r, 3); break; }
      case 'team': this.setTeam(c, m.n); break;
      case 'in': this.onInput(c, m); break;
      case 'act': this.onAction(c, m); break;
    }
  }

  onClose(c) {
    c.alive = false;
    this.leave(c);
  }

  /* ---------------- rooms ---------------- */
  newRoom(mode, pub) {
    if (this.rooms.size >= MAX_ROOMS) return null;
    let code;
    do { code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join(''); } while (this.rooms.has(code));
    const r = { code, mode: MODES[mode] ? mode : 1, public: pub, conns: [], host: null, state: 'lobby', startAt: 0, match: null, loop: null };
    this.rooms.set(code, r);
    return r;
  }
  quick(c, mode) {
    mode = MODES[mode] ? +mode : 1;
    this.leave(c);
    let r = [...this.rooms.values()].find((x) => x.public && x.mode === mode && x.state !== 'playing' && x.state !== 'ended' && x.conns.length < ROOM_MAX);
    if (!r) r = this.newRoom(mode, true);
    if (!r) { this.send(c, { t: 'err', msg: '서버가 가득 찼습니다' }); return; }
    this.enter(c, r);
    if (r.state === 'lobby') this.countdown(r, QUICK_WAIT);
    if (r.conns.length >= ROOM_MAX) this.countdown(r, 3);
  }
  create(c, mode) {
    this.leave(c);
    const r = this.newRoom(MODES[mode] ? +mode : 1, false);
    if (!r) { this.send(c, { t: 'err', msg: '서버가 가득 찼습니다' }); return; }
    this.enter(c, r);
  }
  join(c, code) {
    const r = this.rooms.get(code);
    if (!r) { this.send(c, { t: 'err', msg: '방을 찾을 수 없습니다' }); return; }
    if (r.state === 'playing' || r.state === 'ended') { this.send(c, { t: 'err', msg: '이미 시작된 방입니다' }); return; }
    if (r.conns.length >= ROOM_MAX) { this.send(c, { t: 'err', msg: '방이 가득 찼습니다' }); return; }
    this.leave(c);
    this.enter(c, r);
  }
  enter(c, r) {
    c.room = r; c.pid = null; c.team = 0;
    r.conns.push(c);
    if (!r.host) r.host = c;
    if (r.mode > 1) c.team = this.freeTeam(r);
    this.broadcastRoom(r);
  }
  /** first team number with a free seat */
  freeTeam(r) {
    for (let t = 1; ; t++) if (r.conns.filter((x) => x.team === t).length < r.mode) return t;
  }
  setTeam(c, n) {
    const r = c.room;
    n = Math.floor(Number(n));
    if (!r || r.state !== 'lobby' && r.state !== 'countdown' || r.mode <= 1 || !(n >= 1 && n <= 16)) return;
    if (r.conns.filter((x) => x !== c && x.team === n).length >= r.mode) return;
    c.team = n;
    this.broadcastRoom(r);
  }
  leave(c) {
    const r = c.room;
    if (!r) return;
    r.conns = r.conns.filter((x) => x !== c);
    c.room = null;
    if (r.match && c.pid !== null) this.takeOver(r, c.pid);
    c.pid = null;
    if (r.host === c) r.host = r.conns[0] || null;
    if (!r.conns.length) { this.closeRoom(r); return; }
    if (r.state !== 'playing' && r.state !== 'ended') this.broadcastRoom(r);
  }
  closeRoom(r) {
    if (r.loop) clearInterval(r.loop);
    r.loop = null; r.match = null; r.state = 'closed';
    this.rooms.delete(r.code);
  }
  countdown(r, sec) {
    const at = Date.now() + sec * 1000;
    if (r.state === 'countdown' && r.startAt <= at) return;
    r.state = 'countdown'; r.startAt = at;
    this.broadcastRoom(r);
  }
  roomInfo(r) {
    return {
      t: 'room', code: r.code, mode: r.mode, public: r.public, state: r.state,
      startIn: r.state === 'countdown' ? Math.max(0, (r.startAt - Date.now()) / 1000) : null,
      host: r.host ? r.host.id : null, max: ROOM_MAX, fill: ROOM_FILL,
      players: r.conns.map((x) => ({ id: x.id, name: x.name, team: x.team }))
    };
  }
  broadcastRoom(r) { const s = JSON.stringify(this.roomInfo(r)); for (const c of r.conns) this.send(c, s); }

  lobbyTick() {
    for (const r of this.rooms.values()) {
      if (r.state === 'countdown' && Date.now() >= r.startAt) this.startMatch(r);
      else if (r.state === 'countdown') this.broadcastRoom(r);
    }
  }

  /* ---------------- match ---------------- */
  startMatch(r) {
    const seed = (Math.random() * 1e9) >>> 0;
    // humans get ids 1..n in join order; bots fill the lobby up to ROOM_FILL players
    const humans = r.conns.map((c, i) => ({ id: i + 1, name: c.name, team: r.mode > 1 ? c.team : 0 }));
    const bots = Math.max(0, ROOM_FILL - humans.length);
    const opts = { seed, bots, difficulty: 'normal', teamSize: r.mode, humans };
    r.match = new Match({ world: this.world, nav: this.nav, ...opts });
    r.state = 'playing';
    r.conns.forEach((c, i) => {
      c.pid = humans[i].id; c.queue = []; c.ack = 0; c.last = emptyCommand();
      const p = r.match.byId.get(c.pid);
      if (c.opts) { p.autoPickup = c.opts.autoPickup; p.autoReload = c.opts.autoReload; }
      this.send(c, { t: 'start', ...opts, you: c.pid, code: r.code, mode: r.mode });
    });
    this.log(`room ${r.code}: match started (${humans.length} humans, ${bots} bots, mode ${r.mode})`);
    r.events = [];
    r.acc = 0; r.lastT = performance.now(); r.ticks = 0;
    // setInterval is coarse: run as many fixed ticks as real time asks for
    r.loop = setInterval(() => this.roomTick(r), 1000 / 60);
  }

  /** a disconnected human keeps playing as a bot until the match ends */
  takeOver(r, pid) {
    const m = r.match, p = m && m.byId.get(pid);
    if (!p || !p.alive || p.brain) return;
    p.isBot = true;
    p.name += ' (봇)';
    p.brain = new BotBrain(m, p, 'normal', Math.random());
    if (p.air === 'plane' && m.plane) p.brain.planDrop(m.plane);
    else if (p.air) { p.brain.dropTarget = { x: p.body.pos.x, z: p.body.pos.z }; p.brain.wasAir = true; }
    m.emit({ t: 'takeover', id: pid, name: p.name });
  }

  onInput(c, msg) {
    const r = c.room;
    if (!r || !r.match || c.pid === null || typeof msg.s !== 'number' || !msg.c || typeof msg.c !== 'object') return;
    if (msg.s <= c.ack || (c.queue.length && msg.s <= c.queue[c.queue.length - 1].s)) return;
    c.queue.push({ s: msg.s, c: sanitize(msg.c) });
    // never let a client bank up more than ~12 ticks of input: fold the oldest ones together
    while (c.queue.length > 12) {
      const a = c.queue.shift(), b = c.queue[0];
      for (const k of EDGE_KEYS) b.c[k] = b.c[k] || a.c[k];
      if (b.c.slot < 0 && a.c.slot >= 0) { b.c.slot = a.c.slot; b.c.throwType = a.c.throwType; }
      if (!b.c.use && a.c.use) b.c.use = a.c.use;
      c.ack = a.s;
    }
  }

  onAction(c, msg) {
    const r = c.room, m = r && r.match;
    if (!m || c.pid === null) return;
    const p = m.byId.get(c.pid);
    if (msg.a === 'opts') { if (p) { p.autoPickup = !!msg.autoPickup; p.autoReload = !!msg.autoReload; } return; }
    if (!p || !p.alive || p.downed || p.air || p.veh || m.state !== 'playing') return;
    m.rebuildObstacles();
    if (msg.a === 'pick') {
      const it = m.itemById.get(Number(msg.id));
      // same reach as the inventory's "nearby" list
      if (it && Math.hypot(it.x - p.body.pos.x, it.z - p.body.pos.z) < 2.6 && Math.abs(it.y - p.body.pos.y) < 2) m.pickup(p, it);
    } else if (msg.a === 'drop') {
      const n = Math.max(1, Math.min(999, Math.floor(Number(msg.n)) || 1));
      const k = msg.key;
      if (typeof k === 'string' && (/^slot[0-2]$/.test(k) || Object.hasOwn(p.inv.items, k))) m.requestDrop(p.id, k, n);
    }
  }

  roomTick(r) {
    const m = r.match;
    if (!m) return;
    const now = performance.now();
    r.acc = Math.min(r.acc + (now - r.lastT) / 1000, 0.25);
    r.lastT = now;
    while (r.acc >= TICK) {
      r.acc -= TICK;
      for (const c of r.conns) {
        if (c.pid === null) continue;
        let cmd;
        if (c.queue.length) { const q = c.queue.shift(); cmd = q.c; c.ack = q.s; c.last = cmd; }
        else { cmd = Object.assign({}, c.last); for (const k of EDGE_KEYS) cmd[k] = false; cmd.slot = -1; cmd.use = null; cmd.cycle = 0; cmd.throwType = null; }
        m.setCommand(c.pid, cmd);
      }
      m.step(TICK);
      r.ticks++;
      const evs = m.drainEvents();
      if (evs.length) {
        // events go out right away (gunshots, hits, items): lowest latency for feedback
        const s = JSON.stringify({ t: 'e', ev: evs.map((e) => enrichEvent(m, e)) });
        for (const c of r.conns) this.send(c, s);
      }
      if (r.ticks % SNAP_EVERY === 0) this.snapshot(r);
      if (m.state === 'ended' && !r.endAt) { r.endAt = Date.now(); r.state = 'ended'; this.log(`room ${r.code}: match ended`); }
    }
    // keep the room alive a little after the end so late packets and the result screen settle
    if (r.endAt && Date.now() - r.endAt > 60000) this.closeRoom(r);
  }

  snapshot(r) {
    const m = r.match;
    const common = JSON.stringify(packWorld(m));
    for (const c of r.conns) {
      if (c.pid === null) continue;
      const p = m.byId.get(c.pid);
      // private part (inventory, exact body state, input ack) + the shared world part
      this.send(c, '{"t":"s","me":' + JSON.stringify(packMe(p, c.ack)) + ',' + common.slice(1));
    }
  }
}

/** only known fields with sane types reach the simulation */
function sanitize(c) {
  const n = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0);
  const out = emptyCommand();
  out.fwd = n(c.fwd, -1, 1); out.right = n(c.right, -1, 1);
  out.yaw = n(c.yaw, -10, 10); out.pitch = n(c.pitch, -1.6, 1.6);
  out.aimYaw = n(c.aimYaw, -10, 10); out.aimPitch = n(c.aimPitch, -1.6, 1.6);
  for (const k of ['fire', 'ads', 'sprint', 'walk', 'brake', ...EDGE_KEYS]) out[k] = !!c[k];
  out.slot = Number.isInteger(c.slot) && c.slot >= -1 && c.slot <= 4 ? c.slot : -1;
  out.cycle = c.cycle === 1 || c.cycle === -1 ? c.cycle : 0;
  out.use = typeof c.use === 'string' ? c.use.slice(0, 16) : null;
  out.throwType = typeof c.throwType === 'string' ? c.throwType.slice(0, 16) : null;
  return out;
}
