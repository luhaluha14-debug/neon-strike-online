import * as THREE from 'three';
import { ARMOR_CONFIG, PLAYER_CONFIG } from '../config';
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
  /** Health lost. */
  amount: number;
  /** Damage the armour stopped (0 without armour or on an uncovered zone). */
  absorbed: number;
  /** Shooter id ('local' = the player, bots 'bot-N') and weapon. */
  sourceId: string;
  weaponId: string;
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
  /** Hitscan id: shots with the same sourceId never hit this body. */
  readonly id: string;
  /** Team (team match only; undefined in free-for-all and training). */
  team: string | undefined = undefined;
  /** Seconds since death (0 while alive). */
  deadTime = 0;
  /** Seconds of spawn protection left. */
  protection = 0;
  /** Armour points (ARMOR-01, team match), separate from health. 0 = none. */
  armor = 0;
  /** Damage events taken so far (a plant / defuse is cancelled when this changes). */
  hits = 0;
  /** Called once per hit that actually did damage. */
  onDamage: ((e: PlayerDamageEvent) => void) | null = null;

  private dead = false;

  constructor(
    private readonly player: PlayerController,
    id = 'local',
  ) {
    this.id = id;
  }

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
    this.hits++;
    const { health, absorbed } = armorSplit(info.amount, info.zone, this.armor);
    this.armor = Math.max(0, this.armor - absorbed * ARMOR_CONFIG.wearPerAbsorbed);
    p.health = Math.max(0, p.health - health);
    const killed = p.health === 0;
    if (killed) {
      this.dead = true;
      this.deadTime = 0;
    }
    this.onDamage?.({ amount: health, absorbed, sourceId: info.sourceId, weaponId: info.weaponId, zone: info.zone, direction: info.direction.clone(), killed });
  }

  /** Advances timers by one simulation tick. */
  step(dt: number): void {
    if (this.dead) this.deadTime += dt;
    else if (this.protection > 0) this.protection = Math.max(0, this.protection - dt);
  }

  /**
   * Multiplayer client: the host decides health, armour and death; this
   * shows its verdict (no damage is worked out here).
   */
  setFromHost(hp: number, armor: number, alive: boolean, deadTime = 0): void {
    this.player.health = Math.max(0, Math.min(hp, PLAYER_CONFIG.maxHealth));
    this.armor = Math.max(0, armor);
    if (alive && this.dead) {
      this.dead = false;
      this.deadTime = 0;
    } else if (!alive && !this.dead) {
      this.dead = true;
      this.deadTime = deadTime;
    }
    this.protection = 0;
  }

  /**
   * Alive at full health with fresh spawn protection (called on every
   * (re)spawn). Armour is removed unless `keepArmor` (team match survivor).
   */
  reset(keepArmor = false): void {
    if (!keepArmor) this.armor = 0;
    this.dead = false;
    this.deadTime = 0;
    this.protection = SPAWN_PROTECTION;
    this.player.health = PLAYER_CONFIG.maxHealth;
  }
}

/**
 * How a hit of `amount` on `zone` splits between health and armour
 * (ARMOR_CONFIG): a covered zone with armour left loses `absorb` of the
 * damage to the armour, limited by the armour there is.
 */
export function armorSplit(amount: number, zone: HitZone, armor: number): { health: number; absorbed: number } {
  if (armor <= 0 || !ARMOR_CONFIG.zones.includes(zone)) return { health: amount, absorbed: 0 };
  const absorbed = Math.min(Math.round(amount * ARMOR_CONFIG.absorb), Math.floor(armor / ARMOR_CONFIG.wearPerAbsorbed));
  return { health: amount - absorbed, absorbed };
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
