// C4 bomb objective (team match default): the round rules (TeamMatch) and
// the bomb itself (BombObjective) as pure logic, then in the game: sites
// read from the map, the carrier, planting with the real E key (and what
// cancels it), the bomb timer, the explosion deciding the round and the
// economy, the half-time side swap, a defuse by the player, a dropped bomb
// picked up, and the HUD. Frames are driven at a fixed 1/60 s.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, openGame, installFrameDriver } from './harness.mjs';

let env;
let page;

const run = (n) => page.evaluate((n) => window.T.run(n), n);

before(async () => {
  env = await startEnv();
  page = await openGame(env, { map: 'warehouse', mode: 'team' });
});
after(async () => {
  await page?.context().close();
  await env?.close();
});

test('round rules: before the plant elimination / clock, after it the bomb decides; each end happens once', async () => {
  const r = await page.evaluate(async () => {
    const { TeamMatch, DEFAULT_TEAM_MATCH } = await import('/src/game/TeamMatch.ts');
    const players = [
      { id: 'local', name: 'YOU', team: 'blue', isPlayer: true },
      { id: 'b1', name: 'B1', team: 'blue', isPlayer: false },
      { id: 'r1', name: 'R1', team: 'red', isPlayer: false },
    ];
    const live = (cfg = {}) => {
      const m = new TeamMatch({ ...DEFAULT_TEAM_MATCH, ...cfg }, players);
      m.update(20, { blue: 2, red: 1 }); // prep over
      return m;
    };
    const out = {};
    let m = live();
    out.defaults = { objective: m.config.objective, attackers: m.attackers, defenders: m.defenders, halftime: m.halftimeAfter };
    out.atkWiped = [m.update(0.01, { blue: 0, red: 1 }), m.lastRound.winner, m.lastRound.reason];
    m = live();
    out.defWiped = [m.update(0.01, { blue: 2, red: 0 }), m.lastRound.winner, m.lastRound.reason];
    m = live();
    out.both = [m.update(0.01, { blue: 0, red: 0 }), m.lastRound.winner];
    m = live();
    m.update(120, { blue: 2, red: 1 });
    out.clock = [m.lastRound.winner, m.lastRound.reason, m.lastRound.alive];
    // Planted: the clock stops; attackers wiped out does not end the round.
    m = live();
    const money0 = m.economy.money('local');
    out.plant = [m.bombPlanted('local'), m.bombPlanted('local'), m.economy.money('local') - money0];
    const clock = m.roundTimeLeft;
    out.afterPlant = [m.update(200, { blue: 0, red: 1 }), m.phase, m.roundTimeLeft === clock];
    out.explode = [m.bombExploded({ blue: 0, red: 1 }), m.lastRound.winner, m.lastRound.reason, m.bombExploded({ blue: 0, red: 1 }), m.history.length];
    out.lateDefuse = m.bombDefused('r1', { blue: 0, red: 1 });
    m = live();
    m.bombPlanted('local');
    const red0 = m.economy.money('r1');
    out.defuse = [m.bombDefused('r1', { blue: 1, red: 1 }), m.lastRound.winner, m.lastRound.reason, m.economy.money('r1') - red0];
    out.lateExplode = m.bombExploded({ blue: 1, red: 1 });
    out.latePlant = m.bombPlanted('b1');
    m = live();
    m.bombPlanted('local');
    out.defWipedAfterPlant = [m.update(0.01, { blue: 1, red: 0 }), m.lastRound.winner, m.lastRound.reason];
    // Half time (rounds to win 3: after 2 rounds): sides swap once, money starts over.
    m = live({ roundsToWin: 3 });
    const sides = [m.attackers];
    for (let i = 0; i < 3; i++) {
      m.update(0.01, { blue: 2, red: 0 }); // blue wins
      if (m.over) break;
      m.economy.credit('local', 1000);
      m.update(10, { blue: 2, red: 1 }); // result -> next round
      sides.push([m.round, m.attackers, m.swappedAtRound, m.economy.money('local')]);
      m.update(20, { blue: 2, red: 1 });
    }
    out.halftime = sides;
    // Elimination objective: unchanged (no sides, most survivors at time).
    m = live({ objective: 'elimination' });
    out.elimPlant = m.bombPlanted('local');
    m.update(120, { blue: 2, red: 1 });
    out.elim = [m.lastRound.winner, m.lastRound.reason];
    return out;
  });
  assert.deepEqual(r.defaults, { objective: 'bomb', attackers: 'blue', defenders: 'red', halftime: 4 });
  assert.deepEqual(r.atkWiped, ['round-end', 'red', 'elimination']);
  assert.deepEqual(r.defWiped, ['round-end', 'blue', 'elimination']);
  assert.deepEqual(r.both, ['round-end', null]);
  assert.deepEqual(r.clock, ['red', 'time', { blue: 2, red: 1 }], 'clock out before a plant: the defenders win even when outnumbered');
  assert.deepEqual(r.plant, [true, false, 300], 'planted once, planter bonus $300');
  assert.deepEqual(r.afterPlant, [null, 'live', true], 'attackers wiped out after the plant: still live, clock stopped');
  assert.deepEqual(r.explode, ['round-end', 'blue', 'bomb', null, 1], 'explosion: attackers win, once');
  assert.equal(r.lateDefuse, null);
  assert.deepEqual(r.defuse, ['round-end', 'red', 'defuse', 3300], 'defuse: defenders win; defuser +$300 bonus + $3,000 win');
  assert.equal(r.lateExplode, null);
  assert.equal(r.latePlant, false, 'no plant once the round is decided');
  assert.deepEqual(r.defWipedAfterPlant, ['round-end', 'blue', 'elimination']);
  assert.deepEqual(r.halftime, ['blue', [2, 'blue', 0, 3000 + 3000 + 1000], [3, 'red', 3, 3000]]);
  assert.equal(r.elimPlant, false);
  assert.deepEqual(r.elim, ['blue', 'time']);
});

