// 5v5 round-based team match: rosters and teams, bots that only fight the
// other team, friendly fire off (rounds pass through teammates), rounds that
// end on elimination or on the clock, no respawns inside a round, a clean
// reset between rounds, the match result, restart, and the other modes left
// as they were. Frames are driven at fixed 1/60 s with the real loop stopped.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, openGame, installFrameDriver } from './harness.mjs';

let env;
let page;
before(async () => {
  env = await startEnv();
  // Elimination rules (round won by wiping out the other team / most survivors at time); the C4 rules: bomb.test.mjs.
  page = await openGame(env, { map: 'warehouse', mode: 'team', objective: 'elimination' });
  await page.click('.play-button');
  await page.waitForFunction(() => !!document.pointerLockElement && document.querySelector('.hud').classList.contains('playing'));
  await page.mouse.move(0, 0);
  await installFrameDriver(page);
  await page.evaluate(() => {
    window.T.stopLoop();
    const g = window.game;
    const T = window.T;
    T.V = g.player.position.constructor;
    T.tm = () => g.teamMatch;
    /** Everyone in the match: [id, team, alive, Damageable]. */
    T.all = () => [{ id: 'local', team: g.combat.team, alive: g.combat.alive, target: g.combat }, ...g.squad.bots.map((b) => ({ id: b.id, team: b.team, alive: b.alive, target: b.combat }))];
    /** Kills a combatant the way a round would (through its own applyDamage), credited to `by`. */
    T.kill = (target, by = 'test') => {
      target.protection = 0;
      target.applyDamage({ amount: 999, zone: 'body', sourceId: by, weaponId: 'ar01', point: new T.V(), direction: new T.V(0, 0, 1), distance: 5 });
    };
    /** Runs frames until the match reaches `phase` (or `max` frames). Returns frames run. */
    T.until = (phase, max = 2000) => {
      let n = 0;
      while (g.teamMatch.phase !== phase && n < max) {
        T.run(1);
        n++;
      }
      return n;
    };
    T.snapshot = () => ({
      phase: g.teamMatch.phase,
      round: g.teamMatch.round,
      wins: { ...g.teamMatch.roundWins },
      alive: g.teamAlive(),
      history: g.teamMatch.history.map((r) => ({ ...r, alive: { ...r.alive } })),
    });
  });
});
after(async () => {
  await page?.context().close();
  await env?.close();
});

test('setup: player + 9 bots; BLUE = player + 4 bots, RED = 5 bots; valid spawns at the two ends', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const bots = g.squad.bots;
    const blue = bots.filter((b) => b.team === 'blue');
    const red = bots.filter((b) => b.team === 'red');
    let minCross = Infinity;
    const bluePos = [g.player.position, ...blue.map((b) => b.position)];
    for (const a of bluePos) for (const b of red) minCross = Math.min(minCross, Math.hypot(a.x - b.position.x, a.z - b.position.z));
    let minSame = Infinity;
    for (const list of [bluePos, red.map((b) => b.position)])
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) minSame = Math.min(minSame, Math.hypot(list[i].x - list[j].x, list[i].z - list[j].z));
    return {
      mode: g.mode,
      phase: g.teamMatch.phase,
      round: g.teamMatch.round,
      bots: bots.length,
      registered: [...g.hitscan.targets].filter((t) => t.id.startsWith('bot-')).length,
      playerTeam: g.combat.team,
      playerWeaponTeam: g.weapons.team,
      blue: blue.length,
      red: red.length,
      scores: [...g.teamMatch.scores.values()].map((s) => s.team).sort().join(','),
      alive: g.teamAlive(),
      friendlyFire: g.hitscan.friendlyFire,
      respawns: g.squad.respawns,
      onWalkable: [g.player.position, ...bots.map((b) => b.position)].every((p) => g.nav.nearestWalkable(p) >= 0),
      minCross,
      minSame,
      config: { ...g.teamMatch.config },
      dummies: g.trainingRange,
      ffaMatch: g.match,
    };
  });
  assert.equal(r.mode, 'team');
  assert.equal(r.phase, 'prep');
  assert.equal(r.round, 1);
  assert.deepEqual([r.bots, r.registered], [9, 9]);
  assert.equal(r.playerTeam, 'blue');
  assert.equal(r.playerWeaponTeam, 'blue');
  assert.deepEqual([r.blue, r.red], [4, 5]);
  assert.equal(r.scores, 'blue,blue,blue,blue,blue,red,red,red,red,red');
  assert.deepEqual(r.alive, { blue: 5, red: 5 });
  assert.equal(r.friendlyFire, false);
  assert.equal(r.respawns, false);
  assert.equal(r.onWalkable, true);
  assert.ok(r.minCross > 40, `the teams start far apart (${r.minCross.toFixed(1)} m)`);
  assert.ok(r.minSame > 1, `nobody spawns on a teammate (${r.minSame.toFixed(2)} m)`);
  assert.deepEqual([r.config.teamSize, r.config.roundsToWin, r.config.roundTime], [5, 5, 120]);
  assert.equal(r.dummies, null);
  assert.equal(r.ffaMatch, null, 'no free-for-all match in team mode');
});

