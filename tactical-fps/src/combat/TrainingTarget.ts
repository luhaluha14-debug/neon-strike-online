import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MeshBVH } from 'three-mesh-bvh';
import { PLAYER_CONFIG } from '../config';
import type { Damageable, DamageInfo, HitZone, TargetHit } from './Damage';

// A pop-up training dummy. Bullets are tested against the very triangles that
// are drawn (through a BVH), posed by the same pivot matrix the renderer uses,
// so what you see is what you hit while it stands, sways, falls and rises.

/** Seconds from the killing hit until the dummy lies flat. */
export const FALL_TIME = 0.35;
/** Seconds it stays down before rising. */
export const DOWN_TIME = 3;
/** Seconds to stand back up; it takes hits again (at full health) after this. */
export const RISE_TIME = 0.5;
const FLASH_TIME = 0.1;

/**
 * The dummy pivots on a hinge just behind its heels so it can lie flat on its
 * back without sinking into the floor. Shapes below are in pivot space:
 * +Y up, +Z towards the shooter it faces.
 */
const HINGE_Z = 0.14;

type Shape =
  | { kind: 'sphere'; center: THREE.Vector3; radius: number }
  | { kind: 'capsule'; a: THREE.Vector3; b: THREE.Vector3; radius: number }
  | { kind: 'box'; box: THREE.Box3 };

interface Part {
  name: string;
  zone: HitZone;
  color: number;
  shape: Shape;
}

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z + HINGE_Z);
const box = (cx: number, cy: number, cz: number, w: number, h: number, d: number): Shape => ({
  kind: 'box',
  box: new THREE.Box3(v(cx - w / 2, cy - h / 2, cz - d / 2), v(cx + w / 2, cy + h / 2, cz + d / 2)),
});
const cap = (a: THREE.Vector3, b: THREE.Vector3, radius: number): Shape => ({ kind: 'capsule', a, b, radius });

const SKIN = 0x9c8a6c; // tan mannequin
const VEST = 0x4b4f3a; // olive plate carrier
const PANTS = 0x3d3e38;

/** About 1.78 m tall, roughly a person in kit. */
export const PARTS: readonly Part[] = [
  { name: 'head', zone: 'head', color: SKIN, shape: { kind: 'sphere', center: v(0, 1.66, 0), radius: 0.115 } },
  { name: 'neck', zone: 'body', color: SKIN, shape: cap(v(0, 1.47, 0), v(0, 1.56, 0), 0.06) },
  { name: 'torso', zone: 'body', color: VEST, shape: box(0, 1.2, 0, 0.44, 0.56, 0.24) },
  { name: 'pelvis', zone: 'body', color: PANTS, shape: box(0, 0.875, 0, 0.36, 0.17, 0.22) },
  { name: 'upperArm.l', zone: 'limb', color: VEST, shape: cap(v(-0.275, 1.41, 0), v(-0.3, 1.13, 0.02), 0.055) },
  { name: 'upperArm.r', zone: 'limb', color: VEST, shape: cap(v(0.275, 1.41, 0), v(0.3, 1.13, 0.02), 0.055) },
  { name: 'forearm.l', zone: 'limb', color: SKIN, shape: cap(v(-0.3, 1.13, 0.02), v(-0.29, 0.88, 0.07), 0.045) },
  { name: 'forearm.r', zone: 'limb', color: SKIN, shape: cap(v(0.3, 1.13, 0.02), v(0.29, 0.88, 0.07), 0.045) },
  { name: 'thigh.l', zone: 'limb', color: PANTS, shape: cap(v(-0.1, 0.8, 0), v(-0.11, 0.46, 0), 0.075) },
  { name: 'thigh.r', zone: 'limb', color: PANTS, shape: cap(v(0.1, 0.8, 0), v(0.11, 0.46, 0), 0.075) },
  { name: 'shin.l', zone: 'limb', color: PANTS, shape: cap(v(-0.11, 0.46, 0), v(-0.11, 0.09, 0.01), 0.06) },
  { name: 'shin.r', zone: 'limb', color: PANTS, shape: cap(v(0.11, 0.46, 0), v(0.11, 0.09, 0.01), 0.06) },
];

/** Bounding sphere of all parts (pivot space), for a cheap early-out. */
const BOUND_CENTER = v(0, 0.9, 0);
const BOUND_RADIUS = 1.0;

export interface DummyGeometry {
  geometry: THREE.BufferGeometry;
  /** `ranges[i]` = vertex range of PARTS[i] in the merged geometry. */
  ranges: [start: number, count: number][];
  /** Ray-test acceleration over exactly these triangles (pivot space). */
  bvh: MeshBVH;
}

