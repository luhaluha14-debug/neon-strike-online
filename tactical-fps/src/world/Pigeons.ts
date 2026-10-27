import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { LoadedMap } from './MapLoader';

// Ambient pigeons (public/props/pigeon.glb, made in Blender): flocks circling
// over every map with the file's own wing-beat animation, and a few birds
// perched on roofs and open ground, pecking now and then. Scenery only: not
// in the collision or hit-scan world, invisible to bots, no shadows.
//
// The file holds two birds: a standing one (parts at the scene root, each
// exported twice — the `.001` copies are skipped) and a flying one
// (`Pigeon_Root`, wings on the `Shoulder_*` / `Wrist_*` joints, 6.04 s of
// animation). Both face +X; the file's bird is ~0.9 m tall and is scaled to
// pigeon size. Parts are flat-coloured, so each bird is merged into a few
// vertex-coloured meshes (body, and one per wing segment so the wings can
// beat).

export const PIGEON_URL = '/props/pigeon.glb';

/** File units → metres (a feral pigeon stands ~0.3 m tall). */
const SCALE = 0.32;
const FLOCKS = 2;
const BIRDS_PER_FLOCK = 3;
const PERCHED = 8;
/** Clearance above the highest roof under a flock's circle (m). */
const FLIGHT_CLEARANCE = 6;
/** Wing joints driven by the file's animation (its root flight path is replaced by circling over the map). */
const WING_JOINTS = ['Shoulder_L', 'Wrist_L', 'Shoulder_R', 'Wrist_R'];

type PigeonFile = { scene: THREE.Object3D; clips: THREE.AnimationClip[] } | null;
let file: Promise<PigeonFile> | null = null;

/** Downloads the pigeon file once; a failure means no pigeons (the game is unaffected). */
export function preloadPigeons(): Promise<PigeonFile> {
  file ??= new GLTFLoader()
    .loadAsync(PIGEON_URL)
    .then((g): PigeonFile => ({ scene: g.scene, clips: g.animations }))
    .catch((err) => {
      console.warn('[pigeons] model unavailable: no pigeons', err);
      return null;
    });
  return file;
}

interface Flock {
  center: THREE.Vector2;
  radius: number;
  height: number;
  /** rad/s, sign = direction. */
  rate: number;
  angle: number;
  birds: { object: THREE.Object3D; mixer: THREE.AnimationMixer; offset: THREE.Vector3 }[];
}

interface Perched {
  position: THREE.Vector3;
  yaw: number;
  phase: number;
  rate: number;
}

export class Pigeons {
  readonly object = new THREE.Group();
  readonly flocks: Flock[] = [];
  readonly perched: Perched[] = [];
  private perchedMesh: THREE.InstancedMesh | null = null;
  private time = 0;

  /**
   * Pigeons for `map`, placed from its collision (same places every load of
   * that map), or null while / if the file is not loaded. The result is
   * added under `map.root`, so it goes away with the map.
   */
  static async create(map: LoadedMap, seedText: string): Promise<Pigeons | null> {
    const loaded = await preloadPigeons();
    if (!loaded) return null;
    const p = new Pigeons(map, loaded.scene, loaded.clips, seed(seedText));
    map.root.add(p.object);
    return p;
  }

