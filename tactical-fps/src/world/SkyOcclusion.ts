import * as THREE from 'three';

// How much open sky each spot of the map sees, baked once at map load into a
// small 3D texture over the play area. The map's materials use it to scale
// their sky light (hemisphere fill and sky reflections): under a roof, in a
// warehouse hall or a covered passage the ambient drops, so interiors read
// as interiors next to bright streets. Direct sunlight already stops at walls
// (shadow map); this does the same for the sky. No real-time lights, nothing
// per frame. Only the map uses it: players, bots and weapons keep their full
// lighting, so nobody is harder to see indoors.

export interface SkyOcclusionGrid {
  texture: THREE.Data3DTexture;
  /** World position of the grid's first corner and its size (m). */
  origin: THREE.Vector3;
  size: THREE.Vector3;
  /** Cells and the time the bake took (ms), for diagnostics. */
  cells: number;
  ms: number;
}

/** Ray directions: straight up counts double, then four slanted (45°) toward each side. */
const DIRS = [
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(1, 1, 0).normalize(),
  new THREE.Vector3(-1, 1, 0).normalize(),
  new THREE.Vector3(0, 1, 1).normalize(),
  new THREE.Vector3(0, 1, -1).normalize(),
];
const WEIGHTS = [2, 1, 1, 1, 1];
const RAY_LENGTH = 40;

/**
 * Bakes the grid over `bounds` (cells about `cell` m wide, at most `maxCells` in all). `raycast`
 * returns the distance to the first surface along a direction, or null for open sky.
 */
export function bakeSkyOcclusion(
  raycast: (from: THREE.Vector3, dir: THREE.Vector3, max: number) => number | null,
  bounds: THREE.Box3,
  cell = 2.5,
  maxCells = 48000,
): SkyOcclusionGrid {
  const t0 = performance.now();
  const size = bounds.getSize(new THREE.Vector3());
  // Vertical cells a bit finer than horizontal (storeys, roofs), then coarsened to fit the budget.
  let c = cell;
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (;;) {
    nx = Math.max(2, Math.ceil(size.x / c) + 1);
    ny = Math.max(2, Math.ceil(size.y / (c * 0.8)) + 1);
    nz = Math.max(2, Math.ceil(size.z / c) + 1);
    if (nx * ny * nz <= maxCells) break;
    c *= 1.15;
  }
  const data = new Uint8Array(nx * ny * nz);
  const p = new THREE.Vector3();
  const total = WEIGHTS.reduce((a, b) => a + b, 0);
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        p.set(
          bounds.min.x + (x / (nx - 1)) * size.x,
          bounds.min.y + (y / (ny - 1)) * size.y,
          bounds.min.z + (z / (nz - 1)) * size.z,
        );
        let open = 0;
        for (let i = 0; i < DIRS.length; i++) if (raycast(p, DIRS[i], RAY_LENGTH) === null) open += WEIGHTS[i];
        data[x + nx * (y + ny * z)] = Math.round((open / total) * 255);
      }
    }
  }
  const texture = new THREE.Data3DTexture(data, nx, ny, nz);
  texture.format = THREE.RedFormat;
  texture.type = THREE.UnsignedByteType;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = texture.wrapR = THREE.ClampToEdgeWrapping;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return { texture, origin: bounds.min.clone(), size, cells: nx * ny * nz, ms: performance.now() - t0 };
}

/** Visibility of the sky (0..1) at a point, read back from the grid's data (tests / debugging). */
export function skyVisibilityAt(grid: SkyOcclusionGrid, at: THREE.Vector3): number {
  const img = grid.texture.image as { data: Uint8Array; width: number; height: number; depth: number };
  const f = (v: number, o: number, s: number, n: number) => Math.min(Math.max(Math.round(((v - o) / s) * (n - 1)), 0), n - 1);
  const x = f(at.x, grid.origin.x, grid.size.x, img.width);
  const y = f(at.y, grid.origin.y, grid.size.y, img.height);
  const z = f(at.z, grid.origin.z, grid.size.z, img.depth);
  return img.data[x + img.width * (y + img.height * z)] / 255;
}
