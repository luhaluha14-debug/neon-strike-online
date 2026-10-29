import * as THREE from 'three';
import type { CollisionWorld } from '../world/CollisionWorld';

const MAX_MIST = 16;
const MAX_DROPS = 96;
const MAX_SPLATS = 48;
const MIST_LIFE = 0.32;
const GRAVITY = 9.8;
/** How far behind the target a round carries blood onto a wall or the floor (m). */
const SPATTER_RANGE = 4;
/** How far below the hit a stain lands on the floor (m). */
const FLOOR_RANGE = 2.2;

const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _z = new THREE.Vector3(0, 0, 1);
const _roll = new THREE.Quaternion();
const _n = new THREE.Vector3();
const _hidden = new THREE.Matrix4().makeScale(0, 0, 0);

/**
 * Hit feedback on bodies: a burst of blood mist where the round enters,
 * droplets thrown out that fall under gravity, and a splat on the wall or
 * floor behind the target if one is close enough along the bullet's path.
 * Everything is pooled in three InstancedMeshes (3 draw calls) and costs
 * nothing while idle.
 */
export class BloodEffects {
  readonly group = new THREE.Group();
  private readonly mist: THREE.InstancedMesh;
  private readonly drops: THREE.InstancedMesh;
  private readonly splats: THREE.InstancedMesh;

  private readonly mistPos = Array.from({ length: MAX_MIST }, () => new THREE.Vector3());
  private readonly mistAge = new Float32Array(MAX_MIST).fill(Infinity);
  private readonly mistSize = new Float32Array(MAX_MIST);
  private mistCursor = 0;

  private readonly dropPos = Array.from({ length: MAX_DROPS }, () => new THREE.Vector3());
  private readonly dropVel = Array.from({ length: MAX_DROPS }, () => new THREE.Vector3());
  private readonly dropAge = new Float32Array(MAX_DROPS).fill(Infinity);
  private readonly dropLife = new Float32Array(MAX_DROPS);
  private readonly dropSize = new Float32Array(MAX_DROPS);
  private dropCursor = 0;
  private splatCursor = 0;
  /** Particles alive (mist + drops); update() returns at once when 0. */
  private alive = 0;

