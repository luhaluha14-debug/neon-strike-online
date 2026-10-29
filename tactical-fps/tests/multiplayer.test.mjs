// Multiplayer end to end: two (three) real game pages through the real relay
// (server/mp behind the dev server's /mp proxy). Room by quick join / code,
// the member takes over a bot on the host, its movement shows on the host,
// its rounds are resolved by the host (damage, hit marker, kill feed), the
// host's match / bots show on the member, team match on RED with a purchase
// through the host, the host leaving hands the match to the member, and
// without a relay the lobby says so while the game runs as before.

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

test('deathmatch: quick join + code, the member plays a host bot; movement and shots go through the host (lag-compensated hit, damage, marker)', async () => {
  const host = await openGame(env, { mode: 'deathmatch', width: 480, height: 270 });
  const guest = await openGame(env, { mode: 'training', width: 480, height: 270 });
  for (const p of [host, guest]) p.setDefaultTimeout(60000);
  try {
    await lobby(host, 'Alpha', 'deathmatch');
    await host.click('.mp-quick');
    await host.waitForSelector('.mp-room:not([hidden])');
    const code = await host.textContent('.mp-room-code');
    assert.match(code, /^[A-Z2-9]{5}$/);
    await lobby(guest, 'Bravo');
    await guest.fill('.mp-code', code.toLowerCase());
    await guest.click('.mp-join-btn');
    await guest.waitForFunction(() => window.game.netClient?.myId && window.game.match);
    await host.waitForFunction(() => document.querySelectorAll('.mp-members li').length === 2);
    const h = await host.evaluate(() => {
      const g = window.game;
      const bot = g.squad.bots.find((b) => b.remote);
      return { bots: g.squad.bots.length, remote: bot?.name, botId: bot?.id, score: g.match.scores.get(bot?.id)?.name, mode: g.mode };
    });
    assert.deepEqual([h.bots, h.remote, h.score, h.mode], [7, 'Bravo', 'Bravo', 'deathmatch'], 'a room of 8: 7 bots, one played by Bravo');
    const myId = await guest.evaluate(() => window.game.netClient.myId);
    assert.equal(myId, h.botId);
    // The guest sees everyone else (host + 6 bots) and the host's scoreboard, itself as 'local'.
    await guest.waitForFunction(() => window.game.netClient.puppets.all.size === 7);
    const gm = await guest.evaluate(() => ({ local: window.game.match.scores.get('local')?.name, host: [...window.game.match.scores.values()].some((s) => s.name === 'Alpha'), mode: window.game.mode, map: window.game.mapDef.id }));
    assert.deepEqual(gm, { local: 'Bravo', host: true, mode: 'deathmatch', map: 'warehouse' });

    await play(host);
    await play(guest);
    // Two WebGL pages on a software renderer get ~1-3 frames a second each: from here both are
    // driven frame by frame (fixed 1/60 s steps, no rendering); messages still flow in real time.
    for (const p of [host, guest]) {
      await installFrameDriver(p);
      await p.evaluate(() => window.T.stopLoop());
    }
    const settle = async () => {
      await guest.waitForTimeout(250);
      await host.evaluate(() => window.T.run(6));
      await guest.waitForTimeout(250);
      await guest.evaluate(() => window.T.run(3));
    };
    // Quiet range: the host's AI bots are out (no respawn) so only the two players are left.
    await host.evaluate(() => {
      const g = window.game;
      g.squad.respawns = false;
      for (const b of g.squad.bots) if (!b.remote) b.combat.applyDamage({ amount: 999, zone: 'body', sourceId: 'test', weaponId: 'test', point: b.position.clone(), direction: b.position.clone().set(0, 0, 1), distance: 1 });
      // The host alive where it stands (the bots may have killed it; its respawn timer only runs with its loop).
      g.combat.reset();
      g.combat.protection = 0;
      // The guest's character fresh (the bots may have shot it before): a host spawn where it stands.
      const mine = g.squad.bots.find((b) => b.remote);
      mine.spawn(mine.position.clone().setY(mine.position.y - 0.1), mine.controller.yaw);
    });
    await guest.waitForFunction(() => window.game.combat.alive && window.game.combat.health === 100);
    await settle();
    await guest.evaluate(() => {
      const g = window.game;
      const o = g.netSpawn.bind(g);
      window.__spawns = [];
      g.netSpawn = (m) => (window.__spawns.push({ sp: m.sp, p: m.p }), o(m));
    });
    await host.evaluate(() => {
      const g = window.game;
      const fire = g.hitscan.fire.bind(g.hitscan);
      window.__shots = [];
      g.hitscan.fire = (r) => {
        const res = fire(r);
        if (r.sourceId !== 'local' && g.squad.bots.find((b) => b.id === r.sourceId)?.remote)
          window.__shots.push({ o: r.origin.toArray().map((v) => +v.toFixed(2)), d: r.direction.toArray().map((v) => +v.toFixed(3)), kind: res.kind, dist: res.distance && +res.distance.toFixed(2), me: g.player.position.toArray().map((v) => +v.toFixed(2)) });
        return res;
      };
    });
    // Movement: the guest walks forward 0.75 s (facing open ground); the host's bot follows.
    const start = await guest.evaluate(() => {
      const g = window.game;
      const p = g.player;
      const V = p.position.constructor;
      for (let k = 0; k < 16; k++) {
        const yaw = (k / 16) * Math.PI * 2;
        const dir = new V(-Math.sin(yaw), 0, -Math.cos(yaw));
        const knee = new V(p.position.x, p.position.y + 0.5, p.position.z);
        if (g.map.collision.raycast(knee, dir, 6) === null) {
          p.yaw = yaw;
          break;
        }
      }
      return p.position.clone();
    });
    // Walked at real pace (the host checks reports against its real clock: no faster than running).
    await guest.keyboard.down('KeyW');
    for (let i = 0; i < 9; i++) {
      await guest.evaluate(() => window.T.run(5));
      await guest.waitForTimeout(84);
    }
    await guest.keyboard.up('KeyW');
    await guest.evaluate(() => window.T.run(30));
    await settle();
    const moved = await guest.evaluate((s) => {
      const p = window.game.player.position;
      return { dist: Math.hypot(p.x - s.x, p.z - s.z), pos: [p.x, p.y, p.z] };
    }, start);
    const onHost = await host.evaluate((id) => window.game.squad.bots.find((b) => b.id === id).position.toArray(), h.botId);
    assert.ok(moved.dist > 1, `the guest moved (${moved.dist.toFixed(2)} m) spawns ${JSON.stringify(await guest.evaluate(() => window.__spawns))}`);
    assert.ok(Math.hypot(onHost[0] - moved.pos[0], onHost[2] - moved.pos[2]) < 0.6, `the host has the guest where the guest is (${onHost} vs ${moved.pos})`);

    // A report far beyond running speed (a teleport / speed hack) is refused and the guest is put back.
    const fake = await guest.evaluate(() => {
      const g = window.game;
      const p = g.player.position;
      g.net.send({ k: 'st', sp: g.netClient.spawnSeq, p: [p.x + 30, p.y, p.z], v: [0, 0, 0], yaw: 0, pitch: 0, h: 1.8, g: 1, crouch: 0, aim: 0, use: 0, w: 'ar01' });
      return { x: p.x, z: p.z, seq: g.netClient.spawnSeq };
    });
    await settle();
    const kept = await host.evaluate((id) => window.game.squad.bots.find((b) => b.id === id).position.toArray(), h.botId);
    assert.ok(Math.hypot(kept[0] - fake.x, kept[2] - fake.z) < 0.6, 'the host kept the character where it was');
    await guest.waitForFunction((f) => window.game.netClient.spawnSeq > f.seq, fake);
    const back = await guest.evaluate(() => window.game.player.position.toArray());
    assert.ok(Math.hypot(back[0] - fake.x, back[2] - fake.z) < 0.6, 'the correction put the guest where the host has it');

    // Shot: the host puts the guest's character 6 m in front of the host player, facing it (a spawn the guest applies).
    const setup = await host.evaluate((id) => {
      const g = window.game;
      const p = g.player.position;
      const bot = g.squad.bots.find((b) => b.id === id);
      const V = p.constructor;
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const at = new V(p.x + Math.sin(a) * 6, p.y, p.z + Math.cos(a) * 6);
        const down = g.map.collision.raycast(new V(at.x, at.y + 1, at.z), new V(0, -1, 0), 3);
        if (down === null) continue;
        at.y = at.y + 1 - down;
        // The line the guest will shoot along once landed: its eye to the host's upper chest.
        const eyeB = new V(at.x, at.y + g.player.eyeHeight, at.z);
        const chest = new V(p.x, p.y + 1.4, p.z);
        const dir = chest.clone().sub(eyeB);
        const len = dir.length();
        if (g.map.collision.raycast(eyeB, dir.normalize(), len) !== null) continue;
        bot.spawn(at, Math.atan2(-(p.x - at.x), -(p.z - at.z)));
        return { ok: true, hp: g.combat.health, at: bot.position.toArray() };
      }
      return { ok: false };
    }, h.botId);
    assert.ok(setup.ok, 'found a clear spot');
    await guest.waitForFunction((at) => Math.hypot(window.game.player.position.x - at[0], window.game.player.position.z - at[2]) < 0.05, setup.at);
    // Landed (a spawn drops the character from 0.1 m: no shooting in the air).
    await guest.evaluate(() => window.T.run(60));
    await settle();
    await settle();
    // An aimed single round at the host's chest (its body on the guest's screen).
    const hostWire = await host.evaluate(() => window.game.net.id);
    await guest.evaluate(() => {
      const hud = window.game.hud;
      const show = hud.showHitMarker.bind(hud);
      window.__hits = [];
      hud.showHitMarker = (head, kill) => (window.__hits.push([head, kill]), show(head, kill));
    });
    setup.hp = await host.evaluate(() => (window.game.combat.alive ? window.game.combat.health : -1));
    assert.equal(setup.hp, 100, 'the host is alive at full health');
    const truth = await host.evaluate(() => window.game.player.position.toArray());
    const shown = await guest.evaluate((w) => window.game.netClient.puppets.all.get(w)?.position.toArray(), hostWire);
    assert.ok(shown && Math.hypot(shown[0] - truth[0], shown[1] - truth[1], shown[2] - truth[2]) < 0.3, `the host's body is where the host is (${shown} vs ${truth})`);
    for (let shot = 0; shot < 1; shot++) {
      const aim = await guest.evaluate((hostWire) => {
        const g = window.game;
        const target = g.netClient.puppets.all.get(hostWire)?.position;
        if (!target) return null;
        const p = g.player;
        const dx = target.x - p.position.x;
        const dz = target.z - p.position.z;
        const dy = target.y + 1.4 - (p.position.y + p.eyeHeight);
        p.yaw = Math.atan2(-dx, -dz);
        p.pitch = Math.atan2(dy, Math.hypot(dx, dz));
        return Math.hypot(dx, dz);
      }, hostWire);
      assert.ok(aim !== null, "the host's body is on the guest's screen");
      // The trigger through the game's input (a synthetic click under pointer lock also moves the view).
      await guest.evaluate(() => {
        const input = window.game.input;
        input.mouseButtons = 1;
        window.T.run(2);
        input.mouseButtons = 0;
        window.T.run(45);
      });
      await guest.waitForTimeout(150);
    }
    await host.waitForFunction((hp) => window.game.combat.health < hp || !window.game.combat.alive, setup.hp, { timeout: 10000 }).catch(() => {});
    const after = await host.evaluate(() => ({ hp: window.game.combat.health, stats: window.game.netHost.shotStats, protection: window.game.combat.protection, hits: window.game.combat.hits, shots: window.__shots }));
    assert.ok(after.stats.target >= 1 && !after.stats.rate && !after.stats.origin, `the round was resolved on the host and hit: ${JSON.stringify(after)}`);
    assert.ok(after.hp < setup.hp, `the host took the guest's rounds (${setup.hp} → ${after.hp})`);
    await guest.waitForFunction(() => window.__hits.length > 0, null, { timeout: 5000 });
    assert.ok((await guest.evaluate(() => window.__hits.length)) > 0, 'the guest got the host-confirmed hit marker');
    // The guest's own health / state is the host's (it was not shot).
    assert.equal(await guest.evaluate(() => window.game.combat.health), 100);
    assert.deepEqual(host.errors, []);
    assert.deepEqual(guest.errors, []);
  } finally {
    await host.context().close();
    await guest.context().close();
  }
});

