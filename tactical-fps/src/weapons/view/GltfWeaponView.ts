import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PISTOL_GRIP, type ArmPose, type HandGripProfile } from './HandGrip';
import { animateBolt } from './SniperRifleView';
import type { WeaponAnimState, WeaponView } from './WeaponView';

/**
 * A first-person weapon loaded from a Blender GLB.
 *
 * Node names (empties or meshes) the game looks for:
 *   Grip_R   firing-hand pose (required; +Y along the grip, +Z toward the shooter)
 *   Grip_L   support-hand pose (optional; omit for one-handed weapons)
 *   Muzzle   muzzle flash position (optional)
 *   Magazine part that drops out on reload (optional, best as a direct child of the root)
 *   Bolt     bolt-action part, cycled after each shot (optional)
 *
 * Custom properties on Grip_R (exported as glTF extras) shape the glove:
 *   grip_width, grip_depth (m), grip_index ("trigger" | "ring"), wrist_lift (m)
 * and on the weapon object: right_elbow / left_elbow ([x, y, z]) to steer the arms.
 *
 * Blender is Z-up: model the barrel along Blender +Y with +Z up; the glTF
 * exporter turns that into the game's -Z forward / +Y up.
 */
export class GltfWeaponView implements WeaponView {
  readonly object: THREE.Object3D;
  readonly muzzle: THREE.Object3D | null;
  readonly magazine?: THREE.Object3D;
  readonly gripAnchor = new THREE.Object3D();
  readonly supportAnchor: THREE.Object3D | null;
  readonly rightHand: HandGripProfile;
  readonly armPose?: ArmPose;
  private readonly bolt?: THREE.Object3D;
  private readonly boltRest = new THREE.Vector3();

  constructor(root: THREE.Object3D) {
    this.object = root;
    // A scene wrapping a single weapon object takes that object's name (for debugging).
    if (root.children.length === 1 && root.children[0].name) root.name = root.children[0].name;
    root.updateMatrixWorld(true);
    const find = (name: string) => root.getObjectByName(name) ?? null;

    const gripNode = find('Grip_R');
    if (gripNode) copyRootSpaceTransform(root, gripNode, this.gripAnchor);
    else console.warn('[weapon] GLB has no Grip_R node; the right hand is placed at the model origin.');
    const supportNode = find('Grip_L');
    this.supportAnchor = supportNode ? copyRootSpaceTransform(root, supportNode, new THREE.Object3D()) : null;
    this.object.add(this.gripAnchor);
    if (this.supportAnchor) this.object.add(this.supportAnchor);

    this.muzzle = find('Muzzle');
    this.magazine = find('Magazine') ?? undefined;
    this.bolt = find('Bolt') ?? undefined;
    if (this.bolt) this.boltRest.copy(this.bolt.position);

    const extras = (gripNode?.userData ?? {}) as Record<string, unknown>;
    this.rightHand = {
      width: num(extras.grip_width, PISTOL_GRIP.width),
      depth: num(extras.grip_depth, PISTOL_GRIP.depth),
      index: extras.grip_index === 'ring' ? 'ring' : 'trigger',
      wristLift: num(extras.wrist_lift, 0),
    };
    // Arm hints may sit on the scene root or on the weapon object below it.
    let re: [number, number, number] | null = null;
    let le: [number, number, number] | null = null;
    root.traverse((o) => {
      re ??= vec3(o.userData.right_elbow);
      le ??= vec3(o.userData.left_elbow);
    });
    if (re || le) this.armPose = { rightElbow: re ?? undefined, leftElbow: le ?? undefined };

    root.traverse((o) => {
      o.frustumCulled = false;
    });
  }

  animate(state: WeaponAnimState): void {
    if (this.bolt) animateBolt(this.bolt, this.boltRest, state);
  }

  dispose(): void {
    // Geometry and materials belong to the shared cached GLB; nothing per-instance to free.
    this.object.removeFromParent();
  }
}

const cache = new Map<string, Promise<THREE.Object3D>>();

/** Loads (once per URL) and returns a fresh view; instances share geometry/materials. */
export async function loadGltfWeaponView(url: string): Promise<GltfWeaponView> {
  let scene = cache.get(url);
  if (!scene) {
    scene = new GLTFLoader().loadAsync(url).then((g) => g.scene);
    cache.set(url, scene);
    scene.catch(() => cache.delete(url));
  }
  return new GltfWeaponView((await scene).clone(true));
}

/** Writes `node`'s transform relative to `root` into `target` (anchors may be nested in the GLB). */
function copyRootSpaceTransform(root: THREE.Object3D, node: THREE.Object3D, target: THREE.Object3D): THREE.Object3D {
  const m = new THREE.Matrix4().copy(root.matrixWorld).invert().multiply(node.matrixWorld);
  m.decompose(target.position, target.quaternion, target.scale);
  target.scale.set(1, 1, 1);
  target.name = node.name;
  return target;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function vec3(v: unknown): [number, number, number] | null {
  return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number') ? [v[0], v[1], v[2]] : null;
}
