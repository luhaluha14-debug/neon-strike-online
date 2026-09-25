/* Regression tests for the shared simulation.  Run: npm test */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Terrain } from '../shared/terrain.js';
import { World } from '../shared/world.js';
import { buildMap } from '../shared/mapgen.js';
import { NavGrid } from '../shared/nav.js';
import { newBody, stepBody, setStance, MOVE } from '../shared/movement.js';
import { Match, TICK, emptyCommand, rayHitPlayer } from '../shared/game.js';
import { WEAPONS } from '../shared/weapons.js';
import { newInventory, invAdd, invWeight } from '../shared/items.js';
import { Zone } from '../shared/zone.js';
import { makeRng } from '../shared/util.js';

/* ---------- helpers ---------- */
function flatWorld() {
  const t = new Terrain({ size: 200, cell: 2, seed: 1 });
  t.h.fill(0); t.maxH = 0; t.minH = 0;
  const w = new World(t);
  w.playLimit = 95;
  return w;
}
function walk(world, b, input, seconds) {
  const evs = [];
  for (let i = 0; i < Math.round(seconds * 60); i++) evs.push(stepBody(world, b, input, TICK));
  return evs;
}
let MAP = null, NAV = null;
function map() { if (!MAP) { MAP = buildMap(); NAV = new NavGrid(MAP); } return { world: MAP, nav: NAV }; }

/** 1 human + frozen bots on a flat test world */
function duel(bots = 1) {
  const world = flatWorld();
  world.spawnSpots = [{ x: 0, z: 0 }, { x: 0, z: -20 }, { x: 10, z: -20 }, { x: -10, z: -20 }];
  const nav = new NavGrid(world);
  const m = new Match({ world, nav, seed: 3, bots, humans: [{ id: 1, name: 'me' }], drop: false });
  const me = m.byId.get(1);
  const others = m.players.filter((p) => p.isBot);
  others.forEach((o, i) => { o.brain = null; o.body.pos.x = i * 10; o.body.pos.z = -20; o.yaw = 0; });
  me.body.pos.x = 0; me.body.pos.z = 0; me.yaw = 0;
  return { m, me, others };
}
function tick(m, cmd = {}) { m.setCommand(1, Object.assign(emptyCommand(), cmd)); m.step(TICK); }
function run(m, seconds, cmd = {}) { for (let i = 0; i < Math.round(seconds * 60); i++) tick(m, cmd); }

/* ---------- terrain / world ---------- */
test('map generation is deterministic', () => {
  const a = buildMap(), b = buildMap();
  assert.equal(a.boxes.length, b.boxes.length);
  assert.equal(a.terrain.heightAt(12.3, -45.6), b.terrain.heightAt(12.3, -45.6));
  assert.ok(a.lootSpots.length > 60, 'enough loot spots');
  assert.ok(a.doors.length > 10, 'doors registered for bots');
});

test('terrain sampling matches grid vertices', () => {
  const { world } = map();
  const T = world.terrain;
  for (const [i, j] of [[10, 10], [80, 40], [100, 150]]) {
    const x = -T.half + i * T.cell, z = -T.half + j * T.cell;
    assert.ok(Math.abs(T.heightAt(x, z) - T.h[j * T.n + i]) < 1e-4);
  }
});

test('raycast hits boxes and terrain', () => {
  const w = flatWorld();
  w.addBox(4, 0, -1, 5, 3, 1);
  const h = w.raycast(0, 1, 0, 1, 0, 0, 50);
  assert.ok(h && Math.abs(h.t - 4) < 1e-6 && h.nx === -1);
  const g = w.raycast(0, 5, 0, 0, -1, 0, 50);
  assert.ok(g && Math.abs(g.t - 5) < 0.05 && g.box === null);
  assert.equal(w.lineClear(0, 1, 0, 3.9, 1, 0), true);
  assert.equal(w.lineClear(0, 1, 0, 6, 1, 0), false);
});

