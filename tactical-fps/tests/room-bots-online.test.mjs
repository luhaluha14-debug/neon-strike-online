// Phase 26-B: the room's bot setting. The relay keeps it (the host's choice when the room is made, the
// host alone can change it, 1대1 never has bots), every member sees it, and the host's game follows it:
// allowed, empty places are played by bots as before; not allowed, a seat nobody plays is out of the
// match (no AI, no body, no line on the board) and comes back when someone takes it. Real games over a
// real relay: deathmatch and team with bots on and off, a member that cannot change it, leaving and
// coming back, the host leaving, and 1대1 left as it was.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { startEnv, openGame, ROOT } from './harness.mjs';

let vite;
let relay;
let env;
let M;

before(async () => {
  vite = await createServer({ root: ROOT, logLevel: 'error', server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom' });
  M = { ...(await vite.ssrLoadModule('/server/mp/rooms.ts')), ...(await vite.ssrLoadModule('/src/net/Protocol.ts')) };
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

// --- the relay (no sockets) ----------------------------------------------------------------------

function world(codes = ['AAAAA', 'BBBBB', 'CCCCC', 'DDDDD', 'EEEEE', 'FFFFF']) {
  let i = 0;
  const rooms = new M.Rooms(() => codes[i++ % codes.length]);
  const hi = (name) => {
    const id = rooms.connect();
    rooms.handle(id, { t: 'hello', v: M.MP_PROTOCOL, name });
    return id;
  };
  return { rooms, hi };
}
const roomMsgs = (out) => out.filter((o) => o.msg.t === 'room').map((o) => [o.to, o.msg.room.bots]);
const errorOf = (out) => out.find((o) => o.msg.t === 'error')?.msg.error ?? null;

test('relay: bots allowed unless the host says no; 1대1 never; a bad value refused; the list says it', () => {
  const { rooms, hi } = world();
  const a = hi('a');
  const b = hi('b');
  const c = hi('c');
  const d = hi('d');
  rooms.handle(a, { t: 'create', mode: 'deathmatch', map: 'warehouse' });
  rooms.handle(b, { t: 'create', mode: 'team', map: 'seoul', bots: false });
  rooms.handle(c, { t: 'create', mode: 'duel', map: 'warehouse', bots: true });
  assert.equal(rooms.roomOf(a).bots, true, 'no choice sent (an older client): bots, as before');
  assert.equal(rooms.roomOf(b).bots, false);
  assert.equal(rooms.roomOf(c).bots, false, '1대1: no bots whatever is asked');
  assert.equal(errorOf(rooms.handle(d, { t: 'create', mode: 'deathmatch', map: 'warehouse', bots: 'no' })), 'bad_request');
  assert.equal(rooms.roomOf(d), null);
  assert.deepEqual(
    rooms.list().map((r) => [r.code, r.mode, r.bots]),
    [
      ['AAAAA', 'deathmatch', true],
      ['BBBBB', 'team', false],
      ['CCCCC', 'duel', false],
    ],
  );
});

test('relay: only the host changes it, everyone in the room hears; 1대1 cannot; joining, quick join and the host leaving keep it', () => {
  const { rooms, hi } = world();
  const host = hi('host');
  const m1 = hi('m1');
  const m2 = hi('m2');
  rooms.handle(host, { t: 'create', mode: 'team', map: 'seoul', bots: false });
  const code = rooms.roomOf(host).code;
  rooms.handle(m1, { t: 'join', code });
  assert.equal(rooms.roomOf(m1).bots, false, 'a member joining gets the room as it is');
  // A member cannot change it.
  assert.equal(errorOf(rooms.handle(m1, { t: 'bots', bots: true })), 'not_host');
  assert.equal(rooms.roomOf(host).bots, false);
  // The host can: both get the room with the new setting.
  assert.deepEqual(roomMsgs(rooms.handle(host, { t: 'bots', bots: true })), [
    [host, true],
    [m1, true],
  ]);
  assert.equal(errorOf(rooms.handle(host, { t: 'bots', bots: 1 })), 'bad_request');
  rooms.handle(host, { t: 'bots', bots: false });
  // Quick join into an open room of the mode: the room keeps its own setting (the joiner's is for a new room only).
  rooms.handle(m2, { t: 'quick', mode: 'team', map: 'seoul', bots: true });
  assert.equal(rooms.roomOf(m2).code, code);
  assert.equal(rooms.roomOf(m2).bots, false);
  // The host leaves: the next host has the same room, the same setting; a member leaving and coming back too.
  rooms.handle(host, { t: 'leave' });
  assert.equal(rooms.roomOf(m1).hostId, m1);
  assert.equal(rooms.roomOf(m1).bots, false);
  rooms.handle(m2, { t: 'leave' });
  rooms.handle(m2, { t: 'join', code });
  assert.equal(rooms.roomOf(m2).bots, false);
  assert.equal(errorOf(rooms.handle(m2, { t: 'bots', bots: true })), 'not_host', 'still not the host');
  // A quick join that finds no open room makes one with the joiner's choice.
  const q = hi('q');
  rooms.handle(q, { t: 'quick', mode: 'deathmatch', map: 'warehouse', bots: false });
  assert.equal(rooms.roomOf(q).bots, false);
  assert.equal(rooms.roomOf(q).hostId, q);
  // 1대1: nothing to change.
  const d = hi('d');
  rooms.handle(d, { t: 'create', mode: 'duel', map: 'warehouse' });
  assert.equal(errorOf(rooms.handle(d, { t: 'bots', bots: true })), 'bad_request');
  assert.equal(rooms.roomOf(d).bots, false);
  // No room: nothing to change.
  const lone = hi('lone');
  assert.equal(errorOf(rooms.handle(lone, { t: 'bots', bots: false })), 'no_room');
});

// --- real games ----------------------------------------------------------------------------------

const create = async (p, name, mode, bots) => {
  await p.click('#tab-multi');
  await p.fill('.mp-name', name);
  await p.selectOption('.mp-mode', mode);
  if (bots !== undefined) await p.selectOption('.mp-bots', bots ? 'on' : 'off');
  await p.click('.mp-create');
  await p.waitForFunction((m) => window.game.netHost && window.game.mode === m && (window.game.match || window.game.teamMatch) && window.game.squad, mode);
  return (await p.textContent('.mp-room-code')).trim();
};
const join = async (p, name, code) => {
  await p.click('#tab-multi');
  await p.fill('.mp-name', name);
  await p.fill('.mp-code', code);
  await p.click('.mp-join-btn');
  await p.waitForFunction(() => window.game.netClient?.myId && (window.game.match || window.game.teamMatch));
};
/** The host's match: seats in it, seats out of it, seats people play, lines on the board. */
const seats = (host) =>
  host.evaluate(() => {
    const g = window.game;
    const bots = g.squad.bots;
    return {
      inMatch: bots.filter((b) => !b.benched).length,
      out: bots.filter((b) => b.benched).length,
      played: bots.filter((b) => b.remote).length,
      ai: bots.filter((b) => !b.remote && !b.benched).length,
      lines: (g.match ?? g.teamMatch).scores.size,
      outVisible: bots.filter((b) => b.benched && g.squad.group.getObjectByName(b.id)?.visible).length,
      outAlive: bots.filter((b) => b.benched && b.alive).length,
      room: g.net.room.bots,
    };
  });
const roomView = (p) =>
  p.evaluate(() => ({
    bots: window.game.net?.room?.bots,
    text: document.querySelector('.mp-room-bots-text').textContent,
    toggle: !document.querySelector('.mp-bots-toggle').hidden,
    lobby: document.querySelector('.lobby-room-meta').textContent,
  }));
/** A member's view: the other characters it is shown and the board's lines. */
const memberView = (p) => p.evaluate(() => ({ others: window.game.netClient.puppets.all.size, lines: (window.game.match ?? window.game.teamMatch).scores.size }));
/** Rounds fired by AI seats on the host during `ms`. */
const aiShots = (host, ms) =>
  host.evaluate(async (ms) => {
    const g = window.game;
    let n = 0;
    const seen = g.netHost.broadcastShot.bind(g.netHost);
    g.netHost.broadcastShot = (by, ...a) => {
      const b = g.squad.bots.find((x) => x.id === by);
      if (b && !b.remote) n++;
      return seen(by, ...a);
    };
    await new Promise((r) => setTimeout(r, ms));
    g.netHost.broadcastShot = seen;
    return n;
  }, ms);

test('deathmatch, bots not allowed: the host alone, a member in, a member that cannot change it, leaving and back, then bots allowed', async () => {
  const host = await openGame(env, { mode: 'deathmatch', width: 480, height: 270 });
  const guest = await openGame(env, { mode: 'training', width: 480, height: 270 });
  for (const p of [host, guest]) p.setDefaultTimeout(60000);
  try {
    const code = await create(host, 'Alpha', 'deathmatch', false);
    // Alone: no bot in the match at all.
    assert.deepEqual(await seats(host), { inMatch: 0, out: 7, played: 0, ai: 0, lines: 1, outVisible: 0, outAlive: 0, room: false });
    assert.equal(await aiShots(host, 1500), 0, 'nobody fires');
    assert.deepEqual(await roomView(host), { bots: false, text: '봇: 비허용 — 사람만 경기합니다', toggle: true, lobby: '데스매치 · 1/8명 · 봇 비허용' });

    // A member joins: its seat is in the match, nothing else; it sees only the host.
    await join(guest, 'Bravo', code);
    await host.waitForFunction(() => window.game.squad.bots.some((b) => b.remote));
    assert.deepEqual(await seats(host), { inMatch: 1, out: 6, played: 1, ai: 0, lines: 2, outVisible: 0, outAlive: 0, room: false });
    await guest.waitForFunction(() => window.game.netClient.puppets.all.size === 1 && window.game.match.scores.size === 2);
    assert.deepEqual(await memberView(guest), { others: 1, lines: 2 });
    assert.deepEqual(await roomView(guest), { bots: false, text: '봇: 비허용 — 사람만 경기합니다 (방장만 바꿀 수 있음)', toggle: false, lobby: '데스매치 · 2/8명 · 봇 비허용' });
    // The member's seat really plays: alive, placed, and the host's hits land on it.
    const hit = await host.evaluate(() => {
      const g = window.game;
      const b = g.squad.bots.find((x) => x.remote);
      b.combat.protection = 0;
      const before = b.combat.health;
      b.combat.applyDamage({ amount: 30, zone: 'body', sourceId: 'local', weaponId: 'ar01', point: b.position.clone(), direction: b.position.clone().set(1, 0, 0), distance: 10 });
      return { alive: b.alive, before, after: b.combat.health };
    });
    assert.deepEqual(hit, { alive: true, before: 100, after: 70 });

    // The member tries to switch bots on: the relay refuses, nothing changes anywhere.
    await guest.evaluate(() => window.game.net.setBots(true));
    await guest.waitForTimeout(800);
    assert.equal((await roomView(guest)).bots, false);
    assert.equal((await roomView(host)).bots, false);
    assert.deepEqual(await seats(host), { inMatch: 1, out: 6, played: 1, ai: 0, lines: 2, outVisible: 0, outAlive: 0, room: false });

    // The member leaves: its seat is out again (no bot takes it over).
    await guest.click('.mp-leave');
    await host.waitForFunction(() => !window.game.squad.bots.some((b) => b.remote));
    assert.deepEqual(await seats(host), { inMatch: 0, out: 7, played: 0, ai: 0, lines: 1, outVisible: 0, outAlive: 0, room: false });
    // Back by code: the same setting, in again.
    await join(guest, 'Bravo', code);
    await host.waitForFunction(() => window.game.squad.bots.some((b) => b.remote));
    assert.equal((await roomView(guest)).bots, false);
    assert.equal((await seats(host)).lines, 2);

    // The host allows bots (during the match: asked first, then 확인): both see it, the match starts over with
    // the empty places played by bots.
    await host.click('.mp-bots-toggle');
    await host.click('.mp-confirm-ok');
    await host.waitForFunction(() => window.game.squad.bots.filter((b) => !b.benched).length === 7);
    assert.deepEqual(await seats(host), { inMatch: 7, out: 0, played: 1, ai: 6, lines: 8, outVisible: 0, outAlive: 0, room: true });
    await guest.waitForFunction(() => window.game.net.room.bots === true && window.game.netClient.puppets.all.size === 7);
    assert.deepEqual(await roomView(guest), { bots: true, text: '봇: 허용 — 빈 자리를 봇이 채웁니다 (방장만 바꿀 수 있음)', toggle: false, lobby: '데스매치 · 2/8명 · 봇 허용' });
    assert.equal((await roomView(host)).text, '봇: 허용 — 빈 자리를 봇이 채웁니다');
    assert.deepEqual(host.errors, []);
    assert.deepEqual(guest.errors, []);
  } finally {
    await host.context().close();
    await guest.context().close();
  }
});

test('deathmatch and team, bots allowed (the default): every empty place has a bot, as before', async () => {
  const dm = await openGame(env, { mode: 'deathmatch', width: 480, height: 270 });
  const team = await openGame(env, { mode: 'deathmatch', width: 480, height: 270 });
  for (const p of [dm, team]) p.setDefaultTimeout(60000);
  try {
    await create(dm, 'Delta', 'deathmatch');
    assert.deepEqual(await seats(dm), { inMatch: 7, out: 0, played: 0, ai: 7, lines: 8, outVisible: 0, outAlive: 0, room: true });
    await create(team, 'Echo', 'team');
    assert.deepEqual(await seats(team), { inMatch: 9, out: 0, played: 0, ai: 9, lines: 10, outVisible: 0, outAlive: 0, room: true });
    assert.equal(await team.evaluate(() => window.game.teamWait), null, 'no waiting with bots');
    assert.equal((await roomView(team)).text, '봇: 허용 — 빈 자리를 봇이 채웁니다');
    // The bots play: the deathmatch AI fires within a few seconds (they fight each other).
    assert.ok((await aiShots(dm, 6000)) > 0, 'the bots fight');
    assert.deepEqual(dm.errors, []);
    assert.deepEqual(team.errors, []);
  } finally {
    await dm.context().close();
    await team.context().close();
  }
});

test('team, bots not allowed: waits for the other team; two people play a round; one leaves and the round waits; the host leaves and the next host keeps it', async () => {
  const host = await openGame(env, { mode: 'deathmatch', width: 480, height: 270 });
  const g1 = await openGame(env, { mode: 'training', width: 480, height: 270 });
  const g2 = await openGame(env, { mode: 'training', width: 480, height: 270 });
  for (const p of [host, g1, g2]) p.setDefaultTimeout(60000);
  const banner = (p) => p.evaluate(() => document.querySelector('.team-hud .round-banner')?.textContent ?? '');
  try {
    const code = await create(host, 'Alpha', 'team', false);
    // Alone: no bots, the match holds still, the banner says why.
    const alone = await host.evaluate(async () => {
      const tm = window.game.teamMatch;
      const before = [tm.phase, tm.phaseLeft, tm.round];
      await new Promise((r) => setTimeout(r, 2000));
      return { before, after: [tm.phase, tm.phaseLeft, tm.round], wait: window.game.teamWait };
    });
    assert.deepEqual(alone.after, alone.before, 'nothing moves on');
    assert.equal(alone.wait, 'join');
    assert.match(await banner(host), /봇 없는 방 — 상대 팀 플레이어를 기다리는 중/);
    assert.deepEqual(await seats(host), { inMatch: 0, out: 9, played: 0, ai: 0, lines: 1, outVisible: 0, outAlive: 0, room: false });

    // The first opponent: RED, a fresh match, two lines, one alive on each side.
    await join(g1, 'Bravo', code);
    await host.waitForFunction(() => !window.game.teamWait && window.game.squad.bots.some((b) => b.remote));
    const start = await host.evaluate(() => {
      const g = window.game;
      const b = g.squad.bots.find((x) => x.remote);
      return { team: b.team, round: g.teamMatch.round, history: g.teamMatch.history.length, alive: g.teamAlive() };
    });
    assert.deepEqual(start, { team: 'red', round: 1, history: 0, alive: { blue: 1, red: 1 } });
    assert.deepEqual(await seats(host), { inMatch: 1, out: 8, played: 1, ai: 0, lines: 2, outVisible: 0, outAlive: 0, room: false });
    await g1.waitForFunction(() => window.game.teamMatch.scores.size === 2 && window.game.netClient.puppets.all.size === 1);

    // A round between the two: the host takes the member down, BLUE wins by elimination.
    await host.evaluate(async () => {
      const tm = window.game.teamMatch;
      for (let i = 0; i < 400 && tm.phase !== 'prep' && tm.phase !== 'live'; i++) await new Promise((r) => setTimeout(r, 50));
      if (tm.phase === 'prep') tm.ready();
      for (let i = 0; i < 400 && tm.phase !== 'live'; i++) await new Promise((r) => setTimeout(r, 50));
      const b = window.game.squad.bots.find((x) => x.remote);
      b.combat.protection = 0;
      for (const zone of ['body', 'head']) b.combat.applyDamage({ amount: 60, zone, sourceId: 'local', weaponId: 'ar01', point: b.position.clone(), direction: b.position.clone().set(1, 0, 0), distance: 10 });
    });
    await host.waitForFunction(() => window.game.teamMatch.history.length === 1);
    assert.deepEqual(await host.evaluate(() => [window.game.teamMatch.history[0].winner, window.game.teamMatch.history[0].reason]), ['blue', 'elimination']);
    await g1.waitForFunction(() => window.game.teamMatch.history.length === 1);

    // A second member: one person on each side already, so it joins BLUE (the host's side; ties go BLUE).
    await join(g2, 'Charlie', code);
    await host.waitForFunction(() => window.game.squad.bots.filter((b) => b.remote).length === 2);
    assert.equal((await seats(host)).lines, 3);

    // RED's only player leaves: the match waits for a RED player (it is not over, nobody wins by it).
    await g1.click('.mp-leave');
    await host.waitForFunction(() => window.game.teamWait === 'rejoin');
    const waiting = await host.evaluate(() => ({ over: window.game.teamMatch.over, history: window.game.teamMatch.history.length }));
    assert.deepEqual(waiting, { over: false, history: 1 });
    // The banner says so (from the next drawn frame on).
    await host.waitForFunction(() => /상대 팀에 플레이어가 없어 기다리는 중/.test(document.querySelector('.team-hud .round-banner')?.textContent ?? ''));
    assert.equal((await seats(host)).lines, 2);
    // Back: the round is played again from its start, the match goes on.
    await join(g1, 'Bravo', code);
    await host.waitForFunction(() => !window.game.teamWait && window.game.squad.bots.filter((b) => b.remote).length === 2);
    assert.equal(await host.evaluate(() => window.game.teamMatch.history.length), 1, 'the match went on (not restarted)');

    // The host leaves: the longest-standing member hosts the same room, still without bots.
    await host.click('.mp-leave');
    await g2.waitForFunction(() => window.game.netHost && window.game.teamMatch && window.game.squad);
    await g2.waitForFunction(() => window.game.squad.bots.some((b) => b.remote));
    const next = await seats(g2);
    assert.deepEqual(next, { inMatch: 1, out: 8, played: 1, ai: 0, lines: 2, outVisible: 0, outAlive: 0, room: false });
    assert.equal((await roomView(g2)).toggle, true, 'the new host can change it');
    assert.equal((await roomView(g1)).toggle, false);
    assert.equal((await roomView(g1)).bots, false);
    for (const p of [host, g1, g2]) assert.deepEqual(p.errors, []);
  } finally {
    for (const p of [host, g1, g2]) await p.context().close();
  }
});

test('1대1: no bot setting to choose or change; it waits for its opponent exactly as before', async () => {
  const host = await openGame(env, { mode: 'deathmatch', width: 480, height: 270 });
  host.setDefaultTimeout(60000);
  try {
    await host.click('#tab-multi');
    const field = () => host.evaluate(() => ({ choice: !document.querySelector('.mp-bots-field').hidden, note: !document.querySelector('.mp-bots-duel').hidden }));
    assert.deepEqual(await field(), { choice: true, note: false });
    await host.selectOption('.mp-mode', 'duel');
    assert.deepEqual(await field(), { choice: false, note: true }, '1대1: no choice, a note instead');
    // Even with "no bots" picked before switching to 1대1, the room is simply a 1대1 room.
    await host.selectOption('.mp-mode', 'deathmatch');
    await host.selectOption('.mp-bots', 'off');
    await host.selectOption('.mp-mode', 'duel');
    await host.fill('.mp-name', 'Alpha');
    await host.click('.mp-create');
    await host.waitForFunction(() => window.game.netHost && window.game.teamMatch && window.game.mode === 'duel');
    const r = await host.evaluate(() => {
      const g = window.game;
      return { room: g.net.room.bots, allowed: g.botsAllowed, out: g.squad.bots.filter((b) => b.benched).length, seats: g.teamMatch.scores.size, teamWait: g.teamWait };
    });
    assert.deepEqual(r, { room: false, allowed: true, out: 0, seats: 2, teamWait: null }, 'the 1대1 rules as they were: two seats, nobody benched');
    await host.waitForFunction(() => window.game.duelWait?.kind === 'join');
    assert.deepEqual(await roomView(host), { bots: false, text: '봇: 없음 (1대1은 두 사람만)', toggle: false, lobby: '1대1 대전 · 1/2명 · 봇 없음 (1대1)' });
    // Asking the relay anyway changes nothing.
    await host.evaluate(() => window.game.net.setBots(true));
    await host.waitForTimeout(800);
    assert.equal(await host.evaluate(() => window.game.net.room.bots), false);
    assert.equal(await host.evaluate(() => window.game.duelWait?.kind), 'join');
    assert.deepEqual(host.errors, []);
  } finally {
    await host.context().close();
  }
});

test('team wait: the host’s teammate sees the same wait as the host, then everyone the same round again; the host’s word is checked', async () => {
  const { teamWaitOf } = await vite.ssrLoadModule('/src/net/GameMessages.ts');
  assert.deepEqual(teamWaitOf(['rejoin', 'red']), ['rejoin', 'red']);
  for (const bad of [null, 'join', ['join'], ['wait', 'red'], ['join', 'green'], ['join', 'red', 1]]) assert.equal(teamWaitOf(bad), null, JSON.stringify(bad));

  const host = await openGame(env, { mode: 'deathmatch', width: 480, height: 270 });
  const red = await openGame(env, { mode: 'training', width: 480, height: 270 });
  const blue = await openGame(env, { mode: 'training', width: 480, height: 270 });
  const all = [host, red, blue];
  for (const p of all) p.setDefaultTimeout(60000);
  /** One screen: its banner, its team, what it knows of the wait, the match phase / round it shows. */
  const screen = (p) =>
    p.evaluate(() => {
      const g = window.game;
      return {
        banner: document.querySelector('.team-hud .round-banner')?.textContent ?? '',
        shown: !document.querySelector('.team-hud .round-banner')?.hidden,
        team: g.localTeam,
        wait: g.netClient ? g.netTeamWait : g.teamWaitState,
        phase: g.teamMatch?.phase,
        round: g.teamMatch?.round,
      };
    });
  // Before round 1 has gone live the wait is 'join' (a fresh match when someone comes), after it 'rejoin'.
  const waitText = /봇 없는 방 — 상대 팀(에 플레이어가 없어 기다리는 중| 플레이어를 기다리는 중)/;
  const anyWait = /봇 없는 방/;
  try {
    const code = await create(host, 'Alpha', 'team', false);
    await join(red, 'Bravo', code);
    await host.waitForFunction(() => !window.game.teamWait && window.game.squad.bots.some((b) => b.remote && b.team === 'red'));
    await join(blue, 'Charlie', code);
    await host.waitForFunction(() => window.game.squad.bots.filter((b) => b.remote).length === 2);
    await blue.waitForFunction(() => window.game.localTeam === 'blue' && window.game.teamMatch);
    // Playing: no screen says it waits.
    await host.waitForTimeout(600);
    for (const p of all) {
      const s = await screen(p);
      assert.equal(s.wait, null);
      assert.doesNotMatch(s.banner, anyWait);
    }

    // RED's only player leaves: the host and its BLUE teammate both say the match waits, and it does.
    await red.click('.mp-leave');
    await host.waitForFunction(() => !!window.game.teamWait);
    const kind = await host.evaluate(() => window.game.teamWait);
    for (const p of [host, blue]) await p.waitForFunction((src) => new RegExp(src).test(document.querySelector('.team-hud .round-banner')?.textContent ?? ''), waitText.source);
    const a = await screen(host);
    const b = await screen(blue);
    assert.deepEqual([a.wait, b.wait], [[kind, 'red'], [kind, 'red']]);
    assert.match(a.banner, kind === 'join' ? /상대 팀 플레이어를 기다리는 중/ : /상대 팀에 플레이어가 없어 기다리는 중/, 'the words match the state');
    assert.deepEqual([a.team, b.team], ['blue', 'blue']);
    assert.equal(b.banner, a.banner, 'the same words on both screens');
    assert.ok(a.shown && b.shown);
    // The state they show is the match's: held (nothing moves on, on the host or as the teammate is told).
    const held = await host.evaluate(async () => {
      const tm = window.game.teamMatch;
      const before = [tm.phase, tm.phaseLeft, tm.roundTimeLeft, tm.round];
      await new Promise((r) => setTimeout(r, 1500));
      return { before, after: [tm.phase, tm.phaseLeft, tm.roundTimeLeft, tm.round] };
    });
    assert.deepEqual(held.after, held.before);
    const bAfter = await screen(blue);
    assert.deepEqual([bAfter.phase, bAfter.round], [held.after[0], held.after[3]]);

    // A RED player again: the wait is over on every screen (the one coming back too), the same round shown.
    await join(red, 'Bravo', code);
    // ('join': the match starts over, so the squad is rebuilt for a moment.)
    await host.waitForFunction(() => !window.game.teamWait && window.game.squad?.bots.filter((b) => b.remote).length === 2);
    for (const p of all) await p.waitForFunction(() => !/봇 없는 방/.test(document.querySelector('.team-hud .round-banner')?.textContent ?? '') && window.game.teamMatch);
    await host.waitForTimeout(500);
    const after = await Promise.all(all.map(screen));
    assert.deepEqual(after.map((s) => s.wait), [null, null, null]);
    assert.deepEqual(after.map((s) => s.team), ['blue', 'red', 'blue']);
    assert.equal(new Set(after.map((s) => `${s.phase}|${s.round}`)).size, 1, `one round on every screen: ${after.map((s) => `${s.phase}|${s.round}`)}`);
    for (const p of all) assert.deepEqual(p.errors, []);
  } finally {
    for (const p of all) await p.context().close();
  }
});

test('changing the bot setting during a match asks first: 취소 keeps both, 확인 once restarts once; repeated clicks send one request', async () => {
  const host = await openGame(env, { mode: 'deathmatch', width: 480, height: 270 });
  const guest = await openGame(env, { mode: 'training', width: 480, height: 270 });
  for (const p of [host, guest]) p.setDefaultTimeout(60000);
  const dialog = (p) =>
    p.evaluate(() => ({
      open: !document.querySelector('.mp-confirm').hidden,
      text: document.querySelector('.mp-confirm-text').textContent,
      toggleOff: document.querySelector('.mp-bots-toggle').disabled,
    }));
  try {
    const code = await create(host, 'Alpha', 'deathmatch', false);
    await join(guest, 'Bravo', code);
    await host.waitForFunction(() => window.game.squad.bots.some((b) => b.remote));
    // Count what reaches the relay and mark the match, so a restart shows.
    await host.evaluate(() => {
      const s = window.game.net;
      window.__sent = [];
      const send = s.setBots.bind(s);
      s.setBots = (v) => (window.__sent.push(v), send(v));
      window.__match = window.game.match;
      window.game.match.scores.get('local').kills = 3;
    });
    assert.equal(await host.evaluate(() => window.game.netMatchInProgress), true);

    // Asked first; nothing sent, nothing changed while the question is open.
    await host.click('.mp-bots-toggle');
    const asked = await dialog(host);
    assert.equal(asked.open, true);
    assert.match(asked.text, /봇을 켜면 빈 자리를 봇이 채우고 경기가 처음부터 다시 시작됩니다/);
    assert.equal(asked.toggleOff, true, 'the switch waits while asked');
    // More clicks on the switch meanwhile: nothing.
    await host.evaluate(() => {
      for (let i = 0; i < 3; i++) document.querySelector('.mp-bots-toggle').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    assert.deepEqual(await host.evaluate(() => window.__sent), []);

    // 취소: the setting and the match as they were, on both screens.
    await host.click('.mp-confirm-cancel');
    await host.waitForTimeout(800);
    const kept = await host.evaluate(() => ({ same: window.game.match === window.__match, kills: window.game.match.scores.get('local').kills, room: window.game.net.room.bots, sent: window.__sent.length, open: !document.querySelector('.mp-confirm').hidden, toggleOff: document.querySelector('.mp-bots-toggle').disabled }));
    assert.deepEqual(kept, { same: true, kills: 3, room: false, sent: 0, open: false, toggleOff: false });
    assert.equal(await guest.evaluate(() => window.game.net.room.bots), false);
    assert.deepEqual(await seats(host), { inMatch: 1, out: 6, played: 1, ai: 0, lines: 2, outVisible: 0, outAlive: 0, room: false });
    // Escape cancels too.
    await host.click('.mp-bots-toggle');
    await host.press('.mp-confirm-cancel', 'Escape');
    assert.equal((await dialog(host)).open, false);
    assert.deepEqual(await host.evaluate(() => window.__sent), []);

    // 확인, clicked three times at once: one request, one restart.
    await host.click('.mp-bots-toggle');
    await host.evaluate(() => {
      for (let i = 0; i < 3; i++) document.querySelector('.mp-confirm-ok').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let i = 0; i < 3; i++) document.querySelector('.mp-bots-toggle').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await host.waitForFunction(() => window.game.net.room.bots === true && window.game.match !== window.__match && window.game.squad.bots.filter((b) => !b.benched).length === 7);
    await host.waitForTimeout(800);
    const done = await host.evaluate(() => ({ sent: window.__sent, kills: window.game.match.scores.get('local').kills, open: !document.querySelector('.mp-confirm').hidden, toggleOff: document.querySelector('.mp-bots-toggle').disabled, label: document.querySelector('.mp-bots-toggle').textContent }));
    assert.deepEqual(done, { sent: [true], kills: 0, open: false, toggleOff: false, label: '봇 끄기' });
    await guest.waitForFunction(() => window.game.net.room.bots === true);
    assert.deepEqual(await seats(host), { inMatch: 7, out: 0, played: 1, ai: 6, lines: 8, outVisible: 0, outAlive: 0, room: true });
    // The member never gets the question (no switch to press).
    assert.deepEqual(await guest.evaluate(() => ({ toggle: !document.querySelector('.mp-bots-toggle').hidden, open: !document.querySelector('.mp-confirm').hidden })), { toggle: false, open: false });
    for (const p of [host, guest]) assert.deepEqual(p.errors, []);
  } finally {
    for (const p of [host, guest]) await p.context().close();
  }
});

test('no match under way yet (a team room waiting for its first opponent): the switch acts at once, one request however fast it is pressed', async () => {
  const host = await openGame(env, { mode: 'deathmatch', width: 480, height: 270 });
  host.setDefaultTimeout(60000);
  try {
    await create(host, 'Alpha', 'team', false);
    await host.waitForFunction(() => window.game.teamWait === 'join');
    assert.equal(await host.evaluate(() => window.game.netMatchInProgress), false);
    await host.evaluate(() => {
      const s = window.game.net;
      window.__sent = [];
      const send = s.setBots.bind(s);
      s.setBots = (v) => (window.__sent.push(v), send(v));
      for (let i = 0; i < 4; i++) document.querySelector('.mp-bots-toggle').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    assert.equal(await host.evaluate(() => !document.querySelector('.mp-confirm').hidden), false, 'nothing to ask');
    await host.waitForFunction(() => window.game.net.room.bots === true && window.game.squad.bots.filter((b) => !b.benched).length === 9);
    await host.waitForTimeout(500);
    assert.deepEqual(await host.evaluate(() => window.__sent), [true]);
    assert.equal(await host.evaluate(() => window.game.teamWait), null, 'with bots: no waiting');
    assert.deepEqual(host.errors, []);
  } finally {
    await host.context().close();
  }
});

