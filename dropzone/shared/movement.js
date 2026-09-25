/* =========================================================================
   Character movement controller (shared by player, bots and later the server
   for prediction / reconciliation).  Pure function of (state, input, dt).
   ========================================================================= */
import { clamp } from './util.js';

export const MOVE = {
  gravity: 20,
  jumpVel: 6.4,              // ~1.0 m jump
  step: 0.45,                // auto step-up height (stairs, curbs, crate edges mid-air)
  snapDown: 0.55,            // stick to ground when walking down stairs / slopes
  accelGround: 42,
  decelGround: 34,
  accelAir: 7,
  speed: { run: 5.2, sprint: 6.7, walk: 2.1, crouch: 2.6, prone: 1.15 },
  backMul: 0.72, strafeMul: 0.9,
  adsMul: { stand: 0.62, crouch: 0.8, prone: 1.0 },
  useItemMul: 0.4,
  height: { stand: 1.8, crouch: 1.25, prone: 0.6 },
  eye: { stand: 1.62, crouch: 1.08, prone: 0.38 },
  radius: { stand: 0.32, crouch: 0.32, prone: 0.42 },
  stanceTime: { stand: 0.18, crouch: 0.16, prone: 0.55 },
  fallSafe: 12.5,            // impact speed (m/s) before fall damage
  fallDmg: 7.5               // damage per m/s above fallSafe
};

export function newBody(x, y, z) {
  return {
    pos: { x, y, z }, vel: { x: 0, y: 0, z: 0 },
    onGround: true, stance: 'stand', stanceLock: 0, sprinting: false,
    airTime: 0, landT: 0, lastImpact: 0, moveSpeed: 0, jumpCd: 0
  };
}

export function bodyHeight(b) { return MOVE.height[b.stance]; }
export function bodyRadius(b) { return MOVE.radius[b.stance]; }
export function eyeHeight(b) { return MOVE.eye[b.stance]; }

/**
 * a prone body is ~1.9 m long, far longer than its collision cylinder: check the
 * head end and the feet end too, so heads never poke through walls (and can't be
 * shot from the other side).  Low steps/curbs under 0.3 m are ignored.
 */
export function proneFits(world, x, z, y, yaw) {
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  for (const k of [0.8, -0.78]) {
    if (world.overlaps(x + fx * k, z + fz * k, 0.2, y + 0.3, y + 0.55)) return false;
  }
  return true;
}

/** can the body occupy `stance` at its current position? */
export function stanceFits(world, b, stance, yaw = 0) {
  const r = MOVE.radius[stance], h = MOVE.height[stance];
  if (world.overlaps(b.pos.x, b.pos.z, r, b.pos.y + 0.05, b.pos.y + h)) return false;
  return stance !== 'prone' || proneFits(world, b.pos.x, b.pos.z, b.pos.y, yaw);
}

/** request a stance change. returns true when it happened */
export function setStance(world, b, stance, yaw = 0) {
  if (b.stance === stance) return false;
  if (b.stanceLock > 0) return false;
  if (!b.onGround && stance === 'prone') return false;
  if (!stanceFits(world, b, stance, yaw)) return false;
  b.stanceLock = MOVE.stanceTime[stance === 'stand' ? b.stance : stance];
  b.stance = stance;
  return true;
}

/**
 * @param world
 * @param b     body
 * @param input { fwd:-1..1, right:-1..1, yaw, sprint, walk, jump(edge), ads, usingItem, moveMul }
 * @param dt
 * @returns events {landed:impactSpeed, jumped:true, fallDamage:n}
 */
