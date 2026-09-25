/* =========================================================================
   Ground-level navigation grid + A* for bots.
   1 m cells.  Doors are stamped explicitly so paths go through their centre.
   ========================================================================= */

const CELL = 1;

export class NavGrid {
  constructor(world) {
    this.world = world;
    const lim = world.playLimit || world.half;
    this.lim = lim;
    this.n = Math.floor((lim * 2) / CELL);
    this.walk = new Uint8Array(this.n * this.n);
    this.floorY = new Float32Array(this.n * this.n);
    const T = world.terrain;
    for (let j = 0; j < this.n; j++) {
      for (let i = 0; i < this.n; i++) {
        const x = this.cx(i), z = this.cz(j);
        const g = T.heightAt(x, z);
        const s = world.supportHeight(x, z, 0.2, g + 0.4, 0);
        this.floorY[j * this.n + i] = s;
        let ok = !world.overlaps(x, z, 0.27, s + 0.4, s + 1.7);
        if (ok && T.slopeAt(x, z) < 0.62 && s - g < 0.05) ok = false;
        this.walk[j * this.n + i] = ok ? 1 : 0;
      }
    }
    // stamp doors: a straight corridor through each doorway
    this.override = new Map();
    for (const d of world.doors || []) {
      for (let k = -2; k <= 2; k++) {
        const x = d.x + d.nx * k * CELL, z = d.z + d.nz * k * CELL;
        const idx = this.index(x, z);
        if (idx < 0) continue;
        this.walk[idx] = 1;
        this.override.set(idx, { x, z });
      }
    }
    // scratch buffers for A*
    const N = this.n * this.n;
    this.g = new Float32Array(N);
    this.parent = new Int32Array(N);
    this.stamp = new Uint32Array(N);
    this.closed = new Uint32Array(N);
    this.cur = 0;
    this.heap = new Int32Array(N);
    this.heapF = new Float32Array(N);
  }

  cx(i) { return -this.lim + (i + 0.5) * CELL; }
  cz(j) { return -this.lim + (j + 0.5) * CELL; }
  index(x, z) {
    const i = Math.floor((x + this.lim) / CELL), j = Math.floor((z + this.lim) / CELL);
    if (i < 0 || j < 0 || i >= this.n || j >= this.n) return -1;
    return j * this.n + i;
  }
  isWalk(x, z) { const k = this.index(x, z); return k >= 0 && this.walk[k] === 1; }

  /** nearest walkable cell index to x,z within a small radius */
  nearest(x, z, maxR = 6) {
    const k0 = this.index(x, z);
    if (k0 >= 0 && this.walk[k0]) return k0;
    const i0 = Math.floor((x + this.lim) / CELL), j0 = Math.floor((z + this.lim) / CELL);
    for (let r = 1; r <= maxR; r++) {
      let best = -1, bd = Infinity;
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (Math.abs(di) !== r && Math.abs(dj) !== r) continue;
          const i = i0 + di, j = j0 + dj;
          if (i < 0 || j < 0 || i >= this.n || j >= this.n) continue;
          const k = j * this.n + i;
          if (!this.walk[k]) continue;
          const d = di * di + dj * dj;
          if (d < bd) { bd = d; best = k; }
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  point(k) {
    const o = this.override.get(k);
    if (o) return { x: o.x, z: o.z };
    return { x: this.cx(k % this.n), z: this.cz((k / this.n) | 0) };
  }

  /** grid line-of-walk between two cells (for path smoothing) */
  clear(ax, az, bx, bz) {
    const dx = bx - ax, dz = bz - az;
    const L = Math.hypot(dx, dz);
    const steps = Math.ceil(L / (CELL * 0.4));
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const x = ax + dx * t, z = az + dz * t;
      const k = this.index(x, z);
      if (k < 0 || !this.walk[k]) return false;
      // keep a margin: side samples
      const px = -dz / L * 0.3, pz = dx / L * 0.3;
      if (!this.isWalk(x + px, z + pz) || !this.isWalk(x - px, z - pz)) {
        if (!this.override.has(k)) return false;
      }
    }
    return true;
  }

  /**
   * A* from (sx,sz) to (tx,tz).  returns array of {x,z} waypoints (smoothed) or null
   */
  findPath(sx, sz, tx, tz, maxIter = 12000) {
    const s = this.nearest(sx, sz), t = this.nearest(tx, tz, 8);
    if (s < 0 || t < 0) return null;
    if (s === t) return [this.point(t)];
    const n = this.n;
    const cur = ++this.cur;
    const g = this.g, parent = this.parent, stamp = this.stamp, closed = this.closed;
    const heap = this.heap, heapF = this.heapF;
    let hn = 0;
    const ti = t % n, tj = (t / n) | 0;
    const H = (k) => {
      const di = Math.abs((k % n) - ti), dj = Math.abs(((k / n) | 0) - tj);
      return (di + dj) + (1.4142 - 2) * Math.min(di, dj);
    };
    const push = (k, f) => {
      let i = hn++;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heapF[p] <= f) break;
        heap[i] = heap[p]; heapF[i] = heapF[p]; i = p;
      }
      heap[i] = k; heapF[i] = f;
    };
    const pop = () => {
      const top = heap[0];
      const lk = heap[--hn], lf = heapF[hn];
      let i = 0;
      for (;;) {
        let c = i * 2 + 1;
        if (c >= hn) break;
        if (c + 1 < hn && heapF[c + 1] < heapF[c]) c++;
        if (heapF[c] >= lf) break;
        heap[i] = heap[c]; heapF[i] = heapF[c]; i = c;
      }
      heap[i] = lk; heapF[i] = lf;
      return top;
    };
    stamp[s] = cur; g[s] = 0; parent[s] = -1;
    push(s, H(s));
    let found = false, iter = 0, bestK = s, bestH = H(s);
    while (hn > 0 && iter++ < maxIter) {
      const k = pop();
      if (closed[k] === cur) continue;
      closed[k] = cur;
      if (k === t) { found = true; break; }
      const hk = H(k);
      if (hk < bestH) { bestH = hk; bestK = k; }
      const i = k % n, j = (k / n) | 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ni = i + di, nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
          const nk = nj * n + ni;
          if (!this.walk[nk] || closed[nk] === cur) continue;
          if (di && dj && (!this.walk[j * n + ni] || !this.walk[nj * n + i])) continue;   // no corner cutting
          const ng = g[k] + (di && dj ? 1.4142 : 1);
          if (stamp[nk] !== cur || ng < g[nk]) {
            stamp[nk] = cur; g[nk] = ng; parent[nk] = k;
            push(nk, ng + H(nk));
          }
        }
      }
    }
    const end = found ? t : bestK;
    const cells = [];
    for (let k = end; k !== -1 && cells.length < 5000; k = parent[k]) cells.push(k);
    cells.reverse();
    // smooth: greedy furthest visible
    const pts = cells.map((k) => this.point(k));
    const out = [];
    let a = { x: sx, z: sz };
    let idx = 0;
    while (idx < pts.length) {
      let far = idx;
      for (let q = Math.min(pts.length - 1, idx + 40); q > idx; q--) {
        if (this.clear(a.x, a.z, pts[q].x, pts[q].z)) { far = q; break; }
      }
      out.push(pts[far]);
      a = pts[far];
      idx = far + 1;
    }
    out.partial = !found;
    return out;
  }
}
