/* =============================================================================
   small math helpers shared by client and server.  no dependencies.
   ========================================================================== */

export const TAU = Math.PI * 2;

export function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function invLerp(a, b, v) { return b === a ? 0 : (v - a) / (b - a); }
export function smoothstep(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
export function rnd(a = 1, b) { return b === undefined ? Math.random() * a : a + Math.random() * (b - a); }
export function rndInt(a, b) { return Math.floor(rnd(a, b + 1)); }
export function pick(list) { return list[(Math.random() * list.length) | 0]; }
export function sign(v) { return v < 0 ? -1 : (v > 0 ? 1 : 0); }

/* frame-rate independent approach: pulls `a` toward `b`, `rate` is per second */
export function damp(a, b, rate, dt) { return b + (a - b) * Math.exp(-rate * dt); }

/* shortest signed difference between two angles */
export function angleDelta(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}
export function angleApproach(a, b, maxStep) {
  const d = angleDelta(a, b);
  return a + clamp(d, -maxStep, maxStep);
}

export function dist2(ax, az, bx, bz) { return Math.hypot(bx - ax, bz - az); }
export function dist3(ax, ay, az, bx, by, bz) { return Math.hypot(bx - ax, by - ay, bz - az); }

/* a yaw/pitch pair as a unit direction.  yaw 0 looks toward -Z, matching the camera. */
export function dirFromAngles(yaw, pitch, out = { x: 0, y: 0, z: 0 }) {
  const cp = Math.cos(pitch);
  out.x = -Math.sin(yaw) * cp;
  out.y = Math.sin(pitch);
  out.z = -Math.cos(yaw) * cp;
  return out;
}
export function yawFromDir(x, z) { return Math.atan2(-x, -z); }

export function normalize3(v) {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  v.x /= l; v.y /= l; v.z /= l;
  return v;
}

/* deterministic little RNG so bots and effects can be seeded when needed */
export function makeRng(seed = 1) {
  let s = seed >>> 0 || 1;
  return function next() {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/* distance from point p to the infinite ray (o, d unit).  d must be normalised. */
export function rayPointDistance(ox, oy, oz, dx, dy, dz, px, py, pz) {
  const vx = px - ox, vy = py - oy, vz = pz - oz;
  const along = vx * dx + vy * dy + vz * dz;
  if (along <= 0) return { along: 0, off: Math.hypot(vx, vy, vz) };
  const cx = vx - dx * along, cy = vy - dy * along, cz = vz - dz * along;
  return { along, off: Math.hypot(cx, cy, cz) };
}

export function round2(v) { return Math.round(v * 100) / 100; }
export function round3(v) { return Math.round(v * 1000) / 1000; }
