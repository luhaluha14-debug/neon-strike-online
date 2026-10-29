// GRID lobby (single player, no relay): the first screen and its title,
// every lobby item and where it leads, each mode started from the lobby,
// pause → lobby → resume, results → lobby, and many lobby ↔ game round
// trips without a second game loop, extra window / document / canvas
// listeners, audio contexts or sockets.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, openGame, installFrameDriver, countingInit } from './harness.mjs';

let env;
let page;

before(async () => {
  env = await startEnv();
  page = await openGame(env, { mode: null, lobby: true, width: 960, height: 540, init: countingInit });
});
after(async () => {
  await page?.context().close();
  await env?.close();
});

const view = () =>
  page.evaluate(() => {
    const o = document.querySelector('.overlay');
    const shown = (el) => !!el && el.getBoundingClientRect().width > 0 && getComputedStyle(el).display !== 'none';
    return {
      hidden: o.classList.contains('hidden'),
      lobby: shown(document.querySelector('.lobby')),
      menu: shown(document.querySelector('.menu')),
      page: document.querySelector('.tab[aria-selected="true"]')?.dataset.page,
      mode: window.game.mode,
    };
  });

async function start() {
  await page.click('.play-button');
  await page.waitForFunction(() => window.game.input.active);
}

async function pause() {
  await page.evaluate(() => document.exitPointerLock());
  await page.waitForFunction(() => !window.game.input.active && !document.querySelector('.overlay').classList.contains('hidden'));
}

test('first visit: the GRID lobby (title, tab title, loading screen name); no temporary name anywhere', async () => {
  assert.equal(await page.title(), 'GRID');
  assert.deepEqual(await view(), { hidden: false, lobby: true, menu: false, page: 'play', mode: 'deathmatch' });
  const t = await page.evaluate(() => ({
    title: document.querySelector('.lobby-title').textContent,
    brand: [...document.querySelectorAll('.brand-title')].map((e) => e.textContent),
    items: [...document.querySelectorAll('.lobby-item')].filter((b) => !b.hidden).map((b) => b.querySelector('.lobby-item-label').textContent),
    status: document.querySelector('.lobby-status').textContent,
    text: document.body.innerText + document.title,
  }));
  assert.equal(t.title, 'GRID');
  assert.deepEqual(t.brand, ['GRID', 'GRID'], 'menu header and loading screen');
  assert.deepEqual(t.items, ['PLAY', 'MULTIPLAYER', 'ARSENAL', 'TRAINING', 'SETTINGS'], 'no RESUME before a match was started');
  assert.equal(t.status, '준비 완료');
  assert.doesNotMatch(t.text, /tactical fps|prototype/i);
  assert.deepEqual(page.errors, []);
});

test('every lobby item opens what exists: ARSENAL = weapons, SETTINGS, MULTIPLAYER, TRAINING; PLAY = the two modes; ◂ 로비 and Esc go back', async () => {
  const go = async (item) => {
    await page.click(`.lobby [data-lobby="${item}"]`);
    return view();
  };
  const back = async () => {
    await page.click('.menu-lobby');
    assert.equal((await view()).lobby, true);
  };
  assert.deepEqual(await go('arsenal'), { hidden: false, lobby: false, menu: true, page: 'loadout', mode: 'deathmatch' });
  await back();
  assert.equal((await go('settings')).page, 'settings');
  await back();
  assert.equal((await go('multi')).page, 'multi');
  await page.waitForFunction(() => document.querySelector('.mp-server').textContent.includes('서버 응답 없음'));
  await back();
  assert.deepEqual(await go('training'), { hidden: false, lobby: false, menu: true, page: 'play', mode: 'training' });
  assert.equal(await page.inputValue('select[data-setting="mode"]'), 'training', 'the Play page select follows');
  await back();
  // PLAY: the mode cards, the current one marked; Esc closes them.
  await page.click('.lobby [data-lobby="play"]');
  assert.equal(await page.isVisible('.lobby-play'), true);
  assert.equal(await page.isHidden('.lobby-nav'), true);
  assert.deepEqual(await page.$$eval('.lobby-mode', (b) => b.map((x) => [x.dataset.playMode, x.classList.contains('current')])), [
    ['team', false],
    ['deathmatch', false],
  ]);
  await page.keyboard.press('Escape');
  assert.equal(await page.isVisible('.lobby-nav'), true);
  await page.click('.lobby [data-lobby="play"]');
  await page.click('.lobby [data-play-mode="team"]');
  assert.deepEqual(await view(), { hidden: false, lobby: false, menu: true, page: 'play', mode: 'team' });
  const t = await page.evaluate(() => ({ team: !!window.game.teamMatch, saved: JSON.parse(localStorage.getItem('tactical-fps.match.v1')).mode }));
  assert.deepEqual(t, { team: true, saved: 'team' }, 'same save and match set-up as the select');
  await back();
  await page.click('.lobby [data-lobby="play"]');
  await page.click('.lobby [data-play-mode="deathmatch"]');
  assert.equal((await view()).mode, 'deathmatch');
  assert.equal(await page.evaluate(() => window.game.squad?.bots.length > 0 && !window.game.teamMatch), true);
  assert.deepEqual(page.errors, []);
});

