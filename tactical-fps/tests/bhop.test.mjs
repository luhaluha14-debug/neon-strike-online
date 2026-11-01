// Jumping, bunny hopping and air strafing (Node, the real PlayerController
// on a flat floor at y = 0, 120 Hz ticks): a normal jump, the jump buffer
// (pressed just before landing / too early / after landing), holding the key,
// speed kept by well-timed hops and lost by late ones, air strafing with the
// mouse versus keys alone, diminishing gains, the air speed limit, braking
// against the motion, air control from rest, falls keeping the original air
// control, and the ground speeds unchanged.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { ROOT } from './harness.mjs';

let vite;
let PlayerController;
let CFG;
let THREE;

before(async () => {
  vite = await createServer({ root: ROOT, logLevel: 'error', server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom' });
  ({ PlayerController } = await vite.ssrLoadModule('/src/player/PlayerController.ts'));
  ({ PLAYER_CONFIG: CFG } = await vite.ssrLoadModule('/src/config.ts'));
  THREE = await vite.ssrLoadModule('three');
});
after(async () => {
  await vite?.close();
});

const DT = 1 / 120;
/** A flat floor at y = 0 (the CollisionWorld calls PlayerController makes). */
const flat = {
  resolveCapsule(seg, r, _walkable, hit) {
    const depth = r - seg.start.y;
    hit.grounded = depth >= -1e-4;
    hit.hitCeiling = false;
    hit.groundNormal.set(0, 1, 0);
    if (depth > 0) {
      seg.start.y += depth;
      seg.end.y += depth;
    }
  },
  raycast(o, d, far, n) {
    if (d.y >= 0) return null;
    const t = o.y / -d.y;
    if (t > far) return null;
    n?.set(0, 1, 0);
    return t;
  },
  capsuleOverlaps: () => false,
};
const keys = (o = {}) => ({ moveX: 0, moveY: 0, lookYaw: 0, lookPitch: 0, jump: false, crouch: false, walk: false, ...o });
const speed = (p) => Math.hypot(p.velocity.x, p.velocity.z);

function player(y = 0) {
  const p = new PlayerController(flat);
  p.teleport(new THREE.Vector3(0, y, 0), 0);
  return p;
}

/** Runs forward (W) on the ground for 1 s: full run speed. */
function running() {
  const p = player();
  for (let k = 0; k < 120; k++) p.step(keys({ moveY: 1 }), DT);
  return p;
}

/** Ticks until the player is on the ground again (input from `fn(tick)`). */
function flyToLanding(p, fn = () => keys()) {
  let t = 0;
  while (!p.grounded && t < 1000) p.step(fn(t++), DT);
  return t;
}

/**
 * Hops: after a running start, jumps and flies; `lead` ticks before landing
 * the jump is pressed (negative: pressed |lead| ticks after landing).
 * strafe: alternate A / D each hop, turning the view `turn` rad/s toward
 * that side (the air-strafe technique). Returns the speed after each hop.
 */
function hops(n, { lead = 3, strafe = false, turn = 0, holdW = false } = {}) {
  const p = running();
  p.step(keys({ moveY: 1, jump: true }), DT);
  const out = [];
  let side = 1;
  for (let h = 0; h < n; h++) {
    const base = { moveY: holdW ? 1 : 0, moveX: strafe ? side : 0 };
    flyToLanding(p, () => {
      if (strafe) p.yaw += -side * turn * DT;
      const landing = p.velocity.y < 0 && p.position.y + p.velocity.y * DT * lead <= 1e-4;
      return keys({ ...base, jump: lead > 0 && landing });
    });
    if (lead <= 0) {
      for (let k = 0; k < -lead; k++) p.step(keys(base), DT);
      p.step(keys({ ...base, jump: true }), DT);
    } else p.step(keys(base), DT); // the landing tick: the buffered press fires
    out.push(+speed(p).toFixed(3));
    side = -side;
  }
  return { speeds: out, p };
}

test('a normal jump: same height and air time as before (5.2 m/s up, 18 m/s² down)', () => {
  const p = player();
  p.step(keys(), DT);
  p.step(keys({ jump: true }), DT);
  let top = 0;
  const t = flyToLanding(p, () => {
    top = Math.max(top, p.position.y);
    return keys();
  });
  assert.ok(Math.abs(top - (CFG.jumpVelocity * CFG.jumpVelocity) / (2 * CFG.gravity)) < 0.03, `apex ${top.toFixed(3)} m`);
  assert.ok(Math.abs(t * DT - (2 * CFG.jumpVelocity) / CFG.gravity) < 0.03, `air time ${(t * DT).toFixed(3)} s`);
});

test('holding the jump key hops once: every hop needs a fresh press', () => {
  const p = running();
  let jumps = 0;
  let wasGrounded = true;
  for (let k = 0; k < 400; k++) {
    p.step(keys({ moveY: 1, jump: true }), DT);
    if (wasGrounded && !p.grounded) jumps++;
    wasGrounded = p.grounded;
  }
  assert.equal(jumps, 1);
});

test('jump buffer: pressed shortly before landing fires on the landing tick; pressed too early does not; pressed after landing still jumps', () => {
  const tryLead = (leadTicks) => {
    const p = running();
    p.step(keys({ moveY: 1, jump: true }), DT);
    let pressed = false;
    flyToLanding(p, () => {
      const ticksLeft = p.velocity.y < 0 ? Math.ceil(p.position.y / (-p.velocity.y * DT)) : Infinity;
      const press = !pressed && ticksLeft <= leadTicks;
      if (press) pressed = true;
      return keys({ moveY: 1, jump: press });
    });
    p.step(keys({ moveY: 1 }), DT); // landing tick
    return !p.grounded; // in the air again = hopped
  };
  assert.equal(tryLead(1), true, 'one tick before');
  assert.equal(tryLead(Math.floor(CFG.jumpBuffer * 120) - 1), true, 'just inside the buffer');
  assert.equal(tryLead(Math.ceil(CFG.jumpBuffer * 120) + 6), false, 'well before landing: not buffered');
  // After landing: an ordinary jump from the ground.
  const p = running();
  p.step(keys({ moveY: 1, jump: true }), DT);
  flyToLanding(p, () => keys({ moveY: 1 }));
  for (let k = 0; k < 5; k++) p.step(keys({ moveY: 1 }), DT);
  p.step(keys({ moveY: 1, jump: true }), DT);
  assert.equal(p.grounded, false);
});

test('timing: well-timed hops keep their speed; late hops lose it to friction; pressing jump alone never adds speed', () => {
  const timed = hops(10, { lead: 3, holdW: true }).speeds;
  assert.ok(timed.every((s) => Math.abs(s - CFG.runSpeed) < 1e-9), `kept at run speed: ${timed}`);
  const noKeys = hops(10, { lead: 3 }).speeds;
  assert.ok(noKeys.every((s) => s <= CFG.runSpeed + 1e-9), `no gain without strafing: ${noKeys}`);
  // From a fast start, late hops (3 ticks on the ground each time) bleed speed; timed ones keep more.
  const late = hops(6, { lead: -3, strafe: true, turn: 1.5 }).speeds;
  const good = hops(6, { lead: 3, strafe: true, turn: 1.5 }).speeds;
  assert.ok(late.at(-1) < good.at(-1) - 1.5, `late ${late.at(-1)} vs timed ${good.at(-1)}`);
  assert.ok(late.at(-1) < CFG.runSpeed + 0.3, `late hops end near run speed (${late.at(-1)})`);
});

test('air strafing: turning with the strafe gains speed hop by hop, less as it rises; keys alone or over-turning do not', () => {
  const keysOnly = hops(8, { lead: 3, strafe: true, turn: 0 }).speeds;
  assert.ok(Math.max(...keysOnly) < CFG.runSpeed * 1.02, `A / D without turning: ${keysOnly}`);
  const skilled = hops(12, { lead: 3, strafe: true, turn: 1.5 }).speeds;
  for (let k = 1; k < skilled.length; k++) assert.ok(skilled[k] > skilled[k - 1], `rises every hop: ${skilled}`);
  const gains = skilled.map((s, k) => s - (k ? skilled[k - 1] : CFG.runSpeed));
  assert.ok(gains.at(-1) < gains[1] / 2, `gains shrink as speed rises: ${gains.map((g) => g.toFixed(2))}`);
  assert.ok(skilled.at(-1) > 8 && skilled.at(-1) <= CFG.maxAirSpeed, `skilled hopping reaches ${skilled.at(-1)}`);
  const overTurned = hops(12, { lead: 3, strafe: true, turn: 3.5 }).speeds;
  assert.ok(overTurned.at(-1) < CFG.runSpeed, `turning too fast loses speed: ${overTurned.at(-1)}`);
});

test('the air speed limit: the best possible strafing never goes past it', () => {
  // Every tick the ideal view angle: the strafe key exactly as far across the velocity as still gains.
  const p = running();
  p.step(keys({ moveY: 1, jump: true }), DT);
  let top = 0;
  for (let hop = 0; hop < 60; hop++) {
    flyToLanding(p, () => {
      const v = speed(p);
      const gain = Math.min(CFG.airAccel * CFG.runSpeed * DT, CFG.airWishSpeed);
      const across = Math.acos(Math.max(-1, Math.min(1, (CFG.airWishSpeed - gain) / Math.max(v, 1e-6))));
      // The wish direction `across` away from the velocity; strafe right (moveX 1) points along (cos yaw, -sin yaw).
      const vx = p.velocity.x / Math.max(v, 1e-6);
      const vz = p.velocity.z / Math.max(v, 1e-6);
      const wx = vx * Math.cos(across) - vz * Math.sin(across);
      const wz = vx * Math.sin(across) + vz * Math.cos(across);
      p.yaw = Math.atan2(-wz, wx);
      top = Math.max(top, speed(p));
      const landing = p.velocity.y < 0 && p.position.y + p.velocity.y * DT * 3 <= 1e-4;
      return keys({ moveX: 1, jump: landing });
    });
    p.step(keys({ moveX: 1 }), DT);
    top = Math.max(top, speed(p));
  }
  assert.ok(top <= CFG.maxAirSpeed + 1e-9, `top ${top}`);
  assert.ok(top > CFG.maxAirSpeed - 0.05, `ideal strafing reaches the limit (${top.toFixed(3)})`);
});

test('pressing against the motion in the air slows down, smoothly (no instant stop)', () => {
  const p = running();
  p.step(keys({ moveY: 1, jump: true }), DT);
  const s0 = speed(p);
  const trace = [];
  flyToLanding(p, () => {
    trace.push(p.velocity.z);
    return keys({ moveY: -1 });
  });
  const steps = trace.slice(1).map((v, k) => Math.abs(v - trace[k]));
  assert.ok(Math.max(...steps) <= CFG.airAccel * CFG.runSpeed * DT + 1e-9, 'never more than the air acceleration per tick');
  assert.ok(speed(p) < s0 && trace.at(-1) > -CFG.airWishSpeed - 1e-9, `slowed from ${s0} (end ${trace.at(-1).toFixed(2)})`);
});

test('air control: from a standing jump a key moves the player (up to the air wish speed); a fall without a jump keeps the original control', () => {
  const p = player();
  p.step(keys(), DT);
  p.step(keys({ jump: true }), DT);
  flyToLanding(p, () => keys({ moveX: 1 }));
  assert.ok(speed(p) > 0.5 && speed(p) <= CFG.airWishSpeed + 1e-9, `steered ${speed(p).toFixed(2)} m/s`);
  // Falling from a height (no jump): the original air control, up to fallControl × run speed.
  const f = player(3);
  flyToLanding(f, () => keys({ moveY: 1 }));
  const fallTarget = CFG.runSpeed * CFG.fallControl + 0.01;
  assert.ok(Math.abs(speed(f) - fallTarget) < 0.02, `fall steering ${speed(f).toFixed(3)} (original ${fallTarget})`);
});

test('ground speeds are the same as before: run, walk, crouch; strafing and stopping on the ground', () => {
  const settle = (o) => {
    const p = player();
    for (let k = 0; k < 240; k++) p.step(keys(o), DT);
    return speed(p);
  };
  assert.ok(Math.abs(settle({ moveY: 1 }) - CFG.runSpeed) < 1e-9);
  assert.ok(Math.abs(settle({ moveY: 1, walk: true }) - CFG.walkSpeed) < 1e-9);
  assert.ok(Math.abs(settle({ moveY: 1, crouch: true }) - CFG.crouchSpeed) < 1e-9);
  assert.ok(Math.abs(settle({ moveX: 1, moveY: 1 }) - CFG.runSpeed) < 1e-9, 'diagonal is not faster');
  const p = running();
  for (let k = 0; k < 120; k++) p.step(keys(), DT);
  assert.ok(speed(p) < 0.01, `stops on release (${speed(p)})`);
  assert.deepEqual([CFG.runSpeed, CFG.walkSpeed, CFG.crouchSpeed, CFG.groundAccel, CFG.groundFriction, CFG.jumpVelocity, CFG.gravity], [5.4, 2.8, 2.2, 60, 9, 5.2, 18], 'ground and jump values unchanged');
});

test('a respawn / teleport mid-hop starts from rest: no speed, no air state, no buffered jump carried over', () => {
  const { p } = hops(12, { strafe: true, turn: 1.5 });
  // In the air, fast, with a jump pressed just before the teleport (buffered for the landing).
  p.step(keys({ jump: true }), DT);
  assert.ok(!p.grounded && speed(p) > 8, `mid-hop at speed (${speed(p).toFixed(2)} m/s)`);
  p.step(keys(), DT);
  p.step(keys({ jump: true }), DT);
  p.teleport(new THREE.Vector3(0, 0.1, 0), 0);
  assert.equal(speed(p), 0);
  assert.equal(p.velocity.y, 0);
  // Falls the 0.1 m and lands without the buffered press firing; stays on the ground, still.
  flyToLanding(p);
  for (let k = 0; k < 60; k++) p.step(keys(), DT);
  assert.ok(p.grounded, 'on the ground');
  assert.ok(Math.abs(p.position.y) < 1e-6 && p.velocity.y === 0, `no jump from before the teleport (y ${p.position.y}, vy ${p.velocity.y})`);
  assert.equal(speed(p), 0);
  // The next hop is a plain one: run speed, not the speed from before.
  for (let k = 0; k < 120; k++) p.step(keys({ moveY: 1 }), DT);
  p.step(keys({ moveY: 1, jump: true }), DT);
  flyToLanding(p, () => keys({ moveY: 1 }));
  assert.ok(Math.abs(speed(p) - CFG.runSpeed) < 0.05, `plain hop after the teleport (${speed(p).toFixed(3)} m/s)`);
});
