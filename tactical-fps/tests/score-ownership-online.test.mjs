// Personal records in a real room (relay + two games): the AI bots score,
// then a member joins and its seat shows a fresh record; its kill is its own
// (scoreboard, results, one kill confirm); when it leaves the bot has its own
// record back; reconnecting starts a fresh record again; when the host
// leaves, the member hosts a new match from zero. On the host, the kill
// confirm still sounds for a seat whose deaths restarted after a hand-over.

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

const listen = (page) =>
  page.evaluate(() => {
    const g = window.game;
    window.__kc = 0;
    const play = g.audio.play.bind(g.audio);
    g.audio.play = (id, o) => {
      if (id === 'kill.confirm') window.__kc++;
      return play(id, o);
    };
  });

/** On the host: lethal damage to `victim` from `source`, through the bot's own combat (the real damage → match path). */
const kill = (host, victim, source) =>
  host.evaluate(
    ([victim, source]) => {
      const b = window.game.squad.bots.find((x) => x.id === victim);
      b.combat.protection = 0;
      b.combat.applyDamage({ amount: 999, zone: 'body', sourceId: source, weaponId: 'ar01', point: b.position.clone(), direction: b.position.clone().set(0, 0, 1), distance: 5 });
      for (const o of window.game.squad.bots) if (!o.remote) o.combat.protection = 1e9;
      return !b.alive;
    },
    [victim, source],
  );

/** The host's record of a seat. */
const line = (host, id) => host.evaluate((id) => (({ name, kills, deaths, gen }) => ({ name, kills, deaths, gen }))(window.game.match.scores.get(id)), id);

/** A living AI bot on the host other than `except`. */
const aiBot = (host, except = []) => host.evaluate((except) => window.game.squad.bots.find((b) => !b.remote && b.alive && !except.includes(b.id)).id, except);

async function join(guest, code) {
  await guest.click('#tab-multi');
  await guest.fill('.mp-name', 'Bravo');
  await guest.fill('.mp-code', code);
  await guest.click('.mp-join-btn');
  await guest.waitForFunction(() => window.game.netClient?.myId && window.game.match);
}

