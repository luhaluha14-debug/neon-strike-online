import * as THREE from 'three';
import { ModelKit } from './ModelKit';
import type { ArmPose, HandGripProfile } from './HandGrip';
import type { WeaponAnimState, WeaponView } from './WeaponView';

/**
 * SR-01: AWP-style bolt-action sniper rifle (original placeholder model).
 *
 * Long fluted-look barrel with a muzzle brake, one-piece chassis stock
 * (forend → receiver bed → thumbhole grip → skeleton buttstock with cheek
 * riser), 5-round box magazine, big variable-power scope on two rings, and a
 * bolt with a ball knob on the right. ~1.3 m long. Parts are separate,
 * named groups (`Receiver`, `Barrel`, `Scope`, `Stock`, `Handguard`,
 * `Magazine`, `Bolt`, `Attachments`) so each can be animated or swapped.
 *
 * Only what the first-person camera can see is modelled in detail; the
 * buttstock (mostly behind the camera) is kept simple.
 */
export class SniperRifleView implements WeaponView {
  readonly object = new THREE.Group();
  readonly muzzle = new THREE.Object3D();
  readonly magazine = new THREE.Group();
  readonly bolt = new THREE.Group();
  readonly gripAnchor = new THREE.Object3D();
  readonly supportAnchor = new THREE.Object3D();
  /** Thumbhole grip: a little deeper front-to-back than a rifle pistol grip. */
  readonly rightHand: HandGripProfile = { width: 0.036, depth: 0.054, index: 'trigger', wristLift: 0.058 };
  /** Forearm leaves the thumbhole up and to the right instead of through the lower rail. */
  readonly armPose: ArmPose = { rightElbow: [0.26, -0.2, 0.4] };

  private readonly kit = new ModelKit();
  private readonly boltRest = new THREE.Vector3();

