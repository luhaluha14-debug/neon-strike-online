// Multiplayer state in Node: the match / round / money / bomb state the host
// sends and how a member shows it (ids renamed so the member is 'local'),
// and the host's lag compensation (everyone moved back to what the shooter
// saw, then restored).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { ROOT } from './harness.mjs';

let vite;
let M;

before(async () => {
  vite = await createServer({ root: ROOT, logLevel: 'error', server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom' });
  const load = (p) => vite.ssrLoadModule(p);
  M = {
    ...(await load('/src/net/Mirror.ts')),
    ...(await load('/src/net/LagCompensation.ts')),
    ...(await load('/src/game/Match.ts')),
    ...(await load('/src/game/TeamMatch.ts')),
    ...(await load('/src/game/BombObjective.ts')),
    ...(await load('/src/player/PlayerController.ts')),
    THREE: await load('three'),
  };
});
after(async () => {
  await vite?.close();
});

// Host 'local' is member p1 on the wire; the member plays bot-6 (its 'local').
const toWire = (id) => (id === 'local' ? 'p1' : id);
const hostName = (id, name) => (id === 'local' ? 'Alpha' : name);
const toMember = (id) => (id === 'bot-6' ? 'local' : id);

function teamRoster() {
  return [
    { id: 'local', name: 'YOU', team: 'blue', isPlayer: true },
    ...[1, 2, 3, 4].map((i) => ({ id: `bot-${i}`, name: `B${i}`, team: 'blue', isPlayer: false })),
    ...[5, 6, 7, 8, 9].map((i) => ({ id: `bot-${i}`, name: i === 6 ? 'Bravo' : `R${i}`, team: 'red', isPlayer: false })),
  ];
}

test('team match: round, scores, kill feed, money and payouts reach the member with itself as local; the same objects are updated', () => {
  const host = new M.TeamMatch(M.DEFAULT_TEAM_MATCH, teamRoster());
  host.update(host.config.prepTime + 0.01, { blue: 5, red: 5 });
  host.recordKill('bot-6', 'bot-2', 'ar01', true);
  host.recordKill('local', 'bot-7', 'ar01', false);
  const wire = M.teamMatchState(host, toWire, hostName);
  const s = JSON.parse(JSON.stringify(wire)); // through the network
  const mine = M.applyTeamMatch(null, s, toMember);
  assert.equal(mine.phase, 'live');
  assert.deepEqual(
    [mine.scores.get('local').name, mine.scores.get('local').team, mine.scores.get('local').kills, mine.scores.get('local').isPlayer],
    ['Bravo', 'red', 1, true],
  );
  assert.equal(mine.scores.get('p1').name, 'Alpha', "the host's line under its member id and name");
  assert.equal(mine.scores.get('p1').isPlayer, false);
  assert.equal(mine.economy.money('local'), host.economy.money('bot-6'));
  assert.deepEqual(mine.feed.map((k) => [k.killer, k.victim]), [['local', 'bot-2'], ['p1', 'bot-7']]);
  assert.equal(mine.teamOf('local'), 'red');
  // Next state: same objects, new values.
  host.update(999, { blue: 0, red: 5 });
  const again = M.applyTeamMatch(mine, JSON.parse(JSON.stringify(M.teamMatchState(host, toWire, hostName))), toMember);
  assert.equal(again, mine, 'the HUD keeps the same match object');
  assert.equal(mine.phase, 'result');
  assert.deepEqual(mine.roundWins, { blue: 0, red: 1 });
  assert.equal(mine.lastRound.winner, 'red');
  assert.equal(mine.economy.lastPayout.get('local').reason, 'win');
});

test('deathmatch: scores, feed, clock and the end reach the member; a changed line-up builds a new match', () => {
  const players = [{ id: 'local', name: 'YOU', isPlayer: true }, ...[1, 2, 3].map((i) => ({ id: `bot-${i}`, name: `BOT ${i}`, isPlayer: false }))];
  const host = new M.Match({ bots: 3, timeLimit: 600, killTarget: 2 }, players);
  host.update(12);
  host.recordKill('bot-2', 'local', 'sr01', true);
  const toMe = (id) => (id === 'bot-2' ? 'local' : id);
  const mine = M.applyMatch(null, JSON.parse(JSON.stringify(M.matchState(host, toWire, hostName))), toMe);
  assert.equal(mine.scores.get('local').kills, 1);
  assert.equal(mine.scores.get('p1').deaths, 1);
  assert.equal(mine.timeLeft, 588);
  host.recordKill('bot-2', 'bot-1', 'sr01', false);
  M.applyMatch(mine, JSON.parse(JSON.stringify(M.matchState(host, toWire, hostName))), toMe);
  assert.equal(mine.over, true);
  assert.equal(mine.playerWon, true, 'the member won (its own line is the player)');
  const other = M.applyMatch(mine, { ...M.matchState(host, toWire, hostName), scores: [['x', 'X', 0, 0]] }, toMe);
  assert.notEqual(other, mine);
});

test('bomb: carrier, plant progress and timer follow the host; ids renamed', () => {
  const sites = [{ name: 'A', box: new M.THREE.Box3(new M.THREE.Vector3(0, 0, 0), new M.THREE.Vector3(4, 1, 4)) }];
  const host = new M.BombObjective(sites);
  host.reset('bot-6', new M.THREE.Vector3(1, 0, 1));
  const mine = new M.BombObjective(sites);
  M.applyBomb(mine, JSON.parse(JSON.stringify(M.bombState(host, toWire))), toMember);
  assert.deepEqual([mine.state, mine.carrier, mine.position.toArray()], ['carried', 'local', [1, 0, 1]]);
  host.state = 'planted';
  host.site = 'A';
  host.timeLeft = 31.5;
  host.defusing = { id: 'local', time: 2, hits: 0 };
  M.applyBomb(mine, JSON.parse(JSON.stringify(M.bombState(host, toWire))), toMember);
  assert.deepEqual([mine.state, mine.site, mine.timeLeft, mine.defusing.id], ['planted', 'A', 31.5, 'p1']);
});

test('lag compensation: targets are put where they were at the shooter’s view time (clamped), then restored', () => {
  const lag = new M.LagCompensation();
  const world = { capsuleOverlaps: () => false };
  const a = new M.PlayerController(world);
  const b = new M.PlayerController(world);
  for (let i = 0; i <= 60; i++) {
    const t = i / 120;
    a.position.set(i * 0.05, 0, 0); // moving 6 m/s along x
    b.position.set(5, 0, 0);
    lag.record('a', a, t);
    lag.record('b', b, t);
  }
  const now = 60 / 120;
  const seen = lag.rewind(now - 0.1, now, 'b', () => [a.position.x, b.position.x]);
  assert.ok(Math.abs(seen[0] - (now - 0.1) * 6) < 1e-6, `a back 0.1 s (${seen[0]})`);
  assert.equal(seen[1], 5, 'the shooter itself is not moved');
  assert.equal(a.position.x, 3, 'restored');
  const far = lag.rewind(now - 5, now, 'b', () => a.position.x);
  assert.ok(Math.abs(far - (now - M.MAX_REWIND) * 6) < 1e-6, 'never more than MAX_REWIND back');
  assert.throws(() => lag.rewind(now, now, 'b', () => {
    throw new Error('boom');
  }));
  assert.equal(a.position.x, 3, 'restored even when the shot throws');
  // A respawn far away: the old places are dropped (a rewind never puts it back where it was before the jump).
  a.position.set(40, 0, 0);
  lag.record('a', a, now + 1 / 120);
  assert.equal(lag.rewind(now - 0.1, now + 1 / 120, 'b', () => a.position.x), 40);
});
