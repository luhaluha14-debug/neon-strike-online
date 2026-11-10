// Phase 24 arsenal on a phone (740×360, touch through Chrome's input pipeline): 12. touch input with the
// new weapons. The fire button holds LMG-01 on full auto and fires PIS-02 once per tap; 장전 reloads;
// 무기 switches; 조준 brings up DMR-01's 3× scope with its own look speed.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, openGame, installFrameDriver } from './harness.mjs';
import { fingers, centre } from './mobile-touch.mjs';

let env;
before(async () => {
  env = await startEnv();
});
after(async () => {
  await env?.close();
});

const run = (page, n = 1) => page.evaluate((n) => window.T.run(n), n);
const state = (page) =>
  page.evaluate(() => {
    const g = window.game;
    const w = g.weapons.weapon;
    return { weapon: w.def.id, magazine: w.magazine, status: w.status, rounds: g.weapons.shotsFired, scoped: g.scoped, yaw: g.player.yaw, fingers: g.input.touch.fingerCount };
  });

test('12. touch: LMG-01 full auto while the fire button is held, reload, next weapon PIS-02 one round per tap; DMR-01 scope', async () => {
  const page = await openGame(env, { mode: 'training', quality: 'low', width: 740, height: 360, mobile: true });
  try {
    await page.tap('.play-button');
    await page.waitForFunction(() => window.game.input.active);
    await installFrameDriver(page);
    await page.evaluate(async () => {
      window.T.stopLoop();
      const g = window.game;
      for (const t of g.trainingRange.targets) g.hitscan.unregister(t);
      const { WEAPONS } = await import('/src/weapons/weapons.ts');
      window.T.W = WEAPONS;
      g.weapons.setLoadout([WEAPONS.lmg01, WEAPONS.pis02, WEAPONS.karambit]);
      window.T.run(120);
    });
    const f = await fingers(page);
    const tapOn = async (sel) => {
      const c = await centre(page, sel);
      await f.tap(c.x, c.y);
      await run(page, 2);
    };
    const s0 = await state(page);
    assert.equal(s0.weapon, 'lmg01');
    // Hold fire for 1 s: ~12 rounds at 750 RPM.
    const fire = await centre(page, '.tc-fire');
    await f.start(1, fire.x, fire.y);
    await run(page, 60);
    await f.end(1);
    await run(page, 2);
    const s1 = await state(page);
    assert.ok(Math.abs(s1.rounds - s0.rounds - 12.5) <= 1.5, `LMG-01 held: ${s1.rounds - s0.rounds} rounds in 1 s`);
    assert.equal(s1.magazine, 100 - (s1.rounds - s0.rounds));
    // 장전: the 5.4 s belt change.
    await tapOn('.tc-reload');
    assert.equal((await state(page)).status, 'reloading');
    await run(page, 330);
    assert.equal((await state(page)).magazine, 100, 'reloaded');
    // 무기: PIS-02; each tap is one round (semi-auto).
    await tapOn('.tc-weapon');
    await run(page, 120);
    assert.equal((await state(page)).weapon, 'pis02');
    const p0 = (await state(page)).rounds;
    for (let k = 0; k < 3; k++) {
      await f.start(1, fire.x, fire.y);
      await run(page, 6);
      await f.end(1);
      await run(page, 20);
    }
    assert.equal((await state(page)).rounds - p0, 3, 'three taps, three rounds');
    // DMR-01: 조준 = its 3× scope, look slowed to its scope sensitivity.
    await page.evaluate(() => {
      const g = window.game;
      g.weapons.setLoadout([window.T.W.dmr01, window.T.W.pis02, window.T.W.karambit]);
      window.T.run(120);
    });
    assert.equal((await state(page)).weapon, 'dmr01');
    const drag = async () => {
      const a = (await state(page)).yaw;
      await f.start(2, 450, 180);
      await f.move(2, 520, 180, 5);
      await f.end(2);
      await run(page, 1);
      return (await state(page)).yaw - a;
    };
    const free = await drag();
    await tapOn('.tc-aim');
    await run(page, 60);
    assert.equal((await state(page)).scoped, true, 'scoped');
    const zoomed = await drag();
    const k = await page.evaluate(() => window.game.weapons.weapon.def.scope.sensitivity * 0.7);
    assert.ok(Math.abs(zoomed / free - k) < 0.05, `look speed while scoped: ${(zoomed / free).toFixed(3)} (expected ${k.toFixed(3)})`);
    await tapOn('.tc-aim');
    await run(page, 10);
    const end = await state(page);
    assert.equal(end.scoped, false);
    assert.equal(end.fingers, 0, 'no finger left down');
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});
