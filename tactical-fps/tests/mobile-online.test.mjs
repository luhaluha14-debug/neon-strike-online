// PC and phone in one room (Phase 22): the real relay, a PC browser (mouse,
// keyboard) and a phone (Playwright's mobile emulation, real multi-touch).
// The same rooms on the same server: the phone joins a PC's room with taps,
// moves with the stick and fires with the fire button; the host (the PC)
// sees the phone's character move, takes its rounds and credits its kill;
// the phone sees the host's damage on its own health. A phone can host too,
// and a PC joins it. A phone's connection drops and it rejoins. Nothing is
// different for a touch player on the host: same rules, no aim help.
// Headless Chromium, not real devices.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { startEnv, openGame, ROOT } from './harness.mjs';
import { fingers, centre } from './mobile-touch.mjs';

let vite;
let relay;
let env;

before(async () => {
  vite = await createServer({ root: ROOT, logLevel: 'error', server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom' });
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

/** A phone taps through the multiplayer page and joins room `code` (typing on the on-screen keyboard is a fill). */
async function phoneJoins(phone, name, code) {
  await phone.tap('#tab-multi');
  await phone.fill('.mp-name', name);
  await phone.fill('.mp-code', code);
  await phone.tap('.mp-join-btn');
  await phone.waitForFunction(() => window.game.netClient?.myId && window.game.match);
}

test('11, 12, 13: a phone in a PC’s room: joins with taps, moves, fires and kills by touch; the PC host sees and credits it; host hits reach the phone; a phone hosts and a PC joins; drop and rejoin', async () => {
  const pc = await openGame(env, { mode: 'deathmatch', width: 640, height: 360 });
  const phone = await openGame(env, { mode: 'training', width: 740, height: 360, mobile: true });
  for (const p of [pc, phone]) p.setDefaultTimeout(60000);
  try {
    // The PC creates a deathmatch room (mouse and keyboard, as before).
    await pc.click('#tab-multi');
    await pc.fill('.mp-name', 'PC');
    await pc.selectOption('.mp-mode', 'deathmatch');
    await pc.click('.mp-create');
    await pc.waitForFunction(() => window.game.netHost && window.game.match);
    const code = (await pc.textContent('.mp-room-code')).trim();
    await phoneJoins(phone, 'Phone', code);
    assert.equal(await phone.evaluate(() => document.documentElement.classList.contains('touch')), true);
    // Into the match: the phone taps 플레이 (touch controls), the PC clicks (pointer lock).
    await phone.tap('#tab-play');
    await phone.tap('.play-button');
    await phone.waitForFunction(() => window.game.input.active && !document.querySelector('.touch-ui').hidden);
    await pc.click('#tab-play');
    await pc.click('.play-button');
    await pc.waitForFunction(() => window.game.input.active);
    const seat = await pc.evaluate(() => {
      const g = window.game;
      g.match.config.killTarget = 1000;
      g.squad.respawns = false;
      g.combat.protection = 1e9;
      for (const b of g.squad.bots) b.combat.protection = 1e9;
      return g.squad.bots.find((b) => b.remote).id;
    });
    // The phone's spawn protection runs out before it fires (shots from a protected player still count, but keep it plain).
    await phone.waitForTimeout(500);
    const where = () => pc.evaluate((id) => (({ x, z }) => ({ x, z }))(window.game.squad.bots.find((b) => b.id === id).position), seat);

    // Move: the stick forward for a second; the host sees the phone's character go.
    const f = await fingers(phone);
    const p0 = await where();
    await f.start(1, 120, 250);
    await f.move(1, 120, 170, 4);
    await phone.waitForTimeout(1200);
    await f.end(1);
    await phone.waitForTimeout(400);
    const p1 = await where();
    const moved = Math.hypot(p1.x - p0.x, p1.z - p0.z);
    assert.ok(moved > 1, `the host saw the phone move ${moved.toFixed(2)} m`);

    // Fire: an AI bot is put right in front of where the phone looks (its own view, level); the phone holds fire.
    const yaw = await phone.evaluate(() => {
      window.game.player.pitch = 0;
      return window.game.player.yaw;
    });
    await pc.evaluate(([id, yaw]) => {
      const g = window.game;
      const s = g.squad.bots.find((b) => b.id === id);
      const target = g.squad.bots.find((b) => !b.remote && b.alive);
      const at = s.position.clone().add(new s.position.constructor(-Math.sin(yaw) * 3, 0, -Math.cos(yaw) * 3));
      target.spawn(at, yaw + Math.PI);
      target.combat.protection = 0;
      target.order = null;
      window.__target = target.id;
      // Every round of the phone the host resolves (its own hitscan, its rules).
      window.__hostShots = 0;
      const seen = g.showNetShot.bind(g);
      g.showNetShot = (bot, ...a) => {
        if (bot.id === id) window.__hostShots++;
        return seen(bot, ...a);
      };
    }, [seat, yaw]);
    const fire = await centre(phone, '.tc-fire');
    const mag0 = await phone.evaluate(() => window.game.weapons.weapon.magazine);
    await f.start(3, fire.x, fire.y);
    await pc.waitForFunction((t) => !window.game.squad.bots.find((b) => b.id === t).alive, await pc.evaluate(() => window.__target), { timeout: 20000 }).catch(() => {});
    await f.end(3);
    const shot = await pc.evaluate((id) => ({ shots: window.__hostShots, kills: window.game.match.scores.get(id).kills, alive: window.game.squad.bots.find((b) => b.id === window.__target).alive }), seat);
    const mag1 = await phone.evaluate(() => window.game.weapons.weapon.magazine);
    assert.ok(mag1 < mag0, `the phone fired (${mag0} → ${mag1})`);
    assert.ok(shot.shots > 0, `the host resolved the phone's rounds (${shot.shots})`);
    assert.equal(shot.alive, false, 'the target in front went down');
    assert.equal(shot.kills, 1, 'the host credited the phone’s seat');
    await phone.waitForFunction(() => window.game.match.scores.get('local')?.kills === 1);
    await phone.waitForTimeout(300);
    assert.equal(await phone.textContent('.combat-stats .cs-kills'), '1', 'the phone’s HUD shows its kill');

    // The host hurts the phone: the phone's health follows the host.
    await pc.evaluate((id) => {
      const s = window.game.squad.bots.find((b) => b.id === id);
      s.combat.protection = 0;
      s.combat.applyDamage({ amount: 35, zone: 'body', sourceId: 'local', weaponId: 'ar01', point: s.position.clone(), direction: s.position.clone().set(1, 0, 0), distance: 10 });
    }, seat);
    await phone.waitForFunction(() => window.game.combat.health <= 65, null, { timeout: 10000 });

    // The phone's connection drops; it rejoins the same room with taps.
    await phone.evaluate(() => window.game.input.release());
    await phone.tap('.menu-lobby');
    await phone.evaluate(() => window.game.net.ws.close());
    await phone.waitForFunction(() => !window.game.net);
    await phone.tap('.lobby [data-lobby="multi"]');
    await phone.tap('.mp-rejoin');
    await phone.waitForFunction(() => window.game.netClient?.myId && window.game.match);
    await pc.waitForFunction(() => window.game.squad.bots.some((b) => b.remote));
    assert.equal(await phone.evaluate(() => window.game.input.touch.fingerCount), 0, 'no input left over from before the drop');
    assert.deepEqual(phone.errors, []);
    assert.deepEqual(pc.errors, []);
  } finally {
    await pc.context().close();
    await phone.context().close();
  }

  // A phone hosts a team room; a PC joins it.
  const host = await openGame(env, { mode: 'team', objective: 'elimination', width: 740, height: 360, mobile: true });
  const guest = await openGame(env, { mode: 'team', objective: 'elimination', width: 640, height: 360 });
  for (const p of [host, guest]) p.setDefaultTimeout(60000);
  try {
    await host.tap('#tab-multi');
    await host.fill('.mp-name', 'PhoneHost');
    await host.selectOption('.mp-mode', 'team');
    await host.tap('.mp-quick');
    await host.waitForSelector('.mp-room:not([hidden])');
    const code = (await host.textContent('.mp-room-code')).trim();
    await guest.click('#tab-multi');
    await guest.fill('.mp-name', 'PCGuest');
    await guest.fill('.mp-code', code.toLowerCase());
    await guest.click('.mp-join-btn');
    await guest.waitForFunction(() => window.game.netClient?.myId && window.game.teamMatch);
    await host.waitForFunction(() => window.game.squad?.bots.some((b) => b.remote));
    const both = await Promise.all([host, guest].map((p) => p.evaluate(() => ({ round: window.game.teamMatch.round, phase: window.game.teamMatch.phase, members: document.querySelectorAll('.mp-members li').length }))));
    assert.equal(both[0].round, both[1].round);
    assert.ok(both[0].members === 2, 'the phone host lists both players');
    assert.deepEqual([...host.errors, ...guest.errors], []);
  } finally {
    await host.context().close();
    await guest.context().close();
  }
});