test('the bomb: plant needs E held, standing still, unhurt, in a site; drop on death, pickup by an attacker; defuse in reach; explodes once', async () => {
  const r = await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const { BombObjective } = await import('/src/game/BombObjective.ts');
    const { BOMB_CONFIG } = await import('/src/config.ts');
    const V = THREE.Vector3;
    const sites = [{ name: 'A', box: new THREE.Box3(new V(0, 0, 0), new V(4, 0.06, 4)) }];
    const b = new BombObjective(sites);
    const actor = (o) => ({ id: 'a', side: 'attack', alive: true, position: new V(2, 0.02, 2), speed: 0, use: false, hits: 0, ...o });
    const dt = 1 / 120;
    const steps = (n, actors) => {
      const ev = [];
      for (let i = 0; i < n; i++) ev.push(...b.step(dt, actors));
      return ev.map((e) => e.type + (e.why ? ':' + e.why : ''));
    };
    const out = { cfg: { plant: BOMB_CONFIG.plantTime, defuse: BOMB_CONFIG.defuseTime, timer: BOMB_CONFIG.timer } };
    out.siteRaised = sites[0].box.max.y < 1 && Math.abs(b.sites[0].box.max.y - b.sites[0].box.min.y - 3) < 1e-6;
    b.reset('a', new V(2, 0, 2));
    out.outside = steps(10, [actor({ use: true, position: new V(9, 0, 9) })]);
    out.release = [...steps(60, [actor({ use: true })]), ...steps(1, [actor()])];
    out.move = [...steps(10, [actor({ use: true })]), ...steps(1, [actor({ use: true, speed: 2 })])];
    out.heldAfterCancel = [...out.move, ...steps(20, [actor({ use: true })])];
    steps(1, [actor()]);
    out.hurt = [...steps(10, [actor({ use: true })]), ...steps(1, [actor({ use: true, hits: 1 })])];
    steps(1, [actor({ hits: 1 })]);
    out.zone = [...steps(10, [actor({ use: true, hits: 1 })]), ...steps(1, [actor({ use: true, hits: 1, position: new V(5, 0, 2) })])];
    steps(1, [actor({ hits: 1 })]);
    out.dead = [...steps(10, [actor({ use: true, hits: 1 })]), ...steps(1, [actor({ use: true, alive: false })])];
    out.dropped = [b.state, b.carrier, b.position.toArray()];
    out.defenderNoPickup = steps(5, [actor({ id: 'd', side: 'defense' })]);
    out.pickup = [...steps(1, [actor({ id: 'c', position: new V(2.5, 0, 2) })]), b.carrier];
    const plant = steps(Math.ceil(3.2 * 120) + 3, [actor({ id: 'c', use: true })]);
    out.plant = [plant.filter((e) => e !== 'plant-start').join(), plant[0], b.state, b.site, b.plantedBy];
    const def = (o) => actor({ id: 'd', side: 'defense', position: new V(2.8, 0, 2), use: true, ...o });
    out.defuseFar = steps(5, [def({ position: new V(5, 0, 5) })]);
    out.defuseHurt = [...steps(60, [def()]), ...steps(1, [def({ hits: 2 })])];
    steps(1, [def({ hits: 2, use: false })]);
    const timeLeft = b.timeLeft;
    const d = steps(Math.ceil(7 * 120) + 1, [def({ hits: 2 })]);
    out.defuse = [d[0], d.at(-1), b.state, b.defusedBy, +(timeLeft - b.timeLeft).toFixed(2)];
    out.afterDefuse = steps(10000, [def({ hits: 2 })]);
    // Explosion when nobody defuses.
    b.reset('c', new V(2, 0, 2));
    steps(400, [actor({ id: 'c', use: true })]);
    const ex = steps(Math.ceil(40 * 120) + 2, []);
    out.explode = [ex.join(), b.state];
    out.afterExplode = steps(100, [def()]);
    return out;
  });
  assert.deepEqual(r.cfg, { plant: 3.2, defuse: 7, timer: 40 });
  assert.equal(r.siteRaised, true, 'a flat floor marker becomes a 3 m tall volume');
  assert.deepEqual(r.heldAfterCancel, ['plant-start', 'plant-cancel:move'], 'after a cancel, E must be released before a new start');
  assert.deepEqual(r.outside, [], 'no plant outside a site');
  assert.deepEqual(r.release, ['plant-start', 'plant-cancel:release']);
  assert.deepEqual(r.move, ['plant-start', 'plant-cancel:move']);
  assert.deepEqual(r.hurt, ['plant-start', 'plant-cancel:hurt']);
  assert.deepEqual(r.zone, ['plant-start', 'plant-cancel:zone']);
  assert.deepEqual(r.dead, ['plant-start', 'plant-cancel:dead', 'drop']);
  assert.deepEqual(r.dropped, ['dropped', null, [2, 0.02, 2]]);
  assert.deepEqual(r.defenderNoPickup, [], 'defenders do not pick it up');
  assert.deepEqual(r.pickup, ['pickup', 'c']);
  assert.deepEqual(r.plant, ['planted', 'plant-start', 'planted', 'A', 'c']);
  assert.deepEqual(r.defuseFar, []);
  assert.deepEqual(r.defuseHurt, ['defuse-start', 'defuse-cancel:hurt']);
  assert.equal(r.defuse[0], 'defuse-start');
  assert.equal(r.defuse[1], 'defused');
  assert.deepEqual(r.defuse.slice(2, 4), ['defused', 'd']);
  assert.ok(Math.abs(r.defuse[4] - 7) < 0.02, `7 s defuse (${r.defuse[4]})`);
  assert.deepEqual(r.afterDefuse, [], 'nothing after a defuse');
  assert.deepEqual(r.explode, ['exploded', 'exploded'], 'one explosion');
  assert.deepEqual(r.afterExplode, []);
});