/** Builds the merged visible mesh from PARTS, and the BVH bullets are tested against. */
export function buildDummyGeometry(): DummyGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const ranges: [number, number][] = [];
  let start = 0;
  const color = new THREE.Color();
  for (const p of PARTS) {
    let g: THREE.BufferGeometry;
    const s = p.shape;
    if (s.kind === 'sphere') {
      g = new THREE.SphereGeometry(s.radius, 16, 12);
      g.translate(s.center.x, s.center.y, s.center.z);
    } else if (s.kind === 'capsule') {
      const axis = new THREE.Vector3().subVectors(s.b, s.a);
      g = new THREE.CapsuleGeometry(s.radius, axis.length(), 3, 12);
      g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.clone().normalize()));
      const mid = new THREE.Vector3().addVectors(s.a, s.b).multiplyScalar(0.5);
      g.translate(mid.x, mid.y, mid.z);
    } else {
      const size = s.box.getSize(new THREE.Vector3());
      const c = s.box.getCenter(new THREE.Vector3());
      g = new THREE.BoxGeometry(size.x, size.y, size.z);
      g.translate(c.x, c.y, c.z);
    }
    g.deleteAttribute('uv');
    const n = g.getAttribute('position').count;
    color.setHex(p.color, THREE.SRGBColorSpace);
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) color.toArray(colors, i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    parts.push(g);
    ranges.push([start, n]);
    start += n;
  }
  const geometry = mergeGeometries(parts, false)!;
  parts.forEach((g) => g.dispose());
  // Built before any per-target clone, so every clone shares the same triangle order.
  const bvh = new MeshBVH(geometry);
  return { geometry, ranges, bvh };
}

/** PARTS index of a vertex of the merged geometry. */
export function partOfVertex(ranges: readonly [number, number][], vertex: number): number {
  for (let i = 0; i < ranges.length; i++) if (vertex >= ranges[i][0] && vertex < ranges[i][0] + ranges[i][1]) return i;
  return -1;
}

export type TargetState = 'standing' | 'falling' | 'down' | 'rising';

export interface TargetMotion {
  /** Half the travel of a moving target along its local X axis (m); 0 = static. */
  sweep: number;
  /** Peak speed along the track (m/s). */
  speed: number;
}

const _invRay = new THREE.Ray();
const _local = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _dirLocal = new THREE.Vector3();
const _flash = new THREE.Color(0xfff0dc);

/**
 * One training dummy. Implements the existing `Damageable` interface, so the
 * HitscanSystem resolves shots and computes damage exactly as for any target.
 * Animation advances only in `step()` on the fixed simulation tick; the hit
 * shapes use the same pivot matrix the mesh is rendered with.
 */
export class TrainingTarget implements Damageable {
  readonly team = 'training';
  readonly object = new THREE.Group();
  /** Rotates for falling and hit sway; the mesh is its child. */
  readonly pivot = new THREE.Group();
  readonly mesh: THREE.Mesh;
  readonly maxHealth: number = PLAYER_CONFIG.maxHealth;
  health: number = this.maxHealth;
  state: TargetState = 'standing';
  /** Times this target was taken down (since load / reset). */
  kills = 0;
  /** Seconds since the last state change. */
  stateTime = 0;

  /** Hit sway (rad) and its angular velocity, around pivot X (back) and Z (side). */
  private sway = new THREE.Vector2();
  private swayVel = new THREE.Vector2();
  private phase = 0;
  private flashPart = -1;
  private flashTime = 0;
  private readonly inverse = new THREE.Matrix4();
  private readonly baseColors: Float32Array;
  private readonly ranges: [number, number][];
  private readonly bvh: MeshBVH;
  /** Part of the most recent raycast hit (the hitscan applies damage right after). */
  private lastHit: { point: THREE.Vector3; part: number } | null = null;

  constructor(
    readonly id: string,
    readonly base: THREE.Vector3,
    yaw: number,
    readonly motion: TargetMotion,
    geometry: DummyGeometry,
    material: THREE.Material,
  ) {
    this.object.position.copy(base);
    this.object.rotation.y = yaw;
    this.pivot.position.z = -HINGE_Z;
    // Each dummy owns its geometry copy so a hit flash only tints this one.
    const g = geometry.geometry.clone();
    this.ranges = geometry.ranges;
    this.bvh = geometry.bvh;
    this.baseColors = (g.getAttribute('color').array as Float32Array).slice();
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.name = 'TrainingTarget';
    // The map's shadow map is baked once at load: a moving / falling caster would leave a stale shadow.
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.pivot.add(this.mesh);
    this.object.add(this.pivot);
    this.object.name = id;
    this.syncMatrices();
  }

  get alive(): boolean {
    return this.state === 'standing';
  }

  /** Current offset along the track (moving targets). */
  get trackOffset(): number {
    return this.motion.sweep > 0 ? this.motion.sweep * Math.sin(this.phase) : 0;
  }

