/* =============================================================================
   the hub: one websocket connection per player, a registry of rooms, and the
   matchmaking in front of them (quick match, create, join by code).
   ========================================================================== */
import { Room } from './room.js';
import { MODE_LIST, MAP_LIST, CHARACTER_LIST } from './shared.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no look-alike glyphs
const MSG_PER_SECOND = 220;

export class Hub {
  constructor() {
    this.rooms = new Map();
    this.clients = new Set();
    this.nextId = 1;
  }

  connect(ws) {
    const c = {
      id: this.nextId++, ws, name: 'PLAYER', room: null,
      msgCount: 0, msgWindow: Date.now()
    };
    c.send = (obj) => {
      if (ws.readyState !== 1) return;
      try { ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); }
      catch (e) { /* socket closing */ }
    };
    this.clients.add(c);
    c.send({ t: 'welcome', id: c.id });
    return c;
  }

  disconnect(c) {
    this.leave(c);
    this.clients.delete(c);
  }

  receive(c, data) {
    const t = Date.now();
    if (t - c.msgWindow > 1000) { c.msgWindow = t; c.msgCount = 0; }
    if (++c.msgCount > MSG_PER_SECOND) return;
    let m;
    try { m = JSON.parse(data); } catch (e) { return; }
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
    try { this.handle(c, m); } catch (e) { console.error('message error', m.t, e); }
  }

  handle(c, m) {
    switch (m.t) {
      case 'hello':
        if (!c.room) c.name = cleanName(m.name);
        break;
      case 'ping':
        c.send({ t: 'pong', c: m.c, s: Date.now() });
        break;
      case 'rooms':
        c.send({ t: 'rooms', list: this.publicRooms() });
        break;
      case 'create': {
        this.leave(c);
        const mode = MODE_LIST.includes(m.mode) ? m.mode : 'tdm';
        const map = MAP_LIST.includes(m.map) || m.map === 'random' ? m.map : 'shrine';
        const room = this.newRoom(false, mode, map);
        this.join(c, room, m.ch, m.cm);
        break;
      }
      case 'join': {
        const room = this.rooms.get(String(m.code || '').toUpperCase().trim());
        if (!room) return c.send({ t: 'err', m: '그런 방이 없습니다' });
        if (room.isFull()) return c.send({ t: 'err', m: '방이 가득 찼습니다' });
        if (c.room === room) return;
        this.leave(c);
        this.join(c, room, m.ch, m.cm);
        break;
      }
      case 'quick': {
        this.leave(c);
        let best = null;
        for (const r of this.rooms.values()) {
          if (!r.isPublic || r.isFull()) continue;
          if (m.mode && r.mode !== m.mode) continue;
          if (!best || r.humans().length > best.humans().length) best = r;
        }
        const room = best || this.newRoom(true, MODE_LIST.includes(m.mode) ? m.mode : 'tdm', 'random');
        this.join(c, room, m.ch, m.cm);
        break;
      }
      case 'leave':
        this.leave(c);
        c.send({ t: 'left-room' });
        break;
      default:
        if (c.room) c.room.onMessage(c, m);
    }
  }

  newRoom(isPublic, mode, map) {
    const code = this.makeCode();
    // a public room keeps itself playable with bots; a private one waits for
    // the friends it was made for, and the host can switch that on
    const room = new Room(code, isPublic, mode, map, () => this.rooms.delete(code),
      { fillBots: isPublic });
    this.rooms.set(code, room);
    return room;
  }

  makeCode() {
    let code;
    do {
      code = '';
      for (let i = 0; i < 4; i++) code += CODE_ALPHABET[(Math.random() * CODE_ALPHABET.length) | 0];
    } while (this.rooms.has(code));
    return code;
  }

  join(c, room, character, charm) {
    c.room = room;
    room.addPlayer(c, CHARACTER_LIST.includes(character) ? character : 'rift', charm);
  }

  leave(c) {
    const room = c.room;
    if (!room) return;
    c.room = null;
    room.removePlayer(c.id);
  }

  publicRooms() {
    const out = [];
    for (const r of this.rooms.values()) {
      if (!r.isPublic) continue;
      out.push(r.summary());
    }
    return out.sort((a, b) => b.n - a.n).slice(0, 12);
  }

  tick() {
    for (const r of this.rooms.values()) {
      try { r.tick(); } catch (e) { console.error('room tick error', r.code, e); }
    }
  }
}

function cleanName(s) {
  const n = String(s || '')
    .replace(/[^0-9A-Za-z가-힣ㄱ-ㅎㅏ-ㅣ_\- ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 12);
  return n || 'PLAYER';
}
