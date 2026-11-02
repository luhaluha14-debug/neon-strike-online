// Shotgun online: two real game pages through the real relay (team match,
// elimination). The member (RED) buys an SG-01 through the host and shoots
// the host player. The host resolves each pellet; the member sees one hit
// marker and hears one hit sound per round (a head hit may add one head
// confirm on top, never more), also with the host's per-pellet reports
// arriving spread out by network jitter and with the member's frames
// stopped; a round that kills gives one kill marker and one kill confirm;
// host and member agree on the kill (feed, score) and the damage.

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

test(`a member's shotgun rounds: one marker and one hit sound per round (jitter, frames stopped), one kill confirm for the kill; host and member agree`, async () => {
  const host = await openGame(env, { mode: 'team', objective: 'elimination', width: 480, height: 270 });
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
    assert.equal(await guest.evaluate(() => window.game.localTeam), 'red');
    await play(host);
    await play(guest);
    await guest.evaluate(() => window.game.buy('SG-01'));
    await guest.waitForFunction(() => window.game.weapons.loadout.some((w) => w.def.id === 'sg01'));
    for (const p of [host, guest]) {
      await installFrameDriver(p);
      await p.evaluate(() => window.T.stopLoop());
    }
    const botId = await host.evaluate(() => window.game.squad.bots.find((b) => b.remote).id);
    const hostWire = await host.evaluate(() => window.game.net.id);
    // Into the live round; the AI bots out of it (the two players are left: BLUE host, RED member).
    await host.evaluate(() => {
      const g = window.game;
      while (g.teamMatch.phase !== 'live') window.T.run(1);
      for (const b of g.squad.bots) if (!b.remote) b.combat.applyDamage({ amount: 999, zone: 'body', sourceId: 'test', weaponId: 'test', point: b.position.clone(), direction: b.position.clone().set(0, 0, 1), distance: 1 });
      g.combat.protection = 0;
    });
    const settle = async () => {
      await guest.waitForTimeout(200);
      await host.evaluate(() => window.T.run(4));
      await guest.waitForTimeout(200);
      await guest.evaluate(() => window.T.run(2));
    };
    // The host sends its match state from its frames; the member applies it in its own.
    for (let i = 0; i < 100 && (await guest.evaluate(() => (window.T.run(2), window.game.teamMatch.phase))) !== 'live'; i++) {
      await host.evaluate(() => window.T.run(15));
      await guest.waitForTimeout(100);
    }
    assert.equal(await guest.evaluate(() => window.game.teamMatch.phase), 'live');
    await guest.evaluate(() => {
      const g = window.game;
      const i = g.weapons.loadout.findIndex((w) => w.def.id === 'sg01');
      g.weapons.equipSlot(i);
      window.T.run(60);
      // Count what the member sees and hears.
      window.__marks = [];
      const show = g.hud.showHitMarker.bind(g.hud);
      g.hud.showHitMarker = (head, kill) => (window.__marks.push([head, kill, performance.now()]), show(head, kill));
      window.__sounds = [];
      const play = g.audio.play.bind(g.audio);
      g.audio.play = (id, o) => {
        if (id === 'hit.body' || id === 'hit.head' || id === 'kill.confirm') window.__sounds.push(id);
        return play(id, o);
      };
      window.__hitMsgs = 0;
      const netHit = g.netHit.bind(g);
      // Network jitter on the host's hit reports (each pellet's own message): 0-30 ms each, when on.
      window.__jitter = false;
      g.netHit = (m) => {
        window.__hitMsgs++;
        if (window.__jitter) setTimeout(() => netHit(m), Math.random() * 30);
        else netHit(m);
      };
      return g.weapons.weapon.def.id;
    });
    assert.equal(await guest.evaluate(() => window.game.weapons.weapon.def.id), 'sg01');

    /** The host puts the member's character `d` m from the host player, facing it; the member aims at its hips. */
    const placeAt = async (d) => {
      const ok = await host.evaluate(
        ([id, d]) => {
          const g = window.game;
          const p = g.player.position;
          const bot = g.squad.bots.find((b) => b.id === id);
          const V = p.constructor;
          for (let k = 0; k < 24; k++) {
            const a = (k / 24) * Math.PI * 2;
            const at = new V(p.x + Math.sin(a) * d, p.y, p.z + Math.cos(a) * d);
            const down = g.map.collision.raycast(new V(at.x, at.y + 1, at.z), new V(0, -1, 0), 3);
            if (down === null) continue;
            at.y = at.y + 1 - down;
            const eye = new V(at.x, at.y + 1.6, at.z);
            const hips = new V(p.x, p.y + 0.95, p.z);
            const dir = hips.clone().sub(eye);
            const len = dir.length();
            if (g.map.collision.raycast(eye, dir.normalize(), len) !== null) continue;
            bot.spawn(at, Math.atan2(-(p.x - at.x), -(p.z - at.z)));
            return true;
          }
          return false;
        },
        [botId, d],
      );
      assert.ok(ok, `a clear spot ${d} m away`);
      await guest.waitForFunction(() => window.__spawned !== window.game.netClient.spawnSeq && (window.__spawned = window.game.netClient.spawnSeq));
      // The spawn hands the loadout over again: the shotgun is drawn (0.7 s) before it can fire.
      await guest.evaluate(() => {
        while (window.game.weapons.weapon.status !== 'ready') window.T.run(1);
        window.T.run(5);
      });
      await settle();
      await guest.evaluate((w) => {
        const g = window.game;
        const t = g.netClient.puppets.all.get(w).position;
        const p = g.player;
        const dx = t.x - p.position.x;
        const dz = t.z - p.position.z;
        p.yaw = Math.atan2(-dx, -dz);
        p.pitch = Math.atan2(t.y + 0.95 - (p.position.y + p.eyeHeight), Math.hypot(dx, dz));
      }, hostWire);
    };
    await guest.evaluate(() => (window.__spawned = window.game.netClient.spawnSeq));

    /** One round from the member; its frames stop right after it (results come in on their own). */
    const round = async () => {
      const before = await host.evaluate(() => ({ target: window.game.netHost.shotStats.target ?? 0, hp: window.game.combat.health }));
      await guest.evaluate(() => {
        window.__marks = [];
        window.__sounds = [];
        window.__hitMsgs = 0;
        const g = window.game;
        g.input.mouseButtons = 1;
        window.T.run(2);
        g.input.mouseButtons = 0;
        window.T.run(1);
      });
      // Host resolves the pellets (its frames); the member's frames stay stopped.
      await guest.waitForTimeout(150);
      await host.evaluate(() => window.T.run(3));
      await guest.waitForTimeout(400);
      const after = await host.evaluate(() => ({ target: window.game.netHost.shotStats.target ?? 0, hp: window.game.combat.health, alive: window.game.combat.alive }));
      const seen = await guest.evaluate(() => ({ marks: window.__marks.map(([h, k]) => [h, k]), sounds: window.__sounds.slice(), msgs: window.__hitMsgs }));
      // Next round allowed after the pump (0.88 s).
      await guest.evaluate(() => window.T.run(60));
      return { pellets: after.target - before.target, damage: before.hp - after.hp, alive: after.alive, ...seen };
    };
    /** One confirm per round: one marker + one hit sound, plus at most one head upgrade (marker + head sound). */
    const onePerRound = (r, label, minPellets = 2) => {
      assert.ok(r.pellets >= minPellets, `${label}: pellets hit on the host (${r.pellets})`);
      assert.equal(r.msgs, r.pellets, `${label}: the host reported each pellet (${r.msgs})`);
      const hits = r.sounds.filter((s) => s !== 'kill.confirm');
      assert.ok(r.marks.length >= 1 && r.marks.length <= 2, `${label}: one marker (head upgrade at most) — ${JSON.stringify(r.marks)}`);
      assert.ok(hits.length >= 1 && hits.length <= 2, `${label}: one hit sound (head upgrade at most) — ${hits}`);
      if (hits.length === 2) assert.deepEqual([hits[1], r.marks[1][0]], ['hit.head', true], `${label}: the second is a head upgrade`);
      assert.ok(hits.filter((s) => s === 'hit.body').length <= 1, `${label}: never two body sounds`);
    };

    // 1) At 10 m: some pellets hit, no kill (the host's health kept out of reach of one round here).
    await host.evaluate(() => (window.game.player.health = 1000));
    await placeAt(10);
    const far = await round();
    onePerRound(far, '10 m');
    assert.ok(far.damage > 0 && far.alive, `the host took damage (${far.damage}) and lives`);
    assert.ok(far.marks.every(([, k]) => !k) && !far.sounds.includes('kill.confirm'), 'no kill feedback for a hit');

    // 2) Same, with jitter on the host's per-pellet reports (spread over 30 ms).
    await guest.evaluate(() => (window.__jitter = true));
    await host.evaluate(() => (window.game.player.health = 1000));
    const jittered = await round();
    onePerRound(jittered, 'jitter');

    // 3) Point blank, the host low: the round kills. One kill marker, one kill confirm.
    await host.evaluate(() => (window.game.player.health = 30));
    await placeAt(4);
    assert.deepEqual(await host.evaluate(() => [window.game.combat.alive, window.game.teamMatch.phase]), [true, 'live'], 'the host alive, the round on');
    const kill = await round();
    // (The pellet that kills may be the first: the rest of the round passes through the fallen body.)
    onePerRound(kill, 'kill', 1);
    assert.equal(kill.alive, false, 'the host is down');
    assert.equal(kill.marks.at(-1)[1], true, 'the last marker is a kill marker');
    await guest.waitForTimeout(300);
    const confirms = await guest.evaluate(() => window.__sounds.filter((s) => s === 'kill.confirm').length);
    assert.equal(confirms, 1, 'one kill confirm');
    // Both sides agree on the kill.
    await settle();
    const hostSide = await host.evaluate((id) => ({ kills: window.game.teamMatch.scores.get(id).kills, feed: window.game.teamMatch.feed.filter((f) => f.killer === id).map((f) => f.weaponId) }), botId);
    const guestSide = await guest.evaluate(() => ({ kills: window.game.teamMatch.scores.get('local').kills, feed: window.game.teamMatch.feed.filter((f) => f.killer === 'local').map((f) => f.weaponId) }));
    assert.deepEqual(hostSide, { kills: 1, feed: ['sg01'] });
    assert.deepEqual(guestSide, hostSide, 'the member sees the same kill');
    assert.deepEqual(host.errors, []);
    assert.deepEqual(guest.errors, []);
  } finally {
    await host.context().close();
    await guest.context().close();
  }
});
