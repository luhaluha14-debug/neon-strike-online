/* =========================================================================
   Map generator for the prototype island "HARROW ISLE" (original design).
   The layout is hand authored (fixed coordinates) and decorated with a fixed
   seed, so every client and the server build the exact same map.
   Loot *contents* are randomized per match elsewhere (loot.js).
   ========================================================================= */
import { Terrain } from './terrain.js';
import { World } from './world.js';
import { makeRng } from './util.js';

export const MAP_SEED = 20260925;
export const MAP_SIZE = 640;

/* colour palette (original, muted military / rural tones) */
export const PAL = {
  plaster: 0xbdb39c, plaster2: 0xa9a08a, brick: 0x8b5b45, concrete: 0x97999a, concrete2: 0x7d8284,
  roof: 0x5b3f35, roof2: 0x44505a, floor: 0x7a6b59, wood: 0x8a6a3e, woodDark: 0x5d4630,
  metal: 0x6f7b80, metal2: 0x55606a, hay: 0xc9ad5a, sandbag: 0x9c8b64, stair: 0x6e6255,
  rail: 0x4a4f55, stone: 0x8a877e,
  containers: [0x8c3b2e, 0x2e5a8c, 0x3f7a3a, 0xa8832f, 0x6b6f75, 0x7a4a6e]
};

const FLOOR_H = 3.0;     // storey height
const WALL_T = 0.25;

/* ---------- local-to-world transform for rotated (90° steps) structures ---------- */
function makeXf(cx, cz, rot, baseY) {
  const r = ((rot % 4) + 4) % 4;
  const tp = (u, v) => {
    switch (r) {
      case 0: return [cx + u, cz + v];
      case 1: return [cx - v, cz + u];
      case 2: return [cx - u, cz - v];
      default: return [cx + v, cz - u];
    }
  };
  const dir = (du, dv) => { const [ax, az] = tp(0, 0), [bx, bz] = tp(du, dv); return [bx - ax, bz - az]; };
  return { tp, dir, baseY };
}

function addDoor(world, xf, u, v, nu, nv) {
  const [x, z] = xf.tp(u, v), [nx, nz] = xf.dir(nu, nv);
  world.doors.push({ x, z, nx, nz });
}

class Builder {
  constructor(world) { this.w = world; }
  /** box in local coordinates (u,v horizontal, y relative to xf.baseY) */
  box(xf, u0, y0, v0, u1, y1, v1, color, kind = 'wall', extra = null) {
    const [ax, az] = xf.tp(u0, v0), [bx, bz] = xf.tp(u1, v1);
    return this.w.addBox(Math.min(ax, bx), xf.baseY + y0, Math.min(az, bz), Math.max(ax, bx), xf.baseY + y1, Math.max(az, bz), color, kind, extra);
  }
  /**
   * straight wall along u (axis 'u') or along v (axis 'v') with rectangular openings.
   * openings: [{c, w, y0, y1}] where c is the centre along the wall axis.
   */
  wall(xf, axis, from, to, at, y0, h, openings, color) {
    const ops = (openings || []).slice().sort((a, b) => a.c - b.c);
    const t2 = WALL_T / 2;
    const seg = (a, b, ya, yb) => {
      if (b - a < 0.02 || yb - ya < 0.02) return;
      if (axis === 'u') this.box(xf, a, ya, at - t2, b, yb, at + t2, color);
      else this.box(xf, at - t2, ya, a, at + t2, yb, b, color);
    };
    let cur = from;
    for (const o of ops) {
      const a = o.c - o.w / 2, b = o.c + o.w / 2;
      seg(cur, a, y0, y0 + h);
      seg(a, b, y0, y0 + o.y0);             // below opening
      seg(a, b, y0 + o.y1, y0 + h);         // above opening
      cur = b;
    }
    seg(cur, to, y0, y0 + h);
  }
  /**
   * straight stairs in local space along v.
   * lane u0..u1, starting at v=vStart going in direction dir (+1/-1), from floor y to y+rise
   */
  stairs(xf, u0, u1, vStart, dir, y, rise, color = PAL.stair) {
    const n = Math.round(rise / 0.25), stepRise = rise / n, run = 0.3;
    for (let i = 0; i < n; i++) {
      const va = vStart + dir * i * run, vb = vStart + dir * (i + 1) * run;
      this.box(xf, u0, y, Math.min(va, vb), u1, y + (i + 1) * stepRise, Math.max(va, vb), color, 'stair');
    }
    return n * run;
  }
  /** horizontal slab with optional rectangular holes (local coords) */
  slab(xf, u0, v0, u1, v1, yTop, thick, holes, color) {
    // split the rectangle into pieces around holes (supports up to a couple of holes)
    let rects = [[u0, v0, u1, v1]];
    for (const h of holes || []) {
      const next = [];
      for (const r of rects) {
        const [a0, b0, a1, b1] = r;
        const hu0 = Math.max(a0, h[0]), hv0 = Math.max(b0, h[1]), hu1 = Math.min(a1, h[2]), hv1 = Math.min(b1, h[3]);
        if (hu0 >= hu1 || hv0 >= hv1) { next.push(r); continue; }
        next.push([a0, b0, a1, hv0]);        // front strip
        next.push([a0, hv1, a1, b1]);        // back strip
        next.push([a0, hv0, hu0, hv1]);      // left
        next.push([hu1, hv0, a1, hv1]);      // right
      }
      rects = next.filter((r) => r[2] - r[0] > 0.01 && r[3] - r[1] > 0.01);
    }
    for (const r of rects) this.box(xf, r[0], yTop - thick, r[1], r[2], yTop, r[3], color, 'floor');
  }
}

