import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FirstPersonBody, type BodyState } from '../player/FirstPersonBody';
import { getArmTextures } from '../weapons/view/ArmTextures';

/** FirstPersonBody keeps its hips this far behind the eyes (first-person trick); a third-person body undoes it. */
const BODY_BACK = 0.18;
const DEATH_FALL = 0.5;

/** What the model shows each frame (from the bot's controller, AI and weapon). */
export interface BotPose {
  feet: THREE.Vector3;
  /** Aim direction. */
  yaw: number;
  pitch: number;
  velocity: THREE.Vector3;
  grounded: boolean;
  /** Rifle up at the shoulder (engaging) or at low ready. */
  aiming: boolean;
  alive: boolean;
  /** Seconds since death. */
  deadTime: number;
}

/** Shared materials / geometry of every bot body in a squad (built once). */
export class BotKit {
  readonly materials: THREE.Material[] = [];
  readonly fabric: THREE.MeshStandardMaterial;
  readonly gear: THREE.MeshStandardMaterial;
  readonly skin: THREE.MeshStandardMaterial;
  readonly helmet: THREE.MeshStandardMaterial;
  readonly dark: THREE.MeshStandardMaterial;
  readonly glove: THREE.MeshStandardMaterial;
  readonly gun: THREE.MeshStandardMaterial;

  constructor() {
    const tex = getArmTextures();
    const m = (color: number, roughness: number, metalness = 0, map: THREE.Texture | null = null, normalMap: THREE.Texture | null = null) => {
      const mat = new THREE.MeshStandardMaterial({ color, roughness, metalness, map, normalMap });
      mat.normalScale.setScalar(0.5);
      this.materials.push(mat);
      return mat;
    };
    this.fabric = m(0x5c624f, 0.92, 0, tex.fabricMap, tex.fabricNormal);
    this.gear = m(0x3f4436, 0.85, 0, tex.fabricMap, tex.fabricNormal);
    this.skin = m(0x9a7a62, 0.7);
    this.helmet = m(0x4a5040, 0.65, 0.1);
    this.dark = m(0x1d1f22, 0.5, 0.2);
    this.glove = m(0x2a2a2a, 0.75, 0, tex.gloveMap, tex.gloveNormal);
    this.gun = m(0x26282b, 0.5, 0.55);
  }

  dispose(): void {
    this.materials.forEach((mat) => mat.dispose());
  }
}

const _feet = new THREE.Vector3();
const _state: BodyState = { feet: new THREE.Vector3(), yaw: 0, eyeHeight: 1.68, velocity: new THREE.Vector3(), grounded: true };

/**
 * A third-person tactical operator for a bot: the player's own lower body
 * (FirstPersonBody: distance-driven walk / run cycle with planted feet, IK
 * knees, jump tuck) with a procedural upper body hung on its pelvis —
 * plate carrier, helmet, and arms holding a rifle at the shoulder. The
 * rifle comes up to aim when engaging and rests at low ready otherwise;
 * it kicks when firing, the torso flinches when hit, and the body falls
 * backward when killed. Presentation only: the bot's hit capsule, AI and
 * damage are untouched.
 */
export class BotModel {
  readonly object: THREE.Object3D;
  /** Muzzle point (world position via getWorldPosition) for flashes and tracers. */
  readonly muzzle = new THREE.Object3D();
  private readonly lower = new FirstPersonBody();
  private readonly spine = new THREE.Group();
  private readonly arms = new THREE.Group();
  private readonly geometries: THREE.BufferGeometry[] = [];
  private raise = 0;
  private kick = 0;
  private flinch = 0;
  private flinchSide = 0;

