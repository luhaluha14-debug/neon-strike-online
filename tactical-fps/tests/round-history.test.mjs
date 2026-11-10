// Round history (Phase 21), the rules (Node): each decided round of a team
// match gets one record (TeamMatch.roundStats, next to its history entry):
// how long it was live, the C4 in a bomb round, and every seat's kills,
// deaths, headshot kills and damage in that round alone, by the same rules
// as the match record (Phase 20). Written once, where the round is decided;
// a room member gets the host's records as state (a repeat or an old state
// changes nothing). Deathmatch has no rounds and gets none.

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
    ...(await vite.ssrLoadModule('/src/ui/roundRecords.ts')),
  };
});
after(async () => {
  await vite?.close();
});

const roster = () => [
  { id: 'local', name: 'YOU', team: 'blue', isPlayer: true },
  { id: 'bot-1', name: 'B1', team: 'blue', isPlayer: false },
  { id: 'bot-5', name: 'R5', team: 'red', isPlayer: false },
  { id: 'bot-6', name: 'R6', team: 'red', isPlayer: false },
];
const elim = (over = {}) => new M.TeamMatch({ ...M.DEFAULT_TEAM_MATCH, objective: 'elimination', economy: null, ...over }, roster());
const bombMatch = (over = {}) => new M.TeamMatch({ ...M.DEFAULT_TEAM_MATCH, economy: null, ...over }, roster());
const toLive = (tm, alive = { blue: 2, red: 2 }) => {
  let n = 0;
  while (tm.phase !== 'live' && n++ < 1000) tm.update(0.25, alive);
  assert.equal(tm.phase, 'live');
};
/** A kill with its damage, as the game applies it (hits first, then the death). */
const kill = (tm, killer, victim, head = false, hits = [60, 40]) => {
  for (const h of hits) tm.recordDamage(killer, victim, h);
  return tm.recordKill(killer, victim, 'ar01', head);
};
const row = (st, id) => {
  const p = st.players.find((x) => x[0] === id);
  return p && { name: p[1], team: p[2], kills: p[4], deaths: p[5], headshots: p[6], damage: p[7] };
};

test('1, 2, 3, 4, 5: a round ends once with its record: number, time live, each seat’s K / D / HS / DAMAGE in it; winner and loser', () => {
  const tm = elim();
  toLive(tm);
  tm.update(12.5, { blue: 2, red: 2 }); // 12.5 s of play
  kill(tm, 'local', 'bot-5', true);
  kill(tm, 'bot-6', 'bot-1');
  tm.recordDamage('local', 'bot-6', 30);
  kill(tm, 'local', 'bot-6', false, [70]);
  assert.equal(tm.update(0.5, { blue: 1, red: 0 }), 'round-end');
  assert.equal(tm.history.length, 1);
  assert.equal(tm.roundStats.length, 1);
  const st = tm.roundStats[0];
  assert.equal(st.round, 1);
  assert.equal(st.duration, 13);
  assert.equal(st.bomb, undefined, 'no C4 in an elimination match');
  assert.deepEqual(row(st, 'local'), { name: 'YOU', team: 'blue', kills: 2, deaths: 0, headshots: 1, damage: 200 });
  assert.deepEqual(row(st, 'bot-6'), { name: 'R6', team: 'red', kills: 1, deaths: 1, headshots: 0, damage: 100 });
  assert.deepEqual(row(st, 'bot-1'), { name: 'B1', team: 'blue', kills: 0, deaths: 1, headshots: 0, damage: 0 });
  assert.deepEqual(row(st, 'bot-5'), { name: 'R5', team: 'red', kills: 0, deaths: 1, headshots: 0, damage: 0 });
  assert.equal(st.players.length, 4, 'every seat, those that did nothing too');
  // Winner and loser from each side.
  const r = tm.history[0];
  assert.equal(r.winner, 'blue');
  assert.equal(M.roundOutcome(r, 'blue'), '승리');
  assert.equal(M.roundOutcome(r, 'red'), '패배');
  assert.equal(M.roundOutcome({ ...r, winner: null }, 'blue'), '무승부');
});

test('3, 8: round numbers in order; every round keeps its own record; the match record is their sum', () => {
  const tm = elim();
  const want = [];
  for (let round = 1; round <= 3; round++) {
    toLive(tm);
    if (round === 2) {
      kill(tm, 'bot-5', 'local', true);
      kill(tm, 'bot-5', 'bot-1');
      tm.update(0.1, { blue: 0, red: 2 });
      want.push({ round, winner: 'red', me: { kills: 0, deaths: 1, headshots: 0, damage: 0 } });
    } else {
      kill(tm, 'local', 'bot-5', round === 3);
      kill(tm, 'local', 'bot-6');
      tm.update(0.1, { blue: 2, red: 0 });
      want.push({ round, winner: 'blue', me: { kills: 2, deaths: 0, headshots: round === 3 ? 1 : 0, damage: 200 } });
    }
  }
  assert.deepEqual(
    tm.roundStats.map((s, i) => ({ round: s.round, winner: tm.history[i].winner, me: (({ kills, deaths, headshots, damage }) => ({ kills, deaths, headshots, damage }))(row(s, 'local')) })),
    want,
  );
  assert.deepEqual(tm.history.map((h) => h.round), [1, 2, 3]);
  const me = tm.scores.get('local');
  const sum = (k) => tm.roundStats.reduce((a, s) => a + row(s, 'local')[k], 0);
  assert.deepEqual([sum('kills'), sum('deaths'), sum('headshots'), sum('damage')], [me.kills, me.deaths, me.headshots, me.damage]);
});

