// Phase 25 combat polish, presentation only (no damage, rate, recoil-of-the-aim, spread or price change):
// each weapon's own view-model kick (AR-02 flatter than AR-01, SMG-02 heavier than SMG-01), how the kick
// settles per kind of weapon (SMG quick, marksman / bolt-action smooth), aiming down sights steadier
// than the hip with the round going exactly where it would; the low-ammo and reload-done notices; the
// team status line on one line, clear of the personal record and the round banner, on narrow screens.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, openGame, installFrameDriver } from './harness.mjs';

let env;
before(async () => {
  env = await startEnv();
});
after(async () => {
  await env?.close();
});

test('view-model kick per weapon and per kind; ADS steadier than the hip; the round and the aim recoil unchanged by either', async () => {
  const page = await openGame(env, { map: 'warehouse', width: 1280, height: 720 });
  try {
    await page.evaluate(() => window.game.loop.stop());
    const r = await page.evaluate(async () => {
      const g = window.game;
      const { WEAPONS } = await import('/src/weapons/weapons.ts');
      const vm = g.viewModel;
      const motion = (aim) => ({ lookYaw: 0, lookPitch: 0, speed01: 0, grounded: true, crouching: false, aim });
      const shot = (id, aim = 0) => {
        const def = WEAPONS[id];
        const anim = { category: def.category, equip: 1, reload: null, sinceShot: Infinity, fireInterval: 0.1, inspect: null };
        for (let k = 0; k < 120; k++) vm.update(1 / 120, motion(aim), anim);
        const p0 = vm['pivot'].rotation.x;
        const z0 = vm['pivot'].position.z;
        vm.onShot(def.category, def.view.feel);
        let rise = 0;
        let back = 0;
        let peak = 0;
        let settled = null;
        for (let k = 1; k <= 120; k++) {
          vm.update(1 / 120, motion(aim), anim);
          const dr = vm['pivot'].rotation.x - p0;
          const dz = vm['pivot'].position.z - z0;
          rise = Math.max(rise, dr);
          back = Math.max(back, dz);
          // Settling read on the kick spring itself (the pose also carries the slow idle breathing).
          const kick = vm['kick'];
          peak = Math.max(peak, kick);
          if (settled === null && k > 6 && Math.abs(kick) < peak * 0.1) settled = k / 120;
        }
        return { rise, back, settled };
      };
      const out = {};
      for (const id of ['ar01', 'ar02', 'smg01', 'smg02', 'sr01', 'dmr01', 'pis01', 'pis02', 'lmg01', 'lmg02']) out[id] = shot(id);
      out.ar02Aimed = shot('ar02', 0.6);
      return out;
    });
    const ratio = (a, b, k) => r[a][k] / r[b][k];
    // Rifles: AR-02 rises less and pushes back more than AR-01 (its feel: rise ×0.85, back ×1.15).
    assert.ok(Math.abs(ratio('ar02', 'ar01', 'rise') - 0.85) < 0.03, `AR-02 rise vs AR-01 ${ratio('ar02', 'ar01', 'rise').toFixed(3)}`);
    assert.ok(Math.abs(ratio('ar02', 'ar01', 'back') - 1.15) < 0.03, `AR-02 push vs AR-01 ${ratio('ar02', 'ar01', 'back').toFixed(3)}`);
    // SMG-02's .45 shoves harder than SMG-01.
    assert.ok(ratio('smg02', 'smg01', 'rise') > 1.08, `SMG-02 vs SMG-01 ${ratio('smg02', 'smg01', 'rise').toFixed(3)}`);
    assert.ok(ratio('pis02', 'pis01', 'rise') > 1.05, 'PIS-02 snaps up a little more');
    assert.ok(ratio('lmg02', 'lmg01', 'back') > 1.1, 'LMG-02 shoves harder than LMG-01');
    // Settling: the SMG back on target first, the marksman / bolt-action rifles ease back later.
    assert.ok(r.smg01.settled < r.ar01.settled && r.ar01.settled < r.dmr01.settled && r.ar01.settled < r.sr01.settled, `settle s: ${['smg01', 'ar01', 'dmr01', 'sr01'].map((k) => `${k} ${r[k].settled}`).join(', ')}`);
    for (const [k, v] of Object.entries(r)) assert.ok(v.settled !== null && v.settled <= 0.5, `${k} settles within 0.5 s (${v.settled})`);
    // Aiming down sights: a steadier kick than from the hip (70 % at full aim, here 0.6 of it).
    const aimed = r.ar02Aimed.rise / r.ar02.rise;
    assert.ok(aimed < 0.86 && aimed > 0.78, `ADS kick ${aimed.toFixed(3)} of the hip's`);
  } finally {
    await page.context().close();
  }
});

