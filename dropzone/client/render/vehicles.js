/* =========================================================================
   Vehicle rendering: merged body per type/colour + spinning wheels,
   ground-following attitude, burnt wreck look.
   ========================================================================= */
import * as THREE from 'three';
import { BoxBatch } from './world-view.js';
import { VEHICLES } from '../../shared/vehicles.js';

const PAINT = [0x8a2f2a, 0x2f4f7a, 0x3e5d3a, 0xb8a36a, 0x545a60, 0xd8d4c8, 0x6a3d6e, 0x2a2a2a];
const C = (h) => new THREE.Color(h);
const geoCache = new Map();

function bodyGeometry(type, paint) {
  const key = type + paint;
  if (geoCache.has(key)) return geoCache.get(key);
  const D = VEHICLES[type], b = new BoxBatch();
  const P = C(PAINT[paint % PAINT.length]), dark = C(0x222426), glass = C(0x2c3a44), light = C(0xe8e0b8), red = C(0xa02020), seat = C(0x3a3430), metal = C(0x5a6066);
  const box = (x0, y0, z0, x1, y1, z1, c) => b.add(x0, y0, z0, x1, y1, z1, c, { ao: false });
  const w = D.wid / 2, l = D.len / 2;
  if (type === 'sedan' || type === 'suv') {
    const suv = type === 'suv';
    box(-w, 0.35, -l, w, D.bodyH, l, P);                                   // lower body
    box(-w + 0.08, D.bodyH, -l * 0.45, w - 0.08, D.hgt - 0.05, suv ? l * 0.95 : l * 0.55, glass);  // cabin glass
    box(-w + 0.06, D.hgt - 0.08, -l * 0.42, w - 0.06, D.hgt, suv ? l * 0.95 : l * 0.52, P);          // roof
    for (const x of [-w + 0.02, w - 0.08]) box(x, D.bodyH, -l * 0.45, x + 0.06, D.hgt - 0.08, -l * 0.4, P);   // A pillars
    box(-w, 0.3, -l - 0.05, w, 0.55, -l + 0.1, dark);                      // bumpers
    box(-w, 0.3, l - 0.1, w, 0.55, l + 0.05, dark);
    box(-w + 0.1, 0.62, -l - 0.06, -w + 0.4, 0.75, -l, light); box(w - 0.4, 0.62, -l - 0.06, w - 0.1, 0.75, -l, light);
    box(-w + 0.1, 0.62, l, -w + 0.35, 0.75, l + 0.06, red); box(w - 0.35, 0.62, l, w - 0.1, 0.75, l + 0.06, red);
    if (suv) box(-w + 0.1, D.hgt, -l * 0.3, w - 0.1, D.hgt + 0.08, l * 0.8, metal);                    // roof rack
  } else if (type === 'buggy') {
    box(-w + 0.15, 0.35, -l + 0.2, w - 0.15, 0.6, l - 0.2, dark);          // floor pan
    box(-w + 0.1, 0.6, -l, w - 0.1, 0.8, -l + 0.9, P);                     // nose
    box(-w + 0.25, 0.6, l - 0.9, w - 0.25, 0.95, l, metal);                // engine
    for (const x of [-0.4, 0.4]) box(x - 0.25, 0.6, -0.2, x + 0.25, 0.75, 0.45, seat);
    // roll cage
    for (const [x, z] of [[-w + 0.12, -0.5], [w - 0.18, -0.5], [-w + 0.12, 0.7], [w - 0.18, 0.7]]) box(x, 0.6, z, x + 0.06, D.hgt, z + 0.06, metal);
    box(-w + 0.12, D.hgt - 0.06, -0.5, w - 0.12, D.hgt, 0.76, metal);
  } else if (type === 'moto') {
    box(-0.12, 0.45, -0.75, 0.12, 0.75, 0.55, P);                          // tank / body
    box(-0.14, 0.72, -0.05, 0.14, 0.82, 0.75, seat);                        // seat
    box(-0.08, 0.35, -0.95, 0.08, 1.0, -0.8, metal);                        // fork
    box(-0.35, 0.98, -0.9, 0.35, 1.03, -0.85, dark);                        // handlebar
    box(-0.08, 0.8, -1.0, 0.08, 0.9, -0.95, light);
    box(-0.1, 0.3, -0.2, 0.1, 0.5, 0.3, metal);                             // engine
  }
  const g = b.build();
  geoCache.set(key, g);
  return g;
}

const WHEEL_GEO = new THREE.CylinderGeometry(1, 1, 1, 12).rotateZ(Math.PI / 2);
const WHEEL_MAT = new THREE.MeshLambertMaterial({ color: 0x1c1c1c });
const BODY_MAT = new THREE.MeshLambertMaterial({ vertexColors: true });
const WRECK_MAT = new THREE.MeshLambertMaterial({ color: 0x2a2624 });

function wheelLayout(type) {
  const D = VEHICLES[type], w = D.wid / 2, l = D.len / 2;
  if (type === 'moto') return { r: 0.34, width: 0.12, pos: [[0, -l + 0.35], [0, l - 0.35]] };
  const r = type === 'suv' ? 0.42 : type === 'buggy' ? 0.45 : 0.36;
  const inset = type === 'buggy' ? -0.05 : 0.08;
  return { r, width: type === 'buggy' ? 0.35 : 0.26, pos: [[-w + inset, -l + 0.8], [w - inset, -l + 0.8], [-w + inset, l - 0.75], [w - inset, l - 0.75]] };
}

export class VehicleView {
  constructor(scene, v, shadows) {
    this.root = new THREE.Group();
    this.root.rotation.order = 'YXZ';
    this.body = new THREE.Mesh(bodyGeometry(v.type, v.color || 0), BODY_MAT);
    this.body.castShadow = shadows;
    this.root.add(this.body);
    const L = wheelLayout(v.type);
    this.wheels = L.pos.map(([x, z], i) => {
      const m = new THREE.Mesh(WHEEL_GEO, WHEEL_MAT);
      m.scale.set(L.width, L.r, L.r);
      m.position.set(x, L.r, z);
      m.userData.front = i < 2 || v.type === 'moto' && i === 0;
      this.root.add(m);
      return m;
    });
    this.wheelR = L.r;
    this.spin = 0;
    this.wrecked = false;
    scene.add(this.root);
  }
  update(v, x, y, z, yaw, dt) {
    this.root.position.set(x, y, z);
    this.root.rotation.set(v.pitch, yaw, -v.roll);
    this.spin -= (v.speed * dt) / this.wheelR;
    for (const w of this.wheels) {
      w.rotation.x = this.spin;
      w.rotation.y = w.userData.front ? v.steer * -0.45 : 0;
    }
    if (v.dead && !this.wrecked) {
      this.wrecked = true;
      this.body.material = WRECK_MAT;
      for (const w of this.wheels) w.visible = false;
      this.root.position.y -= 0.2;
    }
  }
  dispose(scene) { scene.remove(this.root); }
}
