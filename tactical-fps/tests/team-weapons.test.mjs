// SMG-01 / SG-01 / PIS-01 (the team match buy-menu weapons) through the real
// weapon system with real mouse / keyboard input: fire rate and mode,
// magazine and reserve, reload, recoil, the shotgun's pellets (one round,
// one sound, eight hitscans), and switching. Frames are driven at a fixed
// 1/60 s. Training dummies are taken out of the hitscan as in
// weapons-audio.test.mjs (this file checks weapon handling, not hits).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, openGame, installFrameDriver } from './harness.mjs';

let env;
let page;

const run = (n) => page.evaluate((n) => window.T.run(n), n);
const take = () =>
  page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    const sounds = {};
    for (const e of T.log) if (e.ok) sounds[e.id] = (sounds[e.id] ?? 0) + 1;
    const w = g.weapons.weapon;
    const out = { sounds, pellets: T.pellets, dirs: T.dirs, flashes: T.flashes, rounds: g.weapons.shotsFired - T.shots0, mag: w.magazine, reserve: w.reserve, weapon: w.def.id, pitch: g.player.pitch };
    T.log = [];
    T.pellets = 0;
    T.dirs = [];
    T.flashes = 0;
    T.shots0 = g.weapons.shotsFired;
    return out;
  });
const hold = async (frames) => {
  await page.mouse.down();
  await run(frames);
  await page.mouse.up();
  await run(2);
};
const click = async () => {
  await page.mouse.down();
  await run(2);
  await page.mouse.up();
  await run(2);
};

before(async () => {
  env = await startEnv();
  page = await openGame(env, { map: 'warehouse' });
  await page.click('.play-button');
  await page.waitForFunction(() => document.pointerLockElement !== null && window.game.input.active && window.game.audio.state === 'running', null, { timeout: 30000 });
  await page.evaluate(() => window.game.audio.ready);
  await installFrameDriver(page);
  await page.evaluate(async () => {
    const g = window.game;
    const T = window.T;
    T.stopLoop();
    for (const t of g.trainingRange.targets) g.hitscan.unregister(t);
    const { WEAPONS } = await import('/src/weapons/weapons.ts');
    g.weapons.setLoadout([WEAPONS.smg01, WEAPONS.sg01, WEAPONS.pis01, WEAPONS.karambit]);
    T.log = [];
    T.pellets = 0;
    T.dirs = [];
    T.flashes = 0;
    T.shots0 = g.weapons.shotsFired;
    const play = g.audio.play.bind(g.audio);
    g.audio.play = (id, o = {}) => {
      const ok = play(id, o);
      T.log.push({ id, ok });
      return ok;
    };
    const onShot = g.viewModel.onShot.bind(g.viewModel);
    g.viewModel.onShot = (c) => {
      T.flashes++;
      onShot(c);
    };
    const ev = g.weapons.events;
    const shot = ev.onShot;
    ev.onShot = (r, origin, dir, weapon, pellet) => {
      T.pellets++;
      T.dirs.push(dir.toArray().map((v) => +v.toFixed(4)).join(','));
      shot(r, origin, dir, weapon, pellet);
    };
  });
  await run(60); // draw
  await take();
});
after(async () => {
  await page?.context().close();
  await env?.close();
});

test('SMG-01: full auto at 800 RPM, one shot sound and flash per round, view climbs, 30 / 120', async () => {
  const r0 = await take();
  assert.equal(r0.weapon, 'smg01');
  await hold(60); // 1.0 s: rounds at 0, 75 ms, ..., 975 ms
  const r = await take();
  assert.equal(r.rounds, 14);
  assert.equal(r.pellets, 14, 'one bullet per round');
  assert.equal(r.flashes, 14);
  assert.equal(r.sounds['smg01.shot'], 14);
  assert.deepEqual([r.mag, r.reserve], [16, 120]);
  assert.ok(r.pitch > r0.pitch + 0.02, `recoil climbs (${r0.pitch.toFixed(3)} -> ${r.pitch.toFixed(3)})`);
});

