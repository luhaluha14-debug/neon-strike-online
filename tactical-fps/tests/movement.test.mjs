// Movement / collision / hitscan determinism on both maps.
//
// A seeded random walk (30 runs x 10 s at the 120 Hz tick: running, strafing,
// jumping, crouching, turning) and 200 seeded hitscan rays per map. Checks:
//   - the same inputs give bit-identical results twice in a row (determinism),
//   - nobody leaves the play area or falls through the floor,
//   - the results match tests/golden/movement.json, recorded on the current
//     main branch. Any change to movement, collision, map classification or
//     hitscan shows up here. If such a change is intended, re-record with
//     UPDATE_GOLDEN=1 and review the diff of the golden file.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, openGame, golden, asJson } from './harness.mjs';

let env;
before(async () => {
  env = await startEnv();
});
after(async () => {
  await env?.close();
});

const results = {};

for (const map of ['seoul', 'warehouse']) {
  test(`${map}: movement, collision and hitscan are deterministic and unchanged`, async () => {
    const page = await openGame(env, { map });
    const r = await page.evaluate(() => {
      const g = window.game;
      const p = g.player;
      g.loop.stop();

      const walk = () => {
        let seed = 42;
        const rnd = () => {
          seed = (seed * 1664525 + 1013904223) >>> 0;
          return seed / 4294967296;
        };
        const spawns = [...g.map.attackSpawns, ...g.map.defenseSpawns];
        const pb = g.map.playBounds;
        let minY = Infinity;
        let outOfBounds = 0;
        let belowKillPlane = 0;
        const ends = [];
        for (let k = 0; k < 30; k++) {
          const s = spawns[k % spawns.length];
          const sp = s.position.clone();
          sp.y += 0.1;
          p.teleport(sp, rnd() * 6.28);
          const st = { moveX: 0, moveY: 1, lookYaw: 0, lookPitch: 0, jump: false, crouch: false, walk: false, fire: false, reload: false };
          for (let i = 0; i < 120 * 10; i++) {
            if (i % 60 === 0) {
              p.yaw += (rnd() - 0.5) * 2.5;
              st.moveX = Math.round(rnd() * 2 - 1);
              st.jump = rnd() < 0.2;
              st.crouch = rnd() < 0.15;
            }
            p.step(st, 1 / 120);
            minY = Math.min(minY, p.position.y);
            if (p.position.x < pb.min.x - 0.5 || p.position.x > pb.max.x + 0.5 || p.position.z < pb.min.z - 0.5 || p.position.z > pb.max.z + 0.5) outOfBounds++;
            if (p.position.y < g.mapDef.killPlaneY) belowKillPlane++;
          }
          ends.push(p.position.toArray().map((v) => +v.toFixed(3)));
        }
        const T = p.position.constructor;
        let hits = 0;
        let distanceSum = 0;
        for (let k = 0; k < 200; k++) {
          const s = spawns[k % spawns.length];
          const o = s.position.clone();
          o.y += 1.6;
          const a = rnd() * 6.28;
          const e = (rnd() - 0.6) * 0.8;
          const d = new T(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e));
          const res = g.hitscan.fire({ origin: o, direction: d, damage: g.weapons.weapon.def.damage, sourceId: 'test', weaponId: 'test' });
          if (res.kind !== 'miss') {
            hits++;
            distanceSum += res.distance;
          }
        }
        return { minY: +minY.toFixed(3), outOfBounds, belowKillPlane, ends, hits, distanceSum: +distanceSum.toFixed(2) };
      };

      const first = walk();
      const second = walk();
      return { first, second, stats: g.map.stats, spawns: g.map.attackSpawns.length + g.map.defenseSpawns.length };
    });

    assert.deepEqual(r.second, r.first, 'same inputs must give identical results');
    assert.equal(r.first.outOfBounds, 0, 'left the play area');
    assert.equal(r.first.belowKillPlane, 0, 'fell below the kill plane');
    assert.ok(r.spawns >= 2, 'map has spawn points');

    results[map] = { stats: r.stats, walk: r.first };
    assert.deepEqual(page.errors, []);
    await page.context().close();
  });
}

test('results match the recorded golden values', async () => {
  assert.ok(results.seoul && results.warehouse, 'map tests did not run');
  const expected = await golden('movement', results);
  assert.deepEqual(asJson(results), expected);
});
