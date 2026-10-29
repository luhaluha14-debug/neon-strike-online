// Bot tactics for the C4 objective (TacticalMap / TacticalDirector + Bot
// orders): sites analysed from the map, a seeded (reproducible) plan per
// round, attack roles / split routes / a flank, defenders split over both
// sites on covered holds, alerts only from what bots actually saw, a
// dropped bomb fetched and planted by a bot, a planted bomb defused by a
// bot, and a bounded pathfinding budget. Frames at a fixed 1/60 s.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, openGame, installFrameDriver } from './harness.mjs';

let env;
let page;

before(async () => {
  env = await startEnv();
  // A fixed seed: the same plan and the same bot decisions every run.
  page = await openGame(env, { map: 'warehouse', mode: 'team', seed: 7 });
  await page.click('.play-button');
  await page.waitForFunction(() => document.pointerLockElement === window.game.renderer.domElement && window.game.input.active);
  await page.mouse.move(0, 0);
  await installFrameDriver(page);
  await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    T.stopLoop();
    T.V = g.player.position.constructor;
    T.kill = (c) => {
      c.protection = 0;
      c.applyDamage({ amount: 999, zone: 'head', sourceId: 'test', weaponId: 'ar01', point: new T.V(), direction: new T.V(0, 0, 1), distance: 5 });
    };
    T.until = (phase, max = 6000) => {
      let n = 0;
      while (g.teamMatch.phase !== phase && n < max) {
        T.run(1);
        n++;
      }
      return n;
    };
    T.reds = () => g.squad.bots.filter((b) => b.team === 'red');
    T.blues = () => g.squad.bots.filter((b) => b.team === 'blue');
    T.plan = () => ({
      target: g.director.target?.name ?? null,
      phase: g.director.phase,
      orders: Object.fromEntries(g.squad.bots.map((b) => [b.id, b.order ? b.order.tag : null])),
      roles: Object.fromEntries(g.squad.bots.map((b) => [b.id, b.order ? b.order.role : null])),
    });
  });
});
after(async () => {
  await page?.context().close();
  await env?.close();
});

test('the map analysed once: both sites with plant spots, at least two ways in, covered holds watching an entrance', async () => {
  const r = await page.evaluate(() => {
    const t = window.game.tacticalMap;
    return {
      ms: t.buildMs,
      sites: t.sites.map((s) => ({
        name: s.name,
        plant: s.plantSpots.length,
        entrances: s.entrances.length,
        holds: s.holds.length,
        holdsNear: s.holds.every((h) => Math.hypot(h.position.x - s.centre.x, h.position.z - s.centre.z) <= 9.01),
        looks: s.holds.every((h) => !!h.look),
      })),
    };
  });
  assert.deepEqual(r.sites.map((s) => s.name), ['A', 'B']);
  for (const s of r.sites) {
    assert.ok(s.plant >= 4, `${s.name}: plant spots ${s.plant}`);
    assert.ok(s.entrances >= 2, `${s.name}: entrances ${s.entrances}`);
    assert.ok(s.holds >= 2, `${s.name}: holds ${s.holds}`);
    assert.equal(s.holdsNear, true);
    assert.equal(s.looks, true);
  }
  assert.ok(r.ms < 3000, `built in ${r.ms.toFixed(0)} ms`);
});

test('reproducible: the same seed gives the same plan (target site, roles, routes)', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    const once = () => {
      g.restartMatch();
      T.until('live');
      T.run(2);
      return T.plan();
    };
    return [once(), once()];
  });
  assert.deepEqual(r[0], r[1]);
  assert.ok(r[0].target === 'A' || r[0].target === 'B');
});

test('attack: one target site, roles entry / support / flank, the flank on another route; defence: both sites held, plus the middle', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    g.restartMatch();
    T.until('live');
    g.combat.protection = 1e9;
    T.run(2);
    const p = T.plan();
    const blue = T.blues().map((b) => ({ id: b.id, tag: b.order?.tag ?? null, role: b.order?.role ?? null }));
    const red = T.reds().map((b) => ({ id: b.id, tag: b.order?.tag ?? null, role: b.order?.role ?? null }));
    return { p, blue, red, carrier: g.bomb.carrier };
  });
  assert.equal(r.carrier, 'local', 'round 1: the player carries');
  // Attackers: all to the same site, different jobs, one through a different entrance.
  const site = r.p.target;
  assert.ok(r.blue.every((b) => b.tag.startsWith(site + ':')), JSON.stringify(r.blue));
  const roles = r.blue.map((b) => b.role).sort();
  assert.deepEqual(roles, ['entry', 'flank', 'support', 'support']);
  assert.ok(r.blue.some((b) => b.tag.endsWith(':flank')) && r.blue.some((b) => b.tag.endsWith(':main')), 'split routes');
  // Defenders: A and B each held by two, the fifth in the middle.
  const at = (s) => r.red.filter((b) => b.tag?.startsWith(s + ':')).length;
  assert.deepEqual([at('A'), at('B'), r.red.filter((b) => b.tag === 'mid').length], [2, 2, 1]);
});