  private constructor(map: LoadedMap, scene: THREE.Object3D, clips: THREE.AnimationClip[], rand: () => number) {
    this.object.name = 'Pigeons';
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
    scene.updateMatrixWorld(true);
    const flyer = scene.getObjectByName('Pigeon_Root');
    const wingClips = clips.filter((c) => WING_JOINTS.some((j) => c.name.startsWith(j)));

    // Perched birds: one instanced mesh for all of them.
    const standing = scene.children.filter((o) => o !== flyer && !o.name.endsWith('.001'));
    const standingGeom = mergeColored(standing, new THREE.Matrix4());
    const bounds = map.playBounds;
    const size = bounds.getSize(new THREE.Vector3());
    const down = new THREE.Vector3(0, -1, 0);
    const normal = new THREE.Vector3();
    const top = bounds.max.y + 30;
    for (let tries = 0; tries < PERCHED * 12 && this.perched.length < PERCHED; tries++) {
      const x = bounds.min.x + 2 + rand() * Math.max(size.x - 4, 0);
      const z = bounds.min.z + 2 + rand() * Math.max(size.z - 4, 0);
      const origin = new THREE.Vector3(x, top, z);
      const d = map.collision.raycast(origin, down, top - bounds.min.y + 50, normal);
      if (d === null || normal.y < 0.9) continue;
      const position = origin.addScaledVector(down, d);
      if (this.perched.some((q) => q.position.distanceTo(position) < 1.5)) continue;
      this.perched.push({ position, yaw: rand() * Math.PI * 2, phase: rand() * 10, rate: 0.6 + rand() * 0.6 });
    }
    if (standingGeom && this.perched.length) {
      this.perchedMesh = new THREE.InstancedMesh(standingGeom, material, this.perched.length);
      this.perchedMesh.name = 'Pigeons_Perched';
      this.perchedMesh.frustumCulled = false;
      this.object.add(this.perchedMesh);
      this.updatePerched();
    }

    // Flying birds: flocks circling above the roofs.
    if (flyer) {
      const template = buildFlyer(flyer);
      const center = bounds.getCenter(new THREE.Vector3());
      const span = Math.min(size.x, size.z);
      for (let f = 0; f < FLOCKS; f++) {
        const radius = span * (0.18 + 0.14 * f + rand() * 0.06);
        const c = new THREE.Vector2(center.x + (rand() - 0.5) * span * 0.15, center.z + (rand() - 0.5) * span * 0.15);
        const height = roofUnder(map, c, radius, bounds) + FLIGHT_CLEARANCE + f * 3 + rand() * 3;
        const speed = 7 + rand() * 2;
        const flock: Flock = { center: c, radius, height, rate: (speed / radius) * (f % 2 ? -1 : 1), angle: rand() * Math.PI * 2, birds: [] };
        for (let b = 0; b < BIRDS_PER_FLOCK; b++) {
          const object = template.clone(true);
          object.scale.setScalar(SCALE);
          const mixer = new THREE.AnimationMixer(object);
          for (const clip of wingClips) mixer.clipAction(clip).play();
          // Each bird beats its wings out of step with the others.
          mixer.setTime(rand() * (wingClips[0]?.duration ?? 1));
          const offset = new THREE.Vector3(-b * 1.6 - rand() * 0.6, (rand() - 0.5) * 1.2, (b % 2 ? 1 : -1) * b * 1.1);
          this.object.add(object);
          flock.birds.push({ object, mixer, offset });
        }
        this.flocks.push(flock);
      }
    }
    this.object.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        (o as THREE.Mesh).material = material;
        o.castShadow = false;
        o.receiveShadow = false;
      }
    });
    this.update(0);
  }

  /** Advances flight, wing beats and pecking. */
  update(dt: number): void {
    this.time += dt;
    const fwd = new THREE.Vector3();
    for (const f of this.flocks) {
      f.angle += f.rate * dt;
      const cos = Math.cos(f.angle);
      const sin = Math.sin(f.angle);
      // Tangent of the circle in the flight direction.
      const dir = Math.sign(f.rate) || 1;
      fwd.set(-sin * dir, 0, cos * dir);
      const yaw = Math.atan2(-fwd.z, fwd.x);
      // Lean into the turn (local +Z is the bird's right; the centre is on the right when flying counter-clockwise).
      const bank = dir * 0.3;
      for (const b of f.birds) {
        b.mixer.update(dt);
        const side = b.offset.z;
        const back = b.offset.x;
        const x = f.center.x + cos * (f.radius + side * dir) + fwd.x * back;
        const z = f.center.y + sin * (f.radius + side * dir) + fwd.z * back;
        const y = f.height + b.offset.y + Math.sin(this.time * 0.7 + back) * 0.6;
        b.object.position.set(x, y, z);
        b.object.rotation.set(bank, yaw, 0, 'YXZ');
      }
    }
    this.updatePerched();
  }

  private updatePerched(): void {
    const mesh = this.perchedMesh;
    if (!mesh) return;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const s = new THREE.Vector3().setScalar(SCALE);
    this.perched.forEach((p, i) => {
      // A peck: short forward dips every few seconds.
      const w = Math.sin(this.time * p.rate * Math.PI + p.phase);
      const peck = w > 0.92 ? (w - 0.92) * 6 : 0;
      e.set(0, p.yaw, -peck, 'YXZ');
      q.setFromEuler(e);
      m.compose(p.position, q, s);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }
}

/** The flying bird with its parts merged: body + one mesh per wing segment, joints kept for the animation. */
function buildFlyer(source: THREE.Object3D): THREE.Object3D {
  const root = new THREE.Group();
  root.name = 'Pigeon_Flyer';
  const joints = new Map<string, THREE.Object3D>();
  const jointOf = (o: THREE.Object3D): THREE.Object3D | null => {
    for (let p: THREE.Object3D | null = o; p && p !== source; p = p.parent) if (WING_JOINTS.includes(p.name)) return p;
    return null;
  };
  // Joints with their rest transforms, nested as in the file.
  for (const name of WING_JOINTS) {
    const j = source.getObjectByName(name);
    if (!j) continue;
    const copy = new THREE.Object3D();
    copy.name = name;
    copy.position.copy(j.position);
    copy.quaternion.copy(j.quaternion);
    copy.scale.copy(j.scale);
    joints.set(name, copy);
  }
  for (const [name, copy] of joints) {
    const parentName = source.getObjectByName(name)!.parent?.name ?? '';
    (joints.get(parentName) ?? root).add(copy);
  }
  // Parts grouped by the joint that moves them (none = body).
  const groups = new Map<THREE.Object3D | null, THREE.Object3D[]>();
  source.traverse((o) => {
    if (!(o as THREE.Mesh).isMesh) return;
    const j = jointOf(o);
    const list = groups.get(j) ?? [];
    list.push(o);
    groups.set(j, list);
  });
  const inverse = new THREE.Matrix4();
  for (const [joint, parts] of groups) {
    // Geometry in the space of its joint (or of the bird root).
    inverse.copy((joint ?? source).matrixWorld).invert();
    const geom = mergeColored(parts, inverse);
    if (!geom) continue;
    const mesh = new THREE.Mesh(geom);
    mesh.name = joint ? `${joint.name}_Mesh` : 'Body_Mesh';
    (joint ? joints.get(joint.name)! : root).add(mesh);
  }
  return root;
}

/** Merges meshes into one geometry (positions, normals, vertex colours from their material colours), in the space given by `toSpace` × world. */
function mergeColored(objects: readonly THREE.Object3D[], toSpace: THREE.Matrix4): THREE.BufferGeometry | null {
  const parts: THREE.BufferGeometry[] = [];
  const m = new THREE.Matrix4();
  for (const obj of objects) {
    obj.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const src = mesh.geometry;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', src.getAttribute('position').clone());
      if (src.getAttribute('normal')) g.setAttribute('normal', src.getAttribute('normal').clone());
      if (src.index) g.setIndex(src.index.clone());
      const color = ((Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial).color ?? new THREE.Color(0.5, 0.5, 0.5);
      const n = g.getAttribute('position').count;
      const colors = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) color.toArray(colors, i * 3);
      g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      m.multiplyMatrices(toSpace, mesh.matrixWorld);
      g.applyMatrix4(m);
      parts.push(g.index ? g.toNonIndexed() : g);
    });
  }
  if (!parts.length) return null;
  for (const g of parts) if (!g.getAttribute('normal')) g.computeVertexNormals();
  const merged = mergeGeometries(parts, false);
  parts.forEach((g) => g.dispose());
  return merged;
}

/** Highest surface under a circle (the flock must clear every roof on its way). */
function roofUnder(map: LoadedMap, center: THREE.Vector2, radius: number, bounds: THREE.Box3): number {
  const top = bounds.max.y + 60;
  const down = new THREE.Vector3(0, -1, 0);
  let highest = bounds.min.y;
  for (let i = 0; i < 32; i++) {
    const a = (i / 32) * Math.PI * 2;
    for (const r of [radius - 3, radius, radius + 3]) {
      const o = new THREE.Vector3(center.x + Math.cos(a) * r, top, center.y + Math.sin(a) * r);
      const d = map.collision.raycast(o, down, top - bounds.min.y + 60);
      if (d !== null) highest = Math.max(highest, top - d);
    }
  }
  return highest;
}

/** Deterministic PRNG from a text (the map id): the same pigeons every time a map loads. */
function seed(text: string): () => number {
  let a = 2166136261;
  for (let i = 0; i < text.length; i++) a = Math.imul(a ^ text.charCodeAt(i), 16777619);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
