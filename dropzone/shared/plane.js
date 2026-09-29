/* =========================================================================
   Transport plane + skydive.
   The plane crosses the island on a random straight line.  Everyone starts
   on board and jumps whenever they like; after a short free fall the
   parachute opens (automatically near the ground, or by pressing jump).
     plane -> fall (fast, steerable, dive by looking down) -> chute -> ground
   ========================================================================= */
import { clamp } from './util.js';
import { MOVE } from './movement.js';

export const PLANE = {
  speed: 22,            // m/s  (a pass over the island takes ~40 s)
  alt: 190,             // flight altitude (m)
  fallGlide: 26,        // max horizontal speed in free fall, level body
  fallDiveGlide: 14,    // ... when diving straight down
  fallVy: 30,           // sink speed, level body
  fallDiveVy: 56,       // sink speed, full dive
  chuteAuto: 55,        // parachute opens automatically this high above the ground
  chuteMinManual: 20,   // can't open it lower than this by hand (it's already open by then)
  chuteGlide: 12,
  chuteVy: 5.5, chuteVyFast: 7.5, chuteVySlow: 4.2
};

export class Plane {
  constructor(rng, limit) {
    const a = rng.next() * Math.PI * 2;
    const dx = Math.cos(a), dz = Math.sin(a);
    // pass near the centre, never exactly through it
    const off = (rng.next() * 2 - 1) * limit * 0.35;
    const cx = -dz * off, cz = dx * off;
    const L = limit * 1.5;
    this.ax = cx - dx * L; this.az = cz - dz * L;
    this.bx = cx + dx * L; this.bz = cz + dz * L;
    this.dx = dx; this.dz = dz;
    this.len = L * 2;
    this.limit = limit;
    this.d = 0;                // distance flown
    this.alt = PLANE.alt;
    this.inside = false;       // over the island (jumping allowed)
    this.done = false;         // everybody is out, plane left
    this.x = this.ax; this.z = this.az;
  }
  get yaw() { return Math.atan2(-this.dx, -this.dz); }
  /** point on the path closest to (x, z) as distance along the path */
  project(x, z) { return clamp((x - this.ax) * this.dx + (z - this.az) * this.dz, 0, this.len); }
  pointAt(d) { return { x: this.ax + this.dx * d, z: this.az + this.dz * d }; }

  /** returns 'enter' | 'leave' | null */
  update(dt) {
    this.d += PLANE.speed * dt;
    this.x = this.ax + this.dx * this.d; this.z = this.az + this.dz * this.d;
    const lim = this.limit - 8;
    const over = Math.abs(this.x) < lim && Math.abs(this.z) < lim;
    if (over && !this.inside) { this.inside = true; return 'enter'; }
    if (!over && this.inside) { this.inside = false; this.left = true; return 'leave'; }
    if (this.d >= this.len) this.done = true;
    return null;
  }
}

/**
 * one step of skydiving.  input: {fwd, right, yaw, pitch}
 * returns {landed: impactSpeed} when touching down
 */
export function stepAir(world, b, input, dt, mode) {
  const ev = {};
  const P = PLANE;
  let f = clamp(input.fwd || 0, -1, 1), r = clamp(input.right || 0, -1, 1);
  const l = Math.hypot(f, r);
  if (l > 1) { f /= l; r /= l; }
  const sy = Math.sin(input.yaw || 0), cy = Math.cos(input.yaw || 0);
  const wx = -sy * f + cy * r, wz = -cy * f - sy * r;
  let maxH, tvy, acc;
  if (mode === 'fall') {
    const dive = clamp(-(input.pitch || 0) * 1.4, 0, 1);            // look down to dive
    maxH = P.fallGlide + (P.fallDiveGlide - P.fallGlide) * dive;
    tvy = -(P.fallVy + (P.fallDiveVy - P.fallVy) * dive * Math.max(0.35, f));
    acc = 10;
  } else {
    maxH = P.chuteGlide;
    tvy = -(f > 0.3 ? P.chuteVyFast : f < -0.3 ? P.chuteVySlow : P.chuteVy);
    acc = 5;
  }
  const tvx = wx * maxH, tvz = wz * maxH;
  const dvx = tvx - b.vel.x, dvz = tvz - b.vel.z, dv = Math.hypot(dvx, dvz);
  if (dv > 0) { const k = Math.min(dv, acc * dt) / dv; b.vel.x += dvx * k; b.vel.z += dvz * k; }
  b.vel.y += clamp(tvy - b.vel.y, -25 * dt, 25 * dt);

  // horizontal move, blocked by walls / map boundary
  const R = MOVE.radius.stand, H = MOVE.height.stand;
  const nx = b.pos.x + b.vel.x * dt;
  if (!world.overlaps(nx, b.pos.z, R, b.pos.y + 0.05, b.pos.y + H)) b.pos.x = nx; else b.vel.x = 0;
  const nz = b.pos.z + b.vel.z * dt;
  if (!world.overlaps(b.pos.x, nz, R, b.pos.y + 0.05, b.pos.y + H)) b.pos.z = nz; else b.vel.z = 0;

  const ground = world.supportHeight(b.pos.x, b.pos.z, R * 0.8, b.pos.y + 0.02, 0);
  const ny = b.pos.y + b.vel.y * dt;
  if (ny <= ground) {
    ev.landed = -b.vel.y;
    b.pos.y = ground;
    // touched down against a tree / wall: slide out to the nearest free spot
    if (world.overlaps(b.pos.x, b.pos.z, R, ground + 0.05, ground + H)) {
      search: for (let rr = 0.3; rr <= 2.4; rr += 0.3) {
        for (let k = 0; k < 12; k++) {
          const a = (k / 12) * Math.PI * 2, x = b.pos.x + Math.cos(a) * rr, z = b.pos.z + Math.sin(a) * rr;
          const g2 = world.supportHeight(x, z, R * 0.8, ground + 0.5, 0);
          if (!world.overlaps(x, z, R, g2 + 0.05, g2 + H)) { b.pos.x = x; b.pos.z = z; b.pos.y = g2; break search; }
        }
      }
    }
    b.vel.y = 0; b.vel.x *= 0.4; b.vel.z *= 0.4;
    b.onGround = true;
    b.stance = 'stand'; b.stanceLock = 0; b.airTime = 0;
  } else { b.pos.y = ny; b.onGround = false; }
  b.moveSpeed = Math.hypot(b.vel.x, b.vel.z);
  ev.height = b.pos.y - ground;
  return ev;
}
