// Round history in a real room (Phase 21): relay + two games, team match.
// The host decides each round and writes its record; the member shows the
// host's records (ids as it sees them: its own seat is 'local'). Both screens
// agree round by round; every state received again changes nothing; after a
// dropped connection and a rejoin the member has the full, same list again,
// and a round decided after that is added once on both.

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

const lobby = async (page, name, mode) => {
  await page.click('#tab-multi');
  await page.fill('.mp-name', name);
  if (mode) await page.selectOption('.mp-mode', mode);
};

/** On the host: the member's seat takes down the whole other team in the live round (the first by the head); the round is decided. */
const decideRound = (host) =>
  host.evaluate(async () => {
    const g = window.game;
    const tm = g.teamMatch;
    const wait = async (ok) => {
      for (let i = 0; i < 600 && !ok(); i++) await new Promise((r) => setTimeout(r, 50));
    };
    // Nobody fights on their own (protected before the round goes live).
    const guard = () => {
      g.combat.protection = 1e9;
      for (const b of g.squad.bots) b.combat.protection = 1e9;
    };
    guard();
    await wait(() => tm.phase === 'prep' || tm.phase === 'live');
    guard();
    if (tm.phase === 'prep') tm.ready();
    await wait(() => tm.phase === 'live');
    guard();
    const seat = g.squad.bots.find((b) => b.remote);
    const before = tm.history.length;
    // Every foe at full health first; the host itself, when on the other team, goes down too.
    const foes = g.squad.bots.filter((b) => b.team !== seat.team && b.alive);
    for (const b of foes) b.combat.reset();
    const hostFoe = g.localTeam !== seat.team && g.combat.alive;
    if (hostFoe) g.player.health = 100;
    foes.forEach((b, i) => {
      b.combat.protection = 0;
      for (const [amount, zone] of [
        [60, 'body'],
        [60, i === 0 ? 'head' : 'body'],
      ])
        b.combat.applyDamage({ amount, zone, sourceId: seat.id, weaponId: 'ar01', point: b.position.clone(), direction: b.position.clone().set(0, 0, 1), distance: 9 });
    });
    if (hostFoe) {
      g.combat.protection = 0;
      g.combat.applyDamage({ amount: 999, zone: 'body', sourceId: seat.id, weaponId: 'ar01', point: g.player.position.clone(), direction: g.player.position.clone().set(0, 0, 1), distance: 9 });
    }
    await wait(() => tm.history.length > before);
    return { seat: seat.id, rounds: tm.history.length, foes: foes.length, killed: foes.length + (hostFoe ? 1 : 0) };
  });

/** Each round's records, by name (ids differ between the screens), with the player's own row as 'ME' on its own screen. */
const records = (page, meName) =>
  page.evaluate(
    (meName) =>
      window.game.teamMatch.roundStats.map((s, i) => ({
        round: s.round,
        winner: window.game.teamMatch.history[i].winner,
        duration: s.duration,
        rows: s.players
          .map((p) => [p[0] === 'local' ? meName : p[1], p[2], p[4], p[5], p[6], p[7]])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      })),
    meName,
  );

test('13, 14, 15: room: host and member hold the same round records; states again add nothing; a rejoin gets the full list; a later round counts once', async () => {
  const host = await openGame(env, { mode: 'team', objective: 'elimination', width: 480, height: 270, quality: 'low' });
  const guest = await openGame(env, { mode: 'team', objective: 'elimination', width: 480, height: 270, quality: 'low' });
  for (const p of [host, guest]) p.setDefaultTimeout(120000);
  try {
    await lobby(host, 'Host', 'team');
    await host.click('.mp-quick');
    await host.waitForSelector('.mp-room:not([hidden])');
    const code = (await host.textContent('.mp-room-code')).trim();
    await lobby(guest, 'Guest');
    await guest.fill('.mp-code', code.toLowerCase());
    await guest.click('.mp-join-btn');
    await host.waitForFunction(() => document.querySelectorAll('.mp-members li').length === 2);
    await host.waitForFunction(() => window.game.teamMatch && window.game.squad?.bots.some((b) => b.remote));
    await guest.waitForFunction(() => window.game.netClient?.myId && window.game.teamMatch);
    await guest.evaluate(() => {
      window.__states = [];
      const receive = window.game.netClient.receive.bind(window.game.netClient);
      window.game.netClient.receive = (d) => {
        if (d?.k === 'match') window.__states.push(d);
        receive(d);
      };
    });
    // The host's own line is 'YOU' on its screen and 'Host' on the member's.
    const hostRecords = async () => (await records(host, 'Host')).map((r) => ({ ...r, rows: r.rows.map((x) => (x[0] === 'YOU' ? ['Host', ...x.slice(1)] : x)).sort((a, b) => String(a[0]).localeCompare(String(b[0]))) }));

    const r1 = await decideRound(host);
    assert.ok(r1.rounds >= 1 && r1.foes >= 1, JSON.stringify(r1));
    await guest.waitForFunction((n) => window.game.teamMatch.roundStats.length === n, r1.rounds);
    const h1 = await hostRecords();
    const g1 = await records(guest, 'Guest');
    assert.deepEqual(g1, h1, 'the same records on both screens');
    // The member's own row in the round it decided: every foe, the first by the head.
    const mine = g1.at(-1).rows.find((x) => x[0] === 'Guest');
    assert.deepEqual([mine[2], mine[4], mine[5]], [r1.killed, 1, r1.killed * 100], 'the member’s round: every foe, one by the head, 100 health each');

    // Every state received so far, again (oldest first, then the latest): the same records.
    const again = await guest.evaluate(() => {
      const g = window.game;
      const all = window.__states.slice();
      for (const d of all) g.netClient.receive(d);
      g.netClient.receive(all.at(-1));
      return { states: all.length, rounds: g.teamMatch.roundStats.length };
    });
    assert.ok(again.states >= 1);
    assert.equal(again.rounds, h1.length);
    assert.deepEqual(await records(guest, 'Guest'), h1);

    // The connection drops; the member rejoins the same room: the full list again, the same.
    await guest.click('.menu-lobby');
    await guest.evaluate(() => window.game.net.ws.close());
    await guest.waitForFunction(() => !window.game.net);
    await guest.click('.lobby [data-lobby="multi"]');
    await guest.click('.mp-rejoin');
    await guest.waitForFunction(() => window.game.netClient?.myId && window.game.teamMatch);
    await host.waitForFunction(() => window.game.squad.bots.some((b) => b.remote));
    await guest.waitForFunction((n) => window.game.teamMatch.roundStats.length === n, h1.length);
    assert.deepEqual(await records(guest, 'Guest'), await hostRecords(), 'after the rejoin: the same list as the host');

    // A round decided after the rejoin: added once on both, the same.
    const r2 = await decideRound(host);
    assert.equal(r2.rounds, h1.length + 1);
    await guest.waitForFunction((n) => window.game.teamMatch.roundStats.length === n, r2.rounds);
    await guest.waitForTimeout(600);
    const h2 = await hostRecords();
    const g2 = await records(guest, 'Guest');
    assert.equal(g2.length, h2.length);
    assert.deepEqual(g2, h2);
    assert.deepEqual(await host.evaluate(() => window.game.teamMatch.roundStats.map((s) => s.round)), h2.map((_, i) => i + 1));
    assert.deepEqual(guest.errors, []);
    assert.deepEqual(host.errors, []);
  } finally {
    await host.context().close();
    await guest.context().close();
  }
});