test('spawn spots fit a standing body (not inside map geometry)', async () => {
  const r = await page.evaluate(async () => {
    const g = window.game;
    const { Line3 } = await import('/node_modules/three/build/three.module.js');
    const seg = new Line3();
    const bad = [];
    for (const t of ['blue', 'red'])
      for (const s of g.teamSpawns[t]) {
        const p = s.position;
        seg.start.set(p.x, p.y + 0.1 + 0.35, p.z);
        seg.end.set(p.x, p.y + 0.1 + 1.8 - 0.35, p.z);
        if (g.map.collision.capsuleOverlaps(seg, 0.33)) bad.push([t, p.x, p.z]);
      }
    return { counts: [g.teamSpawns.blue.length, g.teamSpawns.red.length], bad };
  });
  assert.deepEqual(r.counts, [5, 5]);
  assert.deepEqual(r.bad, []);
});

test('prep (작전 준비, the buy time): everyone is frozen and nobody shoots; then the round goes live', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    const pos0 = g.squad.bots.map((b) => b.position.clone());
    const shots0 = g.squad.bots.reduce((s, b) => s + b.weapons.shotsFired, 0);
    // (The real loop may have run a moment after Play before the test took over: measure from what is left.)
    const tm = g.teamMatch;
    const left0 = tm.phaseLeft;
    const full = tm.config.prepTime;
    // Count the simulation ticks spent in prep (independent of frame timing).
    let prepTicks = 0;
    const update = tm.update;
    tm.update = function (dt, alive) {
      if (this.phase === 'prep') prepTicks++;
      return update.call(this, dt, alive);
    };
    T.run(60); // 1 s of the 15 s prep
    const moved = Math.max(...g.squad.bots.map((b, i) => Math.hypot(b.position.x - pos0[i].x, b.position.z - pos0[i].z)));
    const shots = g.squad.bots.reduce((s, b) => s + b.weapons.shotsFired, 0) - shots0;
    const stillPrep = g.teamMatch.phase;
    const frames = T.until('live', 1200);
    delete tm.update;
    return { moved, shots, stillPrep, frames, left0, full, prepTicks, phase: g.teamMatch.phase, clock: g.teamMatch.roundTimeLeft };
  });
  assert.ok(r.moved < 0.05, `bots hold still in prep (${r.moved})`);
  assert.equal(r.shots, 0);
  assert.equal(r.stillPrep, 'prep');
  assert.equal(r.phase, 'live');
  assert.equal(r.full, 15, 'the prep phase is the 15 s buy time');
  assert.ok(r.left0 > 13 && r.left0 <= 15, `prep had just started (${r.left0} s left)`);
  // The prep ends on its own clock: exactly the time that was left, in 1/120 s ticks (±1 for rounding).
  const expected = r.left0 * 120;
  assert.ok(Math.abs(r.prepTicks - expected) <= 1, `prep runs out on its clock (${r.prepTicks} ticks, expected ${expected.toFixed(1)})`);
  assert.ok(r.frames > 0);
  assert.ok(r.clock > 119.9, `round clock starts full (${r.clock})`);
});

