// Ground movement without jumping: a seeded walk on both maps (running,
// walking, crouching, strafing, stopping, turning, ramps and steps on the
// way) through the real PlayerController and collision. Any change to how
// the player moves on the ground shows up here.
//
// Recorded first on the controller before the bunny-hop / air movement work,
// which left it bit-identical. Re-recorded once for one deliberate fix: running
// diagonally into a wall no longer builds speed along it (it reached ~10 m/s
// here, up to ~14 m/s in theory). Compared tick by tick with the old
// controller, every one of the 48 walks is identical until the first tick
// where the old one went past the move speed against a wall. The recorded top
// speed is still above the run speed: a sharp turn on open ground briefly
// adds the new direction on top of what friction left of the old one, as it
// always has.

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
/** The same on the maps as shipped (with MapDressing): movement-ground-dressed.json. */
const dressedResults = {};

// movement-ground.json was recorded on the map files alone and keeps checking exactly that; the
// dressed maps have their own recording.
for (const [map, dressing] of [['seoul', 'none'], ['warehouse', 'none'], ['seoul', null], ['warehouse', null]]) {
  test(`${map}${dressing ? ' (map file only)' : ' (dressed)'}: ground movement (no jumps) is deterministic`, async () => {
    const page = await openGame(env, { map, dressing });
    const r = await page.evaluate(() => {
      const g = window.game;
      const p = g.player;
      g.loop.stop();
      const walk = () => {
        let seed = 7;
        const rnd = () => {
          seed = (seed * 1664525 + 1013904223) >>> 0;
          return seed / 4294967296;
        };
        const spawns = [...g.map.attackSpawns, ...g.map.defenseSpawns];
        const ends = [];
        let path = 0;
        let speedSum = 0;
        let topSpeed = 0;
        for (let k = 0; k < 24; k++) {
          const s = spawns[k % spawns.length];
          const sp = s.position.clone();
          sp.y += 0.1;
          p.teleport(sp, rnd() * 6.28);
          const st = { moveX: 0, moveY: 1, lookYaw: 0, lookPitch: 0, jump: false, crouch: false, walk: false, fire: false, reload: false };
          for (let i = 0; i < 120 * 8; i++) {
            if (i % 45 === 0) {
              p.yaw += (rnd() - 0.5) * 2.2;
              st.moveX = Math.round(rnd() * 2 - 1);
              st.moveY = rnd() < 0.15 ? 0 : rnd() < 0.1 ? -1 : 1;
              st.crouch = rnd() < 0.15;
              st.walk = rnd() < 0.2;
            }
            const before = p.position.clone();
            p.step(st, 1 / 120);
            path += before.distanceTo(p.position);
            const h = Math.hypot(p.velocity.x, p.velocity.z);
            speedSum += h;
            topSpeed = Math.max(topSpeed, h);
          }
          ends.push(p.position.toArray().map((v) => +v.toFixed(4)));
        }
        return { ends, path: +path.toFixed(3), speedSum: +speedSum.toFixed(3), topSpeed: +topSpeed.toFixed(4) };
      };
      const first = walk();
      const second = walk();
      return { first, second };
    });
    assert.deepEqual(r.second, r.first, 'same inputs must give identical results');
    (dressing ? results : dressedResults)[map] = r.first;
    assert.deepEqual(page.errors, []);
    await page.context().close();
  });
}

test('ground movement matches the recording made before the air-movement changes', async () => {
  assert.ok(results.seoul && results.warehouse, 'map tests did not run');
  const expected = await golden('movement-ground', results);
  assert.deepEqual(asJson(results), expected);
});

test('dressed maps: ground movement matches its recording', async () => {
  assert.ok(dressedResults.seoul && dressedResults.warehouse, 'map tests did not run');
  const expected = await golden('movement-ground-dressed', dressedResults);
  assert.deepEqual(asJson(dressedResults), expected);
});
