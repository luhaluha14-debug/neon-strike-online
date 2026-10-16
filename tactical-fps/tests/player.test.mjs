// Player health, damage, death and respawn (src/player/PlayerCombat.ts + Game).
//
// There are no enemies yet, so shots at the player are fired through the
// game's own HitscanSystem with a test shooter id ('bot-test'), exactly as a
// bot's WeaponSystem would. Movement / firing while dead and the respawn are
// driven with real keyboard and mouse input and fixed 1/60 s frames.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, openGame, installFrameDriver, LOAD_TIMEOUT } from './harness.mjs';

let env;
let page;
const run = (n) => page.evaluate((n) => window.T.run(n), n);

before(async () => {
  env = await startEnv();
  page = await openGame(env, { map: 'warehouse' });
  await page.click('.play-button');
  await page.waitForFunction(() => !!document.pointerLockElement && document.querySelector('.hud').classList.contains('playing'));
  // Under pointer lock, headless Chromium reports each press as a movement equal to the
  // cursor position; park the cursor at (0, 0) so presses carry no movement.
  await page.mouse.move(0, 0);
  await installFrameDriver(page);
  await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    T.stopLoop();
    T.vmRenders = 0;
    const vmRender = g.viewModel.render.bind(g.viewModel);
    g.viewModel.render = (r) => {
      T.vmRenders++;
      vmRender(r);
    };
    T.damage = [];
    const show = g.hud.showDamage.bind(g.hud);
    g.hud.showDamage = (amount, angle) => {
      T.damage.push({ amount, angle });
      show(amount, angle);
    };
    /** Fires one round at the player from `range` m away in direction `fromYaw` (0 = in front of the view). */
    T.shootPlayer = async (part, weaponId = 'ar01', { range = 8, fromYaw = 0, sourceId = 'bot-test' } = {}) => {
      const { computeDamage } = await import('/src/combat/HitscanSystem.ts');
      const p = g.player;
      const V = p.position.constructor;
      const h = { head: p.height - 0.12, body: p.height * 0.7, legs: p.height * 0.3 }[part];
      const aim = new V(p.position.x, p.position.y + h, p.position.z);
      const a = p.yaw + fromYaw;
      const origin = aim.clone().add(new V(-Math.sin(a), 0, -Math.cos(a)).multiplyScalar(range));
      const dir = aim.clone().sub(origin).normalize();
      const w = g.weapons.loadout.find((x) => x.def.id === weaponId).def;
      const before = p.health;
      const res = g.hitscan.fire({ origin, direction: dir, damage: w.damage, sourceId, weaponId });
      return { kind: res.kind, id: res.target?.id, zone: res.zone, damage: res.damage, expected: res.zone ? computeDamage(w.damage, res.zone, res.distance) : null, drop: before - p.health, health: p.health };
    };
    T.state = () => ({
      alive: g.combat.alive,
      health: g.player.health,
      pos: g.player.position.toArray(),
      yaw: g.player.yaw,
      shots: g.weapons.shotsFired,
      mag: g.weapons.weapon.magazine,
      dead: document.querySelector('.hud').classList.contains('dead'),
      panel: !document.querySelector('.death').hidden,
      seconds: document.querySelector('.death-seconds').textContent,
      bodyVisible: g.body.object.visible,
    });
  });
  await run(90); // land, spawn protection (1 s) over
});
after(async () => {
  await page?.context().close();
  await env?.close();
});

test('the player is a hitscan target: zones, damage from the existing computeDamage, health drops', async () => {
  const r = [];
  for (const [part, zone] of [['head', 'head'], ['body', 'body'], ['legs', 'limb']]) {
    await page.evaluate(() => window.game.respawn());
    await run(70);
    r.push({ part, zone, ...(await page.evaluate((p) => window.T.shootPlayer(p), part)) });
  }
  for (const s of r) {
    assert.equal(s.kind, 'target', s.part);
    assert.equal(s.id, 'local');
    assert.equal(s.damage, s.expected, s.part);
    assert.equal(s.drop, Math.min(s.damage, 100), s.part);
  }
  assert.deepEqual(r.map((s) => s.zone), ['head', 'body', 'limb']);
  // AR-01 at 8 m: 128 / 32 / 26.
  assert.deepEqual(r.map((s) => s.damage), [128, 32, 26]);
});

test("the player's own rounds never hit the player", async () => {
  await page.evaluate(() => window.game.respawn());
  await run(70);
  const r = await page.evaluate(() => window.T.shootPlayer('body', 'ar01', { sourceId: 'local' }));
  assert.notEqual(r.kind, 'target');
  assert.equal(r.drop, 0);
});

