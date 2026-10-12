import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PLAYER_CONFIG } from '../config';
import { getArmTextures } from '../weapons/view/ArmTextures';

// Local player's lower body, seen when looking down (first-person "true legs").
//
// Presentation only: it reads the player controller's state and never feeds
// anything back, so movement speed, jumping, collision and the camera are
// unchanged. It lives in the world scene (lit and shadowed like the map) and
// is separate from the view-model arms, which are drawn in their own pass.
// A future third-person / remote-player body would be a different, full
// model; this one deliberately stops at the waist so it can never clip the
// camera.
//
// Proportions follow the collision capsule (1.8 m tall, 0.35 m radius):
// hip joint 0.93 m, thigh 0.44 m, shin 0.43 m, ankle 0.08 m above the sole.

const THIGH = 0.44;
const SHIN = 0.43;
const ANKLE = 0.08;
/** Eye to hip joint, standing (1.68 m eyes, 0.93 m hips). Crouching keeps it, so the hips drop with the eyes. */
const EYE_TO_HIP = PLAYER_CONFIG.standHeight - PLAYER_CONFIG.eyeOffsetFromTop - (THIGH + SHIN + ANKLE - 0.02);
/**
 * Hips sit behind the eyes (more than anatomically: the usual first-person
 * trick so the feet show in front of the waist instead of under it); the
 * feet stand a little ahead of the hips.
 */
const BODY_BACK = 0.18;
const FEET_AHEAD = 0.12;
const HIP_HALF_WIDTH = 0.095;
const FOOT_HALF_WIDTH = 0.11;
/** Distance covered per full gait cycle (two steps): walking .. running. */
const STRIDE_WALK = 1.2;
const STRIDE_RUN = 2.0;
/** Fraction of the cycle a foot is planted: walking .. running (running has a flight phase). */
const STANCE_WALK = 0.5;
const STANCE_RUN = 0.38;
/** How far the lower body twists toward a sideways / diagonal movement direction (rad). */
const MAX_TWIST = 1.0;

const _v = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _bend = new THREE.Vector3();
const _knee = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _fwd = new THREE.Vector3(0, 0, -1);
const _q = new THREE.Quaternion();

/** What the body needs from the player each frame (all already interpolated for rendering). */
export interface BodyState {
  /** Feet position (bottom of the capsule). */
  feet: THREE.Vector3;
  yaw: number;
  eyeHeight: number;
  velocity: THREE.Vector3;
  grounded: boolean;
}

interface Leg {
  side: number;
  thigh: THREE.Group;
  shin: THREE.Group;
  boot: THREE.Group;
  hip: THREE.Vector3;
  foot: THREE.Vector3;
}

export class FirstPersonBody {
  readonly object = new THREE.Group();

  private readonly pelvis = new THREE.Group();
  private readonly legs: Leg[];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private bodyYaw = 0;
  private turning = false;
  private phase = 0;
  private moveBlend = 0;
  private air = 0;
  private initialized = false;