test('bots never take a teammate as an enemy, even one standing right in front of them in the open', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const V = window.T.V;
    const bots = g.squad.bots;
    const [a, b] = bots.filter((x) => x.team === 'blue');
    const reds = bots.filter((x) => x.team === 'red');
    const nav = g.nav;
    const col = g.map.collision;
    // Two teammates 6-12 m apart with a clear line, facing each other.
    let p = null;
    let q = null;
    for (let k = 0; k < 4000; k++) {
      p = nav.center(nav.randomCell());
      q = nav.center(nav.randomCell());
      const d = Math.hypot(p.x - q.x, p.z - q.z);
      if (d < 6 || d > 12 || Math.abs(p.y - q.y) > 0.3) continue;
      const e1 = new V(p.x, p.y + 1.6, p.z);
      const dir = new V(q.x, q.y + 1.6, q.z).sub(e1);
      const len = dir.length();
      if (col.raycast(e1, dir.normalize(), len) === null) break;
    }
    a.spawn(p, Math.atan2(-(q.x - p.x), -(q.z - p.z)));
    b.spawn(q, Math.atan2(-(p.x - q.x), -(p.z - q.z)));
    a.combat.protection = b.combat.protection = 0;
    const everyone = window.T.all().map((c) => (c.id === 'local' ? { id: 'local', team: 'blue', alive: false, position: g.player.position, height: 1.8 } : bots.find((x) => x.id === c.id)));
    // Enemies far away and out of sight for this check.
    const redPos = reds.map((x) => x.position.clone());
    reds.forEach((x) => x.controller.teleport(new V(999, -50, 999), 0));
    let engaged = 0;
    for (let i = 0; i < 240; i++) {
      a.step(1 / 120, everyone, bots);
      b.step(1 / 120, everyone, bots);
      if (a.mode === 'engage' || b.mode === 'engage') engaged++;
    }
    reds.forEach((x, i) => x.controller.teleport(redPos[i], 0));
    return { engaged, shots: a.weapons.shotsFired + b.weapons.shotsFired, isEnemy: a.isEnemy(b), isEnemyRed: a.isEnemy(reds[0]), isEnemyPlayer: a.isEnemy(g.playerCombatant ?? { id: 'local', team: 'blue' }) };
  });
  assert.equal(r.engaged, 0, 'no engagement with a teammate in plain view');
  assert.equal(r.shots, 0);
  assert.equal(r.isEnemy, false);
  assert.equal(r.isEnemyRed, true);
  assert.equal(r.isEnemyPlayer, false, 'the player is a BLUE teammate');
});

test('friendly fire is off: rounds pass through teammates without damage; enemy rounds hurt as usual', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const V = window.T.V;
    const bots = g.squad.bots;
    const ally = bots.find((b) => b.team === 'blue');
    const enemy = bots.find((b) => b.team === 'red');
    g.combat.reset();
    g.combat.protection = 0;
    const p = g.player.position;
    const chest = new V(p.x, p.y + 1.1, p.z);
    // Rounds as an AR-01 fires them (the bots' rifle; the player starts a team round with the knife only).
    const rifle = ally.weapons.weapon.def.damage;
    const shotAt = (from, shooter) => {
      const dir = chest.clone().sub(from).normalize();
      return g.hitscan.fire({ origin: from, direction: dir, damage: shooter.weapons.weapon.def.damage, sourceId: shooter.id, weaponId: 'ar01', team: shooter.team });
    };
    // Shoot from 2 m beside the player (nothing in between).
    const side = new V(p.x + 2, p.y + 1.1, p.z);
    const fromAlly = shotAt(side, ally);
    const hpAfterAlly = g.player.health;
    const fromEnemy = shotAt(side, enemy);
    const hpAfterEnemy = g.player.health;
    // The player's own rifle (team blue) at a teammate bot: no damage.
    ally.spawn(new V(p.x, p.y, p.z - 3), 0);
    ally.combat.protection = 0;
    const allyChest = new V(ally.position.x, ally.position.y + 1.1, ally.position.z);
    const mine = g.hitscan.fire({ origin: new V(p.x, p.y + 1.1, p.z), direction: allyChest.clone().sub(new V(p.x, p.y + 1.1, p.z)).normalize(), damage: rifle, sourceId: 'local', weaponId: 'ar01', team: 'blue' });
    // An enemy right behind that teammate on the same line is still hit: the round passes through the teammate.
    enemy.spawn(new V(p.x, p.y, p.z - 6), 0);
    enemy.combat.protection = 0;
    const through = g.hitscan.fire({ origin: new V(p.x, p.y + 1.1, p.z), direction: new V(0, 0, -1), damage: rifle, sourceId: 'local', weaponId: 'ar01', team: 'blue' });
    return {
      fromAlly: fromAlly.kind,
      hpAfterAlly,
      fromEnemy: fromEnemy.kind,
      enemyDamage: fromEnemy.damage,
      hpAfterEnemy,
      mine: mine.kind,
      allyHp: ally.combat.health,
      through: through.kind,
      throughId: through.target?.id,
      enemyId: enemy.id,
      throughDamage: through.damage,
      enemyHp: enemy.combat.health,
      feed: g.teamMatch.feed.length,
      kills: [...g.teamMatch.scores.values()].reduce((s, x) => s + x.kills, 0),
    };
  });
  assert.notEqual(r.fromAlly, 'target');
  assert.equal(r.hpAfterAlly, 100, 'a teammate round does no damage');
  assert.equal(r.fromEnemy, 'target');
  assert.equal(r.enemyDamage, 24, 'AR-01 body damage, unchanged');
  assert.equal(r.hpAfterEnemy, 76);
  assert.notEqual(r.mine, 'target');
  assert.equal(r.allyHp, 100);
  assert.equal(r.through, 'target');
  assert.equal(r.throughId, r.enemyId, 'the enemy behind the teammate is hit');
  assert.equal(r.throughDamage, 24);
  assert.equal(r.enemyHp, 76);
  assert.equal(r.feed, 0, 'no kill feed from friendly or non-lethal fire');
  assert.equal(r.kills, 0);
});