/* ---------- movement ---------- */
test('run / sprint / crouch / prone speeds', () => {
  const w = flatWorld();
  const speed = (input, stance = 'stand') => {
    const b = newBody(0, 0, 0);
    if (stance !== 'stand') { setStance(w, b, stance); b.stanceLock = 0; }
    walk(w, b, input, 1.0);
    const z0 = b.pos.z;
    walk(w, b, input, 1.0);
    return z0 - b.pos.z;
  };
  assert.ok(Math.abs(speed({ fwd: 1, yaw: 0 }) - MOVE.speed.run) < 0.05);
  assert.ok(Math.abs(speed({ fwd: 1, yaw: 0, sprint: true }) - MOVE.speed.sprint) < 0.05);
  assert.ok(Math.abs(speed({ fwd: 1, yaw: 0 }, 'crouch') - MOVE.speed.crouch) < 0.05);
  assert.ok(Math.abs(speed({ fwd: 1, yaw: 0 }, 'prone') - MOVE.speed.prone) < 0.05);
  // sprint from crouch stands up
  const b = newBody(0, 0, 0); setStance(w, b, 'crouch'); b.stanceLock = 0;
  walk(w, b, { fwd: 1, yaw: 0, sprint: true }, 0.5);
  assert.equal(b.stance, 'stand');
});

test('walls block, steps are climbed, jump reaches ~1m', () => {
  const w = flatWorld();
  w.addBox(-5, 0, -3.2, 5, 3, -3);            // wall ahead
  const b = newBody(0, 0, 0);
  walk(w, b, { fwd: 1, yaw: 0 }, 2);
  assert.ok(b.pos.z > -3 + 0.3, 'stopped by wall');
  // stairs of 0.25 m
  const w2 = flatWorld();
  for (let i = 0; i < 8; i++) w2.addBox(-1, 0, -2 - (i + 1) * 0.3, 1, (i + 1) * 0.25, -2 - i * 0.3);
  const s = newBody(0, 0, 0);
  let top = 0;
  for (let i = 0; i < 150; i++) { stepBody(w2, s, { fwd: 1, yaw: 0 }, TICK); top = Math.max(top, s.pos.y); }
  assert.ok(top > 1.9, 'climbed stairs, y=' + top);
  // jump apex
  const j = newBody(0, 0, 0);
  let maxY = 0;
  stepBody(w, j, { jump: true, yaw: 0 }, TICK);
  for (let i = 0; i < 60; i++) { stepBody(w, j, { yaw: 0 }, TICK); maxY = Math.max(maxY, j.pos.y); }
  assert.ok(maxY > 0.9 && maxY < 1.2, 'jump apex ' + maxY);
  assert.equal(j.onGround, true);
});

test('cannot stand up under a low ceiling; fall damage', () => {
  const w = flatWorld();
  w.addBox(-2, 1.4, -2, 2, 1.6, 2);           // ceiling at 1.4m
  const b = newBody(0, 0, 0);
  b.stance = 'crouch';
  assert.equal(setStance(w, b, 'stand'), false);
  const f = newBody(20, 12, 20); f.onGround = false;
  const evs = walk(w, f, { yaw: 0 }, 2);
  const land = evs.find((e) => e.landed !== undefined);
  assert.ok(land && land.fallDamage > 10, 'fell 12m -> damage');
});

/* ---------- weapons & combat ---------- */
test('fire rate, ammo and reload', () => {
  const { m, me } = duel();
  m.cheat(1, 'give', 'kestrel'); m.cheat(1, 'give', 'ammo_light'); m.cheat(1, 'give', 'ammo_light');
  run(m, 0.7);
  tick(m, { reload: true });
  run(m, 3);
  const slot = m.slotOf(me);
  assert.equal(slot.mag, 30);
  const shots0 = me.shots;
  run(m, 1.0, { fire: true, aimPitch: 0.5, pitch: 0.5 });
  const fired = me.shots - shots0;
  const expect = WEAPONS.kestrel.rpm / 60;
  assert.ok(Math.abs(fired - expect) <= 1.5, `fired ${fired} expected ~${expect}`);
  assert.equal(slot.mag, 30 - fired);
});

test('semi-auto needs a new trigger press', () => {
  const { m, me } = duel();
  m.cheat(1, 'give', 'hornet'); m.cheat(1, 'give', 'ammo_pistol');
  run(m, 0.5); tick(m, { reload: true }); run(m, 2.5);
  const s0 = me.shots;
  run(m, 1, { fire: true, aimPitch: 0.5 });
  assert.equal(me.shots - s0, 1);
  for (let i = 0; i < 5; i++) { run(m, 0.1); run(m, 0.1, { fire: true, aimPitch: 0.5 }); }
  assert.equal(me.shots - s0, 6);
});