test('health stops at 0; death; a dead player takes no further damage and is not a target', async () => {
  await page.evaluate(() => window.game.respawn());
  await run(70);
  const r = await page.evaluate(async () => {
    const T = window.T;
    T.damage = [];
    const a = await T.shootPlayer('body'); // 32
    const b = await T.shootPlayer('head', 'sr01'); // 460 → 0
    const c = await T.shootPlayer('body');
    return { a, b, c, alive: window.game.combat.alive, feedback: T.damage.length };
  });
  assert.equal(r.a.health, 68);
  assert.equal(r.b.health, 0, 'never below 0');
  assert.equal(r.b.drop, 68);
  assert.equal(r.alive, false);
  assert.notEqual(r.c.kind, 'target', 'shots pass a dead player');
  assert.equal(r.c.drop, 0);
  assert.equal(r.feedback, 2, 'hit feedback once per damaging hit');
});

test('while dead: real keys and mouse do not move, turn or shoot; F4 ignored; death panel counts down', async () => {
  // Still dead from the previous test.
  const s0 = await page.evaluate(() => window.T.state());
  assert.equal(s0.alive, false);
  await page.keyboard.down('KeyW');
  await page.mouse.down();
  await page.mouse.move(200, 120); // look input
  await run(30);
  await page.keyboard.press('F4');
  await run(30);
  await page.mouse.up();
  await page.keyboard.up('KeyW');
  await page.mouse.move(0, 0);
  await run(1);
  const s1 = await page.evaluate(() => window.T.state());
  const vm = await page.evaluate(() => {
    const T = window.T;
    const n = T.vmRenders;
    T.run(5);
    return T.vmRenders - n;
  });
  assert.equal(s1.alive, false, 'F4 does not skip the death');
  assert.ok(Math.hypot(s1.pos[0] - s0.pos[0], s1.pos[2] - s0.pos[2]) < 1e-6, 'no movement while dead');
  assert.equal(s1.yaw, s0.yaw, 'no mouse look while dead');
  assert.equal(s1.shots, s0.shots, 'no firing while dead');
  assert.equal(s1.mag, s0.mag);
  assert.equal(vm, 0, 'no weapon drawn while dead');
  assert.equal(s1.bodyVisible, false);
  assert.equal(s1.dead, true);
  assert.equal(s1.panel, true);
  assert.ok(Number(s1.seconds) < Number(s0.seconds), `countdown ${s0.seconds} → ${s1.seconds}`);
});

test('respawn after 3 s: full health, home spawn, ammo reset, panel gone, controls work', async () => {
  await page.evaluate(() => window.game.respawn());
  await run(70);
  // Fire a few rounds first so the ammo reset is visible.
  await page.mouse.down();
  await run(20);
  await page.mouse.up();
  await run(5);
  const before = await page.evaluate(async () => {
    await window.T.shootPlayer('head', 'sr01');
    return window.T.state();
  });
  assert.equal(before.alive, false);
  assert.ok(before.mag < 30);
  // 3.0 s at 1/60 s frames = 180 frames.
  await run(178);
  const almost = await page.evaluate(() => window.T.state());
  await run(3);
  const after = await page.evaluate(() => {
    const g = window.game;
    return { ...window.T.state(), spawn: g.spawnPoint.position.toArray(), protection: g.combat.protection };
  });
  assert.equal(almost.alive, false, 'still dead just before 3 s');
  assert.equal(after.alive, true, 'alive right after 3 s');
  assert.equal(after.health, 100);
  assert.equal(after.mag, 30, 'ammo reset by the existing respawn rule');
  assert.equal(after.dead, false);
  assert.equal(after.panel, false);
  assert.equal(after.bodyVisible, true);
  assert.ok(Math.hypot(after.pos[0] - after.spawn[0], after.pos[2] - after.spawn[2]) < 1e-6, 'at the spawn point');
  assert.ok(after.protection > 0, 'spawn protection running');

  // Controls work right away.
  await run(60);
  const p0 = await page.evaluate(() => window.T.state());
  await page.keyboard.down('KeyW');
  await run(30);
  await page.keyboard.up('KeyW');
  await page.mouse.down();
  await run(2);
  await page.mouse.up();
  await run(5);
  const p1 = await page.evaluate(() => window.T.state());
  assert.ok(Math.hypot(p1.pos[0] - p0.pos[0], p1.pos[2] - p0.pos[2]) > 1, 'moves after respawn');
  assert.equal(p1.shots, p0.shots + 1, 'fires after respawn');
});

test('spawn protection: no damage for 1 s after spawning, normal damage after', async () => {
  await page.evaluate(() => window.game.respawn());
  await run(1);
  const early = await page.evaluate(() => window.T.shootPlayer('body'));
  await run(60);
  const late = await page.evaluate(() => window.T.shootPlayer('body'));
  assert.equal(early.drop, 0);
  assert.equal(early.health, 100);
  assert.equal(late.drop, 32);
});