test('6: the C4: exploded, defused, planted then the defenders wiped out, never planted; by whom', () => {
  const plantRound = (tm) => {
    toLive(tm);
    assert.equal(tm.bombPlanted('local'), true);
  };
  // Exploded.
  const a = bombMatch();
  plantRound(a);
  a.update(3, { blue: 2, red: 2 });
  assert.equal(a.bombExploded({ blue: 2, red: 1 }), 'round-end');
  assert.deepEqual(a.roundStats[0].bomb, { planted: true, plantedBy: 'YOU' });
  assert.equal(M.bombLine(a.history[0], a.roundStats[0]), 'C4 설치 (YOU) → 폭파(공격 성공)');
  // Defused.
  const d = bombMatch();
  plantRound(d);
  assert.equal(d.bombDefused('bot-5', { blue: 1, red: 1 }), 'round-end');
  assert.deepEqual(d.roundStats[0].bomb, { planted: true, plantedBy: 'YOU', defusedBy: 'R5' });
  assert.equal(d.history[0].winner, 'red');
  assert.equal(M.bombLine(d.history[0], d.roundStats[0]), 'C4 설치 (YOU) → 해체 (R5)(방어 성공)');
  // Planted, then the defenders wiped out.
  const w = bombMatch();
  plantRound(w);
  kill(w, 'local', 'bot-5');
  kill(w, 'bot-1', 'bot-6');
  w.update(0.1, { blue: 2, red: 0 });
  assert.equal(w.history[0].reason, 'elimination');
  assert.deepEqual(w.roundStats[0].bomb, { planted: true, plantedBy: 'YOU' });
  assert.equal(M.bombLine(w.history[0], w.roundStats[0]), 'C4 설치 (YOU) → 방어팀 전멸');
  // Never planted: the clock ran out.
  const t = bombMatch({ roundTime: 5 });
  toLive(t);
  t.update(6, { blue: 2, red: 2 });
  assert.equal(t.history[0].reason, 'time');
  assert.deepEqual(t.roundStats[0].bomb, { planted: false });
  assert.equal(M.bombLine(t.history[0], t.roundStats[0]), 'C4 미설치 · 시간 종료(방어 성공)');
  assert.equal(t.roundStats[0].duration, 5, 'a full round clock');
  // The next round starts without the last one's C4.
  let n = 0;
  while (t.phase !== 'live' && n++ < 1000) t.update(0.25, { blue: 2, red: 2 });
  kill(t, 'local', 'bot-5');
  kill(t, 'local', 'bot-6');
  t.update(0.1, { blue: 2, red: 0 });
  assert.deepEqual(t.roundStats[1].bomb, { planted: false });
});

test('7: one record per round: a second end (explosion after a defuse, an update after the end, a stray kill) adds nothing', () => {
  const tm = bombMatch();
  toLive(tm);
  tm.bombPlanted('local');
  // The last kill lands on the tick that decides the round: it counts.
  kill(tm, 'bot-5', 'bot-1');
  assert.equal(tm.bombDefused('bot-6', { blue: 1, red: 2 }), 'round-end');
  assert.equal(tm.bombExploded({ blue: 1, red: 2 }), null);
  assert.equal(tm.bombDefused('bot-6', { blue: 1, red: 2 }), null);
  assert.equal(tm.recordKill('bot-5', 'local', 'ar01', true), false, 'after the decision: nothing counts');
  assert.equal(tm.recordDamage('bot-5', 'local', 50), 0);
  tm.update(0.1, { blue: 0, red: 2 });
  assert.equal(tm.history.length, 1);
  assert.equal(tm.roundStats.length, 1);
  assert.deepEqual(row(tm.roundStats[0], 'bot-5'), { name: 'R5', team: 'red', kills: 1, deaths: 0, headshots: 0, damage: 100 });
  assert.deepEqual(row(tm.roundStats[0], 'local'), { name: 'YOU', team: 'blue', kills: 0, deaths: 0, headshots: 0, damage: 0 });
  // A forfeit adds no round (as the history always had it).
  tm.forfeit('blue');
  assert.equal(tm.roundStats.length, 1);
});

