import * as THREE from 'three';
import type { SurfaceKind } from '../world/SurfaceMaterials';

const MAX_DECALS = 128;
const MAX_PUFFS = 32;
const PUFF_LIFE = 0.32;
const MAX_SPARKS = 64;
const MAX_CHIPS = 64;
const GRAVITY = 9.8;

/** What a bullet does to a surface, by kind of material. */
export type ImpactClass = 'concrete' | 'brick' | 'asphalt' | 'metal' | 'glass' | 'wood' | 'dirt' | 'foliage' | 'water';

/** Map surface kinds (SurfaceMaterials) to impact classes. */
export function impactClassOf(kind: SurfaceKind | null): ImpactClass {
  switch (kind) {
    case 'metal':
    case 'paintedMetal':
    case 'rust':
    case 'carPaint':
      return 'metal';
    case 'glass':
    case 'light':
      return 'glass';
    case 'wood':
      return 'wood';
    case 'dirt':
    case 'grass':
      return 'dirt';
    case 'foliage':
      return 'foliage';
    case 'water':
      return 'water';
    case 'brick':
      return 'brick';
    case 'asphalt':
      return 'asphalt';
    default:
      return 'concrete';
  }
}

/** Dust colour, chip colour, how many sparks / chips (at full detail), dust size. */
const LOOK: Record<ImpactClass, { dust: number; chip: number; sparks: number; chips: number; puff: number }> = {
  concrete: { dust: 0xcfc8ba, chip: 0x8e8a82, sparks: 0, chips: 5, puff: 1 },
  brick: { dust: 0xc29a86, chip: 0x8a4a38, sparks: 0, chips: 5, puff: 1 },
  asphalt: { dust: 0x9a958c, chip: 0x3b3a38, sparks: 0, chips: 4, puff: 0.9 },
  metal: { dust: 0x8f8d88, chip: 0x5d5d5d, sparks: 10, chips: 0, puff: 0.6 },
  glass: { dust: 0xdfe8ea, chip: 0xcfe3e8, sparks: 4, chips: 5, puff: 0.6 },
  wood: { dust: 0xb09272, chip: 0x6b4a2b, sparks: 0, chips: 6, puff: 0.9 },
  dirt: { dust: 0x8f7d5e, chip: 0x5b4a33, sparks: 0, chips: 6, puff: 1.35 },
  foliage: { dust: 0x7a8659, chip: 0x56663a, sparks: 0, chips: 4, puff: 0.8 },
  water: { dust: 0xe8eef0, chip: 0xd8e4e8, sparks: 0, chips: 5, puff: 0.9 },
};

/** Effects detail: low = hole and a small puff; medium adds chips and a few sparks; high all of them. */
export type ImpactDetail = 'low' | 'medium' | 'high';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _v = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3(0, 0, 1);
const _t = new THREE.Vector3();
const _roll = new THREE.Quaternion();
const _hidden = new THREE.Matrix4().makeScale(0, 0, 0);
const _c = new THREE.Color();

/**
 * Bullet impacts on the map: a bullet hole, and by surface a dust puff in the
 * surface's colour (bigger on the ground), sparks off metal and glass, and
 * chips of the material thrown out. Cosmetic, from the hitscan's result;
 * depth tested (nothing shows through walls). Everything pooled in four
 * InstancedMeshes (4 draw calls), nothing allocated per shot.
 */