test('sites come from the map (warehouse A / B plant areas); round 1: BLUE attacks, the player carries the C4', async () => {
  await page.click('.play-button');
  await page.waitForFunction(() => document.pointerLockElement === window.game.renderer.domElement && window.game.input.active);
  await page.mouse.move(0, 0);
  await installFrameDriver(page);
  const r = await page.evaluate(() => {
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
    /** A walkable spot inside site `name` where a standing player fits. */
    T.siteSpot = (name) => {
      const site = g.bomb.sites.find((s) => s.name === name);
      const c = site.box.getCenter(new T.V());
      let best = null;
      for (const cell of g.nav.walkable) {
        const p = g.nav.center(cell);
        if (!site.box.containsPoint(p.clone().setY(p.y + 0.05)) || !g.spawnFits(g.map, p)) continue;
        const d = Math.hypot(p.x - c.x, p.z - c.z);
        if (!best || d < best.d) best = { p, d };
      }
      return best.p;
    };
    T.hud = () => ({
      side: document.querySelector('.team-hud .ta.side').textContent,
      boxShown: !document.querySelector('.team-hud .bomb-box').hidden,
      status: document.querySelector('.team-hud .bomb-text').textContent,
      timer: document.querySelector('.team-hud .bomb-timer').textContent,
      hint: document.querySelector('.team-hud .bomb-hint').textContent,
      progress: document.querySelector('.team-hud .bomb-progress').hidden ? null : document.querySelector('.team-hud .bomb-progress-label').textContent,
    });
    g.restartMatch();
    T.run(2);
    const sites = g.map.bombSites.map((s) => ({ name: s.name, centre: s.box.getCenter(new T.V()).toArray().map((v) => +v.toFixed(1)) }));
    return { sites, objective: g.teamMatch.config.objective, attackers: g.teamMatch.attackers, carrier: g.bomb.carrier, state: g.bomb.state, hud: T.hud() };
  });
  assert.deepEqual(r.sites.map((s) => s.name), ['A', 'B']);
  // Zone_A_Site_PlantArea at (-22.5, -21) and Zone_B_Site_PlantArea at (16.5, -17.25) in the map file.
  assert.deepEqual([r.sites[0].centre[0], r.sites[0].centre[2]], [-22.5, -21]);
  assert.deepEqual([r.sites[1].centre[0], r.sites[1].centre[2]], [16.5, -17.3]);
  assert.equal(r.objective, 'bomb');
  assert.equal(r.attackers, 'blue');
  assert.deepEqual([r.carrier, r.state], ['local', 'carried']);
  assert.equal(r.hud.side, '공격 · C4 설치');
  assert.equal(r.hud.status, 'C4 보유');
});

