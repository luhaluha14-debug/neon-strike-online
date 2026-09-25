/* =========================================================================
   World = terrain + static axis aligned boxes + spatial index.
   Provides the collision and ray queries every other system uses.
   ========================================================================= */

const GRID = 8;          // spatial hash cell size (m)

export class World {
  /**
   * @param {import('./terrain.js').Terrain} terrain
   */
  constructor(terrain) {
    this.terrain = terrain;
    this.half = terrain.half;
    this.boxes = [];               // {minX,minY,minZ,maxX,maxY,maxZ,color,kind,hidden,noShoot}
    this.gn = Math.ceil(terrain.size / GRID);
    this.cells = new Array(this.gn * this.gn);
    for (let i = 0; i < this.cells.length; i++) this.cells[i] = [];
    this._stamp = 1;
    this.props = [];               // render only decoration: trees, bushes, rocks
    this.bushes = [];              // {x,z,r,top}
    this.lootSpots = [];           // {x,y,z,tier}
    this.locations = [];           // {name,x,z}
    this.roads = [];               // [{ax,az,bx,bz,w}]
    this.spawnSpots = [];
    this.doors = [];               // {x,z,nx,nz} door centres + normals (for bot navigation)
  }

  cellIndex(x, z) {
    let i = Math.floor((x + this.half) / GRID), j = Math.floor((z + this.half) / GRID);
    if (i < 0) i = 0; else if (i >= this.gn) i = this.gn - 1;
    if (j < 0) j = 0; else if (j >= this.gn) j = this.gn - 1;
    return j * this.gn + i;
  }

  addBox(minX, minY, minZ, maxX, maxY, maxZ, color = 0x888888, kind = 'wall', extra = null) {
    if (maxX - minX < 1e-4 || maxY - minY < 1e-4 || maxZ - minZ < 1e-4) return null;
    const b = { minX, minY, minZ, maxX, maxY, maxZ, color, kind, hidden: false, id: this.boxes.length, _s: 0 };
    if (extra) Object.assign(b, extra);
    this.boxes.push(b);
    const i0 = Math.floor((minX + this.half) / GRID), i1 = Math.floor((maxX + this.half) / GRID);
    const j0 = Math.floor((minZ + this.half) / GRID), j1 = Math.floor((maxZ + this.half) / GRID);
    for (let j = Math.max(0, j0); j <= Math.min(this.gn - 1, j1); j++)
      for (let i = Math.max(0, i0); i <= Math.min(this.gn - 1, i1); i++) this.cells[j * this.gn + i].push(b);
    return b;
  }

  groundAt(x, z) { return this.terrain.heightAt(x, z); }

