// Menu, settings, loading screen and HUD: DOM state and layout (bounding
// boxes), driven with real clicks / keys. Layout is checked geometrically
// (nothing outside the viewport, Play button reachable); no screenshots are
// compared, so visual polish is out of scope here.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, openGame, waitReady, LOAD_TIMEOUT } from './harness.mjs';

const SETTINGS_KEY = 'tactical-fps.settings.v1';

let env;
before(async () => {
  env = await startEnv();
});
after(async () => {
  await env?.close();
});

/** Elements of the menu column sticking out of the viewport, and whether Play is fully visible. */
const layout = (page) =>
  page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('.menu *')) {
      const b = el.getBoundingClientRect();
      if (b.width && (b.right > innerWidth + 1 || b.left < -1)) out.push(el.className || el.tagName);
    }
    const p = document.querySelector('.play-button').getBoundingClientRect();
    return {
      offenders: [...new Set(out)],
      pageScrollsSideways: document.documentElement.scrollWidth > innerWidth,
      playVisible: p.top >= 0 && p.bottom <= innerHeight && p.width > 0,
    };
  });

for (const [w, h] of [
  [1600, 900],
  [1024, 640],
  [600, 780],
]) {
  test(`layout ${w}x${h}: every menu page fits, Play stays visible`, async () => {
    const page = await openGame(env, { width: w, height: h });
    for (const tab of ['play', 'loadout', 'settings', 'controls']) {
      await page.click('#tab-' + tab);
      const l = await layout(page);
      assert.deepEqual(l.offenders, [], `${tab}: elements outside the viewport`);
      assert.equal(l.pageScrollsSideways, false, `${tab}: horizontal page scroll`);
      assert.equal(l.playVisible, true, `${tab}: Play button not fully visible`);
    }
    assert.deepEqual(page.errors, []);
    await page.context().close();
  });
}

test('loading screen shows the map name and real download progress', async () => {
  const context = await env.browser.newContext({ viewport: { width: 1024, height: 640 } });
  const page = await context.newPage();
  page.setDefaultTimeout(LOAD_TIMEOUT);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  // ~1.5 MB/s: the 6 MB warehouse map takes a few seconds.
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 50, downloadThroughput: 1.5e6, uploadThroughput: 1e6 });
  await page.goto(`${env.url}/?map=warehouse&quality=low`, { waitUntil: 'commit' });
  await page.waitForSelector('.loading:not([hidden])', { timeout: 60000 });
  await page.waitForFunction(() => parseInt(document.querySelector('.loading-percent').textContent, 10) >= 20, null, { timeout: 60000 });
  const shown = await page.evaluate(() => ({
    map: document.querySelector('.loading-map').textContent,
    percent: parseInt(document.querySelector('.loading-percent').textContent, 10),
  }));
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await waitReady(page);
  assert.equal(shown.map, 'MAP 01 · 창고 지구');
  assert.ok(shown.percent >= 20 && shown.percent <= 100);
  assert.equal(await page.evaluate(() => document.querySelector('.loading').hidden), true, 'loading screen hidden when ready');
  await context.close();
});

