/* =============================================================================
   movement.  ground friction, air control, step-up, crouch smoothing and the
   dash override all live here; the player, bots and summons share it.
   ========================================================================== */
import { RULES } from '../game/rules.js';
import { clamp } from '../core/math.js';

export function stepFighter(world, f, dt, wish, now, hooks = {}) {
  const c = f.char;
  const speed = f.currentSpeed(now);
  const dashing = now < f.dashUntil;

  if (dashing) {
    f.vel.x = f.dashDir.x * f.dashSpeed;
    f.vel.z = f.dashDir.z * f.dashSpeed;
    if (f.dashKind === 'blink') { f.vel.y = Math.max(f.vel.y, 0); }
  } else {
    let wx = wish.x, wz = wish.z;
    const wl = Math.hypot(wx, wz);
    if (wl > 1) { wx /= wl; wz /= wl; }
    const accel = (f.onGround ? c.accel : c.airAccel) * (f.onGround ? 1 : RULES.airControl * 2.2);
    const tx = wx * speed, tz = wz * speed;
    f.vel.x += clamp(tx - f.vel.x, -accel * dt, accel * dt);
    f.vel.z += clamp(tz - f.vel.z, -accel * dt, accel * dt);
    if (f.onGround && wl < 0.01) {
      const fr = Math.max(0, 1 - 12 * dt);
      f.vel.x *= fr; f.vel.z *= fr;
    }
  }

  // an outside pull (lure well) nudges the velocity rather than the position,
  // so players can still fight it by running the other way
  if (f.pullVec) {
    f.vel.x += f.pullVec.x * dt;
    f.vel.z += f.pullVec.z * dt;
    f.pullVec = null;
  }

  if (wish.jump && f.onGround && !dashing && now > f.castUntil) {
    f.vel.y = c.jump;
    f.onGround = false;
    hooks.onJump?.(f);
  }

  f.vel.y -= RULES.gravity * dt;
  if (f.vel.y < -RULES.maxFall) f.vel.y = -RULES.maxFall;

  world.moveXZ(f, f.vel.x * dt, f.vel.z * dt);

  f.pos.y += f.vel.y * dt;
  const ground = world.supportAt(f.pos.x, f.pos.z, f.pos.y + 0.34, f.radius * 0.85);
  f.wasGround = f.onGround;
  if (f.pos.y <= ground + 0.001 && f.vel.y <= 0) {
    if (!f.onGround) hooks.onLand?.(f, -f.vel.y);
    f.pos.y = ground;
    f.vel.y = 0;
    f.onGround = true;
  } else {
    f.onGround = false;
    const head = world.blockedAt(f.pos.x, f.pos.z, f.radius * 0.7, f.pos.y + f.height - 0.12, f.pos.y + f.height);
    if (head > 0 && f.vel.y > 0) f.vel.y = 0;
  }
  if (f.pos.y < -6) { f.pos.y = world.groundAt(f.pos.x, f.pos.z); f.vel.x = f.vel.y = f.vel.z = 0; }

  // crouch height eases so the camera does not snap
  const want = f.crouch ? RULES.crouchHeight : RULES.standHeight;
  if (f.height !== want) {
    if (want > f.height) {
      if (world.blockedAt(f.pos.x, f.pos.z, f.radius, f.pos.y + f.height, f.pos.y + want) < 0)
        f.height = Math.min(want, f.height + dt * 6.5);
    } else {
      f.height = Math.max(want, f.height - dt * 7.5);
    }
  }
}

/* moves a simple point entity (summons, decoys) with gravity and wall sliding */
export function stepSimple(world, e, dt) {
  e.vel.y -= RULES.gravity * dt;
  world.moveXZ(e, e.vel.x * dt, e.vel.z * dt);
  e.pos.y += e.vel.y * dt;
  const g = world.supportAt(e.pos.x, e.pos.z, e.pos.y + 0.3, e.radius * 0.8);
  if (e.pos.y <= g + 0.001 && e.vel.y <= 0) { e.pos.y = g; e.vel.y = 0; e.onGround = true; }
  else e.onGround = false;
}
