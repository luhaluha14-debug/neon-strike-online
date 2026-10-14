// Weapon handling and its wiring to sound and muzzle-flash events.
//
// Real mouse / keyboard input through Playwright, frames driven with fixed
// 1/60 s timestamps (Game.frame), so fire rates and reload timings are exact.
// Counts are taken where Game hands events to the audio engine
// (`AudioEngine.play`) and to the view model (`ViewModelLayer.onShot`).
// This checks event wiring and timing, not what the sounds sound like.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, openGame, installFrameDriver } from './harness.mjs';

let env;
let page;

const run = (n) => page.evaluate((n) => window.T.run(n), n);
/** Sound counts, shots, flashes and ammo since the last call. */
const take = () =>
  page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    const sounds = {};
    for (const e of T.log) if (e.ok) sounds[e.id] = (sounds[e.id] ?? 0) + 1;
    const out = {
      sounds,
      log: T.log,
      kinds: T.kinds,
      flashes: T.flashes,
      rounds: g.weapons.shotsFired - T.shots0,
      mag: g.weapons.weapon.magazine,
      reserve: g.weapons.weapon.reserve,
      weapon: g.weapons.weapon.def.id,
    };
    T.log = [];
    T.kinds = {};
    T.flashes = 0;
    T.shots0 = g.weapons.shotsFired;
    return out;
  });
/** Holds the trigger for `frames`, then lets the game see the release (as any real click does). */
const hold = async (frames) => {
  await page.mouse.down();
  await run(frames);
  await page.mouse.up();
  await run(2);
};

before(async () => {
  env = await startEnv();
  page = await openGame(env, { map: 'warehouse' });
  // The Play click is the user gesture that starts audio and pointer lock.
  await page.click('.play-button');
  await page.waitForFunction(() => document.pointerLockElement !== null && window.game.audio.state === 'running', null, { timeout: 30000 });
  await page.evaluate(() => window.game.audio.ready);
  await installFrameDriver(page);
  await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    T.stopLoop();
    // Isolation: training dummies stand in the line of fire from the spawn, and where the
    // moving one is depends on how long the page ran before the frame driver took over.
    // This file checks weapon -> sound / flash wiring and world impacts, so the dummies are
    // taken out of the hitscan here (nothing else changes). Hits on dummies, their confirm
    // sounds and hit markers are checked with real input in targets.test.mjs.
    const range = g.trainingRange;
    if (!range || range.targets.length < 3) throw new Error('expected the training dummies to be present');
    for (const t of range.targets) g.hitscan.unregister(t);
    if ([...g.hitscan.targets].some((t) => t.team === 'training')) throw new Error('dummies still registered');
    T.log = [];
    T.kinds = {};
    T.flashes = 0;
    T.shots0 = g.weapons.shotsFired;
    const play = g.audio.play.bind(g.audio);
    g.audio.play = (id, o = {}) => {
      const ok = play(id, o);
      T.log.push({ id, ok, delay: o.delay ?? 0, rp: +g.weapons.weapon.reloadProgress.toFixed(3) });
      return ok;
    };
    const onShot = g.viewModel.onShot.bind(g.viewModel);
    g.viewModel.onShot = (c) => {
      T.flashes++;
      onShot(c);
    };
    const ev = g.weapons.events;
    const shot = ev.onShot;
    ev.onShot = (r, ...rest) => {
      T.kinds[r.kind] = (T.kinds[r.kind] ?? 0) + 1;
      shot(r, ...rest);
    };
  });
  await run(10);
  await take();
});
after(async () => {
  await page?.context().close();
  await env?.close();
});

test('AR-01 full auto: 600 RPM, one gunshot and one muzzle flash per round', async () => {
  await hold(60); // 1.0 s
  const r = await take();
  assert.equal(r.weapon, 'ar01');
  assert.equal(r.rounds, 10);
  assert.equal(r.flashes, 10);
  // Recoil has random sideways jitter, so whether a round reaches a distant
  // wall varies run to run: every world hit must give exactly one impact sound.
  const { impact = 0, ...rest } = r.sounds;
  assert.deepEqual(rest, { 'ar01.shot': 10 });
  assert.equal(impact, r.kinds.world ?? 0);
  assert.equal(r.mag, 20);
  assert.equal(r.reserve, 90);
});

test('AR-01 empties the magazine, then each trigger pull on empty is one dry fire', async () => {
  await hold(200);
  const a = await take();
  assert.equal(a.rounds, 20);
  assert.equal(a.sounds['ar01.shot'], 20);
  assert.equal(a.sounds.impact ?? 0, a.kinds.world ?? 0);
  assert.equal(a.mag, 0);
  for (let i = 0; i < 3; i++) {
    await page.mouse.down();
    await run(3);
    await page.mouse.up();
    await run(6);
  }
  const b = await take();
  assert.equal(b.rounds, 0);
  assert.deepEqual(b.sounds, { dryfire: 3 });
});