  constructor(kit: BotKit) {
    this.object = this.lower.object;
    this.object.name = 'BotModel';
    const k = kit;
    const sp = this.spine;
    // Pelvis origin is the hip joint; the spine starts at the waist.
    sp.position.set(0, 0.16, 0);
    this.lower.pelvis.add(sp);

    // Torso: shirt, plate carrier with front pouches and shoulder straps.
    this.add(sp, new THREE.CapsuleGeometry(1, 0.6, 4, 14), k.fabric, [0, 0.2, 0], [0.165, 0.18, 0.11]);
    this.add(sp, new THREE.BoxGeometry(0.36, 0.33, 0.25), k.gear, [0, 0.27, 0]);
    for (const x of [-0.1, 0, 0.1]) this.add(sp, new THREE.BoxGeometry(0.085, 0.11, 0.05), k.gear, [x, 0.18, -0.145]);
    this.add(sp, new THREE.BoxGeometry(0.3, 0.05, 0.05), k.dark, [0, 0.1, -0.13]);
    for (const x of [-0.11, 0.11]) this.add(sp, new THREE.BoxGeometry(0.07, 0.04, 0.27), k.gear, [x, 0.45, 0]);
    // Neck, head, helmet with rim, goggles and a mount on the front.
    this.add(sp, new THREE.CylinderGeometry(0.05, 0.058, 0.1, 10), k.skin, [0, 0.52, 0.005]);
    this.add(sp, new THREE.SphereGeometry(0.098, 16, 12), k.skin, [0, 0.645, 0], [0.95, 1.08, 1]);
    this.add(sp, new THREE.SphereGeometry(0.122, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), k.helmet, [0, 0.665, 0.01], [1, 0.95, 1.06]);
    this.add(sp, new THREE.CylinderGeometry(0.124, 0.13, 0.025, 16), k.helmet, [0, 0.655, 0.01], [1, 1, 1.06]);
    this.add(sp, new THREE.BoxGeometry(0.16, 0.04, 0.03), k.dark, [0, 0.64, -0.09]);
    this.add(sp, new THREE.BoxGeometry(0.04, 0.035, 0.03), k.dark, [0, 0.74, -0.115]);
    for (const x of [-0.105, 0.105]) this.add(sp, new THREE.CylinderGeometry(0.035, 0.035, 0.03, 10), k.dark, [x, 0.635, 0.005], [1, 1, 1], [0, 0, Math.PI / 2]);
    // Shoulders.
    for (const x of [-0.2, 0.2]) this.add(sp, new THREE.SphereGeometry(0.075, 10, 8), k.fabric, [x, 0.42, 0]);

    // Arms + rifle pivot at shoulder height; pitched with the aim.
    const a = this.arms;
    a.position.set(0, 0.42, 0);
    sp.add(a);
    // Rifle: stock in the right shoulder, barrel along -Z.
    const r = new THREE.Group();
    r.position.set(0.1, 0.03, 0);
    a.add(r);
    const gun = k.gun;
    this.add(r, new THREE.BoxGeometry(0.045, 0.07, 0.3), gun, [0, 0, -0.17]);
    this.add(r, new THREE.BoxGeometry(0.05, 0.055, 0.24), gun, [0, -0.005, -0.42]);
    this.add(r, new THREE.CylinderGeometry(0.011, 0.011, 0.16, 8), gun, [0, 0, -0.62], [1, 1, 1], [Math.PI / 2, 0, 0]);
    this.add(r, new THREE.CylinderGeometry(0.017, 0.017, 0.05, 8), k.dark, [0, 0, -0.71], [1, 1, 1], [Math.PI / 2, 0, 0]);
    this.add(r, new THREE.BoxGeometry(0.035, 0.14, 0.06), gun, [0, -0.1, -0.2], [1, 1, 1], [0.18, 0, 0]);
    this.add(r, new THREE.BoxGeometry(0.035, 0.09, 0.04), gun, [0, -0.07, -0.04], [-0.3, 0, 0]);
    this.add(r, new THREE.BoxGeometry(0.04, 0.08, 0.2), gun, [0, -0.02, 0.08]);
    this.add(r, new THREE.BoxGeometry(0.035, 0.045, 0.1), k.dark, [0, 0.06, -0.17]);
    this.muzzle.position.set(0.1, 0.03, -0.74);
    a.add(this.muzzle);
    // Arms from the shoulders to the hands on the rifle (grip, handguard).
    this.limb(a, [0.2, 0, 0.02], [0.24, -0.22, -0.05], 0.05, k.fabric);
    this.limb(a, [0.24, -0.22, -0.05], [0.11, -0.06, -0.06], 0.042, k.fabric);
    this.add(a, new THREE.SphereGeometry(0.043, 10, 8), k.glove, [0.11, -0.06, -0.07]);
    this.limb(a, [-0.2, 0, 0.02], [-0.19, -0.2, -0.24], 0.05, k.fabric);
    this.limb(a, [-0.19, -0.2, -0.24], [0.08, -0.03, -0.42], 0.042, k.fabric);
    this.add(a, new THREE.SphereGeometry(0.043, 10, 8), k.glove, [0.09, -0.04, -0.43]);

    this.mergeParts(sp);
    this.mergeParts(a);
    this.mergeParts(r);
    this.object.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.castShadow = false;
      m.receiveShadow = true;
    });
  }

  /** Per frame. */
  update(dt: number, p: BotPose): void {
    // Hand FirstPersonBody feet shifted forward so its hips land over the bot's capsule.
    _feet.set(p.feet.x - Math.sin(p.yaw) * BODY_BACK, p.feet.y, p.feet.z - Math.cos(p.yaw) * BODY_BACK);
    _state.feet.copy(_feet);
    _state.yaw = p.yaw;
    _state.velocity.copy(p.alive ? p.velocity : _state.velocity.set(0, 0, 0));
    _state.grounded = p.grounded || !p.alive;
    this.lower.update(dt, _state);
    // Re-place it with the body's actual (lagging) yaw so the hips stay over the capsule
    // while the body turns, rather than swinging around a point in front of them.
    const by = this.object.rotation.y;
    this.object.position.set(p.feet.x - Math.sin(by) * BODY_BACK, p.feet.y, p.feet.z - Math.cos(by) * BODY_BACK);

    // Upper body: turn from the legs toward the aim, raise / lower the rifle.
    const bodyYaw = this.object.rotation.y;
    const twist = Math.atan2(Math.sin(p.yaw - bodyYaw), Math.cos(p.yaw - bodyYaw));
    this.spine.rotation.y = twist * 0.75;
    this.raise += ((p.aiming ? 1 : 0) - this.raise) * (1 - Math.exp(-9 * dt));
    this.kick = Math.max(0, this.kick - dt * 10);
    this.flinch = Math.max(0, this.flinch - dt * 5);
    const pitch = THREE.MathUtils.clamp(p.pitch, -1, 1);
    this.arms.rotation.x = pitch * this.raise + (1 - this.raise) * -0.75 + this.kick * 0.12;
    this.arms.rotation.y = twist * 0.25;
    this.arms.position.z = this.kick * 0.035;
    this.spine.rotation.x = pitch * 0.25 * this.raise + this.flinch * 0.25;
    this.spine.rotation.z = this.flinch * 0.15 * this.flinchSide;

    if (!p.alive) {
      // Falls onto its back about the feet (the object is at the feet; +Z is behind).
      const t = Math.min(p.deadTime / DEATH_FALL, 1);
      const fall = t * t;
      // Lifted by about half the torso's depth so the body rests on the floor instead of sinking into it.
      this.object.position.y += 0.14 * fall;
      this.object.rotateX((Math.PI / 2) * 0.97 * fall);
      this.object.rotateZ(0.25 * fall);
      this.arms.rotation.x = -0.75 - 0.6 * fall;
    }
  }

  /** A round fired: short recoil kick. */
  onShot(): void {
    this.kick = 1;
  }

  /** Hit: the torso jolts away from the shot. */
  onHit(direction: THREE.Vector3): void {
    this.flinch = 1;
    const right = Math.cos(this.object.rotation.y) * direction.x - Math.sin(this.object.rotation.y) * direction.z;
    this.flinchSide = right > 0 ? -1 : 1;
  }

  /** Snap the legs to the current yaw (after a teleport). */
  reset(): void {
    this.lower.reset();
    this.raise = 0;
    this.kick = 0;
    this.flinch = 0;
  }

  dispose(): void {
    this.object.removeFromParent();
    this.lower.dispose();
    this.geometries.forEach((g) => g.dispose());
  }

  private add(parent: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material, pos: readonly number[], scale: readonly number[] = [1, 1, 1], rot: readonly number[] = [0, 0, 0]): void {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(pos[0], pos[1], pos[2]);
    mesh.scale.set(scale[0], scale[1], scale[2]);
    mesh.rotation.set(rot[0], rot[1], rot[2]);
    parent.add(mesh);
  }

  /** A rounded segment between two points. */
  private limb(parent: THREE.Object3D, a: readonly number[], b: readonly number[], radius: number, material: THREE.Material): void {
    const va = new THREE.Vector3(a[0], a[1], a[2]);
    const vb = new THREE.Vector3(b[0], b[1], b[2]);
    const axis = vb.clone().sub(va);
    const g = new THREE.CapsuleGeometry(radius, Math.max(axis.length() - radius, 0.01), 3, 8);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.clone().normalize()));
    const mid = va.add(vb).multiplyScalar(0.5);
    g.translate(mid.x, mid.y, mid.z);
    parent.add(new THREE.Mesh(g, material));
  }

  /** One mesh per material per group (draw calls). */
  private mergeParts(group: THREE.Object3D): void {
    const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
    for (const child of [...group.children]) {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) continue;
      mesh.updateMatrix();
      const g = (mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone()).applyMatrix4(mesh.matrix);
      mesh.geometry.dispose();
      const list = byMat.get(mesh.material as THREE.Material) ?? [];
      list.push(g);
      byMat.set(mesh.material as THREE.Material, list);
      group.remove(mesh);
    }
    for (const [mat, list] of byMat) {
      const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
      if (list.length > 1) list.forEach((g) => g.dispose());
      if (!merged) continue;
      this.geometries.push(merged);
      group.add(new THREE.Mesh(merged, mat));
    }
  }
}
