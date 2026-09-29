import * as THREE from 'three';
import type { CollisionWorld } from '../world/CollisionWorld';
import type { DamageProfile } from '../weapons/WeaponDefinition';
import type { Damageable, DamageInfo, HitZone } from './Damage';

export type HitscanResult =
  | { kind: 'miss'; end: THREE.Vector3 }
  | { kind: 'world'; point: THREE.Vector3; normal: THREE.Vector3; distance: number }
  | { kind: 'target'; target: Damageable; point: THREE.Vector3; normal: THREE.Vector3; distance: number; zone: HitZone; damage: number };

export interface ShotRequest {
  origin: THREE.Vector3;
  /** Normalized. */
  direction: THREE.Vector3;
  damage: DamageProfile;
  sourceId: string;
  weaponId: string;
}

const _ray = new THREE.Ray();

/**
 * Instant-hit bullet resolution. The map is tested first to find how far the
 * bullet can travel; only targets closer than that can be hit, so walls
 * always block. Targets register themselves here.
 */
export class HitscanSystem {
  private readonly targets = new Set<Damageable>();

  constructor(private readonly world: CollisionWorld) {}

  register(target: Damageable): void {
    this.targets.add(target);
  }

  unregister(target: Damageable): void {
    this.targets.delete(target);
  }

  fire(shot: ShotRequest): HitscanResult {
    const { origin, direction, damage } = shot;
    const normal = new THREE.Vector3();
    const worldDist = this.world.raycast(origin, direction, damage.maxRange, normal);
    const limit = worldDist ?? damage.maxRange;

    _ray.origin.copy(origin);
    _ray.direction.copy(direction);
    let best: { target: Damageable; distance: number; point: THREE.Vector3; normal: THREE.Vector3; zone: HitZone } | null = null;
    for (const target of this.targets) {
      if (!target.alive || target.id === shot.sourceId) continue;
      const hit = target.raycast(_ray, best ? best.distance : limit);
      if (hit && hit.distance < limit && (!best || hit.distance < best.distance)) best = { target, ...hit };
    }

    if (best) {
      const amount = computeDamage(damage, best.zone, best.distance);
      const info: DamageInfo = {
        amount,
        zone: best.zone,
        sourceId: shot.sourceId,
        weaponId: shot.weaponId,
        point: best.point,
        direction: direction.clone(),
        distance: best.distance,
      };
      best.target.applyDamage(info);
      return { kind: 'target', ...best, damage: amount };
    }

    if (worldDist !== null) {
      // Double-sided map faces: make the normal face the shooter.
      if (normal.dot(direction) > 0) normal.negate();
      return { kind: 'world', point: origin.clone().addScaledVector(direction, worldDist), normal, distance: worldDist };
    }
    return { kind: 'miss', end: origin.clone().addScaledVector(direction, damage.maxRange) };
  }
}

export function computeDamage(profile: DamageProfile, zone: HitZone, distance: number): number {
  const zoneMul = zone === 'head' ? profile.headMultiplier : zone === 'limb' ? profile.limbMultiplier : 1;
  let falloff = 1;
  if (distance > profile.falloffStart) {
    const t = Math.min((distance - profile.falloffStart) / Math.max(profile.falloffEnd - profile.falloffStart, 1e-6), 1);
    falloff = 1 + (profile.falloffMinMultiplier - 1) * t;
  }
  return Math.round(profile.base * zoneMul * falloff);
}
