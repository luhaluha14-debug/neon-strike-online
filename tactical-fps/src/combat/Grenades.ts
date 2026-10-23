import * as THREE from 'three';
import { GRENADE_CONFIG } from '../config';
import type { CollisionWorld } from '../world/CollisionWorld';

export type GrenadeKind = 'flash' | 'smoke';

/** A grenade in flight or rolling on the floor (until it goes off). */
export interface Grenade {
  readonly id: number;
  readonly kind: GrenadeKind;
  /** Combatant id of the thrower. */
  readonly owner: string;
  readonly position: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  /** Seconds since the throw. */
  age: number;
  /** Came to rest on a floor. */
  resting: boolean;
}

/** A smoke cloud: blocks sight lines (bots) and is drawn as puffs (GrenadeEffects). */
export interface SmokeCloud {
  readonly id: number;
  readonly center: THREE.Vector3;
  /** Seconds since it popped. */
  age: number;
}

/** Someone a flash can blind: where the eyes are, where they look, how to blind them. */
export interface FlashObserver {
  readonly id: string;
  readonly eye: THREE.Vector3;
  /** Normalized view direction. */
  readonly view: THREE.Vector3;
  blind(seconds: number): void;
}

export interface GrenadeEvents {
  /** Hit a surface hard enough to be heard (`speed`: impact speed, m/s). */
  onBounce?(g: Grenade, speed: number): void;
  /** A flash went off at `g.position`; `blinded` lists who got how long. */
  onFlash?(g: Grenade, blinded: { id: string; seconds: number }[]): void;
  /** A smoke grenade popped into `cloud`. */
  onSmoke?(g: Grenade, cloud: SmokeCloud): void;
}

const _move = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _n = new THREE.Vector3();
const _to = new THREE.Vector3();
const _ab = new THREE.Vector3();
const _ac = new THREE.Vector3();

/**
 * Thrown utility, simulated at the fixed tick: flight under gravity, bounces
 * off the map (collision BVH raycasts, player-clip included), the fuse,
 * then the effect. Pure logic, no rendering; GrenadeEffects draws it.
 *
 * - FLASH-01 goes off after its fuse. Everyone in the open within range is
 *   blinded for a time that falls off with distance and with how far the
 *   flash is from where they look; a wall in between (map geometry) stops it.
 * - SMOKE-01 pops once it has stopped rolling (or at its longest fuse) into
 *   a cloud that grows, lasts and fades (GRENADE_CONFIG.smoke). Sight lines
 *   through it are blocked for bots; the player sees the cloud itself.
 *
 * Grenades do not bounce off people (only the map).
 */
export class GrenadeSystem {
  readonly grenades: Grenade[] = [];
  readonly smokes: SmokeCloud[] = [];
  events: GrenadeEvents = {};
  /** Who a flash can reach (asked only when one goes off). */
  flashTargets: () => readonly FlashObserver[] = () => [];
  private nextId = 1;

  constructor(private readonly world: CollisionWorld) {}

  /**
   * Throws a grenade from `eye` along the normalized view `dir`, adding
   * `carry` (the thrower's velocity). Starts in front of the eye, or just
   * short of a wall that is closer.
   */
  throw(kind: GrenadeKind, owner: string, eye: THREE.Vector3, dir: THREE.Vector3, carry?: THREE.Vector3): Grenade {
    const cfg = GRENADE_CONFIG;
    const ahead = this.world.raycast(eye, dir, cfg.throwOffset + cfg.radius, undefined, true);
    const start = eye.clone().addScaledVector(dir, ahead === null ? cfg.throwOffset : Math.max(ahead - cfg.radius * 2, 0));
    const velocity = dir.clone().multiplyScalar(cfg.throwSpeed);
    velocity.y += cfg.throwLift;
    if (carry) velocity.add(carry);
    const g: Grenade = { id: this.nextId++, kind, owner, position: start, velocity, age: 0, resting: false };
    this.grenades.push(g);
    return g;
  }