test('each mode starts from the lobby; pause shows the menu (계속하기), ◂ 로비 shows RESUME, which goes back into the same match', async () => {
  for (const mode of ['deathmatch', 'team', 'training']) {
    await page.click('.menu-lobby');
    if (mode === 'training') await page.click('.lobby [data-lobby="training"]');
    else {
      await page.click('.lobby [data-lobby="play"]');
      await page.click(`.lobby [data-play-mode="${mode}"]`);
    }
    await start();
    const live = await page.evaluate(() => ({ mode: window.game.mode, dm: !!window.game.match, team: !!window.game.teamMatch, training: !!window.game.trainingRange, overlay: document.querySelector('.overlay').classList.contains('hidden') }));
    assert.deepEqual(live, { mode, dm: mode === 'deathmatch', team: mode === 'team', training: mode === 'training', overlay: true }, mode);
    await pause();
    const v = await view();
    assert.deepEqual([v.menu, v.lobby], [true, false], 'paused: the menu pages');
    assert.equal(await page.textContent('.play-button'), '계속하기');
    await page.click('.menu-lobby');
    assert.equal(await page.isVisible('.lobby [data-lobby="resume"]'), true, 'RESUME once a match was started');
    const serial = await page.evaluate(() => window.game.matchSerial);
    await page.click('.lobby [data-lobby="resume"]');
    await page.waitForFunction(() => window.game.input.active);
    assert.equal(await page.evaluate(() => window.game.matchSerial), serial, 'the same match');
    await pause();
  }
  assert.deepEqual(page.errors, []);
});

test('results → 로비: the result screen closes, a fresh match waits behind the lobby; 다시 시작 and 메뉴 stay next to it', async () => {
  await page.click('.menu-lobby');
  await page.click('.lobby [data-lobby="play"]');
  await page.click('.lobby [data-play-mode="deathmatch"]');
  await start();
  await installFrameDriver(page);
  await page.evaluate(() => {
    window.__render = [window.game.renderer.render, window.game.viewModel.render];
    window.T.stopLoop();
    const g = window.game;
    g.match.recordKill('bot-1', 'local', 'ar01', false);
    g.match.timeLeft = 0.2;
    window.T.run(20);
  });
  await page.waitForFunction(() => !document.pointerLockElement && !document.querySelector('.match-hud:not(.team-hud) .results').hidden);
  assert.deepEqual(await page.$$eval('.match-hud:not(.team-hud) .results-actions button', (b) => b.map((x) => [x.textContent, x.disabled])), [
    ['다시 시작', false],
    ['메뉴', false],
    ['로비', false],
  ]);
  await page.click('.match-hud:not(.team-hud) .results-lobby');
  const r = await page.evaluate(() => ({ results: !document.querySelector('.match-hud:not(.team-hud) .results').hidden, over: window.game.match.over, kills: window.game.match.scores.get('bot-1').kills }));
  assert.deepEqual(r, { results: false, over: false, kills: 0 });
  assert.deepEqual((await view()).lobby, true);
  // The team match's result screen has the same button.
  await page.click('.lobby [data-lobby="play"]');
  await page.click('.lobby [data-play-mode="team"]');
  await start();
  assert.equal(await page.evaluate(() => window.game.forfeitMatch()), true);
  await page.waitForFunction(() => !document.querySelector('.team-hud .results').hidden);
  await page.click('.team-hud .results-lobby');
  assert.equal((await view()).lobby, true);
  assert.equal(await page.evaluate(() => window.game.teamMatch.over), false);
  // Back to the menu-driven tests' state: the real loop again.
  await page.evaluate(() => {
    [window.game.renderer.render, window.game.viewModel.render] = window.__render;
    window.game.loop.start();
  });
  assert.deepEqual(page.errors, []);
});

test('repeated lobby ↔ game round trips: one game loop, no new window / document / canvas listeners, one audio context, no sockets', async () => {
  const cycle = async () => {
    await page.click('.lobby [data-lobby="play"]');
    await page.click('.lobby [data-play-mode="deathmatch"]');
    await start();
    await pause();
    await page.click('.menu-lobby');
    await page.click('.lobby [data-lobby="resume"]');
    await page.waitForFunction(() => window.game.input.active);
    await pause();
    await page.click('.menu-lobby');
    await page.click('.lobby [data-lobby="training"]');
    await start();
    await pause();
    await page.click('.menu-lobby');
    await page.click('.lobby [data-lobby="settings"]');
    await page.click('.menu-lobby');
    await page.click('.lobby [data-lobby="multi"]');
    await page.click('.menu-lobby');
  };
  if (!(await view()).lobby) await page.click('.menu-lobby');
  await cycle();
  const first = await page.evaluate(() => window.__counts());
  for (let i = 0; i < 4; i++) await cycle();
  await page.waitForTimeout(500);
  const last = await page.evaluate(() => window.__counts());
  assert.deepEqual(last.listeners, first.listeners, 'no listener added by a round trip');
  assert.equal(last.sockets, first.sockets, 'no socket opened by a round trip');
  assert.deepEqual(await page.evaluate(() => (window.__sockets ?? []).filter((w) => new URL(w.url).pathname === '/mp').length), 0, 'single player opens no relay socket (the one socket is the dev server client)');
  assert.ok(last.audio <= 1, `one audio context at most (${last.audio})`);
  assert.equal(await page.evaluate(() => window.__framesWaiting()), 1, 'one animation-frame loop');
  assert.deepEqual(page.errors, []);
});