test('menu flow: pick a weapon, play, pause, resume', async () => {
  const page = await openGame(env, { width: 1280, height: 720 });
  const ui = () =>
    page.evaluate(() => ({
      overlayHidden: document.querySelector('.overlay').classList.contains('hidden'),
      playing: document.querySelector('.hud').classList.contains('playing'),
      play: document.querySelector('.play-button').textContent.trim(),
      locked: !!document.pointerLockElement,
      slot: window.game.weapons.slot,
      hudSlot: document.querySelector('.loadout .active')?.textContent,
      pressed: [...document.querySelectorAll('.weapon-card')].map((b) => b.getAttribute('aria-pressed')),
    }));
  const start = await ui();
  assert.equal(start.overlayHidden, false);
  assert.equal(start.play, '플레이');
  assert.equal(start.slot, 0);

  await page.click('#tab-loadout');
  await page.click('.weapon-card[data-id="sr01"]');
  await page.waitForFunction(() => window.game.weapons.slot === 1);
  const picked = await ui();
  assert.deepEqual(picked.pressed, ['false', 'true', 'false']);
  assert.match(picked.hudSlot, /SR-01/);

  await page.click('.play-button');
  // pointerLockElement is set before the (async) pointerlockchange event the game reacts to.
  await page.waitForFunction(() => !!document.pointerLockElement && document.querySelector('.hud').classList.contains('playing'));
  const playing = await ui();
  assert.equal(playing.overlayHidden, true);
  assert.equal(playing.playing, true);

  await page.evaluate(() => document.exitPointerLock());
  await page.waitForFunction(() => !document.querySelector('.overlay').classList.contains('hidden') && !document.querySelector('.hud').classList.contains('playing'));
  const paused = await ui();
  assert.equal(paused.play, '계속하기');
  assert.equal(paused.playing, false);

  await page.click('.play-button');
  await page.waitForFunction(() => !!document.pointerLockElement && document.querySelector('.hud').classList.contains('playing'));
  assert.equal((await ui()).overlayHidden, true);
  await page.evaluate(() => document.exitPointerLock());
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('settings apply immediately and persist in the existing storage format', async () => {
  const page = await openGame(env, { width: 1280, height: 720 });
  await page.click('#tab-settings');
  await page.selectOption('select[data-setting="frame-limit"]', '144');
  await page.selectOption('select[data-setting="volume"]', '0.5');
  await page.click('.toggle');
  const after1 = await page.evaluate((key) => ({
    limit: window.game.loop.frameLimit,
    volume: window.game.settings.volume,
    stats: document.querySelector('.stats').classList.contains('visible'),
    zones: window.game.map.zoneMarkers.visible,
    saved: JSON.parse(localStorage.getItem(key)),
  }), SETTINGS_KEY);
  assert.equal(after1.limit, 144);
  assert.equal(after1.volume, 0.5);
  assert.equal(after1.stats, true);
  assert.equal(after1.zones, true);
  // Exactly the existing keys: a format change would reset players' settings.
  assert.deepEqual(Object.keys(after1.saved).sort(), ['frameLimit', 'mapId', 'quality', 'volume']);
  assert.equal(after1.saved.frameLimit, 144);
  assert.equal(after1.saved.volume, 0.5);

  // F3 is the same action as the toggle.
  await page.keyboard.press('F3');
  const after2 = await page.evaluate(() => ({ stats: document.querySelector('.stats').classList.contains('visible'), toggle: document.querySelector('input[data-setting="stats"]').checked }));
  assert.deepEqual(after2, { stats: false, toggle: false });

  // Survives a reload.
  await page.reload();
  await waitReady(page);
  const reloaded = await page.evaluate(() => ({
    limit: window.game.loop.frameLimit,
    volume: window.game.settings.volume,
    limitSelect: document.querySelector('select[data-setting="frame-limit"]').value,
    volumeSelect: document.querySelector('select[data-setting="volume"]').value,
  }));
  assert.deepEqual(reloaded, { limit: 144, volume: 0.5, limitSelect: '144', volumeSelect: '0.5' });

  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('quality setting reloads the page and is kept (when the link has no ?quality)', async () => {
  // A ?quality= in the link deliberately overrides the saved choice (src/main.ts),
  // so this test opens the plain link.
  const page = await openGame(env, { width: 1280, height: 720, quality: null });
  await page.click('#tab-settings');
  const current = await page.evaluate(() => window.game.quality);
  const next = current === 'low' ? 'medium' : 'low';
  await Promise.all([page.waitForNavigation(), page.selectOption('select[data-setting="quality"]', next)]);
  await waitReady(page);
  const q = await page.evaluate((key) => ({ quality: window.game.quality, saved: JSON.parse(localStorage.getItem(key)).quality, select: document.querySelector('select[data-setting="quality"]').value }), SETTINGS_KEY);
  assert.deepEqual(q, { quality: next, saved: next, select: next });
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('map switch happens in place: same page link, loading state, then ready', async () => {
  const page = await openGame(env, { width: 1280, height: 720 });
  const urlBefore = page.url();
  assert.ok(!urlBefore.includes('map='), '?map= is removed after it is applied');
  await page.click('#tab-play');
  await page.click('.map-card[data-id="seoul"]');
  await page.waitForFunction(() => !document.querySelector('.loading').hidden || window.game.mapDef.id === 'seoul');
  await page.waitForFunction(() => window.game.mapDef.id === 'seoul' && window.game.player && !document.querySelector('.play-button').disabled, null, { timeout: LOAD_TIMEOUT });
  const r = await page.evaluate((key) => ({
    checked: document.querySelector('.map-card[aria-checked="true"]').dataset.id,
    savedMap: JSON.parse(localStorage.getItem(key)).mapId,
    weaponCardsEnabled: [...document.querySelectorAll('.weapon-card')].every((b) => !b.disabled),
  }), SETTINGS_KEY);
  assert.equal(page.url(), urlBefore);
  assert.deepEqual(r, { checked: 'seoul', savedMap: 'seoul', weaponCardsEnabled: true });
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('tabs: arrow keys move the selection; one tab selected at a time', async () => {
  const page = await openGame(env, { width: 1280, height: 720 });
  await page.focus('#tab-play');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  const r = await page.evaluate(() => ({
    selected: [...document.querySelectorAll('.tab')].filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.id),
    visiblePages: [...document.querySelectorAll('.page')].filter((p) => !p.hidden).map((p) => p.dataset.page),
  }));
  assert.deepEqual(r, { selected: ['tab-settings'], visiblePages: ['settings'] });
  await page.context().close();
});

test('HUD ammo readout and states', async () => {
  const page = await openGame(env);
  const r = await page.evaluate(() => {
    const g = window.game;
    const w = g.weapons.weapon;
    const out = [];
    for (const [m, res] of [
      [0, 0],
      [0, 40],
      [5, 0],
      [30, 90],
    ]) {
      w.magazine = m;
      w.reserve = res;
      g.updateWeaponHud();
      const hud = document.querySelector('.hud').classList;
      out.push([document.querySelector('.ammo').textContent.replace(/\s/g, ''), document.querySelector('.weapon-status').textContent, hud.contains('ammo-empty'), hud.contains('ammo-low')]);
    }
    return out;
  });
  assert.deepEqual(r, [
    ['0/0', '탄약 없음', true, false],
    ['0/40', 'R 재장전', true, false],
    ['5/0', '', false, true],
    ['30/90', '', false, false],
  ]);
  await page.context().close();
});