test('a team wiped out ends the round at once; the dead stay dead; the next round resets everyone', async () => {
  // Back to a clean round 1.
  await page.evaluate(() => {
    window.game.restartMatch();
    window.T.until('live');
  });
  const r = await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    const reds = g.squad.bots.filter((b) => b.team === 'red');
    // Four reds down: the round goes on, and the dead are not respawned (well past the 3 s free-for-all delay).
    for (const b of reds.slice(0, 4)) T.kill(b.combat, 'local');
    T.run(2);
    const afterFour = T.snapshot();
    T.run(60 * 4);
    const deadAfter4s = reds.slice(0, 4).filter((b) => b.alive).length;
    const stillLive = g.teamMatch.phase;
    // The last red down: elimination, BLUE wins the round on that tick.
    T.kill(reds[4].combat, 'local');
    T.run(1);
    const ended = T.snapshot();
    const banner = document.querySelector('.team-hud .round-banner');
    const bannerText = banner.hidden ? '' : banner.querySelector('.rb-main').textContent;
    // During the result phase: nobody comes back, nobody shoots.
    const shots0 = g.squad.bots.reduce((s, b) => s + b.weapons.shotsFired, 0);
    let revived = 0;
    for (let i = 0; i < 200 && g.teamMatch.phase === 'result'; i++) {
      T.run(1);
      revived += reds.filter((b) => b.alive).length;
    }
    const shotsInResult = g.squad.bots.reduce((s, b) => s + b.weapons.shotsFired, 0) - shots0;
    const playerKills = g.teamMatch.scores.get('local').kills;
    const feed = g.teamMatch.feed.length;
    // Into round 2.
    T.until('prep', 600);
    const next = T.snapshot();
    const bots = g.squad.bots;
    const atSpawn = (b) => g.teamSpawns[b.team].some((s) => Math.hypot(s.position.x - b.position.x, s.position.z - b.position.z) < 0.5);
    return {
      afterFour,
      deadAfter4s,
      stillLive,
      ended,
      bannerText,
      revived,
      shotsInResult,
      playerKills,
      feed,
      next,
      health: bots.map((b) => b.combat.health),
      mags: bots.map((b) => b.weapons.weapon.magazine),
      atSpawn: bots.every(atSpawn),
      playerAtSpawn: Math.hypot(g.player.position.x - g.teamSpawns.blue[0].position.x, g.player.position.z - g.teamSpawns.blue[0].position.z) < 0.5,
      playerHp: g.player.health,
      playerLoadout: g.weapons.loadout.map((w) => w.def.id),
      modes: bots.map((b) => b.mode),
      fx: g.fx.active,
    };
  });
  assert.deepEqual(r.afterFour.alive, { blue: 5, red: 1 });
  assert.equal(r.afterFour.phase, 'live');
  assert.equal(r.deadAfter4s, 0, 'no respawn inside a round');
  assert.equal(r.stillLive, 'live');
  assert.equal(r.ended.phase, 'result');
  assert.deepEqual(r.ended.wins, { blue: 1, red: 0 });
  assert.deepEqual(r.ended.history, [{ round: 1, winner: 'blue', reason: 'elimination', alive: { blue: 5, red: 0 } }]);
  assert.equal(r.bannerText, 'BLUE 라운드 승리');
  assert.equal(r.revived, 0, 'nobody comes back while the result shows');
  assert.equal(r.shotsInResult, 0, 'no shooting after the round is decided');
  assert.equal(r.playerKills, 5);
  assert.equal(r.feed, 5);
  assert.equal(r.next.phase, 'prep');
  assert.equal(r.next.round, 2);
  assert.deepEqual(r.next.alive, { blue: 5, red: 5 });
  assert.deepEqual(r.next.wins, { blue: 1, red: 0 });
  assert.deepEqual(r.health, Array(9).fill(100));
  assert.deepEqual(r.mags, Array(9).fill(30));
  assert.equal(r.atSpawn, true, 'every bot back on its team spawn');
  assert.equal(r.playerAtSpawn, true);
  assert.equal(r.playerHp, 100);
  assert.deepEqual(r.playerLoadout, ['karambit'], 'gear is per round: back to the knife');
  assert.deepEqual([...new Set(r.modes)], ['wander'], 'no AI memory carried over');
  assert.equal(r.fx, 0, 'tracers / flashes cleared');
});