  constructor() {
    this.object.name = 'SR-01';
    const k = this.kit;

    // --- Materials ---------------------------------------------------------
    const gunmetal = k.mat({ color: 0x4a4f55, metalness: 0.85, roughness: 0.36 });
    const blued = k.mat({ color: 0x2f3439, metalness: 0.9, roughness: 0.28 });
    const steel = k.mat({ color: 0x9aa0a6, metalness: 1.0, roughness: 0.25 });
    const darkSteel = k.mat({ color: 0x1d2024, metalness: 0.7, roughness: 0.45 });
    const rubber = k.mat({ color: 0x18191b, metalness: 0.0, roughness: 0.95 });
    const scopeBody = k.mat({ color: 0x4d5b2e, metalness: 0.55, roughness: 0.38 }); // olive anodized
    const scopeDark = k.mat({ color: 0x23262a, metalness: 0.6, roughness: 0.42 });
    const lensFront = k.mat({ color: 0x0f3346, metalness: 1.0, roughness: 0.05, emissive: 0x051820, emissiveIntensity: 0.6 });
    const lensRear = k.mat({ color: 0x0a0d10, metalness: 0.9, roughness: 0.08 });
    const stockPolymer = k.mat({
      map: makeStockPattern(k),
      color: 0xffffff,
      metalness: 0.05,
      roughness: 0.62,
    });
    stockPolymer.map!.wrapS = stockPolymer.map!.wrapT = THREE.RepeatWrapping;
    stockPolymer.map!.repeat.set(4, 4); // UVs are meters: ~25 cm per tile
    const polymerDark = k.mat({ color: 0x2b3038, metalness: 0.05, roughness: 0.7 });

    const BORE_Y = 0.04;

    // --- Handguard / forend (front part of the one-piece chassis) ------------
    const handguard = group(this.object, 'Handguard');
    k.profile(
      handguard,
      [
        [0.02, 0.022],
        [-0.46, 0.022],
        [-0.476, 0.002],
        [-0.468, -0.028],
        [-0.44, -0.038],
        [-0.08, -0.038],
        [-0.06, -0.032],
        [0.02, -0.032],
      ],
      0.054,
      stockPolymer,
      { bevel: 0.003 },
    );
    // Vent slots along both sides and a sling/bipod stud underneath.
    for (let i = 0; i < 4; i++) {
      for (const side of [-1, 1]) k.box(handguard, [0.002, 0.012, 0.045], polymerDark, [side * 0.0285, -0.006, -0.2 - i * 0.06]);
    }
    k.cyl(handguard, 0.006, 0.006, 0.012, steel, [0, -0.044, -0.42], 'y', 10);

    // --- Receiver --------------------------------------------------------------
    const receiver = group(this.object, 'Receiver');
    k.cyl(receiver, 0.022, 0.022, 0.23, gunmetal, [0, BORE_Y, -0.015], 'z', 20);
    k.cyl(receiver, 0.0235, 0.0235, 0.014, darkSteel, [0, BORE_Y, -0.125], 'z', 20); // recoil lug ring
    k.box(receiver, [0.004, 0.016, 0.065], darkSteel, [0.0205, BORE_Y + 0.006, 0.0]); // ejection port
    // Scope rail with cross slots.
    k.box(receiver, [0.022, 0.008, 0.22], gunmetal, [0, 0.066, -0.015]);
    for (let i = 0; i < 7; i++) k.box(receiver, [0.023, 0.003, 0.004], darkSteel, [0, 0.0705, 0.07 - i * 0.028]);

    // --- Barrel ------------------------------------------------------------------
    const barrel = group(this.object, 'Barrel');
    k.cyl(barrel, 0.0135, 0.0105, 0.67, blued, [0, BORE_Y, -0.465], 'z', 18);
    // Muzzle brake with side ports.
    k.cyl(barrel, 0.0165, 0.0165, 0.07, gunmetal, [0, BORE_Y, -0.835], 'z', 16);
    for (let i = 0; i < 3; i++) {
      for (const side of [-1, 1]) k.box(barrel, [0.004, 0.01, 0.012], darkSteel, [side * 0.0155, BORE_Y, -0.815 - i * 0.02]);
    }
    this.muzzle.name = 'Muzzle';
    this.muzzle.position.set(0, BORE_Y, -0.875);
    this.object.add(this.muzzle);

    // --- Scope (two rings, olive main tube, dark bells) --------------------------
    const scope = group(this.object, 'Scope');
    const SY = 0.112;
    for (const z of [0.05, -0.09]) {
      k.box(scope, [0.026, 0.03, 0.016], scopeDark, [0, 0.084, z]); // ring base
      k.cyl(scope, 0.0195, 0.0195, 0.016, scopeDark, [0, SY, z], 'z', 20); // ring
      k.cyl(scope, 0.003, 0.003, 0.03, steel, [0.012, 0.098, z], 'x', 8); // cross bolt
    }
    k.cyl(scope, 0.0155, 0.0155, 0.24, scopeBody, [0, SY, -0.02], 'z', 24); // main tube
    // Eyepiece (toward the shooter).
    k.cyl(scope, 0.021, 0.0155, 0.02, scopeBody, [0, SY, 0.11], 'z', 24);
    k.cyl(scope, 0.021, 0.021, 0.05, scopeDark, [0, SY, 0.145], 'z', 24);
    k.cyl(scope, 0.0225, 0.0215, 0.012, rubber, [0, SY, 0.176], 'z', 24);
    k.disc(scope, 0.0175, lensRear, [0, SY, 0.182]);
    // Objective bell.
    k.cyl(scope, 0.0155, 0.027, 0.045, scopeBody, [0, SY, -0.162], 'z', 28);
    k.cyl(scope, 0.027, 0.027, 0.075, scopeBody, [0, SY, -0.222], 'z', 28);
    k.cyl(scope, 0.0285, 0.0285, 0.012, scopeDark, [0, SY, -0.264], 'z', 28);
    k.disc(scope, 0.024, lensFront, [0, SY, -0.2705], false);
    // Turrets: elevation (top), windage (right), parallax (left).
    k.cyl(scope, 0.0115, 0.0115, 0.024, scopeDark, [0, SY + 0.026, -0.02], 'y', 16);
    k.cyl(scope, 0.013, 0.013, 0.008, gunmetal, [0, SY + 0.041, -0.02], 'y', 16);
    k.cyl(scope, 0.0115, 0.0115, 0.022, scopeDark, [0.026, SY, -0.02], 'x', 16);
    k.cyl(scope, 0.009, 0.009, 0.014, scopeDark, [-0.022, SY, -0.02], 'x', 14);
    // Magnification ring on the eyepiece.
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      k.box(scope, [0.004, 0.004, 0.03], rubber, [Math.cos(a) * 0.021, SY + Math.sin(a) * 0.021, 0.145], [0, 0, a]);
    }

    // --- Stock: thumbhole grip + skeleton buttstock ------------------------------
    const stock = group(this.object, 'Stock');
    k.profile(
      stock,
      [
        [0.02, 0.022],
        [0.11, 0.03],
        [0.16, 0.062],
        [0.44, 0.062],
        [0.448, 0.0],
        [0.445, -0.165],
        [0.4, -0.165],
        [0.36, -0.115],
        [0.105, -0.128],
        [0.095, -0.148],
        [0.055, -0.14],
        [0.035, -0.05],
        [0.02, -0.032],
      ],
      0.036,
      stockPolymer,
      {
        bevel: 0.003,
        holes: [
          [
            [0.085, -0.06],
            [0.11, -0.11],
            [0.33, -0.098],
            [0.35, -0.01],
            [0.17, 0.032],
            [0.115, 0.008],
          ],
        ],
      },
    );
    k.box(stock, [0.03, 0.012, 0.17], polymerDark, [0, 0.07, 0.29]); // cheek riser
    for (const z of [0.23, 0.35]) k.cyl(stock, 0.004, 0.004, 0.012, steel, [0, 0.064, z], 'y', 8);
    k.box(stock, [0.04, 0.23, 0.016], rubber, [0, -0.052, 0.455]); // butt pad
    // Trigger guard and trigger.
    k.box(stock, [0.012, 0.006, 0.062], darkSteel, [0, -0.086, 0.007]);
    k.box(stock, [0.012, 0.056, 0.006], darkSteel, [0, -0.06, -0.024]);
    k.box(stock, [0.006, 0.03, 0.006], steel, [0, -0.052, 0.016], [0.25, 0, 0]);