  /** visit every box whose footprint overlaps the XZ rectangle (each once) */
  forBoxesIn(minX, minZ, maxX, maxZ, fn) {
    const s = ++this._stamp;
    const i0 = Math.max(0, Math.floor((minX + this.half) / GRID)), i1 = Math.min(this.gn - 1, Math.floor((maxX + this.half) / GRID));
    const j0 = Math.max(0, Math.floor((minZ + this.half) / GRID)), j1 = Math.min(this.gn - 1, Math.floor((maxZ + this.half) / GRID));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const c = this.cells[j * this.gn + i];
        for (let k = 0; k < c.length; k++) {
          const b = c[k];
          if (b._s === s) continue;
          b._s = s;
          if (b.maxX <= minX || b.minX >= maxX || b.maxZ <= minZ || b.minZ >= maxZ) continue;
          if (fn(b) === true) return true;
        }
      }
    }
    return false;
  }

  /** true when a vertical box (collider) overlaps any solid box */
  overlaps(x, z, r, y0, y1) {
    return this.forBoxesIn(x - r, z - r, x + r, z + r, (b) => b.minY < y1 && b.maxY > y0 && !b.passable);
  }

  /**
   * highest standable surface under the collider footprint that is no higher
   * than feetY + maxStep.  Terrain counts as a surface.
   */
  supportHeight(x, z, r, feetY, maxStep) {
    let best = this.terrain.heightAt(x, z);
    // sample terrain at the footprint corners too so we don't sink on slopes
    const lim = feetY + maxStep;
    this.forBoxesIn(x - r, z - r, x + r, z + r, (b) => {
      if (b.passable || b.noStand) return;          // e.g. tree trunks: nobody stands on those
      if (b.maxY <= lim && b.maxY > best) best = b.maxY;
    });
    return best;
  }

  /**
   * ray vs boxes + terrain.
   * @returns {null | {t, x, y, z, nx, ny, nz, box}}  (box null for terrain)
   */
  raycast(ox, oy, oz, dx, dy, dz, maxT, opts = null) {
    let bestT = maxT, bestBox = null, bestAxis = 0, bestSign = 0;
    const ignoreShoot = opts && opts.bullets;
    // 2D DDA across the grid
    const s = ++this._stamp;
    const half = this.half;
    let gx = (ox + half) / GRID, gz = (oz + half) / GRID;
    let i = Math.floor(gx), j = Math.floor(gz);
    const stepI = dx > 0 ? 1 : -1, stepJ = dz > 0 ? 1 : -1;
    const tDeltaX = dx !== 0 ? Math.abs(GRID / dx) : Infinity;
    const tDeltaZ = dz !== 0 ? Math.abs(GRID / dz) : Infinity;
    let tMaxX = dx !== 0 ? ((dx > 0 ? (i + 1 - gx) : (gx - i)) * GRID) / Math.abs(dx) : Infinity;
    let tMaxZ = dz !== 0 ? ((dz > 0 ? (j + 1 - gz) : (gz - j)) * GRID) / Math.abs(dz) : Infinity;
    let tCell = 0;
    const invX = 1 / dx, invY = 1 / dy, invZ = 1 / dz;
    for (let guard = 0; guard < 4096; guard++) {
      if (i >= 0 && j >= 0 && i < this.gn && j < this.gn) {
        const c = this.cells[j * this.gn + i];
        for (let k = 0; k < c.length; k++) {
          const b = c[k];
          if (b._s === s) continue;
          b._s = s;
          if (ignoreShoot && b.shootThrough) continue;
          // slab test
          let t0 = 0, t1 = bestT, axis = -1, sign = 0;
          let ta = (b.minX - ox) * invX, tb = (b.maxX - ox) * invX;
          if (ta > tb) { const q = ta; ta = tb; tb = q; }
          if (ta > t0) { t0 = ta; axis = 0; sign = dx > 0 ? -1 : 1; }
          if (tb < t1) t1 = tb;
          if (t0 > t1) continue;
          ta = (b.minY - oy) * invY; tb = (b.maxY - oy) * invY;
          if (ta > tb) { const q = ta; ta = tb; tb = q; }
          if (ta > t0) { t0 = ta; axis = 1; sign = dy > 0 ? -1 : 1; }
          if (tb < t1) t1 = tb;
          if (t0 > t1) continue;
          ta = (b.minZ - oz) * invZ; tb = (b.maxZ - oz) * invZ;
          if (ta > tb) { const q = ta; ta = tb; tb = q; }
          if (ta > t0) { t0 = ta; axis = 2; sign = dz > 0 ? -1 : 1; }
          if (tb < t1) t1 = tb;
          if (t0 > t1) continue;
          if (t0 < bestT) { bestT = t0; bestBox = b; bestAxis = axis; bestSign = sign; }
        }
      }
      if (tCell > bestT) break;
      if (tMaxX < tMaxZ) { tCell = tMaxX; tMaxX += tDeltaX; i += stepI; }
      else { tCell = tMaxZ; tMaxZ += tDeltaZ; j += stepJ; }
      if (tCell > bestT) break;
      if ((i < -1 || i > this.gn || j < -1 || j > this.gn)) break;
    }
    const tt = this.terrain.raycast(ox, oy, oz, dx, dy, dz, bestT);
    if (tt >= 0 && tt <= bestT) {
      const x = ox + dx * tt, z = oz + dz * tt;
      const e = 0.5, T = this.terrain;
      const nx = T.heightAt(x - e, z) - T.heightAt(x + e, z), nz = T.heightAt(x, z - e) - T.heightAt(x, z + e);
      const l = Math.sqrt(nx * nx + 1 + nz * nz);
      return { t: tt, x, y: oy + dy * tt, z, nx: nx / l, ny: 1 / l, nz: nz / l, box: null };
    }
    if (!bestBox) return null;
    return {
      t: bestT, x: ox + dx * bestT, y: oy + dy * bestT, z: oz + dz * bestT,
      nx: bestAxis === 0 ? bestSign : 0, ny: bestAxis === 1 ? bestSign : 0, nz: bestAxis === 2 ? bestSign : 0,
      box: bestBox
    };
  }

  /** true if the straight segment a->b hits nothing */
  lineClear(ax, ay, az, bx, by, bz) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (L < 1e-5) return true;
    return this.raycast(ax, ay, az, dx / L, dy / L, dz / L, L, { bullets: true }) === null;
  }

  inBush(x, z, y) {
    for (const b of this.bushes) {
      const dx = x - b.x, dz = z - b.z;
      if (dx * dx + dz * dz < b.r * b.r && y < b.top) return true;
    }
    return false;
  }
}
