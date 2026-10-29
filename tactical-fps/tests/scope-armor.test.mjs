// SR-01 scope (right mouse) and ARMOR-01 (body vest), through the real
// input, weapon system, HUD and team match economy. Frames are driven at a
// fixed 1/60 s with the real loop stopped.
//
// Scope: zoom / sensitivity come from the SR-01 definition; held only while
// the right button is held, with the SR-01 ready; no scope on other weapons;
// released on menu / unlock, death (spectating) and round changes.
// Armor: $650, damage split per ARMOR_CONFIG (body only), wear, HUD and buy
// menu, kept by survivors, lost on death.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, openGame, installFrameDriver } from './harness.mjs';

let env;
let page;

const run = (n) => page.evaluate((n) => window.T.run(n), n);
const state = () =>
  page.evaluate(() => {
    const g = window.game;
    return {
      scoped: g.scoped,
      fov: +g.camera.fov.toFixed(3),
      overlay: document.querySelector('.hud').classList.contains('scoped'),
      crosshair: getComputedStyle(document.querySelector('.crosshair')).visibility,
      vmRenders: window.T.vm,
      weapon: g.weapons.weapon.def.id,
    };
  });
const rightDown = () => page.mouse.down({ button: 'right' });
const rightUp = () => page.mouse.up({ button: 'right' });

async function waitLocked() {
  await page.waitForFunction(
    () => document.pointerLockElement === window.game.renderer.domElement && window.game.input.active && document.querySelector('.hud').classList.contains('playing'),
  );
}

before(async () => {
  env = await startEnv();
});
after(async () => {
  await page?.context().close();
  await env?.close();
});

test('scope config: SR-01 only, zoom 4x and 0.4 sensitivity from its definition', async () => {
  page = await openGame(env, { map: 'warehouse' });
  const r = await page.evaluate(async () => {
    const { WEAPONS } = await import('/src/weapons/weapons.ts');
    return Object.fromEntries(Object.values(WEAPONS).map((w) => [w.id, w.scope ?? null]));
  });
  assert.deepEqual(r, { ar01: null, sr01: { zoom: 4, sensitivity: 0.4 }, karambit: null, smg01: null, sg01: null, pis01: null });
});

test('SR-01: right button held zooms in (FOV / 4 magnification), shows the scope, hides the crosshair and the weapon; release restores', async () => {
  await page.click('.play-button');
  await waitLocked();
  await page.mouse.move(0, 0);
  await installFrameDriver(page);
  await page.evaluate(() => {
    const g = window.game;
    window.T.stopLoop();
    window.T.vm = 0;
    g.viewModel.render = () => window.T.vm++;
  });
  await run(40);
  const base = await state();
  assert.equal(base.weapon, 'ar01');
  // AR-01: the right button does nothing.
  await rightDown();
  await run(10);
  const ar = await state();
  await rightUp();
  await run(2);
  assert.deepEqual([ar.scoped, ar.fov, ar.overlay], [false, base.fov, false], 'no scope on AR-01');
  // SR-01.
  await page.keyboard.press('Digit2');
  await run(90);
  await page.evaluate(() => (window.T.vm = 0));
  await run(5);
  const sr = await state();
  assert.equal(sr.weapon, 'sr01');
  assert.equal(sr.scoped, false);
  assert.equal(sr.vmRenders, 5, 'the weapon is drawn while not scoped');
  await rightDown();
  await run(5);
  await page.evaluate(() => (window.T.vm = 0));
  await run(5);
  const zoomed = await state();
  assert.equal(zoomed.scoped, true);
  assert.equal(zoomed.overlay, true, 'scope overlay shown');
  assert.equal(zoomed.crosshair, 'hidden', 'crosshair hidden while scoped');
  assert.equal(zoomed.vmRenders, 0, 'no first-person weapon through the scope');
  const mag = Math.tan((base.fov * Math.PI) / 360) / Math.tan((zoomed.fov * Math.PI) / 360);
  assert.ok(Math.abs(mag - 4) < 1e-3, `4x magnification (${base.fov}° -> ${zoomed.fov}°, ${mag.toFixed(4)})`);
  await rightUp();
  await run(2);
  const released = await state();
  assert.deepEqual([released.scoped, released.fov, released.overlay, released.crosshair === 'visible'], [false, base.fov, false, true]);
});

