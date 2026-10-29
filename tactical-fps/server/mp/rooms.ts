import { randomInt } from 'node:crypto';
import { CODE_ALPHABET, CODE_LENGTH, MP_PROTOCOL, ROOM_CAPACITY, cleanName, validCode, type ClientMessage, type MemberInfo, type RoomInfo, type RoomMode, type RoomSummary, type ServerMessage } from '../../src/net/Protocol';

// Rooms of the multiplayer relay, without sockets (so it can be tested
// directly): who is connected, who is in which room, who hosts it, and where
// each message goes. The relay never reads game payloads: it only checks
// the sender may reach the receiver (members reach their host; the host
// reaches one member or all) and stamps the sender's id.

export const MAX_CLIENTS = 200;
export const MAX_ROOMS = 60;

interface Client {
  id: string;
  name: string | null;
  room: Room | null;
}

interface Room {
  code: string;
  mode: RoomMode;
  map: string;
  hostId: string;
  /** In join order (the next host is the longest-standing member). */
  members: Client[];
}

export type Outbox = { to: string; msg: ServerMessage }[];

const MAP_ID = /^[a-z0-9_-]{1,32}$/;
const MODES: readonly RoomMode[] = ['deathmatch', 'team'];

export class Rooms {
  private readonly clients = new Map<string, Client>();
  private readonly rooms = new Map<string, Room>();
  private seq = 0;

  constructor(private readonly code: () => string = randomCode) {}

  get clientCount(): number {
    return this.clients.size;
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  /** A new connection; null when the server is full. */
  connect(): string | null {
    if (this.clients.size >= MAX_CLIENTS) return null;
    const id = `p${(++this.seq).toString(36)}`;
    this.clients.set(id, { id, name: null, room: null });
    return id;
  }

  disconnect(id: string): Outbox {
    const c = this.clients.get(id);
    if (!c) return [];
    const out = this.leave(c);
    this.clients.delete(id);
    return out;
  }

  handle(id: string, m: ClientMessage): Outbox {
    const c = this.clients.get(id);
    if (!c || !m || typeof m !== 'object') return [];
    const err = (error: Parameters<typeof errorTo>[1]): Outbox => [errorTo(id, error)];
    switch (m.t) {
      case 'hello': {
        if (m.v !== MP_PROTOCOL) return err('version');
        const name = cleanName(m.name);
        if (!name) return err('name');
        c.name = name;
        return [{ to: id, msg: { t: 'welcome', id } }];
      }
      case 'ping':
        return typeof m.n === 'number' ? [{ to: id, msg: { t: 'pong', n: m.n } }] : [];
      case 'quick':
      case 'create': {
        if (!c.name) return err('name');
        if (!MODES.includes(m.mode) || typeof m.map !== 'string' || !MAP_ID.test(m.map)) return err('bad_request');
        const out = this.leave(c);
        let room = m.t === 'quick' ? [...this.rooms.values()].find((r) => r.mode === m.mode && r.members.length < ROOM_CAPACITY[r.mode]) : undefined;
        if (!room) {
          if (this.rooms.size >= MAX_ROOMS) return [...out, errorTo(id, 'server_full')];
          room = { code: this.newCode(), mode: m.mode, map: m.map, hostId: id, members: [] };
          this.rooms.set(room.code, room);
        }
        return [...out, ...this.enter(c, room)];
      }
      case 'join': {
        if (!c.name) return err('name');
        const code = validCode(m.code);
        const room = code ? this.rooms.get(code) : undefined;
        if (!room) return err('not_found');
        if (c.room === room) return [{ to: id, msg: { t: 'room', room: info(room) } }];
        if (room.members.length >= ROOM_CAPACITY[room.mode]) return err('full');
        return [...this.leave(c), ...this.enter(c, room)];
      }
      case 'leave':
        return [...this.leave(c), { to: id, msg: { t: 'left' } }];
      case 'map': {
        const room = c.room;
        if (!room) return err('no_room');
        if (room.hostId !== id) return err('not_host');
        if (typeof m.map !== 'string' || !MAP_ID.test(m.map)) return err('bad_request');
        room.map = m.map;
        return room.members.map((x) => ({ to: x.id, msg: { t: 'room', room: info(room) } }));
      }
      case 'relay': {
        const room = c.room;
        if (!room) return err('no_room');
        const msg: ServerMessage = { t: 'relay', from: id, d: m.d };
        if (room.hostId !== id) return [{ to: room.hostId, msg }];
        if (typeof m.to === 'string') return room.members.some((x) => x.id === m.to && x.id !== id) ? [{ to: m.to, msg }] : [];
        return room.members.filter((x) => x.id !== id).map((x) => ({ to: x.id, msg }));
      }
      default:
        return err('bad_request');
    }
  }

  /** Rooms for the public list: open rooms first, then fuller ones (counts only, no names). */
  list(): RoomSummary[] {
    return [...this.rooms.values()]
      .map((r) => ({ code: r.code, mode: r.mode, map: r.map, players: r.members.length, capacity: ROOM_CAPACITY[r.mode] }))
      .sort((a, b) => Number(a.players >= a.capacity) - Number(b.players >= b.capacity) || b.players - a.players);
  }

  /** The room `id` is in (tests / health). */
  roomOf(id: string): RoomInfo | null {
    const r = this.clients.get(id)?.room;
    return r ? info(r) : null;
  }

  private enter(c: Client, room: Room): Outbox {
    room.members.push(c);
    c.room = room;
    const member: MemberInfo = { id: c.id, name: c.name ?? '' };
    return [
      { to: c.id, msg: { t: 'room', room: info(room) } },
      ...room.members.filter((x) => x !== c).map((x) => ({ to: x.id, msg: { t: 'joined', member } as ServerMessage })),
    ];
  }

  private leave(c: Client): Outbox {
    const room = c.room;
    if (!room) return [];
    c.room = null;
    room.members = room.members.filter((x) => x !== c);
    if (room.members.length === 0) {
      this.rooms.delete(room.code);
      return [];
    }
    const out: Outbox = room.members.map((x) => ({ to: x.id, msg: { t: 'gone', id: c.id } }));
    if (room.hostId === c.id) {
      room.hostId = room.members[0].id;
      for (const x of room.members) out.push({ to: x.id, msg: { t: 'host', id: room.hostId } });
    }
    return out;
  }

  private newCode(): string {
    for (;;) {
      const c = this.code();
      if (!this.rooms.has(c)) return c;
    }
  }
}

function info(r: Room): RoomInfo {
  return { code: r.code, mode: r.mode, map: r.map, hostId: r.hostId, members: r.members.map((m) => ({ id: m.id, name: m.name ?? '' })), capacity: ROOM_CAPACITY[r.mode] };
}

function errorTo(to: string, error: Extract<ServerMessage, { t: 'error' }>['error']): Outbox[number] {
  return { to, msg: { t: 'error', error } };
}

function randomCode(): string {
  let s = '';
  for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}