export class ImpactEffects {
  readonly group = new THREE.Group();
  private readonly decals: THREE.InstancedMesh;
  private readonly puffs: THREE.InstancedMesh;
  private readonly sparks: THREE.InstancedMesh;
  private readonly chips: THREE.InstancedMesh;
  private decalCursor = 0;
  private puffCursor = 0;
  private readonly puffAge = new Float32Array(MAX_PUFFS).fill(Infinity);
  private readonly puffSize = new Float32Array(MAX_PUFFS);
  private readonly puffPos = Array.from({ length: MAX_PUFFS }, () => new THREE.Vector3());
  private readonly puffDrift = Array.from({ length: MAX_PUFFS }, () => new THREE.Vector3());
  private readonly puffRoll = new Float32Array(MAX_PUFFS);
  private sparkCursor = 0;
  private readonly sparkAge = new Float32Array(MAX_SPARKS).fill(Infinity);
  private readonly sparkLife = new Float32Array(MAX_SPARKS);
  private readonly sparkPos = Array.from({ length: MAX_SPARKS }, () => new THREE.Vector3());
  private readonly sparkVel = Array.from({ length: MAX_SPARKS }, () => new THREE.Vector3());
  private chipCursor = 0;
  private readonly chipAge = new Float32Array(MAX_CHIPS).fill(Infinity);
  private readonly chipPos = Array.from({ length: MAX_CHIPS }, () => new THREE.Vector3());
  private readonly chipVel = Array.from({ length: MAX_CHIPS }, () => new THREE.Vector3());
  private readonly chipRot = Array.from({ length: MAX_CHIPS }, () => new THREE.Quaternion());
  private readonly chipSize = new Float32Array(MAX_CHIPS);
  private live = 0;
  detail: ImpactDetail = 'high';
  /** Impacts by class since start (tests / debugging). */
  readonly counts: Partial<Record<ImpactClass, number>> = {};

