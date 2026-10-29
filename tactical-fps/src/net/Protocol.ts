// Multiplayer wire format shared by the relay server (server/mp) and the
// game client (src/net). The relay only manages rooms and forwards `relay`
// payloads; the game itself runs in the room host's browser (host
// authority), and every other peer sends its moves and shots to the host.

/** Bumped when the messages change: peers on another version cannot share a room. */
export const MP_PROTOCOL = 1;
export const MP_PATH = '/mp';
export const MP_SERVICE = 'grid-mp';

export type RoomMode = 'deathmatch' | 'team';

/** Humans per room (bots fill the rest of the match). */
export const ROOM_CAPACITY: Record<RoomMode, number> = { deathmatch: 8, team: 10 };

export const NAME_MAX = 16;
/** Room codes: 5 characters without look-alikes (0/O, 1/I/L). */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 5;
/** Largest message accepted by the relay (bytes). */
export const MAX_MESSAGE = 32 * 1024;

export interface MemberInfo {
  id: string;
  name: string;
}

export interface RoomInfo {
  code: string;
  mode: RoomMode;
  map: string;
  hostId: string;
  members: MemberInfo[];
  capacity: number;
}

/** A room in the public list (`GET /mp/rooms`): counts only, no player names. */
export interface RoomSummary {
  code: string;
  mode: RoomMode;
  map: string;
  players: number;
  capacity: number;
}

/** Client → relay. */
export type ClientMessage =
  | { t: 'hello'; v: number; name: string }
  | { t: 'quick'; mode: RoomMode; map: string }
  | { t: 'create'; mode: RoomMode; map: string }
  | { t: 'join'; code: string }
  | { t: 'leave' }
  /** Host only: the map the room plays now (after a map change). */
  | { t: 'map'; map: string }
  /** Game payload. Non-hosts can only reach the host; the host reaches one member or all. */
  | { t: 'relay'; to?: string; d: unknown }
  | { t: 'ping'; n: number };

export type MpError = 'version' | 'name' | 'full' | 'not_found' | 'bad_request' | 'rate' | 'server_full' | 'not_host' | 'no_room';

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
  | { t: 'error'; error: MpError }
  | { t: 'pong'; n: number };

/** Trimmed, control characters removed, at most NAME_MAX characters; null if nothing is left. */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/[\u0000-\u001f\u007f<>&"']/g, '').trim().slice(0, NAME_MAX);
  return s.length ? s : null;
}

export function validCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toUpperCase();
  if (s.length !== CODE_LENGTH || [...s].some((c) => !CODE_ALPHABET.includes(c))) return null;
  return s;
}

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
    case 'network':
      return '멀티플레이 서버에 연결하지 못했습니다. (무료 서버는 처음 접속할 때 깨어나는 데 1분 정도 걸릴 수 있습니다.)';
    case 'closed':
      return '멀티플레이 서버와 연결이 끊겼습니다.';
  }
}
