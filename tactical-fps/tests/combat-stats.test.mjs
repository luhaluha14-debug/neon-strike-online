// Personal combat statistics (Phase 20), the rules (Node): kills, deaths,
// K/D, headshot kills and damage dealt live on each seat's score line, which
// only the match authority writes (deathmatch Match, team TeamMatch). A kill
// counts once per death (the same death cannot be counted again), headshots
// are the kills whose final hit was to the head (the kill feed's HS), damage
// is the health actually taken from enemies. Room members get the host's
// numbers as state (the same state twice, or an old one, changes nothing), and
// a seat that changes hands starts a fresh record (a member who rejoins does
// not get its earlier numbers added again).

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
    ...(await vite.ssrLoadModule('/src/game/CombatStats.ts')),
    ...(await vite.ssrLoadModule('/src/net/Mirror.ts')),
  };
});
after(async () => {
  await vite?.close();
});

const dm = () => new M.Match({ bots: 3, timeLimit: 600, killTarget: 30 }, [{ id: 'local', name: 'YOU', isPlayer: true }, ...[1, 2, 3].map((i) => ({ id: `bot-${i}`, name: `BOT ${i}`, isPlayer: false }))]);
const teamRoster = () => [
  { id: 'local', name: 'Alpha', team: 'blue', isPlayer: true },
  { id: 'bot-1', name: 'B1', team: 'blue', isPlayer: false },
  { id: 'bot-5', name: 'R5', team: 'red', isPlayer: false },
  { id: 'bot-6', name: 'R6', team: 'red', isPlayer: false },
];
const live = (tm) => tm.update(tm.config.prepTime + 0.01, { blue: 2, red: 2 });
const rec = (l) => ({ kills: l.kills, deaths: l.deaths, headshots: l.headshots, damage: l.damage });

test('1, 4, 5: one kill counts once, with its headshot and the damage that took the health', () => {
  const m = dm();
  // Four body hits of 25 and the final one: 100 health taken, one kill, by a head hit.
  for (let i = 0; i < 3; i++) assert.equal(m.recordDamage('local', 'bot-1', 25), 25);
  assert.equal(m.recordDamage('local', 'bot-1', 25), 25);
  assert.equal(m.recordKill('local', 'bot-1', 'ar01', true), true);
  assert.deepEqual(rec(m.scores.get('local')), { kills: 1, deaths: 0, headshots: 1, damage: 100 });
  assert.deepEqual(rec(m.scores.get('bot-1')), { kills: 0, deaths: 1, headshots: 0, damage: 0 });
  // A body-shot kill: no headshot.
  m.recordDamage('local', 'bot-2', 100);
  m.recordKill('local', 'bot-2', 'ar01', false);
  assert.deepEqual(rec(m.scores.get('local')), { kills: 2, deaths: 0, headshots: 1, damage: 200 });
  // The kill feed says the same.
  const mine = m.feed.filter((k) => M.killBy(m.scores.get('local'), k));
  assert.deepEqual([mine.length, mine.filter((k) => k.head).length], [2, 1]);
});

test('2: a shotgun blast of eight pellets is one kill; damage is what the pellets took, not their nominal sum', () => {
  const m = dm();
  // The pellets as the target applies them: health lost each, nothing once it is down (PlayerCombat drops hits on the dead).
  let hp = 100;
  let kills = 0;
  for (let p = 0; p < 8; p++) {
    if (hp <= 0) break;
    const took = Math.min(hp, 18);
    hp -= took;
    m.recordDamage('local', 'bot-1', took);
    if (hp === 0) kills += m.recordKill('local', 'bot-1', 'sg01', p === 5) ? 1 : 0;
  }
  assert.equal(kills, 1);
  assert.deepEqual(rec(m.scores.get('local')), { kills: 1, deaths: 0, headshots: 1, damage: 100 });
});

test('3: deaths count when the death is confirmed; a suicide is a death with no kill, as the board always had it', () => {
  const m = dm();
  m.recordKill('bot-2', 'local', 'ar01', false);
  m.recordKill('local', 'local', 'ar01', false);
  m.recordKill('c4', 'local', 'c4', false); // a death with no shooter seat
  assert.deepEqual(rec(m.scores.get('local')), { kills: 0, deaths: 3, headshots: 0, damage: 0 });
  assert.equal(m.scores.get('bot-2').kills, 1);
  // Self-damage and damage from no seat credit nobody.
  assert.equal(m.recordDamage('local', 'local', 40), 0);
  assert.equal(m.recordDamage('c4', 'local', 60), 0);
  assert.equal(m.scores.get('local').damage, 0);
});