test('SMG-01 reload: 2.1 s, refills from the reserve', async () => {
  await page.keyboard.press('KeyR');
  await run(120); // 2.0 s: not yet
  const mid = await take();
  assert.equal(mid.mag, 16);
  await run(10);
  const r = await take();
  assert.deepEqual([r.mag, r.reserve], [30, 106]);
  assert.equal(r.sounds['mag.out'] ?? mid.sounds['mag.out'], 1);
});

test('SG-01: pump action, one round = one blast + one pump + 8 pellets in a cone; 8 / 32', async () => {
  await page.keyboard.press('Digit2');
  await run(60);
  await take();
  await hold(30); // held: semi-auto fires once
  const r = await take();
  assert.equal(r.weapon, 'sg01');
  assert.equal(r.rounds, 1);
  assert.equal(r.pellets, 8, 'eight hitscans');
  assert.equal(new Set(r.dirs).size, 8, 'each pellet its own direction');
  assert.equal(r.flashes, 1);
  assert.equal(r.sounds['sg01.shot'], 1, 'one blast, not eight');
  assert.equal(r.sounds['sg01.pump'], 1);
  assert.equal(r.mag, 7);
  // Pellet cone: all within ~3.2° (+ the standing spread of 0) of their mean.
  const v = r.dirs.map((d) => d.split(',').map(Number));
  const mean = [0, 1, 2].map((k) => v.reduce((s, x) => s + x[k], 0) / v.length);
  const len = Math.hypot(...mean);
  const maxAngle = Math.max(...v.map((x) => Math.acos(Math.min(1, (x[0] * mean[0] + x[1] * mean[1] + x[2] * mean[2]) / len))));
  assert.ok(maxAngle < (6.5 * Math.PI) / 180, `pellets within the cone (${((maxAngle * 180) / Math.PI).toFixed(2)}°)`);
  // Pump time: a click 0.5 s after the shot does nothing, one after 0.9 s fires.
  await run(10);
  await click();
  assert.equal((await take()).rounds, 0);
  await run(30);
  await click();
  assert.equal((await take()).rounds, 1);
});

test('SG-01 reload: 3.2 s, shell cues, back to 8', async () => {
  await page.keyboard.press('KeyR');
  await run(200);
  const r = await take();
  assert.deepEqual([r.mag, r.reserve], [8, 30]);
  assert.equal(r.sounds['mag.in'], 3);
  assert.equal(r.sounds['sg01.pump'], 1, 'pumped at the end');
});

test('PIS-01: semi-auto, one round per click, 12 / 36, reload 1.8 s', async () => {
  await page.keyboard.press('Digit3');
  await run(40);
  await take();
  for (let i = 0; i < 12; i++) {
    await click();
    await run(8);
  }
  const r = await take();
  assert.equal(r.weapon, 'pis01');
  assert.equal(r.rounds, 12);
  assert.equal(r.sounds['pis01.shot'], 12);
  assert.equal(r.mag, 0);
  await click();
  assert.deepEqual((await take()).sounds, { dryfire: 1 });
  await page.keyboard.press('KeyR');
  await run(115);
  const re = await take();
  assert.deepEqual([re.mag, re.reserve], [12, 24]);
});

test('switching keeps each weapon’s own ammo', async () => {
  await page.keyboard.press('Digit1');
  await run(40);
  const smg = await take();
  await page.keyboard.press('Digit2');
  await run(50);
  const sg = await take();
  await page.keyboard.press('Digit3');
  await run(30);
  const pis = await take();
  assert.deepEqual(
    [smg.weapon, smg.mag, sg.weapon, sg.mag, pis.weapon, pis.mag],
    ['smg01', 30, 'sg01', 8, 'pis01', 12],
  );
  assert.deepEqual(page.errors, []);
});
