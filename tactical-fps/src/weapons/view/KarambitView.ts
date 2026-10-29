import * as THREE from 'three';
import { ModelKit, planarUVsZY } from './ModelKit';
import type { HandGripProfile } from './HandGrip';
import type { WeaponView } from './WeaponView';

/**
 * Karambit (original placeholder model).
 *
 * Model space is the grip frame: the handle runs along +Y (finger ring on
 * top), the curved claw blade leaves the bottom of the fist and sweeps
 * forward (-Z) with the edge on the inside of the curve. The firing hand
 * closes around the handle with the index finger through the ring.
 *
 * Parts: `Blade` (teal/blue gradient finish), `Ring` + tang (same finish),
 * `Handle` (dark grey textured scales, pivot screws).
 */
export class KarambitView implements WeaponView {
  readonly object = new THREE.Group();
  readonly muzzle = null;
  readonly gripAnchor = new THREE.Object3D();
  readonly supportAnchor = null;
  readonly rightHand: HandGripProfile = { width: 0.022, depth: 0.03, index: 'ring' };

  private readonly kit = new ModelKit();

  constructor() {
    this.object.name = 'KARAMBIT';
    const k = this.kit;

    const finish = k.mat({
      map: makeBladeFinish(k),
      color: 0xffffff,
      metalness: 0.92,
      roughness: 0.2,
      envMapIntensity: 1.3,
    });
    const ringFinish = k.mat({ color: 0x2f8f93, metalness: 0.9, roughness: 0.26 });
    const edgeSteel = k.mat({ color: 0xc8d4d8, metalness: 1.0, roughness: 0.16 });
    const scales = k.mat({ map: makeScaleTexture(k), color: 0xffffff, metalness: 0.08, roughness: 0.72 });
    scales.map!.wrapS = scales.map!.wrapT = THREE.RepeatWrapping;
    scales.map!.repeat.set(20, 20);
    const screw = k.mat({ color: 0xaab2b8, metalness: 1.0, roughness: 0.3 });
    const screwSlot = k.mat({ color: 0x1a1c1f, metalness: 0.5, roughness: 0.6 });

    // --- Blade: claw curve, edge on the concave side --------------------------
    const blade = group(this.object, 'Blade');
    const bladeShape = new THREE.Shape();
    bladeShape.moveTo(0.013, -0.044); // spine at the handle
    bladeShape.bezierCurveTo(0.022, -0.09, -0.008, -0.138, -0.06, -0.14);
    bladeShape.quadraticCurveTo(-0.104, -0.14, -0.126, -0.097); // tip
    bladeShape.quadraticCurveTo(-0.1, -0.113, -0.064, -0.114); // edge, near the tip
    bladeShape.bezierCurveTo(-0.028, -0.113, -0.012, -0.088, -0.014, -0.046);
    bladeShape.closePath();
    const bladeMesh = k.extrudeShape(blade, bladeShape, 0.0055, finish, { bevel: 0.0018, curveSegments: 24 });
    planarUVsZY(bladeMesh.geometry);
    // Polished cutting-edge bevel: a thin bright strip just inside the concave edge.
    const edge = new THREE.Shape();
    edge.moveTo(-0.122, -0.099);
    edge.quadraticCurveTo(-0.098, -0.114, -0.064, -0.115);
    edge.bezierCurveTo(-0.03, -0.114, -0.016, -0.09, -0.017, -0.05);
    edge.lineTo(-0.012, -0.05);
    edge.bezierCurveTo(-0.01, -0.085, -0.026, -0.108, -0.064, -0.109);
    edge.quadraticCurveTo(-0.096, -0.108, -0.12, -0.098);
    edge.closePath();
    k.extrudeShape(blade, edge, 0.0062, edgeSteel, { curveSegments: 20 });
    // Spine jimping (thumb grip notches).
    for (let i = 0; i < 6; i++) {
      const t = i / 5;
      k.box(blade, [0.0062, 0.0022, 0.004], edgeSteel, [0, -0.05 - t * 0.022, 0.0165 - t * 0.0015], [0.15, 0, 0]);
    }

    // --- Tang + finger ring (one steel piece) ---------------------------------
    const ring = group(this.object, 'Ring');
    k.profile(
      ring,
      [
        [0.013, 0.03],
        [0.015, -0.046],
        [-0.014, -0.046],
        [-0.013, 0.03],
      ],
      0.005,
      ringFinish,
      { bevel: 0.001 },
    );
    const torus = new THREE.TorusGeometry(0.0165, 0.0048, 12, 32);
    torus.rotateY(Math.PI / 2); // ring plane = YZ, the finger goes through along X
    k.mesh(ring, torus, ringFinish, [0, 0.046, 0]);

    // --- Handle scales (both sides), slightly waisted for the fingers ----------
    const handle = group(this.object, 'Handle');
    const scaleOutline: [number, number][] = [
      [-0.0135, 0.029],
      [0.0125, 0.029],
      [0.0145, 0.012],
      [0.0125, -0.006],
      [0.0145, -0.026],
      [0.014, -0.043],
      [-0.013, -0.043],
      [-0.015, -0.026],
      [-0.0125, -0.008],
      [-0.0148, 0.01],
    ];
    for (const side of [-1, 1]) {
      k.profile(handle, scaleOutline, 0.0075, scales, { bevel: 0.0018, x: side * 0.0065 });
      for (const y of [0.018, -0.032]) {
        k.cyl(handle, 0.003, 0.003, 0.002, screw, [side * 0.0108, y, 0], 'x', 12);
        k.box(handle, [0.0008, 0.0045, 0.0009], screwSlot, [side * 0.0117, y, 0]);
      }
    }

    // Grip frame = model origin (handle center).
    this.gripAnchor.name = 'Grip_R';
    this.object.add(this.gripAnchor);

    this.object.traverse((o) => {
      o.frustumCulled = false;
    });
  }

