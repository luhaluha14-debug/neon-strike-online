// Hit feel (blood + flesh impact sound) and the controls page (mouse
// sensitivity, key bindings), driven with real clicks and key presses.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, openGame, waitReady, installFrameDriver } from './harness.mjs';

const CONTROLS_KEY = 'tactical-fps.controls.v1';
const SETTINGS_KEY = 'tactical-fps.settings.v1';

let env;
before(async () => {
  env = await startEnv();
});
after(async () => {
  await env?.close();
});

test('hitting a dummy: blood mist + droplets, a floor stain, flesh impact sound; all gone after respawn', async () => {
  const page = await openGame(env, { map: 'warehouse' });
  await page.click('.play-button');
  await page.waitForFunction(() => !!document.pointerLockElement && window.game.audio.state === 'running', null, { timeout: 30000 });
  await page.evaluate(() => window.game.audio.ready);
  // Headless Chromium reports presses under pointer lock as movement from (0, 0).
  await page.mouse.move(0, 0);
  await installFrameDriver(page);
  await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    T.stopLoop();
    T.log = [];
    const play = g.audio.play.bind(g.audio);
    g.audio.play = (id, o = {}) => {
      const ok = play(id, o);
      if (ok) T.log.push(id);
      return ok;
    };
    T.run(40);
    const t = g.trainingRange.targets.find((x) => x.motion.sweep === 0);
    const p = g.player;
    const V = p.position.constructor;
    const eye = new V(p.position.x, p.position.y + p.eyeHeight, p.position.z);
    const d = new V(0, 1.2, 0.14).applyMatrix4(t.pivot.matrixWorld).sub(eye).normalize();
    p.yaw = Math.atan2(-d.x, -d.z);
    p.pitch = Math.asin(d.y);
    T.log = [];
  });
  await page.mouse.down();
  await page.evaluate(() => window.T.run(2));
  await page.mouse.up();
  const hit = await page.evaluate(() => {
    const g = window.game;
    window.T.run(3);
    return { particles: g.blood.activeParticles, splats: g.blood.splatCount, sounds: window.T.log };
  });
  assert.ok(hit.particles >= 10, `blood particles: ${hit.particles}`);
  assert.ok(hit.splats >= 1, 'a stain on the floor below the hit');
  assert.ok(hit.sounds.includes('impact.flesh'), `sounds: ${hit.sounds}`);
  assert.ok(hit.sounds.includes('hit.body'));
  assert.ok(!hit.sounds.includes('impact'), 'no concrete impact sound on a body');

  const later = await page.evaluate(() => {
    window.T.run(60);
    return { particles: window.game.blood.activeParticles, splats: window.game.blood.splatCount };
  });
  assert.equal(later.particles, 0, 'particles fade out within a second');
  assert.equal(later.splats, hit.splats, 'stains stay');
  await page.evaluate(() => window.game.respawn());
  assert.deepEqual(await page.evaluate(() => [window.game.blood.activeParticles, window.game.blood.splatCount]), [0, 0]);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('controls page: sensitivity slider applies at once and is saved apart from the settings record', async () => {
  const page = await openGame(env, { width: 1280, height: 720 });
  await page.click('#tab-controls');
  await page.evaluate(() => {
    const r = document.querySelector('input[data-setting="sensitivity"]');
    r.value = '2.5';
    r.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const r = await page.evaluate(([ck, sk]) => ({
    applied: window.game.input.sensitivity,
    shown: document.querySelector('.range-value').textContent,
    saved: JSON.parse(localStorage.getItem(ck)).sensitivity,
    settingsKeys: localStorage.getItem(sk) ? Object.keys(JSON.parse(localStorage.getItem(sk))).sort() : null,
  }), [CONTROLS_KEY, SETTINGS_KEY]);
  assert.deepEqual(r, { applied: 2.5, shown: '2.50', saved: 2.5, settingsKeys: r.settingsKeys });
  // The settings record (if any) keeps exactly its existing fields.
  if (r.settingsKeys) assert.deepEqual(r.settingsKeys, ['frameLimit', 'mapId', 'quality', 'volume']);

  // Turning speed scales with it: the same mouse movement turns 2.5x as far.
  await page.click('.play-button');
  // pointerLockElement is set before the (async) pointerlockchange event the game reacts to.
  await page.waitForFunction(() => !!document.pointerLockElement && document.querySelector('.hud').classList.contains('playing'));
  await installFrameDriver(page);
  const turn = await page.evaluate(() => {
    const g = window.game;
    window.T.stopLoop();
    window.T.run(2);
    const move = (s) => {
      g.input.sensitivity = s;
      const y0 = g.player.yaw;
      document.dispatchEvent(new MouseEvent('mousemove', { movementX: -100, movementY: 0 }));
      window.T.run(1);
      return g.player.yaw - y0;
    };
    return { one: move(1), more: move(2.5) };
  });
  assert.ok(Math.abs(turn.more / turn.one - 2.5) < 1e-6, JSON.stringify(turn));
  await page.evaluate(() => document.exitPointerLock());
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('key binding: click a key, press a new one; conflicts swap; reserved keys and Esc are refused; reset; kept after reload', async () => {
  const page = await openGame(env, { width: 1280, height: 720 });
  await page.click('#tab-controls');
  const keyOf = (a) => page.evaluate((a) => document.querySelector(`.bind-key[data-action="${a}"]`).textContent, a);
  const bindings = () => page.evaluate(() => ({ ...window.game.input.bindings }));

  // Forward: W → I.
  await page.click('.bind-key[data-action="forward"]');
  assert.equal(await keyOf('forward'), '키를 누르세요…');
  await page.keyboard.press('KeyI');
  assert.equal(await keyOf('forward'), 'I');
  assert.equal((await bindings()).forward, 'KeyI');

  // Back onto I: the two swap (forward gets S).
  await page.click('.bind-key[data-action="back"]');
  await page.keyboard.press('KeyI');
  let b = await bindings();
  assert.equal(b.back, 'KeyI');
  assert.equal(b.forward, 'KeyS');

  // Reserved (F3) and Esc change nothing.
  await page.click('.bind-key[data-action="jump"]');
  await page.keyboard.press('F3');
  await page.click('.bind-key[data-action="jump"]');
  await page.keyboard.press('Escape');
  b = await bindings();
  assert.equal(b.jump, 'Space');
  assert.equal(await keyOf('jump'), 'Space');

  // The new keys drive the game: S now walks forward.
  await page.click('.play-button');
  // pointerLockElement is set before the (async) pointerlockchange event the game reacts to.
  await page.waitForFunction(() => !!document.pointerLockElement && document.querySelector('.hud').classList.contains('playing'));
  await installFrameDriver(page);
  const moved = async (key) => {
    const p0 = await page.evaluate(() => {
      window.T.run(5);
      const g = window.game;
      return { pos: g.player.position.toArray(), yaw: g.player.yaw };
    });
    await page.keyboard.down(key);
    await page.evaluate(() => window.T.run(30));
    await page.keyboard.up(key);
    const p1 = await page.evaluate(() => window.game.player.position.toArray());
    // Distance along the view direction (-Z rotated by yaw).
    const fx = -Math.sin(p0.yaw);
    const fz = -Math.cos(p0.yaw);
    return (p1[0] - p0.pos[0]) * fx + (p1[2] - p0.pos[2]) * fz;
  };
  await page.evaluate(() => window.T.stopLoop());
  assert.ok((await moved('KeyS')) > 1, 'S (new forward key) moves forward');
  assert.ok((await moved('KeyI')) < -1, 'I (new back key) moves backward');
  await page.evaluate(() => document.exitPointerLock());

  // Kept after a reload.
  await page.reload();
  await waitReady(page);
  b = await page.evaluate(() => ({ ...window.game.input.bindings }));
  assert.equal(b.forward, 'KeyS');
  assert.equal(b.back, 'KeyI');

  // Reset to defaults.
  await page.click('#tab-controls');
  await page.click('.controls-reset');
  b = await bindings();
  assert.equal(b.forward, 'KeyW');
  assert.equal(b.back, 'KeyS');
  assert.equal(await page.evaluate(() => window.game.input.sensitivity), 1);
  assert.equal(await keyOf('forward'), 'W');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});