  constructor() {
    this.object.name = 'FirstPersonBody';
    const tex = getArmTextures();
    // Colours are a step lighter than the sleeves: the world is lit less brightly than the view-model pass.
    const pants = this.mat(0x67644f, 0.92, tex.fabricMap, tex.fabricNormal);
    const jacket = this.mat(0x575c4a, 0.92, tex.fabricMap, tex.fabricNormal);
    const gear = this.mat(0x37393c, 0.75, null, tex.gloveNormal);
    const boot = this.mat(0x433a30, 0.7, tex.gloveMap, tex.gloveNormal);
    const sole = this.mat(0x1c1c1c, 0.9);

    // Waist: jacket hem, belt with a buckle and magazine / utility pouches up front.
    const p = this.pelvis;
    this.add(p, new THREE.CapsuleGeometry(1, 0.4, 4, 16), jacket, [0, 0.13, 0.01], [0.165, 0.07, 0.105]);
    this.add(p, new THREE.CylinderGeometry(1, 1, 0.05, 16), gear, [0, 0.09, 0], [0.172, 1, 0.112]);
    this.add(p, new THREE.BoxGeometry(0.05, 0.035, 0.012), this.mat(0x5b5d60, 0.4), [0, 0.09, -0.115]);
    for (const [x, w] of [[-0.085, 0.07], [-0.15, 0.06], [0.11, 0.08]] as const) {
      this.add(p, new THREE.BoxGeometry(w, 0.085, 0.04), gear, [x, 0.06, -0.105], [1, 1, 1], [0, x * 1.8, 0]);
    }
    // Seat of the trousers.
    this.add(p, new THREE.CapsuleGeometry(1, 0.5, 4, 16), pants, [0, 0.0, 0.005], [0.16, 0.1, 0.105]);

    this.legs = [-1, 1].map((side) => {
      const thigh = new THREE.Group();
      this.add(thigh, taper(0.072, 0.056, 12), pants, [0, 0, 0], [1, THIGH, 1]);
      this.add(thigh, new THREE.SphereGeometry(0.073, 12, 8), pants, [0, 0, 0]);
      // Cargo pocket on the outside of the thigh.
      this.add(thigh, new THREE.BoxGeometry(0.03, 0.15, 0.1), pants, [side * 0.06, -0.2, 0]);
      const shin = new THREE.Group();
      this.add(shin, taper(0.054, 0.045, 12), pants, [0, 0, 0], [1, SHIN, 1]);
      this.add(shin, new THREE.SphereGeometry(0.056, 12, 8), pants, [0, 0, 0]);
      // Knee pad on the front of the knee.
      this.add(shin, new THREE.CapsuleGeometry(0.045, 0.05, 4, 10), gear, [0, -0.05, -0.045], [1.05, 1, 0.55]);
      // Boot shaft over the lower shin.
      this.add(shin, taper(0.05, 0.052, 12), boot, [0, -SHIN + 0.13, 0], [1, 0.14, 1]);
      const bootG = new THREE.Group();
      this.add(bootG, new THREE.BoxGeometry(0.1, 0.09, 0.2), boot, [0, -0.035, -0.03]);
      this.add(bootG, new THREE.CapsuleGeometry(0.045, 0.06, 4, 10), boot, [0, -0.04, -0.12], [1.1, 1, 1], [Math.PI / 2, 0, 0]);
      this.add(bootG, new THREE.BoxGeometry(0.108, 0.025, 0.29), sole, [0, -ANKLE + 0.0125, -0.05]);
      this.object.add(thigh, shin, bootG);
      return { side, thigh, shin, boot: bootG, hip: new THREE.Vector3(), foot: new THREE.Vector3() };
    });
    this.object.add(this.pelvis);
    // One draw call per bone and material.
    for (const bone of [this.pelvis, ...this.legs.flatMap((l) => [l.thigh, l.shin, l.boot])]) this.mergeParts(bone);

    this.object.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      // The map's shadow map is baked once (static); the body only receives it.
      m.castShadow = false;
      m.receiveShadow = true;
    });
  }

  update(dt: number, s: BodyState): void {
    const speed = Math.hypot(s.velocity.x, s.velocity.z);
    if (!this.initialized) {
      this.bodyYaw = s.yaw;
      this.initialized = true;
    }

    // Body yaw: follows the view while moving, twisted toward sideways /
    // diagonal movement (so the legs never scissor through each other);
    // standing still it only turns once the view is more than ~45° away
    // (no jitter from small mouse moves).
    let target = s.yaw;
    if (speed > 0.3) {
      // Movement angle relative to the view: 0 forward, ±π/2 sideways, π backward.
      const rel = wrapAngle(Math.atan2(-s.velocity.x, -s.velocity.z) - s.yaw);
      const facing = Math.abs(rel) <= Math.PI / 2 + 0.01 ? rel : wrapAngle(rel - Math.sign(rel) * Math.PI);
      target = s.yaw + THREE.MathUtils.clamp(facing, -MAX_TWIST, MAX_TWIST);
    }
    const diff = wrapAngle(target - this.bodyYaw);
    if (speed > 0.3) this.turning = true;
    else if (Math.abs(diff) > 0.8) this.turning = true;
    else if (Math.abs(diff) < 0.03) this.turning = false;
    if (this.turning) {
      const rate = speed > 0.3 ? 9 : 6;
      const stepAngle = Math.sign(diff) * Math.min(Math.abs(diff), rate * dt);
      this.bodyYaw += stepAngle;
      // Turning in place shuffles the feet a little.
      if (speed <= 0.3) this.phase += Math.abs(stepAngle) * 2.2;
    }

    // Gait cycle driven by distance travelled, so a planted foot stays put on the ground.
    const run01 = Math.min(speed / PLAYER_CONFIG.runSpeed, 1);
    const stride = THREE.MathUtils.lerp(STRIDE_WALK, STRIDE_RUN, run01);
    const stance = THREE.MathUtils.lerp(STANCE_WALK, STANCE_RUN, run01);
    this.phase += (speed * dt * Math.PI * 2) / stride;
    const moveTarget = s.grounded ? Math.min(speed / PLAYER_CONFIG.runSpeed, 1) : 0;
    this.moveBlend += (moveTarget - this.moveBlend) * (1 - Math.exp(-10 * dt));
    this.air += ((s.grounded ? 0 : 1) - this.air) * (1 - Math.exp(-12 * dt));

    // Movement direction in body space (-Z forward).
    const c = Math.cos(this.bodyYaw);
    const sn = Math.sin(this.bodyYaw);
    let mx = 0;
    let mz = -1;
    if (speed > 0.05) {
      mx = (s.velocity.x * c - s.velocity.z * sn) / speed;
      mz = (s.velocity.x * sn + s.velocity.z * c) / speed;
    }

    this.object.position.copy(s.feet);
    this.object.rotation.set(0, this.bodyYaw, 0);
    // Knees stay bent while running.
    const hipY = s.eyeHeight - EYE_TO_HIP - 0.09 * this.moveBlend;
    this.pelvis.position.set(0, hipY, BODY_BACK);
    // Slight forward lean when running.
    this.pelvis.rotation.x = -0.08 * this.moveBlend;

    // Planted, a foot covers stance * stride relative to the body.
    const reach = ((stance * stride) / 2) * this.moveBlend;
    // Standing, the feet are a little ahead of the hips; moving, centred under them.
    const footZ = BODY_BACK - FEET_AHEAD * (1 - this.moveBlend);
    for (const leg of this.legs) {
      // Stance: the foot moves back exactly as fast as the body moves forward
      // (planted). Swing: lifted and carried forward.
      const u = (((this.phase / (Math.PI * 2) + (leg.side > 0 ? 0.5 : 0)) % 1) + 1) % 1;
      let along: number;
      let lift = 0;
      if (u < stance) {
        along = 1 - (2 * u) / stance;
      } else {
        const t = (u - stance) / (1 - stance);
        along = -1 + 2 * t * t * (3 - 2 * t);
        lift = Math.sin(Math.PI * t);
      }
      leg.hip.set(leg.side * HIP_HALF_WIDTH, hipY, BODY_BACK);
      leg.foot.set(
        leg.side * FOOT_HALF_WIDTH + mx * reach * along * 0.7,
        ANKLE + lift * 0.12 * this.moveBlend,
        footZ + mz * reach * along,
      );
      // Airborne: feet tuck up and a little forward.
      leg.foot.y += this.air * (0.18 + (leg.side > 0 ? 0.05 : 0));
      leg.foot.z -= this.air * 0.08;
      this.solveLeg(leg);
    }
  }

  /** Snap to the player's yaw (spawn / teleport) instead of turning toward it. */
  reset(): void {
    this.initialized = false;
    this.phase = 0;
    this.moveBlend = 0;
    this.air = 0;
    this.turning = false;
  }

  dispose(): void {
    this.geometries.forEach((g) => g.dispose());
    this.materials.forEach((m) => m.dispose());
  }

  /** Two-bone IK: knee bends toward the body's front. */
  private solveLeg(leg: Leg): void {
    const { hip, foot } = leg;
    _dir.subVectors(foot, hip);
    let d = _dir.length();
    const maxReach = THIGH + SHIN - 0.002;
    if (d > maxReach) {
      _dir.multiplyScalar(maxReach / d);
      foot.copy(hip).add(_dir);
      d = maxReach;
    }
    _dir.normalize();
    _bend.copy(_fwd).addScaledVector(_dir, -_fwd.dot(_dir)).normalize();
    const a = (THIGH * THIGH - SHIN * SHIN + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(THIGH * THIGH - a * a, 0));
    _knee.copy(hip).addScaledVector(_dir, a).addScaledVector(_bend, h);

    place(leg.thigh, hip, _knee);
    place(leg.shin, _knee, foot);
    leg.boot.position.copy(foot);
    // Toes lift a little at the end of the swing.
    leg.boot.rotation.set(-0.25 * Math.max(0, foot.y - ANKLE) * 4, 0, 0);
  }

  /** Bakes a bone's part meshes into one mesh per material (fewer draw calls when looking down). */
  private mergeParts(bone: THREE.Object3D): void {
    const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
    for (const child of [...bone.children]) {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) continue;
      mesh.updateMatrix();
      const g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
      g.applyMatrix4(mesh.matrix);
      const list = byMaterial.get(mesh.material as THREE.Material) ?? [];
      list.push(g);
      byMaterial.set(mesh.material as THREE.Material, list);
      bone.remove(mesh);
    }
    for (const [material, list] of byMaterial) {
      const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
      if (list.length > 1) list.forEach((g) => g.dispose());
      if (!merged) continue;
      this.geometries.push(merged);
      bone.add(new THREE.Mesh(merged, material));
    }
  }

  private mat(color: number, roughness: number, map: THREE.Texture | null = null, normalMap: THREE.Texture | null = null): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ color, roughness, metalness: 0, map, normalMap });
    m.normalScale.setScalar(0.5);
    this.materials.push(m);
    return m;
  }

  private add(
    parent: THREE.Object3D,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    position: readonly number[],
    scale: readonly number[] = [1, 1, 1],
    rotation: readonly number[] = [0, 0, 0],
  ): THREE.Mesh {
    this.geometries.push(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(position[0], position[1], position[2]);
    mesh.scale.set(scale[0], scale[1], scale[2]);
    mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
    parent.add(mesh);
    return mesh;
  }
}

/** Unit-length tapered tube hanging down from its origin (scaled to the bone length). */
function taper(top: number, bottom: number, segments: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(top, bottom, 1, segments, 1, false);
  g.translate(0, -0.5, 0);
  return g;
}

/** Points a bone group (geometry hanging along -Y) from `a` to `b`. */
function place(bone: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3): void {
  bone.position.copy(a);
  _v.subVectors(a, b).normalize();
  _q.setFromUnitVectors(_up, _v);
  bone.quaternion.copy(_q);
}

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
