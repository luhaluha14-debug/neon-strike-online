// Bunny hopping on the real maps (the game's PlayerController and collision,
// 120 Hz ticks): a long air-strafing hop session over stairs, ramps, kerbs
// and walls never ends a tick inside solid geometry, never leaves the play
// area and never goes past the air speed limit; hopping straight into a wall
// stops at it; running diagonally into a wall on the ground no longer builds
// speed along it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, openGame } from './harness.mjs';

let env;
before(async () => {
  env = await startEnv();
});
after(async () => {
  await env?.close();
});

for (const map of ['seoul', 'warehouse']) {
  test(`${map}: 6 s of strafing hops from every spawn: no tick inside geometry, inside the play area, never past the limit`, async () => {
    const page = await openGame(env, { map });
    try {
      const r = await page.evaluate(async () => {
        const { Line3 } = await import('/node_modules/three/build/three.module.js');
        const g = window.game;
        const p = g.player;
        g.loop.stop();
        const cfg = { cap: 9, r: 0.35 };
        const world = g.map.collision;
        const pb = g.map.playBounds;
        const seg = new Line3();
        const inside = () => {
          seg.start.set(p.position.x, p.position.y + cfg.r, p.position.z);
          seg.end.set(p.position.x, p.position.y + p.height - cfg.r, p.position.z);
          return world.capsuleOverlaps(seg, cfg.r - 0.03);
        };
        const keys = (o) => ({ moveX: 0, moveY: 0, lookYaw: 0, lookPitch: 0, jump: false, crouch: false, walk: false, ...o });
        const spawns = [...g.map.attackSpawns, ...g.map.defenseSpawns];
        let ticks = 0;
        let overlaps = 0;
        let out = 0;
        let top = 0;
        let hopsDone = 0;
        for (const s of spawns) {
          const sp = s.position.clone();
          sp.y += 0.05;
          p.teleport(sp, Math.random() * 6.28);
          // A one-second running start, then 6 s of hops: jump pressed again on each landing tick, in the
          // air strafe sideways and turn the view toward that side; the side flips every hop.
          let side = 1;
          for (let k = 0; k < 120 * 7; k++) {
            const run = k < 120;
            const wasGrounded = p.grounded;
            if (!run && !wasGrounded) p.yaw += -side * 1.5 / 120;
            p.step(keys({ moveY: run ? 1 : 0, moveX: run ? 0 : side, jump: !run && wasGrounded }), 1 / 120);
            if (wasGrounded && !p.grounded) {
              hopsDone++;
              side = -side;
            }
            ticks++;
            const h = Math.hypot(p.velocity.x, p.velocity.z);
            top = Math.max(top, h);
            if (inside()) overlaps++;
            if (p.position.x < pb.min.x - 0.5 || p.position.x > pb.max.x + 0.5 || p.position.z < pb.min.z - 0.5 || p.position.z > pb.max.z + 0.5 || p.position.y < g.mapDef.killPlaneY) out++;
          }
        }
        return { ticks, overlaps, out, top: +top.toFixed(3), hops: hopsDone, spawns: spawns.length };
      });
      assert.ok(r.hops >= r.spawns * 8, `hopped (${r.hops} hops over ${r.ticks} ticks from ${r.spawns} spawns)`);
      assert.equal(r.overlaps, 0, 'a tick ended inside solid geometry');
      assert.equal(r.out, 0, 'left the play area');
      assert.ok(r.top <= 9 + 1e-6, `never past the air speed limit (${r.top})`);
      assert.ok(r.top > 5.4, `hops did build speed (${r.top})`);
      assert.deepEqual(page.errors, []);
    } finally {
      await page.context().close();
    }
  });
}

