// FLASH-01 / SMOKE-01 in the team match: buying (price, carry limit), the
// utility key (4) and a real mouse throw, flight / bounce / fuse on the real
// map collision, flash blindness for the player (white screen that fades)
// and for bots (no sight, no fire) with distance / view angle / walls taken
// into account, smoke blocking bot sight lines, and the round cleanup.
// Frames are driven at a fixed 1/60 s with the real loop stopped.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, openGame, installFrameDriver } from './harness.mjs';

let env;
let page;

const run = (n) => page.evaluate((n) => window.T.run(n), n);

before(async () => {
  env = await startEnv();
  page = await openGame(env, { map: 'warehouse', mode: 'team' });
  await page.click('.play-button');
  await page.waitForFunction(
    () => document.pointerLockElement === window.game.renderer.domElement && window.game.input.active && document.querySelector('.hud').classList.contains('playing'),
  );
  await page.mouse.move(0, 0);
  await installFrameDriver(page);
  await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    T.stopLoop();
    T.V = g.player.position.constructor;
    T.money = () => g.teamMatch.economy.money('local');
    T.kill = (c) => {
      c.protection = 0;
      c.applyDamage({ amount: 999, zone: 'head', sourceId: 'test', weaponId: 'ar01', point: new T.V(), direction: new T.V(0, 0, 1), distance: 5 });
    };
    T.until = (phase, max = 3000) => {
      let n = 0;
      while (g.teamMatch.phase !== phase && n < max) {
        T.run(1);
        n++;
      }
      return n;
    };
    /** The longest clear horizontal line of sight from the player's eye (direction, length). */
    T.clearDir = () => {
      const p = g.player;
      const eye = new T.V(p.position.x, p.position.y + p.eyeHeight, p.position.z);
      let best = null;
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2;
        const d = new T.V(-Math.sin(a), 0, -Math.cos(a));
        const hit = g.map.collision.raycast(eye, d, 40) ?? 40;
        if (!best || hit > best.len) best = { yaw: a, dir: d, len: hit };
      }
      return { eye, ...best };
    };
    /** A flash that goes off on the next tick at `at`. */
    T.flashAt = (at) => g.grenades.grenades.push({ id: 9000 + g.grenades.grenades.length, kind: 'flash', owner: 'test', position: at.clone(), velocity: new T.V(), age: 1.6, resting: true });
    g.restartMatch();
    T.run(2);
  });
});
after(async () => {
  await page?.context().close();
  await env?.close();
});

test('config: FLASH-01 $300 (carry 2), SMOKE-01 $400 (carry 1); the utility action is bound to 4', async () => {
  const r = await page.evaluate(async () => {
    const { GRENADE_CONFIG } = await import('/src/config.ts');
    const { findItem } = await import('/src/weapons/catalog.ts');
    const { ACTIONS } = await import('/src/input/Controls.ts');
    return {
      flash: [findItem('FLASH-01').price, findItem('FLASH-01').available, findItem('FLASH-01').grenade],
      smoke: [findItem('SMOKE-01').price, findItem('SMOKE-01').available, findItem('SMOKE-01').grenade],
      carry: GRENADE_CONFIG.maxCarry,
      key: ACTIONS.find((a) => a.id === 'utility')?.key,
      bound: window.game.input.bindings.utility,
    };
  });
  assert.deepEqual(r, { flash: [300, true, 'flash'], smoke: [400, true, 'smoke'], carry: { flash: 2, smoke: 1 }, key: 'Digit4', bound: 'Digit4' });
});