/* ---------- structures ---------- */

/**
 * a house / office style building with 1-2 floors, optional roof access
 * returns interior loot spots
 */
function building(B, world, o) {
  const { x, z, w, d, rot = 0, floors = 1, roofAccess = false, color = PAL.plaster, roofColor = PAL.roof, tier = 1 } = o;
  const g = world.groundAt(x, z);
  const xf = makeXf(x, z, rot, g);
  const hw = w / 2, hd = d / 2, t = WALL_T;
  const base = 0.15;                              // floor top of ground level
  const flights = floors - 1 + (roofAccess ? 1 : 0);
  const laneW = 1.25;
  const laneU = [-hw + t / 2 + 0.05, -hw + t / 2 + 0.05 + laneW];   // lane A u-range start; lane B next to it
  const stairLen = 12 * 0.3;
  const vs = -hd + t / 2 + 0.6;                   // stairs start (v)
  const laneRange = (f) => {
    const u0 = laneU[0] + (f % 2) * laneW;
    return [u0, u0 + laneW];
  };

  // foundation / ground floor
  B.box(xf, -hw, -0.8, -hd, hw, base, hd, PAL.floor, 'floor');

  const spots = [];
  for (let f = 0; f < floors; f++) {
    const y0 = base + f * FLOOR_H;
    const wallH = FLOOR_H;
    // openings
    const doorF = f === 0 ? [{ c: hw * 0.45, w: 1.3, y0: 0, y1: 2.3 }] : [];
    const doorB = f === 0 && w * d > 90 ? [{ c: -hw * 0.1 + 1.6, w: 1.3, y0: 0, y1: 2.3 }] : [];
    const win = (len, skip) => {
      const res = [];
      const n = Math.max(1, Math.floor(len / 3.6));
      for (let i = 0; i < n; i++) {
        const c = -len / 2 + (i + 0.5) * (len / n);
        if (skip && skip.some((s) => Math.abs(s.c - c) < 1.5)) continue;
        res.push({ c, w: 1.2, y0: 1.0, y1: 2.0 });
      }
      return res;
    };
    B.wall(xf, 'u', -hw, hw, hd - t / 2, y0, wallH, doorF.concat(win(w, doorF)), color);
    for (const dr of doorF) addDoor(world, xf, dr.c, hd - t / 2, 0, 1);
    for (const dr of doorB) addDoor(world, xf, dr.c, -hd + t / 2, 0, 1);
    B.wall(xf, 'u', -hw, hw, -hd + t / 2, y0, wallH, doorB.concat(win(w, doorB)), color);
    B.wall(xf, 'v', -hd + t, hd - t, -hw + t / 2, y0, wallH, win(d - 2 * t, [{ c: vs + stairLen / 2 }]), color);
    B.wall(xf, 'v', -hd + t, hd - t, hw - t / 2, y0, wallH, win(d - 2 * t), color);
    // interior partition for bigger footprints
    if (w >= 9) {
      const pu = laneU[0] + laneW * 2 + 1.2 + (w - 9) * 0.25;
      B.wall(xf, 'v', -hd + t, hd - t, pu, y0, wallH - 0.2, [{ c: 0, w: 1.1, y0: 0, y1: 2.2 }, { c: hd * 0.6, w: 1.1, y0: 0, y1: 2.2 }], PAL.plaster2);
      if (f === 0) { addDoor(world, xf, pu, 0, 1, 0); addDoor(world, xf, pu, hd * 0.6, 1, 0); }
    }
    // loot spots on this floor (avoid stair lanes)
    const uMin = laneU[0] + laneW * 2 + 0.6, uMax = hw - 0.8;
    const cnt = 2 + Math.floor((w * d) / 60);
    for (let i = 0; i < cnt; i++) {
      const u = uMin + ((i * 0.618 + 0.21) % 1) * (uMax - uMin);
      const v = -hd + 1 + ((i * 0.377 + 0.13 + f * 0.31) % 1) * (d - 2);
      const [wx, wz] = xf.tp(u, v);
      spots.push({ x: wx, y: g + y0 + 0.05, z: wz, tier });
    }
  }
  // stairs and slabs
  for (let f = 0; f < flights; f++) {
    const [u0, u1] = laneRange(f);
    const dir = f % 2 === 0 ? 1 : -1;
    const v0 = dir > 0 ? vs : vs + stairLen;
    B.stairs(xf, u0, u1, v0, dir, base + f * FLOOR_H, FLOOR_H);
  }
  for (let f = 1; f <= floors; f++) {
    const yTop = base + f * FLOOR_H;
    const holes = [];
    const fl = f - 1;                               // the flight arriving at this level
    if (fl < flights) {
      const [u0, u1] = laneRange(fl);
      holes.push([u0 - 0.05, vs - 0.05, u1 + 0.05, vs + stairLen + 0.05]);
    }
    const isRoof = f === floors;
    B.slab(xf, -hw, -hd, hw, hd, yTop, 0.2, holes, isRoof ? roofColor : PAL.floor);
    // railing beside the hole on inner floors so people do not fall in sideways
    if (fl < flights && fl % 2 === 0 && !isRoof) {
      const [, u1] = laneRange(fl);
      B.box(xf, u1 - 0.04, yTop, vs, u1 + 0.04, yTop + 1.0, vs + stairLen - 0.9, PAL.rail, 'rail', { shootThrough: true });
    }
  }
  if (roofAccess) {
    const yTop = base + floors * FLOOR_H;
    // parapet
    B.box(xf, -hw, yTop, -hd, hw, yTop + 1.0, -hd + 0.2, color);
    B.box(xf, -hw, yTop, hd - 0.2, hw, yTop + 1.0, hd, color);
    B.box(xf, -hw, yTop, -hd + 0.2, -hw + 0.2, yTop + 1.0, hd - 0.2, color);
    B.box(xf, hw - 0.2, yTop, -hd + 0.2, hw, yTop + 1.0, hd - 0.2, color);
    const [wx, wz] = xf.tp(hw * 0.5, 0);
    spots.push({ x: wx, y: g + yTop + 0.05, z: wz, tier: tier + 1 });
  } else {
    // roof overhang lip for looks
    B.box(xf, -hw - 0.3, base + floors * FLOOR_H, -hd - 0.3, hw + 0.3, base + floors * FLOOR_H + 0.35, hd + 0.3, roofColor, 'roof');
  }
  world.lootSpots.push(...spots);
  return spots;
}