test('hit feedback: direction marker points at the shooter, red edges, health panel flash', async () => {
  await page.evaluate(() => window.game.respawn());
  await run(70);
  const r = await page.evaluate(async () => {
    const T = window.T;
    T.damage = [];
    // 2 m away so no wall near the spawn is in between (checked: each round must hit the player).
    const hits = [];
    hits.push((await T.shootPlayer('body', 'ar01', { fromYaw: -Math.PI / 2, range: 2 })).kind); // from the right
    const right = T.damage.at(-1).angle;
    hits.push((await T.shootPlayer('body', 'ar01', { fromYaw: 0, range: 2 })).kind); // from ahead
    const ahead = T.damage.at(-1).angle;
    hits.push((await T.shootPlayer('body', 'ar01', { fromYaw: Math.PI, range: 2 })).kind); // from behind
    const behind = T.damage.at(-1).angle;
    const running = (sel) => document.querySelector(sel).getAnimations().length;
    return { hits, right, ahead, behind, vignette: running('.damage-vignette'), dir: running('.damage-dir'), vitals: running('.vitals'), health: window.game.player.health, hudHealth: document.querySelector('.health-value').textContent };
  });
  assert.deepEqual(r.hits, ['target', 'target', 'target']);
  assert.ok(Math.abs(r.right - Math.PI / 2) < 1e-6, `right: ${r.right}`);
  assert.ok(Math.abs(r.ahead) < 1e-6, `ahead: ${r.ahead}`);
  assert.ok(Math.abs(Math.abs(r.behind) - Math.PI) < 1e-6, `behind: ${r.behind}`);
  assert.equal(r.vignette, 1);
  assert.equal(r.dir, 1);
  assert.equal(r.vitals, 1);
  await run(1);
  assert.equal(await page.evaluate(() => document.querySelector('.health-value').textContent), String(r.health));
});

test('training targets are unaffected: the player shoots a dummy, the dummy (not the player) takes the damage', async () => {
  await page.evaluate(() => window.game.respawn());
  await run(70);
  const r = await page.evaluate(() => {
    const g = window.game;
    const t = g.trainingRange.targets.find((x) => x.motion.sweep === 0);
    const p = g.player;
    const V = p.position.constructor;
    const eye = new V(p.position.x, p.position.y + p.eyeHeight, p.position.z);
    const aim = new V(0, 1.2, 0.14).applyMatrix4(t.pivot.matrixWorld);
    const d = aim.clone().sub(eye).normalize();
    p.yaw = Math.atan2(-d.x, -d.z);
    p.pitch = Math.asin(d.y);
    return { target: t.health, player: p.health };
  });
  await page.mouse.down();
  await run(2);
  await page.mouse.up();
  await run(5);
  const after = await page.evaluate(() => {
    const g = window.game;
    return { target: g.trainingRange.targets.find((x) => x.motion.sweep === 0).health, player: g.player.health };
  });
  assert.equal(after.target, r.target - 32);
  assert.equal(after.player, 100);
});

test('spawn points are free of map geometry on both maps; dying and switching maps uses the new map', async () => {
  const check = () =>
    page.evaluate(async () => {
      const g = window.game;
      const THREE = await import('/node_modules/three/build/three.module.js');
      const { PLAYER_CONFIG } = await import('/src/config.ts');
      const s = g.spawnPoint;
      const r = PLAYER_CONFIG.radius;
      const seg = new THREE.Line3(new THREE.Vector3(s.position.x, s.position.y + 0.1 + r + 0.05, s.position.z), new THREE.Vector3(s.position.x, s.position.y + 0.1 + PLAYER_CONFIG.standHeight - r, s.position.z));
      const own = [...g.map.attackSpawns, ...g.map.defenseSpawns].includes(s);
      return {
        map: g.mapDef.id,
        own,
        free: !g.map.collision.capsuleOverlaps(seg, r - 0.02),
        alive: g.combat.alive,
        health: g.player.health,
        registered: [...g.hitscan.targets].filter((t) => t.id === 'local').length,
        panel: !document.querySelector('.death').hidden,
      };
    });
  await page.evaluate(() => window.game.respawn());
  const wh = await check();
  // Die, then switch maps before the respawn timer runs out.
  await run(70);
  await page.evaluate(() => window.T.shootPlayer('head', 'sr01'));
  assert.equal(await page.evaluate(() => window.game.combat.alive), false);
  await page.evaluate(() => window.game.switchMap('seoul'));
  await page.waitForFunction(() => window.game.mapDef.id === 'seoul' && window.game.combat && !document.querySelector('.play-button').disabled, null, { timeout: LOAD_TIMEOUT });
  const seoul = await check();
  assert.deepEqual(wh, { map: 'warehouse', own: true, free: true, alive: true, health: 100, registered: 1, panel: false });
  assert.deepEqual(seoul, { map: 'seoul', own: true, free: true, alive: true, health: 100, registered: 1, panel: false });
});

test('no page errors', () => {
  assert.deepEqual(page.errors, []);
});