test('the dead player spectates a living teammate, and comes back next round', async () => {
  await page.evaluate(() => window.T.until('live'));
  const r = await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    T.kill(g.combat, 'bot-6');
    T.run(2);
    const deadEarly = { alive: g.combat.alive, note: document.querySelector('.death-note').textContent };
    T.run(120); // past the 1.5 s spectate delay
    const allies = g.squad.bots.filter((b) => b.team === 'blue' && b.alive);
    const cam = g.camera.position;
    const nearest = Math.min(...allies.map((b) => Math.hypot(b.position.x - cam.x, b.position.z - cam.z)));
    const playerDist = Math.hypot(g.player.position.x - cam.x, g.player.position.z - cam.z);
    const note = document.querySelector('.death-note').textContent;
    // Past the free-for-all 3 s respawn delay: still dead (the round result phase, if it came, keeps it so too).
    T.run(90);
    const stillDead = !g.combat.alive && g.combat.deadTime > 3;
    const deaths = g.teamMatch.scores.get('local').deaths;
    const killerKills = g.teamMatch.scores.get('bot-6').kills;
    // (bot-6 may also have shot a BLUE bot meanwhile: the bots keep fighting.)
    const playerDeaths = g.teamMatch.feed.filter((k) => k.victim === 'local').map((k) => k.killer);
    const bot6Feed = g.teamMatch.feed.filter((k) => k.killer === 'bot-6').length;
    // End the round (all reds), wait for the next one.
    for (const b of g.squad.bots.filter((x) => x.team === 'red')) T.kill(b.combat, 'bot-1');
    T.until('prep', 600);
    return { deadEarly, nearest, playerDist, note, stillDead, deaths, killerKills, playerDeaths, bot6Feed, aliveNext: g.combat.alive, hp: g.player.health, noteHidden: document.querySelector('.death').hidden };
  });
  assert.equal(r.deadEarly.alive, false);
  assert.ok(r.nearest < 3, `camera sits behind a living teammate (${r.nearest.toFixed(2)} m)`);
  assert.match(r.note, /^관전 중: (Alpha|Bravo|Charlie|Delta) — 클릭으로 아군 전환$/);
  assert.equal(r.stillDead, true, 'the player is not respawned during the round');
  assert.equal(r.deaths, 1);
  assert.deepEqual(r.playerDeaths, ['bot-6'], 'the RED bot that shot the player gets the kill');
  assert.equal(r.killerKills, r.bot6Feed, "its kill count matches its kill feed entries");
  assert.equal(r.aliveNext, true);
  assert.equal(r.hp, 100);
  assert.equal(r.noteHidden, true);
});

test('round clock: more survivors wins at time; equal survivors is a draw; a double wipe-out is a draw', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    const out = {};
    g.restartMatch();
    T.until('live');
    // Freeze the fight for this check: bots hold, only the clock runs.
    const step = g.squad.step;
    g.squad.step = (dt) => g.squad.hold(dt);
    // Round 1: 5 vs 4 when the clock runs out.
    T.kill(g.squad.bots.find((b) => b.team === 'red').combat, 'local');
    g.teamMatch.roundTimeLeft = 0.1;
    T.run(10);
    out.r1 = g.teamMatch.history.at(-1);
    T.until('live', 2000);
    // Round 2: 4 vs 4 (one each) at time: draw.
    T.kill(g.squad.bots.find((b) => b.team === 'red').combat, 'local');
    T.kill(g.squad.bots.find((b) => b.team === 'blue').combat, 'bot-7');
    g.teamMatch.roundTimeLeft = 0.1;
    T.run(10);
    out.r2 = g.teamMatch.history.at(-1);
    out.banner2 = document.querySelector('.team-hud .round-banner .rb-main').textContent;
    T.until('live', 2000);
    // Round 3: everyone dies in the same tick: draw by elimination.
    for (const c of T.all()) T.kill(c.target, 'test');
    T.run(1);
    out.r3 = g.teamMatch.history.at(-1);
    out.wins = { ...g.teamMatch.roundWins };
    out.round = g.teamMatch.round;
    g.squad.step = step;
    return out;
  });
  assert.deepEqual(r.r1, { round: 1, winner: 'blue', reason: 'time', alive: { blue: 5, red: 4 } });
  assert.deepEqual(r.r2, { round: 2, winner: null, reason: 'time', alive: { blue: 4, red: 4 } });
  assert.equal(r.banner2, '무승부 (시간 종료)');
  assert.deepEqual(r.r3, { round: 3, winner: null, reason: 'elimination', alive: { blue: 0, red: 0 } });
  assert.deepEqual(r.wins, { blue: 1, red: 0 }, 'draws give nobody a round');
  assert.equal(r.round, 3);
});

