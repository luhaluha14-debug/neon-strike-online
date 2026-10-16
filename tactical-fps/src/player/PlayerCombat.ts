import * as THREE from 'three';
import { PLAYER_CONFIG } from '../config';
import type { Damageable, DamageInfo, HitZone, TargetHit } from '../combat/Damage';
import type { PlayerController } from './PlayerController';

/** Seconds from death until the player respawns. */
export const RESPAWN_DELAY = 3;
/** Seconds after (re)spawning during which damage is ignored, so a spawn is never an instant death. */
export const SPAWN_PROTECTION = 1;

/** Hit radius of the player's body (a little slimmer than the 0.35 m movement capsule). */
const HIT_RADIUS = 0.3;
/** Fractions of the current capsule height (feet = 0): above HEAD is the head, below LEGS a limb. */
const HEAD = 0.86;
const LEGS = 0.5;

export interface PlayerDamageEvent {
  amount: number;
  zone: HitZone;
  /** Normalized world direction the bullet travelled. */
  direction: THREE.Vector3;
  killed: boolean;
}

const _seg = new THREE.Line3();
const _closest = new THREE.Vector3();
const _oc = new THREE.Vector3();
const _ba = new THREE.Vector3();

/**
 * The local player as something bullets can hurt: health (stored in the
 * existing `PlayerController.health`), death, the respawn timer and spawn
 * protection. Registered with the map's HitscanSystem under the same id the
 * player's WeaponSystem shoots with ('local'), so the player's own rounds
 * never hit it; any other shooter (bots later) goes through the existing
 * hitscan and computeDamage.
 *
 * Separate from TrainingTarget on purpose: dummies and the player share only
 * the Damageable interface.
 */
export class PlayerCombat implements Damageable {
  readonly id = 'local';
  /** Seconds since death (0 while alive). */
  deadTime = 0;
  /** Seconds of spawn protection left. */
  protection = 0;
  /** Called once per hit that actually did damage. */
  onDamage: ((e: PlayerDamageEvent) => void) | null = null;

  private dead = false;

  constructor(private readonly player: PlayerController) {}

  get alive(): boolean {
    return !this.dead;
  }

  get health(): number {
    return this.player.health;
  }

  /** Seconds until respawn while dead, else 0. */
  get respawnIn(): number {
    return this.dead ? Math.max(0, RESPAWN_DELAY - this.deadTime) : 0;
  }

  /** True once the respawn delay has fully elapsed. */
  get respawnDue(): boolean {
    return this.dead && this.deadTime >= RESPAWN_DELAY - 1e-9;
  }

  /** Capsule from the feet to the top of the (possibly crouched) player. */
  raycast(ray: THREE.Ray, maxDistance: number): TargetHit | null {
    const p = this.player;
    const h = p.height;
    _seg.start.set(p.position.x, p.position.y + HIT_RADIUS, p.position.z);
    _seg.end.set(p.position.x, p.position.y + h - HIT_RADIUS, p.position.z);
    const t = capsuleEntry(ray, _seg, HIT_RADIUS);
    if (t === null || t > maxDistance) return null;
    const point = ray.origin.clone().addScaledVector(ray.direction, t);
    _seg.closestPointToPoint(point, true, _closest);
    const normal = point.clone().sub(_closest).normalize();
    const rel = (point.y - p.position.y) / h;
    const zone: HitZone = rel >= HEAD ? 'head' : rel < LEGS ? 'limb' : 'body';
    return { distance: t, point, normal, zone };
  }

  applyDamage(info: DamageInfo): void {
    if (this.dead || this.protection > 0 || info.amount <= 0) return;
    const p = this.player;
    p.health = Math.max(0, p.health - info.amount);
    const killed = p.health === 0;
    if (killed) {
      this.dead = true;
      this.deadTime = 0;
    }
    this.onDamage?.({ amount: info.amount, zone: info.zone, direction: info.direction.clone(), killed });
  }

  /** Advances timers by one simulation tick. */
  step(dt: number): void {
    if (this.dead) this.deadTime += dt;
    else if (this.protection > 0) this.protection = Math.max(0, this.protection - dt);
  }

  /** Alive at full health with fresh spawn protection (called on every (re)spawn). */
  reset(): void {
    this.dead = false;
    this.deadTime = 0;
    this.protection = SPAWN_PROTECTION;
    this.player.health = PLAYER_CONFIG.maxHealth;
  }
}

/** Entry distance of a ray into a capsule (union of a finite cylinder and two end spheres). */
function capsuleEntry(ray: THREE.Ray, seg: THREE.Line3, r: number): number | null {
  let best: number | null = null;
  for (const c of [seg.start, seg.end]) {
    _oc.subVectors(ray.origin, c);
    const b = _oc.dot(ray.direction);
    const h = b * b - (_oc.dot(_oc) - r * r);
    if (h < 0) continue;
    const t = -b - Math.sqrt(h);
    if (t >= 0 && (best === null || t < best)) best = t;
  }
  _ba.subVectors(seg.end, seg.start);
  _oc.subVectors(ray.origin, seg.start);
  const baba = _ba.dot(_ba);
  const bard = _ba.dot(ray.direction);
  const baoa = _ba.dot(_oc);
  const qa = baba - bard * bard;
  if (qa > 1e-9) {
    const qb = baba * ray.direction.dot(_oc) - baoa * bard;
    const qc = baba * _oc.dot(_oc) - baoa * baoa - r * r * baba;
    const h = qb * qb - qa * qc;
    if (h >= 0) {
      const t = (-qb - Math.sqrt(h)) / qa;
      const y = baoa + t * bard;
      if (t >= 0 && y > 0 && y < baba && (best === null || t < best)) best = t;
    }
  }
  return best;
}
