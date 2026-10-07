import * as THREE from 'three';
import { PISTOL_GRIP, type ArmPose, type HandGripProfile } from './HandGrip';

/**
 * Procedural first-person arms: tactical gloves and jacket sleeves built from
 * capsules and boxes. They attach to two anchors on the weapon model
 * (`gripAnchor` for the firing hand, `supportAnchor` for the off hand), so
 * any weapon view — including a future Blender GLB — gets hands.
 *
 * Anchor frames: origin on the grip / under the handguard, +Y up along the
 * grip, +Z toward the stock, +X to the right. Units are meters.
 */
export class FirstPersonArms {
  readonly object = new THREE.Group();

  private readonly right = new THREE.Group();
  private readonly left = new THREE.Group();
  private readonly rightForearm: Limb;
  private readonly leftForearm: Limb;
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];

  /**
   * Elbows sit just off-screen, below and behind the weapon (weapon space).
   * Weapons can override them (WeaponView.armPose); mutable for live tuning.
   */
  readonly rightElbow = new THREE.Vector3(0.17, -0.33, 0.42);
  readonly leftElbow = new THREE.Vector3(-0.34, -0.34, 0.12);
  private readonly rightWristLocal = new THREE.Vector3(0.02, -0.058, 0.062);
  private readonly leftWristLocal = new THREE.Vector3(-0.006, -0.036, 0.05);

  private readonly glove: THREE.MeshStandardMaterial;
  private readonly pad: THREE.MeshStandardMaterial;
  private readonly sleeve: THREE.MeshStandardMaterial;
  private readonly cuff: THREE.MeshStandardMaterial;

  constructor(
    private readonly gripAnchor: THREE.Object3D,
    /** null = one-handed weapon: the left arm is hidden. */
    private readonly supportAnchor: THREE.Object3D | null,
    private readonly magazine?: THREE.Object3D,
    grip: HandGripProfile = PISTOL_GRIP,
    armPose?: ArmPose,
  ) {
    if (armPose?.rightElbow) this.rightElbow.set(...armPose.rightElbow);
    if (armPose?.leftElbow) this.leftElbow.set(...armPose.leftElbow);
    this.glove = this.mat(0x1c1d1f, 0.0, 0.82);
    this.pad = this.mat(0x2f3134, 0.1, 0.6);
    this.sleeve = this.mat(0x34372f, 0.0, 0.95);
    this.cuff = this.mat(0x2a2c27, 0.0, 0.9);

    this.buildRightHand(grip);
    this.buildLeftHand();
    this.rightForearm = this.limb(0.033, 0.05);
    this.leftForearm = this.limb(0.032, 0.05);
    this.object.add(this.right, this.left);
    if (!supportAnchor) {
      this.left.visible = false;
      this.leftForearm.group.visible = false;
    }

    this.object.traverse((o) => {
      o.frustumCulled = false;
    });
    this.update(null);
  }

  /** Call every frame after the weapon's own parts (magazine) have moved. */
  update(reloadProgress: number | null): void {
    // Right hand never leaves the grip.
    this.right.position.copy(this.gripAnchor.position);
    this.right.quaternion.copy(this.gripAnchor.quaternion);

    this.object.updateMatrixWorld(true);
    this.setLimb(this.rightForearm, _a.copy(this.rightWristLocal).applyMatrix4(this.right.matrix), this.rightElbow);
    if (!this.supportAnchor) return;

    // Left hand: on the handguard, or following the magazine during a reload.
    this.left.position.copy(this.supportAnchor.position);
    this.left.quaternion.copy(this.supportAnchor.quaternion);
    if (reloadProgress !== null && this.magazine) {
      const t = reloadProgress;
      const w = smoothstep(0.04, 0.18, t) * (1 - smoothstep(0.8, 0.95, t));
      _target.copy(this.magazine.position).add(MAG_GRAB_OFFSET);
      this.left.position.lerp(_target, w);
      _q.setFromEuler(MAG_GRAB_ROT);
      this.left.quaternion.slerp(_q, w);
    }

    this.left.updateMatrix();
    this.setLimb(this.leftForearm, _a.copy(this.leftWristLocal).applyMatrix4(this.left.matrix), this.leftElbow);
  }

  dispose(): void {
    this.geometries.forEach((g) => g.dispose());
    this.materials.forEach((m) => m.dispose());
  }

  /**
   * Firing hand, shaped from the weapon's grip profile. The reference shape
   * fits a 36 x 45 mm pistol grip; other grips move the finger rows and the
   * back of the hand in/out so the glove wraps the grip without clipping.
   */
  private buildRightHand(grip: HandGripProfile): void {
    const h = this.right;
    const dx = grip.width / 2 - PISTOL_GRIP.width / 2;
    const dz = grip.depth / 2 - PISTOL_GRIP.depth / 2;
    const R = (x: number) => x + dx; // right side of the grip
    const L = (x: number) => x - dx; // left side
    const F = (z: number) => z - dz; // front face
    const B = (z: number) => z + dz; // back strap
    const W = (y: number) => y + (grip.wristLift ?? 0); // wrist height

    // Back of the hand on the right side of the grip, palm heel behind it.
    this.box(h, 0.024, 0.078, 0.07 + dz, this.glove, R(0.03), 0.004, 0.016, 0, 0, -0.08);
    this.box(h, 0.042 + dx * 2, 0.06, 0.024, this.glove, 0.006, -0.008, B(0.034));
    // Knuckle protection and a wrist strap.
    this.box(h, 0.008, 0.064, 0.026, this.pad, R(0.044), 0.008, F(-0.006));
    this.box(h, 0.05 + dx * 2, 0.014, 0.034, this.pad, 0.018, W(-0.046), B(0.056), 0.3, 0, 0);

    // Middle, ring and little finger wrap around the front of the grip.
    const rows = [0.016, -0.008, -0.03];
    rows.forEach((y, i) => {
      const r = 0.0088 - i * 0.0007;
      this.capsule(h, r, this.glove, [R(0.03), y, 0.0], [R(0.03), y - 0.003, F(-0.032)]);
      this.capsule(h, r, this.glove, [R(0.028), y - 0.003, F(-0.034)], [L(-0.012), y - 0.004, F(-0.036)]);
      this.capsule(h, r * 0.92, this.glove, [L(-0.016), y - 0.004, F(-0.032)], [L(-0.024), y - 0.004, F(-0.01)]);
    });
    if (grip.index === 'trigger') {
      // Index finger resting on the trigger.
      this.capsule(h, 0.0085, this.glove, [R(0.031), 0.042, 0.002], [R(0.024), 0.04, F(-0.036)]);
      this.capsule(h, 0.008, this.glove, [R(0.022), 0.04, F(-0.038)], [0.004, 0.034, F(-0.052)]);
    } else {
      // Index finger straight through a finger ring centred above the grip (y ≈ 0.046).
      this.capsule(h, 0.0085, this.glove, [R(0.031), 0.044, 0.003], [0.0, 0.046, 0.0]);
      this.capsule(h, 0.0082, this.glove, [0.0, 0.046, 0.0], [L(-0.026), 0.045, 0.006]);
      this.capsule(h, 0.0078, this.glove, [L(-0.027), 0.044, 0.007], [L(-0.024), 0.036, B(0.02)]);
    }
    // Thumb wraps over the top on the left side.
    this.capsule(h, 0.0095, this.glove, [L(-0.012), 0.022, B(0.034)], [L(-0.03), 0.046, B(0.006)]);
    this.capsule(h, 0.0088, this.glove, [L(-0.03), 0.048, B(0.004)], [L(-0.03), 0.058, F(-0.026)]);
    // Glove cuff, behind and below the grip's back strap.
    this.capsule(h, 0.028, this.cuff, [0.018, W(-0.052), B(0.058)], [0.026, W(-0.07), B(0.082)]);
    this.rightWristLocal.set(0.02, W(-0.058), B(0.062));
  }

  private buildLeftHand(): void {
    const h = this.left;
    // Palm under the handguard, slightly rolled toward the shooter.
    this.box(h, 0.052, 0.022, 0.082, this.glove, -0.004, -0.014, 0.004, 0, 0, 0.12);
    this.box(h, 0.03, 0.008, 0.06, this.pad, 0.0, -0.027, 0.006);
    // Four fingers curl up the right side of the handguard.
    [-0.03, -0.01, 0.01, 0.029].forEach((z, i) => {
      const r = 0.0086 - Math.abs(i - 1.5) * 0.0004;
      this.capsule(h, r, this.glove, [0.02, -0.014, z], [0.036, 0.004, z]);
      // Fingers run straight up the side of the handguard (no curling into it).
      this.capsule(h, r, this.glove, [0.0378, 0.006, z], [0.0378, 0.032, z - 0.002]);
      this.capsule(h, r * 0.9, this.glove, [0.0378, 0.034, z - 0.002], [0.0372, 0.048, z - 0.004]);
    });
    // Thumb along the left side.
    this.capsule(h, 0.0095, this.glove, [-0.024, -0.014, 0.03], [-0.036, 0.012, 0.004]);
    this.capsule(h, 0.0088, this.glove, [-0.036, 0.014, 0.002], [-0.034, 0.03, -0.028]);
    // Glove cuff.
    this.capsule(h, 0.029, this.cuff, [-0.006, -0.03, 0.045], [-0.01, -0.044, 0.07]);
  }

  /** Debug names like "R.seg7" so clipping reports can point at a finger part. */
  private partName(parent: THREE.Object3D, kind: string): string {
    const side = parent === this.right ? 'R' : parent === this.left ? 'L' : 'arm';
    return `${side}.${kind}${parent.children.length}`;
  }

  private mat(color: number, metalness: number, roughness: number): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ color, metalness, roughness });
    this.materials.push(m);
    return m;
  }

  private box(
    parent: THREE.Object3D,
    w: number,
    h: number,
    d: number,
    mat: THREE.Material,
    x: number,
    y: number,
    z: number,
    rx = 0,
    ry = 0,
    rz = 0,
  ): THREE.Mesh {
    const g = new THREE.BoxGeometry(w, h, d);
    this.geometries.push(g);
    const m = new THREE.Mesh(g, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    m.name = this.partName(parent, 'box');
    parent.add(m);
    return m;
  }

  /** A rounded segment between two points (finger joints). */
  private capsule(parent: THREE.Object3D, radius: number, mat: THREE.Material, a: number[], b: number[]): THREE.Mesh {
    const pa = new THREE.Vector3(a[0], a[1], a[2]);
    const pb = new THREE.Vector3(b[0], b[1], b[2]);
    const dir = pb.clone().sub(pa);
    const len = dir.length();
    const g = new THREE.CapsuleGeometry(radius, Math.max(len, 1e-4), 3, 8);
    this.geometries.push(g);
    const m = new THREE.Mesh(g, mat);
    m.position.copy(pa).add(pb).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(_up, dir.divideScalar(len || 1));
    m.name = this.partName(parent, 'seg');
    parent.add(m);
    return m;
  }

  /** Forearm: a tapered sleeve whose ends are re-fit each frame. */
  private limb(wristRadius: number, elbowRadius: number): Limb {
    const g = new THREE.CylinderGeometry(wristRadius, elbowRadius, 1, 12, 1, false);
    g.translate(0, 0.5, 0); // origin at the wrist end
    this.geometries.push(g);
    const sleeve = new THREE.Mesh(g, this.sleeve);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(wristRadius * 1.08, wristRadius * 1.1, 0.03, 12), this.cuff);
    this.geometries.push(band.geometry);
    band.position.y = 0.05;
    const group = new THREE.Group();
    group.add(sleeve, band);
    this.object.add(group);
    return { group, sleeve };
  }

  private setLimb(limb: Limb, wrist: THREE.Vector3, elbow: THREE.Vector3): void {
    _dir.subVectors(elbow, wrist);
    const len = _dir.length();
    limb.group.position.copy(wrist);
    limb.group.quaternion.setFromUnitVectors(_up, _dir.divideScalar(len || 1));
    limb.sleeve.scale.set(1, len, 1);
  }
}

interface Limb {
  group: THREE.Group;
  sleeve: THREE.Mesh;
}

const MAG_GRAB_OFFSET = new THREE.Vector3(0.0, -0.11, 0.0);
const MAG_GRAB_ROT = new THREE.Euler(0.15, 0, 0.35);

const _up = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _target = new THREE.Vector3();
const _q = new THREE.Quaternion();

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
}
