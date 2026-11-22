// Phase 30 — the AWM (SR-01's new name and role: semi-automatic, 150 RPM, GRID's top sniper rifle) and the
// swap reset (drawing any weapon resets its fire cooldown; it may fire during its draw; ammo and the reload
// state are kept; the host accepts it, and only it). Real weapon code through the game's own frame driver;
// online parts through a real relay with two browsers.

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

async function play(mode = 'deathmatch') {
  const page = await openGame(env, { mode, width: 640, height: 360, quality: 'low' });
  await page.click('.play-button');
  await page.waitForFunction(() => window.game.input.active);
  await installFrameDriver(page);
  await page.evaluate(() => {
    window.T.stopLoop();
    window.T.run(10);
    window.game.combat.protection = 1e9;
  });
  return page;
}

test('1. AWM numbers: 150 RPM semi-automatic, 160 a round (head ×4, leg ×0.7), 150 → 300 m falloff to 90 %, 500 m; magazine, reserve, reload, draw, scope and moving inaccuracy as before; price and slot kept; the strongest sniper', async () => {
  const page = await openGame(env, { mode: 'training', width: 480, height: 270 });
  try {
    const r = await page.evaluate(async () => {
      const { computeDamage } = await import('/src/combat/HitscanSystem.ts');
      const { armorSplit } = await import('/src/player/PlayerCombat.ts');
      const { WEAPONS } = await import('/src/weapons/weapons.ts');
      const { CATALOG } = await import('/src/weapons/catalog.ts');
      const { AWM_CONFIG } = await import('/src/config.ts');
      const a = WEAPONS.sr01;
      const d = (zone, m) => computeDamage(a.damage, zone, m);
      const others = Object.values(WEAPONS).filter((w) => w.id !== 'sr01' && w.damage.hitPad);
      const item = CATALOG.find((i) => i.id === 'SR-01');
      return {
        name: a.displayName,
        mode: a.fireMode,
        rate: a.fireRate,
        interval: 60 / a.fireRate,
        action: a.action,
        dmg: { body: d('body', 50), head: d('head', 50), leg: d('limb', 50), body200: d('body', 225), body400: d('body', 400) },
        range: a.damage.maxRange,
        vest: armorSplit(d('body', 50), 'body', 100).health,
        kept: [a.magazineSize, a.reserveAmmo, a.reloadTime, a.equipTime, a.scope.zoom, +(a.spread.moving * 180 / Math.PI).toFixed(2)],
        hitPad: [a.damage.hitPad, AWM_CONFIG.hitPad, others.length],
        item: [item.name, item.price, item.slot],
        dmr: { body: computeDamage(WEAPONS.dmr01.damage, 'body', 50), range: WEAPONS.dmr01.damage.maxRange },
        cycleSound: a.sounds.cycle ?? null,
      };
    });
    assert.deepEqual([r.name, r.mode, r.rate, r.interval, r.action], ['AWM', 'semi', 150, 0.4, 'semi']);
    assert.deepEqual(r.dmg, { body: 160, head: 640, leg: 112, body200: 152, body400: 144 });
    assert.equal(r.range, 500);
    assert.ok(r.vest >= 100, `a body hit through a full vest still kills (${r.vest})`);
    assert.deepEqual(r.kept, [5, 30, 3.6, 1, 4, 6]);
    assert.deepEqual(r.hitPad, [0.15, 0.15, 0], 'the hit correction is the AWM’s only, from AWM_CONFIG');
    assert.deepEqual(r.item, ['AWM 저격소총 (반자동)', 4750, 'primary']);
    assert.ok(r.dmg.body > r.dmr.body && r.range > r.dmr.range, 'above the DMR in damage and reach');
    assert.equal(r.cycleSound, null, 'no hand-worked bolt sound');
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});

/** Runs `frames` frames clicking the trigger every frame (a new press each time); returns the frames that fired. */
const clickFire = (page, frames, every = 2) =>
  page.evaluate(
    ({ frames, every }) => {
      const g = window.game;
      const poll = g.input.poll.bind(g.input);
      let f = 0;
      g.input.poll = (out) => {
        poll(out);
        out.fire = f % every === 0;
      };
      const fired = [];
      for (; f < frames; f++) {
        const n = g.weapons.shotsFired;
        window.T.run(1);
        if (g.weapons.shotsFired > n) fired.push(f);
      }
      g.input.poll = poll;
      return fired;
    },
    { frames, every },
  );

test('2. the AWM in play: one round per trigger pull (holding fires once), 150 RPM when clicked fast (0.4 s apart), 5 rounds then a 3.6 s reload, the bolt snaps back and forward by itself (no hand-worked cycle)', async () => {
  const page = await play('deathmatch');
  try {
    await page.evaluate(() => {
      const g = window.game;
      g.weapons.equipSlot(1);
      window.T.run(80);
    });
    assert.equal(await page.evaluate(() => window.game.weapons.weapon.def.id), 'sr01');
    // Held: one round.
    const held = await page.evaluate(() => {
      const g = window.game;
      const poll = g.input.poll.bind(g.input);
      g.input.poll = (out) => {
        poll(out);
        out.fire = true;
      };
      const n = g.weapons.shotsFired;
      window.T.run(90);
      g.input.poll = poll;
      window.T.run(2);
      return g.weapons.shotsFired - n;
    });
    assert.equal(held, 1, 'semi-automatic: holding fires one round');
    await page.evaluate(() => {
      const w = window.game.weapons.weapon;
      w.magazine = 5;
      w.reserve = 30;
      window.T.run(40);
    });
    // Clicking as fast as the frames allow for 2 s: rounds 0.4 s apart (frames are 1/60 s).
    const fired = await clickFire(page, 100);
    const gaps = fired.slice(1).map((f, i) => (f - fired[i]) / 60);
    assert.ok(fired.length === 5, `5 rounds in 1.67 s (${fired.length}: ${fired})`);
    for (const g of gaps) assert.ok(Math.abs(g - 0.4) <= 1 / 60 + 1e-9, `0.4 s apart (${gaps})`);
    const rpm = 60 / (gaps.reduce((a, b) => a + b, 0) / gaps.length);
    assert.ok(Math.abs(rpm - 150) < 4, `${rpm.toFixed(1)} RPM`);
    // The magazine is empty: a reload (3.6 s), then 5 again from the reserve.
    const ammo = await page.evaluate(() => {
      const w = window.game.weapons.weapon;
      const a = [w.magazine, w.reserve];
      window.game.weapons.step({ fire: false, reload: true }, 0);
      const started = w.status;
      window.T.run(60 * 3.5);
      const mid = w.status;
      window.T.run(12);
      return { a, started, mid, after: [w.magazine, w.reserve, w.status] };
    });
    assert.deepEqual(ammo, { a: [0, 30], started: 'reloading', mid: 'reloading', after: [5, 25, 'ready'] });
    // The bolt: back with the shot, home again within 0.11 s, never lifted (no bolt-action cycle).
    const bolt = await page.evaluate(async () => {
      const { animateBolt } = await import('/src/weapons/view/SniperRifleView.ts');
      const V = window.game.player.position.constructor;
      const o = { position: new V(), rotation: { z: 0 } };
      o.position.set = function (x, y, z) {
        this.x = x;
        this.y = y;
        this.z = z;
      };
      const rest = new V(0, 0, 0);
      const at = (s, action) => {
        animateBolt(o, rest, { category: 'sniper', equip: 1, reload: null, sinceShot: s, fireInterval: 0.4, inspect: null, action }, 0.085);
        return [+o.position.z.toFixed(4), +o.rotation.z.toFixed(3)];
      };
      const semi = [0, 0.025, 0.06, 0.12, 0.3].map((s) => at(s, 'semi'));
      // A bolt-action (no action given; its old 1.45 s cycle): the handle is lifted mid-cycle.
      animateBolt(o, rest, { category: 'sniper', equip: 1, reload: null, sinceShot: 0.6, fireInterval: 1.45, inspect: null }, 0.085);
      return { semi, bolt: [+o.position.z.toFixed(4), +o.rotation.z.toFixed(3)] };
    });
    assert.deepEqual(bolt.semi.map((x) => x[1]), [0, 0, 0, 0, 0], 'no handle lift');
    assert.ok(bolt.semi[1][0] > 0.05 && bolt.semi[3][0] === 0 && bolt.semi[4][0] === 0, JSON.stringify(bolt.semi));
    assert.ok(bolt.bolt[1] > 0, 'a bolt-action (no action given) still lifts its handle');
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});

/** A ray from 8 m in front of an armoured bot at chest height, `side` m to the side of its centre, with `weapon`. */
const nearMiss = (page, weapon, side, height = 1.1) =>
  page.evaluate(
    async ({ weapon, side, height }) => {
      const g = window.game;
      const { WEAPONS } = await import('/src/weapons/weapons.ts');
      const V = g.player.position.constructor;
      const bot = g.squad.bots.find((b) => b.alive && !b.remote);
      const c = bot.controller;
      c.lean = 0;
      bot.combat.protection = 0;
      bot.combat.armor = 0;
      c.position.set(c.position.x + 300, c.position.y + 200, c.position.z); // in the open sky, far from any wall
      const origin = new V(c.position.x, c.position.y + height, c.position.z + 8);
      const target = new V(c.position.x + side, c.position.y + height, c.position.z);
      const dir = target.clone().sub(origin).normalize();
      const res = g.hitscan.fire({ origin, direction: dir, damage: WEAPONS[weapon].damage, sourceId: 'tester', weaponId: weapon });
      const out = { kind: res.kind, zone: res.zone ?? null, damage: res.damage ?? 0, alive: bot.alive };
      // Back for the next case.
      bot.combat.player.health = 100;
      bot.combat['dead'] = false;
      c.position.set(c.position.x - 300, c.position.y - 200, c.position.z);
      return out;
    },
    { weapon, side, height },
  );

test('3. AWM hit correction (AWM_CONFIG.hitPad = 0.15 m): a round 0.4 m from a bot’s centre hits with the AWM and misses with every other gun; 0.5 m misses with all; a near miss over the head is a body hit, not a headshot; the training dummies, walls and other weapons are judged as before', async () => {
  const page = await play('deathmatch');
  try {
    const awm = await nearMiss(page, 'sr01', 0.4);
    assert.deepEqual([awm.kind, awm.zone, awm.alive], ['target', 'body', false], JSON.stringify(awm));
    for (const w of ['ar01', 'ar02', 'dmr01', 'smg01', 'smg02', 'lmg01', 'lmg02', 'pis01', 'pis02']) {
      const r = await nearMiss(page, w, 0.4);
      assert.equal(r.kind, 'miss', `${w}: 0.4 m off is a miss`);
    }
    assert.equal((await nearMiss(page, 'sr01', 0.5)).kind, 'miss', 'AWM: 0.5 m off is a miss');
    // Just past the side of the head: a body hit (the correction never makes a headshot).
    const head = await nearMiss(page, 'sr01', 0.38, 1.72);
    assert.deepEqual([head.kind, head.zone], ['target', 'body']);
    // A real head hit is still a headshot.
    const real = await nearMiss(page, 'sr01', 0, 1.72);
    assert.deepEqual([real.kind, real.zone], ['target', 'head']);
    // Walls: a near miss whose padded point is behind a wall is no hit (the line to it is checked).
    const blocked = await page.evaluate(async () => {
      const g = window.game;
      const { WEAPONS } = await import('/src/weapons/weapons.ts');
      const V = g.player.position.constructor;
      const coll = g.map.collision;
      // A wall face: from a spawn, the first direction with a wall 3–10 m away.
      const s = g.map.attackSpawns[0].position;
      const o = new V(s.x, s.y + 1.1, s.z);
      for (let i = 0; i < 64; i++) {
        const a = (i / 64) * Math.PI * 2;
        const d = new V(-Math.sin(a), 0, -Math.cos(a));
        const h = coll.raycast(o, d, 10);
        if (h === null || h < 3) continue;
        // The bot's centre 0.45 m behind the wall, on the round's line: the wall stops it first.
        const bot = g.squad.bots.find((b) => b.alive && !b.remote);
        bot.combat.protection = 0;
        const behind = o.clone().addScaledVector(d, h + 0.45);
        bot.controller.position.set(behind.x, s.y, behind.z);
        const res = g.hitscan.fire({ origin: o, direction: d, damage: WEAPONS.sr01.damage, sourceId: 'tester', weaponId: 'sr01' });
        return { kind: res.kind, alive: bot.alive };
      }
      return { error: 'no wall' };
    });
    assert.deepEqual(blocked, { kind: 'world', alive: true }, 'the wall stops the AWM round; the padding reaches no one behind it');
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});

test('4. swap reset, every gun: fire → switch → fire at once → switch back → fire at once (inside its own interval); one round each; ammo never restored; a reload interrupted by a switch keeps its magazine; the view model finishes the switch with the shot', async () => {
  const page = await play('deathmatch');
  try {
    const r = await page.evaluate(async () => {
      const g = window.game;
      const { WEAPONS } = await import('/src/weapons/weapons.ts');
      const guns = Object.values(WEAPONS).filter((w) => w.category !== 'melee');
      const poll = g.input.poll.bind(g.input);
      let fire = false;
      g.input.poll = (out) => {
        poll(out);
        out.fire = fire;
      };
      // One click: press for a frame, release for a frame.
      const click = () => {
        fire = true;
        window.T.run(1);
        fire = false;
        window.T.run(1);
      };
      const rows = [];
      for (const a of guns)
        for (const b of guns) {
          if (a === b) continue;
          g.weapons.setLoadout([a, b, WEAPONS.karambit], 0);
          window.T.run(Math.ceil(a.equipTime * 60) + 2);
          const wa = g.weapons.loadout[0];
          const wb = g.weapons.loadout[1];
          // Full magazines for this pair (the same weapon is kept from the pair before).
          wa.magazine = a.magazineSize;
          wb.magazine = b.magazineSize;
          const s0 = g.weapons.shotsFired;
          const ammo0 = [wa.magazine, wb.magazine];
          click(); // a
          g.weapons.equipSlot(1);
          click(); // b, at once (its draw time not waited)
          g.weapons.equipSlot(0);
          click(); // a again, inside its own fire interval
          const shots = g.weapons.shotsFired - s0;
          rows.push({ a: a.id, b: b.id, shots, used: [ammo0[0] - wa.magazine, ammo0[1] - wb.magazine], holster: g.viewModel.holstering });
        }
      // Reload, then a switch away and back: the magazine is what it was (no round added), the reload cancelled.
      g.weapons.setLoadout([WEAPONS.ar01, WEAPONS.pis01, WEAPONS.karambit], 0);
      window.T.run(80);
      const w = g.weapons.weapon;
      w.magazine = 7;
      g.weapons.step({ fire: false, reload: true }, 0);
      window.T.run(30);
      const during = [w.status, w.magazine, w.reserve];
      g.weapons.equipSlot(1);
      g.weapons.equipSlot(0);
      const after = [w.status, w.magazine, w.reserve];
      click();
      const fired = [w.magazine];
      g.input.poll = poll;
      return { rows, during, after, fired };
    });
    const bad = r.rows.filter((x) => x.shots !== 3 || x.used[0] !== 2 || x.used[1] !== 1);
    assert.equal(r.rows.length, 11 * 10, 'every ordered pair of the 11 guns');
    assert.deepEqual(bad, [], 'each pair: three rounds (a, b at once, a at once again); two from a, one from b');
    assert.ok(r.rows.every((x) => x.holster === false), 'the view model is on the new weapon after the shot');
    assert.deepEqual(r.during, ['reloading', 7, 90]);
    assert.deepEqual(r.after, ['equipping', 7, 90], 'switched during the reload: cancelled, the magazine kept as it was (nothing added)');
    assert.deepEqual(r.fired, [6], 'and it fires at once from what is left');
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});

test('5. without a switch the fire rate holds for every gun (the reset is the switch, nothing else): a second click inside the interval does not fire', async () => {
  const page = await play('deathmatch');
  try {
    const r = await page.evaluate(async () => {
      const g = window.game;
      const { WEAPONS } = await import('/src/weapons/weapons.ts');
      const out = {};
      for (const w of Object.values(WEAPONS).filter((x) => x.category !== 'melee' && x.fireMode === 'semi')) {
        g.weapons.setLoadout([w, WEAPONS.karambit], 0);
        window.T.run(Math.ceil(w.equipTime * 60) + 2);
        const s0 = g.weapons.shotsFired;
        g.weapons.step({ fire: true, reload: false }, 1 / 120);
        g.weapons.step({ fire: false, reload: false }, 1 / 120);
        g.weapons.step({ fire: true, reload: false }, 1 / 120);
        out[w.id] = g.weapons.shotsFired - s0;
      }
      return out;
    });
    for (const [id, n] of Object.entries(r)) assert.equal(n, 1, `${id}: one round inside its interval`);
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});

test('6. a room: the member’s AWM → pistol → AWM (switch-shooting) is accepted by the host round for round; a forged faster AWM (no switch) is refused; forged switches are capped', async () => {
  const host = await openGame(env, { mode: 'deathmatch', width: 480, height: 270 });
  const member = await openGame(env, { mode: 'training', width: 480, height: 270 });
  for (const p of [host, member]) p.setDefaultTimeout(60000);
  try {
    await host.click('#tab-multi');
    await host.fill('.mp-name', 'Host');
    await host.selectOption('.mp-mode', 'deathmatch');
    await host.click('.mp-create');
    await host.waitForFunction(() => window.game.netHost && window.game.squad);
    const code = (await host.textContent('.mp-room-code')).trim();
    await member.click('#tab-multi');
    await member.fill('.mp-name', 'Member');
    await member.fill('.mp-code', code);
    await member.click('.mp-join-btn');
    await member.waitForFunction(() => window.game.netClient?.myId && window.game.match);
    for (const p of [host, member]) {
      await p.click('#tab-play');
      await p.click('.play-button');
      await p.waitForFunction(() => window.game.input.active);
    }
    await member.waitForTimeout(500);
    // In play and alive (a busy machine may still be bringing the member in).
    await member.waitForFunction(() => window.game.input.active && window.game.combat?.alive && window.game.weapons);
    await installFrameDriver(member);
    const stats = () => host.evaluate(() => ({ ...window.game.netHost.shotStats }));
    const delta = (a, b) => {
      const o = {};
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) o[k] = (b[k] ?? 0) - (a[k] ?? 0);
      return o;
    };
    // Real play: 6 cycles of AWM shot, pistol... the deathmatch loadout is AR-01 / AWM / M9: AWM → AR-01 → AWM.
    const s0 = await stats();
    const sent = await member.evaluate(async () => {
      const g = window.game;
      g.combat.protection = 1e9;
      const n0 = g.weapons.shotsFired;
      const poll = g.input.poll.bind(g.input);
      let fire = false;
      g.input.poll = (out) => {
        poll(out);
        out.fire = fire;
      };
      // Frames driven here (a page in the background gets few animation frames of its own).
      window.T.stopLoop();
      const tick = async () => window.T.run(1);
      const click = async () => {
        fire = true;
        await tick();
        fire = false;
        await tick();
      };
      g.player.pitch = 0.6; // at the sky: no one is hit
      g.weapons.loadout[1].magazine = 5;
      g.weapons.equipSlot(1);
      for (let i = 0; i < 6; i++) {
        await click(); // AWM
        g.weapons.equipSlot(0);
        await click(); // AR-01 at once
        g.weapons.equipSlot(1);
      }
      g.input.poll = poll;
      return g.weapons.shotsFired - n0;
    });
    await host.waitForFunction((want) => {
      const s = window.game.netHost.shotStats;
      return Object.values(s).reduce((a, x) => a + x, 0) >= want;
    }, Object.values(s0).reduce((a, x) => a + x, 0) + sent);
    const real = delta(s0, await stats());
    // Six AWM pulls (its 5 rounds, the sixth on an empty magazine) and six AR-01 rounds, each right after a switch.
    assert.equal(sent, 11, 'the member fired 11 rounds (5 AWM, 6 AR-01), switching between each, in a fifth of a second');
    assert.equal(real.rate ?? 0, 0, `none refused for its rate (${JSON.stringify(real)})`);
    // Forged: 6 AWM rounds at once with no switch between (the member's draw count unchanged).
    await member.waitForTimeout(1500);
    const s1 = await stats();
    await member.evaluate(() => {
      const nc = window.game.netClient;
      const p = window.game.player;
      const q = window.game.weapons.drawCount;
      for (let i = 0; i < 10; i++) nc.send({ k: 'shot', w: 'sr01', o: [p.position.x, p.position.y + 1.6, p.position.z], d: [0, 0.6, -0.8], rt: nc.renderTime(), q });
    });
    await host.waitForFunction((b) => Object.values(window.game.netHost.shotStats).reduce((a, x) => a + x, 0) >= b + 10, Object.values(s1).reduce((a, x) => a + x, 0));
    const forged = delta(s1, await stats());
    // At most a magazine's worth (5) bunched together; the rest refused for the AWM's own rate.
    assert.ok((forged.rate ?? 0) >= 5, `a forged burst without switching is cut by the AWM's own rate (${JSON.stringify(forged)})`);
    // Forged switches: a new draw count on every round, 20 at once: no more than the swap allowance gets through.
    await member.waitForTimeout(3000);
    const s2 = await stats();
    await member.evaluate(() => {
      const nc = window.game.netClient;
      const p = window.game.player;
      for (let i = 0; i < 20; i++) nc.send({ k: 'shot', w: 'sr01', o: [p.position.x, p.position.y + 1.6, p.position.z], d: [0, 0.6, -0.8], rt: nc.renderTime(), q: 1000 + i });
    });
    await host.waitForFunction((b) => Object.values(window.game.netHost.shotStats).reduce((a, x) => a + x, 0) >= b + 20, Object.values(s2).reduce((a, x) => a + x, 0));
    const swaps = delta(s2, await stats());
    const judged = (swaps.miss ?? 0) + (swaps.world ?? 0) + (swaps.target ?? 0);
    assert.ok(judged <= 5 + 3 + 1, `forged switches cannot lift the AWM past its burst + the swap allowance (${JSON.stringify(swaps)})`);
    assert.ok((swaps.rate ?? 0) >= 11, JSON.stringify(swaps));
    assert.deepEqual([host.errors, member.errors], [[], []]);
  } finally {
    await host.context().close();
    await member.context().close();
  }
});
