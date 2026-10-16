import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { GltfFit } from '../WeaponDefinition';
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
 *
 * A file exported without these nodes or in other axes can be used as is
 * with a `GltfFit` (weapons.ts): the scene is rotated into model space under
 * a wrapper, missing anchors come from the fit, and the listed file nodes are
 * gathered into Magazine / Bolt groups for the existing reload and bolt motion.
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

  constructor(scene: THREE.Object3D, fit?: GltfFit) {
    // A scene wrapping a single weapon object takes that object's name (for debugging).
    if (scene.children.length === 1 && scene.children[0].name) scene.name = scene.children[0].name;
    let root = scene;
    if (fit) {
      // Model space is the wrapper; the file's scene sits inside it, rotated.
      root = new THREE.Group();
      root.name = scene.name;
      if (fit.rotation) scene.rotation.set(fit.rotation[0], fit.rotation[1], fit.rotation[2]);
      root.add(scene);
    }
    this.object = root;
    root.updateMatrixWorld(true);
    const find = (name: string) => root.getObjectByName(name) ?? null;

    const gripNode = find('Grip_R');
    if (gripNode) copyRootSpaceTransform(root, gripNode, this.gripAnchor);
    else if (fit?.grip) placeAnchor(this.gripAnchor, 'Grip_R', fit.grip);
    else console.warn('[weapon] GLB has no Grip_R node; the right hand is placed at the model origin.');
    const supportNode = find('Grip_L');
    this.supportAnchor = supportNode
      ? copyRootSpaceTransform(root, supportNode, new THREE.Object3D())
      : fit?.support
        ? placeAnchor(new THREE.Object3D(), 'Grip_L', fit.support)
        : null;
    this.object.add(this.gripAnchor);
    if (this.supportAnchor) this.object.add(this.supportAnchor);

    this.muzzle = find('Muzzle');
    if (!this.muzzle && fit?.muzzle) {
      this.muzzle = new THREE.Object3D();
      this.muzzle.name = 'Muzzle';
      this.muzzle.position.set(fit.muzzle[0], fit.muzzle[1], fit.muzzle[2]);
      root.add(this.muzzle);
    }
    this.magazine = find('Magazine') ?? undefined;
    if (fit?.magazine) this.magazine = gather(root, 'Magazine', fit.magazine, [0, 0, 0]);
    this.bolt = find('Bolt') ?? undefined;
    if (fit?.bolt) this.bolt = gather(root, 'Bolt', fit.bolt.nodes, fit.bolt.pivot);
    if (this.bolt) this.boltRest.copy(this.bolt.position);

    const extras = (gripNode?.userData ?? {}) as Record<string, unknown>;
    this.rightHand = fit?.hand ?? {
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
    if (fit?.armPose) this.armPose = fit.armPose;

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
/** Scenes that have finished loading, so a view can be built without waiting. */
const loaded = new Map<string, THREE.Object3D>();

/** Starts (or reuses) the one download of a GLB. */
export function loadGltfScene(url: string): Promise<THREE.Object3D> {
  let scene = cache.get(url);
  if (!scene) {
    scene = new GLTFLoader().loadAsync(url).then((g) => {
      loaded.set(url, g.scene);
      return g.scene;
    });
    cache.set(url, scene);
    scene.catch(() => cache.delete(url));
  }
  return scene;
}

/** Loads (once per URL) and returns a fresh view; instances share geometry/materials. */
export async function loadGltfWeaponView(url: string, fit?: GltfFit): Promise<GltfWeaponView> {
  return new GltfWeaponView((await loadGltfScene(url)).clone(true), fit);
}

export function isGltfLoaded(url: string): boolean {
  return loaded.has(url);
}

/** A fresh view right away if the GLB has already loaded, else null. */
export function loadedGltfWeaponView(url: string, fit?: GltfFit): GltfWeaponView | null {
  const scene = loaded.get(url);
  return scene ? new GltfWeaponView(scene.clone(true), fit) : null;
}

/** Writes `node`'s transform relative to `root` into `target` (anchors may be nested in the GLB). */
function copyRootSpaceTransform(root: THREE.Object3D, node: THREE.Object3D, target: THREE.Object3D): THREE.Object3D {
  const m = new THREE.Matrix4().copy(root.matrixWorld).invert().multiply(node.matrixWorld);
  m.decompose(target.position, target.quaternion, target.scale);
  target.scale.set(1, 1, 1);
  target.name = node.name;
  return target;
}

function placeAnchor(target: THREE.Object3D, name: string, a: { position: readonly number[]; rotation?: readonly number[] }): THREE.Object3D {
  target.name = name;
  target.position.set(a.position[0], a.position[1], a.position[2]);
  if (a.rotation) target.rotation.set(a.rotation[0], a.rotation[1], a.rotation[2]);
  return target;
}

/** Moves the named nodes (keeping where they are) into a new group whose origin is `pivot`. */
function gather(root: THREE.Object3D, name: string, nodes: readonly string[], pivot: readonly number[]): THREE.Object3D {
  const group = new THREE.Group();
  group.name = name;
  group.position.set(pivot[0], pivot[1], pivot[2]);
  root.add(group);
  root.updateMatrixWorld(true);
  for (const n of nodes) {
    const node = root.getObjectByName(n);
    if (node && node !== group) group.attach(node);
    else console.warn(`[weapon] GLB node "${n}" not found for ${name}`);
  }
  return group;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function vec3(v: unknown): [number, number, number] | null {
  return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number') ? [v[0], v[1], v[2]] : null;
}