test('warehouse: a wall stops a hop; running diagonally into a wall on the ground stays at run speed', async () => {
  const page = await openGame(env, { map: 'warehouse' });
  try {
    const r = await page.evaluate(() => {
      const g = window.game;
      const p = g.player;
      g.loop.stop();
      const V = p.position.constructor;
      const world = g.map.collision;
      // A wall: from a spawn, the nearest solid surface straight ahead at knee height within 3..12 m.
      let best = null;
      for (const s of [...g.map.attackSpawns, ...g.map.defenseSpawns]) {
        for (let a = 0; a < 32; a++) {
          const yaw = (a / 32) * Math.PI * 2;
          const dir = new V(-Math.sin(yaw), 0, -Math.cos(yaw));
          const knee = s.position.clone().setY(s.position.y + 0.5);
          const n = new V();
          const d = world.raycast(knee, dir, 12, n);
          if (d !== null && d > 3 && Math.abs(n.y) < 0.2 && (!best || d < best.d)) best = { s, yaw, d, n: n.clone() };
        }
      }
      if (!best) return { wall: false };
      const keys = (o) => ({ moveX: 0, moveY: 0, lookYaw: 0, lookPitch: 0, jump: false, crouch: false, walk: false, ...o });
      const wallDist = () => {
        const knee = p.position.clone().setY(p.position.y + 0.5);
        return world.raycast(knee, new V(-Math.sin(best.yaw), 0, -Math.cos(best.yaw)), 20);
      };
      // 1) Hop straight at the wall at the air speed limit.
      p.teleport(best.s.position.clone().setY(best.s.position.y + 0.05), best.yaw);
      for (let k = 0; k < 30; k++) p.step(keys(), 1 / 120);
      p.step(keys({ jump: true }), 1 / 120);
      p.velocity.x = -Math.sin(best.yaw) * 9;
      p.velocity.z = -Math.cos(best.yaw) * 9;
      let minWall = Infinity;
      for (let k = 0; k < 120; k++) {
        p.step(keys({ moveY: 1 }), 1 / 120);
        const w = wallDist();
        if (w !== null) minWall = Math.min(minWall, w);
      }
      const intoWall = -(p.velocity.x * -Math.sin(best.yaw) + p.velocity.z * -Math.cos(best.yaw)); // >= 0: not moving into it
      // 2) On the ground, from a standstill run at the wall 30° off straight on (60° from its
      //    surface) and keep pressing into it, sliding along it, for 4 s.
      p.teleport(best.s.position.clone().setY(best.s.position.y + 0.05), best.yaw - Math.PI / 6);
      for (let k = 0; k < 30; k++) p.step(keys(), 1 / 120);
      let top = 0;
      let slid = 0;
      const start = p.position.clone();
      let touching = 0;
      for (let k = 0; k < 480; k++) {
        p.step(keys({ moveY: 1 }), 1 / 120);
        // Ticks pushed by the wall only: where the wall has a corner the player is free of it for a
        // tick and the usual open-ground turn (sideways speed plus the wish) applies, as it always has.
        if (!p.wallContact) continue;
        touching++;
        top = Math.max(top, Math.hypot(p.velocity.x, p.velocity.z));
      }
      // Distance covered along the wall (sideways to the straight-on direction).
      slid = Math.abs((p.position.x - start.x) * Math.cos(best.yaw) - (p.position.z - start.z) * Math.sin(best.yaw));
      return { wall: true, wallAt: +best.d.toFixed(2), minWall: +minWall.toFixed(3), intoWall: +intoWall.toFixed(3), top: +top.toFixed(4), slid: +slid.toFixed(2), touching };
    });
    assert.equal(r.wall, true, 'found a wall to test against');
    assert.ok(r.minWall > 0.3, `stayed out of the wall (closest ${r.minWall} m from the knee ray)`);
    assert.ok(r.intoWall <= 1e-6, `no speed left going into the wall (${r.intoWall})`);
    assert.ok(r.touching > 240, `pressed against the wall (${r.touching} ticks)`);
    assert.ok(r.slid > 2, `slid along the wall (${r.slid} m)`);
    assert.ok(r.top <= 5.4 + 1e-6, `no speed built along the wall (${r.top} m/s)`);
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});