test('buying: 2 flashes and 1 smoke at their prices; one more is refused with nothing charged; HUD and menu show the counts', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    const m0 = T.money();
    const out = [];
    for (const id of ['FLASH-01', 'FLASH-01', 'FLASH-01', 'SMOKE-01', 'SMOKE-01']) {
      const b = g.buy(id);
      out.push([id, b.ok, b.reason ?? null, T.money(), document.querySelector('.buy-feedback').textContent]);
    }
    T.run(1);
    g.updateBuyMenu();
    return {
      m0,
      out,
      nades: { ...g.buyLoadout.grenades },
      hud: document.querySelector('.hud .utility').textContent,
      hudShown: !document.querySelector('.hud .utility').hidden,
      tags: ['FLASH-01', 'SMOKE-01'].map((id) => [document.querySelector(`.buy-card[data-id="${id}"]`).dataset.state, document.querySelector(`.buy-card[data-id="${id}"] .buy-tag`).textContent]),
      loadout: document.querySelector('.buy-loadout').textContent,
    };
  });
  assert.equal(r.m0, 3000);
  assert.deepEqual(r.out, [
    ['FLASH-01', true, null, 2700, 'FLASH-01 구매 완료 (1/2, -$300)'],
    ['FLASH-01', true, null, 2400, 'FLASH-01 구매 완료 (2/2, -$300)'],
    ['FLASH-01', false, 'owned', 2400, 'FLASH-01: 최대 2개까지 보유할 수 있습니다'],
    ['SMOKE-01', true, null, 2000, 'SMOKE-01 구매 완료 (1/1, -$400)'],
    ['SMOKE-01', false, 'owned', 2000, 'SMOKE-01: 최대 1개까지 보유할 수 있습니다'],
  ]);
  assert.deepEqual(r.nades, { flash: 2, smoke: 1 });
  assert.equal(r.hudShown, true);
  assert.equal(r.hud, '섬광 ×2연막 ×1');
  assert.deepEqual(r.tags, [
    ['owned', '보유 중 (2/2)'],
    ['owned', '보유 중 (1/1)'],
  ]);
  assert.match(r.loadout, /FLASH ×2 · SMOKE ×1/);
});

test('key 4 takes out a flash (then the smoke on the next press); a weapon key puts it away; no throw before the round is live', async () => {
  await page.keyboard.press('Digit4');
  await run(2);
  const a = await page.evaluate(() => ({ held: window.game.heldGrenade, name: document.querySelector('.weapon-name').textContent, lit: document.querySelector('.ut-flash').classList.contains('held') }));
  await page.keyboard.press('Digit4');
  await run(2);
  const b = await page.evaluate(() => window.game.heldGrenade);
  await page.keyboard.press('Digit4');
  await run(30);
  // Prep phase: a click does not throw.
  await page.mouse.down();
  await run(3);
  await page.mouse.up();
  await run(2);
  const prep = await page.evaluate(() => ({ phase: window.game.teamMatch.phase, flying: window.game.grenades.grenades.length, nades: { ...window.game.buyLoadout.grenades } }));
  await page.keyboard.press('Digit3');
  await run(2);
  const c = await page.evaluate(() => ({ held: window.game.heldGrenade, weapon: window.game.weapons.weapon.def.id }));
  assert.deepEqual(a, { held: 'flash', name: 'FLASH-01', lit: true });
  assert.equal(b, 'smoke');
  assert.deepEqual(prep, { phase: 'prep', flying: 0, nades: { flash: 2, smoke: 1 } });
  assert.deepEqual(c, { held: null, weapon: 'karambit' });
});

