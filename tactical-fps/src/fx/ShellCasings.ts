import * as THREE from 'three';
import type { WeaponCategory } from '../weapons/WeaponDefinition';

// Spent cases thrown from the ejection port: brass for rifle, SMG, pistol and
// sniper rounds (each its own size), red hulls for the shotgun. Cosmetic only:
// spawned locally from shots already fired (never sent over the network,
// never affecting ammo or hits). They fly with gravity and spin, bounce on the
// floor found under them when they are thrown (one raycast), settle on their
// side and fade out after a few seconds. All of them are one InstancedMesh
// (one draw call), a ring of MAX_CASES: the oldest gives way first.

export const MAX_CASES = 48;
const LIFE = 5;
const FADE = 0.4;
const GRAVITY = 9.8;

export type CaseKind = Exclude<WeaponCategory, 'melee'>;

/** Case size (m) and colour per kind of round. */
export const CASES: Record<CaseKind, { length: number; radius: number; color: number }> = {
  rifle: { length: 0.045, radius: 0.0048, color: 0xc9a14a },
  smg: { length: 0.019, radius: 0.0048, color: 0xcfa74e },
  pistol: { length: 0.019, radius: 0.0048, color: 0xcfa74e },
  sniper: { length: 0.067, radius: 0.0068, color: 0xc29a46 },
  shotgun: { length: 0.065, radius: 0.0101, color: 0x8e1b14 },
};

/** Where a case lands: the floor height under a point (or null: nothing below). */
export type FloorProbe = (from: THREE.Vector3) => number | null;

const _m = new THREE.Matrix4();
const _dq = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _hidden = new THREE.Matrix4().makeScale(0, 0, 0);
const _c = new THREE.Color();
const _axis = new THREE.Vector3();

export class ShellCasings {
  readonly mesh: THREE.InstancedMesh;
  private readonly pos = Array.from({ length: MAX_CASES }, () => new THREE.Vector3());
  private readonly vel = Array.from({ length: MAX_CASES }, () => new THREE.Vector3());
  private readonly rot = Array.from({ length: MAX_CASES }, () => new THREE.Quaternion());
  private readonly spin = Array.from({ length: MAX_CASES }, () => new THREE.Vector3());
  private readonly size = Array.from({ length: MAX_CASES }, () => new THREE.Vector3());
  private readonly age = new Float32Array(MAX_CASES).fill(Infinity);
  private readonly floor = new Float32Array(MAX_CASES);
  private readonly resting = new Uint8Array(MAX_CASES);
  private readonly bounced = new Uint8Array(MAX_CASES);
  private readonly kind: CaseKind[] = new Array<CaseKind>(MAX_CASES).fill('rifle');
  /** First time each case hits the floor (for its sound): kind, where, how fast (m/s). */
  onFloor: ((kind: CaseKind, at: THREE.Vector3, speed: number) => void) | null = null;
  private cursor = 0;
  private live = 0;
  /** Off at low graphics quality. */
  enabled = true;

  constructor(private readonly probe: FloorProbe) {
    // A short cylinder along +Y, unit size (scaled per case), closed ends.
    const geo = new THREE.CylinderGeometry(1, 1, 1, 8, 1, false);
    // Half metallic: the world scene has no environment map, so a fully metallic case would show
    // almost black; this keeps the brass (and the red hull) readable under the map's lights.
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.5, roughness: 0.38 });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_CASES);
    this.mesh.name = 'ShellCasings';
    this.mesh.frustumCulled = false;
    for (let i = 0; i < MAX_CASES; i++) {
      this.mesh.setMatrixAt(i, _hidden);
      this.mesh.setColorAt(i, _c.setHex(0xffffff));
    }
  }

  /** Cases flying or lying around (tests). */
  get count(): number {
    return this.live;
  }

  /** Position of case `i` (tests). */
  at(i: number): THREE.Vector3 | null {
    return this.age[i] < LIFE ? this.pos[i] : null;
  }

  /** Throws a case of `kind` from `port` (world) with `velocity` (world, m/s). */
  eject(kind: CaseKind, port: THREE.Vector3, velocity: THREE.Vector3, rand: () => number = Math.random): void {
    if (!this.enabled) return;
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % MAX_CASES;
    if (!(this.age[i] < LIFE)) this.live++;
    const spec = CASES[kind];
    this.pos[i].copy(port);
    this.vel[i].copy(velocity);
    // Thrown lying across the gun (axis roughly sideways), tumbling end over end.
    _axis.set(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize();
    this.rot[i].setFromAxisAngle(_axis, rand() * Math.PI * 2);
    this.spin[i].set((rand() - 0.5) * 50, (rand() - 0.5) * 20, (rand() - 0.5) * 50);
    this.size[i].set(spec.radius, spec.length, spec.radius);
    this.age[i] = 0;
    this.resting[i] = 0;
    this.bounced[i] = 0;
    this.kind[i] = kind;
    this.floor[i] = this.probe(port) ?? port.y - 4;
    this.mesh.setColorAt(i, _c.setHex(spec.color));
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  update(dt: number): void {
    if (this.live === 0) return;
    const steps = Math.max(1, Math.ceil(dt / (1 / 90)));
    const h = dt / steps;
    for (let i = 0; i < MAX_CASES; i++) {
      if (!(this.age[i] < LIFE)) continue;
      this.age[i] += dt;
      if (this.age[i] >= LIFE) {
        this.mesh.setMatrixAt(i, _hidden);
        this.live--;
        continue;
      }
      const p = this.pos[i];
      const v = this.vel[i];
      const r = this.size[i].x;
      if (!this.resting[i]) {
        for (let k = 0; k < steps; k++) {
          v.y -= GRAVITY * h;
          p.addScaledVector(v, h);
          const w = this.spin[i];
          const ang = w.length() * h;
          if (ang > 0) {
            _dq.setFromAxisAngle(_axis.copy(w).normalize(), ang);
            this.rot[i].premultiply(_dq);
          }
          if (p.y - r <= this.floor[i] && v.y < 0) {
            // Bounce: loses most of its speed and spin; a slow one stays on the floor, on its side.
            p.y = this.floor[i] + r;
            if (!this.bounced[i]) {
              this.bounced[i] = 1;
              this.onFloor?.(this.kind[i], p, -v.y);
            }
            v.y = -v.y * 0.32;
            v.x *= 0.55;
            v.z *= 0.55;
            w.multiplyScalar(0.5);
            if (v.y < 0.35) {
              v.set(0, 0, 0);
              this.resting[i] = 1;
              // Lying on its side: keep its heading, axis horizontal.
              _axis.set(0, 1, 0).applyQuaternion(this.rot[i]);
              _axis.y = 0;
              if (_axis.lengthSq() < 1e-6) _axis.set(1, 0, 0);
              this.rot[i].setFromUnitVectors(_s.set(0, 1, 0), _axis.normalize());
              break;
            }
          }
        }
      }
      const fade = Math.min(1, (LIFE - this.age[i]) / FADE);
      _s.copy(this.size[i]).multiplyScalar(fade);
      _m.compose(p, this.rot[i], _s);
      this.mesh.setMatrixAt(i, _m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear(): void {
    this.age.fill(Infinity);
    for (let i = 0; i < MAX_CASES; i++) this.mesh.setMatrixAt(i, _hidden);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.live = 0;
  }
}
