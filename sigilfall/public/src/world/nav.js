/* =============================================================================
   navigation grid.  built once per arena from the collision world: every cell
   remembers the height a fighter stands at, and neighbours only connect when
   the step between them is small enough to walk.  bots path on this.
   ========================================================================== */
import { RULES } from '../game/rules.js';

const CELL = 1.4;
const STEP = 0.58;

export class NavGrid {
  constructor(world) {
    this.world = world;
    const sx = world.sx, sz = world.sz;
    this.cell = CELL;
    this.ox = -sx - 1;
    this.oz = -sz - 1;
    this.nx = Math.ceil((sx * 2 + 2) / CELL);
    this.nz = Math.ceil((sz * 2 + 2) / CELL);
    const n = this.nx * this.nz;
    this.walk = new Uint8Array(n);
    this.h = new Float32Array(n);
    this.cover = new Uint8Array(n);

    for (let iz = 0; iz < this.nz; iz++) {
      for (let ix = 0; ix < this.nx; ix++) {
        const x = this.ox + (ix + 0.5) * CELL, z = this.oz + (iz + 0.5) * CELL;
        const k = iz * this.nx + ix;
        if (Math.abs(x) > sx - 0.5 || Math.abs(z) > sz - 0.5) continue;
        const y = world.supportAt(x, z, 1e4, 0.42);
        if (world.blockedAt(x, z, 0.42, y, y + RULES.standHeight) >= 0) continue;
        this.walk[k] = 1;
        this.h[k] = y;
      }
    }
    // a cell counts as cover when something tall stands right next to it
    for (let iz = 0; iz < this.nz; iz++) {
      for (let ix = 0; ix < this.nx; ix++) {
        const k = iz * this.nx + ix;
        if (!this.walk[k]) continue;
        const x = this.ox + (ix + 0.5) * CELL, z = this.oz + (iz + 0.5) * CELL;
        let tall = 0;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const px = x + dx * CELL, pz = z + dz * CELL;
          const top = world.supportAt(px, pz, 1e4, 0.4);
          if (top > this.h[k] + 0.9) tall++;
        }
        this.cover[k] = tall > 0 ? 1 : 0;
      }
    }
    this.came = new Int32Array(n).fill(-1);
    this.gScore = new Float32Array(n);
    this.seen = new Int32Array(n).fill(-1);
    this.closed = new Int32Array(n).fill(-1);
    this.stamp = 0;
  }

  index(x, z) {
    const ix = Math.floor((x - this.ox) / CELL);
    const iz = Math.floor((z - this.oz) / CELL);
    if (ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz) return -1;
    return iz * this.nx + ix;
  }
  cx(k) { return this.ox + ((k % this.nx) + 0.5) * CELL; }
  cz(k) { return this.oz + (Math.floor(k / this.nx) + 0.5) * CELL; }
  walkable(k) { return k >= 0 && this.walk[k] === 1; }

  /* nearest walkable cell to a point, searched outward */
  nearest(x, z) {
    const k = this.index(x, z);
    if (this.walkable(k)) return k;
    const ix0 = Math.floor((x - this.ox) / CELL), iz0 = Math.floor((z - this.oz) / CELL);
    for (let r = 1; r < 6; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const ix = ix0 + dx, iz = iz0 + dz;
          if (ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz) continue;
          const kk = iz * this.nx + ix;
          if (this.walk[kk]) return kk;
        }
      }
    }
    return -1;
  }

  neighbours(k, out) {
    out.length = 0;
    const ix = k % this.nx, iz = Math.floor(k / this.nx);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const nx = ix + dx, nz = iz + dz;
        if (nx < 0 || nz < 0 || nx >= this.nx || nz >= this.nz) continue;
        const nk = nz * this.nx + nx;
        if (!this.walk[nk]) continue;
        if (Math.abs(this.h[nk] - this.h[k]) > STEP) continue;
        if (dx && dz) {
          // do not cut corners through a wall
          const a = iz * this.nx + (ix + dx), b = (iz + dz) * this.nx + ix;
          if (!this.walk[a] || !this.walk[b]) continue;
        }
        out.push(nk);
      }
    }
    return out;
  }

  /* A* returning a list of world points, or null.  capped so a bot can never
     stall the frame on a hopeless request. */
  path(fromX, fromZ, toX, toZ, maxNodes = 900) {
    const start = this.nearest(fromX, fromZ), goal = this.nearest(toX, toZ);
    if (start < 0 || goal < 0) return null;
    if (start === goal) return [{ x: toX, z: toZ }];
    this.stamp++;
    const open = [start];
    this.seen[start] = this.stamp;
    this.gScore[start] = 0;
    this.came[start] = -1;
    const nb = [];
    let nodes = 0;
    const hEst = (k) => Math.hypot(this.cx(k) - toX, this.cz(k) - toZ);

    while (open.length && nodes++ < maxNodes) {
      // small grids: a linear scan beats a heap and allocates nothing
      let bi = 0, bf = Infinity;
      for (let i = 0; i < open.length; i++) {
        const f = this.gScore[open[i]] + hEst(open[i]);
        if (f < bf) { bf = f; bi = i; }
      }
      const cur = open.splice(bi, 1)[0];
      if (cur === goal) return this.rebuild(cur, toX, toZ);
      if (this.closed[cur] === this.stamp) { nodes--; continue; }
      this.closed[cur] = this.stamp;
      this.neighbours(cur, nb);
      for (const nk of nb) {
        if (this.closed[nk] === this.stamp) continue;
        const step = Math.hypot(this.cx(nk) - this.cx(cur), this.cz(nk) - this.cz(cur));
        const g = this.gScore[cur] + step;
        if (this.seen[nk] === this.stamp && g >= this.gScore[nk]) continue;
        this.seen[nk] = this.stamp;
        this.gScore[nk] = g;
        this.came[nk] = cur;
        open.push(nk);
      }
    }
    return null;
  }

  rebuild(k, toX, toZ) {
    const pts = [];
    let cur = k, guard = 0;
    while (cur >= 0 && guard++ < 400) {
      pts.push({ x: this.cx(cur), z: this.cz(cur) });
      cur = this.came[cur];
    }
    pts.reverse();
    pts.push({ x: toX, z: toZ });
    return pts;
  }

  /* a spot near `x,z` that breaks line of sight to `fromX,fromZ` */
  coverNear(x, z, fromX, fromZ, world, radius = 12) {
    let best = null, bestD = Infinity;
    const k0 = this.nearest(x, z);
    if (k0 < 0) return null;
    const steps = Math.ceil(radius / CELL);
    const ix0 = k0 % this.nx, iz0 = Math.floor(k0 / this.nx);
    for (let dz = -steps; dz <= steps; dz++) {
      for (let dx = -steps; dx <= steps; dx++) {
        const ix = ix0 + dx, iz = iz0 + dz;
        if (ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz) continue;
        const k = iz * this.nx + ix;
        if (!this.walk[k] || !this.cover[k]) continue;
        const cx = this.cx(k), cz = this.cz(k);
        const d = Math.hypot(cx - x, cz - z);
        if (d > radius || d > bestD) continue;
        if (!world.segBlocked(cx, this.h[k] + 1.5, cz, fromX, 1.6, fromZ)) continue;
        bestD = d;
        best = { x: cx, z: cz };
      }
    }
    return best;
  }
}
