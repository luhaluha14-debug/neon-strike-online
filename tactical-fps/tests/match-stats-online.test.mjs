// Confirmed kill statistics in a real room (relay + two games): a member
// scores far more kills than the kill feed it receives can hold; the host's
// board, the member's board and the member's results all say the same; the
// member's GRID result is handed in once with every kill (per weapon) and
// the credits move once; a late, older match state does not undo anything.

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

test('room: 20 kills by a member (feed holds 12): both boards and the member’s results agree; the result is handed in once; a late old state changes nothing', async () => {
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
    // The member's hand-ins and its own credit balance before.
    const credits0 = await guest.evaluate(async () => {
      const g = window.game;
      window.__submits = [];
      const submit = g.economy.submitMatchResult.bind(g.economy);
      g.economy.submitMatchResult = (r) => {
        window.__submits.push(JSON.parse(JSON.stringify(r)));
        return submit(r);
      };
      // Every received match state, to send an old one again later.
      window.__states = [];
      const receive = g.netClient.receive.bind(g.netClient);
      g.netClient.receive = (d) => {
        if (d?.k === 'match') window.__states.push(d);
        receive(d);
      };
      return (await g.economy.getAccount()).credits;
    });
    // A state from before the kills, to send again late below.
    await guest.waitForFunction(() => window.__states.length > 0);
    // Quiet room; the member's seat kills 20 times (AR-01 and SR-01, 10 each), every victim back up at once.
    const seat = await host.evaluate(() => {
      const g = window.game;
      g.squad.respawns = false;
      g.match.config.killTarget = 1000;
      for (const b of g.squad.bots) b.combat.protection = 1e9;
      const seat = g.squad.bots.find((b) => b.remote);
      const ai = g.squad.bots.filter((b) => !b.remote);
      // Bots the others shot before the room was quieted are put back up first.
      for (const b of ai) if (!b.alive) b.spawn(b.position.clone(), 0);
      for (let i = 0; i < 20; i++) {
        const b = ai[i % ai.length];
        b.combat.protection = 0;
        b.combat.applyDamage({ amount: 999, zone: 'body', sourceId: seat.id, weaponId: i % 2 ? 'sr01' : 'ar01', point: b.position.clone(), direction: b.position.clone().set(0, 0, 1), distance: 5 });
        b.spawn(b.position.clone(), 0);
        b.combat.protection = 1e9;
      }
      return seat.id;
    });
    const hostLine = await host.evaluate((id) => (({ kills, weaponKills }) => ({ kills, weaponKills }))(window.game.match.scores.get(id)), seat);
    assert.deepEqual(hostLine, { kills: 20, weaponKills: { ar01: 10, sr01: 10 } });
    await guest.waitForFunction(() => window.game.match.scores.get('local')?.kills === 20);
    const g1 = await guest.evaluate(() => ({ weaponKills: window.game.match.scores.get('local').weaponKills, feed: window.game.match.feed.length }));
    assert.deepEqual(g1.weaponKills, { ar01: 10, sr01: 10 });
    assert.ok(g1.feed <= 12, `the member's feed holds only the latest kills (${g1.feed})`);

    // A late, older state arriving now (or the same one twice) changes nothing.
    const late = await guest.evaluate(() => {
      const g = window.game;
      const first = window.__states.find((d) => d.m.scores.some((x) => x[0] === g.netClient.myId && x[2] === 0));
      g.netClient.receive(first); // an old state (0 kills for this seat)
      const afterOld = g.match.scores.get('local').kills;
      g.netClient.receive(window.__states.at(-1)); // the latest again
      return { hadOld: !!first, afterOld, afterRepeat: g.match.scores.get('local').kills };
    });
    assert.deepEqual(late, { hadOld: true, afterOld: 20, afterRepeat: 20 });

    // The match ends on the host (long enough to pay): both boards and the member's results agree.
    await host.evaluate(() => {
      window.game.match.elapsed = 120;
      window.game.match.timeLeft = 0.05;
    });
    await guest.waitForFunction(() => !document.querySelector('.match-hud:not(.team-hud) .results').hidden);
    await host.waitForFunction(() => !document.querySelector('.match-hud:not(.team-hud) .results').hidden);
    const board = (p, me) =>
      p.evaluate((me) => {
        const m = window.game.match;
        return [...m.scores.values()].map((l) => [l.id === me ? 'member' : l.isPlayer ? 'host' : l.id, l.kills, l.deaths]).sort();
      }, me);
    const hb = await board(host, seat);
    const gb = await guest.evaluate(() => [...window.game.match.scores.values()].map((l) => [l.id === 'local' ? 'member' : l.id, l.kills, l.deaths]).sort());
    // The host's own line is 'host' on its screen and its member id on the member's.
    const norm = (rows) => rows.map((r) => (r[0] === 'host' || /^p\w+$/.test(r[0]) ? ['host', r[1], r[2]] : r)).sort();
    assert.deepEqual(norm(gb), norm(hb), 'the same record on both screens');
    const row = await guest.evaluate(() => [...document.querySelectorAll('.match-hud:not(.team-hud) .results-table tr')].find((tr) => tr.textContent.includes('Bravo'))?.textContent ?? '');
    assert.match(row, /20/, `the member's results row shows its 20 kills (${row})`);

    // Handed in once, with every kill; credits moved once.
    await guest.waitForFunction(() => window.__submits.length === 1 && document.querySelector('.match-hud:not(.team-hud) .results-reward').textContent !== '');
    const sub = await guest.evaluate(() => window.__submits[0]);
    assert.deepEqual([sub.mode, sub.outcome, sub.kills], ['deathmatch', 'completed', { ar01: 10, sr01: 10 }]);
    // More states after the end, and leaving to the lobby: nothing handed in again.
    await guest.waitForTimeout(1500);
    await guest.click('.match-hud:not(.team-hud) .results-lobby');
    await guest.waitForTimeout(500);
    const after = await guest.evaluate(async () => ({ submits: window.__submits.length, account: await window.game.economy.getAccount() }));
    assert.equal(after.submits, 1);
    assert.equal(after.account.settledMatches.filter((id) => id === sub.matchId).length, 1);
    assert.ok(after.account.credits > credits0, 'credits paid');
    assert.deepEqual(guest.errors, []);
    assert.deepEqual(host.errors, []);
  } finally {
    await host.context().close();
    await guest.context().close();
  }
});
