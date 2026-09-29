/* =========================================================================
   Heightfield terrain.
   The height grid is generated once from a seed and then sampled with the
   exact same triangle split the renderer uses, so what you see is what you
   collide with (client and server agree bit for bit).
   ========================================================================= */
import { clamp, smoothstep } from './util.js';

function hash2(ix, iz, seed) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(seed, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function valueNoise(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
  return (a + (b - a) * ux) + ((c + (d - c) * ux) - (a + (b - a) * ux)) * uz;
}

function fbm(x, z, seed, oct) {
  let amp = 1, f = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += valueNoise(x * f, z * f, seed + i * 31) * amp;
    norm += amp; amp *= 0.5; f *= 2.03;
  }
  return sum / norm;
}

export class Terrain {
  /**
   * @param {object} o
   * @param {number} o.size     world size in meters (square, centered on origin)
   * @param {number} o.cell     grid spacing in meters
   * @param {number} o.seed
   * @param {Array}  o.flats    [{x,z,r,blend,h?}] areas flattened for buildings
   * @param {Array}  o.hills    [{x,z,r,h}] hand placed extra hills
   */
  constructor(o) {
    this.size = o.size;
    this.half = o.size / 2;
    this.cell = o.cell;
    this.n = Math.round(o.size / o.cell) + 1;          // vertices per side
    this.h = new Float32Array(this.n * this.n);
    this.seed = o.seed;
    const flats = o.flats || [], hills = o.hills || [];

    const raw = (x, z) => {
      let y = fbm(x / 70, z / 70, this.seed, 4) * 16 - 5;           // rolling base
      y += Math.pow(fbm(x / 34 + 9.1, z / 34 - 3.7, this.seed + 7, 3), 3) * 10;  // lumpy detail
      for (const hl of hills) {
        const d = Math.hypot(x - hl.x, z - hl.z);
        if (d < hl.r) { const t = 1 - d / hl.r; y += hl.h * t * t * (3 - 2 * t); }
      }
      // rim of hills so the play space feels enclosed
      const edge = Math.max(Math.abs(x), Math.abs(z)) / this.half;
      y += smoothstep(0.82, 1.0, edge) * 22;
      return y;
    };
    // flats get their target height from the raw terrain at their centre
    for (const f of flats) if (f.h === undefined) f.h = raw(f.x, f.z);

    for (let j = 0; j < this.n; j++) {
      for (let i = 0; i < this.n; i++) {
        const x = -this.half + i * this.cell, z = -this.half + j * this.cell;
        let y = raw(x, z);
        for (const f of flats) {
          const d = Math.hypot(x - f.x, z - f.z);
          const t = 1 - smoothstep(f.r, f.r + (f.blend || 14), d);
          if (t > 0) y = y + (f.h - y) * t;
        }
        this.h[j * this.n + i] = Math.round(y * 100) / 100;     // quantize: stable across platforms
      }
    }
    let mx = -Infinity, mn = Infinity;
    for (const v of this.h) { if (v > mx) mx = v; if (v < mn) mn = v; }
    this.maxH = mx; this.minH = mn;
  }

  vert(i, j) {
    i = clamp(i, 0, this.n - 1); j = clamp(j, 0, this.n - 1);
    return this.h[j * this.n + i];
  }

  /** height at world x,z, using triangles (0,0)-(1,0)-(0,1) and (1,1)-(0,1)-(1,0) like the mesh */
  heightAt(x, z) {
    const gx = (x + this.half) / this.cell, gz = (z + this.half) / this.cell;
    let i = Math.floor(gx), j = Math.floor(gz);
    i = clamp(i, 0, this.n - 2); j = clamp(j, 0, this.n - 2);
    const fx = clamp(gx - i, 0, 1), fz = clamp(gz - j, 0, 1);
    const h00 = this.h[j * this.n + i], h10 = this.h[j * this.n + i + 1];
    const h01 = this.h[(j + 1) * this.n + i], h11 = this.h[(j + 1) * this.n + i + 1];
    if (fx + fz <= 1) return h00 + (h10 - h00) * fx + (h01 - h00) * fz;
    return h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
  }

  /** approximate surface normal y component (1 = flat) */
  slopeAt(x, z) {
    const e = this.cell * 0.5;
    const dx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const dz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return (2 * e) / Math.sqrt(dx * dx + dz * dz + 4 * e * e);
  }

  /**
   * ray march against the heightfield.  returns hit distance t (0..maxT) or -1
   */
  raycast(ox, oy, oz, dx, dy, dz, maxT) {
    // quick reject: both ends above the highest point
    if (oy > this.maxH + 0.1 && oy + dy * maxT > this.maxH + 0.1) return -1;
    const step = this.cell * 0.5;
    let prevT = 0, prevD = oy - this.heightAt(ox, oz);
    if (prevD < 0) return 0;
    for (let t = step; ; t += step) {
      const tt = t > maxT ? maxT : t;
      const y = oy + dy * tt;
      const d = y - this.heightAt(ox + dx * tt, oz + dz * tt);
      if (d < 0) {
        // bisect between prevT and tt
        let a = prevT, b = tt;
        for (let k = 0; k < 8; k++) {
          const m = (a + b) * 0.5;
          const dm = oy + dy * m - this.heightAt(ox + dx * m, oz + dz * m);
          if (dm < 0) b = m; else a = m;
        }
        return a;
      }
      prevT = tt; prevD = d;
      if (tt >= maxT) return -1;
    }
  }
}