test('a real throw: one flash used, it flies, bounces on the map, never goes through the floor, goes off at 1.6 s', async () => {
  const r0 = await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    T.until('live');
    // The player is not the subject of these checks: kept alive (protected) while the bots fight.
    g.combat.protection = 1e9;
    // Face the longest open line, a little downward.
    const c = T.clearDir();
    g.player.yaw = c.yaw;
    g.player.pitch = -0.1;
    T.bounces = 0;
    T.flashes = [];
    const ev = g.grenades.events;
    const onBounce = ev.onBounce;
    ev.onBounce = (n, s) => {
      T.bounces++;
      onBounce(n, s);
    };
    const onFlash = ev.onFlash;
    ev.onFlash = (n, blinded) => {
      T.flashes.push({ at: n.position.toArray(), age: n.age, blinded });
      onFlash(n, blinded);
    };
    T.run(2);
    return { floor: g.player.position.y, open: c.len };
  });
  await page.keyboard.press('Digit4');
  await run(30); // drawn (0.35 s)
  await page.mouse.down();
  await run(2);
  await page.mouse.up();
  const r = await page.evaluate((floor) => {
    const g = window.game;
    const T = window.T;
    const thrown = { flying: g.grenades.grenades.length, nades: { ...g.buyLoadout.grenades }, held: g.heldGrenade };
    const n = g.grenades.grenades[0];
    const start = n.position.clone();
    let minY = Infinity;
    let ticks = 0;
    while (g.grenades.grenades.length && ticks < 600) {
      T.run(1);
      ticks++;
      if (g.grenades.grenades[0]) minY = Math.min(minY, g.grenades.grenades[0].position.y);
    }
    return { thrown, start: start.toArray(), travelled: Math.hypot(T.flashes[0].at[0] - start.x, T.flashes[0].at[2] - start.z), minY, floor, ticks, flash: T.flashes[0], bounces: T.bounces, weapon: g.weapons.weapon.def.id };
  }, r0.floor);
  assert.deepEqual(r.thrown, { flying: 1, nades: { flash: 1, smoke: 1 }, held: null }, 'one flash off the belt, back to the weapon');
  assert.ok(r.travelled > 4, `thrown some distance (${r.travelled.toFixed(1)} m along a ${r0.open.toFixed(1)} m open line)`);
  assert.ok(r.minY > r.floor - 0.3, `stays above the floor (${r.minY.toFixed(2)} vs ${r.floor.toFixed(2)})`);
  assert.ok(Math.abs(r.flash.age - 1.6) < 0.02, `fuse ${r.flash.age.toFixed(3)} s`);
  assert.ok(r.bounces >= 1, `bounced (${r.bounces})`);
  assert.equal(r.weapon, 'karambit');
});

test('flash blind time: falls off with distance and view angle, zero behind a wall or out of range', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    const c = T.clearDir();
    const at = (d) => c.eye.clone().addScaledVector(c.dir, d);
    const back = c.dir.clone().negate();
    const blind = (view, p) => +g.grenades.flashBlind(c.eye, view, p).toFixed(3);
    // A wall: the first map hit in some direction.
    let wall = null;
    for (let k = 0; k < 24 && !wall; k++) {
      const a = (k / 24) * Math.PI * 2;
      const d = new T.V(-Math.sin(a), 0, -Math.cos(a));
      const hit = g.map.collision.raycast(c.eye, d, 15);
      if (hit !== null && hit > 1.5) wall = { d, hit };
    }
    return {
      near: blind(c.dir, at(3)),
      mid: blind(c.dir, at(Math.min(10, c.len - 1))),
      side: blind(new T.V(c.dir.z, 0, -c.dir.x), at(3)),
      behind: blind(back, at(3)),
      beyondWall: wall ? blind(wall.d, c.eye.clone().addScaledVector(wall.d, wall.hit + 1)) : null,
      beforeWall: wall ? blind(wall.d, c.eye.clone().addScaledVector(wall.d, wall.hit * 0.5)) : null,
      far: blind(c.dir, at(25)),
    };
  });
  assert.ok(r.near > 4 && r.near <= 4.5, `facing at 3 m: ${r.near}`);
  assert.ok(r.mid < r.near && r.mid > 0, `farther is shorter: ${r.mid}`);
  assert.ok(r.side < r.near && r.side > r.behind, `side ${r.side}`);
  assert.ok(r.behind > 0 && r.behind < 0.7, `behind: short (${r.behind})`);
  assert.notEqual(r.beyondWall, null, 'found a wall to test against');
  assert.equal(r.beyondWall, 0, 'behind a wall: no effect');
  assert.ok(r.beforeWall > 0, 'same direction, this side of the wall: blinded');
  assert.equal(r.far, 0, 'beyond 24 m: nothing');
});

