// GRID lobby with the real relay (server/mp behind the dev server's /mp):
// a team room made from the lobby, joined from the room list and by code,
// teams and head count on both sides, the lobby's room banner, leaving from
// the lobby, a wrong / expired code, a dropped connection (notice + rejoin
// the same room), the host leaving (notice), and many join / leave rounds
// on one socket without extra listeners.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { startEnv, openGame, countingInit, ROOT } from './harness.mjs';

let vite;
let relay;
let env;

before(async () => {
  vite = await createServer({ root: ROOT, logLevel: 'error', server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom' });
  const { createMpServer } = await vite.ssrLoadModule('/server/mp/server.ts');
  relay = createMpServer({ staticDir: null, log: () => {} });
  await new Promise((r) => relay.http.listen(0, '127.0.0.1', r));
  process.env.GRID_MP_PROXY = `http://127.0.0.1:${relay.http.address().port}`;
  env = await startEnv();
  delete process.env.GRID_MP_PROXY;
});
after(async () => {
  await env?.close();
  await relay?.close();
  await vite?.close();
});

/** Lobby → MULTIPLAYER, nickname (and mode). */
async function multi(page, name, mode) {
  await page.click('.lobby [data-lobby="multi"]');
  await page.fill('.mp-name', name);
  if (mode) await page.selectOption('.mp-mode', mode);
}

const members = (page) => page.$$eval('.mp-members li', (li) => li.map((x) => [x.querySelector('.mp-team')?.textContent ?? null, x.childNodes[x.querySelector('.mp-team') ? 1 : 0].textContent.trim()]));

test('team room from the lobby: listed with its head count, joined from the list; both see BLUE / RED; the lobby banner; leaving from the lobby', async () => {
  const host = await openGame(env, { mode: 'deathmatch', width: 480, height: 270, lobby: true });
  const guest = await openGame(env, { mode: 'training', width: 480, height: 270, lobby: true, init: countingInit });
  for (const p of [host, guest]) p.setDefaultTimeout(60000);
  try {
    await multi(host, 'Alpha', 'team');
    await host.waitForFunction(() => document.querySelector('.mp-server').textContent === '멀티플레이 서버 연결 가능');
    await host.click('.mp-create');
    await host.waitForFunction(() => window.game.netHost && window.game.teamMatch);
    const code = await host.textContent('.mp-room-code');

    // The guest sees the room in the list (head count, mode, map) and joins it from there.
    await multi(guest, 'Bravo');
    const row = `.mp-room-row:has(.mp-room-join[data-code="${code}"])`;
    await guest.waitForSelector(row);
    assert.deepEqual(await guest.$eval(row, (r) => [r.querySelector('.mp-room-row-info').textContent, r.querySelector('.mp-room-row-count').textContent]), ['5대5 라운드전 (팀전) · MAP 01 · 창고 지구', '1/10명']);
    await guest.click(`${row} .mp-room-join`);
    await guest.waitForFunction(() => window.game.netClient?.myId && window.game.teamMatch);

    // Teams: the host BLUE, the second player RED, on both screens.
    await host.waitForFunction(() => document.querySelectorAll('.mp-members li[data-team]').length === 2);
    await guest.waitForFunction(() => document.querySelectorAll('.mp-members li[data-team]').length === 2);
    const want = [
      ['BLUE', 'Alpha'],
      ['RED', 'Bravo'],
    ];
    assert.deepEqual(await members(host), want);
    assert.deepEqual(await members(guest), want);

    // The lobby: the room banner with the code and count; single-player modes wait.
    await guest.click('.menu-lobby');
    const banner = await guest.evaluate(() => ({
      shown: !document.querySelector('.lobby-room').hidden,
      code: document.querySelector('.lobby-room-code').textContent,
      meta: document.querySelector('.lobby-room-meta').textContent,
      play: document.querySelector('.lobby [data-lobby="play"]').disabled,
      training: document.querySelector('.lobby [data-lobby="training"]').disabled,
      multi: document.querySelector('.lobby [data-lobby="multi"]').disabled,
    }));
    assert.deepEqual(banner, { shown: true, code, meta: '5대5 라운드전 · 2/10명', play: true, training: true, multi: false });
    // 경기 입장 from the banner: into the room's match.
    await guest.click('.lobby-room-play');
    await guest.waitForFunction(() => window.game.input.active);
    await guest.evaluate(() => document.exitPointerLock());
    await guest.waitForFunction(() => !window.game.input.active);

    // Leave and come back by code a few times: one socket, no extra listeners.
    await guest.click('.menu-lobby');
    const counts = [];
    for (let i = 0; i < 4; i++) {
      await guest.click('.lobby-room-leave');
      await guest.waitForFunction(() => !window.game.net && document.querySelector('.lobby-room').hidden && !document.querySelector('.lobby [data-lobby="play"]').disabled);
      assert.equal(await guest.evaluate(() => window.game.mode === window.game.matchSettings.mode), true, 'back to the saved single-player mode');
      await host.waitForFunction(() => document.querySelectorAll('.mp-members li').length === 1);
      await guest.click('.lobby [data-lobby="multi"]');
      await guest.fill('.mp-code', code);
      await guest.click('.mp-join-btn');
      await guest.waitForFunction(() => window.game.netClient?.myId && window.game.teamMatch);
      await guest.click('.menu-lobby');
      counts.push(await guest.evaluate(() => window.__counts()));
    }
    assert.equal(counts.at(-1).sockets, counts[0].sockets, 'the same relay connection');
    assert.equal(await guest.evaluate(() => window.__sockets.filter((w) => new URL(w.url).pathname === '/mp').length), 1);
    assert.deepEqual(counts.at(-1).listeners, counts[1].listeners, 'no listeners piling up');
    assert.deepEqual(guest.errors, []);
    assert.deepEqual(host.errors, []);
  } finally {
    await host.context().close();
    await guest.context().close();
  }
});

test('errors: a wrong or expired code says so; a dropped connection tells the lobby and offers the same room again; the host leaving is announced', async () => {
  const host = await openGame(env, { mode: 'deathmatch', width: 480, height: 270, lobby: true });
  const guest = await openGame(env, { mode: 'deathmatch', width: 480, height: 270, lobby: true });
  for (const p of [host, guest]) p.setDefaultTimeout(60000);
  try {
    await multi(guest, 'Bravo');
    await guest.fill('.mp-code', 'ZZZZZ');
    await guest.click('.mp-join-btn');
    await guest.waitForFunction(() => document.querySelector('.mp-error').textContent.includes('만료'));
    await guest.fill('.mp-code', 'AB1');
    await guest.click('.mp-join-btn');
    assert.equal(await guest.textContent('.mp-error'), '방 코드는 5자입니다 (영문·숫자).');

    await multi(host, 'Alpha', 'deathmatch');
    await host.click('.mp-create');
    await host.waitForFunction(() => window.game.netHost && window.game.match);
    const code = await host.textContent('.mp-room-code');
    await guest.fill('.mp-code', code);
    await guest.click('.mp-join-btn');
    await guest.waitForFunction(() => window.game.netClient?.myId && window.game.match);

    // The connection drops (network, relay restart): single player again, the lobby says so, rejoin offered.
    await guest.click('.menu-lobby');
    await guest.evaluate(() => window.game.net.ws.close());
    await guest.waitForFunction(() => !window.game.net && !document.querySelector('.lobby-notice').hidden);
    assert.match(await guest.textContent('.lobby-notice'), /연결이 끊겼습니다/);
    assert.equal(await guest.evaluate(() => document.querySelector('.lobby-room').hidden), true);
    await guest.click('.lobby [data-lobby="multi"]');
    assert.equal(await guest.textContent('.mp-rejoin'), `같은 방(${code})에 다시 참가`);
    await guest.click('.mp-rejoin');
    await guest.waitForFunction(() => window.game.netClient?.myId && window.game.match);
    assert.equal(await guest.isHidden('.mp-rejoin'), true);

    // The host leaves: the guest hosts now, and the lobby says the match starts over.
    await guest.click('.menu-lobby');
    await host.context().close();
    await guest.waitForFunction(() => window.game.netHost && !document.querySelector('.lobby-notice').hidden);
    assert.equal(await guest.textContent('.lobby-notice'), '방장이 나가 내가 방장이 되었습니다. 경기가 처음부터 다시 시작됩니다.');
    assert.deepEqual(guest.errors, []);
  } finally {
    await host.context().close().catch(() => {});
    await guest.context().close();
  }
});
