import { randomInt } from 'node:crypto';
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  MP_PROTOCOL,
  PARTY_CODE_LENGTH,
  PARTY_MAX,
  PLATFORMS,
  POOLS,
  ROOM_CAPACITY,
  cleanName,
  groupPool,
  poolAllows,
  roomBots,
  validCode,
  validPartyCode,
  type ClientMessage,
  type MatchPool,
  type MemberInfo,
  type PartyInfo,
  type Platform,
  type RoomInfo,
  type RoomMode,
  type RoomSummary,
  type ServerMessage,
} from '../../src/net/Protocol';

// Rooms of the multiplayer relay, without sockets (so it can be tested
// directly): who is connected, who is in which room, who hosts it, and where
// each message goes. The relay never reads game payloads: it only checks
// the sender may reach the receiver (members reach their host; the host
// reaches one member or all) and stamps the sender's id.
//
// Phase 28 crossplay: each player says its platform (the controls it uses; only 'pc' / 'mobile' are
// accepted), each room has a pool (mixed, PC only, mobile only) checked on every way in (quick join,
// a new room, a code, a party), and parties go into rooms together, the leader choosing: a party of PC
// and mobile players always plays in the mixed pool. The match itself is still run by the room's host
// browser; none of this changes who hosts, rejoining or the host hand-over.

export const MAX_CLIENTS = 200;
export const MAX_ROOMS = 60;
export const MAX_PARTIES = 100;

interface Client {
  id: string;
  name: string | null;
  room: Room | null;
  platform: Platform;
  party: Party | null;
}

interface Party {
  code: string;
  leaderId: string;
  members: Client[];
}

interface Room {
  code: string;
  mode: RoomMode;
  map: string;
  hostId: string;
  /** Empty places are played by bots (deathmatch / team, the host's choice; never in 1대1). */
  bots: boolean;
  pool: MatchPool;
  /** In join order (the next host is the longest-standing member). */
  members: Client[];
}

export type Outbox = { to: string; msg: ServerMessage }[];

const MAP_ID = /^[a-z0-9_-]{1,32}$/;
const MODES: readonly RoomMode[] = ['deathmatch', 'team', 'duel'];

export class Rooms {
  private readonly clients = new Map<string, Client>();
  private readonly rooms = new Map<string, Room>();
  private readonly parties = new Map<string, Party>();
  private seq = 0;