  constructor(private world: CollisionWorld | null = null) {
    const mistMat = new THREE.MeshBasicMaterial({ map: makeMistTexture(), color: 0x7e0c0c, transparent: true, depthWrite: false, fog: true });
    this.mist = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mistMat, MAX_MIST);
    const dropMat = new THREE.MeshBasicMaterial({ map: makeDropTexture(), color: 0x6e0808, transparent: true, depthWrite: false, fog: true });
    this.drops = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), dropMat, MAX_DROPS);
    const splatMat = new THREE.MeshBasicMaterial({
      map: makeSplatTexture(),
      color: 0x5c0606,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      fog: true,
    });
    this.splats = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), splatMat, MAX_SPLATS);
    for (const im of [this.mist, this.drops]) {
      for (let i = 0; i < im.count; i++) im.setMatrixAt(i, _hidden);
      im.frustumCulled = false;
      im.renderOrder = 3;
    }
    this.splats.count = 0;
    this.splats.frustumCulled = false;
    this.splats.renderOrder = 1;
    this.group.name = 'BloodEffects';
    this.group.add(this.splats, this.mist, this.drops);
  }

  /** The map the spatter lands on (set on every map load). */
  setWorld(world: CollisionWorld | null): void {
    this.world = world;
  }

  /** A round hit a body at `point`, travelling along `dir` (normalized). Headshots spray more. */
  spawn(point: THREE.Vector3, dir: THREE.Vector3, head: boolean): void {
    // Mist: a cloud at the entry wound on the shooter's side (in front of the body, so it is
    // never hidden by it) and one blown out of the far side.
    for (let k = 0; k < (head ? 3 : 2); k++) {
      const i = this.mistCursor;
      this.mistCursor = (this.mistCursor + 1) % MAX_MIST;
      if (this.mistAge[i] >= MIST_LIFE) this.alive++;
      this.mistAge[i] = 0;
      this.mistSize[i] = (head ? 0.55 : 0.42) * (0.85 + Math.random() * 0.3) * (k === 0 ? 1 : 1.25);
      this.mistPos[i].copy(point).addScaledVector(dir, k === 0 ? -0.07 : 0.3 * k);
    }
    // Droplets: mostly forward along the bullet, spread out, some kicked back toward the shooter.
    const n = head ? 18 : 11;
    for (let k = 0; k < n; k++) {
      const i = this.dropCursor;
      this.dropCursor = (this.dropCursor + 1) % MAX_DROPS;
      if (this.dropAge[i] >= this.dropLife[i]) this.alive++;
      this.dropAge[i] = 0;
      this.dropLife[i] = 0.45 + Math.random() * 0.35;
      this.dropSize[i] = 0.03 + Math.random() * 0.045;
      this.dropPos[i].copy(point).addScaledVector(dir, -0.05);
      const back = Math.random() < 0.25 ? -0.5 : 1;
      this.dropVel[i]
        .copy(dir)
        .multiplyScalar(back * (1.5 + Math.random() * 3))
        .add(_n.set(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5).multiplyScalar(2.4));
    }
    this.spatter(point, dir, head);
  }

  /** Splat on the first wall within reach behind the target, and a stain on the floor below. */
  private spatter(point: THREE.Vector3, dir: THREE.Vector3, head: boolean): void {
    if (!this.world) return;
    // A little downward: blood ends up below the line of fire.
    _p.copy(dir).setY(dir.y - 0.25).normalize();
    this.splat(point, _p, SPATTER_RANGE, head ? 0.75 : 0.5);
    _p.copy(dir).setY(0).normalize().multiplyScalar(0.35).setY(-1).normalize();
    this.splat(point, _p, FLOOR_RANGE, head ? 0.6 : 0.45);
  }

  private splat(point: THREE.Vector3, ray: THREE.Vector3, range: number, scale: number): void {
    const dist = this.world!.raycast(point, ray, range, _n);
    if (dist === null) return;
    _p.copy(ray);
    if (_n.dot(_p) > 0) _n.negate();
    _q.setFromUnitVectors(_z, _n);
    _roll.setFromAxisAngle(_z, Math.random() * Math.PI * 2);
    _q.multiply(_roll);
    const size = scale * (0.8 + Math.random() * 0.4) * (0.6 + (0.4 * dist) / range);
    _s.set(size, size, 1);
    const at = point.clone().addScaledVector(_p, dist).addScaledVector(_n, 0.006);
    _m.compose(at, _q, _s);
    this.splats.setMatrixAt(this.splatCursor, _m);
    this.splatCursor = (this.splatCursor + 1) % MAX_SPLATS;
    this.splats.count = Math.min(this.splats.count + 1, MAX_SPLATS);
    this.splats.instanceMatrix.needsUpdate = true;
  }

  /** Per frame: particles face the camera, drops fall, everything shrinks out. */
  update(dt: number, camera: THREE.Camera): void {
    if (this.alive === 0) return;
    const facing = camera.quaternion;
    for (let i = 0; i < MAX_MIST; i++) {
      if (this.mistAge[i] >= MIST_LIFE) continue;
      this.mistAge[i] += dt;
      const t = this.mistAge[i] / MIST_LIFE;
      if (t >= 1) {
        this.mist.setMatrixAt(i, _hidden);
        this.alive--;
        continue;
      }
      // Bursts open fast, then thins (shrinks) away.
      const size = this.mistSize[i] * (t < 0.25 ? 0.4 + (t / 0.25) * 0.6 : 1 - (t - 0.25) * 0.9);
      this.mistPos[i].y += dt * 0.15;
      _m.compose(this.mistPos[i], facing, _s.setScalar(size));
      this.mist.setMatrixAt(i, _m);
    }
    for (let i = 0; i < MAX_DROPS; i++) {
      if (this.dropAge[i] >= this.dropLife[i]) continue;
      this.dropAge[i] += dt;
      if (this.dropAge[i] >= this.dropLife[i]) {
        this.drops.setMatrixAt(i, _hidden);
        this.alive--;
        continue;
      }
      const v = this.dropVel[i];
      v.y -= GRAVITY * dt;
      v.multiplyScalar(1 - 1.5 * dt);
      this.dropPos[i].addScaledVector(v, dt);
      const t = this.dropAge[i] / this.dropLife[i];
      _m.compose(this.dropPos[i], facing, _s.setScalar(this.dropSize[i] * (1 - t * t)));
      this.drops.setMatrixAt(i, _m);
    }
    this.mist.instanceMatrix.needsUpdate = true;
    this.drops.instanceMatrix.needsUpdate = true;
  }

  /** Removes every particle and splat (respawn, map switch). */
  clear(): void {
    for (let i = 0; i < MAX_MIST; i++) {
      this.mistAge[i] = Infinity;
      this.mist.setMatrixAt(i, _hidden);
    }
    for (let i = 0; i < MAX_DROPS; i++) {
      this.dropAge[i] = Infinity;
      this.drops.setMatrixAt(i, _hidden);
    }
    this.mist.instanceMatrix.needsUpdate = true;
    this.drops.instanceMatrix.needsUpdate = true;
    this.alive = 0;
    this.splats.count = 0;
    this.splatCursor = 0;
  }

  /** Particles alive right now (tests / debugging). */
  get activeParticles(): number {
    return this.alive;
  }

  get splatCount(): number {
    return this.splats.count;
  }
}

