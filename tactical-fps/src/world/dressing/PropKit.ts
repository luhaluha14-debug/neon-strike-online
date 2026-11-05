import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Building blocks for map dressing. Every part is a small primitive (box,
// cylinder, plane) placed with a matrix and collected per material; at the end
// each material becomes ONE mesh, which the map loader then merges with the
// map's own batches of the same material (so a hundred AC units cost one draw
// call, not a hundred). Material names follow the map's naming so
// SurfaceMaterials classifies them (shading, bullet impacts, sounds).
//
// Two layers:
//   solid  (`Dress_…`)     collide with players and bullets, appear on the bot nav grid
//   detail (`DressDeco_…`) visual only: wires, painted lines, flat decals

export type Layer = 'solid' | 'detail';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');

const unitBox = new THREE.BoxGeometry(1, 1, 1);
const cylinders = new Map<number, THREE.BufferGeometry>();
function unitCylinder(segments: number): THREE.BufferGeometry {
  let g = cylinders.get(segments);
  if (!g) {
    g = new THREE.CylinderGeometry(0.5, 0.5, 1, segments, 1, false);
    cylinders.set(segments, g);
  }
  return g;
}
const unitPlane = new THREE.PlaneGeometry(1, 1);

export interface MaterialSpec {
  color: number;
  roughness?: number;
  metalness?: number;
  map?: THREE.Texture;
  emissive?: number;
  emissiveIntensity?: number;
  emissiveMap?: THREE.Texture;
  side?: THREE.Side;
}

/** Where a part goes: position (m), rotation (rad: tilt X, heading Y, roll Z; applied Z, X, then Y), size (m). */
export interface Placement {
  at: readonly [number, number, number];
  size: readonly [number, number, number];
  rot?: readonly [number, number, number];
}

export class PropKit {
  private readonly buckets = new Map<string, { layer: Layer; material: THREE.Material; parts: THREE.BufferGeometry[] }>();
  private readonly materials = new Map<string, THREE.MeshStandardMaterial>();
  /** Parts added per material (stats / tests). */
  parts = 0;

  constructor(private readonly specs: Record<string, MaterialSpec>) {}

  material(name: string): THREE.MeshStandardMaterial {
    let m = this.materials.get(name);
    if (!m) {
      const s = this.specs[name];
      if (!s) throw new Error(`dressing: no material "${name}"`);
      m = new THREE.MeshStandardMaterial({
        name,
        color: s.color,
        roughness: s.roughness ?? 0.7,
        metalness: s.metalness ?? 0,
        map: s.map ?? null,
        side: s.side ?? THREE.FrontSide,
      });
      if (s.emissive !== undefined) {
        m.emissive.setHex(s.emissive);
        m.emissiveIntensity = s.emissiveIntensity ?? 1;
        m.emissiveMap = s.emissiveMap ?? null;
      }
      this.materials.set(name, m);
    }
    return m;
  }

  /** A box. `uv`: optional UV rectangle [u0, v0, u1, v1] on its front (+Z) face (sign atlases). */
  box(mat: string, p: Placement, layer: Layer = 'solid', uv?: readonly [number, number, number, number]): void {
    let g: THREE.BufferGeometry = unitBox.clone();
    if (uv) g = withFrontUv(g, uv);
    this.add(mat, g, p, layer);
  }

  /** A cylinder along its local Y (segments: roundness; 6–12 is plenty at map scale). */
  cylinder(mat: string, p: Placement, segments = 8, layer: Layer = 'solid'): void {
    this.add(mat, unitCylinder(segments).clone(), p, layer);
  }

  /** A flat quad facing local +Z (painted lines, decals, signs). UV rectangle as for `box`. */
  plane(mat: string, p: Placement, layer: Layer = 'detail', uv?: readonly [number, number, number, number]): void {
    const g: THREE.BufferGeometry = unitPlane.clone();
    if (uv) {
      const a = g.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < a.count; i++) a.setXY(i, uv[0] + a.getX(i) * (uv[2] - uv[0]), uv[1] + a.getY(i) * (uv[3] - uv[1]));
    }
    this.add(mat, g, p, layer);
  }

  /** A straight tube between two points (pipes, wires, rails, braces). */
  tube(mat: string, a: THREE.Vector3, b: THREE.Vector3, radius: number, layer: Layer = 'solid', segments = 6): void {
    const d = _p.subVectors(b, a);
    const len = d.length();
    if (len < 1e-4) return;
    const g = unitCylinder(segments).clone();
    _q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.divideScalar(len));
    _m.compose(_s.copy(a).add(b).multiplyScalar(0.5), _q, new THREE.Vector3(radius * 2, len, radius * 2));
    g.applyMatrix4(_m);
    this.push(mat, g, layer);
  }

  /** A box between two points with a given cross-section (beams, girts, braces). */
  beam(mat: string, a: THREE.Vector3, b: THREE.Vector3, w: number, h: number, layer: Layer = 'solid'): void {
    const d = _p.subVectors(b, a);
    const len = d.length();
    if (len < 1e-4) return;
    const g = unitBox.clone();
    _q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), d.divideScalar(len));
    _m.compose(_s.copy(a).add(b).multiplyScalar(0.5), _q, new THREE.Vector3(w, h, len));
    g.applyMatrix4(_m);
    this.push(mat, g, layer);
  }

  private add(mat: string, g: THREE.BufferGeometry, p: Placement, layer: Layer): void {
    // YXZ: the part is tilted in its own frame first, then turned to its heading.
    _e.set(p.rot?.[0] ?? 0, p.rot?.[1] ?? 0, p.rot?.[2] ?? 0, 'YXZ');
    _q.setFromEuler(_e);
    _m.compose(_p.set(p.at[0], p.at[1], p.at[2]), _q, _s.set(p.size[0], p.size[1], p.size[2]));
    g.applyMatrix4(_m);
    this.push(mat, g, layer);
  }

  private push(mat: string, g: THREE.BufferGeometry, layer: Layer): void {
    const key = `${layer}|${mat}`;
    let b = this.buckets.get(key);
    if (!b) {
      b = { layer, material: this.material(mat), parts: [] };
      this.buckets.set(key, b);
    }
    b.parts.push(g);
    this.parts++;
  }

  /**
   * One mesh per (layer, material), named so the map loader knows the layer: `Dress_<mat>` collides,
   * `DressDeco_<mat>` does not. Geometries are in world space (identity transform). Add them to the
   * map scene directly (the loader names a mesh after its top-level ancestor).
   */
  build(withoutDetail = false): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const { layer, material, parts } of this.buckets.values()) {
      if (withoutDetail && layer === 'detail') {
        parts.forEach((g) => g.dispose());
        continue;
      }
      const merged = mergeGeometries(parts, false);
      parts.forEach((g) => g.dispose());
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, material);
      mesh.name = (layer === 'solid' ? 'Dress_' : 'DressDeco_') + material.name;
      out.push(mesh);
    }
    this.buckets.clear();
    return out;
  }
}

/** Maps the +Z face of a unit box to a UV rectangle; other faces get a corner of it (solid edge colour). */
function withFrontUv(g: THREE.BufferGeometry, uv: readonly [number, number, number, number]): THREE.BufferGeometry {
  const a = g.getAttribute('uv') as THREE.BufferAttribute;
  const n = g.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < a.count; i++) {
    if (n.getZ(i) > 0.5) a.setXY(i, uv[0] + a.getX(i) * (uv[2] - uv[0]), uv[1] + a.getY(i) * (uv[3] - uv[1]));
    else a.setXY(i, uv[0] + 0.002, uv[1] + 0.002);
  }
  return g;
}

/** Small deterministic random (same dressing on every client and every load). */
export function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}