test('player flashed: white screen at full for most of the time, then fades; the HUD clears when it is over', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    const c = T.clearDir();
    g.player.yaw = c.yaw;
    g.player.pitch = 0;
    T.run(1);
    T.flashAt(c.eye.clone().addScaledVector(c.dir, 3));
    T.run(1);
    const opacity = () => +getComputedStyle(document.querySelector('.flash-white')).opacity;
    const t0 = g.flashBlind;
    const full = opacity();
    T.run(Math.round((t0 - 1.0) * 60)); // 1 s left: fading
    const fading = opacity();
    T.run(90);
    return { t0, full, fading, after: opacity(), blind: g.flashBlind, cls: document.querySelector('.hud').classList.contains('flashed') };
  });
  assert.ok(r.t0 > 4, `blinded ${r.t0.toFixed(2)} s`);
  assert.equal(r.full, 1);
  assert.ok(r.fading > 0.5 && r.fading < 0.85, `fading (${r.fading})`);
  assert.equal(r.after, 0);
  assert.equal(r.blind, 0);
  assert.equal(r.cls, false);
});

/** One RED bot alive (the rest down), standing `dist` m from the player along the open line, facing the player. */
async function duel(dist) {
  return page.evaluate((dist) => {
    const g = window.game;
    const T = window.T;
    const bots = g.squad.bots;
    const red = bots.find((b) => b.team === 'red' && b.alive);
    for (const b of bots) if (b !== red && b.alive && b.team === 'blue') T.kill(b.combat);
    for (const b of bots) if (b !== red && b.alive) T.kill(b.combat);
    const c = T.clearDir();
    const p = c.eye.clone().addScaledVector(c.dir, dist);
    p.y = g.player.position.y;
    red.controller.teleport(p, c.yaw + Math.PI);
    red.mode = 'wander';
    red.target = null;
    red.blindTime = 0;
    red.combat.protection = 0;
    g.combat.health = 100;
    T.red = red;
    return { id: red.id, alive: g.teamAlive() };
  }, dist);
}

test('bot flashed: sees nobody and holds fire while blind, then engages again', async () => {
  const d = await duel(7);
  assert.equal(d.alive.red, 1);
  const r = await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    const red = T.red;
    g.combat.protection = 1e9;
    T.run(30);
    const seen = red.mode === 'engage' && red.target?.id === 'local';
    // Flash right in front of the bot, at its eye height.
    const c = red.controller;
    const eye = new T.V(c.position.x, c.position.y + c.eyeHeight, c.position.z);
    const view = new T.V(-Math.sin(c.yaw), 0, -Math.cos(c.yaw));
    T.flashAt(eye.clone().addScaledVector(view, 2));
    T.run(1);
    const blind = red.blindTime;
    const shots0 = red.weapons.shotsFired;
    T.run(60);
    const during = { mode: red.mode, shots: red.weapons.shotsFired - shots0, blind: red.blindTime };
    T.run(Math.ceil(red.blindTime * 60) + 60);
    return { seen, blind, during, afterMode: red.mode, afterBlind: red.blindTime };
  });
  assert.equal(r.seen, true, 'engaging the player before the flash');
  assert.ok(r.blind > 3.5, `blinded ${r.blind.toFixed(2)} s`);
  assert.notEqual(r.during.mode, 'engage', 'lost the target while blind');
  assert.equal(r.during.shots, 0, 'no shots while blind');
  assert.equal(r.afterBlind, 0);
  assert.equal(r.afterMode, 'engage', 'sees and engages again once recovered');
});

