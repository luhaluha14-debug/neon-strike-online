import type { GrenadeKind } from '../combat/Grenades';
import type { BombStateMsg, MatchState, TeamMatchState } from './Mirror';

// Game messages inside relay payloads. The host runs the match; members
// (clients) play their own character and report it. Vectors are [x, y, z]
// rounded to centimetres; times are the host's clock in seconds.

export type V3 = [number, number, number];

/** One combatant in a snapshot. */
export type EntityState = [
  id: string,
  x: number,
  y: number,
  z: number,
  yaw: number,
  pitch: number,
  height: number,
  vx: number,
  vz: number,
  /** bit 0 alive, 1 grounded, 2 aiming, 3 crouching */
  flags: number,
  hp: number,
  armor: number,
  /** Seconds dead (death fall). */
  deadTime: number,
  team: string,
];

/** Client → host. */
export type ToHost =
  /** Map loaded, ready to play: the host gives this member a character. */
  | { k: 'hi' }
  /** The member's character, ~30 per second. `sp`: the last spawn it applied (older reports are ignored). */
  | { k: 'st'; sp: number; p: V3; v: V3; yaw: number; pitch: number; h: number; g: 0 | 1; crouch: 0 | 1; aim: 0 | 1; use: 0 | 1; w: string }
  /** One round (pellet) fired: from the eye, along `d`, as the member saw the others at host time `rt`. */
  | { k: 'shot'; w: string; o: V3; d: V3; rt: number }
  | { k: 'buy'; id: string; n: number }
  | { k: 'throw'; kind: GrenadeKind; eye: V3; dir: V3; carry: V3 }
  /** "출격 확정" from a member: ignored (only the host may end the buy time). */
  | { k: 'ready' };

/** Host → clients. */
export type ToClient =
  /** Which character is yours (team match: which team). */
  | { k: 'you'; id: string; team: string | null }
  /** Mode / map of the room's match (a client switches if needed). */
  | { k: 'mode'; mode: 'deathmatch' | 'team'; map: string }
  /** Combatants, ~20 per second. */
  | { k: 'snap'; t: number; e: EntityState[] }
  /** Match / round / bomb state, a few times a second and on changes. */
  | { k: 'match'; t: number; m: MatchState | TeamMatchState; bomb: BombStateMsg | null; who?: [member: string, team: 'blue' | 'red'][] }
  /** Put your character here (spawn, round start, correction). `loadout`: catalog ids of the gear (team match). */
  | { k: 'spawn'; sp: number; p: V3; yaw: number; alive: boolean; hp: number; armor: number; loadout: string[] | null; grenades: { flash: number; smoke: number } | null; round: boolean }
  /** You were hit (direction for the HUD; hp / death follow in snapshots). */
  | { k: 'hurt'; amount: number; d: V3; killed: boolean; by: string; w: string; head: boolean }
  /** A round resolved by the host (tracer, impact, blood, sound). */
  | { k: 'fx'; by: string; w: string; o: V3; e: V3; kind: 'miss' | 'world' | 'target'; n: V3 | null; head: boolean }
  /** Your round hit someone (hit marker). */
  | { k: 'hit'; head: boolean; kill: boolean }
  /** A grenade thrown by someone else (every peer flies its own copy). */
  | { k: 'throw'; by: string; kind: GrenadeKind; eye: V3; dir: V3; carry: V3 }
  | { k: 'buy'; n: number; ok: boolean; message: string; loadout: string[]; grenades: { flash: number; smoke: number }; armor: number }
  /** The C4 went off at `p`. */
  | { k: 'boom'; p: V3 }
  /** A new match starts (restart, mode or map change). */
  | { k: 'restart' };

export const v3 = (v: { x: number; y: number; z: number }): V3 => [r2(v.x), r2(v.y), r2(v.z)];
export const r2 = (n: number): number => Math.round(n * 100) / 100;
export const r3 = (n: number): number => Math.round(n * 1000) / 1000;

export function isToHost(d: unknown): d is ToHost {
  return !!d && typeof d === 'object' && typeof (d as { k?: unknown }).k === 'string';
}

export function isToClient(d: unknown): d is ToClient {
  return !!d && typeof d === 'object' && typeof (d as { k?: unknown }).k === 'string';
}

/** A finite [x, y, z]. */
export function validV3(v: unknown, limit = 1e5): v is V3 {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < limit);
}