test('9: a new match starts with no round records', () => {
  const a = elim();
  toLive(a);
  kill(a, 'local', 'bot-5');
  kill(a, 'local', 'bot-6');
  a.update(0.1, { blue: 2, red: 0 });
  assert.equal(a.roundStats.length, 1);
  const b = elim();
  assert.deepEqual([b.history.length, b.roundStats.length], [0, 0]);
});

test('10: bots are recorded by the same rules; a seat that changes hands mid-round starts its round tally again (as its match record)', () => {
  const tm = elim();
  toLive(tm);
  kill(tm, 'bot-5', 'bot-1', true);
  // A member takes bot-6 over mid-round: the AI's part of the round is the AI's and leaves with it.
  kill(tm, 'bot-6', 'local');
  tm.reassign('bot-6', 'Bravo');
  tm.recordDamage('bot-6', 'local', 0);
  tm.update(0.1, { blue: 0, red: 2 });
  const st = tm.roundStats[0];
  assert.deepEqual(row(st, 'bot-5'), { name: 'R5', team: 'red', kills: 1, deaths: 0, headshots: 1, damage: 100 });
  assert.deepEqual(row(st, 'bot-6'), { name: 'Bravo', team: 'red', kills: 0, deaths: 0, headshots: 0, damage: 0 }, 'the member, from its take-over');
  assert.equal(st.players.find((p) => p[0] === 'bot-6')[3], 1, 'by its controller generation');
  assert.deepEqual(row(st, 'local'), { name: 'YOU', team: 'blue', kills: 0, deaths: 1, headshots: 0, damage: 0 });
});

test('13, 14: room member: the host’s records as they are (ids as the member sees them); a repeat or an old state adds nothing; an older host has none; garbage is dropped', () => {
  const host = elim();
  host.reassign('bot-5', 'Bravo'); // a member plays bot-5
  const toWire = (id) => (id === 'local' ? 'p1' : id);
  const wire = () => JSON.parse(JSON.stringify(M.teamMatchState(host, toWire, (id, n) => (id === 'local' ? 'Alpha' : n))));
  const asMember = (id) => (id === 'bot-5' ? 'local' : id === 'p1' ? 'p1' : id);
  const old = wire();
  for (let r = 0; r < 2; r++) {
    toLive(host);
    kill(host, 'bot-5', 'bot-1', r === 0);
    kill(host, 'bot-5', 'local');
    host.update(0.1, { blue: 0, red: 2 });
  }
  let member = M.applyTeamMatch(null, wire(), asMember);
  const view = (m) => m.roundStats.map((s) => ({ round: s.round, duration: s.duration, me: row(s, 'local'), host: row(s, 'p1') }));
  const want = [1, 2].map((round) => ({
    round,
    duration: host.roundStats[round - 1].duration,
    me: { name: 'Bravo', team: 'red', kills: 2, deaths: 0, headshots: round === 1 ? 1 : 0, damage: 200 },
    host: { name: 'Alpha', team: 'blue', kills: 0, deaths: 1, headshots: 0, damage: 0 },
  }));
  assert.deepEqual(view(member), want);
  for (let i = 0; i < 3; i++) member = M.applyTeamMatch(member, wire(), asMember);
  assert.deepEqual(view(member), want, 'the same state again: still two rounds');
  member = M.applyTeamMatch(member, old, asMember);
  member = M.applyTeamMatch(member, wire(), asMember);
  assert.deepEqual(view(member), want, 'an old state, then the current one');
  // An older host: no round records, nothing invented.
  const older = wire();
  delete older.rounds;
  assert.equal(M.applyTeamMatch(null, older, asMember).roundStats.length, 0);
  // Garbage: bad rows dropped, numbers checked (headshots never above kills).
  const bad = wire();
  bad.rounds[0].players.push(['x', 'X', 'green', 0, 1, 1, 1, 1], 'nope');
  bad.rounds[0].players[0][6] = 99;
  bad.rounds[0].duration = -4;
  const fromBad = M.applyTeamMatch(null, bad, asMember);
  assert.equal(fromBad.roundStats[0].players.length, host.roundStats[0].players.length);
  assert.ok(fromBad.roundStats[0].players[0][6] <= fromBad.roundStats[0].players[0][4]);
  assert.equal(fromBad.roundStats[0].duration, 0);
});

test('11: deathmatch has no rounds: no round records at all', () => {
  const m = new M.Match({ bots: 2, timeLimit: 600, killTarget: 30 }, [
    { id: 'local', name: 'YOU', isPlayer: true },
    { id: 'bot-1', name: 'B', isPlayer: false },
  ]);
  m.recordDamage('local', 'bot-1', 100);
  m.recordKill('local', 'bot-1', 'ar01', true);
  assert.equal('roundStats' in m, false);
  assert.equal('rounds' in JSON.parse(JSON.stringify(M.matchState(m, (id) => id, (_, n) => n))), false);
});