test('over time the teams spread instead of bunching in the middle: defenders reach their sites, attackers come in on two routes', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    const tm = g.tacticalMap;
    // Movement only: nobody fights (every bot blind, so no engagement or sightings overrides the plan).
    for (const b of g.squad.bots) b.combat.protection = 1e9;
    const blueTrack = new Map(T.blues().map((b) => [b.id, []]));
    for (let s = 0; s < 14; s++) {
      for (const b of g.squad.bots) b.blindTime = 2;
      T.run(60);
      for (const b of T.blues()) blueTrack.get(b.id).push(b.position.clone());
    }
    const red = T.reds().map((b) => {
      const name = b.order.tag.split(':')[0];
      const site = tm.site(name);
      const d = site ? Math.hypot(b.position.x - site.centre.x, b.position.z - site.centre.z) : Math.hypot(b.position.x - tm.mid.x, b.position.z - tm.mid.z);
      return { tag: b.order.tag, d };
    });
    // Attackers' positions: how far apart the main group and the flanker are.
    const flanker = T.blues().find((b) => b.order.role === 'flank');
    const entry = T.blues().find((b) => b.order.role === 'entry');
    const apart = Math.max(...blueTrack.get(flanker.id).map((p, i) => p.distanceTo(blueTrack.get(entry.id)[i])));
    // Widest spread of the attackers during the approach (they converge on the site at the end, as planned).
    const ids = [...blueTrack.keys()];
    const blueSpread = Math.max(...blueTrack.get(ids[0]).map((_, i) => Math.max(...ids.flatMap((a) => ids.map((b) => blueTrack.get(a)[i].distanceTo(blueTrack.get(b)[i]))))));
    return { red, apart, blueSpread, phase: g.director.phase, live: g.teamMatch.phase };
  });
  const arrived = r.red.filter((x) => x.d < 12).length;
  assert.ok(arrived >= 4, `defenders at their posts: ${JSON.stringify(r.red)}`);
  assert.ok(r.apart > 8, `the flank takes another way (${r.apart.toFixed(1)} m apart at most)`);
  assert.ok(r.blueSpread > 6, `attackers not in one bunch (${r.blueSpread.toFixed(1)} m)`);
});

test('no cheating: the defence is alerted only by what its bots saw; blinded defenders do not react to an attacker in the site', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    g.restartMatch();
    T.until('live');
    g.combat.protection = 1e9;
    for (const b of g.squad.bots) b.combat.protection = 1e9;
    T.run(30);
    // Every defender blind (sees nobody); the player walks into a site.
    for (const b of T.reds()) b.blindTime = 1e6;
    const site = g.tacticalMap.sites[0];
    const before = T.plan().orders;
    const reports0 = g.director.sightings.filter((s) => s.team === 'red').length;
    g.player.teleport(site.centre.clone().setY(site.centre.y + 0.1), 0);
    T.run(120);
    const blind = { alerts: [...g.director.alerts], reports: g.director.sightings.filter((s) => s.team === 'red').length - reports0, same: JSON.stringify(T.reds().map((b) => before[b.id])) === JSON.stringify(T.reds().map((b) => b.order.tag)) };
    // Sight back: a defender who can see the player reports it, and the site goes on alert.
    for (const b of T.reds()) b.blindTime = 0;
    let n = 0;
    while (!g.director.alerts.size && n < 1200) {
      T.run(1);
      n++;
    }
    const seen = T.reds().some((b) => b.target?.id === 'local' || b.mode === 'search');
    return { blind, alerted: [...g.director.alerts], seen, n };
  });
  assert.deepEqual(r.blind, { alerts: [], reports: 0, same: true });
  assert.ok(r.alerted.length >= 1 && r.seen, `alerted once seen (${r.alerted}, ${r.n} frames)`);
});

