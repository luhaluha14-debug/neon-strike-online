// Bot deathmatch: nav grid, bots that move / see / shoot under the same
// combat rules as the player, kills and deaths, match end and restart.
// Frames are driven at fixed 1/60 s with the real frame loop stopped.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, openGame, installFrameDriver } from './harness.mjs';

let env;
let page;
before(async () => {
  env = await startEnv();
  page = await openGame(env, { map: 'warehouse', mode: 'deathmatch' });
  await page.click('.play-button');
  await page.waitForFunction(() => !!document.pointerLockElement && document.querySelector('.hud').classList.contains('playing'));
  await page.mouse.move(0, 0);
  await installFrameDriver(page);
  await page.evaluate(async () => {
    window.T.stopLoop();
    const g = window.game;
    const { Line3 } = await import('/node_modules/three/build/three.module.js');
    const V = g.player.position.constructor;
    window.T.V = V;
    const seg = new Line3();
    /** Inside the play area, and (a slightly slimmer) standing capsule not inside map geometry. */
    window.T.botOk = (b) => {
      const p = b.position;
      const pb = g.map.playBounds;
      const inside = p.x > pb.min.x - 0.5 && p.x < pb.max.x + 0.5 && p.z > pb.min.z - 0.5 && p.z < pb.max.z + 0.5 && p.y > g.mapDef.killPlaneY;
      const r = 0.3;
      seg.start.set(p.x, p.y + r + 0.06, p.z);
      seg.end.set(p.x, p.y + b.height - r, p.z);
      return { inside, inWall: g.map.collision.capsuleOverlaps(seg, r) };
    };
  });
});
after(async () => {
  await page?.context().close();
  await env?.close();
});

test('setup: nav grid over the map, 5 bots registered with the hitscan, a fresh match', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    return {
      mode: g.mode,
      cells: g.nav.walkable.length,
      bots: g.squad.bots.length,
      registered: [...g.hitscan.targets].filter((t) => t.id.startsWith('bot-')).length,
      players: g.match.scores.size,
      onWalkable: g.squad.bots.every((b) => g.nav.nearestWalkable(b.position) >= 0),
      dummies: g.trainingRange,
      timeLeft: g.match.timeLeft,
      killTarget: g.match.config.killTarget,
    };
  });
  assert.equal(r.mode, 'deathmatch');
  assert.ok(r.cells > 1000, `${r.cells} walkable cells`);
  assert.deepEqual([r.bots, r.registered, r.players], [5, 5, 6]);
  assert.equal(r.onWalkable, true);
  assert.equal(r.dummies, null, 'no training dummies in a match');
  // (The real loop may have run a few frames after Play before the test took over the frames.)
  assert.ok(r.timeLeft <= 600 && r.timeLeft > 595, `time left ${r.timeLeft}`);
  assert.equal(r.killTarget, 30);
});

test('bots see only what is in the open: no engagement through a wall, engagement in the open', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const V = window.T.V;
    const nav = g.nav;
    const col = g.map.collision;
    const bot = g.squad.bots[0];
    // Others out of the way (far corner, dead) so only the player matters.
    for (const b of g.squad.bots.slice(1)) b.combat.applyDamage({ amount: 999, zone: 'body', sourceId: 'test', weaponId: 'test', point: b.position, direction: new V(0, 0, 1), distance: 1 });
    let wall = null;
    let open = null;
    for (let k = 0; k < 4000 && (!wall || !open); k++) {
      const a = nav.center(nav.randomCell());
      const b = nav.center(nav.randomCell());
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      if (d < 6 || d > 25 || Math.abs(a.y - b.y) > 0.3) continue;
      // Only pairs where the line at 1.6 m and the bot's own sight line (its eye to the
      // player's chest) agree: low cover can block one and not the other.
      const sight = (h0, h1) => {
        const from = new V(a.x, a.y + h0, a.z);
        const dir = new V(b.x, b.y + h1, b.z).sub(from);
        const len = dir.length();
        return col.raycast(from, dir.normalize(), len) !== null;
      };
      const blocked = sight(1.6, 1.6);
      if (blocked !== sight(0.1 + bot.controller.eyeHeight, 1.8 * 0.8)) continue;
      if (blocked && !wall) wall = [a, b];
      if (!blocked && !open) open = [a, b];
    }
    const trial = ([a, b]) => {
      bot.spawn(a, 0);
      bot.combat.protection = 0;
      bot.controller.yaw = Math.atan2(-(b.x - a.x), -(b.z - a.z));
      g.player.teleport(b.clone().setY(b.y + 0.1), 0);
      g.combat.reset();
      g.combat.protection = 99; // the player must not die during the check
      bot.mode = 'wander';
      bot.target = null;
      // Perception only: the bot is held on its spot (it would otherwise start walking a
      // new route and could step out from behind the wall within these 0.33 s).
      for (let i = 0; i < 40; i++) {
        bot.step(1 / 120, [{ id: 'local', alive: true, position: g.player.position, height: 1.8 }], [bot]);
        bot.controller.position.set(a.x, a.y + 0.1, a.z);
        bot.controller.velocity.set(0, 0, 0);
      }
      return bot.mode;
    };
    return { found: !!wall && !!open, behindWall: trial(wall), inOpen: trial(open) };
  });
  assert.equal(r.found, true);
  assert.notEqual(r.behindWall, 'engage', 'a wall hides the player');
  assert.equal(r.inOpen, 'engage', 'the player in the open is engaged');
  await page.evaluate(() => {
    window.game.combat.protection = 0;
    window.game.restartMatch();
  });
});

