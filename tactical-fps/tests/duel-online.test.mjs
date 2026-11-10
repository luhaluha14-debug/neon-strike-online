// 1대1 (Phase 23) in a real room: the relay + two games, and a third that
// cannot get in. The host waits alone (nothing moves on, its opponent seat's
// AI never fights); the opponent joins and a fresh match starts; rounds are
// decided by elimination on the host and both screens agree on round wins,
// the personal record (K / D / HS / DAMAGE) and the round records; the
// opponent drops: the match waits, and back in time it gets its record back
// and the cut-off round is played again; dropped and gone: the host wins.

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

const join = async (p, name, code) => {
  await p.click('#tab-multi');
  await p.fill('.mp-name', name);
  await p.fill('.mp-code', code);
  await p.click('.mp-join-btn');
};
const line = (p, id) => p.evaluate((id) => (({ kills, deaths, headshots, damage, team }) => ({ kills, deaths, headshots, damage, team }))(window.game.teamMatch.scores.get(id)), id);
const banner = (p) => p.evaluate(() => document.querySelector('.team-hud .round-banner')?.textContent ?? '');
/** On the host: seat `victim` killed by `by` with two hits (the second to the head). */
const kill = (host, victim, by) =>
  host.evaluate(
    ([victim, by]) => {
      const g = window.game;
      const c = victim === 'local' ? g.combat : g.squad.bots.find((b) => b.id === victim).combat;
      const pos = victim === 'local' ? g.player.position : g.squad.bots.find((b) => b.id === victim).position;
      c.protection = 0;
      for (const [amount, zone] of [
        [60, 'body'],
        [60, 'head'],
      ])
        c.applyDamage({ amount, zone, sourceId: by, weaponId: 'ar01', point: pos.clone(), direction: pos.clone().set(1, 0, 0), distance: 10 });
    },
    [victim, by],
  );
/** Host: until the round is live (prep skipped), everyone protected so only the test decides. */
const live = (host) =>
  host.evaluate(async () => {
    const g = window.game;
    const tm = g.teamMatch;
    for (let i = 0; i < 400 && tm.phase !== 'prep' && tm.phase !== 'live'; i++) await new Promise((r) => setTimeout(r, 50));
    if (tm.phase === 'prep') tm.ready();
    for (let i = 0; i < 400 && tm.phase !== 'live'; i++) await new Promise((r) => setTimeout(r, 50));
    g.combat.protection = 1e9;
    for (const b of g.squad.bots) b.combat.protection = 1e9;
    return tm.phase;
  });