test('smoke: a cloud between bot and player blocks the bot’s sight; it lasts its duration, then the bot sees again', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    const red = T.red;
    const c = red.controller;
    const mid = g.player.position.clone().add(c.position).multiplyScalar(0.5);
    mid.y = g.player.position.y;
    // A smoke grenade resting there, popping now.
    g.grenades.grenades.push({ id: 9500, kind: 'smoke', owner: 'test', position: mid.clone(), velocity: new T.V(), age: 1.5, resting: true });
    T.run(1);
    const cloud = g.grenades.smokes[0];
    T.run(80); // fully bloomed
    const eyeP = new T.V(g.player.position.x, g.player.position.y + g.player.eyeHeight, g.player.position.z);
    const eyeB = new T.V(c.position.x, c.position.y + c.eyeHeight, c.position.z);
    const blocked = g.grenades.sightBlocked(eyeB, eyeP);
    red.mode = 'wander';
    red.target = null;
    const shots0 = red.weapons.shotsFired;
    // Held on its spot (perception only: walking into the cloud would put it inside, where it sees again).
    const spot = c.position.clone();
    const yaw = c.yaw;
    for (let i = 0; i < 90; i++) {
      T.run(1);
      c.teleport(spot, yaw);
    }
    const inSmoke = { mode: red.mode, shots: red.weapons.shotsFired - shots0 };
    const puffs = g.grenadeFx.puffCount;
    const left = Math.ceil((16 - cloud.age) * 60) + 5;
    for (let i = 0; i < left; i++) {
      T.run(1);
      c.teleport(spot, yaw);
    }
    const gone = { smokes: g.grenades.smokes.length, puffs: g.grenadeFx.puffCount };
    for (let i = 0; i < 30; i++) {
      T.run(1);
      c.teleport(spot, yaw);
    }
    return { popped: !!cloud, centre: cloud.center.y - mid.y, blocked, inSmoke, puffs, gone, afterMode: red.mode };
  });
  assert.equal(r.popped, true);
  assert.ok(Math.abs(r.centre - 1.1) < 0.2, 'cloud centred 1.1 m above the grenade');
  assert.equal(r.blocked, true);
  assert.notEqual(r.inSmoke.mode, 'engage', 'the bot cannot see through the smoke');
  assert.equal(r.inSmoke.shots, 0);
  assert.equal(r.puffs, 22, 'one cloud of 22 puffs drawn');
  assert.deepEqual(r.gone, { smokes: 0, puffs: 0 }, 'gone after 16 s, nothing left drawn');
  assert.equal(r.afterMode, 'engage', 'sees the player again');
});

test('round change: grenades in flight and clouds removed, blindness cleared; a survivor keeps unused grenades, the dead lose them', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    // Something in the air, a cloud, and the player blinded.
    const c = T.clearDir();
    g.grenades.throw('flash', 'test', c.eye, c.dir);
    g.grenades.grenades.push({ id: 9600, kind: 'smoke', owner: 'test', position: g.player.position.clone(), velocity: new T.V(), age: 1.5, resting: true });
    T.run(1);
    g.flashBlind = 3;
    const before = { flying: g.grenades.grenades.length, smokes: g.grenades.smokes.length, nades: { ...g.buyLoadout.grenades } };
    // The player survives: end the round by killing the last red.
    g.combat.protection = 0;
    for (const b of g.squad.bots) if (b.alive && b.team === 'red') T.kill(b.combat);
    T.until('prep');
    T.run(2);
    const next = { flying: g.grenades.grenades.length, smokes: g.grenades.smokes.length, blind: g.flashBlind, nades: { ...g.buyLoadout.grenades }, puffs: g.grenadeFx.puffCount, overlay: +getComputedStyle(document.querySelector('.flash-white')).opacity };
    // Now the player dies in the next round.
    T.until('live');
    T.kill(g.combat);
    T.until('prep');
    return { before, next, dead: { ...g.buyLoadout.grenades }, hud: document.querySelector('.hud .utility').hidden };
  });
  assert.ok(r.before.flying >= 1 && r.before.smokes === 1);
  assert.deepEqual(r.next, { flying: 0, smokes: 0, blind: 0, nades: r.before.nades, puffs: 0, overlay: 0 });
  assert.deepEqual(r.before.nades, { flash: 1, smoke: 1 }, 'the one flash thrown earlier is gone, the rest carried');
  assert.deepEqual(r.dead, { flash: 0, smoke: 0 });
  assert.equal(r.hud, true);
  assert.deepEqual(page.errors, []);
});
