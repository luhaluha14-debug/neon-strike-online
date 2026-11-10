import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { GltfFit } from '../WeaponDefinition';
import { PISTOL_GRIP, type ArmPose, type HandGripProfile } from './HandGrip';
import { animateBolt } from './SniperRifleView';
import type { WeaponAnimState, WeaponView } from './WeaponView';
import { prepareWeaponScene } from './WeaponSurface';

/**
 * A first-person weapon loaded from a Blender GLB.
 *
 * Node names (empties or meshes) the game looks for:
 *   Grip_R   firing-hand pose (required; +Y along the grip, +Z toward the shooter)
 *   Grip_L   support-hand pose (optional; omit for one-handed weapons)
 *   Muzzle   muzzle flash position (optional)
 *   Magazine part that drops out on reload (optional, best as a direct child of the root)
 *   Bolt     bolt-action part, cycled after each shot (optional)
 * Moving parts animated when present (tools/rig-weapons.mjs splits them out of one-piece models):
 *   Slide            pistol slide: back and forward on each shot, locked back on an empty magazine
 *   Trigger / Trigger pulled while a round fires
 *   Pump, PumpBolt   pump action fore-end and bolt: racked with the support hand after each round
 *   ChargingHandle / Charging_Handle   pulled at the end of a reload
 *   Shell            shotgun shell pushed in through the loading port on each reload insert
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
  readonly reloadGrab?: THREE.Object3D;
  readonly gripAnchor = new THREE.Object3D();
  readonly supportAnchor: THREE.Object3D | null;
  readonly rightHand: HandGripProfile;
  readonly armPose?: ArmPose;
  private readonly bolt?: THREE.Object3D;
  private readonly boltRest = new THREE.Vector3();
  private readonly supportRest = new THREE.Vector3();
  readonly magazineDrop?: THREE.Vector3;
  readonly ejectPort?: THREE.Object3D;
  /** Moving parts found in the file, each with its rest position and the model's "back" (+Z) / "up" in its parent's space. */
  private readonly parts: Partial<Record<'slide' | 'trigger' | 'pump' | 'pumpBolt' | 'handle' | 'shell' | 'cover', MovingPart>> = {};

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
    // Parted files: the file's nodes gathered into the game's named parts first (and a static turn, e.g. a folded bipod).
    for (const g of fit?.groups ?? []) {
      const group = gather(root, g.name, g.nodes, g.pivot ?? [0, 0, 0]);
      if (g.rotation) group.rotation.set(g.rotation[0], g.rotation[1], g.rotation[2]);
      if (g.scale) group.scale.set(g.scale[0], g.scale[1], g.scale[2]);
    }

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
    if (this.supportAnchor) {
      this.object.add(this.supportAnchor);
      this.supportRest.copy(this.supportAnchor.position);
    }

    this.muzzle = find('Muzzle');
    if (!this.muzzle && fit?.muzzle) {
      this.muzzle = new THREE.Object3D();
      this.muzzle.name = 'Muzzle';
      this.muzzle.position.set(fit.muzzle[0], fit.muzzle[1], fit.muzzle[2]);
      root.add(this.muzzle);
    }
    this.magazine = find('Magazine') ?? undefined;
    if (fit?.magazine) this.magazine = gather(root, 'Magazine', fit.magazine, fit.magazinePivot ?? [0, 0, 0]);
    if (!this.magazine && fit?.magwell) {
      this.reloadGrab = new THREE.Object3D();
      this.reloadGrab.name = 'MagWell';
      this.reloadGrab.position.set(fit.magwell[0], fit.magwell[1], fit.magwell[2]);
      root.add(this.reloadGrab);
    }
    if (this.magazine && fit?.magazineDrop) this.magazineDrop = dirInParent(this.magazine, new THREE.Vector3(...fit.magazineDrop));
    const part = (name: string): MovingPart | undefined => {
      const o = find(name);
      if (!o) return undefined;
      return { o, rest: o.position.clone(), restX: o.rotation.x, back: dirInParent(o, new THREE.Vector3(0, 0, 1)), up: dirInParent(o, new THREE.Vector3(0, 1, 0)) };
    };
    this.parts.slide = part('Slide');
    this.parts.trigger = part('Trigger');
    this.parts.pump = part('Pump');
    this.parts.pumpBolt = part('PumpBolt');
    this.parts.handle = part('ChargingHandle') ?? part('Charging_Handle');
    this.parts.shell = part('Shell');
    this.parts.cover = part('FeedCover');
    // Ejection port: the file's own node, else the fit's point (model space).
    const portNode = find('Ejection_Port') ?? find('Dust_Cover');
    if (portNode) {
      // A modelled part (its origin may sit anywhere, e.g. at the model origin): the port is the middle
      // of its geometry, kept on the part so it follows it.
      const box = new THREE.Box3().setFromObject(portNode);
      if (box.isEmpty()) this.ejectPort = portNode;
      else {
        const anchor = new THREE.Object3D();
        anchor.name = 'EjectPort';
        portNode.add(anchor);
        anchor.position.copy(portNode.worldToLocal(box.getCenter(new THREE.Vector3())));
        this.ejectPort = anchor;
      }
    }
    if (!this.ejectPort && fit?.ejectPort) {
      this.ejectPort = new THREE.Object3D();
      this.ejectPort.name = 'EjectPort';
      this.ejectPort.position.set(fit.ejectPort[0], fit.ejectPort[1], fit.ejectPort[2]);
      root.add(this.ejectPort);
    }
    if (this.parts.shell) this.parts.shell.o.visible = false;
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
    // Pump action: the support hand racks the fore-end (and with it the bolt) back and forward after each round.
    if (state.category === 'shotgun') {
      const pump = pumpTravel(state.sinceShot) * PUMP_TRAVEL;
      if (this.supportAnchor) this.supportAnchor.position.z = this.supportRest.z + pump;
      move(this.parts.pump, pump);
      move(this.parts.pumpBolt, pump);
    }
    move(this.parts.slide, slideTravel(state) * SLIDE_TRAVEL);
    // Trigger pulled while a round goes (a few mm, the blade's travel).
    move(this.parts.trigger, state.sinceShot < 0.08 && state.category !== 'melee' ? 0.004 : 0);
    // Charging handle racked at the end of a reload (the charge / chamber sound).
    move(this.parts.handle, state.reload === null ? 0 : chargeTravel(state.reload) * (state.category === 'smg' ? 0.045 : 0.06));
    // Belt-fed reload: the feed cover swings up on its front hinge while the belt is laid in.
    if (this.parts.cover) this.parts.cover.o.rotation.x = this.parts.cover.restX - (state.reload === null ? 0 : coverOpen(state.reload)) * COVER_ANGLE;
    if (this.parts.shell) shellInsert(this.parts.shell, state);
  }

  dispose(): void {
    // Geometry and materials belong to the shared cached GLB; nothing per-instance to free.
    this.object.removeFromParent();
  }
}