test('first team to 5 round wins takes the match: results with the winner and every round; restart is a fresh match', async () => {
  await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    g.restartMatch();
    // RED wins round 1, then BLUE wins five.
    T.until('live');
    for (const c of T.all().filter((x) => x.team === 'blue')) T.kill(c.target, 'bot-5');
    T.run(1);
    for (let i = 0; i < 5; i++) {
      T.until('live', 2000);
      for (const b of g.squad.bots.filter((x) => x.team === 'red')) T.kill(b.combat, 'local');
      T.run(2);
    }
  });
  await page.waitForFunction(() => !document.pointerLockElement);
  const res = await page.evaluate(() => {
    const g = window.game;
    const el = document.querySelector('.team-hud .results');
    return {
      phase: g.teamMatch.phase,
      winner: g.teamMatch.winner,
      wins: { ...g.teamMatch.roundWins },
      rounds: g.teamMatch.history.map((r) => r.winner),
      shown: !el.hidden,
      title: el.querySelector('.results-title').textContent,
      sub: el.querySelector('.results-sub').textContent,
      chips: [...el.querySelectorAll('.round-history .rh-w')].map((x) => x.textContent),
      tables: [...el.querySelectorAll('.results-teams table')].map((t) => t.querySelectorAll('tbody tr').length),
    };
  });
  assert.equal(res.phase, 'over');
  assert.equal(res.winner, 'blue');
  assert.deepEqual(res.wins, { blue: 5, red: 1 });
  assert.deepEqual(res.rounds, ['red', 'blue', 'blue', 'blue', 'blue', 'blue']);
  assert.equal(res.shown, true);
  assert.equal(res.title, 'BLUE 승리');
  assert.equal(res.sub, '승리 · BLUE 5 : 1 RED · 6라운드');
  assert.deepEqual(res.chips, ['RED', 'BLUE', 'BLUE', 'BLUE', 'BLUE', 'BLUE']);
  assert.deepEqual(res.tables, [5, 5]);

  // Restart from the results screen.
  await page.click('.team-hud .results-restart');
  await page.waitForFunction(() => !!document.pointerLockElement && document.querySelector('.hud').classList.contains('playing'));
  await page.evaluate(() => window.T.run(5));
  const fresh = await page.evaluate(() => {
    const g = window.game;
    return {
      ...window.T.snapshot(),
      kills: [...g.teamMatch.scores.values()].reduce((s, x) => s + x.kills + x.deaths, 0),
      feed: g.teamMatch.feed.length,
      shown: !document.querySelector('.team-hud .results').hidden,
      hp: g.player.health,
      bots: g.squad.bots.length,
    };
  });
  assert.equal(fresh.phase, 'prep');
  assert.equal(fresh.round, 1);
  assert.deepEqual(fresh.wins, { blue: 0, red: 0 });
  assert.deepEqual(fresh.history, []);
  assert.deepEqual(fresh.alive, { blue: 5, red: 5 });
  assert.equal(fresh.kills, 0);
  assert.equal(fresh.feed, 0);
  assert.equal(fresh.shown, false);
  assert.equal(fresh.hp, 100);
  assert.equal(fresh.bots, 9);
});

test('HUD: round wins, round number, clock and survivors; Tab shows both teams with kills and deaths', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    T.until('live');
    T.kill(g.squad.bots.find((b) => b.team === 'red').combat, 'local');
    T.run(2);
    const q = (s) => document.querySelector('.team-hud ' + s);
    return {
      visible: !document.querySelector('.team-hud').hidden,
      ffaHidden: document.querySelector('.match-hud:not(.team-hud)').hidden,
      blue: q('.tb-wins-blue').textContent,
      red: q('.tb-wins-red').textContent,
      round: q('.tb-round').textContent,
      time: q('.tb-time').textContent,
      aliveBlue: q('.ta-blue').textContent,
      aliveRed: q('.ta-red').textContent,
      feed: q('.killfeed').textContent,
    };
  });
  assert.equal(r.visible, true);
  assert.equal(r.ffaHidden, true);
  assert.deepEqual([r.blue, r.red, r.round], ['0', '0', '라운드 1']);
  assert.match(r.time, /^[12]:\d\d$/);
  assert.deepEqual([r.aliveBlue, r.aliveRed], ['5', '4']);
  assert.match(r.feed, /^YOU AR-01 (Echo|Foxtrot|Golf|Hotel|India)$/);
  await page.keyboard.down('Tab');
  await page.evaluate(() => window.T.run(2));
  const board = await page.evaluate(() => {
    const b = document.querySelector('.team-hud .scoreboard');
    return {
      shown: !b.hidden,
      heads: [...b.querySelectorAll('thead th:first-child')].map((x) => x.textContent),
      rows: [...b.querySelectorAll('tbody tr')].map((tr) => [tr.dataset.team, ...[...tr.children].slice(1).map((td) => td.textContent)]),
    };
  });
  await page.keyboard.up('Tab');
  assert.equal(board.shown, true);
  assert.deepEqual(board.heads, ['BLUE · 0', 'RED · 0']);
  assert.equal(board.rows.length, 10);
  assert.deepEqual(board.rows[0], ['blue', 'YOU', '1', '0'], 'the player leads BLUE with the kill');
  assert.equal(board.rows.filter((x) => x[0] === 'red' && x[3] === '1').length, 1, 'one RED death');
});