test('AR-01 reload: refills 30 from reserve, cues match the magazine animation', async () => {
  await page.keyboard.press('KeyR');
  await run(140); // 2.33 s > 2.2 s reload
  const r = await take();
  assert.equal(r.mag, 30);
  assert.equal(r.reserve, 60);
  assert.deepEqual(r.sounds, { 'mag.out': 1, 'mag.in': 1, 'ar01.charge': 1 });
  const at = Object.fromEntries(r.log.map((e) => [e.id, e.rp]));
  assert.ok(at['mag.out'] >= 0.04 && at['mag.out'] < 0.08, `mag.out at ${at['mag.out']}`);
  assert.ok(at['mag.in'] >= 0.81 && at['mag.in'] < 0.84, `mag.in at ${at['mag.in']}`);
});

test('switch to SR-01: draw sound; semi-auto fires once per click with one bolt cycle', async () => {
  await page.keyboard.press('Digit2');
  await run(70); // 1.0 s equip
  const a = await take();
  assert.equal(a.weapon, 'sr01');
  assert.deepEqual(a.sounds, { 'equip.gun': 1 });

  await hold(3);
  await run(100);
  const b = await take();
  assert.equal(b.rounds, 1);
  const { impact = 0, ...srSounds } = b.sounds;
  assert.deepEqual(srSounds, { 'sr01.shot': 1, 'sr01.bolt': 1 });
  assert.equal(impact, b.kinds.world ?? 0);

  await hold(120); // holding the trigger for 2 s: still one shot
  await run(10);
  const c = await take();
  assert.equal(c.rounds, 1);
  assert.equal(c.mag, 3);
});

test('SR-01 reload cues; a reload cancelled by switching weapons plays no "magazine in"', async () => {
  await page.keyboard.press('KeyR');
  await run(225); // 3.75 s > 3.6 s
  const a = await take();
  assert.equal(a.mag, 5);
  assert.deepEqual(a.sounds, { 'mag.out': 1, 'mag.in': 1, 'sr01.chamber': 1 });

  await run(90);
  await hold(3);
  await run(5);
  await take();
  await run(180);
  await page.keyboard.press('KeyR');
  await run(110); // ~50 % of the reload
  await page.keyboard.press('Digit1');
  await run(60);
  const b = await take();
  assert.equal(b.sounds['mag.out'], 1);
  assert.equal(b.sounds['mag.in'], undefined);
  assert.equal(b.sounds['equip.gun'], 1);
  assert.equal(b.weapon, 'ar01');
});

test('Karambit: draw sound, one swing per attack at 120 per minute, hit sound on contact', async () => {
  await page.keyboard.press('Digit3');
  await run(30);
  const a = await take();
  assert.equal(a.weapon, 'karambit');
  assert.deepEqual(a.sounds, { 'equip.knife': 1 });

  await hold(63); // 1.05 s: attacks at 0, 0.5, 1.0 s
  await run(30);
  const b = await take();
  assert.equal(b.rounds, 3);
  assert.equal(b.sounds['karambit.swing'], 3);

  // Contact: feed a world hit through the game's own shot handler.
  const c = await page.evaluate(() => {
    const g = window.game;
    const V = g.camera.position.constructor;
    const p = g.camera.position.clone().add(new V(0, 0, -1.2));
    g.weapons.events.onShot({ kind: 'world', point: p, normal: new V(0, 0, 1), distance: 1.2 }, g.camera.position.clone(), new V(0, 0, -1), g.weapons.weapon);
    return window.T.log.map((e) => [e.id, e.delay]);
  });
  await take();
  assert.deepEqual(c, [
    ['karambit.swing', 0],
    ['karambit.hit', 0.03],
  ]);
});

test('weapon switch spam: one draw sound per switch, no voices left playing', async () => {
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press('Digit' + (1 + (i % 3)));
    await run(1);
  }
  const r = await take();
  assert.equal((r.sounds['equip.gun'] ?? 0) + (r.sounds['equip.knife'] ?? 0), 30);
  await page.keyboard.press('Digit1');
  await run(60);
  await take();
});

test('impacts: one impact sound per world hit; voices are capped and released', async () => {
  await page.evaluate(() => {
    window.game.respawn();
    window.game.player.pitch = -0.6; // at the ground
  });
  let maxVoices = 0;
  await page.mouse.down();
  for (let i = 0; i < 40; i++) {
    await run(5);
    maxVoices = Math.max(maxVoices, await page.evaluate(() => window.game.audio.activeVoices));
  }
  await page.mouse.up();
  const r = await take();
  assert.equal(r.rounds, 30);
  assert.equal(r.kinds.world, 30);
  assert.equal(r.sounds['ar01.shot'], 30);
  assert.equal(r.sounds.impact, 30);
  // Group caps: shot 10 + impact 6 + foley 6.
  assert.ok(maxVoices <= 22, `max voices ${maxVoices}`);
  await page.waitForFunction(() => window.game.audio.liveNodes === 0, null, { timeout: 10000 });
});

test('volume 0 plays nothing (setting respected)', async () => {
  await page.evaluate(() => window.game.audio.setVolume(0));
  await page.keyboard.press('KeyR');
  await run(140);
  await hold(30);
  const r = await take();
  assert.ok(r.rounds > 0);
  assert.deepEqual(r.sounds, {});
  await page.evaluate(() => window.game.audio.setVolume(0.75));
});

test('no page errors', () => {
  assert.deepEqual(page.errors, []);
});
