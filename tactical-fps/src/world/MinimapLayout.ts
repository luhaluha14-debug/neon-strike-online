import * as THREE from 'three';
import type { LoadedMap } from './MapLoader';
import type { NavGrid } from '../ai/NavGrid';

// The minimap's picture of a map, worked out once from the map's own
// collision (the same geometry the game plays on) and its walkable grid (the
// cells a player can reach from the spawns, as the bots navigate it), one
// cell per metre over the play area: open floor, floor under a roof (inside),
// low cover (a car, a crate, a low wall: under head height) and walls /
// buildings. Every cell knows its world position, so the minimap and the
// world line up exactly.

export const LAYOUT_CELL = 1;

export const enum Cell {
  Out = 0,
  Floor = 1,
  Indoor = 2,
  Cover = 3,
  Wall = 4,
}

export interface MinimapLayout {
  minX: number;
  minZ: number;
  nx: number;
  nz: number;
  cells: Uint8Array;
  /** Bomb sites: centre and half size (x, z), with their letter. */
  sites: { name: string; x: number; z: number; hx: number; hz: number }[];
  buildMs: number;
}

const _o = new THREE.Vector3();
const DOWN = new THREE.Vector3(0, -1, 0);
const UP = new THREE.Vector3(0, 1, 0);

/** The layout of `map` (a few tens of thousands of short rays through the map's BVH; once per map). */
export function buildMinimapLayout(map: LoadedMap, nav: NavGrid): MinimapLayout {
  const t0 = performance.now();
  const b = map.playBounds;
  const col = map.collision;
  const nx = Math.max(1, Math.ceil((b.max.x - b.min.x) / LAYOUT_CELL));
  const nz = Math.max(1, Math.ceil((b.max.z - b.min.z) / LAYOUT_CELL));
  const cells = new Uint8Array(nx * nz);
  // Ground level of the play area: where the players stand (the spawns).
  const spawns = [...map.attackSpawns, ...map.defenseSpawns];
  const ground = spawns.length ? spawns.reduce((a, s) => a + s.position.y, 0) / spawns.length : b.min.y;
  const top = b.max.y + 2;
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const x = b.min.x + (ix + 0.5) * LAYOUT_CELL;
      const z = b.min.z + (iz + 0.5) * LAYOUT_CELL;
      // From the sky: the highest surface here.
      const dTop = col.raycast(_o.set(x, top, z), DOWN, top - (ground - 4));
      if (dTop === null) continue; // nothing to stand on: outside the map
      const high = top - dTop - ground;
      // Reachable on foot (the walkable grid): open floor, or indoor floor under a roof.
      const n = nav.cellAt(x, z);
      const walk = n >= 0 && !Number.isNaN(nav.floor[n]);
      let c: Cell;
      if (walk) {
        const fy = nav.floor[n];
        const roof = col.raycast(_o.set(x, fy + 0.3, z), UP, 12);
        c = roof !== null && roof > 1.6 ? Cell.Indoor : Cell.Floor;
      } else c = high > 2.0 ? Cell.Wall : high > 0.35 ? Cell.Cover : Cell.Floor;
      cells[ix + iz * nx] = c;
    }
  }
  const sites = map.bombSites.map((s) => {
    const c = s.box.getCenter(new THREE.Vector3());
    const h = s.box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    return { name: s.name, x: c.x, z: c.z, hx: h.x, hz: h.z };
  });
  return { minX: b.min.x, minZ: b.min.z, nx, nz, cells, sites, buildMs: performance.now() - t0 };
}

/** The cell kind at a world position (Out beyond the play area). */
export function layoutAt(l: MinimapLayout, x: number, z: number): Cell {
  const ix = Math.floor((x - l.minX) / LAYOUT_CELL);
  const iz = Math.floor((z - l.minZ) / LAYOUT_CELL);
  if (ix < 0 || iz < 0 || ix >= l.nx || iz >= l.nz) return Cell.Out;
  return l.cells[ix + iz * l.nx] as Cell;
}