test('Tab board (team): no bar on its top edge (the column header lines stay); closed on release and on focus loss', async () => {
  await page.keyboard.down('Tab');
  await page.evaluate(() => window.T.run(1));
  const top = await page.evaluate(() => {
    const b = document.querySelector('.team-hud .scoreboard');
    const th = b.querySelector('thead th');
    return { shown: !b.hidden, width: getComputedStyle(b).borderTopWidth, before: getComputedStyle(b, '::before').content, headerLine: getComputedStyle(th).borderBottomWidth, tables: b.querySelectorAll(':scope > table').length };
  });
  await page.keyboard.up('Tab');
  assert.deepEqual(top, { shown: true, width: '0px', before: 'none', headerLine: '1px', tables: 2 });
  const closed = () => page.evaluate(() => (window.T.run(1), document.querySelector('.team-hud .scoreboard').hidden));
  assert.equal(await closed(), true);
  await page.keyboard.down('Tab');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  assert.equal(await closed(), true, 'a focus change while Tab is down does not leave the board open');
  await page.keyboard.up('Tab');
});

test('simulation: 10 combatants play rounds out on their own; rounds end, nobody respawns mid-round, no friendly damage', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    g.restartMatch();
    const errors = [];
    const team = (id) => g.teamMatch.teamOf(id);
    // Every damaging hit on a bot, checked for friendly fire.
    for (const b of g.squad.bots) {
      const orig = b.combat.onDamage;
      b.combat.onDamage = (e) => {
        if (team(e.sourceId) === b.team) errors.push(`friendly damage ${e.sourceId} -> ${b.id}`);
        orig?.(e);
      };
    }
    const origPlayer = g.combat.onDamage;
    g.combat.onDamage = (e) => {
      if (team(e.sourceId) === 'blue') errors.push(`friendly damage ${e.sourceId} -> local`);
      origPlayer?.(e);
    };
    let lastAlive = null;
    let lastRound = 1;
    let frames = 0;
    let shots = 0;
    const shots0 = g.squad.bots.reduce((s, b) => s + b.weapons.shotsFired, 0);
    // Up to 4 rounds or 6 minutes of play.
    while (g.teamMatch.history.length < 4 && !g.teamMatch.over && frames < 60 * 360) {
      T.run(1);
      frames++;
      const tm = g.teamMatch;
      if (tm.round !== lastRound) {
        lastRound = tm.round;
        lastAlive = null;
      }
      const alive = g.teamAlive();
      if (tm.phase === 'live' && lastAlive && (alive.blue > lastAlive.blue || alive.red > lastAlive.red)) errors.push(`respawn in round ${tm.round}`);
      if (tm.phase === 'live') lastAlive = alive;
      if (tm.roundTimeLeft < 0) errors.push('negative clock');
      for (const b of g.squad.bots) if (b.mode === 'engage' && b.target && b.target.team === b.team) errors.push(`${b.id} targets teammate ${b.target.id}`);
    }
    shots = g.squad.bots.reduce((s, b) => s + b.weapons.shotsFired, 0) - shots0;
    const tm = g.teamMatch;
    const decided = tm.history.map((h) => {
      const consistent =
        h.reason === 'elimination'
          ? (h.alive.blue === 0) !== (h.alive.red === 0)
            ? h.winner === (h.alive.blue === 0 ? 'red' : 'blue')
            : h.winner === null
          : h.winner === (h.alive.blue === h.alive.red ? null : h.alive.blue > h.alive.red ? 'blue' : 'red');
      return { ...h, consistent };
    });
    const kills = [...tm.scores.values()].reduce((s, x) => s + x.kills, 0);
    const deaths = [...tm.scores.values()].reduce((s, x) => s + x.deaths, 0);
    return { frames, shots, errors: errors.slice(0, 10), decided, rounds: tm.history.length, wins: { ...tm.roundWins }, kills, deaths, feed: tm.feed.length };
  });
  assert.deepEqual(r.errors, []);
  assert.ok(r.rounds >= 3, `rounds decided: ${r.rounds} in ${(r.frames / 60).toFixed(0)} s`);
  for (const d of r.decided) assert.equal(d.consistent, true, JSON.stringify(d));
  assert.ok(r.shots > 50, `bots fought (${r.shots} rounds fired)`);
  assert.ok(r.decided.some((d) => d.reason === 'elimination'), 'at least one round ended by elimination');
  assert.equal(r.feed, r.deaths, 'one feed entry per death');
  assert.ok(r.kills <= r.deaths);
  assert.equal(r.wins.blue + r.wins.red, r.decided.filter((d) => d.winner).length);
});