test('a dropped bomb is fetched by the nearest attacker bot, carried to the target and planted there', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    g.restartMatch();
    T.until('live');
    // Defenders out of the way (all but one held back at their spawn, so the round goes on).
    const keep = T.reds()[0];
    for (const b of T.reds()) if (b !== keep) T.kill(b.combat);
    const home = keep.position.clone();
    keep.combat.protection = 1e9;
    for (const b of T.blues()) b.combat.protection = 1e9;
    // The player (carrier) dies: the bomb drops.
    T.kill(g.combat);
    T.run(1);
    const dropped = g.bomb.state;
    const events = [];
    let n = 0;
    let pickedBy = null;
    while (g.bomb.state !== 'planted' && g.teamMatch.phase === 'live' && n < 100 * 60) {
      keep.controller.teleport(home, 0);
      // Objective movement only: no fight with the one defender left.
      keep.blindTime = 1;
      for (const b of T.blues()) b.blindTime = 1;
      T.run(1);
      n++;
      if (!pickedBy && g.bomb.state === 'carried') {
        pickedBy = g.bomb.carrier;
        events.push(['pickup', +(n / 60).toFixed(1)]);
      }
    }
    return { dropped, pickedBy, events, state: g.bomb.state, site: g.bomb.site, target: g.director.target.name, by: g.bomb.plantedBy, seconds: n / 60 };
  });
  assert.equal(r.dropped, 'dropped');
  assert.match(r.pickedBy ?? '', /^bot-[1-4]$/, 'a BLUE bot picked it up');
  assert.equal(r.state, 'planted', `planted (after ${r.seconds.toFixed(1)} s)`);
  assert.equal(r.site, r.target, 'at the planned site');
  assert.equal(r.by, r.pickedBy);
});

test('a planted bomb: defender bots go to it, one defuses while the others cover', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    // Continue the last round: the attackers die, the defenders come back into play.
    g.combat.protection = 0;
    for (const b of T.blues()) T.kill(b.combat);
    // Revive the defence: a fresh round would end this one, so bring back the killed RED bots at their spawn instead.
    const spawns = g.spawnsOf('red');
    T.reds().forEach((b, i) => {
      if (!b.alive) g.squad.spawnAt(b, spawns[i % spawns.length].position, spawns[i % spawns.length].yaw);
    });
    T.run(40); // the plan is updated every 0.5 s
    const roles = T.reds().map((b) => b.order?.role);
    let n = 0;
    while (g.bomb.state === 'planted' && n < 40 * 60) {
      T.run(1);
      n++;
    }
    const last = g.teamMatch.lastRound;
    return { roles, state: g.bomb.state, by: g.bomb.defusedBy, last: last && [last.winner, last.reason], seconds: n / 60 };
  });
  assert.equal(r.roles.filter((x) => x === 'defuser').length, 1);
  assert.equal(r.roles.filter((x) => x === 'cover').length, 4);
  assert.equal(r.state, 'defused', `defused before the timer (${r.seconds.toFixed(1)} s)`);
  assert.match(r.by, /^bot-(5|6|7|8|9)$/);
  assert.deepEqual(r.last, ['red', 'defuse']);
});

test('pathfinding stays bounded: A* runs only when an order or route changes (under 1 call per bot per second)', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    g.restartMatch();
    T.until('live');
    g.combat.protection = 1e9;
    for (const b of g.squad.bots) b.combat.protection = 1e9;
    let calls = 0;
    const find = g.nav.findPath.bind(g.nav);
    g.nav.findPath = (...a) => {
      calls++;
      return find(...a);
    };
    const t0 = performance.now();
    T.run(20 * 60);
    g.nav.findPath = find;
    return { calls, perBotSecond: calls / 9 / 20, ms: performance.now() - t0 };
  });
  assert.ok(r.perBotSecond < 1, `${r.calls} A* calls in 20 s for 9 bots (${r.perBotSecond.toFixed(2)} per bot per second)`);
});

