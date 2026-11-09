// Personal records vs. seats (Node): a bot scores, a room member takes its
// seat over and starts from zero (the bot's kills are not the member's and
// stay out of the member's results), later kills are the member's, the bot
// gets its own record back when the member leaves; team rounds, history and
// money never move; the generation crosses the network with the scores; the
// kill feed keeps who scored then.

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

const dmPlayers = () => [{ id: 'local', name: 'Alpha', isPlayer: true }, ...[1, 2, 3].map((i) => ({ id: `bot-${i}`, name: `BOT ${i}`, isPlayer: false }))];
const mine = (m, id) => m.feed.filter((k) => M.killBy(m.scores.get(id), k)).length;

test('deathmatch: the bot’s kills before the hand-over are not the member’s; the member’s kills after are; the bot gets its own record back', () => {
  const m = new M.Match({ bots: 3, timeLimit: 600, killTarget: 30 }, dmPlayers());
  m.recordKill('bot-1', 'bot-2', 'ar01', false);
  m.recordKill('bot-1', 'local', 'ar01', true);
  m.recordKill('bot-3', 'bot-1', 'ar01', false);
  assert.deepEqual([m.scores.get('bot-1').kills, m.scores.get('bot-1').deaths], [2, 1]);
  // A member takes the seat over.
  const ai = m.reassign('bot-1', 'Bravo');
  assert.deepEqual(ai, { kills: 2, deaths: 1, weaponKills: { ar01: 2 }, headshots: 1, damage: 0 }, 'the AI record, kept aside');
  const line = m.scores.get('bot-1');
  assert.deepEqual([line.name, line.kills, line.deaths, line.gen], ['Bravo', 0, 0, 1]);
  assert.equal(mine(m, 'bot-1'), 0, 'the earlier kills in the feed are not the member’s');
  // The feed still says who scored them.
  const first = m.feed[0];
  assert.equal(M.feedName(m.scores, first.killer, first.kg, first.kn), 'BOT 1');
  // The member scores.
  assert.equal(m.recordKill('bot-1', 'bot-3', 'ar01', false), true);
  assert.deepEqual([line.kills, mine(m, 'bot-1')], [1, 1]);
  assert.equal(M.feedName(m.scores, 'bot-1', m.feed.at(-1).kg, m.feed.at(-1).kn), 'Bravo');
  // Others are untouched.
  assert.deepEqual([m.scores.get('local').deaths, m.scores.get('bot-3').kills], [1, 1]);
  // The member leaves: the AI's record comes back, the member's kill is not added to it.
  m.reassign('bot-1', 'BOT 1', ai);
  assert.deepEqual([line.name, line.kills, line.deaths, line.gen], ['BOT 1', 2, 1, 2]);
  assert.equal(mine(m, 'bot-1'), 0, 'neither the member’s kill nor the old ones count for the new controller');
  assert.equal(m.reassign('nobody', 'X'), null);
});

test('team match: a hand-over resets only the personal line; rounds, history, money and the other lines stay', () => {
  const roster = [
    { id: 'local', name: 'Alpha', team: 'blue', isPlayer: true },
    { id: 'bot-1', name: 'B1', team: 'blue', isPlayer: false },
    { id: 'bot-5', name: 'R5', team: 'red', isPlayer: false },
    { id: 'bot-6', name: 'R6', team: 'red', isPlayer: false },
  ];
  const tm = new M.TeamMatch(M.DEFAULT_TEAM_MATCH, roster);
  tm.update(tm.config.prepTime + 0.01, { blue: 2, red: 2 });
  tm.recordKill('bot-5', 'bot-1', 'ar01', false);
  tm.recordKill('bot-5', 'local', 'ar01', false);
  tm.update(0.01, { blue: 0, red: 2 });
  assert.equal(tm.phase, 'result');
  const before = { wins: { ...tm.roundWins }, history: tm.history.length, money: tm.economy.money('bot-5'), round: tm.round };
  const ai = tm.reassign('bot-5', 'Charlie');
  assert.deepEqual(ai, { kills: 2, deaths: 0, weaponKills: { ar01: 2 }, headshots: 0, damage: 0 });
  assert.deepEqual([tm.scores.get('bot-5').kills, tm.scores.get('bot-5').team], [0, 'red']);
  assert.deepEqual({ wins: { ...tm.roundWins }, history: tm.history.length, money: tm.economy.money('bot-5'), round: tm.round }, before, 'team score and the seat’s money are not personal');
  assert.deepEqual([tm.scores.get('local').deaths, tm.scores.get('bot-1').deaths], [1, 1]);
  assert.equal(mine(tm, 'bot-5'), 0);
});

test('network: the generation goes with the scores; the member’s screen counts only its own kills as its own; an older host (no generation) reads as 0', () => {
  const m = new M.Match({ bots: 3, timeLimit: 600, killTarget: 30 }, dmPlayers());
  m.recordKill('bot-2', 'bot-3', 'ar01', false); // the AI on seat bot-2
  m.reassign('bot-2', 'Bravo'); // the member takes it
  m.recordKill('bot-2', 'local', 'ar01', true); // the member's kill
  const toWire = (id) => (id === 'local' ? 'p1' : id);
  const s = JSON.parse(JSON.stringify(M.matchState(m, toWire, (id, n) => (id === 'local' ? 'Alpha' : n))));
  const member = M.applyMatch(null, s, (id) => (id === 'bot-2' ? 'local' : id));
  const me = member.scores.get('local');
  assert.deepEqual([me.name, me.kills, me.gen], ['Bravo', 1, 1]);
  assert.equal(member.feed.filter((k) => M.killBy(me, k)).length, 1, 'the AI’s kill on this seat is not counted as the member’s');
  assert.equal(member.feed.length, 2);
  // A state without the generation field (an older host): everything reads as generation 0.
  const old = { ...s, scores: s.scores.map((x) => x.slice(0, 4)), feed: s.feed.map(({ kg, vg, kn, vn, ...k }) => k) };
  const legacy = M.applyMatch(null, old, (id) => (id === 'bot-2' ? 'local' : id));
  assert.equal(legacy.scores.get('local').gen, 0);
});
