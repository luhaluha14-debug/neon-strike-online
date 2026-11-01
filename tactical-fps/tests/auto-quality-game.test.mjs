// Automatic graphics quality in the game (headless Chromium, software
// WebGL: no real GPU, so the frame times that lower the level are fed in,
// not measured). A plain link starts on 자동 at the level the device check
// gives; only frames in play are measured (menu frames restart the
// warm-up); a sustained slow stretch lowers the level on the spot (pixel
// ratio, shadows) and is remembered; a level chosen by hand or in the link
// is never measured or changed; choosing 자동 again starts over.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, openGame, waitReady } from './harness.mjs';

const SETTINGS_KEY = 'tactical-fps.settings.v1';
const AUTO_KEY = 'tactical-fps.auto-quality.v1';

let env;
before(async () => {
  env = await startEnv();
});
after(async () => {
  await env?.close();
});

const state = (page) =>
  page.evaluate(
    ({ SETTINGS_KEY, AUTO_KEY }) => {
      const g = window.game;
      return {
        quality: g.quality,
        auto: !!g.autoQuality,
        select: document.querySelector('select[data-setting="quality"]').value,
        saved: JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}').quality ?? null,
        remembered: JSON.parse(localStorage.getItem(AUTO_KEY) ?? 'null'),
        shadows: g.renderer.shadowMap.enabled,
        castShadow: g.sun.castShadow,
        pixelRatio: g.renderer.getPixelRatio(),
        dpr: devicePixelRatio,
      };
    },
    { SETTINGS_KEY, AUTO_KEY },
  );

test('plain link: 자동, the device check level; play frames measured, menu frames restart the warm-up', async () => {
  const page = await openGame(env, { width: 1280, height: 720, quality: null });
  try {
    const s = await state(page);
    assert.equal(s.auto, true);
    assert.equal(s.select, 'auto');
    assert.equal(s.saved, null);
    // The level the device check gives for what this browser reports (no GPU names involved).
    const dev = await page.evaluate(async () => {
      const A = await import('/src/core/AutoQuality.ts');
      const d = A.readDevice();
      return { d, guess: A.guessQuality(d) };
    });
    assert.ok(dev.d.gpu && dev.d.gpu.maxTextureSize > 0, `WebGL information read (${JSON.stringify(dev.d)})`);
    assert.equal(s.quality, dev.guess, `device check (${JSON.stringify(dev.d)})`);

    // In play the warm-up runs down; back in the menu it starts over.
    await page.click('#tab-play');
    await page.click('.play-button');
    await page.waitForFunction(() => window.game.input.active);
    await page.waitForFunction(() => window.game.autoQuality.warm < 5);
    await page.evaluate(() => document.exitPointerLock());
    await page.waitForFunction(() => !window.game.input.active);
    await page.waitForFunction(() => window.game.autoQuality.warm === 5);
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});

test('a sustained slow stretch at medium lowers to low during play (pixel ratio, shadows) and is remembered; drawing goes on', async () => {
  const page = await openGame(env, {
    width: 1280,
    height: 720,
    quality: null,
    init: () => {
      if (!sessionStorage.getItem('seeded')) {
        sessionStorage.setItem('seeded', '1');
        localStorage.setItem('tactical-fps.auto-quality.v1', JSON.stringify({ level: 'medium', ceiling: null }));
      }
    },
  });
  try {
    const before = await state(page);
    assert.deepEqual([before.quality, before.auto, before.shadows, before.castShadow], ['medium', true, true, true]);
    assert.equal(before.pixelRatio, Math.min(before.dpr, 1.5));
    // 20 s of play at 25 fps (fed in: this browser's own frame rate says nothing about a GPU).
    const lowered = await page.evaluate(() => {
      const g = window.game;
      let at = null;
      for (let i = 0; i < 500; i++) {
        g.measureQuality(1 / 25, true);
        if (at === null && g.quality !== 'medium') at = (i + 1) / 25;
      }
      return at;
    });
    assert.ok(lowered >= 17 && lowered < 18, `lowered after the warm-up and three slow windows (${lowered} s)`);
    const after = await state(page);
    assert.deepEqual([after.quality, after.auto, after.select, after.shadows, after.castShadow], ['low', true, 'auto', false, false]);
    assert.equal(after.pixelRatio, Math.min(after.dpr, 1));
    assert.deepEqual(after.remembered, { level: 'low', ceiling: 'low' });
    // The game keeps drawing with the new settings (materials rebuilt without shadows).
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.waitForTimeout(500);
    assert.deepEqual(page.errors, []);

    // Next load starts at the remembered level.
    await page.reload();
    await waitReady(page);
    assert.equal((await state(page)).quality, 'low');
  } finally {
    await page.context().close();
  }
});

test('a level chosen by hand is kept (never measured); 자동 again starts over; a ?quality link is a choice too', async () => {
  const page = await openGame(env, {
    width: 1280,
    height: 720,
    quality: null,
    init: () => {
      if (!sessionStorage.getItem('seeded')) {
        sessionStorage.setItem('seeded', '1');
        localStorage.setItem('tactical-fps.auto-quality.v1', JSON.stringify({ level: 'low', ceiling: 'low' }));
      }
    },
  });
  try {
    await page.click('#tab-settings');
    await Promise.all([page.waitForNavigation(), page.selectOption('select[data-setting="quality"]', 'high')]);
    await waitReady(page);
    const manual = await state(page);
    assert.deepEqual([manual.quality, manual.auto, manual.select, manual.saved, manual.shadows], ['high', false, 'high', 'high', true]);
    // No measuring: slow frames change nothing.
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.game.autoQuality), null);

    await page.click('#tab-settings');
    await Promise.all([page.waitForNavigation(), page.selectOption('select[data-setting="quality"]', 'auto')]);
    await waitReady(page);
    const auto = await state(page);
    assert.deepEqual([auto.auto, auto.select, auto.saved, auto.remembered], [true, 'auto', null, null], 'measured from scratch (the earlier ceiling is dropped)');
    assert.equal(await page.evaluate(() => window.game.autoQuality.state.ceiling), null);
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
  const linked = await openGame(env, { quality: 'medium' });
  try {
    const s = await state(linked);
    assert.deepEqual([s.quality, s.auto, s.select], ['medium', false, 'medium']);
  } finally {
    await linked.context().close();
  }
});
