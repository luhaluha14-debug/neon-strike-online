/* the room rules, driven directly: lobby, match flow, hit validation, bots */
import { test, assert, equal } from './harness.js';
import { Room } from '../server/room.js';
import { CHARACTERS, CHARMS, RULES, worldFor } from '../server/shared.js';

/* a stand-in for a websocket client that just records what it was sent */
function fakeClient(id, name) {
  return {
    id, name, sent: [],
    send(obj) { this.sent.push(typeof obj === 'string' ? JSON.parse(obj) : obj); },
    last(type) { return [...this.sent].reverse().find((m) => m.t === type); },
    all(type) { return this.sent.filter((m) => m.t === type); }
  };
}

function makeRoom(opts = {}) {
  const room = new Room('TEST', false, opts.mode || 'tdm', opts.map || 'shrine', () => {},
    { fillBots: opts.fillBots === true, botLevel: 'normal' });
  return room;
}

/* puts two players into a running match, standing in the open, facing each other */
function liveMatch(opts = {}) {
  const room = makeRoom(opts);
  const c1 = fakeClient(1, 'A'), c2 = fakeClient(2, 'B');
  const a = room.addPlayer(c1, 'rift');
  const b = room.addPlayer(c2, 'vein');
  room.startMatch();
  const world = worldFor(room.map);
  // place them 10 m apart on open ground with a clear line between
  const place = (p, x, z) => {
    p.pos = { x, y: world.supportAt(x, z, 60, p.radius), z };
    p.lastStateAt = Date.now() / 1000;
    p.hist = [{ t: Date.now() / 1000, x, y: p.pos.y, z, h: p.height }];
  };
  place(a, 0, -20);
  place(b, 0, -10);
  a.yaw = Math.atan2(-(b.pos.x - a.pos.x), -(b.pos.z - a.pos.z));
  a.pitch = 0;
  a.spawnAt = -99;                      // past spawn protection
  b.spawnAt = -99;
  return { room, a, b, c1, c2 };
}

test('a room starts in its lobby and reports itself', () => {
  const room = makeRoom();
  const c = fakeClient(1, 'A');
  room.addPlayer(c, 'rift');
  const info = c.last('room');
  assert(info, 'a joining player should receive the room info');
  equal(info.state, 'lobby');
  equal(info.ps.length, 1);
  equal(room.hostId, 1, 'the first player hosts');
});

test('teams are balanced as players arrive, and free-for-all splits everyone', () => {
  const room = makeRoom();
  for (let i = 1; i <= 4; i++) room.addPlayer(fakeClient(i, 'P' + i), 'rift');
  const teams = [...room.players.values()].map((p) => p.team);
  equal(teams.filter((t) => t === 'a').length, 2);
  equal(teams.filter((t) => t === 'b').length, 2);

  const ffa = makeRoom({ mode: 'ffa' });
  for (let i = 1; i <= 3; i++) ffa.addPlayer(fakeClient(i, 'P' + i), 'rift');
  equal(new Set([...ffa.players.values()].map((p) => p.team)).size, 3, 'everyone is their own team');
});

test('starting a match spawns everyone on their own side', () => {
  const { room, a, b } = liveMatch();
  equal(room.state, 'play');
  assert(a.alive && b.alive);
  equal(a.hp, CHARACTERS.rift.hp);
  equal(b.hp, CHARACTERS.vein.hp);
});

test('a plausible hit claim is applied', () => {
  const { room, a, b } = liveMatch();
  const spec = CHARACTERS.rift.primary;
  const before = b.hp;
  room.onFire(a, { d: [0, 0, 1], h: [{ id: b.id, n: spec.dmg, d: 10 }] });
  assert(b.hp < before, 'the shot should have landed');
  equal(before - b.hp, spec.dmg);
});

test('claims are rejected when the aim, the distance or the wall says no', () => {
  const { room, a, b } = liveMatch();
  const spec = CHARACTERS.rift.primary;

  a.fireCredit = 2;
  const hp1 = b.hp;
  room.onFire(a, { d: [0, 0, -1], h: [{ id: b.id, n: spec.dmg, d: 10 }] });   // aiming away
  equal(b.hp, hp1, 'a shot fired in the other direction must not count');

  a.fireCredit = 2;
  room.onFire(a, { d: [0, 0, 1], h: [{ id: b.id, n: spec.dmg, d: 90 }] });    // lying about range
  equal(b.hp, hp1, 'a claim whose distance does not match must not count');

  a.fireCredit = 2;
  const far = { id: b.id, n: spec.dmg, d: 10 };
  b.pos.x = 0; b.pos.z = 20; b.hist = [{ t: Date.now() / 1000, x: 0, y: b.pos.y, z: 20, h: b.height }];
  room.onFire(a, { d: [0, 0, 1], h: [far] });
  equal(b.hp, hp1, 'a target 40 m away cannot be hit by a claim of 10 m');
});

