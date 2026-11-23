import * as THREE from 'three';
import { loadGltfScene, loadedGltfScene } from '../weapons/view/GltfWeaponView';
import { PLAYER_CONFIG } from '../config';
import { buildBotRifle, liftCharacterMaterial, RIFLE_GRIP, RIFLE_MUZZLE_Z, BODY_LEAN, slashPose, holdsKnife, type BotBody, type BotKit, type BotPose } from './BotModel';
import { FirstPersonBody, HIP_HEIGHT, type BodyState } from '../player/FirstPersonBody';
import { CharacterMotion, nearCamera } from './CharacterMotion';
import { meleeStyleOf } from '../weapons/meleeMotion';
import { HeldWeapon } from '../weapons/view/ThirdPersonWeapons';
import { dressStandIn } from '../skins/StandInSkin';

// Blender character models for the bots ("봇 외형: 요원 모델"):
// BLUE wears the operator, RED (and free-for-all bots) the opposing force.
// Both files are single static meshes in one pose: no skeleton, no
// animation. They are used exactly as exported; what the game adds is
// placement, the team rifle in the hands, turning toward the aim and a
// simple fall on death. Hit boxes, AI and damage are the bots' own.

export const AGENT_MODEL_URLS = { blue: '/characters/operator.glb', red: '/characters/terrorist.glb' } as const;

/** BLUE → operator; RED and team-less (free-for-all) bots → terrorist. */
export function agentModelUrl(team?: string): string {
  return team === 'blue' ? AGENT_MODEL_URLS.blue : AGENT_MODEL_URLS.red;
}

/** Downloads both character files once; a failure leaves the built-in body in use. */
export async function preloadAgentModels(): Promise<void> {
  const results = await Promise.allSettled(Object.values(AGENT_MODEL_URLS).map((url) => loadGltfScene(url)));
  for (const r of results) if (r.status === 'rejected') console.warn('[bots] character model unavailable, keeping the built-in body', r.reason);
}

// Measured on both files: the figure stands on y = 0 centred at x 0.95 with its
// feet centred at z 0.05, facing +Z; the hands meet at (0.84, 1.23, 0.52).
const FILE_CENTRE = new THREE.Vector3(0.95, 0, 0.05);
/** The hands in bot space (feet at the origin, facing -Z). */
const HANDS = new THREE.Vector3(0.11, 1.23, -0.47);
/** How far the back of the figure reaches behind the feet (lifts the body when it lies on its back). */
const BACK_DEPTH = 0.2;
const DEATH_FALL = 0.5;
/** Step bob length (m per bob) and height while running (the far figure, which has no legs of its own). */
const BOB_STRIDE = 0.7;
const BOB_HEIGHT = 0.03;
/**
 * Phase 31: the file's figure is one rigid mesh (no skeleton), so its legs cannot walk. Up close it is cut at
 * the hips: the upper body from the file rides on the animated legs of FirstPersonBody (distance-driven gait
 * with planted feet, knee IK, crouch, jump tuck), dressed in the file's own trouser, boot and gear colours.
 * Triangles whose centre is below this height (m above the soles) are the file's legs.
 */
const HIP_CUT = 0.9;
/** How much shorter the far figure gets crouched (the capsule goes from 1.8 to 1.2 m; the figure's top is ~1.76 m). */
const FAR_CROUCH = (PLAYER_CONFIG.standHeight - PLAYER_CONFIG.crouchHeight) / 1.76;
/** FirstPersonBody keeps its hips this far behind its own origin (first-person trick, undone here as in BotModel). */
const BODY_BACK = 0.18;

const _feet = new THREE.Vector3();
const _state: BodyState = { feet: new THREE.Vector3(), yaw: 0, eyeHeight: 1.68, velocity: new THREE.Vector3(), grounded: true };
const _slash = { rx: 0, ry: 0, rz: 0, z: 0 };
const _v = new THREE.Vector3();