test('60 s of play: bots move without getting stuck in walls, fight with AR-01 damage, kills are counted', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    g.restartMatch();
    const hits = [];
    g.combat.onDamage = ((orig) => (e) => {
      hits.push({ amount: e.amount, weapon: e.weaponId, source: e.sourceId, zone: e.zone });
      orig(e);
    })(g.combat.onDamage);
    const dist = g.squad.bots.map(() => 0);
    const last = g.squad.bots.map((b) => b.position.clone());
    let outside = 0;
    let overlap = 0;
    for (let s = 0; s < 60; s++) {
      T.run(60);
      g.squad.bots.forEach((b, i) => {
        dist[i] += Math.hypot(b.position.x - last[i].x, b.position.z - last[i].z);
        last[i].copy(b.position);
        const { inside, inWall } = T.botOk(b);
        if (!inside) outside++;
        if (b.alive && inWall) overlap++;
      });
    }
    return {
      dist: dist.map((d) => Math.round(d)),
      outside,
      overlap,
      feed: g.match.feed.length,
      kills: g.match.ranking.reduce((s, x) => s + x.kills, 0),
      deaths: g.match.ranking.reduce((s, x) => s + x.deaths, 0),
      hits,
      over: g.match.over,
    };
  });
  for (const d of r.dist) assert.ok(d > 15, `every bot moves (${r.dist})`);
  assert.equal(r.outside, 0, 'no bot leaves the map');
  assert.equal(r.overlap, 0, 'no bot inside a wall (300 samples)');
  assert.ok(r.feed >= 3, `kills happened: ${r.feed}`);
  // Every feed entry is a death; kills exclude self-inflicted ones.
  assert.equal(r.deaths, r.feed);
  assert.ok(r.kills <= r.deaths);
  // Bot hits on the player: AR-01 rounds through the normal damage table (24 body / 19 limb / 102 head, less with falloff).
  for (const h of r.hits) {
    assert.equal(h.weapon, 'ar01');
    assert.match(h.source, /^bot-/);
    const max = { head: 102, body: 24, limb: 19 }[h.zone];
    assert.ok(h.amount <= max && h.amount >= max * 0.8 - 1, JSON.stringify(h));
  }
});

test('CS-style firing: bots stop (counter-strafe) before shooting, no run-and-gun spraying', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    g.restartMatch();
    // Record each bot's ground speed at the moment a round leaves the barrel.
    const speeds = [];
    for (const b of g.squad.bots) {
      const ev = b.weapons.events;
      const orig = ev.onShot;
      ev.onShot = (...a) => {
        speeds.push({ v: Math.hypot(b.controller.velocity.x, b.controller.velocity.z), grounded: b.controller.grounded });
        orig?.(...a);
      };
    }
    T.run(60 * 40);
    return speeds;
  });
  assert.ok(r.length >= 20, `bots fought (${r.length} rounds)`);
  for (const s of r) {
    assert.ok(s.v < 1.2, `round fired while moving at ${s.v.toFixed(2)} m/s`);
    assert.ok(s.grounded, 'round fired in the air');
  }
});