test('damage is capped at what the ability can actually do', () => {
  const { room, a, b } = liveMatch();
  const spec = CHARACTERS.rift.primary;
  const before = b.hp;
  room.onFire(a, { d: [0, 0, 1], h: [{ id: b.id, n: 99999, d: 10 }] });
  const dealt = before - b.hp;
  assert(dealt > 0, 'the hit still lands');
  assert(dealt <= spec.dmg * spec.head * 1.8, 'but a wild damage number is clamped: ' + dealt);
});

test('rate of fire is enforced, not trusted', () => {
  const { room, a, b } = liveMatch();
  const spec = CHARACTERS.rift.primary;
  let landed = 0;
  const before = b.hp;
  for (let i = 0; i < 12; i++) {
    room.onFire(a, { d: [0, 0, 1], h: [{ id: b.id, n: spec.dmg, d: 10 }] });
  }
  landed = (before - b.hp) / spec.dmg;
  assert(landed <= 3, 'a dozen instant shots should not all count, got ' + landed);
});

test('friendly fire is impossible', () => {
  const room = makeRoom();
  const c1 = fakeClient(1, 'A'), c2 = fakeClient(2, 'B');
  const a = room.addPlayer(c1, 'rift');
  const b = room.addPlayer(c2, 'rift');
  b.team = a.team;
  room.startMatch();
  b.team = a.team;
  const before = b.hp;
  room.onFire(a, { d: [0, 0, 1], h: [{ id: b.id, n: 50, d: 5 }] });
  equal(b.hp, before, 'a team mate cannot be damaged');
});

test('abilities respect their cooldown', () => {
  const { room, a } = liveMatch();
  const q = CHARACTERS.rift.q;
  room.onAbility(a, { s: 'q', d: [0, 0, 1] });
  const firstCd = a.cd.q;
  assert(firstCd > 0, 'the cooldown starts');
  room.onAbility(a, { s: 'q', d: [0, 0, 1] });
  equal(a.cd.q, firstCd, 'a second cast while cooling must be ignored');
  assert(Math.abs(firstCd - (Date.now() / 1000 + q.cd)) < 0.5);
});

test('a domain needs a full gauge, and spends it', () => {
  const { room, a } = liveMatch();
  a.ult = 40;
  room.onAbility(a, { s: 'ult', d: [0, 0, 1], p: [a.pos.x, a.pos.y, a.pos.z] });
  assert(!a.ultActive, 'a half charged gauge cannot open a domain');
  a.ult = RULES.ult.max;
  room.onAbility(a, { s: 'ult', d: [0, 0, 1], p: [a.pos.x, a.pos.y, a.pos.z] });
  assert(a.ultActive, 'a full gauge opens it');
  equal(a.ult, 0, 'and empties the gauge');
  equal(room.domains.length, 1);
});

test('kills score, and the match ends on the target', () => {
  const { room, a, b, c1 } = liveMatch();
  room.M.target;
  b.hp = 1;
  room.damage(b, 50, a, {});
  equal(a.stats.kills, 1);
  equal(room.scores[a.team], 1);
  assert(c1.last('kill'), 'the kill is broadcast');
  room.scores[a.team] = room.M.target - 1;
  b.alive = true; b.hp = 1;
  room.damage(b, 50, a, {});
  equal(room.state, 'end', 'reaching the target ends the match');
  assert(c1.last('end').win === a.team);
});

test('the dead respawn after the mode delay', () => {
  const { room, a, b } = liveMatch();
  b.hp = 1;
  room.damage(b, 50, a, {});
  assert(!b.alive);
  b.respawnAt = Date.now() / 1000 - 0.01;
  room.tick();
  assert(b.alive, 'the timer should bring them back');
  equal(b.hp, b.maxHp);
});