  raycast(ray: THREE.Ray, maxDistance: number): TargetHit | null {
    // Into pivot space (rotation + translation only, so distances are unchanged).
    _invRay.copy(ray).applyMatrix4(this.inverse);
    _invRay.direction.normalize();
    if (_invRay.distanceSqToPoint(BOUND_CENTER) > BOUND_RADIUS * BOUND_RADIUS) return null;
    // The drawn triangles, front faces only (as rendered).
    const hit = this.bvh.raycastFirst(_invRay, THREE.FrontSide, 0, maxDistance);
    if (!hit || !hit.face) return null;
    const part = partOfVertex(this.ranges, hit.face.a);
    const point = ray.origin.clone().addScaledVector(ray.direction, hit.distance);
    const normal = hit.face.normal.clone().transformDirection(this.pivot.matrixWorld);
    this.lastHit = { point, part };
    return { distance: hit.distance, point, normal, zone: PARTS[part].zone };
  }

  applyDamage(info: DamageInfo): void {
    if (!this.alive) return;
    this.health = Math.max(0, this.health - info.amount);
    // Same hit the hitscan just resolved through raycast(): flash that part.
    this.flashPart = this.lastHit && this.lastHit.point === info.point ? this.lastHit.part : PARTS.findIndex((p) => p.zone === info.zone);
    this.flashTime = FLASH_TIME;
    this.paintFlash(1);
    // Push away from the shooter, harder for heavier hits.
    _dirLocal.copy(info.direction).transformDirection(this.inverse);
    const k = Math.min(info.amount, 120) * 0.022;
    this.swayVel.x += _dirLocal.z * k;
    this.swayVel.y -= _dirLocal.x * k;
    if (this.health <= 0) {
      this.setState('falling');
      this.kills++;
    }
  }

  /** Advances the dummy by one simulation tick. */
  step(dt: number): void {
    this.stateTime += dt;
    if (this.state === 'standing' && this.motion.sweep > 0) this.phase += (this.motion.speed / this.motion.sweep) * dt;
    // (Tolerance: the time is a sum of 1/120 s ticks.)
    if (this.state === 'falling' && this.stateTime >= FALL_TIME - 1e-9) this.setState('down');
    else if (this.state === 'down' && this.stateTime >= DOWN_TIME - 1e-9) this.setState('rising');
    else if (this.state === 'rising' && this.stateTime >= RISE_TIME - 1e-9) {
      this.health = this.maxHealth;
      this.setState('standing');
    }

    // Damped spring back to upright (about 2.2 Hz, settles in ~0.3 s).
    const w = 14;
    const zeta = 0.45;
    for (const c of ['x', 'y'] as const) {
      this.swayVel[c] += (-w * w * this.sway[c] - 2 * zeta * w * this.swayVel[c]) * dt;
      this.sway[c] = THREE.MathUtils.clamp(this.sway[c] + this.swayVel[c] * dt, -0.3, 0.3);
    }
    if (this.state !== 'standing') {
      this.sway.multiplyScalar(0.9);
      this.swayVel.multiplyScalar(0.9);
    }

    if (this.flashTime > 0) {
      this.flashTime = Math.max(0, this.flashTime - dt);
      this.paintFlash(this.flashTime / FLASH_TIME);
    }
    this.syncMatrices();
  }

  /** Pivot rotation around X: 0 upright, -PI/2 flat on its back. */
  get fallAngle(): number {
    const lie = -Math.PI / 2;
    if (this.state === 'falling') return lie * Math.min(this.stateTime / FALL_TIME, 1) ** 2;
    if (this.state === 'down') return lie;
    if (this.state === 'rising') {
      const t = Math.min(this.stateTime / RISE_TIME, 1);
      return lie * (1 - t * t * (3 - 2 * t));
    }
    return 0;
  }

  /** Back to full health, upright, at the start of its track. */
  reset(): void {
    this.health = this.maxHealth;
    this.state = 'standing';
    this.stateTime = 0;
    this.kills = 0;
    this.phase = 0;
    this.sway.set(0, 0);
    this.swayVel.set(0, 0);
    this.flashTime = 0;
    this.paintFlash(0);
    this.lastHit = null;
    this.syncMatrices();
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.object.removeFromParent();
  }

  private setState(s: TargetState): void {
    this.state = s;
    this.stateTime = 0;
  }

  private syncMatrices(): void {
    this.object.position.copy(this.base);
    if (this.motion.sweep > 0) {
      _local.set(this.trackOffset, 0, 0).applyAxisAngle(_up, this.object.rotation.y);
      this.object.position.add(_local);
    }
    this.pivot.rotation.set(this.fallAngle + this.sway.x, 0, this.sway.y);
    this.object.updateMatrixWorld(true);
    this.inverse.copy(this.pivot.matrixWorld).invert();
  }

  private paintFlash(amount: number): void {
    const attr = this.mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    arr.set(this.baseColors);
    if (amount > 0 && this.flashPart >= 0) {
      const [start, count] = this.ranges[this.flashPart];
      const a = amount * 0.65;
      for (let i = start * 3; i < (start + count) * 3; i += 3) {
        arr[i] += (_flash.r - arr[i]) * a;
        arr[i + 1] += (_flash.g - arr[i + 1]) * a;
        arr[i + 2] += (_flash.b - arr[i + 2]) * a;
      }
    }
    attr.needsUpdate = true;
  }
}
