import * as THREE from 'three';
import { PLAYER_CONFIG } from '../config';
import type { LoadedMap, SpawnPoint } from '../world/MapLoader';
import type { HitscanSystem } from './HitscanSystem';
import { buildDummyGeometry, TrainingTarget, type TargetMotion } from './TrainingTarget';

/**
 * Where the dummies go, relative to the player's spawn and its facing:
 * `distance` ahead, `lateral` to the right (m). The maps have no target
 * markers, so each slot is checked against the map's collision at load and
 * pulled closer (1 m at a time) until it is valid.
 */
export interface TargetSlot {
  distance: number;
  lateral: number;
  motion?: TargetMotion;
}

export const TARGET_SLOTS: readonly TargetSlot[] = [
  { distance: 10, lateral: -2.5 },
  { distance: 18, lateral: 2.5 },
  { distance: 28, lateral: -1.5 },
  { distance: 40, lateral: 3 },
  // Strafing target: 3 m of track at up to 1.5 m/s.
  { distance: 22, lateral: 0, motion: { sweep: 1.5, speed: 1.5 } },
];

const MIN_DISTANCE = 6;
/** Bases (or tracks) of two dummies stay at least this far apart. */
const MIN_SPACING = 2.2;

export interface SlotResult {
  slot: number;
  placed: boolean;
  /** Distance from the spawn actually used, when placed. */
  distance?: number;
  /** Why the last candidate was rejected, when not placed. */
  reason?: string;
}

const _down = new THREE.Vector3(0, -1, 0);
const _n = new THREE.Vector3();
const _seg = new THREE.Line3();
const _dir = new THREE.Vector3();

/**
 * The training dummies of one loaded map: placement, registration with the
 * map's HitscanSystem, the fixed-tick update, reset and disposal.
 */
export class TrainingRange {
  readonly group = new THREE.Group();
  readonly targets: TrainingTarget[] = [];
  /** One entry per TARGET_SLOTS entry: where it went, or why it could not be placed. */
  readonly placement: SlotResult[] = [];
  private readonly material: THREE.MeshStandardMaterial;
  private readonly geometry: ReturnType<typeof buildDummyGeometry>;
  private disposed = false;

  constructor(
    private readonly map: LoadedMap,
    spawn: SpawnPoint | undefined,
    private readonly hitscan: HitscanSystem,
    slots: readonly TargetSlot[] = TARGET_SLOTS,
  ) {
    this.group.name = 'TrainingRange';
    this.geometry = buildDummyGeometry();
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0 });
    if (!spawn) {
      slots.forEach((_, i) => this.placement.push({ slot: i, placed: false, reason: 'map has no spawn point' }));
      console.warn('[training] no spawn point: no training targets placed');
      return;
    }

    const forward = new THREE.Vector3(-Math.sin(spawn.yaw), 0, -Math.cos(spawn.yaw));
    const right = new THREE.Vector3(Math.cos(spawn.yaw), 0, -Math.sin(spawn.yaw));
    const eye = spawn.position.clone();
    eye.y += PLAYER_CONFIG.standHeight - PLAYER_CONFIG.eyeOffsetFromTop;
    // Every dummy faces back along the spawn's view direction.
    const yaw = Math.atan2(-forward.x, -forward.z);

    slots.forEach((slot, i) => {
      let reason = 'no candidate';
      for (let d = slot.distance; d >= MIN_DISTANCE; d -= 1) {
        const base = spawn.position.clone().addScaledVector(forward, d).addScaledVector(right, slot.lateral);
        const r = this.check(base, slot.motion?.sweep ?? 0, right, forward, eye, spawn.position.y);
        if (typeof r === 'string') {
          reason = r;
          continue;
        }
        base.y = r;
        const target = new TrainingTarget(`training-${i + 1}`, base, yaw, slot.motion ?? { sweep: 0, speed: 0 }, this.geometry, this.material);
        this.targets.push(target);
        this.group.add(target.object);
        hitscan.register(target);
        this.placement.push({ slot: i, placed: true, distance: d });
        return;
      }
      this.placement.push({ slot: i, placed: false, reason });
      console.warn(`[training] target slot ${i + 1} could not be placed: ${reason}`);
    });
  }

  /** Advances every dummy by one simulation tick. */
  step(dt: number): void {
    for (const t of this.targets) t.step(dt);
  }

  /** All dummies upright at full health, moving ones back at the start of their track. */
  reset(): void {
    for (const t of this.targets) t.reset();
  }

  /** Unregisters from the hitscan and frees the GPU resources. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const t of this.targets) {
      this.hitscan.unregister(t);
      t.dispose();
    }
    this.targets.length = 0;
    this.geometry.geometry.dispose();
    this.material.dispose();
    this.group.removeFromParent();
  }

  /**
   * Validates a base position (and the whole track of a moving dummy).
   * Returns the floor height, or the reason it is rejected.
   */
  private check(base: THREE.Vector3, sweep: number, right: THREE.Vector3, forward: THREE.Vector3, eye: THREE.Vector3, spawnY: number): number | string {
    const col = this.map.collision;
    const samples = sweep > 0 ? [-1, -0.5, 0, 0.5, 1] : [0];
    let floorY: number | null = null;
    for (const s of samples) {
      const p = base.clone().addScaledVector(right, s * sweep);
      const b = this.map.playBounds;
      if (p.x < b.min.x + 1 || p.x > b.max.x - 1 || p.z < b.min.z + 1 || p.z > b.max.z - 1) return 'outside the play area';
      // Floor: something flat under the spot, near the spawn's height.
      const from = new THREE.Vector3(p.x, spawnY + 1.5, p.z);
      const dist = col.raycast(from, _down, 4, _n, true);
      if (dist === null) return 'no floor';
      if (Math.abs(_n.y) < 0.9) return 'floor too steep';
      const y = from.y - dist;
      if (Math.abs(y - spawnY) > 1.5) return 'floor height differs from the spawn';
      if (floorY === null) floorY = y;
      else if (Math.abs(y - floorY) > 0.1) return 'uneven track';
      p.y = floorY;
      // Standing volume, the floor area it falls onto (behind it), and the line of sight.
      // (Capsule bottoms sit 5 cm above the floor so the floor itself does not count.)
      _seg.start.set(p.x, p.y + 0.45, p.z);
      _seg.end.set(p.x, p.y + 1.45, p.z);
      if (col.capsuleOverlaps(_seg, 0.4)) return 'blocked where it stands';
      _seg.start.set(p.x, p.y + 0.35, p.z).addScaledVector(forward, 0.2);
      _seg.end.copy(_seg.start).addScaledVector(forward, 1.7);
      if (col.capsuleOverlaps(_seg, 0.3)) return 'no room to fall';
      for (const h of [1.66, 1.2]) {
        const aim = new THREE.Vector3(p.x, p.y + h, p.z);
        const len = _dir.subVectors(aim, eye).length();
        if (col.raycast(eye, _dir.normalize(), len - 0.3) !== null) return 'not visible from the spawn';
      }
      for (const t of this.targets) {
        const reach = t.motion.sweep + sweep + MIN_SPACING;
        if (Math.hypot(t.base.x - base.x, t.base.z - base.z) < reach) return 'too close to another target';
      }
    }
    return floorY!;
  }
}
