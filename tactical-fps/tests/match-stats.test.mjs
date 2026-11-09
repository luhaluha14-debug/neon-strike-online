// Confirmed personal kill statistics (Node): each line counts its current
// controller's credited kills per weapon; that count (not the kill feed,
// which a room member only receives the last part of) is what results and
// GRID rewards use. A long match beyond the feed's reach, a seat hand-over
// and the bot's record coming back, the same state applied twice, and a
// state from an older host (no counts: the feed is counted, as before).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { ROOT } from './harness.mjs';

let vite;
let M;

before(async () => {
  vite = await createServer({ root: ROOT, logLevel: 'error', server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom' });
  M = {
    ...(await vite.ssrLoadModule('/src/game/Match.ts')),
    ...(await vite.ssrLoadModule('/src/game/TeamMatch.ts')),
    ...(await vite.ssrLoadModule('/src/net/Mirror.ts')),
  };
});
after(async () => {
  await vite?.close();
});

const players = () => [{ id: 'local', name: 'Alpha', isPlayer: true }, ...[1, 2, 3].map((i) => ({ id: `bot-${i}`, name: `BOT ${i}`, isPlayer: false }))];
const toWire = (id) => (id === 'local' ? 'p1' : id);
const hostName = (id, n) => (id === 'local' ? 'Alpha' : n);
const asMember = (id) => (id === 'bot-2' ? 'local' : id);
const wire = (m) => JSON.parse(JSON.stringify(M.matchState(m, toWire, hostName)));
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

test('a long match: the member’s confirmed kills reach it in full although the feed it gets is cut short', () => {
  const m = new M.Match({ bots: 3, timeLimit: 3600, killTarget: 1000 }, players());
  m.reassign('bot-2', 'Bravo'); // a member plays seat bot-2
  for (let i = 0; i < 25; i++) m.recordKill('bot-2', i % 2 ? 'bot-1' : 'local', i % 3 ? 'ar01' : 'sr01', false);
  for (let i = 0; i < 6; i++) m.recordKill('bot-3', 'bot-2', 'smg01', false);
  const host = m.scores.get('bot-2');
  assert.deepEqual([host.kills, host.weaponKills], [25, { sr01: 9, ar01: 16 }]);
  const member = M.applyMatch(null, wire(m), asMember);
  assert.ok(member.feed.length < 25, `the feed the member gets is cut short (${member.feed.length} of ${m.feed.length})`);
  const me = member.scores.get('local');
  assert.deepEqual([me.kills, me.weaponKills, member.legacyStats], [25, { sr01: 9, ar01: 16 }, false]);
  assert.equal(sum(me.weaponKills), me.kills, 'per-weapon counts add up to the kills on the board');
  // Counting the feed instead (the old way) would have missed most of them.
  assert.ok(member.feed.filter((k) => M.killBy(me, k)).length < 25);
});

test('hand-over: the bot’s per-weapon kills are kept aside and come back with it; the member starts from none', () => {
  const tm = new M.TeamMatch(M.DEFAULT_TEAM_MATCH, [
    { id: 'local', name: 'Alpha', team: 'blue', isPlayer: true },
    { id: 'bot-5', name: 'R5', team: 'red', isPlayer: false },
    { id: 'bot-6', name: 'R6', team: 'red', isPlayer: false },
  ]);
  tm.update(tm.config.prepTime + 0.01, { blue: 1, red: 2 });
  tm.recordKill('bot-5', 'local', 'ar01', true);
  assert.equal(tm.recordKill('bot-5', 'bot-6', 'ar01', false), false, 'a teammate is not credited');
  assert.deepEqual(tm.scores.get('bot-5').weaponKills, { ar01: 1 });
  const ai = tm.reassign('bot-5', 'Charlie');
  assert.deepEqual(tm.scores.get('bot-5').weaponKills, {});
  assert.deepEqual(ai, { kills: 1, deaths: 0, weaponKills: { ar01: 1 }, headshots: 1, damage: 0 });
  tm.reassign('bot-5', 'R5', ai);
  assert.deepEqual([tm.scores.get('bot-5').kills, tm.scores.get('bot-5').weaponKills], [1, { ar01: 1 }]);
});

test('the same state twice changes nothing (absolute numbers, not additions); counts sent by the host are checked', () => {
  const m = new M.Match({ bots: 3, timeLimit: 600, killTarget: 1000 }, players());
  m.reassign('bot-2', 'Bravo');
  m.recordKill('bot-2', 'bot-1', 'ar01', false);
  const s = wire(m);
  const member = M.applyMatch(null, s, asMember);
  M.applyMatch(member, s, asMember);
  M.applyMatch(member, JSON.parse(JSON.stringify(s)), asMember);
  assert.deepEqual([member.scores.get('local').kills, member.scores.get('local').weaponKills], [1, { ar01: 1 }]);
  // Nonsense in the counts is dropped, not trusted.
  const bad = { ...s, scores: s.scores.map((x) => (x[0] === 'bot-2' ? [...x.slice(0, 5), { ar01: -3, sr01: 1.5, pis01: 2 }] : x)) };
  M.applyMatch(member, bad, asMember);
  assert.deepEqual(member.scores.get('local').weaponKills, { pis01: 2 });
});

test('an older host (no per-weapon counts): the member falls back to counting the feed, as before', () => {
  const m = new M.Match({ bots: 3, timeLimit: 600, killTarget: 1000 }, players());
  m.recordKill('bot-2', 'bot-1', 'ar01', false);
  const s = wire(m);
  const old = { ...s, scores: s.scores.map((x) => x.slice(0, 4)), feed: s.feed.map(({ kg, vg, kn, vn, ...k }) => k) };
  const member = M.applyMatch(null, old, asMember);
  assert.equal(member.legacyStats, true);
  assert.deepEqual(member.scores.get('local').weaponKills, {});
  assert.equal(member.feed.filter((k) => M.killBy(member.scores.get('local'), k)).length, 1);
});
