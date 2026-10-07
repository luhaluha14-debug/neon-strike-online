import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshBVH } from 'three-mesh-bvh';
import type { ViewModelLayer } from '../weapons/view/ViewModelLayer';

// Development-only checks for first-person models (loaded only in dev
// builds). Useful when tuning offsets or importing a Blender weapon:
//   game.vmCheck()  → how deep the gloves sink into the weapon, and whether
//                     any visible geometry reaches the camera's near plane.

export interface ViewModelCheckResult {
  weapon: string;
  handVertices: number;
  /** Glove vertices inside the weapon by more than `tolerance`. */
  handVerticesInside: number;
  /** Deepest glove penetration into the weapon (mm). */
  maxPenetrationMm: number;
  /** Visible vertices closer to the eye than `nearLimit` (would clip / look huge). */
  verticesTooCloseToCamera: number;
  /** Nearest on-screen vertex distance in front of the camera (m). */
  nearestVisibleZ: number;
  /** Glove parts with the most clipping (name, vertices inside, deepest mm). */
  worstParts: [string, number, number][];
}

const _v = new THREE.Vector3();
const _ray = new THREE.Ray();
const DIRS = [new THREE.Vector3(1, 0.13, 0.07), new THREE.Vector3(-0.11, 1, 0.05), new THREE.Vector3(0.09, -0.06, 1)].map((d) => d.normalize());

export function checkViewModel(layer: ViewModelLayer, tolerance = 0.0015, nearLimit = 0.06): ViewModelCheckResult {
  const view = layer.currentView;
  const arms = layer.currentArms;
  if (!view || !arms) throw new Error('no weapon in hand');
  layer.scene.updateMatrixWorld(true);

  // Weapon as one closed-ish triangle soup in world space.
  const parts: THREE.BufferGeometry[] = [];
  view.object.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.visible) return;
    const g = m.geometry.clone().applyMatrix4(m.matrixWorld);
    const p = new THREE.BufferGeometry().setAttribute('position', g.getAttribute('position'));
    if (g.index) p.setIndex(g.index);
    parts.push(p.index ? p.toNonIndexed() : p);
  });
  const weaponGeom = mergeGeometries(parts, false)!;
  const bvh = new MeshBVH(weaponGeom);

  // Point-in-mesh by ray parity, majority vote over three directions (robust to open caps).
  const inside = (p: THREE.Vector3) => {
    let votes = 0;
    for (const d of DIRS) {
      _ray.origin.copy(p);
      _ray.direction.copy(d);
      if (bvh.raycast(_ray, THREE.DoubleSide).length % 2 === 1) votes++;
    }
    return votes >= 2;
  };

  let handVertices = 0;
  let handVerticesInside = 0;
  let maxPen = 0;
  const target = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  const perPart = new Map<string, [number, number]>();
  arms.object.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.visible || !isVisibleChain(m)) return;
    const pos = m.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      _v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      handVertices++;
      if (!inside(_v)) continue;
      bvh.closestPointToPoint(_v, target);
      if (target.distance > tolerance) {
        handVerticesInside++;
        maxPen = Math.max(maxPen, target.distance);
        const e = perPart.get(m.name) ?? [0, 0];
        perPart.set(m.name, [e[0] + 1, Math.max(e[1], target.distance)]);
      }
    }
  });

  // Near-plane / camera check on everything visible in the view-model scene.
  const cam = layer.camera;
  cam.updateMatrixWorld();
  let tooClose = 0;
  let nearest = Infinity;
  const ndc = new THREE.Vector3();
  layer.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !isVisibleChain(m)) return;
    const pos = m.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      _v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld).applyMatrix4(cam.matrixWorldInverse);
      const z = -_v.z;
      if (z <= 0) continue; // behind the eye: never drawn
      ndc.copy(_v).applyMatrix4(cam.projectionMatrix);
      if (Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1) continue; // off-screen
      nearest = Math.min(nearest, z);
      if (z < nearLimit) tooClose++;
    }
  });

  weaponGeom.dispose();
  parts.forEach((g) => g.dispose());
  return {
    weapon: view.object.name,
    handVertices,
    handVerticesInside,
    maxPenetrationMm: +(maxPen * 1000).toFixed(1),
    verticesTooCloseToCamera: tooClose,
    nearestVisibleZ: +nearest.toFixed(3),
    worstParts: [...perPart.entries()]
      .sort((a, b) => b[1][1] - a[1][1])
      .slice(0, 8)
      .map(([n, [c, d]]) => [n, c, +(d * 1000).toFixed(1)]),
  };
}

function isVisibleChain(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}
