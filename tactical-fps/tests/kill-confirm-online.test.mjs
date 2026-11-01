// Kill confirm in a room (real relay): a kill the host's match credits to a
// member plays the confirm once on that member's screen and not on the
// host's; damage to the dead and a repeated kill message play nothing; the
// host's own kill stays on the host; the member's scoreboard counts it once.
// Then the match ends on the host: both show the result, the member's
// 다시 시작 waits for the host, and 로비 keeps the member in the room.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { startEnv, openGame, ROOT } from './harness.mjs';

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

/** Records kill-confirm requests (and the kill ids a member receives). */
const listen = (page) =>
  page.evaluate(() => {
    const g = window.game;
    window.__kc = 0;
    window.__ids = [];
    const play = g.audio.play.bind(g.audio);
    g.audio.play = (id, o) => {
      if (id === 'kill.confirm') window.__kc++;
      return play(id, o);
    };
    const netKill = g.netKill.bind(g);
    g.netKill = (id) => {
      window.__ids.push(id);
      netKill(id);
    };
  });

/** On the host: lethal damage to AI bot `victim` from `source` (a member's bot, or 'local'). */
const kill = (host, victim, source) =>
  host.evaluate(
    ([victim, source]) => {
      const b = window.game.squad.bots.find((x) => x.id === victim);
      b.combat.protection = 0;
      b.combat.applyDamage({ amount: 999, zone: 'body', sourceId: source, weaponId: 'ar01', point: b.position.clone(), direction: b.position.clone().set(0, 0, 1), distance: 5 });
      return b.alive;
    },
    [victim, source],
  );

test('room: a member’s kill confirms once on the member only; repeats are silent; the host’s kill stays on the host; then results on both', async () => {
  const host = await openGame(env, { mode: 'deathmatch', width: 480, height: 270 });
  const guest = await openGame(env, { mode: 'training', width: 480, height: 270 });
  for (const p of [host, guest]) p.setDefaultTimeout(60000);
  try {
    await host.click('#tab-multi');
    await host.fill('.mp-name', 'Alpha');
    await host.selectOption('.mp-mode', 'deathmatch');
    await host.click('.mp-create');
    await host.waitForFunction(() => window.game.netHost && window.game.match);
    const code = await host.textContent('.mp-room-code');
    await guest.click('#tab-multi');
    await guest.fill('.mp-name', 'Bravo');
    await guest.fill('.mp-code', code);
    await guest.click('.mp-join-btn');
    await guest.waitForFunction(() => window.game.netClient?.myId && window.game.match);
    await listen(host);
    await listen(guest);
    const ids = await host.evaluate(() => {
      const g = window.game;
      // Quiet room: the host's match keeps running, so the AI bots are made unhurtable (until the
      // test hurts one), nobody respawns, and no one reaches the kill target meanwhile.
      g.squad.respawns = false;
      g.match.config.killTarget = 1000;
      for (const b of g.squad.bots) if (!b.remote) b.combat.protection = 1e9;
      const ai = g.squad.bots.filter((b) => !b.remote && b.alive).map((b) => b.id);
      return { member: g.squad.bots.find((b) => b.remote).id, ai };
    });

    // The kills the member's character already had (it may have scored as an AI bot before the member took it over).
    const before = await host.evaluate((id) => window.game.match.scores.get(id).kills, ids.member);
    // The member's bot kills an AI bot (as when the host resolves the member's round).
    assert.equal(await kill(host, ids.ai[0], ids.member), false);
    await guest.waitForFunction(() => window.__kc === 1);
    assert.equal(await host.evaluate(() => window.__kc), 0, 'not on the host');
    // Damage to the dead bot: no second death, no message.
    await kill(host, ids.ai[0], ids.member);
    await guest.waitForTimeout(800);
    assert.equal(await guest.evaluate(() => window.__kc), 1);
    // The same kill message again (a repeat): silent.
    const repeat = await guest.evaluate(() => {
      window.game.netKill(window.__ids[0]);
      return [window.__kc, window.__ids.length, window.game.killConfirm.count];
    });
    assert.deepEqual(repeat, [1, 2, 1]);
    // The host's own kill: on the host only.
    await kill(host, ids.ai[1], 'local');
    assert.equal(await host.evaluate(() => window.__kc), 1);
    await guest.waitForTimeout(800);
    assert.equal(await guest.evaluate(() => window.__kc), 1);
    // The member's scoreboard counts the kill once (mirrored from the host, nothing added locally).
    assert.equal(await host.evaluate((id) => window.game.match.scores.get(id).kills, ids.member), before + 1);
    await guest.waitForFunction((n) => window.game.match.scores.get('local')?.kills === n, before + 1).catch(async (e) => {
      const board = (p) => p.evaluate(() => JSON.stringify([...window.game.match.scores].map(([id, x]) => [id, x.name, x.kills, x.deaths]).concat([['over', window.game.match.over, window.game.netClient?.myId ?? null]])));
      throw new Error(`member board ${await board(guest)} host board ${await board(host)} (${e.message.split('\n')[0]})`);
    });
    await guest.waitForTimeout(800);
    assert.equal(await guest.evaluate(() => window.game.match.scores.get('local').kills), before + 1);

    // The host's match ends (clock): results on both; only the host can restart.
    await host.evaluate(() => (window.game.match.timeLeft = 0.05));
    await host.waitForFunction(() => !document.querySelector('.match-hud:not(.team-hud) .results').hidden);
    await guest.waitForFunction(() => !document.querySelector('.match-hud:not(.team-hud) .results').hidden);
    const r = await Promise.all(
      [host, guest].map((p) =>
        p.evaluate(() => {
          const q = (s) => document.querySelector('.match-hud:not(.team-hud) ' + s);
          return { title: q('.results-title').textContent, restart: q('.results-restart').disabled, lobby: q('.results-lobby').disabled };
        }),
      ),
    );
    assert.ok(['승리', '패배'].includes(r[0].title) && ['승리', '패배'].includes(r[1].title));
    assert.deepEqual([r[0].restart, r[1].restart, r[0].lobby, r[1].lobby], [false, true, false, false]);
    // 로비 on the member: the lobby, still in the room.
    await guest.click('.match-hud:not(.team-hud) .results-lobby');
    const after = await guest.evaluate(() => ({ lobby: document.querySelector('.overlay').classList.contains('view-lobby'), room: !!window.game.net?.room, banner: !document.querySelector('.lobby-room').hidden }));
    assert.deepEqual(after, { lobby: true, room: true, banner: true });
    assert.deepEqual(guest.errors, []);
    assert.deepEqual(host.errors, []);
  } finally {
    await host.context().close();
    await guest.context().close();
  }
});
