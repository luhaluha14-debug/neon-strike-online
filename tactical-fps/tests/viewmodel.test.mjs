// First-person hands on the weapons: glove / weapon interpenetration and
// near-plane proximity, measured geometrically by the dev-only
// `window.vmCheck()` (src/debug/viewModelChecks.ts) after posing the view
// model for each weapon and animation state. No pixels are compared.
//
// Budgets are the values measured on main when this suite was added (in mm /
// vertex counts, rounded up by at most 0.5 mm / ~10 %). They are regression
// guards: lower them when the hands improve, never raise them to make a
// change pass without looking at it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, openGame } from './harness.mjs';

let env;
let page;
before(async () => {
  env = await startEnv();
  page = await openGame(env, { map: 'warehouse', width: 1280, height: 720 });
  await page.evaluate(() => window.game.loop.stop());
  await page.waitForFunction(() => typeof window.vmCheck === 'function');
});
after(async () => {
  await page?.context().close();
  await env?.close();
});

/** Equips `slot`, holds the given animation state for 40 frames, returns vmCheck(). */
const pose = (slot, s = {}) =>
  page.evaluate(
    ([slot, s]) => {
      const g = window.game;
      const vm = g.viewModel;
      const ws = g.weapons;
      ws.equipSlot(slot);
      const w = ws.weapon;
      w.status = 'ready';
      w.equipRemaining = 0;
      const anim = { category: w.def.category, equip: s.equip ?? 1, reload: s.reload ?? null, sinceShot: s.sinceShot ?? Infinity, fireInterval: w.fireInterval, inspect: s.inspect ?? null };
      for (let k = 0; k < 40; k++) vm.update(1 / 60, { lookYaw: 0, lookPitch: 0, speed01: 0, grounded: true, crouching: false }, anim);
      const c = window.vmCheck();
      return { inside: c.handVerticesInside, maxMm: c.maxPenetrationMm, near: c.verticesTooCloseToCamera, handVertices: c.handVertices };
    },
    [slot, s],
  );

const cases = [
  // name, slot, state, max mm, max vertices inside
  ['AR-01 idle', 0, {}, 5.0, 21],
  ['AR-01 just fired', 0, { sinceShot: 0.03 }, 5.0, 21],
  ['AR-01 drawing', 0, { equip: 0.5 }, 5.0, 21],
  ['AR-01 reload 40 % (hand on magazine)', 0, { reload: 0.4 }, 7.2, 140],
  ['AR-01 reload 82 % (magazine going in)', 0, { reload: 0.82 }, 12.0, 113],
  ['SR-01 idle', 1, {}, 5.6, 29],
  ['SR-01 bolt cycling', 1, { sinceShot: 0.7 }, 5.6, 29],
  ['Karambit idle', 2, {}, 0, 0],
  ['Karambit slash', 2, { sinceShot: 0.16 }, 0, 0],
  ['Karambit inspect', 2, { inspect: 0.5 }, 0, 0],
];

for (const [name, slot, state, maxMm, maxInside] of cases) {
  test(`${name}: glove clipping within budget, nothing at the near plane`, async () => {
    const r = await pose(slot, state);
    assert.ok(r.handVertices > 0, 'hands are present');
    assert.ok(r.maxMm <= maxMm, `deepest penetration ${r.maxMm} mm > ${maxMm} mm`);
    assert.ok(r.inside <= maxInside, `${r.inside} glove vertices inside the weapon > ${maxInside}`);
    assert.equal(r.near, 0, 'vertices closer than 6 cm to the eye');
  });
}

test('support hand shown on two-handed weapons, hidden on the knife', async () => {
  const visible = await page.evaluate(() => {
    const g = window.game;
    const out = [];
    for (const slot of [0, 1, 2]) {
      g.weapons.equipSlot(slot);
      const view = g.viewModel.currentView;
      out.push(!!view.supportAnchor);
    }
    g.weapons.equipSlot(0);
    return out;
  });
  assert.deepEqual(visible, [true, true, false]);
});

test('no page errors', () => {
  assert.deepEqual(page.errors, []);
});
