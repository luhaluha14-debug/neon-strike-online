import { MP_PATH, MP_PROTOCOL, MP_SERVICE, type ClientMessage, type MatchPool, type MemberInfo, type MpError, type PartyInfo, type Platform, type RoomInfo, type RoomMode, type RoomSummary, type ServerMessage } from './Protocol';

// The browser's connection to the multiplayer relay: sign in with a name,
// get into a room (quick join, a new room, or a room code), then exchange
// game messages with the room's host. Holds no game logic.

/** Relay address: VITE_MP_URL (a static site pointing at the relay service), else this page's own server. */
export function relayUrl(): string {
  const configured = import.meta.env.VITE_MP_URL as string | undefined;
  if (configured) return configured;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${MP_PATH}`;
}

/** Is a relay answering? (A static host answers with the game page instead: no.) */
export async function relayAvailable(timeoutMs = 4000): Promise<boolean> {
  const http = relayUrl().replace(/^ws/, 'http');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${http}/health`, { signal: ctl.signal, cache: 'no-store' });
    const j = (await r.json().catch(() => null)) as { service?: string } | null;
    return j?.service === MP_SERVICE;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The relay's open rooms (`GET /mp/rooms`). null: no relay answered, or a
 * relay without the list (older version); the caller says so.
 */