/** The file's upper body (made once per file): the same meshes and materials, without the leg triangles. */
const upperTemplates = new WeakMap<THREE.Object3D, THREE.Object3D>();
function upperTemplate(template: THREE.Object3D): THREE.Object3D {
  let upper = upperTemplates.get(template);
  if (upper) return upper;
  upper = template.clone(true);
  upper.updateMatrixWorld(true);
  const rootInv = upper.matrixWorld.clone().invert();
  const m = new THREE.Matrix4();
  upper.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const g = mesh.geometry;
    const pos = g.attributes.position;
    m.multiplyMatrices(rootInv, mesh.matrixWorld);
    const index = g.index;
    const count = index ? index.count : pos.count;
    const keep: number[] = [];
    for (let i = 0; i < count; i += 3) {
      let y = 0;
      for (let k = 0; k < 3; k++) y += _v.fromBufferAttribute(pos, index ? index.getX(i + k) : i + k).applyMatrix4(m).y;
      if (y / 3 >= HIP_CUT) for (let k = 0; k < 3; k++) keep.push(index ? index.getX(i + k) : i + k);
    }
    const cut = new THREE.BufferGeometry();
    for (const name of Object.keys(g.attributes)) cut.setAttribute(name, g.attributes[name]);
    cut.setIndex(keep);
    cut.computeBoundingSphere();
    mesh.geometry = cut;
    if (keep.length === 0) mesh.visible = false;
  });
  upperTemplates.set(template, upper);
  return upper;
}

/** The file's colour for a part of the uniform (first material whose name matches), for the legs it rides on. */
function fileColor(template: THREE.Object3D, pattern: RegExp): number | null {
  let found: number | null = null;
  template.traverse((o) => {
    if (found !== null) return;
    const mats = (o as THREE.Mesh).material;
    for (const mat of mats ? (Array.isArray(mats) ? mats : [mats]) : []) {
      if (found === null && pattern.test(mat.name) && (mat as THREE.MeshStandardMaterial).color) found = (mat as THREE.MeshStandardMaterial).color.getHex();
    }
  });
  return found;
}

/**
 * A bot as a character from a Blender file (operator / terrorist). Up close: the file's upper body on walking
 * legs (Phase 31); beyond CHARACTER_VIEW.nearRange the whole file figure as it was (no legs to animate, a step
 * bob instead), which costs a third of the draw calls. Presentation only: the hit capsule, aim and damage are
 * the bot's own.
 */
export class AgentModel implements BotBody {
  readonly object: THREE.Object3D;
  readonly muzzle = new THREE.Object3D();
  /** Animated legs (and the root: it stands at the feet, turned with the body). */
  private readonly lower = new FirstPersonBody();
  /** Hip pivot (on the pelvis): twist toward the aim, lean, crouch tip, breathing. */
  private readonly waist = new THREE.Group();
  /** The file's upper body (near). */
  private readonly upper: THREE.Object3D;
  /** The whole file figure (far), on its own pivot at the hips so it leans the same way. */
  private readonly farWaist = new THREE.Group();
  private readonly far = new THREE.Group();
  private readonly rifle: THREE.Group;
  private readonly rifleRest = new THREE.Vector3();
  private readonly geometries: THREE.BufferGeometry[] = [];
  private phase = 0;
  private move = 0;
  private raise = 0;
  private kick = 0;
  private flinch = 0;
  private flinchSide = 0;
  private near = true;
  /** Always the full animated body (the lobby's close-up figure, seen by its own camera). */
  alwaysNear = false;
  readonly motion = new CharacterMotion();

  /** The character for a bot of `team`, or null while its file is not loaded (the caller keeps the built-in body). */
  static create(team: string | undefined, kit: BotKit): AgentModel | null {
    const scene = loadedGltfScene(agentModelUrl(team));
    return scene ? new AgentModel(scene, kit) : null;
  }

  /** `template`: the loaded file scene (shared; cloned here, geometry and materials stay shared). */
  private readonly kit: BotKit;
  private standInSkin: string | undefined = undefined;
  readonly held: HeldWeapon;