test('planting with E: nothing outside a site; in site A, held 3.2 s standing still: planted, $300, clock stopped, timer on the HUD', async () => {
  const pre = await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    T.until('live');
    g.combat.protection = 1e9; // the player is the subject: kept alive while the bots fight
    T.spot = T.siteSpot('A');
    return { phase: g.teamMatch.phase };
  });
  assert.equal(pre.phase, 'live');
  // Outside a site: E does nothing.
  await page.keyboard.down('KeyE');
  await run(30);
  await page.keyboard.up('KeyE');
  await run(2);
  assert.equal(await page.evaluate(() => window.game.bomb.state), 'carried');
  const moneyBefore = await page.evaluate(() => {
    const g = window.game;
    g.player.teleport(window.T.spot.clone().setY(window.T.spot.y + 0.1), 0);
    window.T.run(20);
    return g.teamMatch.economy.money('local');
  });
  const hint = await page.evaluate(() => window.T.hud().hint);
  assert.equal(hint, 'A 사이트 — E 길게: C4 설치');
  // Held, but walking: cancelled.
  await page.keyboard.down('KeyE');
  await run(30);
  const mid = await page.evaluate(() => ({ p: window.game.bomb.plantProgress, hud: window.T.hud() }));
  await page.keyboard.down('KeyW');
  await run(10);
  await page.keyboard.up('KeyW');
  await page.keyboard.up('KeyE');
  const cancelled = await page.evaluate(() => ({ planting: window.game.bomb.planting, state: window.game.bomb.state }));
  await page.evaluate(() => {
    window.game.player.teleport(window.T.spot.clone().setY(window.T.spot.y + 0.1), 0);
    window.T.run(30);
  });
  // Held 3.2 s.
  await page.keyboard.down('KeyE');
  const clock0 = await page.evaluate(() => window.game.teamMatch.roundTimeLeft);
  await run(3.2 * 60 + 3);
  await page.keyboard.up('KeyE');
  const r = await page.evaluate(() => {
    const g = window.game;
    const clock = g.teamMatch.roundTimeLeft;
    window.T.run(60);
    return { state: g.bomb.state, site: g.bomb.site, by: g.bomb.plantedBy, planted: g.teamMatch.planted, money: g.teamMatch.economy.money('local'), clockStopped: g.teamMatch.roundTimeLeft === clock, timeLeft: g.bomb.timeLeft, hud: window.T.hud(), shown: g.bombFx.group.children[0].visible };
  });
  assert.ok(mid.p > 0.1 && mid.p < 0.25, `progress after 0.5 s: ${mid.p}`);
  assert.equal(mid.hud.progress, 'C4 설치 중');
  assert.deepEqual(cancelled, { planting: null, state: 'carried' }, 'moving cancels the plant');
  assert.deepEqual([r.state, r.site, r.by, r.planted], ['planted', 'A', 'local', true]);
  assert.equal(r.money, moneyBefore + 300);
  assert.equal(r.clockStopped, true);
  assert.ok(clock0 < 120);
  assert.ok(Math.abs(r.timeLeft - 39) < 0.05, `timer ${r.timeLeft}`);
  assert.equal(r.hud.status, 'C4 설치됨 · A 사이트');
  assert.equal(r.hud.timer, '0:39');
  assert.equal(r.shown, true, 'the charge lies on the ground');
});