  dispose(): void {
    this.kit.dispose();
  }
}

function group(parent: THREE.Object3D, name: string): THREE.Group {
  const g = new THREE.Group();
  g.name = name;
  parent.add(g);
  return g;
}

/**
 * Teal → blue → green "doppler"-style gradient with darker liquid streaks
 * and bright highlights, generated in code (u = along the blade, v = across).
 */
function makeBladeFinish(k: ModelKit): THREE.CanvasTexture {
  return k.canvasTexture(512, 256, (g, w, h) => {
    const base = g.createLinearGradient(0, h, w, 0);
    base.addColorStop(0, '#0f6b5f');
    base.addColorStop(0.3, '#1aa39a');
    base.addColorStop(0.55, '#1f6fae');
    base.addColorStop(0.8, '#20a86f');
    base.addColorStop(1, '#0c4f6e');
    g.fillStyle = base;
    g.fillRect(0, 0, w, h);
    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    // Flowing dark and light streaks.
    for (let i = 0; i < 26; i++) {
      const y0 = rnd() * h;
      const amp = 8 + rnd() * 26;
      const freq = 0.01 + rnd() * 0.025;
      const phase = rnd() * Math.PI * 2;
      const dark = rnd() < 0.6;
      g.strokeStyle = dark ? `rgba(6, 30, 52, ${0.25 + rnd() * 0.35})` : `rgba(170, 255, 236, ${0.12 + rnd() * 0.25})`;
      g.lineWidth = 2 + rnd() * (dark ? 9 : 4);
      g.beginPath();
      for (let x = 0; x <= w; x += 6) g.lineTo(x, y0 + Math.sin(x * freq + phase) * amp);
      g.stroke();
    }
    // Soft bright bloom near the tip area.
    const glow = g.createRadialGradient(w * 0.2, h * 0.3, 4, w * 0.2, h * 0.3, w * 0.35);
    glow.addColorStop(0, 'rgba(140, 255, 230, 0.35)');
    glow.addColorStop(1, 'rgba(140, 255, 230, 0)');
    g.fillStyle = glow;
    g.fillRect(0, 0, w, h);
  });
}

/** Dark grey G10-style texture for the handle scales. */
function makeScaleTexture(k: ModelKit): THREE.CanvasTexture {
  return k.canvasTexture(128, 128, (g, w, h) => {
    g.fillStyle = '#34373b';
    g.fillRect(0, 0, w, h);
    let seed = 3;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let y = 0; y < h; y += 3) {
      g.fillStyle = `rgba(${rnd() < 0.5 ? '255,255,255' : '0,0,0'}, ${0.04 + rnd() * 0.06})`;
      g.fillRect(0, y, w, 1 + Math.round(rnd()));
    }
    for (let i = 0; i < 600; i++) {
      g.fillStyle = rnd() < 0.5 ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.12)';
      g.fillRect(rnd() * w, rnd() * h, 1, 1);
    }
  });
}
