import type * as THREE from 'three';

export type HitZone = 'head' | 'body' | 'limb';

export interface DamageInfo {
  amount: number;
  zone: HitZone;
  /** Who fired (player / bot id later). */
  sourceId: string;
  weaponId: string;
  point: THREE.Vector3;
  /** Normalized travel direction of the bullet. */
  direction: THREE.Vector3;
  distance: number;
  /** A one-hit-kill weapon (melee): the target dies, whatever its health and armour. */
  lethal?: boolean;
}

export interface TargetHit {
  distance: number;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  zone: HitZone;
}

/**
 * Anything bullets can hurt (players, bots, breakables). Targets do their own
 * ray test so each can use whatever hitboxes it likes (capsules, boxes, bones).
 */
export interface Damageable {
  readonly id: string;
  /** Team id; friendly fire rules can filter on it later. */
  readonly team?: string;
  readonly alive: boolean;
  /**
   * Returns the nearest hit along the ray within `maxDistance`, or null. `pad` (m): a weapon's hit correction
   * (Phase 30, the AWM): a hitbox that supports it is that much wider for this ray (others ignore it).
   */
  raycast(ray: THREE.Ray, maxDistance: number, pad?: number): TargetHit | null;
  applyDamage(info: DamageInfo): void;
}