test('after the plant: attackers wiped out does not end the round; the explosion does (attackers win), damaging those near it, once', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    const tm = g.teamMatch;
    // A red bot standing right next to the bomb (well inside the blast).
    const red = g.squad.bots.find((b) => b.team === 'red' && b.alive);
    red.controller.teleport(g.bomb.position.clone().setY(g.bomb.position.y + 0.1).add(new T.V(1.5, 0, 0)), 0);
    red.combat.protection = 0;
    // Every attacker dies.
    for (const b of g.squad.bots) if (b.team === 'blue') T.kill(b.combat);
    T.kill(g.combat);
    T.run(30);
    const afterWipe = { phase: tm.phase, alive: g.teamAlive() };
    const blueMoney = tm.economy.money('local');
    let frames = 0;
    while (g.bomb.state === 'planted' && frames < 3000) {
      // Keep the red bot by the bomb (no defuse: bots get their objective logic in the bot stage).
      red.controller.teleport(g.bomb.position.clone().setY(g.bomb.position.y + 0.1).add(new T.V(1.5, 0, 0)), 0);
      red.useKey = false;
      T.run(1);
      frames++;
    }
    const last = tm.lastRound;
    return { afterWipe, frames, state: g.bomb.state, phase: tm.phase, last, redAlive: red.alive, gain: tm.economy.money('local') - blueMoney, wins: { ...tm.roundWins }, feed: tm.feed.filter((k) => k.weaponId === 'c4').length, history: tm.history.length, banner: document.querySelector('.team-hud .round-banner .rb-main').textContent };
  });
  assert.deepEqual(r.afterWipe, { phase: 'live', alive: { blue: 0, red: r.afterWipe.alive.red } });
  assert.ok(r.afterWipe.alive.red > 0);
  assert.ok(Math.abs(r.frames / 60 - 38.5) < 0.6, `exploded at the 40 s timer (${(r.frames / 60).toFixed(2)} s after)`);
  assert.equal(r.state, 'exploded');
  assert.equal(r.phase, 'result');
  assert.deepEqual([r.last.winner, r.last.reason], ['blue', 'bomb']);
  assert.equal(r.redAlive, false, 'the red bot next to it was killed by the blast');
  assert.ok(r.feed >= 1, 'blast kills in the feed as C4');
  assert.equal(r.gain, 3000, 'attackers paid the win reward once');
  assert.deepEqual(r.wins, { blue: 1, red: 0 });
  assert.equal(r.history, 1);
  assert.equal(r.banner, 'BLUE 라운드 승리 (C4 폭파)');
});