test('the player kills a bot through the normal hitscan: kill credited, bot respawns 3 s later', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    const V = T.V;
    g.restartMatch();
    // Right after the restart (no frames run, so no other bot can have shot it yet), with its spawn protection over.
    const bot = g.squad.bots[0];
    bot.combat.protection = 0;
    const head = new V(bot.position.x, bot.position.y + bot.height - 0.1, bot.position.z);
    // Shoot from 1.5 m away, from a side with no wall in between (it may have spawned right behind cover).
    let dir = null;
    for (let k = 0; k < 16 && !dir; k++) {
      const a = (k / 16) * Math.PI * 2;
      const d = new V(Math.sin(a), 0, Math.cos(a));
      if (g.map.collision.raycast(head.clone().addScaledVector(d, -1.5), d, 1.5) === null) dir = d;
    }
    const origin = head.clone().addScaledVector(dir, -1.5);
    const res = g.hitscan.fire({ origin, direction: dir, damage: g.weapons.loadout[1].def.damage, sourceId: 'local', weaponId: 'sr01' });
    const after = { kind: res.kind, id: res.target?.id, alive: bot.alive, kills: g.match.scores.get('local').kills, deaths: g.match.scores.get(bot.id).deaths, feed: g.match.feed.at(-1) };
    T.run(185);
    return { ...after, aliveLater: bot.alive, health: bot.combat.health, onGrid: g.nav.nearestWalkable(bot.position) >= 0 };
  });
  assert.equal(r.kind, 'target');
  assert.equal(r.id, 'bot-1');
  assert.equal(r.alive, false);
  assert.equal(r.kills, 1);
  assert.equal(r.deaths, 1);
  assert.deepEqual([r.feed.killer, r.feed.victim, r.feed.weaponId], ['local', 'bot-1', 'sr01']);
  assert.equal(r.aliveLater, true, 'respawned after 3 s');
  assert.equal(r.health, 100);
  assert.equal(r.onGrid, true);
});

test('HUD: timer and kills shown; Tab shows the scoreboard', async () => {
  await page.evaluate(() => window.T.run(10));
  const bar = await page.evaluate(() => ({ time: document.querySelector('.mb-time').textContent, kills: document.querySelector('.mb-kills').textContent, visible: !document.querySelector('.match-hud').hidden }));
  assert.equal(bar.visible, true);
  assert.match(bar.time, /^\d+:\d\d$/);
  assert.match(bar.kills, /^\d+ \/ 30 킬$/);
  await page.keyboard.down('Tab');
  await page.evaluate(() => window.T.run(2));
  const board = await page.evaluate(() => ({ shown: !document.querySelector('.scoreboard').hidden, rows: document.querySelectorAll('.scoreboard tbody tr').length }));
  await page.keyboard.up('Tab');
  assert.deepEqual(board, { shown: true, rows: 6 });
});

test('Tab board: held = open, released = closed (also after key repeat and quick taps); a release lost to a focus change or Alt/Cmd+Tab never leaves it open; hidden = not drawn', async () => {
  const shown = async () => {
    await page.evaluate(() => window.T.run(1));
    return page.evaluate(() => !document.querySelector('.match-hud .scoreboard').hidden);
  };
  const key = (type, init) => page.evaluate(([type, init]) => window.dispatchEvent(new KeyboardEvent(type, { code: 'Tab', key: 'Tab', ...init })), [type, init]);
  await page.keyboard.down('Tab');
  assert.equal(await shown(), true, 'held');
  for (let i = 0; i < 5; i++) await key('keydown', { repeat: true });
  assert.equal(await shown(), true, 'auto-repeat keeps it open');
  await page.keyboard.up('Tab');
  assert.equal(await shown(), false, 'released');
  for (let i = 0; i < 6; i++) await page.keyboard.press('Tab');
  assert.equal(await shown(), false, 'quick taps end closed');
  // Focus leaves while Tab is down (another window, a system dialog): the key-up never arrives.
  await key('keydown');
  assert.equal(await shown(), true);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  assert.equal(await shown(), false, 'closed on focus loss, not stuck open');
  await key('keydown');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    delete document.hidden;
  });
  assert.equal(await shown(), false, 'closed when the tab is hidden');
  // Alt+Tab / Cmd+Tab switch windows (their key-up is never delivered): no board.
  await key('keydown', { altKey: true });
  assert.equal(await shown(), false);
  await key('keydown', { metaKey: true });
  assert.equal(await shown(), false);
  // Movement keys keep working with the board open.
  await page.keyboard.down('Tab');
  await page.keyboard.down('KeyW');
  const move = await page.evaluate(() => {
    window.T.run(3);
    return { board: !document.querySelector('.match-hud .scoreboard').hidden, forward: window.game.input.keys.has('KeyW') };
  });
  await page.keyboard.up('KeyW');
  await page.keyboard.up('Tab');
  assert.deepEqual(move, { board: true, forward: true });
  // Hidden means not drawn at all (no empty panel left on screen).
  const drawn = () => page.evaluate(() => {
    window.T.run(1);
    const r = document.querySelector('.match-hud:not(.team-hud) .scoreboard').getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  assert.equal(await drawn(), false, 'released: nothing drawn');
  await page.keyboard.down('Tab');
  await page.evaluate(() => window.T.run(1));
  assert.equal(await drawn(), true, 'held: drawn');
  await page.keyboard.up('Tab');
  await page.evaluate(() => window.T.run(1));
  assert.equal(await drawn(), false, 'released again: nothing drawn');
});

