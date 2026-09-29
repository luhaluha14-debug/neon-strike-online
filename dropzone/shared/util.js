/* =========================================================================
   Small math / random helpers shared by client, server and tests.
   Everything in /shared must stay free of DOM and three.js so the exact same
   code can run on the authoritative server later.
   ========================================================================= */

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function smoothstep(a, b, v) { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }

/** wrap an angle to [-PI, PI] */
export function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** move `cur` toward `tgt` by at most `step` */
export function approach(cur, tgt, step) {
  if (cur < tgt) return Math.min(cur + step, tgt);
  return Math.max(cur - step, tgt);
}

export function dist2D(ax, az, bx, bz) { const dx = ax - bx, dz = az - bz; return Math.sqrt(dx * dx + dz * dz); }
export function dist3(a, b) { const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z; return Math.sqrt(dx * dx + dy * dy + dz * dz); }

/** forward direction for yaw/pitch.  yaw 0 looks toward -Z (three.js camera convention) */
export function dirFromAngles(yaw, pitch, out = { x: 0, y: 0, z: 0 }) {
  const cp = Math.cos(pitch);
  out.x = -Math.sin(yaw) * cp;
  out.y = Math.sin(pitch);
  out.z = -Math.cos(yaw) * cp;
  return out;
}
export function anglesFromDir(dx, dy, dz) {
  const h = Math.sqrt(dx * dx + dz * dz);
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, h) };
}

/* ---------- deterministic random (mulberry32) ---------- */
export function makeRng(seed) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range(a, b) { return a + next() * (b - a); },
    int(a, b) { return Math.floor(a + next() * (b - a + 1)); },
    pick(arr) { return arr[Math.floor(next() * arr.length)]; },
    chance(p) { return next() < p; },
    get state() { return s; }
  };
}

/** hash a few ints into a seed (used for per-shot spread so client & server agree) */
export function hashInts(a, b = 0, c = 0) {
  let h = 2166136261 >>> 0;
  for (const v of [a, b, c]) {
    h ^= v & 0xffff; h = Math.imul(h, 16777619);
    h ^= (v >>> 16) & 0xffff; h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
