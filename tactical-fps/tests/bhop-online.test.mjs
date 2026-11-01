// Bunny hopping online: two real game pages through the real relay. The
// host checks every member report against its real clock: a member hopping
// at the air speed limit (9 m/s) for two seconds is accepted all the way
// (no correction, no snapping back) and its character follows on the host,
// airborne while the report says so; a member reporting moves or a velocity
// beyond any reachable speed (a speed hack) is refused and put back where
// the host has it; the host player's jump shows on the member as airborne.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { startEnv, openGame, installFrameDriver, ROOT } from './harness.mjs';

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

async function lobby(page, name, mode) {
  await page.click('#tab-multi');
  await page.fill('.mp-name', name);
  if (mode) await page.selectOption('.mp-mode', mode);
}

async function play(page) {
  await page.click('#tab-play');
  await page.click('.play-button');
  await page.waitForFunction(() => window.game.input.active);
}

test('deathmatch: hops at the air speed limit are accepted in real time; faster moves and velocities are refused; jump state reaches the other side', async () => {
  const host = await openGame(env, { mode: 'deathmatch', width: 480, height: 270 });
  const guest = await openGame(env, { mode: 'training', width: 480, height: 270 });
  for (const p of [host, guest]) p.setDefaultTimeout(60000);
  try {
    await lobby(host, 'Alpha', 'deathmatch');
    await host.click('.mp-quick');
    await host.waitForSelector('.mp-room:not([hidden])');
    const code = await host.textContent('.mp-room-code');
    await lobby(guest, 'Bravo');
    await guest.fill('.mp-code', code.toLowerCase());
    await guest.click('.mp-join-btn');
    await guest.waitForFunction(() => window.game.netClient?.myId && window.game.match);
    await host.waitForFunction(() => document.querySelectorAll('.mp-members li').length === 2);
    const botId = await host.evaluate(() => window.game.squad.bots.find((b) => b.remote).id);
    await play(host);
    await play(guest);
    // Both pages driven frame by frame (software WebGL is too slow to run freely); messages flow in real time.
    for (const p of [host, guest]) {
      await installFrameDriver(p);
      await p.evaluate(() => window.T.stopLoop());
    }
    // Quiet range: the AI bots out, the guest's character fresh where it stands.
    await host.evaluate(() => {
      const g = window.game;
      g.squad.respawns = false;
      for (const b of g.squad.bots) if (!b.remote) b.combat.applyDamage({ amount: 999, zone: 'body', sourceId: 'test', weaponId: 'test', point: b.position.clone(), direction: b.position.clone().set(0, 0, 1), distance: 1 });
      g.combat.reset();
      g.combat.protection = 0;
      const mine = g.squad.bots.find((b) => b.remote);
      mine.spawn(mine.position.clone().setY(mine.position.y - 0.1), mine.controller.yaw);
    });
    await guest.waitForFunction(() => window.game.combat.alive && window.game.combat.health === 100);
    const settle = async () => {
      await guest.waitForTimeout(250);
      await host.evaluate(() => window.T.run(6));
      await guest.waitForTimeout(250);
      await guest.evaluate(() => window.T.run(3));
    };
    await settle();

    // The guest's own reports are replaced by scripted ones (its frames send none from here: no T.run on it).
    await guest.evaluate(() => {
      const g = window.game;
      window.__report = (p, v, grounded) =>
        g.net.send({ k: 'st', sp: g.netClient.spawnSeq, p, v, yaw: 0, pitch: 0, h: 1.8, g: grounded ? 1 : 0, crouch: 0, aim: 0, use: 0, w: g.netWeaponId });
    });
    /**
     * Reports a hop session at `speed` m/s along +x for `seconds` of real time, a report every
     * ~50 ms (the game's own rate) with the host stepping in between. `latency(i)`: how old (s)
     * report i is when it goes out (network delay varying from report to report: jitter).
     * Returns what the host did.
     */
    const session = async (speed, seconds, velocity = speed, latency = () => 0) => {
      const start = await host.evaluate((id) => window.game.squad.bots.find((b) => b.id === id).position.toArray(), botId);
      const seq = await guest.evaluate(() => window.game.netClient.spawnSeq);
      // Anchor: one report where the host has the character, accepted now.
      await guest.evaluate((p) => window.__report(p, [0, 0, 0], true), start);
      await guest.waitForTimeout(60);
      await host.evaluate(() => window.T.run(1));
      const t0 = Date.now();
      let last = start;
      let airborneSeen = 0;
      let groundedSeen = 0;
      let reports = 0;
      let tp = 0;
      while (Date.now() - t0 < seconds * 1000) {
        await guest.waitForTimeout(50);
        // Reports arrive in order, each as old as the delay it met on the way.
        tp = Math.max(tp, (Date.now() - t0) / 1000 - latency(reports));
        const t = tp;
        // Hops of ~0.58 s: in the air most of the time, a tick on the ground at each landing.
        const grounded = t % 0.58 < 0.05;
        last = [start[0] + speed * t, start[1] + (grounded ? 0 : 0.4), start[2]];
        await guest.evaluate(({ p, v, g }) => window.__report(p, v, g), { p: last, v: [velocity, grounded ? 0 : 1, 0], g: grounded });
        reports++;
        await guest.waitForTimeout(10);
        const h = await host.evaluate((id) => {
          window.T.run(1);
          const c = window.game.squad.bots.find((b) => b.id === id).controller;
          return { p: c.position.toArray(), grounded: c.grounded };
        }, botId);
        if (h.grounded) groundedSeen++;
        else airborneSeen++;
        if ((await guest.evaluate(() => window.game.netClient.spawnSeq)) > seq) return { corrected: true, reports, start, last, host: h.p };
      }
      await guest.waitForTimeout(250);
      await host.evaluate(() => window.T.run(1));
      const corrected = (await guest.evaluate(() => window.game.netClient.spawnSeq)) > seq;
      const onHost = await host.evaluate((id) => window.game.squad.bots.find((b) => b.id === id).position.toArray(), botId);
      return { corrected, reports, start, last, host: onHost, airborneSeen, groundedSeen };
    };

    // 1) Two seconds at the air speed limit: every report accepted, the host's character where the guest says.
    const ok = await session(9, 2);
    assert.equal(ok.corrected, false, `hopping at 9 m/s was refused after ${ok.reports} reports`);
    assert.ok(ok.reports >= 20, `reports sent (${ok.reports})`);
    assert.ok(Math.hypot(ok.host[0] - ok.last[0], ok.host[2] - ok.last[2]) < 0.05, `the host has the character at the last report (${ok.host} vs ${ok.last})`);
    assert.ok(ok.host[0] - ok.start[0] > 15, `moved ${(ok.host[0] - ok.start[0]).toFixed(2)} m on the host`);
    assert.ok(ok.airborneSeen > 0 && ok.groundedSeen >= 0, `the host had the character airborne (${ok.airborneSeen} of ${ok.reports})`);

    // 1b) Jitter: the delay swings between 20 and 220 ms from one report to the next (the worst
    //     case: each fast report right after a slow one), then varies at random in that range.
    const swing = await session(9, 4, 9, (i) => (i % 2 ? 0.02 : 0.22));
    assert.equal(swing.corrected, false, `hopping at 9 m/s with 200 ms jitter was refused after ${swing.reports} reports`);
    let seed = 3;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const random = await session(9, 4, 9, () => 0.02 + rnd() * 0.2);
    assert.equal(random.corrected, false, `hopping at 9 m/s with random 20-220 ms delays was refused after ${random.reports} reports`);
    assert.ok(Math.hypot(random.host[0] - random.last[0], random.host[2] - random.last[2]) < 0.05, 'the host has the character at the last report');

    // 2) Moving 13 m/s for two seconds (velocity reported honestly at the limit): refused, put back.
    const far = await session(13, 2, 9);
    assert.equal(far.corrected, true, 'moving at 13 m/s was accepted');
    await guest.evaluate(() => window.T.run(1));
    const back = await guest.evaluate(() => window.game.player.position.toArray());
    assert.ok(Math.hypot(back[0] - far.host[0], back[2] - far.host[2]) < 0.6, `the correction put the guest where the host has it (${back} vs ${far.host})`);

    // 3) A velocity past any reachable speed, without moving far: refused at once.
    const seq = await guest.evaluate(() => window.game.netClient.spawnSeq);
    const at = await host.evaluate((id) => window.game.squad.bots.find((b) => b.id === id).position.toArray(), botId);
    await guest.evaluate((p) => window.__report(p, [13, 0, 0], false), [at[0] + 0.1, at[1], at[2]]);
    await settle();
    assert.ok((await guest.evaluate(() => window.game.netClient.spawnSeq)) > seq, 'a 13 m/s velocity was accepted');
    const kept = await host.evaluate((id) => window.game.squad.bots.find((b) => b.id === id).position.toArray(), botId);
    assert.ok(Math.hypot(kept[0] - at[0], kept[2] - at[2]) < 0.05, 'the host kept the character where it was');

    // 4) The host player's jump: the member's view of it is airborne, then grounded again.
    const hostWire = await host.evaluate(() => window.game.net.id);
    const flagsOnGuest = async () => {
      await guest.waitForTimeout(120);
      return guest.evaluate((w) => window.game.netClient.puppets.all.get(w)?.samples.at(-1)?.e[9], hostWire);
    };
    await host.evaluate(() => window.T.run(30));
    await guest.waitForTimeout(150);
    assert.equal((await flagsOnGuest()) & 2, 2, 'the host shows grounded before the jump');
    await host.evaluate(() => {
      const p = window.game.player;
      p.velocity.y = 5.2;
      p.grounded = false;
      window.T.run(6);
    });
    assert.equal((await flagsOnGuest()) & 2, 0, 'the host shows airborne mid-jump');
    await host.evaluate(() => window.T.run(60));
    assert.equal((await flagsOnGuest()) & 2, 2, 'the host shows grounded after landing');
    assert.deepEqual(host.errors, []);
    assert.deepEqual(guest.errors, []);
  } finally {
    await host.context().close();
    await guest.context().close();
  }
});