  constructor() {
    const decalMat = new THREE.MeshBasicMaterial({
      map: makeHoleTexture(),
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      fog: true,
    });
    this.decals = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.085, 0.085), decalMat, MAX_DECALS);
    this.decals.count = 0;
    this.decals.frustumCulled = false;
    this.decals.renderOrder = 1;

    const puffMat = new THREE.MeshBasicMaterial({ map: makePuffTexture(), color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false });
    this.puffs = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), puffMat, MAX_PUFFS);
    this.puffs.renderOrder = 2;

    const sparkMat = new THREE.MeshBasicMaterial({ map: makeSparkTexture(), color: 0xffd08a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    this.sparks = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), sparkMat, MAX_SPARKS);
    this.sparks.renderOrder = 3;

    this.chips = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 }), MAX_CHIPS);

    for (const im of [this.puffs, this.sparks, this.chips]) {
      im.frustumCulled = false;
      for (let i = 0; i < im.count; i++) im.setMatrixAt(i, _hidden);
    }
    for (let i = 0; i < MAX_PUFFS; i++) this.puffs.setColorAt(i, _c.setHex(0xffffff));
    for (let i = 0; i < MAX_CHIPS; i++) this.chips.setColorAt(i, _c.setHex(0xffffff));
    this.group.name = 'ImpactEffects';
    this.group.add(this.decals, this.puffs, this.sparks, this.chips);
  }

  /** Sparks + chips + puffs in the air (tests). */
  get active(): number {
    return this.live;
  }

  /** A round that hit the map at `point` (surface `normal`), on a surface of `kind` (null: unknown, plain dust). */
  spawn(point: THREE.Vector3, normal: THREE.Vector3, kind: SurfaceKind | null = null, rand: () => number = Math.random): void {
    const cls = impactClassOf(kind);
    this.counts[cls] = (this.counts[cls] ?? 0) + 1;
    const look = LOOK[cls];
    _q.setFromUnitVectors(_z, normal);
    _roll.setFromAxisAngle(_z, rand() * Math.PI * 2);
    _q.multiply(_roll);

    // Bullet hole (ring buffer: oldest disappears first). Water keeps no hole.
    if (cls !== 'water' && cls !== 'foliage') {
      _p.copy(point).addScaledVector(normal, 0.004);
      _s.setScalar((cls === 'metal' ? 0.6 : 0.8) + rand() * 0.4);
      _m.compose(_p, _q, _s);
      this.decals.setMatrixAt(this.decalCursor, _m);
      this.decalCursor = (this.decalCursor + 1) % MAX_DECALS;
      this.decals.count = Math.min(this.decals.count + 1, MAX_DECALS);
      this.decals.instanceMatrix.needsUpdate = true;
    }

    // Dust: kicked up bigger off the ground, drifting out of the surface.
    const ground = normal.y > 0.7;
    const puffs = this.detail === 'high' ? 2 : 1;
    for (let n = 0; n < puffs; n++) {
      const i = this.puffCursor;
      this.puffCursor = (this.puffCursor + 1) % MAX_PUFFS;
      if (!(this.puffAge[i] < PUFF_LIFE)) this.live++;
      this.puffAge[i] = n * -0.04;
      this.puffSize[i] = 0.36 * look.puff * (ground ? 1.5 : 1) * (0.8 + rand() * 0.4) * (n ? 1.4 : 1);
      this.puffPos[i].copy(point).addScaledVector(normal, 0.04);
      this.puffDrift[i].copy(normal).multiplyScalar(ground ? 0.5 : 0.35).y += 0.12;
      this.puffRoll[i] = rand() * Math.PI * 2;
      this.puffs.setColorAt(i, _c.setHex(look.dust));
    }
    if (this.puffs.instanceColor) this.puffs.instanceColor.needsUpdate = true;
    if (this.detail === 'low') return;

    const share = this.detail === 'high' ? 1 : 0.5;
    // Sparks: thrown off the surface in a cone around the bounce direction.
    for (let n = Math.round(look.sparks * share); n > 0; n--) {
      const i = this.sparkCursor;
      this.sparkCursor = (this.sparkCursor + 1) % MAX_SPARKS;
      if (!(this.sparkAge[i] < this.sparkLife[i])) this.live++;
      this.sparkAge[i] = 0;
      this.sparkLife[i] = 0.1 + rand() * 0.16;
      this.sparkPos[i].copy(point).addScaledVector(normal, 0.01);
      randomCone(normal, 1.1, rand, this.sparkVel[i]).multiplyScalar(3 + rand() * 4);
    }
    // Chips of the surface.
    for (let n = Math.round(look.chips * share); n > 0; n--) {
      const i = this.chipCursor;
      this.chipCursor = (this.chipCursor + 1) % MAX_CHIPS;
      if (!(this.chipAge[i] < 0.6)) this.live++;
      this.chipAge[i] = 0;
      this.chipPos[i].copy(point).addScaledVector(normal, 0.01);
      randomCone(normal, 0.9, rand, this.chipVel[i]).multiplyScalar(1.2 + rand() * 1.8);
      this.chipRot[i].setFromAxisAngle(_v.set(rand(), rand(), rand()).normalize(), rand() * 6);
      this.chipSize[i] = 0.008 + rand() * 0.01;
      this.chips.setColorAt(i, _c.setHex(look.chip));
    }
    if (this.chips.instanceColor) this.chips.instanceColor.needsUpdate = true;
  }

  update(dt: number, camera?: THREE.Camera): void {
    if (this.live === 0) return;
    for (let i = 0; i < MAX_PUFFS; i++) {
      if (!(this.puffAge[i] < PUFF_LIFE)) continue;
      this.puffAge[i] += dt;
      const t = this.puffAge[i] / PUFF_LIFE;
      if (t >= 1) {
        this.puffs.setMatrixAt(i, _hidden);
        this.live--;
        continue;
      }
      if (t < 0) continue;
      // Grows fast and thins out; faces the camera.
      this.puffPos[i].addScaledVector(this.puffDrift[i], dt);
      const k = this.puffSize[i] * (0.45 + Math.sqrt(t) * 0.9) * (t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3);
      if (camera) _q.copy(camera.quaternion);
      else _q.identity();
      _q.multiply(_roll.setFromAxisAngle(_z, this.puffRoll[i] + t));
      _m.compose(this.puffPos[i], _q, _s.set(k, k, 1));
      this.puffs.setMatrixAt(i, _m);
    }
    for (let i = 0; i < MAX_SPARKS; i++) {
      if (!(this.sparkAge[i] < this.sparkLife[i])) continue;
      this.sparkAge[i] += dt;
      if (this.sparkAge[i] >= this.sparkLife[i]) {
        this.sparks.setMatrixAt(i, _hidden);
        this.live--;
        continue;
      }
      const v = this.sparkVel[i];
      v.y -= GRAVITY * dt;
      this.sparkPos[i].addScaledVector(v, dt);
      // A streak along its motion, its width turned to the camera.
      const len = Math.min(0.2, v.length() * 0.03) * (1 - this.sparkAge[i] / this.sparkLife[i]);
      _y.copy(v).normalize();
      if (camera) _t.subVectors(camera.position, this.sparkPos[i]).normalize();
      else _t.set(0, 0, 1);
      _x.crossVectors(_y, _t).normalize();
      _t.crossVectors(_x, _y);
      _m.makeBasis(_x.multiplyScalar(0.012), _y.multiplyScalar(Math.max(len, 0.01)), _t);
      _m.setPosition(this.sparkPos[i]);
      this.sparks.setMatrixAt(i, _m);
    }
    for (let i = 0; i < MAX_CHIPS; i++) {
      if (!(this.chipAge[i] < 0.6)) continue;
      this.chipAge[i] += dt;
      if (this.chipAge[i] >= 0.6) {
        this.chips.setMatrixAt(i, _hidden);
        this.live--;
        continue;
      }
      const v = this.chipVel[i];
      v.y -= GRAVITY * dt;
      this.chipPos[i].addScaledVector(v, dt);
      this.chipRot[i].multiply(_roll.setFromAxisAngle(_z, dt * 20));
      _m.compose(this.chipPos[i], this.chipRot[i], _s.setScalar(this.chipSize[i] * (1 - this.chipAge[i] / 0.6)));
      this.chips.setMatrixAt(i, _m);
    }
    this.puffs.instanceMatrix.needsUpdate = true;
    this.sparks.instanceMatrix.needsUpdate = true;
    this.chips.instanceMatrix.needsUpdate = true;
  }

  clear(): void {
    this.decals.count = 0;
    this.decalCursor = 0;
    this.puffAge.fill(Infinity);
    this.sparkAge.fill(Infinity);
    this.chipAge.fill(Infinity);
    for (const im of [this.puffs, this.sparks, this.chips]) {
      for (let i = 0; i < im.count; i++) im.setMatrixAt(i, _hidden);
      im.instanceMatrix.needsUpdate = true;
    }
    this.live = 0;
  }
}