test('5: damage is whole points of health, never more than one full health per hit; garbage counts nothing', () => {
  const m = dm();
  assert.equal(m.recordDamage('local', 'bot-1', 33.4), 33);
  assert.equal(m.recordDamage('local', 'bot-1', 1e9), 100);
  for (const bad of [0, -5, NaN, Infinity]) assert.equal(m.recordDamage('local', 'bot-1', bad), 0);
  assert.equal(m.recordDamage('local', 'nobody', 50), 0, 'not a combatant of this match');
  assert.equal(m.scores.get('local').damage, 133);
});

test('6, 7: K/D is kills per death, two decimals; with no deaths it is the kills', () => {
  assert.equal(M.kdRatio(12, 5), 2.4);
  assert.equal(M.formatKd(12, 5), '2.40');
  assert.equal(M.formatKd(1, 3), '0.33');
  assert.equal(M.formatKd(0, 4), '0.00');
  assert.equal(M.formatKd(7, 0), '7.00');
  assert.equal(M.formatKd(0, 0), '0.00');
});

test('8: team match: the record carries across rounds; nothing counts outside a live round; no credit against a teammate', () => {
  const tm = new M.TeamMatch(M.DEFAULT_TEAM_MATCH, teamRoster());
  assert.equal(tm.recordDamage('local', 'bot-5', 50), 0, 'prep: nothing counts');
  live(tm);
  assert.equal(tm.recordDamage('local', 'bot-1', 30), 0, 'a teammate');
  tm.recordDamage('local', 'bot-5', 100);
  tm.recordKill('local', 'bot-5', 'ar01', true);
  tm.recordDamage('local', 'bot-6', 100);
  tm.recordKill('local', 'bot-6', 'ar01', false);
  tm.update(0.01, { blue: 2, red: 0 }); // round won
  assert.equal(tm.phase, 'result');
  assert.equal(tm.recordDamage('local', 'bot-5', 40), 0, 'after the round is decided: nothing counts');
  const r1 = rec(tm.scores.get('local'));
  assert.deepEqual(r1, { kills: 2, deaths: 0, headshots: 1, damage: 200 });
  // Next round: same record, adds up.
  while (tm.phase !== 'live') tm.update(0.5, { blue: 2, red: 2 });
  assert.equal(tm.round, 2);
  assert.deepEqual(rec(tm.scores.get('local')), r1, 'kept across the round change');
  tm.recordDamage('bot-5', 'local', 100);
  tm.recordKill('bot-5', 'local', 'ar01', false);
  tm.recordDamage('local', 'bot-6', 64);
  assert.deepEqual(rec(tm.scores.get('local')), { kills: 2, deaths: 1, headshots: 1, damage: 264 });
});

test('9: a new match starts every record at zero (deathmatch and team)', () => {
  const a = dm();
  a.recordDamage('local', 'bot-1', 100);
  a.recordKill('local', 'bot-1', 'ar01', true);
  const b = dm();
  assert.deepEqual(rec(b.scores.get('local')), { kills: 0, deaths: 0, headshots: 0, damage: 0 });
  const tm = new M.TeamMatch(M.DEFAULT_TEAM_MATCH, teamRoster());
  for (const l of tm.scores.values()) assert.deepEqual(rec(l), { kills: 0, deaths: 0, headshots: 0, damage: 0 });
});

test('10: room member: the host state applied twice, or an old one late, does not add anything; a rejoin starts the seat fresh', () => {
  const host = dm();
  host.reassign('bot-2', 'Bravo'); // a member plays bot-2
  const toWire = (id) => (id === 'local' ? 'p1' : id);
  const wire = () => JSON.parse(JSON.stringify(M.matchState(host, toWire, (id, n) => (id === 'local' ? 'Alpha' : n))));
  const asMember = (id) => (id === 'bot-2' ? 'local' : id);
  const old = wire();
  for (let i = 0; i < 3; i++) {
    host.recordDamage('bot-2', 'bot-1', 100);
    host.recordKill('bot-2', 'bot-1', 'ar01', i === 0);
  }
  let member = M.applyMatch(null, wire(), asMember);
  const want = { kills: 3, deaths: 0, headshots: 1, damage: 300 };
  assert.deepEqual(rec(member.scores.get('local')), want);
  member = M.applyMatch(member, wire(), asMember);
  member = M.applyMatch(member, wire(), asMember);
  assert.deepEqual(rec(member.scores.get('local')), want, 'the same state again');
  member = M.applyMatch(member, old, asMember);
  member = M.applyMatch(member, wire(), asMember);
  assert.deepEqual(rec(member.scores.get('local')), want, 'an old state, then the current one');
  // The member leaves (the AI gets the seat back) and joins again (a new controller): a fresh record, not 3 + 3.
  const ai = host.reassign('bot-2', 'BOT 2');
  host.reassign('bot-2', 'Bravo');
  assert.deepEqual(rec(ai), want, 'the leaving member’s record went with it');
  member = M.applyMatch(member, wire(), asMember);
  assert.deepEqual(rec(member.scores.get('local')), { kills: 0, deaths: 0, headshots: 0, damage: 0 });
  host.recordDamage('bot-2', 'bot-3', 100);
  host.recordKill('bot-2', 'bot-3', 'ar01', false);
  member = M.applyMatch(member, wire(), asMember);
  assert.deepEqual(rec(member.scores.get('local')), { kills: 1, deaths: 0, headshots: 0, damage: 100 });
});

