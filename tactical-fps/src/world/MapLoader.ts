import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MAP_CONFIG } from '../config';
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
  bounds: THREE.Box3;
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

export async function loadMap(url: string, onProgress?: (ratio: number) => void): Promise<LoadedMap> {
  const gltf = await new GLTFLoader().loadAsync(url, (e) => {
    if (onProgress && e.total > 0) onProgress(e.loaded / e.total);
  });
  const scene = gltf.scene;
  scene.updateMatrixWorld(true);

  const attackSpawns: SpawnPoint[] = [];
  const defenseSpawns: SpawnPoint[] = [];
  const renderBatches = new Map<string, { material: THREE.Material; geometries: THREE.BufferGeometry[] }>();
  const colliderGeometries: THREE.BufferGeometry[] = [];
  const zoneMarkers = new THREE.Group();
  zoneMarkers.name = 'ZoneMarkers';
  zoneMarkers.visible = false;
  let sourceMeshes = 0;

  scene.traverse((obj) => {
    if (obj.name.startsWith(MAP_CONFIG.attackSpawnPrefix)) {
      attackSpawns.push({ position: obj.getWorldPosition(new THREE.Vector3()), yaw: 0 });
    } else if (obj.name.startsWith(MAP_CONFIG.defenseSpawnPrefix)) {
      defenseSpawns.push({ position: obj.getWorldPosition(new THREE.Vector3()), yaw: 0 });
    }

    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const name = ownerName(obj, scene);
    if (startsWithAny(name, MAP_CONFIG.hiddenPrefixes)) return;
    sourceMeshes++;

    const worldGeom = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);

    if (name.startsWith(MAP_CONFIG.zoneMarkerPrefix)) {
      const marker = new THREE.Mesh(worldGeom, mesh.material);
      marker.name = name;
      zoneMarkers.add(marker);
      return;
    }

    // Static batching: one merged mesh per material + attribute layout.
    // GLTFLoader emits one single-material mesh per glTF primitive.
    addToBatch(renderBatches, mesh.material as THREE.Material, worldGeom.clone());

    if (!startsWithAny(name, MAP_CONFIG.nonCollidingPrefixes)) {
      const posOnly = new THREE.BufferGeometry();
      posOnly.setAttribute('position', worldGeom.getAttribute('position'));
      if (worldGeom.index) posOnly.setIndex(worldGeom.index);
      colliderGeometries.push(posOnly.index ? posOnly.toNonIndexed() : posOnly);
    }
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
  const collision = new CollisionWorld(colliderGeom);

  const bounds = new THREE.Box3().setFromObject(root, true);
  const center = bounds.getCenter(new THREE.Vector3());
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
    attackSpawns,
    defenseSpawns,
    stats: { sourceMeshes, drawCalls: root.children.length - 1, triangles, colliderTriangles: collision.triangleCount },
  };
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