test('ADS (right mouse, AR-02) vs the hip: the same round, the same aim recoil; only the view steadier', async () => {
  const page = await openGame(env, { map: 'warehouse', width: 960, height: 540 });
  try {
    await page.click('.play-button');
    await page.waitForFunction(() => document.pointerLockElement !== null && window.game.input.active);
    await installFrameDriver(page);
    const r = await page.evaluate(async () => {
      const g = window.game;
      const T = window.T;
      T.stopLoop();
      const { WEAPONS } = await import('/src/weapons/weapons.ts');
      for (const t of g.trainingRange.targets) g.hitscan.unregister(t);
      g.weapons.setLoadout([WEAPONS.ar02, WEAPONS.karambit]);
      T.run(90);
      let dir = null;
      const ev = g.weapons.events;
      const prev = ev.onShot;
      ev.onShot = (r, o, d, w, p) => ((dir = d.toArray().map((v) => +v.toFixed(6))), prev(r, o, d, w, p));
      const shoot = (aim) => {
        g.player.pitch = 0;
        g.player.yaw = 0;
        dir = null;
        g.input.mouseButtons = aim ? 4 : 0;
        T.run(20);
        const steady = g['aimAmount']();
        g.input.mouseButtons = 1 | (aim ? 4 : 0);
        T.run(1);
        g.input.mouseButtons = aim ? 4 : 0;
        T.run(3);
        const pitch = +g.player.pitch.toFixed(6);
        g.input.mouseButtons = 0;
        // The spray resets (and the view settles) before the next one.
        T.run(90);
        return { dir, pitch, steady };
      };
      const hip = shoot(false);
      const ads = shoot(true);
      ev.onShot = prev;
      return { hip, ads };
    });
    assert.equal(r.hip.steady, 0);
    assert.equal(r.ads.steady, 0.6, 'aiming down sights steadies the view');
    assert.ok(r.hip.dir, 'a round from the hip');
    assert.deepEqual(r.ads.dir, r.hip.dir, 'the round goes the same way');
    assert.equal(r.ads.pitch, r.hip.pitch, 'the same aim recoil');
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});

test('HUD: 탄약 부족 when low, R 재장전 when empty, 재장전 완료 for a moment after a reload; nothing when full', async () => {
  const page = await openGame(env, { map: 'warehouse', width: 1280, height: 720 });
  try {
    await page.click('.play-button');
    await page.waitForFunction(() => document.pointerLockElement !== null && window.game.input.active);
    await installFrameDriver(page);
    // The status line keeps its old wording (empty when merely low); the notices have their own line.
    const status = () => page.evaluate(() => [document.querySelector('.weapon-status').textContent, document.querySelector('.ammo-note').textContent, document.querySelector('.hud').classList.contains('ammo-low')]);
    await page.evaluate(() => {
      window.T.stopLoop();
      for (const t of window.game.trainingRange.targets) window.game.hitscan.unregister(t);
      window.T.run(60);
    });
    assert.deepEqual(await status(), ['', '', false]);
    await page.evaluate(() => {
      window.game.weapons.weapon.magazine = 4;
      window.T.run(2);
    });
    assert.deepEqual(await status(), ['', '탄약 부족', true]);
    await page.evaluate(() => {
      window.game.weapons.weapon.magazine = 0;
      window.T.run(2);
    });
    assert.deepEqual((await status()).slice(0, 2), ['R 재장전', '']);
    await page.keyboard.press('r');
    await page.evaluate(() => {
      const g = window.game;
      for (let k = 0; k < 5 && g.weapons.weapon.status !== 'reloading'; k++) window.T.run(1);
      while (g.weapons.weapon.status === 'reloading') window.T.run(1);
      window.T.run(1);
    });
    assert.deepEqual((await status()).slice(0, 2), ['', '재장전 완료']);
    await page.waitForTimeout(1300);
    await page.evaluate(() => window.T.run(2));
    assert.deepEqual((await status()).slice(0, 2), ['', ''], 'the notice goes after a moment');
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});

for (const [w, h, mobile] of [
  [640, 360, true],
  [740, 360, true],
  [760, 420, false],
  [800, 450, false],
]) {
  test(`team status line on one line, clear of the personal record and the round banner: ${w}×${h}${mobile ? ' phone' : ''}`, async () => {
    const page = await openGame(env, { mode: 'team', objective: 'elimination', width: w, height: h, mobile, quality: 'low' });
    try {
      if (mobile) await page.tap('.play-button');
      else await page.click('.play-button');
      await page.waitForFunction(() => window.game.input.active);
      await installFrameDriver(page);
      await page.evaluate(() => {
        window.T.stopLoop();
        window.T.run(30);
      });
      const r = await page.evaluate(() => {
        const box = (s) => {
          const e = document.querySelector(s);
          if (!e || !e.getClientRects().length) return null;
          const b = e.getBoundingClientRect();
          return { l: b.left, t: b.top, r: b.right, b: b.bottom, h: b.height };
        };
        const ta = box('.team-alive');
        const lineH = parseFloat(getComputedStyle(document.querySelector('.team-alive')).fontSize) * 2;
        const others = { stats: box('.combat-stats'), vitals: box('.vitals'), banner: box('.round-banner'), minimap: box('.minimap') };
        const hit = (a, b) => !!a && !!b && Math.min(a.r, b.r) - Math.max(a.l, b.l) > 0 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 0;
        const banner = others.banner;
        return {
          oneLine: ta.h <= lineH,
          inside: ta.l >= 0 && ta.r <= innerWidth,
          overlaps: Object.entries(others).filter(([, b]) => hit(ta, b)).map(([k]) => k),
          bannerOverlaps: banner ? ['stats', 'vitals', 'minimap'].filter((k) => hit(banner, others[k])) : [],
        };
      });
      assert.ok(r.oneLine, 'one line');
      assert.ok(r.inside, 'inside the screen');
      assert.deepEqual(r.overlaps, [], 'the status line overlaps nothing');
      assert.deepEqual(r.bannerOverlaps, [], 'the round banner overlaps nothing');
      assert.deepEqual(page.errors, []);
    } finally {
      await page.context().close();
    }
  });
}
