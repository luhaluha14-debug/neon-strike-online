import * as THREE from 'three';
import { loadGltfScene, loadedGltfScene } from '../weapons/view/GltfWeaponView';
import { PLAYER_CONFIG } from '../config';
import { buildBotRifle, RIFLE_MUZZLE_Z, type BotBody, type BotKit, type BotPose } from './BotModel';

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
/** Pistol grip of buildBotRifle in rifle space. */
const RIFLE_GRIP = new THREE.Vector3(0, -0.07, -0.04);
/** How far the back of the figure reaches behind the feet (lifts the body when it lies on its back). */
const BACK_DEPTH = 0.2;
const DEATH_FALL = 0.5;
/** Step bob length (m per bob) and height while running. */
const BOB_STRIDE = 0.7;
const BOB_HEIGHT = 0.03;

export class AgentModel implements BotBody {
  readonly object = new THREE.Group();
  readonly muzzle = new THREE.Object3D();
  /** The file's scene, turned to face -Z. */
  private readonly body = new THREE.Group();
  private readonly rifle: THREE.Group;
  private readonly rifleRest = new THREE.Vector3();
  private readonly geometries: THREE.BufferGeometry[] = [];
  private bodyYaw = 0;
  private initialized = false;
  private phase = 0;
  private move = 0;
  private raise = 0;
  private kick = 0;
  private flinch = 0;
  private flinchSide = 0;

  /** The character for a bot of `team`, or null while its file is not loaded (the caller keeps the built-in body). */
  static create(team: string | undefined, kit: BotKit): AgentModel | null {
    const scene = loadedGltfScene(agentModelUrl(team));
    return scene ? new AgentModel(scene, kit) : null;
  }

  /** `template`: the loaded file scene (shared; cloned here, geometry and materials stay shared). */
  constructor(template: THREE.Object3D, kit: BotKit) {
    this.object.name = 'AgentModel';
    const file = template.clone(true);
    file.position.set(-FILE_CENTRE.x, -FILE_CENTRE.y, -FILE_CENTRE.z);
    this.body.rotation.y = Math.PI;
    this.body.add(file);
    this.object.add(this.body);
    // The bots' rifle with its grip in the hands, barrel forward.
    this.rifle = buildBotRifle(kit, this.geometries);
    this.rifleRest.copy(HANDS).sub(RIFLE_GRIP);
    this.rifle.position.copy(this.rifleRest);
    this.muzzle.position.set(0, 0, RIFLE_MUZZLE_Z);
    this.rifle.add(this.muzzle);
    this.object.add(this.rifle);
    this.object.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      // The map's shadow map is baked once (static); bodies only receive it.
      m.castShadow = false;
      m.receiveShadow = true;
    });
  }

  update(dt: number, p: BotPose): void {
    if (!this.initialized) {
      this.bodyYaw = p.yaw;
      this.initialized = true;
    }
    // No rig: the whole figure turns to the aim (quickly, but not snapping).
    if (p.alive) this.bodyYaw += wrap(p.yaw - this.bodyYaw) * (1 - Math.exp(-14 * dt));
    const speed = p.alive ? Math.hypot(p.velocity.x, p.velocity.z) : 0;
    this.move += ((p.grounded ? Math.min(speed / PLAYER_CONFIG.runSpeed, 1) : 0) - this.move) * (1 - Math.exp(-10 * dt));
    this.phase += (speed * dt * Math.PI) / BOB_STRIDE;
    this.raise += ((p.aiming ? 1 : 0) - this.raise) * (1 - Math.exp(-9 * dt));
    this.kick = Math.max(0, this.kick - dt * 10);
    this.flinch = Math.max(0, this.flinch - dt * 5);

    this.object.position.copy(p.feet);
    // A small step bob stands in for the missing walk cycle.
    this.object.position.y += Math.abs(Math.sin(this.phase)) * BOB_HEIGHT * this.move;
    this.object.rotation.set(0, this.bodyYaw, 0);
    this.body.rotation.z = this.flinch * 0.08 * this.flinchSide;
    // Rifle follows the aim pitch when engaging; recoil kick.
    this.rifle.position.copy(this.rifleRest);
    this.rifle.position.z += this.kick * 0.03;
    this.rifle.rotation.set(THREE.MathUtils.clamp(p.pitch, -1, 1) * 0.8 * this.raise + this.kick * 0.1, 0, 0);
    this.rifle.visible = true;

    if (!p.alive) {
      // Falls onto its back about the feet, as the built-in body does; the rifle is dropped.
      const t = Math.min(p.deadTime / DEATH_FALL, 1);
      const fall = t * t;
      this.object.position.y += BACK_DEPTH * fall;
      this.object.rotateX((Math.PI / 2) * 0.97 * fall);
      this.object.rotateZ(0.25 * fall);
      this.rifle.visible = fall < 0.35;
    }
  }

  onShot(): void {
    this.kick = 1;
  }

  onHit(direction: THREE.Vector3): void {
    this.flinch = 1;
    const right = Math.cos(this.bodyYaw) * direction.x - Math.sin(this.bodyYaw) * direction.z;
    this.flinchSide = right > 0 ? -1 : 1;
  }

  reset(): void {
    this.initialized = false;
    this.phase = 0;
    this.move = 0;
    this.raise = 0;
    this.kick = 0;
    this.flinch = 0;
  }

  /** Only this model's own geometry (the rifle); the character's geometry and materials belong to the loaded file. */
  dispose(): void {
    this.object.removeFromParent();
    this.geometries.forEach((g) => g.dispose());
  }
}

function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