test('SR-01 scope: look slowed to 0.4x while zoomed; the saved sensitivity is unchanged', async () => {
  const turn = await page.evaluate(() => {
    const g = window.game;
    const sens = g.input.sensitivity;
    const move = () => {
      const y0 = g.player.yaw;
      document.dispatchEvent(new MouseEvent('mousemove', { movementX: -100, movementY: 0 }));
      window.T.run(1);
      return g.player.yaw - y0;
    };
    return { sens, free: move() };
  });
  await rightDown();
  await run(5);
  const scoped = await page.evaluate(() => {
    const g = window.game;
    const y0 = g.player.yaw;
    document.dispatchEvent(new MouseEvent('mousemove', { movementX: -100, movementY: 0 }));
    window.T.run(1);
    return { d: g.player.yaw - y0, sens: g.input.sensitivity, scoped: g.scoped };
  });
  await rightUp();
  await run(2);
  assert.equal(scoped.scoped, true);
  assert.ok(Math.abs(scoped.d / turn.free - 0.4) < 1e-6, JSON.stringify({ turn, scoped }));
  assert.equal(scoped.sens, turn.sens, 'mouse sensitivity setting untouched');
});

test('SR-01 scope: drops out after a shot (bolt cycle) and comes back while still held; reloading has no scope', async () => {
  await rightDown();
  await run(5);
  assert.equal((await state()).scoped, true);
  await page.mouse.down();
  await run(2);
  await page.mouse.up();
  await run(2);
  const afterShot = await state();
  assert.equal(afterShot.scoped, false, 'out of the scope while the bolt cycles');
  await run(90);
  assert.equal((await state()).scoped, true, 'back in the scope once ready, button still held');
  await page.keyboard.press('KeyR');
  await run(5);
  assert.equal((await state()).scoped, false, 'no scope while reloading');
  await rightUp();
  await run(240);
});

test('SR-01 scope: released when the pointer lock is lost (menu), no zoom left behind', async () => {
  await rightDown();
  await run(5);
  assert.equal((await state()).scoped, true);
  await page.evaluate(() => document.exitPointerLock());
  await page.waitForFunction(() => !window.game.input.active);
  await run(3);
  const s = await state();
  await rightUp();
  assert.deepEqual([s.scoped, s.overlay], [false, false]);
  assert.ok(s.fov > 60, `normal FOV (${s.fov})`);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

// ---- Team match: armor, and the scope across death / rounds ----

test('armorSplit: 30% of body damage absorbed while armor lasts; head / limbs untouched', async () => {
  page = await openGame(env, { map: 'warehouse', mode: 'team' });
  const r = await page.evaluate(async () => {
    const { armorSplit } = await import('/src/player/PlayerCombat.ts');
    const { ARMOR_CONFIG } = await import('/src/config.ts');
    return {
      cfg: ARMOR_CONFIG,
      body: armorSplit(24, 'body', 100),
      head: armorSplit(24, 'head', 100),
      none: armorSplit(24, 'body', 0),
      little: armorSplit(24, 'body', 3),
      big: armorSplit(100, 'body', 100),
    };
  });
  assert.deepEqual(r.cfg, { max: 100, absorb: 0.3, wearPerAbsorbed: 1, zones: ['body'] });
  assert.deepEqual(r.body, { health: 17, absorbed: 7 });
  assert.deepEqual(r.head, { health: 24, absorbed: 0 });
  assert.deepEqual(r.none, { health: 24, absorbed: 0 });
  assert.deepEqual(r.little, { health: 21, absorbed: 3 }, 'cannot absorb more than the armor left');
  assert.deepEqual(r.big, { health: 70, absorbed: 30 });
});

test('ARMOR-01: $650 in the buy phase, 100 AP on the HUD and in the menu; full = owned; damage then splits and wears it', async () => {
  await page.click('.play-button');
  await waitLocked();
  await page.mouse.move(0, 0);
  await installFrameDriver(page);
  const r = await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    T.stopLoop();
    g.restartMatch();
    T.run(2);
    const money = () => g.teamMatch.economy.money('local');
    const hud = () => ({ shown: !document.querySelector('.hud .armor').hidden, value: document.querySelector('.armor-value').textContent });
    const before = { armor: g.combat.armor, money: money(), hud: hud() };
    const buy = g.buy('ARMOR-01');
    T.run(1);
    g.updateBuyMenu(); // the menu refreshes itself only while open
    const card = document.querySelector('.buy-card[data-id="ARMOR-01"]');
    const after = { armor: g.combat.armor, money: money(), hud: hud(), card: card.dataset.state, loadout: document.querySelector('.buy-loadout').textContent, fb: document.querySelector('.buy-feedback').textContent };
    const again = g.buy('ARMOR-01');
    const afterAgain = money();
    // Live: a 24-damage body hit -> 17 health, armor 93.
    while (g.teamMatch.phase !== 'live') T.run(1);
    g.combat.protection = 0;
    const V = g.player.position.constructor;
    const hit = (amount, zone) => g.combat.applyDamage({ amount, zone, sourceId: 'red-0', weaponId: 'ar01', point: new V(), direction: new V(0, 0, 1), distance: 5 });
    const events = [];
    const prev = g.combat.onDamage;
    g.combat.onDamage = (e) => {
      events.push({ amount: e.amount, absorbed: e.absorbed });
      prev?.(e);
    };
    hit(24, 'body');
    const body = { health: g.combat.health, armor: g.combat.armor };
    hit(24, 'head');
    const head = { health: g.combat.health, armor: g.combat.armor };
    T.run(1);
    return { before, buy: buy.ok, after, again: again.reason, afterAgain, body, head, events, hudAfter: hud(), roundLive: g.teamMatch.phase };
  });
  assert.deepEqual(r.before, { armor: 0, money: 3000, hud: r.before.hud });
  assert.equal(r.before.hud.shown, false, 'no armor readout without armor');
  assert.equal(r.buy, true);
  assert.equal(r.after.money, 2350, '$650');
  assert.equal(r.after.armor, 100);
  assert.deepEqual(r.after.hud, { shown: true, value: '100' });
  assert.equal(r.after.card, 'owned');
  assert.match(r.after.loadout, /ARMOR-01 100/);
  assert.equal(r.after.fb, 'ARMOR-01 구매 완료 (-$650)');
  assert.equal(r.again, 'owned', 'full armor cannot be bought again');
  assert.equal(r.afterAgain, 2350);
  assert.deepEqual(r.body, { health: 83, armor: 93 }, '24 body -> 17 health + 7 absorbed');
  assert.deepEqual(r.head, { health: 59, armor: 93 }, 'no helmet: head damage is not reduced');
  assert.deepEqual(r.events, [{ amount: 17, absorbed: 7 }, { amount: 24, absorbed: 0 }]);
  assert.deepEqual(r.hudAfter, { shown: true, value: '93' });
});

