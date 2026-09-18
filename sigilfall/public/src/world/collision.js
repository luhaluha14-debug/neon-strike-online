/* =============================================================================
   world geometry: axis aligned boxes, movement resolution, ray casts.
   pure data + math, so the server judges hits against exactly the same arena
   the players walk around in.

   box layout:  [x, z, w, d, h, kind, mat, y0]
     x, z  centre on the floor plane        w, d  full width / depth
     h     height of the box                y0    bottom of the box (default 0)
     kind  's' solid  |  'f' walkable step / floor  |  'c' clip (blocks movement,
           bullets pass)  |  'n' no-collide decor
     mat   material key used by the renderer
   ========================================================================== */
import { clamp } from '../core/math.js';

const NO_CLIMB = 1e4;          // marks a surface nothing may stand on top of

export class World {
  constructor(mapDef) {
    this.map = mapDef;
    this.sx = mapDef.sx;
    this.sz = mapDef.sz;
    const src = mapDef.boxes.filter((b) => b[5] !== 'n');
    const n = this.n = src.length;
    this.x0 = new Float32Array(n); this.x1 = new Float32Array(n);
    this.y0 = new Float32Array(n); this.y1 = new Float32Array(n);
    this.z0 = new Float32Array(n); this.z1 = new Float32Array(n);
    this.top = new Float32Array(n);      // the height movement may step onto
    this.opaque = new Uint8Array(n);     // blocks bullets and line of sight
    for (let i = 0; i < n; i++) {
      const b = src[i];
      const base = b[7] || 0;
      this.x0[i] = b[0] - b[2] / 2; this.x1[i] = b[0] + b[2] / 2;
      this.z0[i] = b[1] - b[3] / 2; this.z1[i] = b[1] + b[3] / 2;
      this.y0[i] = base; this.y1[i] = base + b[4];
      // the arena shell is deliberately unclimbable: landing on the skybox walls
      // strands a player somewhere bots can never reach
      this.top[i] = b[6] === 'shell' ? NO_CLIMB : base + b[4];
      this.opaque[i] = b[5] === 'c' ? 0 : 1;
    }
    this.hitNormal = { x: 0, y: 0, z: 0, index: -1 };
  }

  /* highest surface under (x, z) that feet at `feetY` may stand on */
  supportAt(x, z, feetY, r = 0.36) {
    let best = 0;
    for (let i = 0; i < this.n; i++) {
      if (x + r < this.x0[i] || x - r > this.x1[i] || z + r < this.z0[i] || z - r > this.z1[i]) continue;
      const t = this.top[i];
      if (t <= feetY + 0.06 && t > best) best = t;
    }
    return best;
  }

  /* does a capsule of radius r spanning [feet, head] overlap anything at (x, z)?
     returns the top of the tallest blocker, or -1 when the spot is free. */
  blockedAt(x, z, r, feet, head) {
    let worst = -1;
    for (let i = 0; i < this.n; i++) {
      if (x + r <= this.x0[i] || x - r >= this.x1[i] || z + r <= this.z0[i] || z - r >= this.z1[i]) continue;
      if (this.y1[i] <= feet + 0.02) continue;         // low enough to stand on
      if (this.y0[i] >= head) continue;                // high enough to walk under
      const t = this.top[i];
      if (t > worst) worst = t;
    }
    return worst;
  }