/** A random direction within `spread` (rad) of `axis` (unit), written to `out`. */
function randomCone(axis: THREE.Vector3, spread: number, rand: () => number, out: THREE.Vector3): THREE.Vector3 {
  _t.set(axis.z, axis.x, axis.y).cross(axis);
  if (_t.lengthSq() < 1e-6) _t.set(1, 0, 0).cross(axis);
  _t.normalize();
  _v.crossVectors(axis, _t);
  const a = rand() * Math.PI * 2;
  const r = Math.tan(spread * Math.sqrt(rand()) * 0.5);
  return out.copy(axis).addScaledVector(_t, Math.cos(a) * r).addScaledVector(_v, Math.sin(a) * r).normalize();
}

function makeHoleTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  grad.addColorStop(0, 'rgba(10,10,10,1)');
  grad.addColorStop(0.35, 'rgba(25,23,21,0.95)');
  grad.addColorStop(0.6, 'rgba(60,56,50,0.5)');
  grad.addColorStop(1, 'rgba(60,56,50,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Soft lumpy dust cloud. */
function makePuffTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  for (let i = 0; i < 6; i++) {
    const x = 32 + Math.cos(i * 2.1) * 9;
    const y = 32 + Math.sin(i * 1.3) * 8;
    const grad = g.createRadialGradient(x, y, 0, x, y, 22);
    grad.addColorStop(0, 'rgba(255,255,255,0.5)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** A hot streak: white core, soft edges. */
function makeSparkTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 8;
  c.height = 32;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 8, 0);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.5, 'rgba(255,255,255,1)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 8, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