test('1대1: waits alone; the opponent joins a fresh match; rounds and records agree; drop and rejoin; drop and gone; no third player', async () => {
  const host = await openGame(env, { mode: 'deathmatch', width: 480, height: 270 });
  const guest = await openGame(env, { mode: 'training', width: 480, height: 270 });
  const third = await openGame(env, { mode: 'training', width: 480, height: 270 });
  for (const p of [host, guest, third]) p.setDefaultTimeout(60000);
  try {
    await host.click('#tab-multi');
    await host.fill('.mp-name', 'Alpha');
    await host.selectOption('.mp-mode', 'duel');
    await host.click('.mp-create');
    await host.waitForFunction(() => window.game.netHost && window.game.teamMatch && window.game.mode === 'duel');
    const code = (await host.textContent('.mp-room-code')).trim();
    // Alone: the match holds; the opponent seat's AI does not fight.
    const alone = await host.evaluate(async () => {
      const g = window.game;
      let shots = 0;
      const seen = g.netHost.broadcastShot.bind(g.netHost);
      g.netHost.broadcastShot = (by, ...a) => {
        if (by !== 'local') shots++;
        return seen(by, ...a);
      };
      const before = { phase: g.teamMatch.phase, left: g.teamMatch.phaseLeft };
      await new Promise((r) => setTimeout(r, 3000));
      g.netHost.broadcastShot = seen;
      return { before, after: { phase: g.teamMatch.phase, left: g.teamMatch.phaseLeft }, shots, seats: g.teamMatch.scores.size, wait: g.duelWait?.kind };
    });
    assert.deepEqual(alone.after, alone.before, 'nothing moves on while alone');
    assert.equal(alone.shots, 0, 'the opponent seat’s AI never fires');
    assert.equal(alone.seats, 2, 'two seats: the host and its opponent');
    assert.equal(alone.wait, 'join');
    assert.match(await banner(host), /상대를 기다리는 중/);

    // The opponent joins: a fresh match from round 1.
    await join(guest, 'Bravo', code);
    await guest.waitForFunction(() => window.game.netClient?.myId && window.game.teamMatch && window.game.mode === 'duel');
    await host.waitForFunction(() => !window.game.duelWait && window.game.squad.bots[0].remote);
    const seat = await host.evaluate(() => window.game.squad.bots[0].id);
    assert.deepEqual(await host.evaluate(() => [window.game.teamMatch.round, window.game.teamMatch.history.length]), [1, 0]);
    assert.deepEqual([await line(host, 'local'), await line(host, seat)].map((l) => [l.team, l.kills, l.deaths]), [
      ['blue', 0, 0],
      ['red', 0, 0],
    ]);
    // A third player cannot get into a 1대1 room.
    await join(third, 'Charlie', code);
    await third.waitForFunction(() => document.querySelector('.mp-error')?.textContent);
    assert.match(await third.textContent('.mp-error'), /가득|full|정원/i);
    assert.equal(await third.evaluate(() => !!window.game.netClient), false);

    // Round 1: the host takes the opponent down; round 2: the opponent takes the host down.
    assert.equal(await live(host), 'live');
    await kill(host, seat, 'local');
    await host.waitForFunction(() => window.game.teamMatch.history.length === 1);
    assert.equal(await live(host), 'live');
    await kill(host, 'local', seat);
    await host.waitForFunction(() => window.game.teamMatch.history.length === 2);
    await guest.waitForFunction(() => window.game.teamMatch.history.length === 2 && window.game.teamMatch.roundStats.length === 2);
    await guest.waitForTimeout(500);
    const hostView = { wins: await host.evaluate(() => ({ ...window.game.teamMatch.roundWins })), me: await line(host, 'local'), them: await line(host, seat) };
    const guestView = await guest.evaluate(() => {
      const tm = window.game.teamMatch;
      const lines = [...tm.scores.values()].map((l) => ({ id: l.id, name: l.name, kills: l.kills, deaths: l.deaths, headshots: l.headshots, damage: l.damage }));
      return { wins: { ...tm.roundWins }, me: lines.find((l) => l.id === 'local'), host: lines.find((l) => l.id !== 'local'), rounds: tm.roundStats.map((s) => s.players.map((p) => p.slice(4)).sort()) };
    });
    assert.deepEqual(hostView.wins, { blue: 1, red: 1 });
    assert.deepEqual(guestView.wins, hostView.wins, 'round wins agree');
    assert.deepEqual(
      (({ kills, deaths, headshots, damage }) => ({ kills, deaths, headshots, damage }))(hostView.me),
      { kills: 1, deaths: 1, headshots: 1, damage: 100 },
    );
    assert.deepEqual(
      (({ kills, deaths, headshots, damage }) => ({ kills, deaths, headshots, damage }))(guestView.me),
      (({ kills, deaths, headshots, damage }) => ({ kills, deaths, headshots, damage }))(hostView.them),
      'the opponent’s record: the same on both screens',
    );
    assert.deepEqual(
      (({ kills, deaths, headshots, damage }) => ({ kills, deaths, headshots, damage }))(guestView.host),
      (({ kills, deaths, headshots, damage }) => ({ kills, deaths, headshots, damage }))(hostView.me),
    );
    const hostRounds = await host.evaluate(() => window.game.teamMatch.roundStats.map((s) => s.players.map((p) => p.slice(4)).sort()));
    assert.deepEqual(guestView.rounds, hostRounds, 'round records agree');
    // The opponent's HUD shows its record.
    assert.equal(await guest.evaluate(() => ['.cs-kills', '.cs-deaths', '.cs-hs', '.cs-dmg'].map((s) => document.querySelector(`.combat-stats ${s}`).textContent).join(' ')), '1 1 1 100');

    // The opponent drops in round 3: the match waits; it rejoins in time, gets its record back, round 3 again.
    assert.equal(await live(host), 'live');
    await guest.click('.menu-lobby').catch(() => {});
    await guest.evaluate(() => window.game.net.ws.close());
    await guest.waitForFunction(() => !window.game.net);
    await host.waitForFunction(() => window.game.duelWait?.kind === 'rejoin');
    assert.match(await banner(host), /Bravo 연결 끊김 — 재접속 대기 \d+초/);
    const held = await host.evaluate(async () => {
      const tm = window.game.teamMatch;
      const a = [tm.phase, tm.round, tm.roundTimeLeft];
      await new Promise((r) => setTimeout(r, 1500));
      return [a, [tm.phase, tm.round, tm.roundTimeLeft]];
    });
    assert.deepEqual(held[1], held[0], 'the match holds while waiting');
    await guest.click('.lobby [data-lobby="multi"]');
    await guest.click('.mp-rejoin');
    await guest.waitForFunction(() => window.game.netClient?.myId && window.game.teamMatch);
    await host.waitForFunction(() => !window.game.duelWait && window.game.squad.bots[0].remote);
    const back = await host.evaluate((id) => ({ round: window.game.teamMatch.round, phase: window.game.teamMatch.phase, history: window.game.teamMatch.history.length, line: (({ kills, deaths, headshots, damage }) => ({ kills, deaths, headshots, damage }))(window.game.teamMatch.scores.get(id)) }), seat);
    assert.deepEqual(back, { round: 3, phase: 'prep', history: 2, line: { kills: 1, deaths: 1, headshots: 1, damage: 100 } }, 'its record back; round 3 from its start');
    await guest.waitForFunction(() => window.game.teamMatch.scores.get('local')?.kills === 1);

    // Dropped and not back in time: the host wins (the wait is cut short here).
    await guest.evaluate(() => window.game.net.ws.close());
    await host.waitForFunction(() => window.game.duelWait?.kind === 'rejoin');
    await host.evaluate(() => (window.game.duelWait.left = 0.3));
    await host.waitForFunction(() => window.game.teamMatch.over && !document.querySelector('.team-hud .results').hidden);
    const res = await host.evaluate(() => ({
      title: document.querySelector('.team-hud .results-title').textContent,
      mode: document.querySelector('.team-hud .results-personal .cr-mode').textContent,
      rounds: document.querySelectorAll('.team-hud .round-records tbody tr').length,
      winner: window.game.teamMatch.winner,
    }));
    assert.equal(res.winner, 'blue');
    assert.equal(res.title, '상대 기권 - 승리');
    assert.match(res.mode, /1대1 대전/);
    assert.equal(res.rounds, 2, 'the two decided rounds in the round records');
    assert.deepEqual([...host.errors, ...guest.errors, ...third.errors], []);
  } finally {
    await host.context().close();
    await guest.context().close();
    await third.context().close();
  }
});
