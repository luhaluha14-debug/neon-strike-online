import * as THREE from 'three';

const MAX_TRACERS = 48;
const MAX_FLASHES = 16;
/** Visual speed of a tracer streak (m/s) and its length (m). Purely cosmetic: hits are resolved by the hitscan. */
const TRACER_SPEED = 420;
const TRACER_LENGTH = 3.2;
const TRACER_WIDTH = 0.022;
const FLASH_LIFE = 0.055;

const _m = new THREE.Matrix4();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _p = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _hidden = new THREE.Matrix4().makeScale(0, 0, 0);
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _roll = new THREE.Quaternion();
const _fwd = new THREE.Vector3(0, 0, 1);

/**
 * Cosmetic gunfire in the world (any shooter): tracer streaks flying from the
 * muzzle to where the hitscan resolved the round, and muzzle flashes (a
 * camera-facing star plus a flame cone along the barrel). Pooled in three
 * InstancedMeshes; nothing here affects hits or damage.
 */
export class CombatEffects {
  readonly group = new THREE.Group();
  private readonly tracers: THREE.InstancedMesh;
  private readonly stars: THREE.InstancedMesh;
  private readonly cones: THREE.InstancedMesh;
  private readonly tFrom = Array.from({ length: MAX_TRACERS }, () => new THREE.Vector3());
  private readonly tTo = Array.from({ length: MAX_TRACERS }, () => new THREE.Vector3());
  private readonly tAge = new Float32Array(MAX_TRACERS).fill(Infinity);
  private readonly tLife = new Float32Array(MAX_TRACERS);
  private tCursor = 0;
  private readonly fPos = Array.from({ length: MAX_FLASHES }, () => new THREE.Vector3());
  private readonly fDir = Array.from({ length: MAX_FLASHES }, () => new THREE.Vector3());
  private readonly fAge = new Float32Array(MAX_FLASHES).fill(Infinity);
  private readonly fSize = new Float32Array(MAX_FLASHES);
  private readonly fRoll = new Float32Array(MAX_FLASHES);
  private fCursor = 0;
  private alive = 0;

  constructor() {
    const additive = (map: THREE.Texture, color: number) =>
      new THREE.MeshBasicMaterial({ map, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: false, side: THREE.DoubleSide });
    const quad = new THREE.PlaneGeometry(1, 1);
    this.tracers = new THREE.InstancedMesh(quad, additive(streakTexture(), 0xffd59a), MAX_TRACERS);
    this.stars = new THREE.InstancedMesh(quad, additive(starTexture(), 0xffcf8a), MAX_FLASHES);
    // Flame cone: a quad along +Y from its base, turned to lie along the barrel.
    const cone = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
    this.cones = new THREE.InstancedMesh(cone, additive(flameTexture(), 0xffb867), MAX_FLASHES);
    for (const im of [this.tracers, this.stars, this.cones]) {
      for (let i = 0; i < im.count; i++) im.setMatrixAt(i, _hidden);
      im.frustumCulled = false;
      im.renderOrder = 4;
    }
    this.group.name = 'CombatEffects';
    this.group.add(this.tracers, this.stars, this.cones);
  }

  /** A round from `from` that the hitscan ended at `to`. */
  tracer(from: THREE.Vector3, to: THREE.Vector3): void {
    const len = from.distanceTo(to);
    if (len < 1) return;
    const i = this.tCursor;
    this.tCursor = (this.tCursor + 1) % MAX_TRACERS;
    if (this.tAge[i] >= this.tLife[i]) this.alive++;
    this.tFrom[i].copy(from);
    this.tTo[i].copy(to);
    this.tAge[i] = 0;
    this.tLife[i] = (len + TRACER_LENGTH) / TRACER_SPEED;
  }

  /** Muzzle flash at `pos` for a barrel pointing along `dir` (normalized). */
  flash(pos: THREE.Vector3, dir: THREE.Vector3, size = 1): void {
    const i = this.fCursor;
    this.fCursor = (this.fCursor + 1) % MAX_FLASHES;
    if (this.fAge[i] >= FLASH_LIFE) this.alive++;
    this.fPos[i].copy(pos);
    this.fDir[i].copy(dir);
    this.fAge[i] = 0;
    this.fSize[i] = size * (0.8 + Math.random() * 0.45);
    this.fRoll[i] = Math.random() * Math.PI;
  }