test('kill target reached: match over, results, mouse released; restart gives a fresh match', async () => {
  await page.evaluate(() => {
    const g = window.game;
    for (let i = 0; i < 30; i++) g.match.recordKill('local', 'bot-2', 'ar01', false);
    window.T.run(2);
  });
  await page.waitForFunction(() => !document.pointerLockElement);
  const res = await page.evaluate(() => ({
    over: window.game.match.over,
    reason: window.game.match.endReason,
    shown: !document.querySelector('.results').hidden,
    title: document.querySelector('.results-title').textContent,
    rows: document.querySelectorAll('.results-table tbody tr').length,
  }));
  assert.deepEqual(res, { over: true, reason: 'kills', shown: true, title: '승리', rows: 6 });
  // Frozen while over: time does not run.
  const t0 = await page.evaluate(() => window.game.match.timeLeft);
  await page.click('.results-restart');
  await page.waitForFunction(() => !!document.pointerLockElement && document.querySelector('.hud').classList.contains('playing'));
  await page.evaluate(() => window.T.run(30));
  const fresh = await page.evaluate(() => ({
    over: window.game.match.over,
    kills: window.game.match.ranking.reduce((s, x) => s + x.kills, 0),
    shown: !document.querySelector('.results').hidden,
    timeLeft: window.game.match.timeLeft,
    health: window.game.player.health,
  }));
  assert.equal(fresh.over, false);
  assert.equal(fresh.shown, false);
  assert.ok(fresh.timeLeft < 600 && fresh.timeLeft > 599, `timer restarted (${fresh.timeLeft}, was ${t0})`);
  assert.equal(fresh.health, 100);
});

test('time limit: the match ends when the clock runs out; losing shows 패배', async () => {
  await page.evaluate(() => {
    const g = window.game;
    g.match.recordKill('bot-3', 'local', 'ar01', false);
    g.match.timeLeft = 0.2;
    window.T.run(20);
  });
  await page.waitForFunction(() => !document.pointerLockElement);
  const r = await page.evaluate(() => ({ over: window.game.match.over, reason: window.game.match.endReason, title: document.querySelector('.results-title').textContent }));
  assert.deepEqual(r, { over: true, reason: 'time', title: '패배' });
  await page.click('.results-menu');
  assert.equal(await page.evaluate(() => document.querySelector('.results').hidden), true);
});

test('menu: switching to the training ground removes the bots and brings the dummies back', async () => {
  await page.click('#tab-play');
  await page.selectOption('select[data-setting="mode"]', 'training');
  const t = await page.evaluate(() => ({ squad: window.game.squad, dummies: window.game.trainingRange?.targets.length, hud: document.querySelector('.match-hud').hidden, botsInHitscan: [...window.game.hitscan.targets].filter((x) => x.id.startsWith('bot-')).length }));
  assert.deepEqual(t, { squad: null, dummies: 5, hud: true, botsInHitscan: 0 });
  await page.selectOption('select[data-setting="mode"]', 'deathmatch');
  assert.equal(await page.evaluate(() => window.game.squad.bots.length), 5);
  assert.deepEqual(page.errors, []);
});