function warehouse(B, world, o) {
  const { x, z, w = 26, d = 16, rot = 0, H = 7, color = PAL.metal, mezz = true, tier = 2 } = o;
  const g = world.groundAt(x, z);
  const xf = makeXf(x, z, rot, g);
  const hw = w / 2, hd = d / 2, t = WALL_T;
  B.box(xf, -hw, -0.8, -hd, hw, 0.1, hd, PAL.concrete2, 'floor');
  const big = [{ c: 0, w: 4.5, y0: 0, y1: 4.5 }];
  const hi = (len) => {
    const r = []; const n = Math.floor(len / 5);
    for (let i = 0; i < n; i++) r.push({ c: -len / 2 + (i + 0.5) * (len / n), w: 2.2, y0: 4.6, y1: 5.6 });
    return r;
  };
  B.wall(xf, 'v', -hd, hd, -hw + t / 2, 0.1, H, big, color);
  B.wall(xf, 'v', -hd, hd, hw - t / 2, 0.1, H, big, color);
  B.wall(xf, 'u', -hw + t, hw - t, -hd + t / 2, 0.1, H, hi(w).concat([{ c: hw * 0.55, w: 1.3, y0: 0, y1: 2.3 }]), color);
  B.wall(xf, 'u', -hw + t, hw - t, hd - t / 2, 0.1, H, hi(w), color);
  B.box(xf, -hw - 0.4, H + 0.1, -hd - 0.4, hw + 0.4, H + 0.45, hd + 0.4, PAL.roof2, 'roof');
  addDoor(world, xf, -hw + t / 2, 0, 1, 0); addDoor(world, xf, hw - t / 2, 0, 1, 0); addDoor(world, xf, hw * 0.55, -hd + t / 2, 0, 1);
  const spots = [];
  const add = (u, v, y, tr = tier) => { const [wx, wz] = xf.tp(u, v); spots.push({ x: wx, y: g + y + 0.05, z: wz, tier: tr }); };
  if (mezz) {
    const mTop = 3.35, depth = 4.2;
    const v0 = -hd + t, v1 = -hd + t + depth;
    B.slab(xf, -hw + t, v0, hw - t - 1.5, v1, mTop, 0.3, [], PAL.metal2);
    // support pillars
    for (let u = -hw + 3; u < hw - 3; u += 6) B.box(xf, u - 0.15, 0.1, v1 - 0.3, u + 0.15, mTop - 0.3, v1, PAL.metal2, 'pillar');
    // railing with gap at the stair head
    B.box(xf, -hw + t, mTop, v1 - 0.08, hw - t - 3.2, mTop + 1.0, v1, PAL.rail, 'rail', { shootThrough: true });
    // stairs coming up along -v at the right end
    const su0 = hw - t - 1.45, su1 = hw - t - 0.05;
    const n = Math.round((mTop - 0.1) / 0.25);
    const run = n * 0.3;
    B.stairs(xf, su0, su1, v0 + run, -1, 0.1, mTop - 0.1);
    add(-hw + 3, v0 + 2, mTop, tier + 1); add(0, v0 + 2, mTop, tier + 1); add(hw - 6, v0 + 2, mTop, tier + 1);
  }
  // crates for cover
  const rng = makeRng((x * 73856093) ^ (z * 19349663));
  for (let i = 0; i < 7; i++) {
    const u = rng.range(-hw + 2.5, hw - 4), v = rng.range(-hd + 6.5, hd - 2);
    const s = rng.range(1.1, 1.5);
    B.box(xf, u - s / 2, 0.1, v - s / 2, u + s / 2, 0.1 + s, v + s / 2, PAL.wood, 'crate');
    if (rng.chance(0.35)) B.box(xf, u - s / 2 + 0.1, 0.1 + s, v - s / 2 + 0.1, u + s / 2 - 0.1, 0.1 + s * 1.9, v + s / 2 - 0.1, PAL.woodDark, 'crate');
    add(u + s / 2 + 0.6, v, 0.1);
  }
  world.lootSpots.push(...spots);
}

