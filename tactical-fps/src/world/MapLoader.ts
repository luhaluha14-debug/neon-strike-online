import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { MapDefinition } from '../maps';
import { CollisionWorld } from './CollisionWorld';

export interface SpawnPoint {
  position: THREE.Vector3;
  /** Yaw (radians) facing toward the map center. */
  yaw: number;
}

export interface LoadedMap {
  /** Render root, already batched by material. */
  root: THREE.Group;
  /** Gameplay zone markers (child of root, hidden by default). */
  zoneMarkers: THREE.Group;
  collision: CollisionWorld;
  /** Everything rendered, including distant scenery. */
  bounds: THREE.Box3;
  /** The playable area (player-clip walls, else the solid collider). Used for shadows and spawn facing. */
  playBounds: THREE.Box3;
  attackSpawns: SpawnPoint[];
  defenseSpawns: SpawnPoint[];
  stats: { sourceMeshes: number; drawCalls: number; triangles: number; colliderTriangles: number };
}

const startsWithAny = (name: string, prefixes: readonly string[]) => prefixes.some((p) => name.startsWith(p));

/** Walks up the hierarchy so children of e.g. a `Tpl_` node inherit its classification. */
function ownerName(obj: THREE.Object3D, scene: THREE.Object3D): string {
  let o: THREE.Object3D | null = obj;
  let name = obj.name;
  while (o && o !== scene) {
    if (o.name) name = o.name;
    o = o.parent;
  }
  return name;
}

function attributeSignature(g: THREE.BufferGeometry): string {
  return Object.keys(g.attributes).sort().join(',') + (g.index ? '|i' : '|n');
}

export async function loadMap(def: MapDefinition, onProgress?: (ratio: number) => void): Promise<LoadedMap> {
  const gltf = await new GLTFLoader().loadAsync(def.url, (e) => {
    if (onProgress && e.total > 0) onProgress(e.loaded / e.total);
  });
  const scene = gltf.scene;
  scene.updateMatrixWorld(true);

  const attackSpawns: SpawnPoint[] = [];
  const defenseSpawns: SpawnPoint[] = [];
  const renderBatches = new Map<string, { material: THREE.Material; geometries: THREE.BufferGeometry[] }>();
  const colliderGeometries: THREE.BufferGeometry[] = [];
  const clipGeometries: THREE.BufferGeometry[] = [];
  const zoneMarkers = new THREE.Group();
  zoneMarkers.name = 'ZoneMarkers';
  zoneMarkers.visible = false;
  let sourceMeshes = 0;

  scene.traverse((obj) => {
    if (obj.name.startsWith(def.attackSpawnPrefix)) {
      attackSpawns.push({ position: obj.getWorldPosition(new THREE.Vector3()), yaw: 0 });
    } else if (obj.name.startsWith(def.defenseSpawnPrefix)) {
      defenseSpawns.push({ position: obj.getWorldPosition(new THREE.Vector3()), yaw: 0 });
    }

    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const name = ownerName(obj, scene);
    if (startsWithAny(name, def.hiddenPrefixes)) return;
    sourceMeshes++;

    const worldGeom = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);

    if (startsWithAny(name, def.playerClipPrefixes)) {
      clipGeometries.push(positionsOnly(worldGeom));
      worldGeom.dispose();
      return;
    }

    if (name.startsWith(def.zoneMarkerPrefix)) {
      const marker = new THREE.Mesh(worldGeom, mesh.material);
      marker.name = name;
      zoneMarkers.add(marker);
      return;
    }

    // Static batching: one merged mesh per material + attribute layout.
    // GLTFLoader emits one single-material mesh per glTF primitive.
    addToBatch(renderBatches, mesh.material as THREE.Material, worldGeom.clone());

    if (!startsWithAny(name, def.nonCollidingPrefixes)) colliderGeometries.push(positionsOnly(worldGeom));
    worldGeom.dispose();
  });

  const root = new THREE.Group();
  root.name = 'MapRoot';
  let triangles = 0;
  for (const { material, geometries } of renderBatches.values()) {
    const merged = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries, false);
    if (!merged) continue;
    geometries.forEach((g) => g !== merged && g.dispose());
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    const batch = new THREE.Mesh(merged, material);
    batch.name = material.name || 'batch';
    batch.matrixAutoUpdate = false;
    batch.castShadow = true;
    batch.receiveShadow = true;
    root.add(batch);
    triangles += (merged.index ? merged.index.count : merged.getAttribute('position').count) / 3;
  }
  tuneMaterials(root);
  root.add(zoneMarkers);
  root.updateMatrixWorld(true);

  const colliderGeom = mergeGeometries(colliderGeometries, false);
  if (!colliderGeom) throw new Error('Map has no collidable geometry');
  colliderGeometries.forEach((g) => g.dispose());
  const clipGeom = clipGeometries.length ? mergeGeometries(clipGeometries, false) : null;
  clipGeometries.forEach((g) => g.dispose());
  const collision = new CollisionWorld(colliderGeom, clipGeom);

  const bounds = new THREE.Box3().setFromObject(root, true);
  colliderGeom.computeBoundingBox();
  clipGeom?.computeBoundingBox();
  const playBounds = (clipGeom?.boundingBox ?? colliderGeom.boundingBox!).clone();
  const center = playBounds.getCenter(new THREE.Vector3());
  for (const s of [...attackSpawns, ...defenseSpawns]) {
    // Camera looks down -Z at yaw 0; face the map center.
    s.yaw = Math.atan2(-(center.x - s.position.x), -(center.z - s.position.z));
  }
  attackSpawns.sort((a, b) => a.position.x - b.position.x);
  defenseSpawns.sort((a, b) => a.position.x - b.position.x);

  return {
    root,
    zoneMarkers,
    collision,
    bounds,
    playBounds,
    attackSpawns,
    defenseSpawns,
    stats: { sourceMeshes, drawCalls: root.children.length - 1, triangles, colliderTriangles: collision.triangleCount },
  };
}

/** Frees GPU resources of a loaded map (used when switching maps). */
export function disposeMap(map: LoadedMap): void {
  const materials = new Set<THREE.Material>();
  map.root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach((m) => materials.add(m));
  });
  materials.forEach((m) => m.dispose());
  map.root.removeFromParent();
}

/** Non-indexed position-only copy for collision BVHs. */
function positionsOnly(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', g.getAttribute('position'));
  if (g.index) out.setIndex(g.index);
  return out.index ? out.toNonIndexed() : out;
}

function addToBatch(
  batches: Map<string, { material: THREE.Material; geometries: THREE.BufferGeometry[] }>,
  material: THREE.Material,
  geometry: THREE.BufferGeometry,
): void {
  // mergeGeometries needs identical attribute sets and consistent indexing.
  if (!geometry.index) geometry.setIndex([...Array(geometry.getAttribute('position').count).keys()]);
  geometry.clearGroups();
  const key = material.uuid + '#' + attributeSignature(geometry);
  let batch = batches.get(key);
  if (!batch) {
    batch = { material, geometries: [] };
    batches.set(key, batch);
  }
  batch.geometries.push(geometry);
}

function tuneMaterials(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mat = mesh.material as THREE.MeshStandardMaterial;
    if (!mat.isMeshStandardMaterial) return;
    // Glass reads as a dark reflective surface rather than a see-through one;
    // keeping it opaque avoids costly sorted transparency.
    if (/glass/i.test(mat.name) && !/lamp/i.test(mat.name)) {
      mat.metalness = 0.6;
      mat.roughness = 0.15;
    }
    mat.envMapIntensity = 0.6;
  });
}