function canvasTexture(draw: (g: CanvasRenderingContext2D, size: number) => void, size = 64): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d')!, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Soft, lumpy cloud (tinted red by the material). */
function makeMistTexture(): THREE.CanvasTexture {
  return canvasTexture((g, s) => {
    for (let k = 0; k < 7; k++) {
      const x = s / 2 + (Math.random() - 0.5) * s * 0.35;
      const y = s / 2 + (Math.random() - 0.5) * s * 0.35;
      const r = s * (0.2 + Math.random() * 0.2);
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, 'rgba(255,255,255,0.8)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, s, s);
    }
  });
}

function makeDropTexture(): THREE.CanvasTexture {
  return canvasTexture((g, s) => {
    const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.6, 'rgba(255,255,255,0.9)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
  }, 32);
}

/** Irregular splat with a dense core, streaks and scattered dots. */
function makeSplatTexture(): THREE.CanvasTexture {
  return canvasTexture((g, s) => {
    const c = s / 2;
    g.fillStyle = 'rgba(255,255,255,0.95)';
    g.beginPath();
    for (let a = 0; a <= Math.PI * 2 + 0.01; a += Math.PI / 12) {
      const r = s * (0.14 + Math.random() * 0.1);
      const x = c + Math.cos(a) * r;
      const y = c + Math.sin(a) * r;
      if (a === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.fill();
    for (let k = 0; k < 9; k++) {
      const a = Math.random() * Math.PI * 2;
      const len = s * (0.18 + Math.random() * 0.24);
      g.lineWidth = 2 + Math.random() * 4;
      g.strokeStyle = 'rgba(255,255,255,0.85)';
      g.beginPath();
      g.moveTo(c, c);
      g.lineTo(c + Math.cos(a) * len, c + Math.sin(a) * len);
      g.stroke();
    }
    for (let k = 0; k < 40; k++) {
      const a = Math.random() * Math.PI * 2;
      const r = s * (0.15 + Math.random() * 0.33);
      g.fillStyle = `rgba(255,255,255,${0.5 + Math.random() * 0.5})`;
      g.beginPath();
      g.arc(c + Math.cos(a) * r, c + Math.sin(a) * r, 0.8 + Math.random() * 2.6, 0, Math.PI * 2);
      g.fill();
    }
  }, 128);
}
