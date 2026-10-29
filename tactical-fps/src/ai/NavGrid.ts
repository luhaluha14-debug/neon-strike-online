import * as THREE from 'three';
import { PLAYER_CONFIG } from '../config';
import type { LoadedMap } from '../world/MapLoader';

/** Grid spacing (m). */
const CELL = 1;
/** Highest step between neighbouring cells a player can walk (m). */
const MAX_STEP = 0.55;
const DIRS: readonly [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

const _down = new THREE.Vector3(0, -1, 0);
const _n = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _d = new THREE.Vector3();
const _seg = new THREE.Line3();

/**
 * Walkable grid of one map, built once at load from the map's own collision:
 * flood-filled outward from the spawn points, a cell is walkable when there
 * is floor under it, a standing player fits there, and the step from its
 * neighbour is low and not blocked by a wall. Bots path on it with A*, so
 * they never walk through walls or onto roofs they cannot reach.
 */
export class NavGrid {
  readonly nx: number;
  readonly nz: number;
  readonly minX: number;
  readonly minZ: number;
  /** Floor height per cell (NaN = not walkable). */
  readonly floor: Float32Array;
  /** Bit k set = can move to neighbour DIRS[k]. */
  readonly links: Uint8Array;
  readonly walkable: number[] = [];
  readonly buildMs: number;

  constructor(private readonly map: LoadedMap) {
    const t0 = performance.now();
    const b = map.playBounds;
    this.minX = b.min.x;
    this.minZ = b.min.z;
    this.nx = Math.max(1, Math.ceil((b.max.x - b.min.x) / CELL));
    this.nz = Math.max(1, Math.ceil((b.max.z - b.min.z) / CELL));
    this.floor = new Float32Array(this.nx * this.nz).fill(NaN);
    this.links = new Uint8Array(this.nx * this.nz);

    const queue: number[] = [];
    for (const s of [...map.attackSpawns, ...map.defenseSpawns]) {
      const i = this.cellAt(s.position.x, s.position.z);
      if (i < 0 || !Number.isNaN(this.floor[i])) continue;
      const y = this.probe(i, s.position.y + 0.8);
      if (y === null) continue;
      this.floor[i] = y;
      queue.push(i);
    }
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head];
      const cx = i % this.nx;
      const cz = (i / this.nx) | 0;
      const y = this.floor[i];
      for (let k = 0; k < 8; k++) {
        const x = cx + DIRS[k][0];
        const z = cz + DIRS[k][1];
        if (x < 0 || z < 0 || x >= this.nx || z >= this.nz) continue;
        const j = x + z * this.nx;
        let ny = this.floor[j];
        const fresh = Number.isNaN(ny);
        if (fresh) {
          const p = this.probe(j, y + 1.2);
          if (p === null || Math.abs(p - y) > MAX_STEP) continue;
          ny = p;
        } else if (Math.abs(ny - y) > MAX_STEP) continue;
        if (!this.passable(i, y, j, ny)) continue;
        this.links[i] |= 1 << k;
        if (fresh) {
          this.floor[j] = ny;
          queue.push(j);
        }
      }
    }
    for (let i = 0; i < this.floor.length; i++) if (!Number.isNaN(this.floor[i])) this.walkable.push(i);
    this.buildMs = performance.now() - t0;
  }

  cellAt(x: number, z: number): number {
    const cx = Math.floor((x - this.minX) / CELL);
    const cz = Math.floor((z - this.minZ) / CELL);
    if (cx < 0 || cz < 0 || cx >= this.nx || cz >= this.nz) return -1;
    return cx + cz * this.nx;
  }

  /** World position of a cell's centre on its floor. */
  center(i: number, out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(this.minX + ((i % this.nx) + 0.5) * CELL, this.floor[i], this.minZ + (((i / this.nx) | 0) + 0.5) * CELL);
  }

  /** Nearest walkable cell to a world position (searching a few cells around), or -1. */
  nearestWalkable(p: THREE.Vector3): number {
    const c = this.cellAt(p.x, p.z);
    if (c >= 0 && !Number.isNaN(this.floor[c]) && Math.abs(this.floor[c] - p.y) < 1.5) return c;
    const cx = Math.floor((p.x - this.minX) / CELL);
    const cz = Math.floor((p.z - this.minZ) / CELL);
    let best = -1;
    let bestD = Infinity;
    for (let r = 1; r <= 4 && best < 0; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          const x = cx + dx;
          const z = cz + dz;
          if (x < 0 || z < 0 || x >= this.nx || z >= this.nz) continue;
          const j = x + z * this.nx;
          if (Number.isNaN(this.floor[j]) || Math.abs(this.floor[j] - p.y) > 1.5) continue;
          const d = dx * dx + dz * dz;
          if (d < bestD) {
            bestD = d;
            best = j;
          }
        }
      }
    }
    return best;
  }

  randomCell(rand: () => number = Math.random): number {
    return this.walkable.length ? this.walkable[Math.floor(rand() * this.walkable.length)] : -1;
  }

  /**
   * A* from `from` to `to` (world positions). Returns waypoints (floor level,
   * ending at `to`'s cell), with straight stretches merged, or null.
   */
  findPath(from: THREE.Vector3, to: THREE.Vector3, maxNodes = 6000): THREE.Vector3[] | null {
    const s = this.nearestWalkable(from);
    const g = this.nearestWalkable(to);
    if (s < 0 || g < 0) return null;
    if (s === g) return [this.center(g)];
    const nx = this.nx;
    const gx = g % nx;
    const gz = (g / nx) | 0;
    const h = (i: number) => {
      const dx = Math.abs((i % nx) - gx);
      const dz = Math.abs(((i / nx) | 0) - gz);
      return Math.max(dx, dz) + 0.414 * Math.min(dx, dz);
    };
    const cost = new Map<number, number>([[s, 0]]);
    const came = new Map<number, number>();
    const open = new MinHeap();
    open.push(s, h(s));
    let expanded = 0;
    while (open.size) {
      const i = open.pop();
      if (i === g) break;
      if (++expanded > maxNodes) return null;
      const ci = cost.get(i)!;
      const l = this.links[i];
      for (let k = 0; k < 8; k++) {
        if (!(l & (1 << k))) continue;
        const j = i + DIRS[k][0] + DIRS[k][1] * nx;
        const nc = ci + (k < 4 ? 1 : 1.414);
        if (nc < (cost.get(j) ?? Infinity)) {
          cost.set(j, nc);
          came.set(j, i);
          open.push(j, nc + h(j));
        }
      }
    }
    if (!came.has(g)) return null;
    const cells: number[] = [g];
    for (let c = g; c !== s; ) {
      c = came.get(c)!;
      cells.push(c);
    }
    cells.reverse();
    // String pulling: keep a cell only when the straight line past it is not clear.
    const out: THREE.Vector3[] = [];
    let anchor = 0;
    for (let k = 2; k < cells.length; k++) {
      if (!this.clearLine(cells[anchor], cells[k])) {
        out.push(this.center(cells[k - 1]));
        anchor = k - 1;
      }
    }
    out.push(this.center(g));
    return out;
  }

  /** True when a player can walk straight from cell a to cell b (every cell on the line walkable, no wall in between). */
  clearLine(a: number, b: number): boolean {
    this.center(a, _a);
    this.center(b, _b);
    const len = Math.hypot(_b.x - _a.x, _b.z - _a.z);
    const steps = Math.ceil(len / (CELL * 0.5));
    let prevY = _a.y;
    for (let k = 1; k < steps; k++) {
      const t = k / steps;
      const c = this.cellAt(_a.x + (_b.x - _a.x) * t, _a.z + (_b.z - _a.z) * t);
      if (c < 0 || Number.isNaN(this.floor[c]) || Math.abs(this.floor[c] - prevY) > MAX_STEP) return false;
      prevY = this.floor[c];
    }
    _a.y += 0.6;
    _b.y += 0.6;
    _d.subVectors(_b, _a);
    const dist = _d.length();
    return this.map.collision.raycast(_a, _d.normalize(), dist, undefined, true) === null;
  }

  /** Floor height under a cell's centre, searched downward from `fromY`, if a player fits there. */
  private probe(i: number, fromY: number): number | null {
    this.center(i, _a);
    _a.y = fromY;
    const dist = this.map.collision.raycast(_a, _down, 3.2, _n, true);
    if (dist === null || Math.abs(_n.y) < PLAYER_CONFIG.walkableNormalY) return null;
    const y = fromY - dist;
    const r = PLAYER_CONFIG.radius - 0.03;
    _seg.start.set(_a.x, y + r + 0.08, _a.z);
    _seg.end.set(_a.x, y + PLAYER_CONFIG.standHeight - r, _a.z);
    return this.map.collision.capsuleOverlaps(_seg, r) ? null : y;
  }

  /** No wall between two neighbouring cells at knee and chest height. */
  private passable(i: number, y: number, j: number, ny: number): boolean {
    this.center(i, _a);
    this.center(j, _b);
    for (const h of [0.5, 1.3]) {
      _a.y = y + h;
      _b.y = ny + h;
      _d.subVectors(_b, _a);
      const len = _d.length();
      if (this.map.collision.raycast(_a, _d.normalize(), len, undefined, true) !== null) return false;
    }
    return true;
  }
}

/** Binary min-heap of (id, priority). */
class MinHeap {
  private ids: number[] = [];
  private pri: number[] = [];
  get size(): number {
    return this.ids.length;
  }
  push(id: number, p: number): void {
    const ids = this.ids;
    const pri = this.pri;
    let i = ids.length;
    ids.push(id);
    pri.push(p);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (pri[parent] <= p) break;
      ids[i] = ids[parent];
      pri[i] = pri[parent];
      i = parent;
    }
    ids[i] = id;
    pri[i] = p;
  }
  pop(): number {
    const ids = this.ids;
    const pri = this.pri;
    const top = ids[0];
    const lastId = ids.pop()!;
    const lastP = pri.pop()!;
    if (ids.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= ids.length) break;
        const r = l + 1;
        const c = r < ids.length && pri[r] < pri[l] ? r : l;
        if (pri[c] >= lastP) break;
        ids[i] = ids[c];
        pri[i] = pri[c];
        i = c;
      }
      ids[i] = lastId;
      pri[i] = lastP;
    }
    return top;
  }
}
