import { MP_PATH, MP_PROTOCOL, MP_SERVICE, type ClientMessage, type MemberInfo, type MpError, type RoomInfo, type RoomMode, type RoomSummary, type ServerMessage } from './Protocol';

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
        !!x && typeof x.code === 'string' && (x.mode === 'deathmatch' || x.mode === 'team') && typeof x.map === 'string' && Number.isFinite(x.players) && Number.isFinite(x.capacity),
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
  handlers: NetHandlers = {};
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
  async connect(name: string, url = relayUrl(), timeoutMs = 75_000): Promise<void> {
    if (this.connected) return;
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
    const welcome = await this.request({ t: 'hello', v: MP_PROTOCOL, name }, ['welcome']);
    this.id = (welcome as Extract<ServerMessage, { t: 'welcome' }>).id;
    this.name = name;
  }

  quick(mode: RoomMode, map: string): Promise<RoomInfo> {
    return this.enter({ t: 'quick', mode, map });
  }

  create(mode: RoomMode, map: string): Promise<RoomInfo> {
    return this.enter({ t: 'create', mode, map });
  }

  join(code: string): Promise<RoomInfo> {
    return this.enter({ t: 'join', code });
  }

  /** Host: the room now plays `map`. */
  setMap(map: string): void {
    this.raw({ t: 'map', map });
  }

  /** Leaves the room (stays connected). */
  leave(): void {
    if (!this.room) return;
    this.room = null;
    this.raw({ t: 'leave' });
  }

  /** Game message: to the host (members), or to `to` / everyone (host). */
  send(data: unknown, to?: string): void {
    if (!this.room) return;
    this.raw(to ? { t: 'relay', to, d: data } : { t: 'relay', d: data });
  }

  close(): void {
    this.closing = true;
    this.room = null;
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
    if (p && (p.want.includes(m.t) || m.t === 'error')) {
      this.pending = null;
      if (m.t === 'error') p.reject(new NetError(m.error));
      else p.resolve(m);
      if (m.t !== 'room') return;
    }
    switch (m.t) {
      case 'room':
        this.room = m.room;
        this.handlers.room?.(m.room);
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
    this.pending?.reject(new NetError('closed'));
    this.pending = null;
    if (unexpected) this.handlers.closed?.();
  }
}