  constructor(
    private readonly code: () => string = randomCode,
    private readonly partyCode: () => string = () => randomCode(PARTY_CODE_LENGTH),
  ) {}

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
    this.clients.set(id, { id, name: null, room: null, platform: 'pc', party: null });
    return id;
  }

  disconnect(id: string): Outbox {
    const c = this.clients.get(id);
    if (!c) return [];
    const out = [...this.leave(c), ...this.leaveParty(c)];
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
        // Only the platforms there are (absent: an older client, keyboard and mouse).
        if (m.platform !== undefined && !PLATFORMS.includes(m.platform)) return err('platform');
        c.name = name;
        c.platform = m.platform ?? 'pc';
        return [{ to: id, msg: { t: 'welcome', id } }];
      }
      case 'ping':
        return typeof m.n === 'number' ? [{ to: id, msg: { t: 'pong', n: m.n } }] : [];
      case 'quick':
      case 'create': {
        if (!c.name) return err('name');
        if (!MODES.includes(m.mode) || typeof m.map !== 'string' || !MAP_ID.test(m.map)) return err('bad_request');
        if (m.bots !== undefined && typeof m.bots !== 'boolean') return err('bad_request');
        if (m.pool !== undefined && !POOLS.includes(m.pool)) return err('bad_request');
        if (c.party && c.party.leaderId !== id) return err('party_leader');
        const group = this.groupOf(c);
        const pool = groupPool(m.pool ?? 'mixed', group.map((x) => x.platform));
        if (!pool) return err('platform');
        if (group.length > ROOM_CAPACITY[m.mode]) return err('full');
        // An open room of the mode and the pool with a place for the whole group (not the one it is in).
        let room =
          m.t === 'quick'
            ? [...this.rooms.values()].find((r) => r.mode === m.mode && r.pool === pool && r !== c.room && r.members.length + group.length <= ROOM_CAPACITY[r.mode])
            : undefined;
        if (!room) {
          if (this.rooms.size >= MAX_ROOMS) return err('server_full');
          room = { code: this.newCode(), mode: m.mode, map: m.map, hostId: id, bots: roomBots(m.mode, m.bots), pool, members: [] };
          this.rooms.set(room.code, room);
        }
        return this.enterGroup(group, room);
      }
      case 'join': {
        if (!c.name) return err('name');
        if (c.party && c.party.leaderId !== id) return err('party_leader');
        const code = validCode(m.code);
        const room = code ? this.rooms.get(code) : undefined;
        if (!room) return err('not_found');
        const group = this.groupOf(c);
        if (c.room === room && group.every((x) => x.room === room)) return [{ to: id, msg: { t: 'room', room: info(room) } }];
        // The room's pool holds for every way in: a code too.
        if (!group.every((x) => poolAllows(room.pool, x.platform))) return err('platform');
        if (room.members.length + group.filter((x) => x.room !== room).length > ROOM_CAPACITY[room.mode]) return err('full');
        return this.enterGroup(group, room);
      }
      case 'platform': {
        if (!c.name) return err('name');
        if (!PLATFORMS.includes(m.platform)) return err('platform');
        // In a room the platform it was entered with stays (a PC only room cannot get a touch player).
        if (c.room) return c.platform === m.platform ? [] : err('platform');
        c.platform = m.platform;
        return c.party ? this.partyNews(c.party) : [];
      }
      case 'party_create': {
        if (!c.name) return err('name');
        if (this.parties.size >= MAX_PARTIES) return err('server_full');
        const out = this.leaveParty(c);
        const party: Party = { code: this.newPartyCode(), leaderId: id, members: [c] };
        this.parties.set(party.code, party);
        c.party = party;
        return [...out, ...this.partyNews(party)];
      }
      case 'party_join': {
        if (!c.name) return err('name');
        const code = validPartyCode(m.code);
        const party = code ? this.parties.get(code) : undefined;
        if (!party) return err('party_not_found');
        if (c.party === party) return this.partyNews(party).filter((o) => o.to === id);
        if (party.members.length >= PARTY_MAX) return err('party_full');
        const out = this.leaveParty(c);
        party.members.push(c);
        c.party = party;
        return [...out, ...this.partyNews(party)];
      }
      case 'party_leave':
        return this.leaveParty(c);
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
      case 'bots': {
        const room = c.room;
        if (!room) return err('no_room');
        if (room.hostId !== id) return err('not_host');
        // 1대1 is two players, never bots: there is nothing to choose.
        if (typeof m.bots !== 'boolean' || room.mode === 'duel') return err('bad_request');
        room.bots = m.bots;
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
      .map((r) => ({ code: r.code, mode: r.mode, map: r.map, players: r.members.length, capacity: ROOM_CAPACITY[r.mode], bots: r.bots, pool: r.pool }))
      .sort((a, b) => Number(a.players >= a.capacity) - Number(b.players >= b.capacity) || b.players - a.players);
  }

  /** The room `id` is in (tests / health). */
  roomOf(id: string): RoomInfo | null {
    const r = this.clients.get(id)?.room;
    return r ? info(r) : null;
  }

  /** The party `id` is in (tests). */
  partyOf(id: string): PartyInfo | null {
    const p = this.clients.get(id)?.party;
    return p ? partyInfo(p) : null;
  }

  /** Who goes in with `c`: its party (leader first), or `c` alone. */
  private groupOf(c: Client): Client[] {
    const p = c.party;
    return p ? [c, ...p.members.filter((x) => x !== c)] : [c];
  }

  /** Everyone of `group` into `room` (out of the room each was in first); the first one in a new room hosts it. */
  private enterGroup(group: Client[], room: Room): Outbox {
    const out: Outbox = [];
    for (const x of group) {
      if (x.room === room) {
        out.push({ to: x.id, msg: { t: 'room', room: info(room) } });
        continue;
      }
      out.push(...this.leave(x), ...this.enter(x, room));
    }
    return out;
  }

  /** The party as it is now, to each of its members. */
  private partyNews(p: Party): Outbox {
    const party = partyInfo(p);
    return p.members.map((x) => ({ to: x.id, msg: { t: 'party', party } as ServerMessage }));
  }

  private leaveParty(c: Client): Outbox {
    const p = c.party;
    if (!p) return [];
    c.party = null;
    p.members = p.members.filter((x) => x !== c);
    const out: Outbox = [{ to: c.id, msg: { t: 'party', party: null } }];
    if (p.members.length === 0) {
      this.parties.delete(p.code);
      return out;
    }
    if (p.leaderId === c.id) p.leaderId = p.members[0].id;
    return [...out, ...this.partyNews(p)];
  }

  private newPartyCode(): string {
    for (;;) {
      const c = this.partyCode();
      if (!this.parties.has(c)) return c;
    }
  }

  private enter(c: Client, room: Room): Outbox {
    room.members.push(c);
    c.room = room;
    const member: MemberInfo = { id: c.id, name: c.name ?? '', platform: c.platform };
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
  return {
    code: r.code,
    mode: r.mode,
    map: r.map,
    hostId: r.hostId,
    members: r.members.map((m) => ({ id: m.id, name: m.name ?? '', platform: m.platform })),
    capacity: ROOM_CAPACITY[r.mode],
    bots: r.bots,
    pool: r.pool,
  };
}

function partyInfo(p: Party): PartyInfo {
  return { code: p.code, leaderId: p.leaderId, members: p.members.map((m) => ({ id: m.id, name: m.name ?? '', platform: m.platform })) };
}

function errorTo(to: string, error: Extract<ServerMessage, { t: 'error' }>['error']): Outbox[number] {
  return { to, msg: { t: 'error', error } };
}

function randomCode(length = CODE_LENGTH): string {
  let s = '';
  for (let i = 0; i < length; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}