  /* moves an entity horizontally, resolving each axis on its own so sliding
     along a wall keeps working, and stepping up small ledges feels automatic. */
  moveXZ(ent, dx, dz) {
    const r = ent.radius, hh = ent.height;
    const mag = Math.abs(dx) + Math.abs(dz);
    const steps = mag > 0.42 ? Math.min(6, Math.ceil(mag / 0.38)) : 1;
    const sx = dx / steps, sz = dz / steps;
    let bumped = false;
    for (let s = 0; s < steps; s++) {
      const nx = ent.pos.x + sx;
      let hit = this.blockedAt(nx, ent.pos.z, r, ent.pos.y, ent.pos.y + hh);
      if (hit < 0) ent.pos.x = nx;
      else if (ent.onGround && hit - ent.pos.y <= 0.58 && hit < NO_CLIMB &&
        this.blockedAt(nx, ent.pos.z, r, hit, hit + hh) < 0) { ent.pos.x = nx; ent.pos.y = hit; }
      else bumped = true;

      const nz = ent.pos.z + sz;
      hit = this.blockedAt(ent.pos.x, nz, r, ent.pos.y, ent.pos.y + hh);
      if (hit < 0) ent.pos.z = nz;
      else if (ent.onGround && hit - ent.pos.y <= 0.58 && hit < NO_CLIMB &&
        this.blockedAt(ent.pos.x, nz, r, hit, hit + hh) < 0) { ent.pos.z = nz; ent.pos.y = hit; }
      else bumped = true;
    }
    const lx = this.sx - 0.6, lz = this.sz - 0.6;
    ent.pos.x = clamp(ent.pos.x, -lx, lx);
    ent.pos.z = clamp(ent.pos.z, -lz, lz);
    return bumped;
  }

  /* is there room for a capsule here?  used by blinks and summon placement. */
  fits(x, y, z, r, h) {
    if (Math.abs(x) > this.sx - 0.6 || Math.abs(z) > this.sz - 0.6) return false;
    return this.blockedAt(x, z, r, y, y + h) < 0;
  }

  /* slab ray cast against every box.  returns the hit distance (or maxT) and
     leaves the surface normal in this.hitNormal. */
  raycast(ox, oy, oz, dx, dy, dz, maxT) {
    let best = maxT, bi = -1, bAxis = 0, bSign = 0;
    const ix = 1 / (Math.abs(dx) < 1e-7 ? (dx < 0 ? -1e-7 : 1e-7) : dx);
    const iy = 1 / (Math.abs(dy) < 1e-7 ? (dy < 0 ? -1e-7 : 1e-7) : dy);
    const iz = 1 / (Math.abs(dz) < 1e-7 ? (dz < 0 ? -1e-7 : 1e-7) : dz);
    for (let i = 0; i < this.n; i++) {
      if (!this.opaque[i]) continue;
      let t1 = (this.x0[i] - ox) * ix, t2 = (this.x1[i] - ox) * ix;
      let tmin = t1 < t2 ? t1 : t2, tmax = t1 < t2 ? t2 : t1;
      let axis = 0, sgn = t1 < t2 ? -1 : 1;
      t1 = (this.y0[i] - oy) * iy; t2 = (this.y1[i] - oy) * iy;
      let a = t1 < t2 ? t1 : t2, b = t1 < t2 ? t2 : t1;
      if (a > tmin) { tmin = a; axis = 1; sgn = t1 < t2 ? -1 : 1; }
      if (b < tmax) tmax = b;
      t1 = (this.z0[i] - oz) * iz; t2 = (this.z1[i] - oz) * iz;
      a = t1 < t2 ? t1 : t2; b = t1 < t2 ? t2 : t1;
      if (a > tmin) { tmin = a; axis = 2; sgn = t1 < t2 ? -1 : 1; }
      if (b < tmax) tmax = b;
      if (tmax < 0 || tmin > tmax) continue;
      const t = tmin < 0 ? 0 : tmin;
      if (t < best) { best = t; bi = i; bAxis = axis; bSign = sgn; }
    }
    const nrm = this.hitNormal;
    nrm.x = nrm.y = nrm.z = 0; nrm.index = bi;
    if (bi >= 0) {
      if (bAxis === 0) nrm.x = bSign; else if (bAxis === 1) nrm.y = bSign; else nrm.z = bSign;
    }
    return best;
  }

  /* straight line of sight test between two points */
  segBlocked(ox, oy, oz, tx, ty, tz) {
    let dx = tx - ox, dy = ty - oy, dz = tz - oz;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-3) return false;
    dx /= len; dy /= len; dz /= len;
    return this.raycast(ox, oy, oz, dx, dy, dz, len) < len - 0.02;
  }

  /* the floor height under a point, ignoring what the entity can climb */
  groundAt(x, z) { return this.supportAt(x, z, 1e4, 0.3); }
}
