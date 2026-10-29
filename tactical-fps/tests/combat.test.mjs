// Hit registration and damage numbers.
//
// There are no enemies in the game yet, so these tests register test-only
// targets (plain objects implementing the existing `Damageable` interface)
// with the game's own HitscanSystem through its public `register()`. Nothing
// in the game code is changed. Damage numbers are pinned to the current
// weapon data so an accidental balance change fails loudly.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, openGame } from './harness.mjs';

// 115 x 0.9 = 103.5 sits exactly on a rounding boundary (floating point decides).
const SR_BODY_END = 104;

let env;
let page;
before(async () => {
  env = await startEnv();
  page = await openGame(env, { map: 'warehouse' });
  await page.evaluate(() => {
    const g = window.game;
    g.loop.stop();
    const V = g.player.position.constructor;
    // Axis-aligned test target: a 0.5 x 1.8 x 0.5 m box; zone from hit height.
    window.makeTarget = (id, x, y, z, opts = {}) => {
      const min = new V(x - 0.25, y, z - 0.25);
      const max = new V(x + 0.25, y + 1.8, z + 0.25);
      return {
        id,
        team: 'test',
        alive: opts.alive ?? true,
        hits: [],
        raycast(ray, maxDistance) {
          let t0 = 0;
          let t1 = maxDistance;
          for (const a of ['x', 'y', 'z']) {
            const o = ray.origin[a];
            const d = ray.direction[a];
            if (Math.abs(d) < 1e-9) {
              if (o < min[a] || o > max[a]) return null;
              continue;
            }
            let ta = (min[a] - o) / d;
            let tb = (max[a] - o) / d;
            if (ta > tb) [ta, tb] = [tb, ta];
            t0 = Math.max(t0, ta);
            t1 = Math.min(t1, tb);
            if (t0 > t1) return null;
          }
          const point = ray.origin.clone().addScaledVector(ray.direction, t0);
          const h = point.y - y;
          const zone = h > 1.5 ? 'head' : h < 0.8 ? 'limb' : 'body';
          return { distance: t0, point, normal: new V(0, 0, 1), zone };
        },
        applyDamage(info) {
          this.hits.push({ amount: info.amount, zone: info.zone, sourceId: info.sourceId, weaponId: info.weaponId });
        },
      };
    };
  });
});
after(async () => {
  await page?.context().close();
  await env?.close();
});

test('damage numbers per weapon, zone and distance match the current weapon data', async () => {
  const table = await page.evaluate(async () => {
    const { computeDamage } = await import('/src/combat/HitscanSystem.ts');
    const { AR_01, SR_01, KARAMBIT } = await import('/src/weapons/weapons.ts');
    const out = {};
    for (const w of [AR_01, SR_01, KARAMBIT]) {
      out[w.id] = {};
      for (const zone of ['head', 'body', 'limb']) {
        out[w.id][zone] = [0, w.damage.falloffStart, (w.damage.falloffStart + w.damage.falloffEnd) / 2, w.damage.falloffEnd, w.damage.falloffEnd * 2].map((d) => computeDamage(w.damage, zone, d));
      }
    }
    return out;
  });
  // [0 m, falloff start, mid, falloff end, 2x falloff end]
  assert.deepEqual(table, {
    // base 24, head x4.25, limb x0.8, 30-80 m falloff down to x0.8
    ar01: { head: [102, 102, 92, 82, 82], body: [24, 24, 22, 19, 19], limb: [19, 19, 17, 15, 15] },
    // base 115, head x4, limb x0.85, 120-250 m falloff down to x0.9
    sr01: { head: [460, 460, 437, 414, 414], body: [115, 115, 109, SR_BODY_END, SR_BODY_END], limb: [98, 98, 93, 88, 88] },
    // base 40, head x1.5, no falloff
    karambit: { head: [60, 60, 60, 60, 60], body: [40, 40, 40, 40, 40], limb: [40, 40, 40, 40, 40] },
  });
});

test('hitscan hits a target in the open, once, with the computed damage', async () => {
  const r = await page.evaluate(async () => {
    const { computeDamage } = await import('/src/combat/HitscanSystem.ts');
    const g = window.game;
    const V = g.player.position.constructor;
    // Find an open direction from the spawn: no wall within 12 m at chest height.
    const spawn = g.map.attackSpawns[0].position.clone();
    const origin = new V(spawn.x, spawn.y + 1.6, spawn.z);
    let dir = null;
    for (let a = 0; a < 64 && !dir; a++) {
      const d = new V(Math.sin((a / 64) * Math.PI * 2), 0, Math.cos((a / 64) * Math.PI * 2));
      if (g.map.collision.raycast(origin, d, 12) === null) dir = d;
    }
    if (!dir) return { error: 'no open direction' };
    const p = origin.clone().addScaledVector(dir, 8);
    const target = window.makeTarget('t1', p.x, spawn.y + 0.3, p.z);
    g.hitscan.register(target);
    const ar = g.weapons.loadout[0].def;
    const res = g.hitscan.fire({ origin, direction: dir, damage: ar.damage, sourceId: 'local', weaponId: ar.id });
    g.hitscan.unregister(target);
    return { kind: res.kind, zone: res.zone, damage: res.damage, expected: computeDamage(ar.damage, res.zone ?? 'body', res.distance ?? 0), hits: target.hits };
  });
  assert.equal(r.error, undefined);
  assert.equal(r.kind, 'target');
  assert.equal(r.zone, 'body');
  assert.equal(r.damage, r.expected);
  assert.deepEqual(r.hits, [{ amount: r.expected, zone: 'body', sourceId: 'local', weaponId: 'ar01' }]);
});

