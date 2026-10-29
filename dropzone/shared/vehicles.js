/* =========================================================================
   Vehicles (original designs): arcade driving model shared by client and
   server.  A vehicle is an oriented box that follows the ground, steers
   like a bicycle model, burns fuel, takes damage and can be destroyed.
   ========================================================================= */
import { clamp, wrapAngle } from './util.js';

/* seats: [x (right), z (back), y] in vehicle space, seat 0 = driver */
export const VEHICLES = {
  sedan: {
    name: 'RIVA 4D', cat: '세단', len: 4.4, wid: 1.8, hgt: 1.45, bodyH: 0.85,
    seats: [[-0.42, -0.1, 0.35], [0.42, -0.1, 0.35], [-0.42, 0.85, 0.35], [0.42, 0.85, 0.35]],
    maxSpeed: 29, accel: 7.5, brake: 16, reverse: 8, turn: 1.9, hp: 140, offroad: 0.72, fuelUse: 0.03, weight: 1
  },
  suv: {
    name: 'TUNDRA SUV', cat: 'SUV', len: 4.8, wid: 2.0, hgt: 1.85, bodyH: 1.05,
    seats: [[-0.45, -0.2, 0.55], [0.45, -0.2, 0.55], [-0.45, 0.9, 0.55], [0.45, 0.9, 0.55]],
    maxSpeed: 26, accel: 6.5, brake: 15, reverse: 7, turn: 1.7, hp: 220, offroad: 0.92, fuelUse: 0.036, weight: 1.4
  },
  moto: {
    name: 'KITE 250', cat: '오토바이', len: 2.1, wid: 0.75, hgt: 1.15, bodyH: 0.75,
    seats: [[0, 0.05, 0.55], [0, 0.55, 0.62]],
    maxSpeed: 36, accel: 11, brake: 18, reverse: 4, turn: 2.6, hp: 80, offroad: 0.82, fuelUse: 0.018, weight: 0.4, open: true
  },
  buggy: {
    name: 'DUNE BUGGY', cat: '오프로드', len: 3.4, wid: 1.8, hgt: 1.45, bodyH: 0.7,
    seats: [[-0.4, 0.1, 0.35], [0.4, 0.1, 0.35]],
    maxSpeed: 31, accel: 9.5, brake: 16, reverse: 7, turn: 2.2, hp: 110, offroad: 1.0, fuelUse: 0.028, weight: 0.8, open: true
  }
};
export const VEHICLE_TYPES = ['sedan', 'sedan', 'suv', 'moto', 'moto', 'buggy'];

export function newVehicle(id, type, x, y, z, yaw, fuel) {
  const D = VEHICLES[type];
  return {
    id, type, x, y, z, yaw, speed: 0, vy: 0, steer: 0, pitch: 0, roll: 0,
    hp: D.hp, fuel, dead: false, burnT: 0, seats: new Array(D.seats.length).fill(null),
    onGround: true, lastHitBy: null
  };
}

/** local (right, back) -> world offset for a vehicle yaw */
export function vehToWorld(v, lx, lz) {
  const c = Math.cos(v.yaw), s = Math.sin(v.yaw);
  return { x: v.x + lx * c + lz * s, z: v.z - lx * s + lz * c };
}
/** world -> local (right, back) */
export function worldToVeh(v, x, z) {
  const c = Math.cos(v.yaw), s = Math.sin(v.yaw), dx = x - v.x, dz = z - v.z;
  return { x: dx * c - dz * s, z: dx * s + dz * c };
}
/** collision circles along the length of the vehicle */
export function vehCircles(v, x = v.x, z = v.z, yaw = v.yaw) {
  const D = VEHICLES[v.type];
  const r = D.wid / 2;
  const n = Math.max(1, Math.ceil(D.len / D.wid));
  const out = [];
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : -D.len / 2 + r + (i / (n - 1)) * (D.len - 2 * r);
    out.push({ x: x + fx * t, z: z + fz * t, r });
  }
  return out;
}
/** distance from a point to the vehicle's footprint (0 when inside) */
export function vehDistance(v, x, z) {
  const D = VEHICLES[v.type], l = worldToVeh(v, x, z);
  const dx = Math.max(0, Math.abs(l.x) - D.wid / 2), dz = Math.max(0, Math.abs(l.z) - D.len / 2);
  return Math.hypot(dx, dz);
}
/** ray vs the vehicle's lower body box. returns t or -1 */
export function rayVehicle(v, ox, oy, oz, dx, dy, dz, maxT) {
  const D = VEHICLES[v.type];
  const c = Math.cos(v.yaw), s = Math.sin(v.yaw);
  const lx0 = (ox - v.x) * c - (oz - v.z) * s, lz0 = (ox - v.x) * s + (oz - v.z) * c, ly0 = oy - v.y;
  const ldx = dx * c - dz * s, ldz = dx * s + dz * c;
  // windows above the body line stay open, so occupants can be shot
  const b = [-D.wid / 2, 0.25, -D.len / 2, D.wid / 2, D.bodyH, D.len / 2];
  let t0 = 0, t1 = maxT;
  const o = [lx0, ly0, lz0], d = [ldx, dy, ldz];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-9) { if (o[a] < b[a] || o[a] > b[a + 3]) return -1; continue; }
    let ta = (b[a] - o[a]) / d[a], tb = (b[a + 3] - o[a]) / d[a];
    if (ta > tb) { const q = ta; ta = tb; tb = q; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return -1;
  }
  return t0;
}