/** How far the support hand racks a pump action back (m, toward the shooter). */
const PUMP_TRAVEL = 0.075;
/** Pistol slide travel (m). */
const SLIDE_TRAVEL = 0.028;
/** How far a belt-fed gun's feed cover opens (rad, ~70°). */
const COVER_ANGLE = 1.22;

interface MovingPart {
  o: THREE.Object3D;
  rest: THREE.Vector3;
  /** Rest turn about the model's X axis (a hinged part). */
  restX: number;
  /** Model +Z (toward the shooter) in the part's parent space. */
  back: THREE.Vector3;
  /** Model +Y in the part's parent space. */
  up: THREE.Vector3;
}

/** A model-space direction expressed in `o`'s parent space (the model root is the topmost ancestor, unrotated). */
function dirInParent(o: THREE.Object3D, modelDir: THREE.Vector3): THREE.Vector3 {
  let top: THREE.Object3D = o;
  while (top.parent) top = top.parent;
  top.updateMatrixWorld(true);
  const q = new THREE.Quaternion();
  o.parent ? o.parent.getWorldQuaternion(q) : q.identity();
  return modelDir.clone().applyQuaternion(q.invert()).normalize();
}

/** Moves a part `amount` m back (toward the shooter) from rest. */
function move(p: MovingPart | undefined, amount: number): void {
  if (p) p.o.position.copy(p.rest).addScaledVector(p.back, amount);
}