test('walls block shots: a target behind a wall is not hit', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const V = g.player.position.constructor;
    const spawn = g.map.attackSpawns[0].position.clone();
    const origin = new V(spawn.x, spawn.y + 1.6, spawn.z);
    // Find a wall 3-40 m away, put the target 2 m behind it on the same line.
    let found = null;
    for (let a = 0; a < 64 && !found; a++) {
      const d = new V(Math.sin((a / 64) * Math.PI * 2), 0, Math.cos((a / 64) * Math.PI * 2));
      const dist = g.map.collision.raycast(origin, d, 40);
      if (dist !== null && dist > 3) found = { d, dist };
    }
    if (!found) return { error: 'no wall found' };
    const p = origin.clone().addScaledVector(found.d, found.dist + 2);
    const target = window.makeTarget('behind', p.x, spawn.y + 0.3, p.z);
    g.hitscan.register(target);
    const res = g.hitscan.fire({ origin, direction: found.d, damage: g.weapons.loadout[1].def.damage, sourceId: 'local', weaponId: 'sr01' });
    g.hitscan.unregister(target);
    return { kind: res.kind, distance: res.distance, wall: found.dist, hits: target.hits.length };
  });
  assert.equal(r.error, undefined);
  assert.equal(r.kind, 'world');
  assert.ok(Math.abs(r.distance - r.wall) < 1e-6);
  assert.equal(r.hits, 0);
});

test('nearest target wins; shooter, dead targets and out-of-range targets are ignored', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const V = g.player.position.constructor;
    const spawn = g.map.attackSpawns[0].position.clone();
    const origin = new V(spawn.x, spawn.y + 1.6, spawn.z);
    let dir = null;
    for (let a = 0; a < 64 && !dir; a++) {
      const d = new V(Math.sin((a / 64) * Math.PI * 2), 0, Math.cos((a / 64) * Math.PI * 2));
      if (g.map.collision.raycast(origin, d, 12) === null) dir = d;
    }
    const at = (m) => origin.clone().addScaledVector(dir, m);
    const shoot = (weapon, sourceId = 'local') => g.hitscan.fire({ origin, direction: dir, damage: weapon.damage, sourceId, weaponId: weapon.id });
    const ar = g.weapons.loadout[0].def;
    const knife = g.weapons.loadout[2].def;
    const out = {};

    const near = window.makeTarget('near', at(5).x, spawn.y + 0.3, at(5).z);
    const far = window.makeTarget('far', at(9).x, spawn.y + 0.3, at(9).z);
    g.hitscan.register(far);
    g.hitscan.register(near);
    out.nearest = shoot(ar).target?.id;
    out.counts = [near.hits.length, far.hits.length];
    g.hitscan.unregister(near);
    g.hitscan.unregister(far);

    const self = window.makeTarget('local', at(5).x, spawn.y + 0.3, at(5).z);
    g.hitscan.register(self);
    out.self = shoot(ar).kind;
    g.hitscan.unregister(self);

    const dead = window.makeTarget('dead', at(5).x, spawn.y + 0.3, at(5).z, { alive: false });
    g.hitscan.register(dead);
    out.dead = shoot(ar).kind;
    g.hitscan.unregister(dead);

    const reach = window.makeTarget('reach', at(4).x, spawn.y + 0.3, at(4).z);
    g.hitscan.register(reach);
    out.knifeAt4m = shoot(knife).kind;
    g.hitscan.unregister(reach);
    const close = window.makeTarget('close', at(1.2).x, spawn.y + 0.3, at(1.2).z);
    g.hitscan.register(close);
    out.knifeAt1m = shoot(knife).kind;
    g.hitscan.unregister(close);
    return out;
  });
  assert.equal(r.nearest, 'near');
  assert.deepEqual(r.counts, [1, 0]);
  assert.notEqual(r.self, 'target');
  assert.notEqual(r.dead, 'target');
  assert.notEqual(r.knifeAt4m, 'target', 'knife reach is 1.9 m');
  assert.equal(r.knifeAt1m, 'target');
});

test('no page errors', () => {
  assert.deepEqual(page.errors, []);
});