test('bullets hit players: headshot > body > legs, kill drops loot', () => {
  const { m, me, others } = duel(1);
  const bot = others[0];
  bot.body.pos.x = 0; bot.body.pos.z = -20;
  const aimAt = (y) => { const e = m.eye(me); const dy = y - e.y, dz = -20 - e.z; return { aimYaw: 0, aimPitch: Math.atan2(dy, -dz) }; };
  m.cheat(1, 'give', 'kestrel'); m.cheat(1, 'give', 'ammo_light');
  run(m, 0.7); tick(m, { reload: true }); run(m, 3);
  const hits = [];
  run(m, 0.5, { ads: true, ...aimAt(bot.body.pos.y + 1.2) });       // aim down sights first
  const shoot = (y) => {
    const hp = bot.hp;
    run(m, 0.3, { ads: true, ...aimAt(y) });
    me.bloom = 0;
    tick(m, { fire: true, ads: true, ...aimAt(y) });
    run(m, 0.5, { ads: true, ...aimAt(y) });
    hits.push(hp - bot.hp);
    bot.hp = 100;
  };
  me.bloom = 0;
  shoot(bot.body.pos.y + 1.62); shoot(bot.body.pos.y + 1.2); shoot(bot.body.pos.y + 0.45);
  assert.ok(hits[0] > hits[1] && hits[1] > hits[2] && hits[2] > 0, 'damage by part ' + hits.map((h) => h.toFixed(1)));
  // kill
  bot.hp = 10;
  tick(m, { fire: true, ...aimAt(bot.body.pos.y + 1.2) });
  run(m, 0.5);
  assert.equal(bot.alive, false);
  assert.equal(me.kills, 1);
  assert.equal(m.state, 'ended');
  assert.equal(m.winner, 1);
});

test('hitbox follows stance and yaw (prone)', () => {
  const { m, others } = duel(1);
  const p = others[0];
  p.body.pos.x = 0; p.body.pos.z = 0; p.body.pos.y = 0; p.body.stance = 'prone'; p.yaw = Math.PI / 2;   // facing -X
  // a vertical ray straight down 0.8m in front of the prone body (toward -X) hits the head/torso
  assert.ok(rayHitPlayer(p, -0.8, 3, 0, 0, -1, 0, 5));
  // but nothing 0.8m to the side (+Z)
  assert.equal(rayHitPlayer(p, 0, 3, 0.8, 0, -1, 0, 5), null);
});

test('inventory capacity and pickup', () => {
  const inv = newInventory();
  const n = invAdd(inv, 'ammo_light', 1000);
  assert.ok(n < 1000 && invWeight(inv) <= inv.capacity + 1e-6);
  const { m, me } = duel();
  const it = m.dropItem('bandage', 3, 0.5, 1, 0);
  assert.equal(m.pickup(me, it), true);
  assert.equal(me.inv.items.bandage, 3);
  // weapon swap drops the old one
  m.cheat(1, 'give', 'kestrel'); m.cheat(1, 'give', 'wasp');
  const extra = m.dropItem('breaker', 1, 0.5, 1, 0);
  me.cur = 0;
  m.pickup(me, extra);
  assert.equal(me.slots[0].id, 'breaker');
  assert.ok(m.items.some((i) => i.key === 'kestrel'), 'old weapon dropped');
});

test('healing takes time and caps', () => {
  const { m, me } = duel();
  me.hp = 40;
  m.cheat(1, 'give', 'bandage');
  tick(m, { use: 'bandage' });
  run(m, 1);
  assert.equal(me.hp, 40, 'not instant');
  run(m, 3);
  assert.equal(me.hp, 55);
  me.hp = 74;
  tick(m, { use: 'bandage' }); run(m, 4);
  assert.equal(me.hp, 75, 'bandage caps at 75');
});

test('input buffering keeps presses made during short locks', () => {
  const { m, me } = duel();
  m.cheat(1, 'give', 'kestrel'); m.cheat(1, 'give', 'ammo_light');
  tick(m, { reload: true });                     // during equip
  run(m, 0.7);
  assert.equal(me.reloading, true);
  tick(m, { crouch: true }); tick(m, { prone: true });
  run(m, 1);
  assert.equal(me.body.stance, 'prone');
});