  update(dt: number, camera: THREE.Camera): void {
    if (this.alive === 0) return;
    const cam = camera.position;
    for (let i = 0; i < MAX_TRACERS; i++) {
      if (this.tAge[i] >= this.tLife[i]) continue;
      this.tAge[i] += dt;
      if (this.tAge[i] >= this.tLife[i]) {
        this.tracers.setMatrixAt(i, _hidden);
        this.alive--;
        continue;
      }
      // Head of the streak travels along the path; the tail trails by TRACER_LENGTH.
      const total = this.tFrom[i].distanceTo(this.tTo[i]);
      const head = Math.min(this.tAge[i] * TRACER_SPEED, total);
      const tail = Math.max(0, head - TRACER_LENGTH);
      _y.subVectors(this.tTo[i], this.tFrom[i]).normalize();
      _a.copy(this.tFrom[i]).addScaledVector(_y, tail);
      _b.copy(this.tFrom[i]).addScaledVector(_y, head);
      // Quad along the path, its width turned toward the camera.
      _p.addVectors(_a, _b).multiplyScalar(0.5);
      _z.subVectors(cam, _p).normalize();
      _x.crossVectors(_y, _z).normalize();
      _z.crossVectors(_x, _y);
      const width = TRACER_WIDTH * (1 + _p.distanceTo(cam) * 0.02);
      _m.makeBasis(_x.multiplyScalar(width), _y.multiplyScalar(Math.max(head - tail, 0.01)), _z);
      _m.setPosition(_p);
      this.tracers.setMatrixAt(i, _m);
    }
    for (let i = 0; i < MAX_FLASHES; i++) {
      if (this.fAge[i] >= FLASH_LIFE) continue;
      this.fAge[i] += dt;
      if (this.fAge[i] >= FLASH_LIFE) {
        this.stars.setMatrixAt(i, _hidden);
        this.cones.setMatrixAt(i, _hidden);
        this.alive--;
        continue;
      }
      const k = this.fSize[i] * (1 - (this.fAge[i] / FLASH_LIFE) * 0.4);
      _roll.setFromAxisAngle(_fwd, this.fRoll[i]);
      _q.copy(camera.quaternion).multiply(_roll);
      _m.compose(this.fPos[i], _q, _s.set(0.32 * k, 0.32 * k, 1));
      this.stars.setMatrixAt(i, _m);
      // Cone: base at the muzzle, length along the barrel, facing the camera around that axis.
      _y.copy(this.fDir[i]);
      _z.subVectors(cam, this.fPos[i]).normalize();
      _x.crossVectors(_y, _z).normalize();
      _z.crossVectors(_x, _y);
      _m.makeBasis(_x.multiplyScalar(0.12 * k), _y.multiplyScalar(0.36 * k), _z);
      _m.setPosition(this.fPos[i]);
      this.cones.setMatrixAt(i, _m);
    }
    this.tracers.instanceMatrix.needsUpdate = true;
    this.stars.instanceMatrix.needsUpdate = true;
    this.cones.instanceMatrix.needsUpdate = true;
  }

  clear(): void {
    this.tAge.fill(Infinity);
    this.fAge.fill(Infinity);
    for (const im of [this.tracers, this.stars, this.cones]) {
      for (let i = 0; i < im.count; i++) im.setMatrixAt(i, _hidden);
      im.instanceMatrix.needsUpdate = true;
    }
    this.alive = 0;
  }

  /** Tracers + flashes on screen (tests / debugging). */
  get active(): number {
    return this.alive;
  }
}

function tex(draw: (g: CanvasRenderingContext2D, w: number, h: number) => void, w: number, h: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Bright core line, soft edges, brighter toward the head (top). */
function streakTexture(): THREE.CanvasTexture {
  return tex((g, w, h) => {
    const across = g.createLinearGradient(0, 0, w, 0);
    across.addColorStop(0, 'rgba(255,255,255,0)');
    across.addColorStop(0.5, 'rgba(255,255,255,1)');
    across.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = across;
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'destination-in';
    const along = g.createLinearGradient(0, h, 0, 0);
    along.addColorStop(0, 'rgba(255,255,255,0)');
    along.addColorStop(1, 'rgba(255,255,255,1)');
    g.fillStyle = along;
    g.fillRect(0, 0, w, h);
  }, 16, 64);
}

function starTexture(): THREE.CanvasTexture {
  return tex((g, w) => {
    const c = w / 2;
    const glow = g.createRadialGradient(c, c, 0, c, c, c);
    glow.addColorStop(0, 'rgba(255,255,240,1)');
    glow.addColorStop(0.2, 'rgba(255,220,150,0.85)');
    glow.addColorStop(1, 'rgba(255,150,60,0)');
    g.fillStyle = glow;
    g.beginPath();
    for (let i = 0; i < 12; i++) {
      const r = i % 2 === 0 ? c * (0.75 + Math.random() * 0.25) : c * 0.22;
      const a = (i / 12) * Math.PI * 2;
      g.lineTo(c + Math.cos(a) * r, c + Math.sin(a) * r);
    }
    g.closePath();
    g.fill();
  }, 64, 64);
}

/** Flame tongue: wide and hot at the base (bottom), tapering out. */
function flameTexture(): THREE.CanvasTexture {
  return tex((g, w, h) => {
    const grad = g.createLinearGradient(0, h, 0, 0);
    grad.addColorStop(0, 'rgba(255,245,220,1)');
    grad.addColorStop(0.4, 'rgba(255,190,90,0.8)');
    grad.addColorStop(1, 'rgba(255,120,40,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(w * 0.15, h);
    g.quadraticCurveTo(w * 0.2, h * 0.35, w * 0.5, 0);
    g.quadraticCurveTo(w * 0.8, h * 0.35, w * 0.85, h);
    g.closePath();
    g.fill();
  }, 32, 64);
}