  constructor(template: THREE.Object3D, kit: BotKit) {
    this.kit = kit;
    this.object = this.lower.object;
    this.object.name = 'AgentModel';
    const placeFile = (file: THREE.Object3D) => {
      const turned = new THREE.Group();
      turned.rotation.y = Math.PI;
      file.position.set(-FILE_CENTRE.x, -FILE_CENTRE.y, -FILE_CENTRE.z);
      turned.add(file);
      return turned;
    };
    // Near: the upper body from the hips up, in hip space (the soles HIP_HEIGHT below).
    const upperRoot = new THREE.Group();
    upperRoot.position.y = -HIP_HEIGHT;
    this.upper = placeFile(upperTemplate(template).clone(true));
    upperRoot.add(this.upper);
    this.waist.add(upperRoot);
    this.lower.pelvis.add(this.waist);
    // Far: the whole figure, standing on the feet under the hips.
    const farRoot = new THREE.Group();
    farRoot.position.y = -HIP_HEIGHT;
    farRoot.add(placeFile(template.clone(true)));
    // The pivot at hip height (the figure leans about its hips), the figure's soles back on the ground.
    this.farWaist.position.y = HIP_HEIGHT;
    this.farWaist.add(farRoot);
    this.far.add(this.farWaist);
    this.far.position.z = BODY_BACK;
    this.object.add(this.far);
    // Legs in the file's colours.
    const finish = (pattern: RegExp, roughness: number) => {
      const color = fileColor(template, pattern);
      return color === null ? null : { color, roughness };
    };
    this.lower.applyLook({ pants: finish(/pants|uniform/i, 0.9), jacket: finish(/jacket|uniform/i, 0.9), gear: finish(/gear|rig/i, 0.85), boot: finish(/boot/i, 0.7) });

    // The weapon at the hands, carried by the upper body (it follows the twist, lean and crouch).
    this.rifle = buildBotRifle(kit, this.geometries);
    this.rifleRest.copy(HANDS).sub(RIFLE_GRIP);
    this.rifle.position.copy(this.rifleRest);
    this.muzzle.position.set(0, 0, RIFLE_MUZZLE_Z);
    const standIn = [...this.rifle.children];
    this.rifle.add(this.muzzle);
    upperRoot.add(this.rifle);
    this.held = new HeldWeapon(
      this.rifle,
      RIFLE_GRIP,
      (visible, asset) => {
        for (const c of standIn) c.visible = visible;
        if (visible) this.setWeaponSkin(asset);
      },
      (p) => (p ? this.muzzle.position.copy(p) : this.muzzle.position.set(0, 0, RIFLE_MUZZLE_Z)),
    );
    this.object.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.castShadow = false;
      m.receiveShadow = true;
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        if ((mat as THREE.MeshStandardMaterial).isMeshStandardMaterial) liftCharacterMaterial(mat as THREE.MeshStandardMaterial);
      }
    });
    this.setNear(true);
  }

  /** Whether the full animated body is shown (else the far figure). */
  get detailed(): boolean {
    return this.near;
  }

  private setNear(near: boolean): void {
    this.near = near;
    this.lower.setOwnPartsVisible(near);
    this.upper.visible = near;
    this.far.visible = !near;
  }

  update(dt: number, p: BotPose): void {
    const mo = this.motion;
    mo.update(dt, p);
    // The legs: their root goes BODY_BACK ahead of the feet so the hips land over the capsule (as BotModel).
    _feet.set(p.feet.x - Math.sin(p.yaw) * BODY_BACK, p.feet.y, p.feet.z - Math.cos(p.yaw) * BODY_BACK);
    _state.feet.copy(_feet);
    _state.yaw = p.yaw;
    _state.velocity.copy(mo.velocity);
    _state.eyeHeight = mo.eyeHeight;
    _state.grounded = p.grounded || !p.alive;
    this.lower.update(dt, _state);
    const by = this.lower.yaw;
    this.object.position.set(p.feet.x - Math.sin(by) * BODY_BACK, p.feet.y, p.feet.z - Math.cos(by) * BODY_BACK);
    const near = this.alwaysNear || nearCamera(p.feet);
    if (near !== this.near) this.setNear(near);

    const speed = Math.hypot(mo.velocity.x, mo.velocity.z);
    this.move += ((p.grounded ? Math.min(speed / PLAYER_CONFIG.runSpeed, 1) : 0) - this.move) * (1 - Math.exp(-10 * dt));
    this.phase += (speed * dt * Math.PI) / BOB_STRIDE;
    this.raise += ((p.aiming ? 1 : 0) - this.raise) * (1 - Math.exp(-9 * dt));
    this.kick = Math.max(0, this.kick - dt * 10);
    this.flinch = Math.max(0, this.flinch - dt * 5);

    // Upper body: turned from the legs to the aim, leaning, tipped forward when crouched, breathing at rest.
    const twist = p.alive ? Math.atan2(Math.sin(p.yaw - by), Math.cos(p.yaw - by)) : 0;
    slashPose(mo.slashStyle, p.alive ? mo.slashSweep : 0, _slash);
    const roll = this.flinch * 0.08 * this.flinchSide - mo.lean * BODY_LEAN - (p.alive ? mo.strafeRoll(by) : 0);
    // The pelvis tips forward while running; the chest comes back up over it.
    this.waist.rotation.set(0.08 * this.move + mo.crouch * 0.16 + mo.breathing(this.move), twist + _slash.ry * 0.3, roll, 'YXZ');
    // Far: the whole figure turns to the aim, leans about the hips, sinks a little when crouched, bobs with the step.
    this.farWaist.rotation.set(0, twist, -mo.lean * BODY_LEAN, 'YXZ');
    // (crouched it is squashed to the crouched height, standing on its soles).
    const farScale = 1 - mo.crouch * FAR_CROUCH;
    this.far.position.y = Math.abs(Math.sin(this.phase)) * BOB_HEIGHT * this.move + Math.min(0, mo.land) * 0.5;
    this.far.scale.y = farScale;

    this.rifle.position.copy(this.rifleRest);
    // The rifle rides on the hips; the far figure has none of its own, so it goes where that figure's hands are.
    if (!this.near) this.rifle.position.y += HIP_HEIGHT - this.lower.pelvis.position.y - HANDS.y * (1 - farScale) + (this.far.position.y);
    this.rifle.position.z += this.kick * 0.03 + _slash.z;
    this.rifle.rotation.set(THREE.MathUtils.clamp(p.pitch, -1, 1) * 0.8 * this.raise + this.kick * 0.1 + _slash.rx, _slash.ry, _slash.rz);
    this.rifle.visible = true;

    if (!p.alive) {
      const t = Math.min(p.deadTime / DEATH_FALL, 1);
      const fall = t * t;
      this.object.position.y += BACK_DEPTH * fall;
      this.object.rotateX((Math.PI / 2) * 0.97 * fall);
      this.object.rotateZ(0.25 * fall);
      this.rifle.visible = fall < 0.35;
    }
  }

  /** A round fired: short recoil kick; a knife slashes instead (Phase 31). */
  onShot(): void {
    if (holdsKnife(this.held)) this.motion.slash(meleeStyleOf(this.held.assetId));
    else this.kick = 1;
  }

  onHit(direction: THREE.Vector3): void {
    this.flinch = 1;
    const by = this.lower.yaw;
    const right = Math.cos(by) * direction.x - Math.sin(by) * direction.z;
    this.flinchSide = right > 0 ? -1 : 1;
  }

  setWeaponSkin(assetId: string | undefined): void {
    if (assetId === this.standInSkin) return;
    this.standInSkin = dressStandIn(this.rifle, this.kit.gun, this.kit.dark, assetId);
  }

  get weaponSkin(): string | undefined {
    return this.held.real ? this.held.assetId : this.standInSkin;
  }

  setWeapon(weaponId: string | undefined, assetId: string | undefined): void {
    this.held.set(weaponId, assetId);
  }

  reset(): void {
    this.lower.reset();
    this.motion.reset();
    this.phase = 0;
    this.move = 0;
    this.raise = 0;
    this.kick = 0;
    this.flinch = 0;
  }

  /** Only this model's own geometry (the rifle, the legs); the character's geometry and materials belong to the loaded file. */
  dispose(): void {
    this.held.dispose();
    this.object.removeFromParent();
    this.lower.dispose();
    this.geometries.forEach((g) => g.dispose());
  }
}