test('half time: sides swap (BLUE defends), money and gear start over; a dropped C4 is picked up by an attacker; the player defuses it with E', async () => {
  const r0 = await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    const tm = g.teamMatch;
    // Quick rounds up to half time (rounds to win 5: sides swap after round 4): BLUE wipes RED out.
    const rounds = [];
    while (tm.round < 5 && !tm.over) {
      T.until('live');
      g.combat.protection = 1e9;
      rounds.push({ round: tm.round, carrier: g.bomb.carrier, attackers: tm.attackers });
      for (const b of g.squad.bots) if (b.team === 'red' && b.alive) T.kill(b.combat);
      T.until('prep');
    }
    g.updateBuyMenu();
    return { rounds, round: tm.round, attackers: tm.attackers, swapped: tm.swappedAtRound, money: tm.economy.money('local'), redMoney: tm.economy.money(g.squad.bots.find((b) => b.team === 'red').id), gear: g.weapons.loadout.map((w) => w.def.id), wins: { ...tm.roundWins }, hud: T.hud() };
  });
  // Carriers rotate through BLUE: the player, then the bots.
  // Round 1 was the player's; rounds 2-4 go to BLUE's bots in turn (bot-1..bot-4 are BLUE).
  assert.deepEqual(r0.rounds.map((x) => [x.round, x.carrier]), [[2, 'bot-1'], [3, 'bot-2'], [4, 'bot-3']]);
  assert.deepEqual(r0.rounds.map((x) => x.attackers), ['blue', 'blue', 'blue']);
  assert.equal(r0.round, 5);
  assert.deepEqual([r0.attackers, r0.swapped], ['red', 5]);
  assert.deepEqual(r0.wins, { blue: 4, red: 0 });
  assert.equal(r0.money, 3000, 'money starts over at half time');
  assert.equal(r0.redMoney, 3000);
  assert.deepEqual(r0.gear, ['karambit'], 'gear starts over (default issue)');
  assert.equal(r0.hud.side, '방어 · C4 저지');
  assert.equal(r0.hud.status, '', 'defenders are not told who carries the bomb');

  const r = await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    const tm = g.teamMatch;
    T.until('live');
    g.combat.protection = 1e9;
    const carrierBot = g.squad.bots.find((b) => b.id === g.bomb.carrier);
    // The carrier dies: the bomb drops where it fell; another RED attacker walks onto it.
    T.kill(carrierBot.combat);
    T.run(1);
    const drop = { state: g.bomb.state, at: g.bomb.position.distanceTo(carrierBot.position) };
    const other = g.squad.bots.find((b) => b.team === 'red' && b.alive);
    other.controller.teleport(g.bomb.position.clone().setY(g.bomb.position.y + 0.1), 0);
    T.run(1);
    const pickup = { state: g.bomb.state, carrier: g.bomb.carrier, expected: other.id };
    // The new carrier plants at site B (held still there by the test; bot objective logic comes later).
    const spot = T.siteSpot('B');
    let n = 0;
    while (g.bomb.state !== 'planted' && n < 600) {
      other.controller.teleport(spot.clone().setY(spot.y + 0.1), 0);
      other.useKey = true;
      T.run(1);
      n++;
    }
    other.useKey = false;
    T.spotB = spot;
    return { drop, pickup, planted: g.bomb.state, site: g.bomb.site, by: g.bomb.plantedBy, plantFrames: n, hud: T.hud() };
  });
  assert.deepEqual([r.drop.state, r.drop.at < 0.01], ['dropped', true]);
  assert.deepEqual([r.pickup.state, r.pickup.carrier], ['carried', r.pickup.expected]);
  assert.deepEqual([r.planted, r.site], ['planted', 'B']);
  assert.ok(Math.abs(r.plantFrames / 60 - 3.2) < 0.1, `planted after ${(r.plantFrames / 60).toFixed(2)} s`);
  assert.equal(r.hud.status, 'C4 설치됨 · B 사이트');
  assert.equal(r.hud.hint, 'B 사이트로 가서 해체');

  // The player defuses: next to the bomb, E held. A hit cancels; then 7 s unhurt.
  await page.evaluate(() => {
    const g = window.game;
    const p = g.bomb.position;
    g.player.teleport(new window.T.V(p.x + 0.8, p.y + 0.1, p.z), 0);
    // Keep the red side from interfering: only the planter is left, held far away.
    for (const b of g.squad.bots) if (b.team === 'red' && b.alive && b.id !== g.bomb.plantedBy) window.T.kill(b.combat);
    window.T.run(30);
  });
  const near = await page.evaluate(() => window.T.hud().hint);
  assert.equal(near, 'E 길게: C4 해체 (7초)');
  await page.keyboard.down('KeyE');
  await run(60);
  const hurt = await page.evaluate(() => {
    const g = window.game;
    const before = g.bomb.defuseProgress;
    g.combat.protection = 0;
    g.combat.applyDamage({ amount: 5, zone: 'limb', sourceId: g.bomb.plantedBy, weaponId: 'ar01', point: new window.T.V(), direction: new window.T.V(0, 0, 1), distance: 5 });
    g.combat.protection = 1e9;
    window.T.run(1);
    return { before, after: g.bomb.defusing, hud: window.T.hud().progress };
  });
  await page.keyboard.up('KeyE');
  await run(2);
  const planterId = await page.evaluate(() => window.game.bomb.plantedBy);
  await page.keyboard.down('KeyE');
  const res = await page.evaluate((planterId) => {
    const g = window.game;
    const T = window.T;
    const planter = g.squad.bots.find((b) => b.id === planterId);
    const far = T.spotB.clone().add(new T.V(0, 0.1, 0));
    const money = g.teamMatch.economy.money('local');
    let n = 0;
    const hudMid = [];
    while (g.bomb.state === 'planted' && n < 7.5 * 60) {
      // The planter is kept out of the fight (it would otherwise shoot the defuser).
      planter.controller.teleport(far.clone().add(new T.V(0, 0, 30)), 0);
      T.run(1);
      n++;
      if (n === 210) hudMid.push(T.hud().progress, +g.bomb.defuseProgress.toFixed(2));
    }
    T.run(1);
    return { frames: n, state: g.bomb.state, by: g.bomb.defusedBy, last: g.teamMatch.lastRound, gain: g.teamMatch.economy.money('local') - money, hudMid, over: g.teamMatch.over || g.teamMatch.phase };
  }, planterId);
  await page.keyboard.up('KeyE');
  assert.ok(hurt.before > 0.1, 'defusing');
  assert.equal(hurt.after, null, 'a hit cancels the defuse');
  assert.equal(res.state, 'defused');
  assert.equal(res.by, 'local');
  assert.ok(Math.abs(res.frames / 60 - 7) < 0.1, `7 s defuse (${(res.frames / 60).toFixed(2)} s)`);
  assert.deepEqual(res.hudMid, ['C4 해체 중', 0.5]);
  assert.deepEqual([res.last.winner, res.last.reason, res.last.attackers], ['blue', 'defuse', 'red']);
  assert.equal(res.gain, 300 + 3000, 'defuse bonus + round win');
  assert.deepEqual(page.errors, []);
});