test('ARMOR-01: a survivor keeps the worn vest next round and can top it up; a dead player starts with none', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    const tm = g.teamMatch;
    const V = g.player.position.constructor;
    const kill = (c) => {
      c.protection = 0;
      c.applyDamage({ amount: 999, zone: 'head', sourceId: 'test', weaponId: 'ar01', point: new V(), direction: new V(0, 0, 1), distance: 5 });
    };
    for (const b of g.squad.bots.filter((b) => b.team === 'red')) kill(b.combat);
    T.run(1);
    while (tm.phase !== 'prep') T.run(1);
    const kept = g.combat.armor;
    const health = g.combat.health;
    const m0 = tm.economy.money('local');
    const card = document.querySelector('.buy-card[data-id="ARMOR-01"]');
    T.run(1);
    g.updateBuyMenu();
    const tag = card.querySelector('.buy-tag')?.textContent;
    const top = g.buy('ARMOR-01');
    const topped = { armor: g.combat.armor, paid: m0 - tm.economy.money('local'), fb: document.querySelector('.buy-feedback').textContent };
    // Next round: the player dies.
    while (tm.phase !== 'live') T.run(1);
    kill(g.combat);
    for (const b of g.squad.bots.filter((b) => b.team === 'blue')) kill(b.combat);
    T.run(1);
    while (tm.phase !== 'prep') T.run(1);
    return { kept, health, tag, top: top.ok, topped, afterDeath: g.combat.armor, hud: document.querySelector('.hud .armor').hidden };
  });
  assert.equal(r.kept, 93, 'the worn vest carries over as it was');
  assert.equal(r.health, 100, 'health is restored, armor is not');
  assert.equal(r.tag, '보충 (현재 93)');
  assert.equal(r.top, true);
  assert.deepEqual(r.topped, { armor: 100, paid: 650, fb: 'ARMOR-01 보충 93 → 100 (-$650)' });
  assert.equal(r.afterDeath, 0, 'died: no armor');
  assert.equal(r.hud, true);
});

test('scope is dropped on death (spectating) and is gone at the next round', async () => {
  await page.evaluate(() => {
    const g = window.game;
    g.teamMatch.economy.credit('local', 5000);
    g.buy('SR-01');
    while (g.teamMatch.phase !== 'live') window.T.run(1);
    window.T.run(90);
  });
  await rightDown();
  await run(5);
  const live = await state();
  await page.evaluate(() => {
    const g = window.game;
    const V = g.player.position.constructor;
    g.combat.protection = 0;
    g.combat.applyDamage({ amount: 999, zone: 'head', sourceId: 'test', weaponId: 'ar01', point: new V(), direction: new V(0, 0, 1), distance: 5 });
  });
  await run(5);
  const dead = await state();
  await page.evaluate(() => {
    const g = window.game;
    while (g.teamMatch.phase !== 'prep') window.T.run(1);
  });
  await run(2);
  const next = await state();
  await rightUp();
  assert.deepEqual([live.weapon, live.scoped], ['sr01', true]);
  assert.deepEqual([dead.scoped, dead.overlay], [false, false], 'no scope while dead / spectating');
  assert.ok(dead.fov > 60);
  assert.deepEqual([next.scoped, next.overlay, next.weapon], [false, false, 'karambit'], 'died: default issue, no scope');
  assert.deepEqual(page.errors, []);
});