function container(B, xf, u, v, rotAlong, level, color) {
  const L = 6.1, W = 2.45, H = 2.6;
  const y0 = level * H;
  if (rotAlong) B.box(xf, u - L / 2, y0, v - W / 2, u + L / 2, y0 + H, v + W / 2, color, 'container');
  else B.box(xf, u - W / 2, y0, v - L / 2, u + W / 2, y0 + H, v + L / 2, color, 'container');
}

function containerYard(B, world, o) {
  const { x, z } = o;
  const g = world.groundAt(x, z);
  const xf = makeXf(x, z, 0, g);
  const rng = makeRng(991);
  B.box(xf, -28, -0.5, -22, 28, 0.05, 22, PAL.concrete2, 'floor');
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 5; c++) {
      if (rng.chance(0.18)) continue;
      const u = -22 + c * 11 + rng.range(-1, 1), v = -16 + r * 10.5;
      const along = rng.chance(0.75);
      const cols = PAL.containers;
      container(B, xf, u, v, along, 0, cols[rng.int(0, cols.length - 1)]);
      if (rng.chance(0.4)) container(B, xf, u + rng.range(-0.3, 0.3), v, along, 1, cols[rng.int(0, cols.length - 1)]);
      // step crate next to some stacks so they can be climbed
      if (rng.chance(0.35)) B.box(xf, u + 3.2, 0, v - 0.6, u + 4.4, 1.3, v + 0.6, PAL.wood, 'crate');
      const [wx, wz] = xf.tp(u + (along ? 0 : 2.2), v + (along ? 2 : 0));
      world.lootSpots.push({ x: wx, y: g + 0.1, z: wz, tier: 1 });
    }
  }
  // small office by the yard gate
  building(B, world, { x: x - 34, z: z + 4, w: 8, d: 7, rot: 1, floors: 1, color: PAL.concrete, roofColor: PAL.roof2, tier: 1 });
}

function fenceLine(B, world, ax, az, bx, bz, h = 1.05, gapEvery = 0) {
  const L = Math.hypot(bx - ax, bz - az);
  const n = Math.ceil(L / 3);
  for (let i = 0; i < n; i++) {
    if (gapEvery && i % gapEvery === gapEvery - 1) continue;
    const t0 = i / n, t1 = (i + 1) / n;
    const x0 = ax + (bx - ax) * t0, z0 = az + (bz - az) * t0, x1 = ax + (bx - ax) * t1, z1 = az + (bz - az) * t1;
    const g = Math.min(world.groundAt(x0, z0), world.groundAt(x1, z1)) - 0.3;
    const top = Math.max(world.groundAt(x0, z0), world.groundAt(x1, z1)) + h;
    const minX = Math.min(x0, x1) - 0.08, maxX = Math.max(x0, x1) + 0.08, minZ = Math.min(z0, z1) - 0.08, maxZ = Math.max(z0, z1) + 0.08;
    world.addBox(minX, g, minZ, maxX, top, maxZ, PAL.woodDark, 'fence');
  }
}

function ruins(B, world, x, z, rng) {
  // sit on the lowest point of the footprint so the slab never floats on a slope
  let g = Infinity;
  for (let a = -5; a <= 5; a += 2.5) for (let b = -4; b <= 4; b += 2) g = Math.min(g, world.groundAt(x + a, z + b));
  const xf = makeXf(x, z, rng.int(0, 3), g);
  const w = 9, d = 7;
  B.box(xf, -w / 2, -0.5, -d / 2, w / 2, 0.1, d / 2, PAL.stone, 'floor');
  const hs = [2.8, 1.4, 2.2, 0.9, 2.6, 1.8];
  let k = 0;
  for (let u = -w / 2; u < w / 2 - 0.1; u += 1.5) {
    B.box(xf, u, 0, -d / 2, u + 1.5, hs[k++ % hs.length] * rng.range(0.6, 1.1), -d / 2 + 0.4, PAL.stone, 'ruin');
  }
  for (let v = -d / 2 + 0.4; v < d / 2 - 1.5; v += 1.5) {
    if (rng.chance(0.3)) continue;
    B.box(xf, -w / 2, 0, v, -w / 2 + 0.4, hs[k++ % hs.length] * rng.range(0.6, 1.1), v + 1.5, PAL.stone, 'ruin');
  }
  const [wx, wz] = xf.tp(0, 0);
  world.lootSpots.push({ x: wx, y: g + 0.15, z: wz, tier: 1 });
}