function blocked(world, v, x, z, yaw, y) {
  const D = VEHICLES[v.type];
  for (const c of vehCircles(v, x, z, yaw)) {
    // low things (curbs, floor slabs, the ground) are driven over
    if (world.overlapsStatic(c.x, c.z, c.r * 0.92, y + 0.5, y + D.hgt)) return true;
  }
  return false;
}

/**
 * @param input {throttle -1..1, steer -1..1 (+ = right), handbrake, boost}
 * @returns events {crash: impactSpeed, landed: v}
 */
export function stepVehicle(world, v, input, dt, onRoad) {
  const D = VEHICLES[v.type];
  const ev = {};
  let thr = clamp(input.throttle || 0, -1, 1);
  if (v.dead || v.fuel <= 0) thr = 0;
  const max = D.maxSpeed * (onRoad ? 1 : D.offroad) * (input.boost ? 1.12 : 1);
  // ---- longitudinal ----
  if (thr > 0) {
    if (v.speed < -0.3) v.speed = Math.min(0, v.speed + D.brake * dt);
    else v.speed += D.accel * thr * (input.boost ? 1.35 : 1) * Math.max(0.05, 1 - v.speed / max) * dt;
  } else if (thr < 0) {
    if (v.speed > 0.3) v.speed = Math.max(0, v.speed - D.brake * dt);
    else v.speed = Math.max(-D.reverse, v.speed - D.accel * 0.7 * dt);
  } else {
    const roll = (onRoad ? 1.2 : 3) * dt;
    v.speed = Math.abs(v.speed) < roll ? 0 : v.speed - Math.sign(v.speed) * roll;
  }
  if (v.speed > max) v.speed = Math.max(max, v.speed - 6 * dt);          // off-road drag
  v.speed -= v.speed * 0.05 * dt;
  if (input.handbrake) { const hb = 11 * dt; v.speed = Math.abs(v.speed) < hb ? 0 : v.speed - Math.sign(v.speed) * hb; }
  // slopes: gravity along the body
  v.speed -= 9.8 * Math.sin(v.pitch) * dt * 0.7;
  // fuel
  if (thr !== 0 && !v.dead) v.fuel = Math.max(0, v.fuel - Math.abs(v.speed) * D.fuelUse * dt * (input.boost ? 1.6 : 1) - 0.01 * dt);

  // ---- steering (bicycle-ish; tighter at low speed, drifty with the handbrake) ----
  v.steer += (clamp(input.steer || 0, -1, 1) - v.steer) * Math.min(1, dt * 6);
  const sp = Math.abs(v.speed);
  const yawRate = -v.steer * D.turn * clamp(v.speed / 5, -1, 1) * (1 - 0.45 * Math.min(1, sp / D.maxSpeed)) * (input.handbrake ? 1.6 : 1);
  const newYaw = wrapAngle(v.yaw + yawRate * dt);

  // ---- move + collide ----
  const fx = -Math.sin(newYaw), fz = -Math.cos(newYaw);
  const nx = v.x + fx * v.speed * dt, nz = v.z + fz * v.speed * dt;
  if (!blocked(world, v, nx, nz, newYaw, v.y)) { v.x = nx; v.z = nz; v.yaw = newYaw; }
  else if (!blocked(world, v, v.x, v.z, newYaw, v.y)) { v.yaw = newYaw; ev.crash = sp; v.speed *= -0.2; }
  else { ev.crash = sp; v.speed *= -0.25; }

  // ---- vertical: follow the ground, fly off ramps / cliffs ----
  const ground = world.supportHeight(v.x, v.z, Math.min(0.8, D.wid * 0.4), v.y, 0.6);
  if (v.y > ground + 0.08 && (v.vy > 0 || v.y - ground > 0.35 || !v.onGround)) {
    v.onGround = false;
    v.vy -= 20 * dt;
    v.y += v.vy * dt;
    if (v.y <= ground) { ev.landed = -v.vy; v.y = ground; v.vy = 0; v.onGround = true; }
  } else {
    const prevY = v.y;
    v.y = ground;
    // launched off a crest: keep the upward speed the slope gave us
    v.vy = v.onGround ? clamp((v.y - prevY) / Math.max(dt, 1e-4), -20, 12) : 0;
    v.onGround = true;
  }
  // body attitude from the terrain under the wheels (visual + slope force)
  const h = (lx, lz) => { const p = vehToWorld(v, lx, lz); return world.groundAt(p.x, p.z); };
  const hf = h(0, -D.len * 0.4), hb = h(0, D.len * 0.4), hl = h(-D.wid * 0.4, 0), hr = h(D.wid * 0.4, 0);
  const tp = Math.atan2(hf - hb, D.len * 0.8), tr = Math.atan2(hl - hr, D.wid * 0.8);
  v.pitch += (clamp(tp, -0.6, 0.6) - v.pitch) * Math.min(1, dt * 8);
  v.roll += (clamp(tr, -0.5, 0.5) - v.roll) * Math.min(1, dt * 8);
  return ev;
}
