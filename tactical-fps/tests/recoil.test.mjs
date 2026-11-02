// Gun recoil (Node, the game's RecoilController and weapon table at 120 Hz
// ticks): the climb of every gun is what it was; the sideways path of the
// automatic guns is the same S shape every spray (a small random wobble on
// top), different per gun; the view settles back sideways as well as up
// after the trigger is released, without undoing what the player countered
// and without a jump; damage, fire rate, magazines and the SR-01 scope are
// unchanged.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { ROOT } from './harness.mjs';

let vite;
let RecoilController;
let W;

before(async () => {
  vite = await createServer({ root: ROOT, logLevel: 'error', server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom' });
  ({ RecoilController } = await vite.ssrLoadModule('/src/weapons/RecoilController.ts'));
  W = await vite.ssrLoadModule('/src/weapons/weapons.ts');
});
after(async () => {
  await vite?.close();
});

const DT = 1 / 120;
const DEG = Math.PI / 180;

/**
 * Holds the trigger for `shots` rounds at the gun's fire rate, then lets go for `rest` s.
 * `counter(pitch, yaw)` may return the player's own look input per tick. Returns the view
 * (pitch, yaw) at each shot and after the rest, plus the largest one-tick settling move.
 */
function spray(def, shots, { seed = 1, rest = 2, counter = null } = {}) {
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const rc = new RecoilController(def.recoil, rnd);
  const out = { pitch: 0, yaw: 0 };
  let pitch = 0;
  let yaw = 0;
  let t = 0;
  let next = 0;
  let fired = 0;
  let jump = 0;
  let released = -1;
  const at = [];
  const tick = (firing) => {
    if (firing && t >= next) {
      at.push([pitch, yaw]);
      rc.onShot();
      fired++;
      next += 60 / def.fireRate;
    }
    rc.update(DT, out);
    pitch += out.pitch;
    yaw += out.yaw;
    // Settling motion only: from when recovery starts (before it the last kick is still easing in).
    if (!firing && t - released > def.recoil.recoveryDelay + DT) jump = Math.max(jump, Math.abs(out.yaw), Math.abs(out.pitch));
    const c = counter?.(pitch, yaw);
    if (c) {
      rc.absorbPlayerPitch(c[0]);
      rc.absorbPlayerYaw(c[1]);
      pitch += c[0];
      yaw += c[1];
    }
    t += DT;
  };
  while (fired < shots) tick(true);
  released = t;
  for (let k = 0; k < rest * 120; k++) tick(false);
  return { at, end: [pitch, yaw], jump };
}

const GUNS = () => [W.AR_01, W.SMG_01, W.PIS_01, W.SG_01, W.SR_01];

test('the climb is unchanged: the same pitch at every shot as the recorded profile (first shot on the crosshair)', () => {
  // Pitch at shots 1, 2, 5, 10 and the cap, in degrees (from the profiles before this change).
  const expected = { ar01: [0, 0.43, 2, 5.44, 6], smg01: [0, 0.27, 1.31, 3.54, 4.5] };
  for (const def of [W.AR_01, W.SMG_01]) {
    const r = spray(def, 30);
    const got = [0, 1, 4, 9, 29].map((i) => +(r.at[i][0] / DEG).toFixed(2));
    assert.deepEqual(got, expected[def.id], def.id);
  }
  for (const def of GUNS()) assert.equal(spray(def, 1).at[0][0], 0, `${def.id}: first round where the crosshair is`);
});

test('automatic guns: the sideways path is the same every spray (S shape, its own per gun); the wobble on top stays small', () => {
  for (const def of [W.AR_01, W.SMG_01]) {
    const runs = [1, 2, 3, 4, 5, 6].map((seed) => spray(def, 30, { seed: seed * 7919 }));
    let widest = 0;
    for (let i = 0; i < 30; i++) {
      const y = runs.map((r) => r.at[i][1]);
      widest = Math.max(widest, Math.max(...y) - Math.min(...y));
    }
    assert.ok(widest < 0.7 * DEG, `${def.id}: runs stay within ${(widest / DEG).toFixed(2)}° of each other`);
    // The average path turns: goes one way, then the other, then back.
    const mean = (i) => runs.reduce((s, r) => s + r.at[i][1], 0) / runs.length;
    const signs = [14, 19, 29].map((i) => Math.sign(mean(i)));
    assert.deepEqual(signs, [def.recoil.yawDriftSign, -def.recoil.yawDriftSign, def.recoil.yawDriftSign], `${def.id}: S path ${signs}`);
    assert.ok(Math.abs(mean(14)) > 0.4 * DEG, `${def.id}: the drift is felt (${(mean(14) / DEG).toFixed(2)}° at shot 15)`);
  }
  assert.notEqual(W.AR_01.recoil.yawDriftSign, W.SMG_01.recoil.yawDriftSign, 'the rifle and the SMG pull different ways first');
});

test('after letting go the view settles back up and sideways to where it was aimed, smoothly', () => {
  for (const def of GUNS()) {
    const r = spray(def, Math.min(def.magazineSize, 30));
    assert.ok(Math.abs(r.end[0]) < 0.01 * DEG && Math.abs(r.end[1]) < 0.01 * DEG, `${def.id}: back on the aim (${r.end.map((v) => (v / DEG).toFixed(3))}°)`);
    assert.ok(r.jump <= def.recoil.recoverySpeed * DT + 1e-9, `${def.id}: no jump while settling (${(r.jump / DEG).toFixed(3)}° in one tick)`);
  }
  // SR-01: after one shot the scope is back on the aim before the bolt has cycled.
  const sr = spray(W.SR_01, 1, { rest: 60 / W.SR_01.fireRate });
  assert.ok(Math.hypot(...sr.end) < 0.01 * DEG, `scope back on target (${sr.end.map((v) => (v / DEG).toFixed(3))}°)`);
});

test('what the player countered is not undone: pulling against the kick leaves the view where the player put it', () => {
  // Hold the view on the start point by pulling against every kick (a perfect spray control).
  const r = spray(W.AR_01, 30, {
    counter: (pitch, yaw) => [-pitch, -yaw],
  });
  assert.ok(Math.abs(r.end[0]) < 1e-6 && Math.abs(r.end[1]) < 1e-6, `stays on the point (${r.end.map((v) => (v / DEG).toFixed(4))}°)`);
});

test('damage, fire rate, magazines and the SR-01 bolt / 4x scope are as they were', () => {
  const t = Object.fromEntries(GUNS().map((d) => [d.id, [d.damage.base, d.damage.headMultiplier, d.fireRate, d.fireMode, d.magazineSize, d.reloadTime]]));
  assert.deepEqual(t, {
    ar01: [24, 4.25, 600, 'auto', 30, 2.2],
    smg01: [19, 3.5, 800, 'auto', 30, 2.1],
    pis01: [26, 3.9, 360, 'semi', 12, 1.8],
    sg01: [15, 2, 68, 'semi', 8, 3.2],
    sr01: [115, 4, 41, 'semi', 5, 3.6],
  });
  assert.deepEqual(W.SR_01.scope, { zoom: 4, sensitivity: 0.4 });
  assert.equal(W.SR_01.sounds.cycle, 'sr01.bolt');
  assert.deepEqual(W.SG_01.pellets, { count: 8, spread: 3.2 * DEG });
});