  /** One simulation tick. */
  step(dt: number): void {
    for (let i = this.smokes.length - 1; i >= 0; i--) {
      const s = this.smokes[i];
      s.age += dt;
      if (s.age >= GRENADE_CONFIG.smoke.duration) this.smokes.splice(i, 1);
    }
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const g = this.grenades[i];
      g.age += dt;
      if (!g.resting) this.fly(g, dt);
      if (this.due(g)) {
        this.grenades.splice(i, 1);
        this.detonate(g);
      }
    }
  }

  /** Removes every grenade and cloud (round change, new match, map change). */
  clear(): void {
    this.grenades.length = 0;
    this.smokes.length = 0;
  }

  /** Current radius of a cloud (grows over the bloom). */
  static radius(s: SmokeCloud): number {
    const c = GRENADE_CONFIG.smoke;
    return c.radius * THREE.MathUtils.smoothstep(s.age, 0, c.bloom);
  }

  /** Does a cloud still block sight? (Until halfway through its fade.) */
  static blocking(s: SmokeCloud): boolean {
    const c = GRENADE_CONFIG.smoke;
    return s.age < c.duration - c.fadeOut * 0.5;
  }

  /** Is the straight line from `a` to `b` blocked by a smoke cloud? */
  sightBlocked(a: THREE.Vector3, b: THREE.Vector3): boolean {
    for (const s of this.smokes) {
      if (!GrenadeSystem.blocking(s)) continue;
      const r = GrenadeSystem.radius(s) * GRENADE_CONFIG.smoke.blockFactor;
      if (r <= 0) continue;
      // Closest point of segment ab to the centre.
      _ab.subVectors(b, a);
      _ac.subVectors(s.center, a);
      const len2 = _ab.lengthSq();
      const t = len2 > 0 ? THREE.MathUtils.clamp(_ac.dot(_ab) / len2, 0, 1) : 0;
      _ab.multiplyScalar(t).add(a);
      if (_ab.distanceToSquared(s.center) < r * r) return true;
    }
    return false;
  }

  /** 0..1: how deep `p` is inside a cloud (1 = at a centre), for the player's screen veil. */
  densityAt(p: THREE.Vector3): number {
    let best = 0;
    for (const s of this.smokes) {
      const r = GrenadeSystem.radius(s);
      if (r <= 0) continue;
      const k = 1 - p.distanceTo(s.center) / r;
      if (k <= 0) continue;
      const fade = 1 - THREE.MathUtils.smoothstep(s.age, GRENADE_CONFIG.smoke.duration - GRENADE_CONFIG.smoke.fadeOut, GRENADE_CONFIG.smoke.duration);
      best = Math.max(best, Math.min(1, k * 1.6) * fade);
    }
    return best;
  }

  /**
   * Blind time (s) for eyes at `eye` looking along `view` (normalized) from
   * a flash at `at`: 0 if out of range, behind a wall, or too short.
   */
  flashBlind(eye: THREE.Vector3, view: THREE.Vector3, at: THREE.Vector3): number {
    const f = GRENADE_CONFIG.flash;
    _to.subVectors(at, eye);
    const d = _to.length();
    if (d > f.range) return 0;
    if (d > 0.3) {
      _to.multiplyScalar(1 / d);
      if (this.world.raycast(eye, _to, d - 0.15) !== null) return 0;
    } else {
      _to.copy(view);
    }
    const distance = 1 - (d / f.range) ** 2;
    const facing = f.behind + (1 - f.behind) * THREE.MathUtils.smoothstep(view.dot(_to), -0.5, 0.85);
    const t = f.maxBlind * distance * facing;
    return t < f.minBlind ? 0 : t;
  }

  private due(g: Grenade): boolean {
    if (g.kind === 'flash') return g.age >= GRENADE_CONFIG.flash.fuse;
    const s = GRENADE_CONFIG.smoke;
    return (g.resting && g.age >= s.fuse) || g.age >= s.maxFuse;
  }

  private detonate(g: Grenade): void {
    if (g.kind === 'smoke') {
      const cloud: SmokeCloud = { id: g.id, center: g.position.clone(), age: 0 };
      cloud.center.y += GRENADE_CONFIG.smoke.lift;
      this.smokes.push(cloud);
      this.events.onSmoke?.(g, cloud);
      return;
    }
    const at = g.position.clone();
    at.y += 0.08;
    const blinded: { id: string; seconds: number }[] = [];
    for (const o of this.flashTargets()) {
      const t = this.flashBlind(o.eye, o.view, at);
      if (t > 0) {
        o.blind(t);
        blinded.push({ id: o.id, seconds: t });
      }
    }
    this.events.onFlash?.(g, blinded);
  }

  /** Moves a flying grenade by one tick: gravity, then a swept ray against the map with bounce and friction. */
  private fly(g: Grenade, dt: number): void {
    const cfg = GRENADE_CONFIG;
    const v = g.velocity;
    v.y -= cfg.gravity * dt;
    _move.copy(v).multiplyScalar(dt);
    const len = _move.length();
    if (len < 1e-6) return;
    _dir.copy(_move).multiplyScalar(1 / len);
    const hit = this.world.raycast(g.position, _dir, len + cfg.radius, _n, true);
    if (hit === null) {
      g.position.add(_move);
      return;
    }
    // Face normals are two-sided: turn it against the motion.
    if (_n.dot(_dir) > 0) _n.negate();
    g.position.addScaledVector(_dir, Math.max(hit - cfg.radius, 0));
    const vn = v.dot(_n);
    // Split into the part into the surface (bounced back, damped) and along it (slowed by friction).
    // A real impact loses `friction` of the sliding speed at once; rolling contact (gravity's
    // pull of one tick) only slows it gradually (`rollDrag` per second).
    _move.copy(_n).multiplyScalar(vn);
    const keep = -vn > 1 ? cfg.friction : Math.exp(-cfg.rollDrag * dt);
    v.sub(_move).multiplyScalar(keep).addScaledVector(_n, -vn * cfg.bounce);
    if (-vn > 1.5) this.events.onBounce?.(g, -vn);
    if (_n.y > 0.7 && v.length() < 0.7) {
      v.set(0, 0, 0);
      g.resting = true;
    }
  }
}