export async function listRooms(timeoutMs = 6000): Promise<RoomSummary[] | null> {
  const http = relayUrl().replace(/^ws/, 'http');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${http}/rooms`, { signal: ctl.signal, cache: 'no-store' });
    const j = (await r.json().catch(() => null)) as { service?: string; rooms?: unknown } | null;
    if (j?.service !== MP_SERVICE || !Array.isArray(j.rooms)) return null;
    return j.rooms.filter(
      (x): x is RoomSummary =>
        !!x && typeof x.code === 'string' && (x.mode === 'deathmatch' || x.mode === 'team' || x.mode === 'duel') && typeof x.map === 'string' && Number.isFinite(x.players) && Number.isFinite(x.capacity),
    );
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export class NetError extends Error {
  constructor(readonly code: MpError | 'network' | 'closed') {
    super(code);
  }
}

export interface NetHandlers {
  /** The room changed (members, host, map) or was entered. */
  room?(room: RoomInfo): void;
  joined?(member: MemberInfo): void;
  gone?(id: string): void;
  /** The host changed (the previous one left). */
  host?(id: string): void;
  /** A game message from `from` (the host, or a member when this peer hosts). */
  message?(from: string, data: unknown): void;
  /** The connection ended (not by leave()). */
  closed?(): void;
}

export class NetSession {
  id: string | null = null;
  name = '';
  room: RoomInfo | null = null;
  /** The platform this session told the relay (Phase 28): the controls in use when it connected / last changed outside a room. */
  platform: Platform = 'pc';
  /** The party this player is in (null: none). */
  party: PartyInfo | null = null;
  /** Round trip to the relay (ms; Phase 28 network status), null until measured. */
  rtt: number | null = null;
  private pingAt = 0;
  handlers: NetHandlers = {};
  /** The party changed (formed, someone joined / left, a new leader, or no party any more). */
  onParty: ((party: PartyInfo | null) => void) | null = null;
  /**
   * The party leader took this player into a room it did not ask for (a new room, or another one than it is
   * in): the caller starts (or restarts) the online match there.
   */
  onPulled: ((room: RoomInfo) => void) | null = null;
  private ws: WebSocket | null = null;
  private pending: { want: ServerMessage['t'][]; resolve: (m: ServerMessage) => void; reject: (e: NetError) => void } | null = null;
  private closing = false;

  get connected(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN && !!this.id;
  }

  get isHost(): boolean {
    return !!this.room && this.room.hostId === this.id;
  }

  /** Opens the connection and signs in with `name`. The free relay may take up to a minute to wake up. */
  async connect(name: string, url = relayUrl(), timeoutMs = 75_000, platform: Platform = this.platform): Promise<void> {
    if (this.connected) return;
    this.platform = platform;
    this.closing = false;
    const ws = new WebSocket(url);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.close();
        reject(new NetError('network'));
      }, timeoutMs);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new NetError('network'));
      };
    });
    ws.onmessage = (e) => this.receive(e.data);
    ws.onclose = () => this.onClose();
    ws.onerror = null;
    const welcome = await this.request({ t: 'hello', v: MP_PROTOCOL, name, platform: this.platform }, ['welcome']);
    this.id = (welcome as Extract<ServerMessage, { t: 'welcome' }>).id;
    this.name = name;
  }

  /** `bots`: for the room this creates when no open one is found (an existing room keeps its own setting). */
  quick(mode: RoomMode, map: string, bots = true, pool: MatchPool = 'mixed'): Promise<RoomInfo> {
    return this.enter({ t: 'quick', mode, map, bots, pool });
  }

  create(mode: RoomMode, map: string, bots = true, pool: MatchPool = 'mixed'): Promise<RoomInfo> {
    return this.enter({ t: 'create', mode, map, bots, pool });
  }

  /**
   * The controls changed: the relay hears it outside a room (a room keeps the platform each player entered
   * with; the change counts from the next room). Returns whether it was sent.
   */
  setPlatform(p: Platform): boolean {
    if (p === this.platform || this.room) return false;
    this.platform = p;
    this.raw({ t: 'platform', platform: p });
    return true;
  }

  async createParty(): Promise<PartyInfo> {
    const m = (await this.request({ t: 'party_create' }, ['party'])) as Extract<ServerMessage, { t: 'party' }>;
    return m.party!;
  }

  async joinParty(code: string): Promise<PartyInfo> {
    const m = (await this.request({ t: 'party_join', code }, ['party'])) as Extract<ServerMessage, { t: 'party' }>;
    return m.party!;
  }

  leaveParty(): void {
    if (!this.party) return;
    this.raw({ t: 'party_leave' });
  }

  join(code: string): Promise<RoomInfo> {
    return this.enter({ t: 'join', code });
  }

  /** Host: the room now plays `map`. */
  setMap(map: string): void {
    this.raw({ t: 'map', map });
  }

  /** Host (deathmatch / team rooms): empty places played by bots or not. The relay answers with the room. */
  setBots(bots: boolean): void {
    this.raw({ t: 'bots', bots });
  }

  /** Leaves the room (stays connected). */
  leave(): void {
    if (!this.room) return;
    this.room = null;
    this.raw({ t: 'leave' });
  }

  /** Measures the round trip to the relay (answered by a pong); at most one in flight, every couple of seconds. */
  ping(now = performance.now()): void {
    if (!this.connected || now - this.pingAt < 2000) return;
    this.pingAt = now;
    this.raw({ t: 'ping', n: now });
  }

  /** Game message: to the host (members), or to `to` / everyone (host). */
  send(data: unknown, to?: string): void {
    if (!this.room) return;
    this.raw(to ? { t: 'relay', to, d: data } : { t: 'relay', d: data });
  }

  close(): void {
    this.closing = true;
    this.room = null;
    this.party = null;
    this.id = null;
    this.ws?.close();
    this.ws = null;
  }

  private async enter(m: ClientMessage): Promise<RoomInfo> {
    const r = (await this.request(m, ['room'])) as Extract<ServerMessage, { t: 'room' }>;
    this.room = r.room;
    return r.room;
  }

  private request(m: ClientMessage, want: ServerMessage['t'][], timeoutMs = 15_000): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new NetError('network'));
      }, timeoutMs);
      this.pending = {
        want,
        resolve: (x) => {
          clearTimeout(timer);
          resolve(x);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      this.raw(m);
    });
  }

  private raw(m: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private receive(raw: unknown): void {
    let m: ServerMessage;
    try {
      m = JSON.parse(String(raw)) as ServerMessage;
    } catch {
      return;
    }
    const p = this.pending;
    let answer = false;
    if (p && (p.want.includes(m.t) || m.t === 'error')) {
      this.pending = null;
      answer = true;
      if (m.t === 'error') p.reject(new NetError(m.error));
      else p.resolve(m);
      if (m.t !== 'room' && m.t !== 'party') return;
    }
    switch (m.t) {
      case 'room': {
        const before = this.room;
        this.room = m.room;
        // Not asked for, and a room this player was not in: its party leader took it there.
        if (!answer && (!before || before.code !== m.room.code)) {
          this.onPulled?.(m.room);
          break;
        }
        this.handlers.room?.(m.room);
        break;
      }
      case 'party':
        this.party = m.party;
        this.onParty?.(m.party);
        break;
      case 'joined':
        if (this.room && !this.room.members.some((x) => x.id === m.member.id)) this.room.members.push(m.member);
        this.handlers.joined?.(m.member);
        break;
      case 'gone':
        if (this.room) this.room.members = this.room.members.filter((x) => x.id !== m.id);
        this.handlers.gone?.(m.id);
        break;
      case 'host':
        if (this.room) this.room.hostId = m.id;
        this.handlers.host?.(m.id);
        break;
      case 'relay':
        this.handlers.message?.(m.from, m.d);
        break;
      case 'pong': {
        const rtt = performance.now() - m.n;
        // A little smoothing: one slow answer does not make the line jump.
        if (rtt >= 0 && rtt < 60_000) this.rtt = this.rtt === null ? rtt : this.rtt * 0.6 + rtt * 0.4;
        break;
      }
      case 'error':
        console.warn('[mp] relay error', m.error);
        break;
      default:
        break;
    }
  }

  private onClose(): void {
    const unexpected = !this.closing;
    this.ws = null;
    this.id = null;
    this.room = null;
    this.party = null;
    this.onParty?.(null);
    this.pending?.reject(new NetError('closed'));
    this.pending = null;
    if (unexpected) this.handlers.closed?.();
  }
}