test('modes stay separate: deathmatch and training come back unchanged, options do not overwrite each other', async () => {
  // Open the menu (as Esc does in play).
  await page.evaluate(() => document.exitPointerLock());
  await page.waitForFunction(() => !document.pointerLockElement);
  await page.click('#tab-play');
  const vis = await page.evaluate(() => ({ team: !document.querySelector('.team-options').hidden, ffa: !document.querySelector('.match-options').hidden }));
  assert.deepEqual(vis, { team: true, ffa: false });
  await page.selectOption('select[data-setting="round-time"]', '180');
  await page.selectOption('select[data-setting="rounds-to-win"]', '7');
  const teamCfg = await page.evaluate(() => ({ ...window.game.teamMatch.config }));
  assert.deepEqual([teamCfg.roundTime, teamCfg.roundsToWin], [180, 7]);

  await page.selectOption('select[data-setting="mode"]', 'deathmatch');
  const dm = await page.evaluate(() => {
    const g = window.game;
    return {
      bots: g.squad.bots.length,
      teams: g.squad.bots.map((b) => b.team ?? null),
      respawns: g.squad.respawns,
      ff: g.hitscan.friendlyFire,
      playerTeam: g.combat.team ?? null,
      weaponTeam: g.weapons.team ?? null,
      ffa: !!g.match,
      tm: g.teamMatch,
      hud: [document.querySelector('.match-hud:not(.team-hud)').hidden, document.querySelector('.team-hud').hidden],
      options: [document.querySelector('.match-options').hidden, document.querySelector('.team-options').hidden],
      timeLimit: g.match.config.timeLimit,
      killTarget: g.match.config.killTarget,
      stored: JSON.parse(localStorage.getItem('tactical-fps.match.v1')),
    };
  });
  assert.equal(dm.bots, 5);
  assert.deepEqual(dm.teams, [null, null, null, null, null]);
  assert.equal(dm.respawns, true, 'free-for-all keeps the 3 s respawn');
  assert.equal(dm.ff, true);
  assert.equal(dm.playerTeam, null);
  assert.equal(dm.weaponTeam, null);
  assert.equal(dm.ffa, true);
  assert.equal(dm.tm, null);
  assert.deepEqual(dm.hud, [false, true]);
  assert.deepEqual(dm.options, [false, true]);
  assert.deepEqual([dm.timeLimit, dm.killTarget], [600, 30], 'deathmatch options untouched by the team options');
  assert.deepEqual([dm.stored.mode, dm.stored.roundTime, dm.stored.roundsToWin, dm.stored.timeLimit, dm.stored.killTarget], ['deathmatch', 180, 7, 600, 30]);

  await page.selectOption('select[data-setting="kill-target"]', '10');
  await page.selectOption('select[data-setting="mode"]', 'training');
  const tr = await page.evaluate(() => ({ squad: window.game.squad, dummies: window.game.trainingRange?.targets.length, ff: window.game.hitscan.friendlyFire }));
  assert.deepEqual(tr, { squad: null, dummies: 5, ff: true });

  await page.selectOption('select[data-setting="mode"]', 'team');
  const back = await page.evaluate(() => ({ cfg: { ...window.game.teamMatch.config }, bots: window.game.squad.bots.length, stored: JSON.parse(localStorage.getItem('tactical-fps.match.v1')) }));
  assert.deepEqual([back.cfg.roundTime, back.cfg.roundsToWin, back.bots], [180, 7, 9], 'team options kept across the mode switches');
  assert.equal(back.stored.killTarget, 10, 'and the deathmatch change is kept too');
  assert.deepEqual(page.errors, []);
});
