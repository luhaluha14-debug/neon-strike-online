// Multiplayer wire format shared by the relay server (server/mp) and the
// game client (src/net). The relay only manages rooms and forwards `relay`
// payloads; the game itself runs in the room host's browser (host
// authority), and every other peer sends its moves and shots to the host.

/** Bumped when the messages change: peers on another version cannot share a room. */
export const MP_PROTOCOL = 1;
export const MP_PATH = '/mp';
export const MP_SERVICE = 'grid-mp';

/** 'duel': 1대1, two players only (no bots fight). */
export type RoomMode = 'deathmatch' | 'team' | 'duel';

/** Humans per room (bots fill the rest of the match, when the room allows bots). */
export const ROOM_CAPACITY: Record<RoomMode, number> = { deathmatch: 8, team: 10, duel: 2 };

/**
 * Does a room of `mode` fill its empty places with bots? Chosen by the host for deathmatch and team rooms
 * (default: yes; `requested` absent = an older client = yes). 1대1 never has bots, whatever is asked.
 */
export function roomBots(mode: RoomMode, requested: boolean | undefined): boolean {
  return mode !== 'duel' && requested !== false;
}

/**
 * Phase 28 crossplay. The platform a player plays on is the controls it uses (keyboard + mouse = 'pc',
 * touch = 'mobile'); the client says which, the relay accepts only these values. A room's pool says who
 * may be in it: everyone ('mixed', the default), PC players only, or mobile players only.
 */
export type Platform = 'pc' | 'mobile';
export const PLATFORMS: readonly Platform[] = ['pc', 'mobile'];
export type MatchPool = 'mixed' | 'pc' | 'mobile';
export const POOLS: readonly MatchPool[] = ['mixed', 'pc', 'mobile'];
/** Players per party (one team of a 5대5). */
export const PARTY_MAX = 5;
/** Party codes are one character longer than room codes (never mistaken for one). */
export const PARTY_CODE_LENGTH = 6;

/** May a player on `platform` be in a room of `pool`? */
export function poolAllows(pool: MatchPool, platform: Platform): boolean {
  return pool === 'mixed' || pool === platform;
}

/**
 * The pool a group (a party, or one player) gets into for `requested`: a group of PC and mobile players
 * always plays in the mixed pool; otherwise the requested pool, if it allows the group's platform (null: not).
 */
export function groupPool(requested: MatchPool, platforms: readonly Platform[]): MatchPool | null {
  if (new Set(platforms).size > 1) return 'mixed';
  return platforms.every((p) => poolAllows(requested, p)) ? requested : null;
}

export const NAME_MAX = 16;
/** Room codes: 5 characters without look-alikes (0/O, 1/I/L). */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 5;
/** Largest message accepted by the relay (bytes). */
export const MAX_MESSAGE = 32 * 1024;

export interface MemberInfo {
  id: string;
  name: string;
  /** Phase 28 (absent from an older relay: unknown). */
  platform?: Platform;
}

/** A party: players who enter rooms together (the leader picks the room). */
export interface PartyInfo {
  code: string;
  leaderId: string;
  members: MemberInfo[];
}

export interface RoomInfo {
  code: string;
  mode: RoomMode;
  map: string;
  hostId: string;
  members: MemberInfo[];
  capacity: number;
  /**
   * Empty places are played by bots (the relay keeps it; only the host changes it). Always false for 1대1.
   * Absent from an older relay: bots, as before.
   */
  bots?: boolean;
  /** Who may be in it (Phase 28; absent from an older relay: everyone). */
  pool?: MatchPool;
}

/** A room in the public list (`GET /mp/rooms`): counts only, no player names. */
export interface RoomSummary {
  code: string;
  mode: RoomMode;
  map: string;
  players: number;
  capacity: number;
  bots?: boolean;
  pool?: MatchPool;
}