    // --- Magazine (own group: reload animation moves it) -------------------------
    this.magazine.name = 'Magazine';
    this.magazine.position.set(0, -0.05, -0.065);
    k.box(this.magazine, [0.03, 0.058, 0.07], polymerDark, [0, 0, 0]);
    k.box(this.magazine, [0.034, 0.008, 0.074], darkSteel, [0, -0.031, 0]);
    k.box(this.magazine, [0.008, 0.012, 0.01], steel, [0, 0.016, 0.039]); // release catch
    this.object.add(this.magazine);

    // --- Bolt (own group, pivot on the bore axis: rotate on Z to lift, move on Z to cycle)
    this.bolt.name = 'Bolt';
    this.bolt.position.set(0, BORE_Y, 0.07);
    this.boltRest.copy(this.bolt.position);
    k.cyl(this.bolt, 0.0165, 0.0165, 0.05, gunmetal, [0, 0, 0.055], 'z', 18); // bolt shroud
    k.cyl(this.bolt, 0.012, 0.0145, 0.012, darkSteel, [0, 0, 0.086], 'z', 16); // cocking piece
    const handle = new THREE.Group();
    handle.rotation.z = -0.55; // handle swept down to the right
    this.bolt.add(handle);
    k.cyl(handle, 0.0045, 0.0045, 0.045, steel, [0.035, 0, 0], 'x', 10);
    k.mesh(handle, new THREE.SphereGeometry(0.0115, 16, 12), darkSteel, [0.062, 0, 0]); // knob
    this.object.add(this.bolt);

    // --- Attachments: sling swivel on the butt -----------------------------------
    const attachments = group(this.object, 'Attachments');
    k.cyl(attachments, 0.007, 0.007, 0.004, steel, [0.02, -0.12, 0.39], 'x', 12);

    // --- Hand anchors --------------------------------------------------------------
    // Firing hand on the thumbhole grip: grip axis leans forward at the top.
    this.gripAnchor.name = 'Grip_R';
    this.gripAnchor.position.set(0, -0.095, 0.074);
    this.gripAnchor.rotation.x = -0.22;
    // Support hand under the forend, ahead of the magazine.
    this.supportAnchor.name = 'Grip_L';
    this.supportAnchor.position.set(0, -0.038, -0.3);
    this.object.add(this.gripAnchor, this.supportAnchor);

    this.object.traverse((o) => {
      o.frustumCulled = false;
    });
  }

  animate(state: WeaponAnimState): void {
    animateBolt(this.bolt, this.boltRest, state);
  }

  dispose(): void {
    this.kit.dispose();
  }
}

/**
 * Bolt cycle after each shot: lift the handle, pull back, push forward,
 * lock down. Shared with GLB models that have a `Bolt` node.
 */
export function animateBolt(bolt: THREE.Object3D, rest: THREE.Vector3, state: WeaponAnimState, travel = 0.085): void {
  const cycle = Math.min(state.fireInterval, 1.4);
  // Starts once the recoil settles, finishes just before the next shot is allowed.
  const t = (state.sinceShot - 0.18) / (cycle - 0.3);
  let lift = 0;
  let back = 0;
  if (t > 0 && t < 1) {
    if (t < 0.2) lift = t / 0.2;
    else if (t < 0.8) {
      lift = 1;
      back = Math.sin(((t - 0.2) / 0.6) * Math.PI);
    } else lift = 1 - (t - 0.8) / 0.2;
  }
  bolt.rotation.z = smooth(lift) * 1.05;
  bolt.position.set(rest.x, rest.y, rest.z + back * travel);
}

function smooth(x: number): number {
  return x * x * (3 - 2 * x);
}

function group(parent: THREE.Object3D, name: string): THREE.Group {
  const g = new THREE.Group();
  g.name = name;
  parent.add(g);
  return g;
}

/**
 * Blue hydro-dip style pattern for the stock (inspired by the reference,
 * not copied): deep blue base, dark navy and pale grey swirls.
 */
function makeStockPattern(k: ModelKit): THREE.CanvasTexture {
  return k.canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = '#2e4f86';
    g.fillRect(0, 0, w, h);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const blob = (color: string, count: number, size: number) => {
      g.fillStyle = color;
      for (let i = 0; i < count; i++) {
        const x = rnd() * w;
        const y = rnd() * h;
        g.beginPath();
        // Irregular lobed blob.
        for (let a = 0; a <= 12; a++) {
          const ang = (a / 12) * Math.PI * 2;
          const r = size * (0.55 + rnd() * 0.6);
          g.lineTo(x + Math.cos(ang) * r, y + Math.sin(ang) * r * 0.7);
        }
        g.fill();
      }
    };
    blob('#1b2b4d', 26, 22);
    blob('#c9ced6', 12, 9);
    blob('#101828', 18, 7);
    // Fine speckle for a moulded-polymer feel.
    for (let i = 0; i < 900; i++) {
      g.fillStyle = rnd() < 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.08)';
      g.fillRect(rnd() * w, rnd() * h, 1, 1);
    }
  });
}