test('team match state carries headshots and damage; an older host (no such fields) shows zeros; garbage is not shown', () => {
  const tm = new M.TeamMatch(M.DEFAULT_TEAM_MATCH, teamRoster());
  live(tm);
  tm.recordDamage('bot-5', 'local', 80);
  tm.recordDamage('bot-5', 'bot-1', 100);
  tm.recordKill('bot-5', 'bot-1', 'ar01', true);
  const s = JSON.parse(JSON.stringify(M.teamMatchState(tm, (id) => id, (_, n) => n)));
  const asBot5 = (id) => (id === 'bot-5' ? 'local' : id === 'local' ? 'bot-5' : id);
  const member = M.applyTeamMatch(null, s, asBot5);
  assert.deepEqual(rec(member.scores.get('local')), { kills: 1, deaths: 0, headshots: 1, damage: 180 });
  const older = JSON.parse(JSON.stringify(s));
  for (const row of older.scores) row.length = 7; // no hs / dmg
  const fromOld = M.applyTeamMatch(null, older, asBot5);
  assert.deepEqual(rec(fromOld.scores.get('local')), { kills: 1, deaths: 0, headshots: 0, damage: 0 });
  const bad = JSON.parse(JSON.stringify(s));
  for (const row of bad.scores) {
    row[7] = 99; // more headshots than kills
    row[8] = -1;
  }
  const fromBad = M.applyTeamMatch(null, bad, asBot5);
  assert.deepEqual([fromBad.scores.get('local').headshots, fromBad.scores.get('local').damage], [1, 0]);
});

test('12: bots keep their own record by the same rules (kills on the board, deaths, headshots, damage)', () => {
  const m = dm();
  m.recordDamage('bot-1', 'local', 100);
  m.recordKill('bot-1', 'local', 'ar01', true);
  m.recordDamage('bot-1', 'bot-3', 60);
  m.recordDamage('bot-1', 'bot-3', 40);
  m.recordKill('bot-1', 'bot-3', 'ar01', false);
  const b = m.scores.get('bot-1');
  assert.deepEqual(rec(b), { kills: 2, deaths: 0, headshots: 1, damage: 200 });
  assert.equal(m.ranking[0].id, 'bot-1', 'the board ranks by the same kills');
  // A hand-over keeps the AI's record aside (with headshots and damage) and brings it back.
  const kept = m.reassign('bot-1', 'Bravo');
  assert.deepEqual(rec(m.scores.get('bot-1')), { kills: 0, deaths: 0, headshots: 0, damage: 0 });
  m.reassign('bot-1', 'BOT 1', kept);
  assert.deepEqual(rec(m.scores.get('bot-1')), { kills: 2, deaths: 0, headshots: 1, damage: 200 });
});

test('13: training keeps its own record (kills, headshot kills, damage taken from the dummies; no deaths), reset per session', () => {
  const t = new M.TrainingStats();
  t.hit(40, false, false);
  t.hit(60, true, true);
  t.hit(100, true, false);
  assert.deepEqual(rec(t), { kills: 2, deaths: 0, headshots: 1, damage: 200 });
  t.reset();
  assert.deepEqual(rec(t), { kills: 0, deaths: 0, headshots: 0, damage: 0 });
});

test('after the match ends nothing more is counted (deathmatch)', () => {
  const m = dm();
  m.config.killTarget = 1;
  m.recordDamage('local', 'bot-1', 100);
  m.recordKill('local', 'bot-1', 'ar01', false);
  assert.equal(m.over, true);
  assert.equal(m.recordDamage('local', 'bot-2', 100), 0);
  assert.equal(m.recordKill('local', 'bot-2', 'ar01', true), false);
  assert.deepEqual(rec(m.scores.get('local')), { kills: 1, deaths: 0, headshots: 0, damage: 100 });
});
