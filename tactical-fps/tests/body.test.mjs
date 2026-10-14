// First-person lower body (src/player/FirstPersonBody.ts): pose logic only.
//
// The player is driven through PlayerController.step at the 120 Hz tick and
// the body is updated exactly like Game.frame does (Game.updateBody). Checks
// numbers, not pictures: distance to the camera, foot sliding, turning rules,
// crouch / airborne poses.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, openGame } from './harness.mjs';

let env;
let page;
before(async () => {
  env = await startEnv();
  page = await openGame(env, { map: 'warehouse' });
  await page.evaluate(() => {
    const g = window.game;
    g.loop.stop();
    const base = { moveX: 0, moveY: 0, lookYaw: 0, lookPitch: 0, jump: false, crouch: false, walk: false, fire: false, reload: false };
    const V = g.player.position.constructor;
    const B = (window.B = {});
    B.reset = () => {
      const p = g.player;
      p.teleport(new V(0, 0.1, 28), 0);
      for (let i = 0; i < 120; i++) p.step(base, 1 / 120);
      g.body.reset();
      B.sim(1);
    };
    /** Nearest body vertex to the camera (m). */
    B.minDist = () => {
      let m = Infinity;
      const v = new V();
      g.body.object.updateMatrixWorld(true);
      g.body.object.traverse((o) => {
        if (!o.isMesh) return;
        const pos = o.geometry.getAttribute('position');
        for (let i = 0; i < pos.count; i++) m = Math.min(m, v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).distanceTo(g.camera.position));
      });
      return m;
    };
    /** n frames of 1/60 s with an input; returns the smallest camera distance seen. */
    B.sim = (n, input = {}, yawPerSecond = 0) => {
      const p = g.player;
      const st = { ...base, ...input };
      let minDist = Infinity;
      for (let f = 0; f < n; f++) {
        p.yaw += yawPerSecond / 60;
        p.step(st, 1 / 120);
        p.step(st, 1 / 120);
        g.camera.position.set(p.position.x, p.position.y + p.eyeHeight, p.position.z);
        g.camera.rotation.set(p.pitch, p.yaw, 0);
        g.camera.updateMatrixWorld();
        g.updateBody(1 / 60, p.eyeHeight);
        minDist = Math.min(minDist, B.minDist());
      }
      return minDist;
    };
    B.info = () => ({ bodyYaw: g.body.bodyYaw, yaw: g.player.yaw, hipY: g.body.pelvis.position.y, feet: g.body.legs.map((l) => l.foot.y) });
  });
});
after(async () => {
  await page?.context().close();
  await env?.close();
});

const states = [
  ['standing', {}, 30],
  ['running', { moveY: 1 }, 60],
  ['walking', { moveY: 1, walk: true }, 60],
  ['strafing', { moveX: 1 }, 60],
  ['backpedalling', { moveY: -1 }, 60],
  ['crouching', { crouch: true }, 60],
  ['jumping', { jump: true }, 20],
];

for (const [name, input, frames] of states) {
  test(`${name}: every body vertex stays at least 0.5 m from the camera`, async () => {
    const d = await page.evaluate(([input, frames]) => {
      window.B.reset();
      return window.B.sim(frames, input);
    }, [input, frames]);
    assert.ok(d >= 0.5, `closest body vertex ${d.toFixed(3)} m from the eye`);
  });
}

test('running: a planted foot stays planted (no foot sliding)', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const B = window.B;
    B.reset();
    B.sim(60, { moveY: 1 });
    const V = g.player.position.constructor;
    const legs = g.body.legs;
    let prev = legs.map((l) => l.boot.getWorldPosition(new V()));
    let prevPlanted = legs.map((l) => l.foot.y < 0.081);
    const speeds = [];
    for (let f = 0; f < 60; f++) {
      B.sim(1, { moveY: 1 });
      legs.forEach((l, i) => {
        const w = l.boot.getWorldPosition(new V());
        const planted = l.foot.y < 0.081;
        if (planted && prevPlanted[i]) speeds.push(w.distanceTo(prev[i]) * 60);
        prev[i] = w;
        prevPlanted[i] = planted;
      });
    }
    speeds.sort((a, b) => a - b);
    return { median: speeds[speeds.length >> 1], max: speeds[speeds.length - 1], samples: speeds.length, playerSpeed: Math.hypot(g.player.velocity.x, g.player.velocity.z) };
  });
  assert.ok(r.playerSpeed > 5, 'player is running');
  assert.ok(r.samples >= 20, `too few planted samples (${r.samples})`);
  assert.ok(r.median < 0.05, `median planted foot speed ${r.median} m/s`);
  assert.ok(r.max < 0.3, `max planted foot speed ${r.max} m/s`);
});

test('standing still: small view turns do not turn the legs, large ones do', async () => {
  const r = await page.evaluate(() => {
    const B = window.B;
    B.reset();
    B.sim(20, {}, 0.6); // 0.2 rad
    const small = B.info();
    B.reset();
    B.sim(30, {}, 3.0); // 1.5 rad
    B.sim(40);
    const large = B.info();
    return { small, large };
  });
  assert.ok(Math.abs(r.small.bodyYaw) < 1e-9, `body turned ${r.small.bodyYaw} rad for a 0.2 rad look`);
  assert.ok(Math.abs(r.large.bodyYaw - r.large.yaw) < 0.05, 'body catches up with a large turn');
});

test('crouching lowers the hips by the eye drop; jumping lifts the feet', async () => {
  const r = await page.evaluate(() => {
    const B = window.B;
    B.reset();
    B.sim(30);
    const stand = B.info();
    B.reset();
    B.sim(60, { crouch: true });
    const crouch = B.info();
    B.reset();
    B.sim(14, { jump: true });
    const air = B.info();
    return { stand, crouch, air };
  });
  assert.ok(Math.abs(r.stand.hipY - 0.93) < 0.01, `standing hip height ${r.stand.hipY}`);
  assert.ok(Math.abs(r.stand.hipY - r.crouch.hipY - 0.6) < 0.01, `crouch drops the hips by ${r.stand.hipY - r.crouch.hipY}`);
  assert.ok(Math.min(...r.air.feet) > 0.15, `feet while airborne ${r.air.feet}`);
});

test('no page errors', () => {
  assert.deepEqual(page.errors, []);
});