test('bots fill an empty room and actually play', () => {
  const room = makeRoom({ fillBots: true });
  const c = fakeClient(1, 'A');
  room.addPlayer(c, 'brand');
  assert(room.bots().length > 0, 'a lone player should get opponents');
  room.startMatch();
  const bot = room.bots()[0];
  const world = worldFor(room.map);
  const start = { x: bot.pos.x, z: bot.pos.z };
  let grounded = 0, worstDrop = 0, highest = -99;
  for (let i = 0; i < 120; i++) {
    room.lastTick = Date.now() / 1000 - 0.05;
    room.tick();
    // a bot may be mid jump or mid fall; it may never sink or fly
    const floor = world.supportAt(bot.pos.x, bot.pos.z, bot.pos.y + 0.4, bot.radius * 0.85);
    if (Math.abs(bot.pos.y - floor) < 0.25) grounded++;
    worstDrop = Math.min(worstDrop, bot.pos.y - floor);
    highest = Math.max(highest, bot.pos.y);
  }
  const moved = Math.hypot(bot.pos.x - start.x, bot.pos.z - start.z);
  assert(moved > 1, 'a bot should have moved somewhere, moved ' + moved.toFixed(2));
  assert(grounded > 60, 'a bot should spend most of its time on the ground (' + grounded + '/120)');
  assert(worstDrop > -0.6, 'a bot must never sink into the floor (' + worstDrop.toFixed(2) + ')');
  assert(highest < 14, 'a bot must never fly (' + highest.toFixed(2) + ')');
});

test('a player who leaves is removed and the room closes when empty', () => {
  let closed = false;
  const room = new Room('T2', false, 'tdm', 'shrine', () => { closed = true; }, { fillBots: false });
  room.addPlayer(fakeClient(1, 'A'), 'rift');
  room.addPlayer(fakeClient(2, 'B'), 'rift');
  room.removePlayer(2);
  equal(room.players.size, 1);
  room.removePlayer(1);
  assert(closed, 'the last player leaving closes the room');
});

test('a bad state packet cannot teleport a player across the map', () => {
  const { room, a } = liveMatch();
  const from = { x: a.pos.x, z: a.pos.z };
  a.lastStateAt = Date.now() / 1000;
  room.onState(a, { sq: a.spawnSeq, p: [25, 0, 25], y: 0, pi: 0, h: 1.8, f: 1 });
  const moved = Math.hypot(a.pos.x - from.x, a.pos.z - from.z);
  assert(moved < 1, 'the jump should be rejected, moved ' + moved.toFixed(2));

  room.onState(a, { sq: a.spawnSeq, p: [from.x + 2, a.pos.y, from.z + 1], y: 0, pi: 0, h: 1.8, f: 1 });
  assert(Math.hypot(a.pos.x - from.x, a.pos.z - from.z) > 1, 'a normal step is accepted');
});

test('garbage input is ignored rather than crashing the room', () => {
  const { room, a, c1 } = liveMatch();
  const junk = [
    { t: 'st', sq: a.spawnSeq, p: ['x', null, undefined] },
    { t: 'st', sq: 999, p: [1, 2, 3] },
    { t: 'fire', d: null, h: 'nope' },
    { t: 'abil', s: 'nonsense' },
    { t: 'hit', a: 'nonexistent', h: [{ id: 999, n: 1e9 }] },
    { t: 'char', ch: 'hacker' }
  ];
  for (const m of junk) room.onMessage(c1, m);
  equal(room.state, 'play', 'the match survives nonsense');
  assert(a.alive);
});

test('the server applies the charm, so the client cannot invent its own numbers', () => {
  const room = makeRoom();
  const c1 = fakeClient(1, 'A'), c2 = fakeClient(2, 'B');
  const a = room.addPlayer(c1, 'rift', 'vigor');
  const b = room.addPlayer(c2, 'rift', 'swift');
  room.startMatch();
  equal(a.maxHp, Math.round(CHARACTERS.rift.hp * CHARMS.vigor.mods.hp), 'the health charm is applied on spawn');
  equal(a.hp, a.maxHp);

  const before = a.hp;
  room.damage(a, 100, b, {});
  const taken = before - a.hp;
  assert(taken < 100, 'the damage reduction applies: ' + taken);

  const t = Date.now() / 1000;
  room.onAbility(b, { s: 'q', d: [0, 0, 1] });
  const shortened = b.cd.q - t;
  assert(shortened < CHARACTERS.rift.q.cd - 0.5, 'the cooldown charm shortens the dash: ' + shortened.toFixed(2));
});

test('a made-up charm name is ignored', () => {
  const room = makeRoom();
  const p = room.addPlayer(fakeClient(1, 'A'), 'rift', 'godmode');
  equal(p.charm.id, 'none');
  equal(p.maxHp, CHARACTERS.rift.hp);
});