test('team match: the member plays RED, buys through the host, sees the round state; when the host leaves, the member hosts', async () => {
  const host = await openGame(env, { mode: 'team', objective: 'bomb', width: 480, height: 270 });
  const guest = await openGame(env, { mode: 'training', width: 480, height: 270 });
  for (const p of [host, guest]) p.setDefaultTimeout(60000);
  try {
    await lobby(host, 'Host', 'team');
    await host.click('.mp-create');
    await host.waitForSelector('.mp-room:not([hidden])');
    const code = await host.textContent('.mp-room-code');
    await lobby(guest, 'Guest');
    await guest.fill('.mp-code', code);
    await guest.click('.mp-join-btn');
    await guest.waitForFunction(() => window.game.netClient?.myId && window.game.teamMatch);
    const g1 = await guest.evaluate(() => ({ team: window.game.localTeam, mine: window.game.teamMatch.scores.get('local'), phase: window.game.teamMatch.phase, money: window.game.teamMatch.economy?.money('local') }));
    assert.equal(g1.team, 'red', 'the second human goes to the team with fewer humans');
    assert.equal(g1.mine.team, 'red');
    assert.equal(g1.mine.name, 'Guest');
    assert.equal(g1.phase, 'prep');
    assert.ok(g1.money > 0, 'money from the host');
    // Buy through the host: a pistol (prep phase).
    await play(guest);
    const before = await host.evaluate(() => {
      const bot = window.game.squad.bots.find((b) => b.remote);
      return window.game.teamMatch.economy.money(bot.id);
    });
    await guest.evaluate(() => window.game.buy('PIS-01'));
    await guest.waitForFunction(() => window.game.weapons.loadout.some((w) => w.def.id === 'pis01'));
    const afterMoney = await host.evaluate(() => {
      const bot = window.game.squad.bots.find((b) => b.remote);
      return window.game.teamMatch.economy.money(bot.id);
    });
    assert.equal(afterMoney, before - 500, 'paid on the host');
    await guest.waitForFunction((m) => window.game.teamMatch.economy.money('local') === m, afterMoney);
    // The host leaves: the guest takes over the room and runs a fresh match with bots.
    await host.context().close();
    await guest.waitForFunction(() => window.game.netHost && window.game.squad && window.game.teamMatch && !window.game.netClient, null, { timeout: 30000 });
    const g2 = await guest.evaluate(() => ({ bots: window.game.squad.bots.length, round: window.game.teamMatch.round, members: document.querySelectorAll('.mp-members li').length }));
    assert.deepEqual(g2, { bots: 9, round: 1, members: 1 });
    assert.deepEqual(guest.errors, []);
  } finally {
    await guest.context().close();
  }
});

