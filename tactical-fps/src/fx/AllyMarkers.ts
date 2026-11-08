import * as THREE from 'three';

// A small chevron over each teammate's head (team match only), as tactical
// shooters do, so a friendly figure is never mistaken for an enemy in a
// fast exchange. Deliberately limited:
//   - allies only: nothing is ever drawn for an enemy;
//   - depth tested: hidden by walls like the ally itself (no seeing through
//     walls, nothing about anyone's position beyond what is in view);
//   - keeps about the same size on screen with distance (clamped), fades out
//     close up (the ally is plainly there) and far away.
// All markers are one InstancedMesh (one draw call), reused every frame.

export const MAX_ALLY_MARKERS = 8;
/** Height of the chevron's lower tip above an ally's feet (m): just clear of the helmet. */
const ABOVE_HEAD = 2.0;
/** On-screen size: world size per metre of distance (≈ 15 px wide at 540 px tall, 78° FOV), clamped (m). */
const SIZE_PER_M = 0.04;
const MIN_SIZE = 0.16;
const MAX_SIZE = 3.2;
/** Fully shown between these distances (m); faded outside. */
const NEAR = 4;
const FAR = 70;

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _hidden = new THREE.Matrix4().makeScale(0, 0, 0);
const _c = new THREE.Color();
const _faded = new THREE.Color();

export class AllyMarkers {
  readonly mesh: THREE.InstancedMesh;
  private shown = 0;

  constructor() {
    const material = new THREE.MeshBasicMaterial({
      map: chevronTexture(),
      transparent: true,
      depthWrite: false,
      depthTest: true,
      toneMapped: false,
      fog: false,
    });
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), material, MAX_ALLY_MARKERS);
    this.mesh.name = 'AllyMarkers';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    for (let i = 0; i < MAX_ALLY_MARKERS; i++) {
      this.mesh.setMatrixAt(i, _hidden);
      this.mesh.setColorAt(i, _c.setRGB(1, 1, 1));
    }
  }

  /** How many markers are showing (tests). */
  get count(): number {
    return this.shown;
  }

  /**
   * Places one marker per ally (feet positions, alive ones only), facing `camera`, in team `color`.
   * Pass an empty list outside team matches.
   */
  update(camera: THREE.Camera, allies: readonly THREE.Vector3[], color: number): void {
    let n = 0;
    _c.setHex(color);
    for (const feet of allies) {
      if (n >= MAX_ALLY_MARKERS) break;
      _p.set(feet.x, feet.y + ABOVE_HEAD, feet.z);
      const d = _p.distanceTo(camera.position);
      const size = THREE.MathUtils.clamp(d * SIZE_PER_M, MIN_SIZE, MAX_SIZE);
      // Grows upward with distance: the tip stays just over the head, never across the body.
      _p.y += size * 0.3;
      const fade = Math.min(1, Math.max(0, (d - NEAR * 0.5) / (NEAR * 0.5))) * Math.min(1, Math.max(0, (FAR - d) / 15));
      if (fade <= 0.02) continue;
      _m.compose(_p, camera.quaternion, _s.set(size, size * 0.6, 1));
      this.mesh.setMatrixAt(n, _m);
      // Fade through the instance colour (additive-free: the texture's alpha keeps the shape).
      this.mesh.setColorAt(n, _faded.copy(_c).multiplyScalar(0.35 + 0.65 * fade));
      n++;
    }
    for (let i = n; i < this.shown; i++) this.mesh.setMatrixAt(i, _hidden);
    this.shown = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

/** A downward chevron with a thin dark edge (reads on sky and on walls alike). */
function chevronTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 40;
  const g = c.getContext('2d')!;
  const path = () => {
    g.beginPath();
    g.moveTo(6, 6);
    g.lineTo(32, 32);
    g.lineTo(58, 6);
    g.lineTo(46, 6);
    g.lineTo(32, 20);
    g.lineTo(18, 6);
    g.closePath();
  };
  path();
  g.lineWidth = 5;
  g.strokeStyle = 'rgba(0,0,0,0.55)';
  g.stroke();
  path();
  g.fillStyle = '#ffffff';
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
