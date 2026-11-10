// Personal combat statistics in a real room (Phase 20): relay + two games.
// Only the host applies damage and decides deaths, so the member's KILLS /
// DEATHS / K/D / HEADSHOTS / DAMAGE are the host's numbers for its seat: both
// screens agree, for the member's record and for the host's. The member
// computes nothing itself (a hit it reports never counts until the host
// applies it). States sent again change nothing; a dropped connection and a
// rejoin start the member's seat afresh (its earlier numbers are not added
// again), as the board has always treated a seat that changes hands.

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

const hudNumbers = (page) =>
  page.evaluate(() => ['.cs-kills', '.cs-deaths', '.cs-kd', '.cs-hs', '.cs-dmg'].map((s) => document.querySelector(`.combat-stats ${s}`).textContent).join(' '));

test('11, 10: room: host and member agree on both records (HUD and board); repeated states and a rejoin never double anything', async () => {
  const host = await openGame(env, { mode: 'deathmatch', width: 640, height: 360 });
  const guest = await openGame(env, { mode: 'training', width: 640, height: 360 });
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
    await guest.evaluate(() => {
      window.__states = [];
      const receive = window.game.netClient.receive.bind(window.game.netClient);
      window.game.netClient.receive = (d) => {
        if (d?.k === 'match') window.__states.push(d);
        receive(d);
      };
    });

    // On the host: quiet room; the member's seat kills 3 AI bots (2 by a final head hit), the host kills the member's seat once.
    const seat = await host.evaluate(() => {
      const g = window.game;
      g.squad.respawns = false;
      g.match.config.killTarget = 1000;
      for (const b of g.squad.bots) b.combat.protection = 1e9;
      g.combat.protection = 1e9;
      const seat = g.squad.bots.find((b) => b.remote);
      const ai = g.squad.bots.filter((b) => !b.remote);
      // Everyone back up at full health (they fought before the room was quieted).
      for (const b of g.squad.bots) {
        b.spawn(b.position.clone(), 0);
        b.combat.protection = 1e9;
      }
      const pick = (l) => ({ kills: l.kills, deaths: l.deaths, headshots: l.headshots, damage: l.damage });
      window.__before = { member: pick(g.match.scores.get(seat.id)), host: pick(g.match.scores.get('local')) };
      const hit = (victim, by, amount, zone) => {
        victim.combat.protection = 0;
        victim.combat.applyDamage({ amount, zone, sourceId: by, weaponId: 'ar01', point: victim.position.clone(), direction: victim.position.clone().set(0, 0, 1), distance: 8 });
      };
      for (let i = 0; i < 3; i++) {
        const b = ai[i];
        hit(b, seat.id, 70, 'body');
        hit(b, seat.id, 70, i < 2 ? 'head' : 'body'); // 30 of these 70 are left to take
        b.spawn(b.position.clone(), 0);
        b.combat.protection = 1e9;
      }
      hit(seat, 'local', 45, 'body');
      hit(seat, 'local', 80, 'head'); // 55 left
      return seat.id;
    });
    const lines = await host.evaluate((id) => {
      const pick = (l) => ({ kills: l.kills, deaths: l.deaths, headshots: l.headshots, damage: l.damage });
      return { member: pick(window.game.match.scores.get(id)), host: pick(window.game.match.scores.get('local')), before: window.__before };
    }, seat);
    const delta = (a, b) => Object.fromEntries(Object.keys(a).map((k) => [k, a[k] - b[k]]));
    assert.deepEqual(delta(lines.member, lines.before.member), { kills: 3, deaths: 1, headshots: 2, damage: 300 }, 'by the host: 3 kills, 2 by the head, 3 × 100 health');
    assert.deepEqual(delta(lines.host, lines.before.host), { kills: 1, deaths: 0, headshots: 1, damage: 100 });
    const fmt = (l) => `${l.kills} ${l.deaths} ${(l.deaths ? l.kills / l.deaths : l.kills).toFixed(2)} ${l.headshots} ${l.damage}`;

    // The member's HUD shows its record as the host has it; the host's HUD its own.
    await guest.waitForFunction((d) => window.game.match.scores.get('local')?.damage === d, lines.member.damage);
    await guest.waitForTimeout(300);
    await host.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
    assert.equal(await hudNumbers(guest), fmt(lines.member), 'the member’s HUD = the host’s line for its seat');
    assert.equal(await hudNumbers(host), fmt(lines.host));
    // Each screen's board line for the other agrees.
    const hostOnGuest = await guest.evaluate(() => {
      const l = [...window.game.match.scores.values()].find((x) => x.name === 'Alpha');
      return { kills: l.kills, deaths: l.deaths, headshots: l.headshots, damage: l.damage };
    });
    assert.deepEqual(hostOnGuest, lines.host);

    // The member's own report of a hit is not a hit: its record moves only by the host's states.
    const before = await guest.evaluate(() => window.__states.length);
    const replay = await guest.evaluate(() => {
      const g = window.game;
      const all = window.__states.slice();
      for (const d of all) g.netClient.receive(d); // every state again, oldest first
      g.netClient.receive(all.at(-1));
      const l = g.match.scores.get('local');
      return { kills: l.kills, deaths: l.deaths, headshots: l.headshots, damage: l.damage, states: all.length };
    });
    assert.ok(replay.states >= before && replay.states >= 1, `states received (${replay.states})`);
    assert.deepEqual({ ...replay, states: undefined }, { ...lines.member, states: undefined }, 'every state again: the same record');

    // The connection drops and the member rejoins: a fresh seat record, the host's line for it not doubled.
    await guest.click('.menu-lobby');
    await guest.evaluate(() => window.game.net.ws.close());
    await guest.waitForFunction(() => !window.game.net);
    await guest.click('.lobby [data-lobby="multi"]');
    await guest.click('.mp-rejoin');
    await guest.waitForFunction(() => window.game.netClient?.myId && window.game.match);
    await host.waitForFunction(() => window.game.squad.bots.some((b) => b.remote));
    const after = await host.evaluate(() => {
      const g = window.game;
      const seat = g.squad.bots.find((b) => b.remote);
      const pick = (l) => ({ kills: l.kills, deaths: l.deaths, headshots: l.headshots, damage: l.damage });
      return { seat: seat.id, line: pick(g.match.scores.get(seat.id)), host: pick(g.match.scores.get('local')) };
    });
    assert.deepEqual(after.line, { kills: 0, deaths: 0, headshots: 0, damage: 0 }, 'the rejoined member starts its seat afresh');
    assert.deepEqual(after.host, lines.host, 'the host’s own record untouched');
    await guest.waitForFunction(() => window.game.match.scores.get('local')?.kills === 0);
    // One more kill after the rejoin counts once on both screens.
    await host.evaluate((id) => {
      const g = window.game;
      const seat = g.squad.bots.find((b) => b.id === id);
      const b = g.squad.bots.find((x) => !x.remote && x.alive);
      b.combat.protection = 0;
      b.combat.applyDamage({ amount: 999, zone: 'head', sourceId: seat.id, weaponId: 'ar01', point: b.position.clone(), direction: b.position.clone().set(0, 0, 1), distance: 8 });
    }, after.seat);
    await guest.waitForFunction(() => window.game.match.scores.get('local')?.kills === 1);
    await guest.waitForTimeout(300);
    assert.equal(await hudNumbers(guest), '1 0 1.00 1 100');
    assert.deepEqual(guest.errors, []);
    assert.deepEqual(host.errors, []);
  } finally {
    await host.context().close();
    await guest.context().close();
  }
});
