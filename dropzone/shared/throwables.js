/* =========================================================================
   Throwables (original designs): frag, smoke, flash, incendiary.
   Physics is shared so the client's trajectory preview matches the sim.
   ========================================================================= */

export const THROWABLES = {
  frag: { name: 'HX-3 파편 수류탄', short: '파편', fuse: 3.2, radius: 7.5, damage: 120, color: '#5d6b45' },
  smoke: { name: 'FOG-6 연막탄', short: '연막', fuse: 1.8, smokeR: 7, smokeT: 24, color: '#9aa3a8' },
  flash: { name: 'LUX 섬광탄', short: '섬광', fuse: 1.7, flashR: 24, blind: 4.5, color: '#d9d2b0' },
  molotov: { name: 'BLAZE 화염병', short: '화염', fuse: 4, impact: true, fireR: 4.2, fireT: 9, dps: 14, color: '#b8552e' }
};
export const THROW_ORDER = ['frag', 'smoke', 'flash', 'molotov'];
export const THROW_SPEED = { far: 20, near: 10 };      // m/s: normal throw / short lob (aim button)
const GRAV = 9.81, BOUNCE = 0.34, FRICTION = 0.72, R = 0.08;

/** initial position + velocity for a throw from eye position along aim */
export function throwLaunch(eye, yaw, pitch, lob, bodyVel) {
  const cp = Math.cos(pitch);
  const dx = -Math.sin(yaw) * cp, dy = Math.sin(pitch), dz = -Math.cos(yaw) * cp;
  const sp = lob ? THROW_SPEED.near : THROW_SPEED.far;
  // start a little in front of the face so it never spawns inside the thrower
  return {
    x: eye.x + dx * 0.45 + Math.cos(yaw) * 0.18, y: eye.y + dy * 0.45 - 0.05, z: eye.z + dz * 0.45 - Math.sin(yaw) * 0.18,
    vx: dx * sp + (bodyVel ? bodyVel.x * 0.5 : 0), vy: dy * sp + 2.2, vz: dz * sp + (bodyVel ? bodyVel.z * 0.5 : 0)
  };
}

/**
 * advance one projectile by dt with bounces.  returns 'hit' on first contact
 * (for impact grenades), 'rest' when it stopped, or null.
 */
export function stepProjectile(world, g, dt) {
  if (g.rest) return null;
  let ev = null;
  let remaining = dt;
  for (let iter = 0; iter < 3 && remaining > 1e-5; iter++) {
    g.vy -= GRAV * remaining;
    const sx = g.vx * remaining, sy = g.vy * remaining, sz = g.vz * remaining;
    const L = Math.hypot(sx, sy, sz);
    if (L < 1e-6) break;
    const h = world.raycast(g.x, g.y, g.z, sx / L, sy / L, sz / L, L + R);
    if (!h) { g.x += sx; g.y += sy; g.z += sz; break; }
    const t = Math.max(0, h.t - R);
    g.x += sx / L * t; g.y += sy / L * t; g.z += sz / L * t;
    // reflect with energy loss
    const vn = g.vx * h.nx + g.vy * h.ny + g.vz * h.nz;
    g.vx -= (1 + BOUNCE) * vn * h.nx; g.vy -= (1 + BOUNCE) * vn * h.ny; g.vz -= (1 + BOUNCE) * vn * h.nz;
    g.vx *= FRICTION; g.vz *= FRICTION;
    if (!ev) ev = 'hit';
    g.bounces = (g.bounces || 0) + 1;
    if (h.ny > 0.6 && Math.hypot(g.vx, g.vy, g.vz) < 1.4) {
      g.rest = true; g.vx = g.vy = g.vz = 0;
      g.y = h.y + R;
      return ev === 'hit' ? 'hit' : 'rest';
    }
    remaining -= remaining * (t / Math.max(L, 1e-6));
  }
  // safety: never below the terrain
  const tg = world.groundAt(g.x, g.z) + R;
  if (g.y <= tg + 0.002) {
    if (g.vy < -1.5) { if (!ev) ev = 'hit'; g.vx *= 0.6; g.vz *= 0.6; }    // impact eats speed
    g.y = tg;
    if (g.vy < 0) g.vy = -g.vy * BOUNCE;
    // rolling on the ground: friction slows it down and it comes to rest
    const k = Math.exp(-6 * dt);
    g.vx *= k; g.vz *= k;
    if (Math.hypot(g.vx, g.vz) < 0.6 && Math.abs(g.vy) < 1) { g.rest = true; g.vx = g.vy = g.vz = 0; }
  }
  return ev;
}

/** predicted path for the client preview (same physics) */
export function predictThrow(world, launch, seconds = 3, step = 1 / 30) {
  const g = { ...launch };
  const pts = [{ x: g.x, y: g.y, z: g.z }];
  for (let t = 0; t < seconds && !g.rest; t += step) {
    const ev = stepProjectile(world, g, step);
    pts.push({ x: g.x, y: g.y, z: g.z });
    if (ev === 'hit' && launch.stopOnHit) break;
  }
  return pts;
}

/** ballistic pitch to hit a point at horizontal distance d and height dy (low arc), or null */
export function solvePitch(d, dy, speed) {
  const v2 = speed * speed, g = GRAV;
  const disc = v2 * v2 - g * (g * d * d + 2 * dy * v2);
  if (disc < 0) return null;
  return Math.atan((v2 - Math.sqrt(disc)) / (g * d));
}

/** does the segment a->b pass through any smoke cloud? */
export function smokeBlocks(smokes, ax, ay, az, bx, by, bz) {
  for (const s of smokes) {
    if (s.r < 1.5) continue;
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const L2 = dx * dx + dy * dy + dz * dz;
    let t = L2 > 0 ? ((s.x - ax) * dx + (s.y - ay) * dy + (s.z - az) * dz) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = ax + dx * t - s.x, py = ay + dy * t - s.y, pz = az + dz * t - s.z;
    if (px * px + py * py * 2.2 + pz * pz < s.r * s.r * 0.8) return true;
  }
  return false;
}