/** Client → relay. */
export type ClientMessage =
  /** `platform`: absent = 'pc' (an older client: keyboard and mouse). */
  | { t: 'hello'; v: number; name: string; platform?: Platform }
  /**
   * `bots`: for a room this creates (an existing room keeps its own); absent = bots. `pool`: the matching
   * pool, absent = 'mixed'. In a party only the leader may send these and `join`: the whole party goes.
   */
  | { t: 'quick'; mode: RoomMode; map: string; bots?: boolean; pool?: MatchPool }
  | { t: 'create'; mode: RoomMode; map: string; bots?: boolean; pool?: MatchPool }
  /** The controls changed (outside a room only: a room keeps the platform each player entered with). */
  | { t: 'platform'; platform: Platform }
  | { t: 'party_create' }
  | { t: 'party_join'; code: string }
  | { t: 'party_leave' }
  | { t: 'join'; code: string }
  | { t: 'leave' }
  /** Host only: the map the room plays now (after a map change). */
  | { t: 'map'; map: string }
  /** Host only, deathmatch / team rooms: empty places played by bots or not. */
  | { t: 'bots'; bots: boolean }
  /** Game payload. Non-hosts can only reach the host; the host reaches one member or all. */
  | { t: 'relay'; to?: string; d: unknown }
  | { t: 'ping'; n: number };

export type MpError = 'version' | 'name' | 'full' | 'not_found' | 'bad_request' | 'rate' | 'server_full' | 'not_host' | 'no_room' | 'platform' | 'party_leader' | 'party_not_found' | 'party_full';

/** Relay → client. */
export type ServerMessage =
  | { t: 'welcome'; id: string }
  | { t: 'room'; room: RoomInfo }
  | { t: 'left' }
  | { t: 'joined'; member: MemberInfo }
  | { t: 'gone'; id: string }
  /** The previous host left: `id` hosts from now on (the match starts over). */
  | { t: 'host'; id: string }
  | { t: 'relay'; from: string; d: unknown }
  /** The party this player is in now (null: none: left, or never in one). */
  | { t: 'party'; party: PartyInfo | null }
  | { t: 'error'; error: MpError }
  | { t: 'pong'; n: number };

/** Trimmed, control characters removed, at most NAME_MAX characters; null if nothing is left. */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/[\u0000-\u001f\u007f<>&"']/g, '').trim().slice(0, NAME_MAX);
  return s.length ? s : null;
}

export function validCode(raw: unknown, length = CODE_LENGTH): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toUpperCase();
  if (s.length !== length || [...s].some((c) => !CODE_ALPHABET.includes(c))) return null;
  return s;
}

export function validPartyCode(raw: unknown): string | null {
  return validCode(raw, PARTY_CODE_LENGTH);
}

export const PLATFORM_LABEL: Record<Platform, string> = { pc: 'PC', mobile: '모바일' };
export const POOL_LABEL: Record<MatchPool, string> = { mixed: '통합 (PC + 모바일)', pc: 'PC 전용', mobile: '모바일 전용' };

export function mpErrorMessage(e: MpError | 'network' | 'closed'): string {
  switch (e) {
    case 'version':
      return '게임 버전이 다릅니다. 새로고침(Ctrl+Shift+R) 후 다시 시도하세요.';
    case 'name':
      return '닉네임을 입력하세요 (1–16자).';
    case 'full':
      return '방이 가득 찼습니다.';
    case 'not_found':
      return '그 코드의 방이 없습니다. 모두 나가 방이 사라졌거나(만료) 코드가 틀렸습니다.';
    case 'bad_request':
      return '잘못된 요청입니다.';
    case 'rate':
      return '요청이 너무 많습니다. 잠시 후 다시 시도하세요.';
    case 'server_full':
      return '서버가 가득 찼습니다. 잠시 후 다시 시도하세요.';
    case 'not_host':
      return '방장만 할 수 있습니다.';
    case 'no_room':
      return '방에 들어가 있지 않습니다.';
    case 'platform':
      return '이 매칭에 참가할 수 없는 플랫폼입니다 (PC 전용 / 모바일 전용 방, 또는 방 안에서 조작 방식 변경).';
    case 'party_leader':
      return '파티에서는 파티장만 방을 고를 수 있습니다.';
    case 'party_not_found':
      return '그 코드의 파티가 없습니다.';
    case 'party_full':
      return `파티가 가득 찼습니다 (최대 ${PARTY_MAX}명).`;
    case 'network':
      return '멀티플레이 서버에 연결하지 못했습니다. (무료 서버는 처음 접속할 때 깨어나는 데 1분 정도 걸릴 수 있습니다.)';
    case 'closed':
      return '멀티플레이 서버와 연결이 끊겼습니다.';
  }
}
