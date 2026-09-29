import * as THREE from 'three';

const MAX_DECALS = 128;
const MAX_PUFFS = 24;
const PUFF_LIFE = 0.18;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _z = new THREE.Vector3(0, 0, 1);
const _roll = new THREE.Quaternion();

/**
 * Bullet impact feedback: persistent bullet holes plus a brief dust puff.
 * Everything is pooled in two InstancedMeshes (2 draw calls total).
 */
export class ImpactEffects {
  readonly group = new THREE.Group();
  private readonly decals: THREE.InstancedMesh;
  private readonly puffs: THREE.InstancedMesh;
  private decalCursor = 0;
  private puffCursor = 0;
  private readonly puffAge = new Float32Array(MAX_PUFFS).fill(Infinity);
  private readonly puffPos: THREE.Vector3[] = [];
  private readonly puffRot: THREE.Quaternion[] = [];
  private activePuffs = 0;

  constructor() {
    const decalMat = new THREE.MeshBasicMaterial({
      map: makeHoleTexture(),
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      fog: true,
    });
    this.decals = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.07, 0.07), decalMat, MAX_DECALS);
    this.decals.count = 0;
    this.decals.frustumCulled = false;
    this.decals.renderOrder = 1;

    const puffMat = new THREE.MeshBasicMaterial({
      map: makePuffTexture(),
      color: 0xcfc8ba,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
    });
    this.puffs = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.28, 0.28), puffMat, MAX_PUFFS);
    this.puffs.count = MAX_PUFFS;
    this.puffs.frustumCulled = false;
    this.puffs.renderOrder = 2;
    _m.makeScale(0, 0, 0);
    for (let i = 0; i < MAX_PUFFS; i++) {
      this.puffs.setMatrixAt(i, _m);
      this.puffPos.push(new THREE.Vector3());
      this.puffRot.push(new THREE.Quaternion());
    }

    this.group.add(this.decals, this.puffs);
  }

  spawn(point: THREE.Vector3, normal: THREE.Vector3): void {
    _q.setFromUnitVectors(_z, normal);
    _roll.setFromAxisAngle(_z, Math.random() * Math.PI * 2);
    _q.multiply(_roll);

    // Bullet hole (ring buffer: oldest disappears first).
    _p.copy(point).addScaledVector(normal, 0.004);
    _s.setScalar(0.8 + Math.random() * 0.4);
    _m.compose(_p, _q, _s);
    this.decals.setMatrixAt(this.decalCursor, _m);
    this.decalCursor = (this.decalCursor + 1) % MAX_DECALS;
    this.decals.count = Math.min(this.decals.count + 1, MAX_DECALS);
    this.decals.instanceMatrix.needsUpdate = true;

    // Dust puff.
    const i = this.puffCursor;
    this.puffCursor = (this.puffCursor + 1) % MAX_PUFFS;
    this.puffPos[i].copy(point).addScaledVector(normal, 0.05);
    this.puffRot[i].copy(_q);
    if (!Number.isFinite(this.puffAge[i]) || this.puffAge[i] >= PUFF_LIFE) this.activePuffs++;
    this.puffAge[i] = 0;
  }

  update(dt: number): void {
    if (this.activePuffs === 0) return;
    for (let i = 0; i < MAX_PUFFS; i++) {
      if (this.puffAge[i] >= PUFF_LIFE) continue;
      this.puffAge[i] += dt;
      const t = this.puffAge[i] / PUFF_LIFE;
      if (t >= 1) {
        _m.makeScale(0, 0, 0);
        this.activePuffs--;
      } else {
        // Grow quickly, then shrink away.
        _s.setScalar(t < 0.3 ? t / 0.3 : 1 - (t - 0.3) / 0.7);
        _m.compose(this.puffPos[i], this.puffRot[i], _s);
      }
      this.puffs.setMatrixAt(i, _m);
    }
    this.puffs.instanceMatrix.needsUpdate = true;
  }

  clear(): void {
    this.decals.count = 0;
    this.decalCursor = 0;
  }
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

function makePuffTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