function sandbags(B, world, x, z, rot, len = 3) {
  const g = world.groundAt(x, z);
  const xf = makeXf(x, z, rot, g - 0.1);
  B.box(xf, -len / 2, 0, -0.35, len / 2, 1.05, 0.35, PAL.sandbag, 'sandbag');
}

function carWreck(B, world, x, z, rot, color) {
  const g = world.groundAt(x, z);
  const xf = makeXf(x, z, rot, g);
  B.box(xf, -2.1, 0.25, -0.9, 2.1, 1.05, 0.9, color, 'car');
  B.box(xf, -1.0, 1.05, -0.8, 1.2, 1.6, 0.8, color, 'car');
}

/* ---------- road helpers ---------- */
function distToSeg(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = ax + dx * t, z = az + dz * t;
  return Math.hypot(px - x, pz - z);
}
export function roadDist(world, x, z) {
  let best = Infinity;
  for (const r of world.roads) {
    const d = distToSeg(x, z, r.ax, r.az, r.bx, r.bz) - r.w / 2;
    if (d < best) best = d;
  }
  return best;
}

/* ======================================================================= */
export function buildMap() {
  const sites = {
    town: { x: -110, z: -80, r: 40 },
    ashford: { x: 150, z: 140, r: 56 },
    depot: { x: 140, z: -120, r: 36 },
    yard: { x: 200, z: 20, r: 34 },
    ridge: { x: -140, z: 140, r: 15 },
    farm: { x: 0, z: 200, r: 28 },
    cross: { x: 0, z: 0, r: 16 },
    base: { x: -195, z: 30, r: 42 },
    quarry: { x: -30, z: -200, r: 36 },
    hamlet: { x: -205, z: -195, r: 26 }
  };
  const flats = Object.values(sites).map((s) => ({ x: s.x, z: s.z, r: s.r, blend: 18 }));
  const terrain = new Terrain({
    size: MAP_SIZE, cell: 2, seed: MAP_SEED, flats,
    hills: [
      { x: -140, z: 140, r: 80, h: 18 }, { x: 70, z: 50, r: 60, h: 10 }, { x: -70, z: -140, r: 60, h: 9 },
      { x: 220, z: -210, r: 70, h: 14 }, { x: -40, z: 100, r: 40, h: 6 }, { x: 90, z: -250, r: 50, h: 8 }, { x: -250, z: 200, r: 60, h: 12 }
    ]
  });
  const world = new World(terrain);
  const B = new Builder(world);
  const rng = makeRng(MAP_SEED);

  world.locations = [
    { name: 'MILLBROOK', x: sites.town.x, z: sites.town.z, kind: 'town' },
    { name: 'ASHFORD', x: sites.ashford.x, z: sites.ashford.z, kind: 'town' },
    { name: 'IRONWORKS', x: sites.depot.x, z: sites.depot.z, kind: 'industry' },
    { name: 'SALT YARD', x: sites.yard.x, z: sites.yard.z, kind: 'port' },
    { name: 'WATCH RIDGE', x: sites.ridge.x, z: sites.ridge.z, kind: 'military' },
    { name: 'HOLLOW FARM', x: sites.farm.x, z: sites.farm.z, kind: 'farm' },
    { name: 'CROSSROADS', x: sites.cross.x, z: sites.cross.z, kind: 'road' },
    { name: 'CAMP VARGA', x: sites.base.x, z: sites.base.z, kind: 'military' },
    { name: 'GREYSTONE QUARRY', x: sites.quarry.x, z: sites.quarry.z, kind: 'industry' },
    { name: 'PINECREST', x: sites.hamlet.x, z: sites.hamlet.z, kind: 'town' }
  ];

  const S = sites;
  const road = (a, b, w = 7) => world.roads.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z, w });
  road(S.cross, S.town); road(S.cross, S.depot); road(S.cross, S.yard); road(S.cross, S.farm, 6);
  road(S.cross, S.ashford); road(S.cross, S.base, 6); road(S.cross, S.quarry, 6);
  road(S.town, S.hamlet, 6); road(S.town, S.quarry, 6); road(S.depot, S.yard, 6); road(S.yard, S.ashford, 6);
  road(S.farm, S.ashford, 6); road(S.base, { x: -150, z: 110 }, 5); road({ x: -150, z: 110 }, S.ridge, 5); road(S.base, S.town, 6);

  const cols = [PAL.plaster, PAL.brick, PAL.plaster2];

  /* ---- MILLBROOK: small town grid ---- */
  const T = S.town;
  const houses = [
    [-22, -22, 10, 8, 2, 0], [0, -24, 8, 7, 1, 0], [22, -22, 11, 9, 2, 2],
    [-24, 0, 8, 7, 1, 1], [24, 1, 9, 8, 1, 3],
    [-22, 22, 9, 9, 2, 0], [1, 24, 12, 8, 2, 2], [23, 22, 8, 7, 1, 2]
  ];
  for (const [du, dv, w, d, fl, rot] of houses) building(B, world, { x: T.x + du, z: T.z + dv, w, d, rot, floors: fl, color: cols[(Math.abs(du + dv) / 2 | 0) % 3], tier: 1 });
  { const g = world.groundAt(T.x, T.z); world.addBox(T.x - 1.6, g - 0.2, T.z - 1.6, T.x + 1.6, g + 0.8, T.z + 1.6, PAL.stone, 'fountain'); }
  carWreck(B, world, T.x + 8, T.z - 9, 0, 0x55606a);
  carWreck(B, world, T.x - 10, T.z + 8, 1, 0x7a3d33);

  /* ---- ASHFORD: bigger town, apartment blocks = close quarters ---- */
  const A = S.ashford;
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 3; j++) {
      const du = -42 + i * 28, dv = -30 + j * 30;
      if (i === 1 && j === 1) continue;                     // main square
      const big = (i + j) % 3 === 0;
      building(B, world, {
        x: A.x + du + rng.range(-2, 2), z: A.z + dv + rng.range(-2, 2), w: big ? 14 : rng.int(8, 11), d: big ? 10 : rng.int(7, 9),
        rot: rng.int(0, 3), floors: big ? 3 : rng.int(1, 2), roofAccess: big, color: cols[(i * 3 + j) % 3], tier: big ? 2 : 1
      });
    }
  }
  { const g = world.groundAt(A.x - 14, A.z); world.addBox(A.x - 16, g - 0.2, A.z - 2, A.x - 12, g + 0.9, A.z + 2, PAL.stone, 'fountain'); }
  carWreck(B, world, A.x, A.z + 12, 0, 0x4f5f7a);
  carWreck(B, world, A.x + 30, A.z - 14, 1, 0x7a6a3d);

  /* ---- IRONWORKS depot ---- */
  const D = S.depot;
  warehouse(B, world, { x: D.x - 8, z: D.z - 12, rot: 0 });
  warehouse(B, world, { x: D.x + 14, z: D.z + 14, w: 22, d: 14, rot: 1, H: 6.5, color: PAL.metal2, mezz: true });
  for (let i = 0; i < 6; i++) {
    const g = world.groundAt(D.x, D.z);
    const px = D.x - 20 + i * 5.5 + rng.range(-1, 1), pz = D.z + 12 + rng.range(-3, 3);
    world.addBox(px - 0.7, g, pz - 0.7, px + 0.7, g + 1.4, pz + 0.7, PAL.wood, 'crate');
    world.lootSpots.push({ x: px + 1.3, y: g + 0.1, z: pz, tier: 1 });
  }
  fenceLine(B, world, D.x - 34, D.z - 34, D.x + 34, D.z - 34, 2.4, 4);
  fenceLine(B, world, D.x + 34, D.z - 34, D.x + 34, D.z + 30, 2.4, 4);

  /* ---- SALT YARD containers ---- */
  containerYard(B, world, S.yard);

  /* ---- WATCH RIDGE: tower + ruins on the big hill = long range fights ---- */
  const R = S.ridge;
  building(B, world, { x: R.x, z: R.z, w: 7, d: 7, floors: 2, roofAccess: true, color: PAL.concrete, roofColor: PAL.concrete2, tier: 2 });
  sandbags(B, world, R.x + 8, R.z + 2, 1, 3.5);
  sandbags(B, world, R.x - 7, R.z - 7, 0, 3.5);
  sandbags(B, world, R.x + 3, R.z - 9, 0, 3);
  ruins(B, world, R.x + 19, R.z - 11, rng);
  ruins(B, world, R.x - 17, R.z + 12, rng);

  /* ---- CAMP VARGA: walled military base, best loot ---- */
  const V = S.base;
  const gv = world.groundAt(V.x, V.z);
  const wall = (x0, z0, x1, z1) => world.addBox(Math.min(x0, x1) - 0.3, gv - 0.5, Math.min(z0, z1) - 0.3, Math.max(x0, x1) + 0.3, gv + 3, Math.max(z0, z1) + 0.3, PAL.concrete2, 'wall');
  // perimeter with gates on every side
  wall(V.x - 36, V.z - 36, V.x - 5, V.z - 36); wall(V.x + 5, V.z - 36, V.x + 36, V.z - 36);
  wall(V.x - 36, V.z + 36, V.x - 5, V.z + 36); wall(V.x + 5, V.z + 36, V.x + 36, V.z + 36);
  wall(V.x - 36, V.z - 36, V.x - 36, V.z - 5); wall(V.x - 36, V.z + 5, V.x - 36, V.z + 36);
  wall(V.x + 36, V.z - 36, V.x + 36, V.z - 5); wall(V.x + 36, V.z + 5, V.x + 36, V.z + 36);
  warehouse(B, world, { x: V.x - 14, z: V.z - 18, w: 20, d: 9, rot: 0, H: 4.5, color: 0x5a6450, mezz: false, tier: 2 });
  warehouse(B, world, { x: V.x - 14, z: V.z + 18, w: 20, d: 9, rot: 0, H: 4.5, color: 0x5a6450, mezz: false, tier: 2 });
  building(B, world, { x: V.x + 18, z: V.z - 16, w: 6, d: 6, floors: 3, roofAccess: true, color: PAL.concrete, roofColor: PAL.concrete2, tier: 3 });
  building(B, world, { x: V.x + 18, z: V.z + 14, w: 11, d: 8, floors: 1, color: PAL.concrete, roofColor: PAL.roof2, tier: 2 });
  for (const [dx, dz, r] of [[4, -4, 0], [-4, 6, 1], [10, 2, 0], [26, 0, 1], [-26, 0, 1]]) sandbags(B, world, V.x + dx, V.z + dz, r, 3.5);
  { const xf = makeXf(V.x + 2, V.z, 0, gv); container(B, xf, 0, -26, true, 0, PAL.containers[2]); container(B, xf, 0, -26, true, 1, PAL.containers[4]); container(B, xf, 8, 27, true, 0, PAL.containers[2]); }

  /* ---- GREYSTONE QUARRY: open pit, big rock blocks, machinery ---- */
  const Q = S.quarry;
  const gq = world.groundAt(Q.x, Q.z);
  for (let i = 0; i < 14; i++) {
    const a = rng.range(0, 6.28), r = rng.range(8, 30), sz = rng.range(2, 5);
    const x = Q.x + Math.cos(a) * r, z = Q.z + Math.sin(a) * r;
    world.addBox(x - sz / 2, gq - 0.5, z - sz / 2, x + sz / 2, gq + sz * rng.range(0.5, 1.1), z + sz / 2, PAL.stone, 'rock');
  }
  warehouse(B, world, { x: Q.x + 18, z: Q.z - 18, w: 16, d: 10, rot: 1, H: 6, color: PAL.metal, mezz: false, tier: 1 });
  { const xf = makeXf(Q.x - 14, Q.z + 16, 0, gq); container(B, xf, 0, 0, true, 0, PAL.containers[3]); container(B, xf, 0, 3, true, 0, PAL.containers[0]); container(B, xf, 0, 1.5, true, 1, PAL.containers[1]); }
  for (let i = 0; i < 6; i++) world.lootSpots.push({ x: Q.x + rng.range(-24, 24), y: gq + 0.1, z: Q.z + rng.range(-24, 24), tier: 1 });

  /* ---- PINECREST: forest hamlet ---- */
  const P = S.hamlet;
  for (const [du, dv, rot] of [[-12, -10, 0], [12, -9, 1], [-11, 12, 2], [13, 11, 3]]) building(B, world, { x: P.x + du, z: P.z + dv, w: 8, d: 7, rot, floors: 1 + (du > 0 ? 1 : 0), color: PAL.plaster2, tier: 1 });

  /* ---- HOLLOW FARM ---- */
  const F = S.farm;
  warehouse(B, world, { x: F.x - 8, z: F.z + 4, w: 16, d: 12, rot: 1, H: 6, color: 0x7e3b2c, mezz: false, tier: 1 });
  building(B, world, { x: F.x + 14, z: F.z - 6, w: 9, d: 8, floors: 2, color: PAL.plaster, tier: 1 });
  for (let i = 0; i < 7; i++) {
    const px = F.x + rng.range(-20, 20), pz = F.z + rng.range(-24, -12);
    const g = world.groundAt(px, pz);
    world.addBox(px - 0.9, g - 0.1, pz - 0.6, px + 0.9, g + 1.2, pz + 0.6, PAL.hay, 'hay');
  }
  fenceLine(B, world, F.x - 26, F.z - 28, F.x + 26, F.z - 28, 1.05, 5);
  fenceLine(B, world, F.x - 26, F.z - 28, F.x - 26, F.z + 22, 1.05, 5);

  /* ---- CROSSROADS: roadside shop + wrecks ---- */
  const C = S.cross;
  building(B, world, { x: C.x + 9, z: C.z - 9, w: 10, d: 7, rot: 0, floors: 1, color: PAL.concrete, roofColor: PAL.roof2, tier: 1 });
  carWreck(B, world, C.x - 5, C.z + 6, 1, 0x3e5a44);
  carWreck(B, world, C.x + 12, C.z + 8, 0, 0x8f8a7a);
  sandbags(B, world, C.x - 8, C.z - 6, 0);

  /* ---- scattered field cover / loot ---- */
  for (let i = 0; i < 60; i++) {
    const x = rng.range(-250, 250), z = rng.range(-250, 250);
    if (nearSite(sites, x, z, 10) || roadDist(world, x, z) < 3) continue;
    // only on level ground: on a slope the floor slab would float like a wall
    let lo = Infinity, hi = -Infinity;
    for (let a = -6; a <= 6; a += 3) for (let b = -6; b <= 6; b += 3) { const h = world.groundAt(x + a, z + b); lo = Math.min(lo, h); hi = Math.max(hi, h); }
    if (hi - lo > 0.9) continue;
    const k = rng.next();
    if (k < 0.4) ruins(B, world, x, z, rng);
    else if (k < 0.55) building(B, world, { x, z, w: 7, d: 6, rot: rng.int(0, 3), floors: 1, color: cols[i % 3], tier: 0 });
    else { sandbags(B, world, x, z, rng.int(0, 1)); world.lootSpots.push({ x: x + 1.2, y: world.groundAt(x + 1.2, z + 1.2) + 0.1, z: z + 1.2, tier: 0 }); }
  }

  /* ---- decoration: trees, bushes, rocks ---- */
  const occupied = (x, z, pad) => {
    let hit = false;
    world.forBoxesIn(x - pad, z - pad, x + pad, z + pad, () => { hit = true; return true; });
    return hit;
  };
  // forests: west woods, east hills, south, around Pinecrest = ambush country
  const forests = [[-180, 20, 110, 0.9], [210, -30, 80, 0.8], [-40, -200, 90, 0.5], [-205, -195, 80, 1], [60, 250, 80, 0.8], [-60, 150, 70, 0.7], [80, 60, 60, 0.6]];
  const density = (x, z) => {
    let d = 0.18;
    for (const [fx, fz, fr, k] of forests) d += Math.max(0, 1 - Math.hypot(x - fx, z - fz) / fr) * k;
    return d;
  };
  let trees = 0;
  for (let tries = 0; tries < 30000 && trees < 1700; tries++) {
    const x = rng.range(-300, 300), z = rng.range(-300, 300);
    if (rng.next() > density(x, z)) continue;
    if (nearSite(sites, x, z, 3) || roadDist(world, x, z) < 2.5 || occupied(x, z, 2.5)) continue;
    const g = world.groundAt(x, z);
    const h = rng.range(7, 13), kind = rng.chance(0.65) ? 'pine' : 'oak';
    world.props.push({ type: 'tree', kind, x, y: g, z, h, s: rng.range(0.8, 1.25) });
    world.addBox(x - 0.28, g - 0.5, z - 0.28, x + 0.28, g + h * 0.7, z + 0.28, 0x4a3726, 'trunk', { hidden: true, noStand: true });
    trees++;
  }
  for (let i = 0; i < 900; i++) {
    const x = rng.range(-280, 280), z = rng.range(-280, 280);
    if (roadDist(world, x, z) < 1.5 || occupied(x, z, 1.8)) continue;
    const g = world.groundAt(x, z), r = rng.range(1.0, 1.8);
    world.props.push({ type: 'bush', x, y: g, z, r });
    world.bushes.push({ x, z, r, top: g + 1.15 });
  }
  for (let i = 0; i < 240; i++) {
    const x = rng.range(-280, 280), z = rng.range(-280, 280);
    if (nearSite(sites, x, z, 4) || roadDist(world, x, z) < 3 || occupied(x, z, 3)) continue;
    const g = world.groundAt(x, z), s = rng.range(1.0, 2.6);
    world.props.push({ type: 'rock', x, y: g, z, s, rot: rng.range(0, 6.28) });
    world.addBox(x - s * 0.75, g - 0.5, z - s * 0.75, x + s * 0.75, g + s * 0.95, z + s * 0.75, PAL.stone, 'rock', { hidden: true });
  }

  /* ---- invisible map boundary ---- */
  const H = world.half, lim = 276;
  world.addBox(-H, -50, -H, -lim, 300, H, 0, 'bound', { hidden: true });
  world.addBox(lim, -50, -H, H, 300, H, 0, 'bound', { hidden: true });
  world.addBox(-lim, -50, -H, lim, 300, -lim, 0, 'bound', { hidden: true });
  world.addBox(-lim, -50, lim, lim, 300, H, 0, 'bound', { hidden: true });
  world.playLimit = lim;

  /* ---- spawn spots: clear outdoor points on a grid ---- */
  for (let x = -255; x <= 255; x += 10) {
    for (let z = -255; z <= 255; z += 10) {
      if (occupied(x, z, 1.5)) continue;
      if (world.terrain.slopeAt(x, z) < 0.8) continue;
      world.spawnSpots.push({ x, z });
    }
  }

  /* ---- vehicle parking spots: road sides + settlements ---- */
  world.vehicleSpots = [];
  const clearFor = (x, z) => !occupied(x, z, 3.2) && world.terrain.slopeAt(x, z) > 0.9 && Math.abs(x) < lim - 10 && Math.abs(z) < lim - 10;
  for (const r of world.roads) {
    const L = Math.hypot(r.bx - r.ax, r.bz - r.az), dx = (r.bx - r.ax) / L, dz = (r.bz - r.az) / L;
    for (let d = 30; d < L - 20; d += 70) {
      const side = (Math.round(d / 70) % 2) ? 1 : -1;
      const x = r.ax + dx * d - dz * side * (r.w / 2 + 2.5), z = r.az + dz * d + dx * side * (r.w / 2 + 2.5);
      if (clearFor(x, z)) world.vehicleSpots.push({ x, z, yaw: Math.atan2(-dx, -dz) });
    }
  }
  for (const Lc of world.locations) {
    for (let k = 0; k < 8; k++) {
      const a = rng.range(0, 6.28), rr = rng.range(10, 30), x = Lc.x + Math.cos(a) * rr, z = Lc.z + Math.sin(a) * rr;
      if (clearFor(x, z)) { world.vehicleSpots.push({ x, z, yaw: rng.range(-3.1, 3.1) }); break; }
    }
  }
  return world;
}

function nearSite(sites, x, z, pad) {
  for (const k in sites) {
    const s = sites[k];
    if (Math.hypot(x - s.x, z - s.z) < s.r + pad) return true;
  }
  return false;
}