test('leaving the room returns to single player; without a relay the lobby says so and nothing else changes', async () => {
  const page = await openGame(env, { mode: 'deathmatch', width: 480, height: 270 });
  page.setDefaultTimeout(60000);
  try {
    await lobby(page, 'Solo', 'deathmatch');
    await page.click('.mp-create');
    await page.waitForFunction(() => window.game.netHost && window.game.squad?.bots.length === 7);
    // A hidden host tab gets no animation frames: a worker timer keeps the room's match running.
    await installFrameDriver(page);
    const t0 = await page.evaluate(() => {
      window.T.stopLoop();
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
      return window.game.match.elapsed;
    });
    await page.waitForTimeout(1500);
    const t1 = await page.evaluate(() => {
      const e = window.game.match.elapsed;
      delete document.hidden;
      document.dispatchEvent(new Event('visibilitychange'));
      return e;
    });
    assert.ok(t1 - t0 > 0.5, `the match ran while hidden (${(t1 - t0).toFixed(2)} s)`);
    await page.click('.mp-leave');
    await page.waitForFunction(() => !window.game.netHost && !window.game.net && window.game.squad?.bots.length === window.game.matchSettings.bots);
    assert.equal(await page.isHidden('.mp-room'), true);
    assert.equal(await page.isDisabled('select[data-setting="mode"]'), false, 'options unlocked again');
  } finally {
    await page.context().close();
  }
  const plain = await startEnv();
  try {
    const p = await openGame(plain, { mode: 'deathmatch', width: 480, height: 270 });
    p.setDefaultTimeout(60000);
    await p.click('#tab-multi');
    await p.waitForFunction(() => document.querySelector('.mp-server').textContent.includes('서버 응답 없음'));
    assert.equal(await p.evaluate(() => window.game.net), null);
    await p.context().close();
  } finally {
    await plain.close();
  }
});