/**
 * Pistol slide, 0 (forward) .. 1 (back): a short cycle after each round (back in 25 ms, home by 70 ms),
 * locked back on an empty magazine until the end of its reload (released at 0.9-0.95, the slide sound).
 */
export function slideTravel(s: WeaponAnimState): number {
  if (s.category !== 'pistol') return 0;
  if (s.empty && (s.reload === null || s.reload < 0.9)) return 1;
  if (s.empty && s.reload !== null) return 1 - Math.min(1, (s.reload - 0.9) / 0.05);
  const t = s.sinceShot;
  if (t < 0.025) return t / 0.025;
  if (t < 0.07) return 1 - (t - 0.025) / 0.045;
  return 0;
}

/** Charging handle, 0..1: pulled back at 0.86-0.92 of a reload and let go (snaps home by 0.95). */
export function chargeTravel(t: number): number {
  if (t < 0.86 || t > 0.95) return 0;
  if (t < 0.92) return (t - 0.86) / 0.06;
  return 1 - (t - 0.92) / 0.03;
}

/**
 * Feed cover of a belt-fed reload, 0 (shut) .. 1 (open): up at 0.02-0.12 (the cover sound at 0.03), open
 * while the box goes out and the new belt goes in, shut at 0.86-0.9 (closing sound at 0.88), before the
 * charging handle (0.86-0.95).
 */
export function coverOpen(t: number): number {
  const ease = (x: number) => x * x * (3 - 2 * x);
  if (t < 0.02 || t > 0.9) return 0;
  if (t < 0.12) return ease((t - 0.02) / 0.1);
  if (t < 0.86) return 1;
  return 1 - ease((t - 0.86) / 0.04);
}

/** Shotgun reload: a shell comes up to the loading port and is pushed in at each insert (0.15, 0.4, 0.65). */
function shellInsert(p: MovingPart, s: WeaponAnimState): void {
  p.o.visible = false;
  if (s.category !== 'shotgun' || s.reload === null) return;
  for (const at of SHELL_INSERTS) {
    const k = (s.reload - (at - 0.08)) / 0.13;
    if (k < 0 || k > 1) continue;
    p.o.visible = true;
    // Up from the hand below the port (60 %), then forward into the magazine tube.
    const rise = Math.min(1, k / 0.6);
    const push = Math.max(0, (k - 0.6) / 0.4);
    p.o.position.copy(p.rest).addScaledVector(p.up, (rise - 1) * 0.08).addScaledVector(p.back, -push * 0.04);
  }
}
const SHELL_INSERTS = [0.15, 0.4, 0.65];

/**
 * Pump stroke after a round, 0 (forward) .. 1 (racked back), timed to the pump sound
 * (`sg01.pump`: back 0.12-0.24 s, forward 0.30-0.40 s after the shot).
 */
export function pumpTravel(sinceShot: number): number {
  const ease = (x: number) => x * x * (3 - 2 * x);
  if (sinceShot < 0.12 || sinceShot >= 0.4) return 0;
  if (sinceShot < 0.24) return ease((sinceShot - 0.12) / 0.12);
  if (sinceShot < 0.3) return 1;
  return 1 - ease((sinceShot - 0.3) / 0.1);
}

const cache = new Map<string, Promise<THREE.Object3D>>();
/** Scenes that have finished loading, so a view can be built without waiting. */
const loaded = new Map<string, THREE.Object3D>();

/** Starts (or reuses) the one download of a GLB. */
export function loadGltfScene(url: string): Promise<THREE.Object3D> {
  let scene = cache.get(url);
  if (!scene) {
    scene = new GLTFLoader().loadAsync(url).then((g) => {
      // Weapon files (not the characters): cutter leftovers darkened, surface grain on the materials.
      if (url.startsWith('/weapons/')) prepareWeaponScene(g.scene);
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

/** The loaded scene of a GLB (shared: clone it before adding it anywhere), or null while loading / failed. */
export function loadedGltfScene(url: string): THREE.Object3D | null {
  return loaded.get(url) ?? null;
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