test('room: the seat’s earlier record stays the bot’s; the member’s kill is the member’s (board, results, one confirm); leaving, reconnecting and a new host keep it straight', async () => {
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
    await listen(host);
    // A quiet room: AI bots cannot be hurt except by this test, nobody respawns, no one reaches the kill target.
    await host.evaluate(() => {
      const g = window.game;
      g.squad.respawns = false;
      g.match.config.killTarget = 1000;
      for (const b of g.squad.bots) b.combat.protection = 1e9;
      // Every AI bot has a record before anyone joins (3 kills, 1 death each).
      const ids = g.squad.bots.map((b) => b.id);
      for (const id of ids) for (let i = 0; i < 3; i++) g.match.recordKill(id, 'local', 'ar01', false);
      for (const id of ids) g.match.recordKill('local', id, 'ar01', false);
    });

    // The host's kill confirm on a seat whose deaths restart after a hand-over: still one per kill.
    const v = await aiBot(host);
    const deathsBefore = (await line(host, v)).deaths;
    assert.equal(await kill(host, v, 'local'), true);
    assert.equal(await host.evaluate(() => window.__kc), 1);
    await host.evaluate((v) => {
      const g = window.game;
      const b = g.squad.bots.find((x) => x.id === v);
      g.match.reassign(v, 'Someone');
      b.spawn(b.position.clone(), 0);
      b.combat.protection = 1e9;
    }, v);
    assert.deepEqual((await line(host, v)).deaths, 0);
    assert.equal(await kill(host, v, 'local'), true);
    assert.equal(await host.evaluate(() => window.__kc), 2, 'same victim, same death count, another controller: a new kill (no stale key)');
    await host.evaluate((v) => window.game.match.reassign(v, `BOT back`, { kills: 3, deaths: 2 }), v);
    assert.ok(deathsBefore >= 1);

    // The member joins: its seat starts from zero on both screens; the AI's record is kept aside.
    const lines0 = await host.evaluate(() => Object.fromEntries([...window.game.match.scores].map(([id, l]) => [id, { kills: l.kills, deaths: l.deaths, gen: l.gen, weaponKills: { ...l.weaponKills } }])));
    await join(guest, code);
    await listen(guest);
    const seat = await host.evaluate(() => window.game.squad.bots.find((b) => b.remote).id);
    assert.deepEqual(await line(host, seat), { name: 'Bravo', kills: 0, deaths: 0, gen: lines0[seat].gen + 1 });
    const kept = await host.evaluate(() => [...window.game.netHost.members.values()][0].botRecord);
    assert.deepEqual(kept, { kills: lines0[seat].kills, deaths: lines0[seat].deaths, weaponKills: lines0[seat].weaponKills });
    assert.ok(kept.kills >= 3, 'the seat had kills of its own');
    await guest.waitForFunction((gen) => window.game.match.scores.get('local')?.gen === gen, lines0[seat].gen + 1);
    const g0 = await guest.evaluate(() => (({ kills, deaths }) => ({ kills, deaths }))(window.game.match.scores.get('local')));
    assert.deepEqual(g0, { kills: 0, deaths: 0 }, 'the bot’s 3 kills are not shown as the member’s');
    // Other players' records did not move.
    const other = await aiBot(host, [seat]);
    assert.deepEqual((await line(host, other)).kills, 3);

    // The member kills: its own record, its own results, one confirm.
    assert.equal(await kill(host, other, seat), true);
    await guest.waitForFunction(() => window.__kc === 1 && window.game.match.scores.get('local').kills === 1);
    const results = await guest.evaluate(() => window.game.matchResult(window.game.matchRecord, 'completed').kills);
    assert.deepEqual(results, { ar01: 1 }, 'GRID results count only the member’s own kill, not the seat’s AI kills (feed holds them too)');
    // The host's full feed does hold the seat's earlier (AI) kills: they are kept, just not counted as the member's.
    assert.ok((await host.evaluate((seat) => window.game.match.feed.filter((k) => k.killer === seat).length, seat)) > 1);
    assert.equal(await host.evaluate(() => window.__kc), 2, 'the member’s kill is not the host’s');

    // The member leaves: the bot has its own record back (not +1 from the member).
    await guest.click('#tab-multi');
    await guest.click('.mp-leave');
    await host.waitForFunction((seat) => !window.game.squad.bots.find((b) => b.id === seat).remote, seat);
    const back = await line(host, seat);
    assert.deepEqual([back.kills, back.deaths, back.gen], [lines0[seat].kills, lines0[seat].deaths, lines0[seat].gen + 2]);
    assert.notEqual(back.name, 'Bravo');

    // Reconnect (same room by code): a fresh record again; its kill is confirmed once more (a new kill id).
    await join(guest, code);
    const seat2 = await host.evaluate(() => window.game.squad.bots.find((b) => b.remote).id);
    assert.deepEqual(await line(host, seat2).then((l) => [l.kills, l.deaths, l.name]), [0, 0, 'Bravo']);
    await guest.waitForFunction(() => window.game.match.scores.get('local')?.kills === 0);
    const third = await aiBot(host, [seat2]);
    assert.equal(await kill(host, third, seat2), true);
    await guest.waitForFunction(() => window.__kc === 2 && window.game.match.scores.get('local').kills === 1);

    // The host leaves: the member hosts a new match; every record starts at zero (no carried totals).
    await host.context().close();
    await guest.waitForFunction(() => window.game.netHost && window.game.match && !window.game.netClient, null, { timeout: 30000 });
    const fresh = await guest.evaluate(() => [...window.game.match.scores.values()].every((l) => l.kills === 0 && l.deaths === 0));
    assert.equal(fresh, true);
    assert.deepEqual(guest.errors, []);
  } finally {
    await host.context().close().catch(() => {});
    await guest.context().close();
  }
});