/* ---------- zone ---------- */
test('zone shrinks inside the previous circle and hurts outside', () => {
  const z = new Zone(makeRng(9), 138);
  for (let i = 0; i < 20000 && z.stage !== 'done'; i++) {
    const prev = { ...z.cur };
    z.update(0.1);
    if (z.stage === 'wait') {
      const d = Math.hypot(z.next.x - z.cur.x, z.next.z - z.cur.z);
      assert.ok(d + z.next.r <= z.cur.r + 1e-6, 'next circle inside current');
    }
    assert.ok(z.cur.r <= prev.r + 1e-9);
  }
  assert.equal(z.stage, 'done');
  const { m, me } = duel();
  m.zone.cur = { x: 100, z: 100, r: 5 };
  const hp = me.hp;
  run(m, 1);
  assert.ok(me.hp < hp);
});

/* ---------- full bot matches ---------- */
for (const diff of ['easy', 'normal', 'hard']) {
  test(`bot-only match (${diff}) finishes with exactly one winner`, () => {
    const { world, nav } = map();
    const m = new Match({ world, nav, seed: 11, bots: 20, difficulty: diff });
    let kills = 0;
    while (m.state === 'playing' && m.time < 900) {
      m.step(TICK);
      for (const e of m.drainEvents()) if (e.t === 'kill') kills++;
    }
    assert.equal(m.state, 'ended', 'match ended within 15 min');
    assert.equal(kills, 19);
    assert.equal(m.players.filter((p) => p.alive).length, 1);
    const places = m.players.map((p) => p.place).sort((a, b) => a - b);
    assert.deepEqual(places, Array.from({ length: 20 }, (_, i) => i + 1));
    // everybody left the plane and landed
    assert.ok(m.players.every((p) => p.air === null || !p.alive), 'nobody stuck in the air');
    // nobody fell through the world
    for (const p of m.players) assert.ok(p.body.pos.y >= world.groundAt(p.body.pos.x, p.body.pos.z) - 0.01);
  });
}

/* ---------- regressions found in bug hunt #1 ---------- */
test('prone body never pokes through a wall (no headshots from behind cover)', () => {
  const { m, me } = duel(1);
  m.world.addBox(-5, 0, -3.25, 5, 3, -3.0);
  tick(m, { prone: true }); run(m, 1);
  assert.equal(me.body.stance, 'prone');
  run(m, 4, { fwd: 1 });                      // crawl head-first into the wall
  run(m, 2, { fwd: 1, yaw: 0.9 });            // and try to swing the body around
  const behind = rayHitPlayer(me, me.body.pos.x, 0.3, -8, 0, 0, 1, 20);
  const wall = m.world.raycast(me.body.pos.x, 0.3, -8, 0, 0, 1, 20);
  assert.ok(!behind || behind.t > wall.t, 'hitbox reachable only through the wall');
  // going prone facing a wall at arm's length is refused
  const { m: m2, me: me2 } = duel(1);
  m2.world.addBox(-5, 0, -1.0, 5, 3, -0.8);
  tick(m2, { prone: true }); run(m2, 1);
  assert.notEqual(me2.body.stance, 'prone');
});

test('ground items are never buried inside walls or crates', () => {
  const { world, nav } = map();
  for (let seed = 1; seed <= 10; seed++) {
    const m = new Match({ world, nav, seed, bots: 1 });
    for (const it of m.items) assert.ok(!world.overlaps(it.x, it.z, 0.1, it.y + 0.05, it.y + 0.35), `item ${it.key} buried at ${it.x.toFixed(1)},${it.z.toFixed(1)}`);
  }
});

test('simultaneous last deaths still give unique placements', () => {
  const { world, nav } = map();
  const m = new Match({ world, nav, seed: 5, bots: 2, drop: false });
  for (const p of m.players) { p.brain = null; p.hp = 5; }
  m.zone.cur = { x: 999, z: 999, r: 1 }; m.zone.phase = 5;
  for (let i = 0; i < 120 && m.state === 'playing'; i++) m.step(TICK);
  assert.deepEqual(m.players.map((p) => p.place).sort(), [1, 2]);
  assert.equal(m.byId.get(m.winner).place, 1);
});