test('engagement on the move: a far enemy seen while travelling to an ordered spot is called out, not duelled; near, or at its post, the bot fights', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    const V = T.V;
    g.restartMatch();
    T.until('live');
    g.director = null; // the orders below are set by the test
    g.combat.protection = 1e9;
    for (const b of g.squad.bots) {
      b.combat.protection = 1e9;
      b.blindTime = 1e6; // everyone else out of it
    }
    // The longest clear line from any spawn spot (both sides).
    let best = null;
    for (const s of [...g.spawnsOf('blue'), ...g.spawnsOf('red')]) {
      const eye = new V(s.position.x, s.position.y + 1.6, s.position.z);
      for (let k = 0; k < 36; k++) {
        const a = (k / 36) * Math.PI * 2;
        const d = new V(-Math.sin(a), 0, -Math.cos(a));
        const hit = g.map.collision.raycast(eye, d, 60) ?? 60;
        if (!best || hit > best.len) best = { yaw: a, d, len: hit, p: s.position.clone() };
      }
    }
    const p = best.p;
    const at = (m) => p.clone().addScaledVector(best.d, m).setY(p.y + 0.1);
    const blue = T.blues()[0];
    const red = T.reds()[0];
    // Only these two in play (the player stays, protected, so the round goes on).
    for (const b of g.squad.bots) if (b !== blue && b !== red) T.kill(b.combat);
    let spots = 0;
    blue.onSpot = () => spots++;
    blue.blindTime = 0;
    const place = (meters, goal) => {
      blue.order = { role: 'entry', goal, look: null, use: false, tag: 'test:' + goal.toArray().join() };
      blue.mode = 'wander';
      blue.target = null;
      const shots = blue.weapons.shotsFired;
      for (let i = 0; i < 45; i++) {
        blue.controller.teleport(at(0), best.yaw);
        red.controller.teleport(at(meters), best.yaw + Math.PI);
        T.run(1);
      }
      return { mode: blue.mode, target: blue.target?.id ?? null, shots: blue.weapons.shotsFired - shots };
    };
    const far = at(0).clone().addScaledVector(best.d, -40); // a spot 40 m behind: still travelling
    const travellingFar = place(40, far);
    const spotsAfterFar = spots;
    const travellingNear = place(20, far);
    const atPostFar = place(40, at(0));
    // Losing sight of a far enemy: with an order, back to the order (no chase); without one, search as before.
    const lose = (order) => {
      place(40, at(0));
      blue.order = order ? blue.order : null;
      blue.blindTime = 0.3;
      T.run(12);
      const mode = blue.mode;
      blue.blindTime = 0;
      return mode;
    };
    return { line: best.len, travellingFar, spotsAfterFar, travellingNear, atPostFar, lostWithOrder: lose(true), lostWithout: lose(false), redId: red.id };
  });
  assert.ok(r.line >= 41, `a clear line of ${r.line.toFixed(1)} m`);
  assert.deepEqual(r.travellingFar, { mode: 'wander', target: null, shots: 0 }, 'not duelled while travelling');
  assert.equal(r.spotsAfterFar, 1, 'called out to the team once');
  assert.equal(r.travellingNear.mode, 'engage', 'within 30 m: fights');
  assert.equal(r.travellingNear.target, r.redId);
  assert.equal(r.atPostFar.mode, 'engage', 'holding its post: fights at any range');
  assert.equal(r.lostWithOrder, 'wander', 'no chase across the map with an order');
  assert.equal(r.lostWithout, 'search', 'without an order: searches as before');
});

test('a bot-only round from the start: attackers leave the spawn instead of duelling across the map (seeded)', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    g.restartMatch();
    T.until('live');
    // The player is out at once: 4 BLUE attackers (one fetches the bomb) vs 5 RED defenders.
    T.kill(g.combat);
    const start = new Map(T.blues().map((b) => [b.id, b.position.clone()]));
    let farDuels = 0;
    for (let i = 0; i < 5 * 60; i++) {
      T.run(1);
      for (const b of T.blues()) {
        const o = b.order;
        const travelling = o && Math.hypot(o.goal.x - b.position.x, o.goal.z - b.position.z) > 0.7 && (o.role === 'retriever' || Math.hypot(o.goal.x - b.position.x, o.goal.z - b.position.z) > 15);
        if (b.alive && b.mode === 'engage' && b.target && travelling && b.position.distanceTo(b.target.position) > 30 && b.seenFor < 0.02) farDuels++;
      }
    }
    // The bomb fetcher only has a few metres to walk (the bomb lies where the player fell); the others head out.
    const moved = T.blues().filter((b) => b.alive && b.order?.role !== 'retriever' && b.order?.role !== 'carrier').map((b) => +b.position.distanceTo(start.get(b.id)).toFixed(1));
    const fetched = g.bomb.state === 'carried' && T.blues().some((b) => b.id === g.bomb.carrier);
    return { farDuels, moved, fetched, reports: g.director.sightings.filter((s) => s.team === 'blue').length };
  });
  assert.equal(r.farDuels, 0, 'no attacker started a duel beyond 30 m on its way');
  assert.ok(r.moved.length >= 1 && r.moved.every((m) => m > 8), `out of the spawn after 5 s: ${r.moved}`);
  assert.equal(r.fetched, true, 'the dropped bomb picked up within 5 s');
});

test('elimination objective: no tactical orders (bots roam and fight as before)', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    g.matchSettings.objective = 'elimination';
    g.restartMatch();
    T.until('live');
    T.run(120);
    const out = { director: !!g.director && g.teamMatch.bombMode, orders: g.squad.bots.filter((b) => b.order).length, bomb: g.bomb };
    g.matchSettings.objective = 'bomb';
    return out;
  });
  assert.deepEqual(r, { director: false, orders: 0, bomb: null });
  assert.deepEqual(page.errors, []);
});
