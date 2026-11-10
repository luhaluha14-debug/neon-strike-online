// Bot aim balance (Phase 23), measured in the game (one bot, the player as
// its target, standing or strafing; see bot-aim.mjs). A bot reacts after a
// time that varies and is longer for easier bots; a strafing target is hit
// less than a standing one; a far one less than a near one; harder bots hit
// more. Seen as before: field of view, sight range and walls are untouched
// (a target behind a wall is never shot at), and weapon damage / recoil are
// the players' (weapon-balance golden).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, openGame, installFrameDriver } from './harness.mjs';
import { measureBotAim, oneBotMatch } from './bot-aim.mjs';

let env;
let page;

before(async () => {
  env = await startEnv();
  page = await oneBotMatch(env, openGame, installFrameDriver);
});
after(async () => {
  await page?.context().close();
  await env?.close();
});

const at = (rows, d, moving) => rows.find((r) => r.d === d && r.moving === moving);

test('per difficulty: reaction varies and is slower for easier bots; strafing and distance cost hits; harder bots hit more', async () => {
  const out = {};
  for (const diff of ['easy', 'normal', 'hard']) out[diff] = await measureBotAim(page, { distances: [10, 30], trials: 10, seconds: 4, difficulty: diff });
  console.log(`[bot balance] ${JSON.stringify(out)}`);
  for (const [diff, rows] of Object.entries(out)) {
    assert.ok(rows.every((r) => !r.none && r.engaged >= 8), `${diff}: every engagement ran (${JSON.stringify(rows)})`);
    // Enough shots for a hit rate to mean something (the line of fire stays clear for the whole strafe).
    assert.ok(rows.every((r) => r.shots >= 100), `${diff}: enough shots measured (${JSON.stringify(rows)})`);
    const near = at(rows, 10, false);
    assert.ok(at(rows, 10, true).hitRate < near.hitRate, `${diff}: a strafing target is hit less than a standing one at 10 m`);
    assert.ok(at(rows, 30, false).hitRate < near.hitRate, `${diff}: 30 m less than 10 m`);
    // Not instant and not robotic: the reaction differs from one engagement to the next.
    for (const r of rows) assert.ok(r.reactionMin >= 0.3, `${diff} ${r.d} m: no instant first shot (${r.reactionMin} s)`);
  }
  const rx = (diff) => at(out[diff], 10, false).reaction;
  assert.ok(rx('easy') > rx('normal') && rx('normal') > rx('hard'), `reaction easy ${rx('easy')} > normal ${rx('normal')} > hard ${rx('hard')}`);
  const hit = (diff) => at(out[diff], 10, false).hitRate;
  assert.ok(hit('hard') > hit('easy') + 0.1, `hard hits clearly more than easy at 10 m (${hit('hard')} vs ${hit('easy')})`);
  // Normal is a fair opponent: it hits a standing player at 10 m about half the time, a strafing one far less.
  assert.ok(hit('normal') > 0.3 && hit('normal') < 0.7, `normal at 10 m: ${hit('normal')}`);
  assert.ok(at(out.normal, 10, true).hitRate < 0.5, `normal vs a strafing player at 10 m: ${at(out.normal, 10, true).hitRate}`);
  assert.deepEqual(page.errors, []);
});

test('the reaction varies between engagements (not one fixed delay)', async () => {
  const rows = await page.evaluate(async () => {
    const bot = window.game.squad.bots[0];
    bot.setDifficulty('normal');
    const out = new Set();
    // The same acquisition many times: the reaction it draws.
    for (let i = 0; i < 20; i++) {
      bot['acquire']({ position: bot.position.clone().add(new bot.position.constructor(0, 0, -10)), height: 1.8 }, 10);
      out.add(Math.round(bot['reactionNeed'] * 100));
    }
    return [...out];
  });
  assert.ok(rows.length >= 8, `${rows.length} different reaction times in 20`);
});

test('no sight, no shot: a target behind a wall is never fired at, at any difficulty (held behind it: none; walking: only with a clear line)', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const V = g.camera.position.constructor;
    const col = g.map.collision;
    const bot = g.squad.bots[0];
    // A bot and a player 6 m apart with a wall between them.
    let pair = null;
    for (let k = 0; k < 8000 && !pair; k++) {
      const c = g.nav.randomCell();
      const p = g.nav.center(c);
      const a = Math.random() * Math.PI * 2;
      const q = new V(p.x + Math.sin(a) * 6, p.y, p.z + Math.cos(a) * 6);
      const down = col.raycast(new V(q.x, q.y + 1.5, q.z), new V(0, -1, 0), 3);
      if (down === null || Math.abs(down - 1.5) > 0.3) continue;
      // A solid wall: every line from where the bot's eye may be to any part of the player is blocked (no window, no gap).
      const side = new V(Math.cos(a), 0, -Math.sin(a));
      let blocked = true;
      for (const eh of [1.45, 1.6, 1.75])
        for (const so of [-0.35, 0, 0.35])
          for (let h = 0.2; h <= 1.95 && blocked; h += 0.15) {
            const eye = new V(p.x, p.y + eh, p.z).addScaledVector(side, so);
            const t = new V(q.x, q.y + h, q.z).addScaledVector(side, so);
            const d = t.clone().sub(eye);
            if (col.raycast(eye, d.clone().normalize(), d.length()) === null) blocked = false;
          }
      if (blocked) pair = { p, q, yaw: Math.atan2(-(q.x - p.x), -(q.z - p.z)) };
    }
    if (!pair) return { none: true };
    // Is any part of the player in a clear line from the bot's eye right now?
    const inSight = () => {
      const c = bot.controller;
      const eye = new V(c.position.x, c.position.y + c.eyeHeight, c.position.z);
      for (let h = 0.2; h <= 1.95; h += 0.15) {
        const d = new V(g.player.position.x, g.player.position.y + h, g.player.position.z).sub(eye);
        if (col.raycast(eye, d.clone().normalize(), d.length()) === null) return true;
      }
      return false;
    };
    const held = {};
    const blind = {};
    for (const diff of ['easy', 'normal', 'hard']) {
      bot.setDifficulty(diff);
      // Held where it stands (behind the wall): it never fires.
      bot.spawn(pair.p.clone(), pair.yaw);
      g.player.teleport(pair.q.clone(), 0);
      const pos = bot.controller.position.clone();
      let s = bot.weapons.shotsFired;
      const s0 = s;
      for (let i = 0; i < 240; i++) {
        g.player.position.copy(pair.q);
        bot.controller.position.copy(pos);
        bot.controller.velocity.set(0, 0, 0);
        window.T.run(1);
      }
      held[diff] = bot.weapons.shotsFired - s0;
      // Left free to walk (it may round the wall and then see the player): every shot it fires has a clear line.
      bot.spawn(pair.p.clone(), pair.yaw);
      g.player.teleport(pair.q.clone(), 0);
      s = bot.weapons.shotsFired;
      blind[diff] = 0;
      for (let i = 0; i < 240; i++) {
        g.player.position.copy(pair.q);
        window.T.run(1);
        if (bot.weapons.shotsFired > s && !inSight()) blind[diff] += bot.weapons.shotsFired - s;
        s = bot.weapons.shotsFired;
      }
    }
    return { held, blind };
  });
  assert.notEqual(r.none, true, 'found a spot with a wall between');
  assert.deepEqual(r.held, { easy: 0, normal: 0, hard: 0 }, 'held behind the wall: no shot');
  assert.deepEqual(r.blind, { easy: 0, normal: 0, hard: 0 }, 'walking: no shot without a clear line to the player');
});