test('god mode takes no damage and emits no hit events', () => {
  const { m, me, others } = duel(1);
  m.cheat(1, 'god'); m.drainEvents();
  m.damage(me, 30, others[0], 'kestrel', { x: 1, y: 0, z: 0 });
  assert.equal(me.hp, 100);
  assert.equal(m.drainEvents().filter((e) => e.t === 'hit').length, 0);
});

test('auto reload: empty magazine reloads by itself, never interrupts healing', () => {
  const { m, me } = duel();
  m.cheat(1, 'give', 'hornet'); m.cheat(1, 'give', 'ammo_pistol');
  run(m, 0.5);
  assert.equal(me.reloading, true, 'picked up an empty gun with ammo in the bag');
  run(m, 2.5);
  assert.equal(m.slotOf(me).mag, 15);
  for (let i = 0; i < 15; i++) { tick(m, { fire: true, aimPitch: 0.5 }); run(m, 0.16); }
  assert.equal(m.slotOf(me).mag, 0);
  run(m, 0.2);
  assert.equal(me.reloading, true);
  run(m, 2.5);
  assert.equal(m.slotOf(me).mag, 15);
  // healing with an empty gun: no auto reload until the heal finishes
  m.slotOf(me).mag = 0; me.hp = 50; m.cheat(1, 'give', 'bandage');
  tick(m, { use: 'bandage' }); run(m, 1);
  assert.ok(me.using && !me.reloading);
  me.autoReload = false; run(m, 3.5);
  assert.equal(me.reloading, false, 'setting off -> manual only');
});

test('loot is dense: most spots have items', () => {
  const { world, nav } = map();
  const m = new Match({ world, nav, seed: 21, bots: 1 });
  assert.ok(m.items.length > world.lootSpots.length * 2, `items ${m.items.length}`);
});

test('transport plane: everyone boards, jumps, parachutes and lands; human steers to a chosen spot', () => {
  const { world, nav } = map();
  const m = new Match({ world, nav, seed: 31, bots: 12, humans: [{ id: 1, name: 'me' }] });
  const me = m.byId.get(1);
  assert.ok(m.players.every((p) => p.air === 'plane'));
  // storm clock is frozen during the flight
  const zt = m.zone.timer;
  // pick a destination and steer to it
  const target = { x: world.locations[0].x + 6, z: world.locations[0].z + 6 };
  let jumped = false, sawChute = false;
  for (let i = 0; i < 60 * 90 && (me.air || !jumped); i++) {
    const c = { yaw: me.yaw, pitch: 0 };
    if (me.air === 'plane') {
      const pl = m.plane;
      if (pl.inside && pl.d >= pl.project(target.x, target.z) - 40) c.jump = true;
      c.yaw = pl.yaw;
    } else {
      jumped = true;
      const dx = target.x - me.body.pos.x, dz = target.z - me.body.pos.z;
      c.yaw = Math.atan2(-dx, -dz);
      c.fwd = Math.hypot(dx, dz) > 3 ? 1 : 0;
      if (me.air === 'chute') sawChute = true;
    }
    tick(m, c);
  }
  assert.equal(me.air, null, 'landed');
  assert.ok(sawChute, 'parachute opened');
  assert.equal(me.hp, 100, 'no fall damage with a parachute');
  const miss = Math.hypot(me.body.pos.x - target.x, me.body.pos.z - target.z);
  assert.ok(miss < 25, 'landed near the chosen spot, miss ' + miss.toFixed(1));
  assert.ok(m.zone.timer <= zt, 'storm clock running after the flight');
  // bots are all out and on the ground by now
  run(m, 20);
  assert.ok(m.players.filter((p) => p.alive).every((p) => p.air === null));
  assert.equal(m.plane.done || m.plane.left, true);
});

test('diving bots / players never hit the ground at dive speed (chute brakes in time)', () => {
  const { world, nav } = map();
  for (const seed of [8, 9, 10]) {
    const m = new Match({ world, nav, seed, bots: 24 });
    let worst = 0;
    while (m.time < 60) { m.step(TICK); for (const e of m.drainEvents()) if (e.t === 'landed') worst = Math.max(worst, e.v); }
    assert.ok(worst < 9, 'max landing speed ' + worst.toFixed(1));
  }
});