export function stepBody(world, b, input, dt) {
  const ev = {};
  if (b.stanceLock > 0) b.stanceLock = Math.max(0, b.stanceLock - dt);
  if (b.jumpCd > 0) b.jumpCd -= dt;
  if (b.landT > 0) b.landT -= dt;

  // ---- wish direction ----
  let f = clamp(input.fwd || 0, -1, 1), r = clamp(input.right || 0, -1, 1);
  const len = Math.hypot(f, r);
  if (len > 1) { f /= len; r /= len; }
  const mag = Math.min(1, len);

  // sprint only when mostly moving forward, standing, not aiming, not using items
  const wantSprint = !!input.sprint && f > 0.55 && !input.ads && !input.usingItem;
  if (wantSprint && b.stance !== 'stand' && b.onGround && b.stanceLock <= 0) {
    // sprinting from crouch/prone stands you up if there is room
    setStance(world, b, 'stand');
  }
  b.sprinting = wantSprint && b.stance === 'stand' && b.stanceLock <= 0;

  let base;
  if (b.stance === 'prone') base = MOVE.speed.prone;
  else if (b.stance === 'crouch') base = MOVE.speed.crouch;
  else if (b.sprinting) base = MOVE.speed.sprint;
  else if (input.walk) base = MOVE.speed.walk;
  else base = MOVE.speed.run;

  // direction penalties (backpedal / strafe)
  const fwdPart = f < 0 ? MOVE.backMul : 1;
  const dirMul = len > 0 ? (Math.abs(f) * fwdPart + Math.abs(r) * MOVE.strafeMul) / (Math.abs(f) + Math.abs(r)) : 1;
  let speed = base * dirMul * mag * (input.moveMul || 1);
  if (input.ads && !b.sprinting) speed *= MOVE.adsMul[b.stance];
  if (input.usingItem) speed *= MOVE.useItemMul;
  if (b.landT > 0) speed *= 0.55;
  if (b.stanceLock > 0 && b.stance === 'prone') speed *= 0.2;

  // yaw 0 faces -Z; right vector is +X at yaw 0
  const sy = Math.sin(input.yaw || 0), cy = Math.cos(input.yaw || 0);
  let wx = 0, wz = 0;
  if (len > 0.001) {
    const nf = f / Math.max(len, 1e-6), nr = r / Math.max(len, 1e-6);
    wx = (-sy * nf + cy * nr);
    wz = (-cy * nf - sy * nr);
  }
  const tvx = wx * speed, tvz = wz * speed;

  // ---- accelerate horizontal velocity ----
  const accel = b.onGround ? (speed > 0.01 ? MOVE.accelGround : MOVE.decelGround) : MOVE.accelAir;
  const dvx = tvx - b.vel.x, dvz = tvz - b.vel.z;
  const dv = Math.hypot(dvx, dvz);
  if (dv > 0) {
    const s = Math.min(dv, accel * dt) / dv;
    if (b.onGround || speed > 0.01) { b.vel.x += dvx * s; b.vel.z += dvz * s; }
  }

  // ---- jump ----
  if (input.jump && b.onGround && b.jumpCd <= 0 && b.stanceLock <= 0) {
    ev.jumpUsed = true;
    if (b.stance !== 'stand') {
      setStance(world, b, 'stand');               // first press stands you up
    } else {
      b.vel.y = MOVE.jumpVel;
      b.onGround = false;
      b.jumpCd = 0.35;
      ev.jumped = true;
    }
  }

  // ---- horizontal move with collision + step up ----
  moveAxis(world, b, b.vel.x * dt, 0, ev, input.yaw || 0);
  moveAxis(world, b, 0, b.vel.z * dt, ev, input.yaw || 0);

  // ---- vertical ----
  const h = MOVE.height[b.stance], rad = MOVE.radius[b.stance];
  if (!b.onGround) b.vel.y -= MOVE.gravity * dt;
  const newY = b.pos.y + b.vel.y * dt;
  if (b.vel.y > 0) {
    // ceiling
    if (world.overlaps(b.pos.x, b.pos.z, rad, b.pos.y + h, newY + h)) b.vel.y = 0;
    else b.pos.y = newY;
    b.airTime += dt;
  } else {
    const ground = world.supportHeight(b.pos.x, b.pos.z, rad * 0.8, b.pos.y + 0.02, 0);
    if (b.onGround) {
      // walking: follow ground up to snapDown below
      if (b.pos.y - ground <= MOVE.snapDown && ground <= b.pos.y + 0.02) {
        b.pos.y = ground; b.vel.y = 0;
      } else if (ground > b.pos.y) {
        b.pos.y = ground; b.vel.y = 0;             // terrain rose under us
      } else {
        b.onGround = false; b.airTime = 0;
        b.pos.y = newY;
      }
    } else {
      b.airTime += dt;
      if (newY <= ground) {
        const impact = -b.vel.y;
        b.pos.y = ground; b.vel.y = 0; b.onGround = true;
        ev.landed = impact;
        if (impact > 9) b.landT = 0.12 + Math.min(0.3, (impact - 9) * 0.03);
        if (impact > MOVE.fallSafe) ev.fallDamage = (impact - MOVE.fallSafe) * MOVE.fallDmg;
        b.airTime = 0;
      } else b.pos.y = newY;
    }
    // terrain is always a floor (never fall through it)
    const tg = world.groundAt(b.pos.x, b.pos.z);
    if (b.pos.y < tg) { b.pos.y = tg; if (!b.onGround) { b.onGround = true; ev.landed = ev.landed || 0; } b.vel.y = 0; }
  }
  b.moveSpeed = Math.hypot(b.vel.x, b.vel.z);
  return ev;
}

function moveAxis(world, b, dx, dz, ev, yaw) {
  if (dx === 0 && dz === 0) return;
  const r = MOVE.radius[b.stance], h = MOVE.height[b.stance];
  const nx = b.pos.x + dx, nz = b.pos.z + dz;
  const y = b.pos.y;
  if (b.stance === 'prone' && !proneFits(world, nx, nz, y, yaw)) {
    if (dx !== 0) b.vel.x = 0;
    if (dz !== 0) b.vel.z = 0;
    return;
  }
  if (!world.overlaps(nx, nz, r, y + 0.02, y + h)) { b.pos.x = nx; b.pos.z = nz; return; }
  // try stepping up (works mid-air too: acts like a small mantle)
  const top = world.supportHeight(nx, nz, r, y, MOVE.step);
  if (top > y && top - y <= MOVE.step && !world.overlaps(nx, nz, r, top + 0.02, top + h) &&
      !world.overlaps(b.pos.x, b.pos.z, r, y + h, top + h + 0.02)) {
    b.pos.x = nx; b.pos.z = nz; b.pos.y = top;
    if (!b.onGround) { b.onGround = true; b.vel.y = Math.max(0, b.vel.y) * 0; ev.stepped = true; }
    return;
  }
  // blocked: kill velocity on this axis
  if (dx !== 0) b.vel.x = 0;
  if (dz !== 0) b.vel.z = 0;
}