test('Seoul: both bomb sites read from the map (BombSite_A / B_PlantZone_Volume), each with standing room inside', async () => {
  await page.evaluate(() => document.exitPointerLock());
  const r = await page.evaluate(async () => {
    const g = window.game;
    await g.switchMap('seoul');
    // switchMap rebuilds the match on the new map.
    return {
      map: g.mapDef.id,
      objective: g.teamMatch.config.objective,
      sites: g.map.bombSites.map((s) => ({ name: s.name, centre: s.box.getCenter(new window.T.V()).toArray(), size: s.box.getSize(new window.T.V()).toArray() })),
      spots: ['A', 'B'].map((n) => !!window.T.siteSpot(n)),
      carrier: g.bomb.carrier,
    };
  });
  assert.equal(r.map, 'seoul');
  assert.equal(r.objective, 'bomb');
  assert.deepEqual(r.sites.map((s) => s.name), ['A', 'B']);
  assert.deepEqual(r.sites[0].centre.map((v) => Math.round(v)), [-35, 2, -41]);
  assert.deepEqual(r.sites[1].centre.map((v) => Math.round(v)), [29, 2, -38]);
  assert.deepEqual(r.sites[0].size.map((v) => Math.round(v)), [12, 3, 10]);
  assert.deepEqual(r.spots, [true, true]);
  assert.equal(r.carrier, 'local');
  assert.deepEqual(page.errors, []);
});
