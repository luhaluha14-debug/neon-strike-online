// Phase 29 — every melee weapon kills in one valid hit: the M9 and the two knife items (카람빗, 버터플라이,
// which are the same weapon with another model). The same from the front, the side and the back, through
// armour, on a PC and on a phone, against bots and players, in every mode; reach, walls, the slash rate,
// spawn protection and the host's checks still decide what a valid hit is. Online, the host judges the
// member's slash once (no double kill, no burst of forged slashes).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { startEnv, openGame, installFrameDriver, waitReady, ROOT } from './harness.mjs';
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

async function play(opts) {
  const page = await openGame(env, { width: 640, height: 360, quality: 'low', ...opts });
  // Credits for the knife items (this browser's offline record), as a player who saved up.
  await page.waitForFunction(() => window.game.account);
  await page.evaluate(() => {
    const a = JSON.parse(localStorage.getItem('grid.account.v1'));
    a.credits = 5000;
    localStorage.setItem('grid.account.v1', JSON.stringify(a));
  });
  await page.reload();
  await waitReady(page);
  await page.waitForFunction(() => window.game.account?.credits === 5000);
  if (opts.mobile) await page.tap('.play-button');
  else await page.click('.play-button');
  await page.waitForFunction(() => window.game.input.active);
  await installFrameDriver(page);
  await page.evaluate(() => {
    window.T.stopLoop();
    window.T.run(10);
    const g = window.game;
    // The player is not the subject here: nothing hurts it while it slashes.
    g.combat.protection = 1e9;
  });
  return page;
}

/** Knife in hand (slot 3): the M9, or a knife item bought with credits ('karambit.claw' / 'karambit.butterfly'). */
const holdKnife = (page, skinId) =>
  page.evaluate(async (skinId) => {
    const g = window.game;
    if (skinId) {
      if (!g.account.items.some((i) => i.skinId === skinId)) {
        const r = await g.economy.purchase(skinId);
        if (!r.ok) return `buy ${skinId}: ${r.message ?? r.error}`;
      }
      const item = g.account.items.find((i) => i.skinId === skinId).itemId;
      await g.economy.equip('knife', 'karambit', item);
    } else await g.economy.equip('knife', 'karambit', null);
    g.weapons.equipSlot(g.weapons.loadout.findIndex((w) => w.def.id === 'karambit'));
    window.T.run(40); // drawn
    g.showWeaponModel(g.weapons.weapon.def);
    return `${g.weapons.weapon.def.id}|${g.shownSpec.url}`;
  }, skinId);

/**
 * Puts an alive enemy bot in the open with full armour, facing `facing`, and the player `dist` m away on the
 * side `side` (0 = in front of the bot, π/2 = its side, π = behind it), aiming at its chest. A wall between
 * them when `wall` (then the bot stands behind it).
 */
const stage = async (page, opts = {}) => {
  // The knife ready again (one slash per 0.5 s).
  await page.evaluate(() => window.T.run(36));
  return stageNow(page, opts);
};
const stageNow = (page, { side = 0, dist = 1.2, wall = false, team = null } = {}) =>
  page.evaluate(
    ({ side, dist, wall, team }) => {
      const g = window.game;
      const V = g.player.position.constructor;
      const bot = g.squad.bots.find((b) => b.alive && !b.benched && !b.remote && (!team || b.team !== team));
      if (!bot) return { error: 'no bot alive' };
      const coll = g.map.collision;
      const spots = [...g.map.attackSpawns, ...g.map.defenseSpawns].map((s) => s.position);
      const eyeH = g.player.eyeHeight;
      let place = null;
      let wallDir = null;
      for (const s of spots) {
        const o = new V(s.x, s.y + 1.1, s.z);
        if (!wall) {
          // Open all round within 3 m.
          let open = true;
          for (let i = 0; i < 16 && open; i++) {
            const a = (i / 16) * Math.PI * 2;
            if (coll.raycast(o, new V(-Math.sin(a), 0, -Math.cos(a)), 3) !== null) open = false;
          }
          if (open) {
            place = s;
            break;
          }
        } else {
          // A wall ahead: the player stands 0.6 m in front of it, the bot behind it (1.5 m away in all).
          for (let i = 0; i < 32; i++) {
            const a = (i / 32) * Math.PI * 2;
            const d = new V(-Math.sin(a), 0, -Math.cos(a));
            const h = coll.raycast(o, d, 12);
            if (h === null || h < 1) continue;
            const stand = new V(s.x + d.x * (h - 0.6), s.y, s.z + d.z * (h - 0.6));
            // Thin enough that the bot stands in the open behind it.
            const beyond = new V(stand.x + d.x * 1.5, s.y + 1.1, stand.z + d.z * 1.5);
            if (coll.raycast(beyond, d.clone().negate(), 0.5) !== null) continue;
            place = stand;
            wallDir = a;
            break;
          }
          if (place) break;
        }
      }
      if (!place) return { error: 'no spot' };
      const facing = 0.7;
      let px, pz, bx, bz;
      if (!wall) {
        bx = place.x;
        bz = place.z;
        const a = facing + side; // direction from the bot to the player
        px = bx - Math.sin(a) * dist;
        pz = bz - Math.cos(a) * dist;
      } else {
        px = place.x;
        pz = place.z;
        bx = px - Math.sin(wallDir) * 1.5;
        bz = pz - Math.cos(wallDir) * 1.5;
      }
      bot.controller.position.set(bx, place.y, bz);
      bot.controller.velocity?.set?.(0, 0, 0);
      bot.controller.yaw = facing;
      bot.combat.armor = 100;
      bot.combat.protection = 0;
      const p = g.player;
      p.position.set(px, place.y, pz);
      p.velocity.set(0, 0, 0);
      const dx = bx - px;
      const dz = bz - pz;
      p.yaw = Math.atan2(-dx, -dz);
      p.pitch = Math.atan2(place.y + 1.1 - (place.y + eyeH), Math.hypot(dx, dz));
      return { id: bot.id, dist: Math.hypot(dx, dz) };
    },
    { side, dist, wall, team },
  );

/** One slash (fire held for one frame) and what it did to the bot. */
const slash = (page, botId, frames = 1) =>
  page.evaluate(
    ({ botId, frames }) => {
      const g = window.game;
      const bot = g.squad.bots.find((b) => b.id === botId);
      const poll = g.input.poll.bind(g.input);
      const shots0 = g.weapons.shotsFired;
      // The knife's own result (other bots may be shooting each other meanwhile).
      const ev = g.weapons.events;
      const onShot = ev.onShot;
      const hits = [];
      ev.onShot = (res, ...rest) => {
        hits.push(res.kind === 'target' ? `${res.target.id}:${res.damage}` : res.kind);
        return onShot?.(res, ...rest);
      };
      const line = (g.teamMatch ?? g.match)?.scores?.get('local');
      const kills0 = line?.kills ?? 0;
      const armor0 = bot.combat.armor;
      g.input.poll = (out) => {
        poll(out);
        out.fire = true;
      };
      const deadAt = [];
      for (let i = 0; i < frames; i++) {
        window.T.run(1);
        deadAt.push(!bot.alive);
      }
      g.input.poll = poll;
      ev.onShot = onShot;
      window.T.run(1);
      return {
        hits,
        slashes: g.weapons.shotsFired - shots0,
        dead: !bot.alive,
        deadOnFirstFrame: deadAt[0],
        health: bot.controller.health,
        armor: [armor0, bot.combat.armor],
        kills: (line?.kills ?? 0) - kills0,
      };
    },
    { botId, frames },
  );

test('1. the rule: melee is lethal (a full health bar for every zone and distance in reach), other weapons unchanged; one weapon behind all three knives', async () => {
  const page = await openGame(env, { mode: 'training', width: 480, height: 270 });
  try {
    const r = await page.evaluate(async () => {
      const { computeDamage } = await import('/src/combat/HitscanSystem.ts');
      const { WEAPONS, KARAMBIT, AR_01 } = await import('/src/weapons/weapons.ts');
      const { knifeViewSpec } = await import('/src/weapons/knifeModels.ts');
      const { SLASH_STRIKE } = await import('/src/weapons/view/ViewModelLayer.ts');
      const melee = Object.values(WEAPONS).filter((w) => w.category === 'melee').map((w) => w.id);
      return {
        melee,
        lethal: Object.values(WEAPONS).filter((w) => w.damage.lethal).map((w) => w.id),
        knife: ['head', 'body', 'limb'].flatMap((z) => [0, 1, 1.9].map((d) => computeDamage(KARAMBIT.damage, z, d))),
        ar: computeDamage(AR_01.damage, 'body', 5),
        reach: KARAMBIT.damage.maxRange,
        rate: KARAMBIT.fireRate,
        items: [knifeViewSpec('model:karambit')?.url, knifeViewSpec('model:butterfly')?.url, KARAMBIT.view.url],
        strike: SLASH_STRIKE,
      };
    });
    assert.deepEqual(r.melee, ['karambit'], 'one melee weapon: the M9 (id karambit); the knife items are models of it');
    assert.deepEqual(r.lethal, ['karambit'], 'only melee is lethal');
    assert.ok(r.knife.every((d) => d === 100), r.knife.join());
    assert.equal(r.ar, 24, 'guns unchanged');
    assert.deepEqual([r.reach, r.rate], [1.9, 120], 'reach and slash rate unchanged');
    assert.deepEqual(r.items, ['/weapons/karambit.glb', '/weapons/butterfly.glb', '/weapons/m9_bayonet.glb']);
    assert.ok(r.strike <= 0.07, 'the blade sweeps across within 4 frames of the hit');
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});

test('2. M9, 카람빗, 버터플라이 (PC, deathmatch): one slash kills an armoured bot from the front, the side and the back; armour does not absorb it; the kill counts once', async () => {
  const page = await play({ mode: 'deathmatch' });
  try {
    await page.waitForFunction(() => window.game.account);
    const rows = [];
    for (const [name, skin, url] of [
      ['M9', null, '/weapons/m9_bayonet.glb'],
      ['카람빗', 'karambit.claw', '/weapons/karambit.glb'],
      ['버터플라이', 'karambit.butterfly', '/weapons/butterfly.glb'],
    ]) {
      assert.equal(await holdKnife(page, skin), `karambit|${url}`, name);
      for (const [where, side] of [
        ['front', 0],
        ['side', Math.PI / 2],
        ['back', Math.PI],
      ]) {
        // Bots respawn 3 s after dying: let the dead ones come back before running out.
        await page.evaluate(() => window.game.squad.bots.filter((b) => b.alive).length < 2 && window.T.run(260));
        const s = await stage(page, { side });
        assert.ok(!s.error, s.error);
        const r = await slash(page, s.id);
        rows.push({ name, where, ...r });
        assert.deepEqual(
          { hits: r.hits, slashes: r.slashes, dead: r.dead, firstFrame: r.deadOnFirstFrame, health: r.health, kills: r.kills, armorWorn: r.armor[0] !== r.armor[1] },
          { hits: [`${s.id}:100`], slashes: 1, dead: true, firstFrame: true, health: 0, kills: 1, armorWorn: false },
          `${name} ${where}`,
        );
      }
    }
    assert.equal(rows.length, 9);
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});

test('3. a valid hit only: out of reach (2.4 m) nothing; through a wall nothing; spawn protection holds; one slash per 0.5 s (held fire), and a dead bot is not killed again', async () => {
  const page = await play({ mode: 'deathmatch' });
  try {
    assert.equal(await holdKnife(page, null), 'karambit|/weapons/m9_bayonet.glb');
    // Out of reach.
    let s = await stage(page, { dist: 2.4 });
    let r = await slash(page, s.id);
    assert.deepEqual([r.slashes, r.dead, r.hits.some((h) => h.startsWith(s.id))], [1, false, false], 'out of reach');
    // A wall between.
    s = await stage(page, { wall: true });
    assert.ok(!s.error, s.error);
    r = await slash(page, s.id);
    assert.deepEqual([r.slashes, r.dead, r.hits], [1, false, ['world']], 'through a wall: the wall takes it');
    // Spawn protection (a just respawned bot) still protects.
    await page.evaluate(() => window.T.run(40));
    s = await stage(page, {});
    await page.evaluate((id) => (window.game.squad.bots.find((b) => b.id === id).combat.protection = 1), s.id);
    r = await slash(page, s.id);
    assert.deepEqual([r.slashes, r.dead], [1, false], 'spawn protection');
    // Held fire for 0.4 s: one slash (0.5 s apart), one kill; holding on past the next slash: no second kill.
    await page.evaluate(() => window.T.run(40));
    s = await stage(page, {});
    r = await slash(page, s.id, 24);
    assert.deepEqual([r.slashes, r.dead, r.kills], [1, true, 1], 'one slash in 0.4 s');
    r = await slash(page, s.id, 40);
    assert.deepEqual([r.slashes >= 1, r.kills], [true, 0], 'the dead bot is not killed again');
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});

test('4. team match (live round) and the training range: one slash kills an armoured enemy bot / a dummy; teammates are not hit; a slash on the player kills it through armour too', async () => {
  const page = await play({ mode: 'team' });
  try {
    await page.evaluate(() => {
      const tm = window.game.teamMatch;
      tm.phaseLeft = 0.01;
      window.T.run(3);
    });
    assert.equal(await page.evaluate(() => window.game.teamMatch.phase), 'live');
    await holdKnife(page, null);
    const team = await page.evaluate(() => window.game.localTeam);
    const s = await stage(page, { side: Math.PI, team });
    assert.ok(!s.error, s.error);
    const r = await slash(page, s.id);
    assert.deepEqual([r.dead, r.health, r.kills, r.armor[1]], [true, 0, 1, 100], 'enemy bot, through its armour');
    // The player as the victim: a knife slash at its chest with 100 armour.
    const v = await page.evaluate(async () => {
      const g = window.game;
      const { KARAMBIT } = await import('/src/weapons/weapons.ts');
      g.combat.protection = 0;
      g.combat.armor = 100;
      const p = g.player;
      const V = p.position.constructor;
      const origin = new V(p.position.x + 1.2, p.position.y + 1.6, p.position.z);
      const dir = new V(p.position.x, p.position.y + 1.1, p.position.z).sub(origin).normalize();
      const enemy = g.squad.bots.find((b) => b.team !== g.localTeam);
      const res = g.hitscan.fire({ origin, direction: dir, damage: KARAMBIT.damage, sourceId: enemy.id, weaponId: 'karambit', team: enemy.team });
      return { kind: res.kind, dead: g.combat.dead, health: p.health, armor: g.combat.armor };
    });
    assert.deepEqual(v, { kind: 'target', dead: true, health: 0, armor: 100 }, 'the player: killed through armour by one slash');
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
  // Training range: a dummy in one slash.
  const tr = await play({ mode: 'training' });
  try {
    await holdKnife(tr, null);
    const r = await tr.evaluate(() => {
      const g = window.game;
      const t = g.trainingRange.targets[0];
      const p = g.player;
      const V = p.position.constructor;
      t.motion.sweep = 0;
      t.base.copy(new V(p.position.x, p.position.y, p.position.z - 1.2));
      t['syncMatrices']();
      p.yaw = 0;
      p.pitch = Math.atan2(1.1 - p.eyeHeight, 1.2);
      const poll = g.input.poll.bind(g.input);
      g.input.poll = (out) => {
        poll(out);
        out.fire = true;
      };
      window.T.run(1);
      g.input.poll = poll;
      return { health: t.health, max: t.maxHealth };
    });
    assert.deepEqual(r, { health: 0, max: 100 });
    assert.deepEqual(tr.errors, []);
  } finally {
    await tr.context().close();
  }
});

test('5. a phone: one tap on 발사 with the knife kills an armoured bot (the same rule as the PC)', async () => {
  const page = await play({ mode: 'deathmatch', mobile: true, width: 740, height: 360 });
  try {
    await page.waitForFunction(() => window.game.account);
    assert.equal(await holdKnife(page, 'karambit.butterfly'), 'karambit|/weapons/butterfly.glb');
    const s = await stage(page, { side: Math.PI / 2 });
    assert.ok(!s.error, s.error);
    const f = await fingers(page);
    const fire = await centre(page, '.tc-fire');
    await f.start(1, fire.x, fire.y);
    const r = await page.evaluate((id) => {
      const g = window.game;
      const bot = g.squad.bots.find((b) => b.id === id);
      const n0 = g.weapons.shotsFired;
      window.T.run(1);
      return { slashes: g.weapons.shotsFired - n0, dead: !bot.alive, health: bot.controller.health, armor: bot.combat.armor, aids: g.mobileAids };
    }, s.id);
    await f.end(1);
    assert.deepEqual(r, { slashes: 1, dead: true, health: 0, armor: 100, aids: true });
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});

// --- online ---------------------------------------------------------------------------------------

test('6. a room (real relay): the member\'s slash kills the armoured host in one hit, judged by the host, counted once; a second slash on the body does nothing; a burst of forged slashes is cut to two', async () => {
  const host = await openGame(env, { mode: 'deathmatch', width: 480, height: 270 });
  const member = await openGame(env, { mode: 'training', width: 480, height: 270 });
  for (const p of [host, member]) p.setDefaultTimeout(60000);
  let pin = null;
  try {
    await host.click('#tab-multi');
    await host.fill('.mp-name', 'Host');
    await host.selectOption('.mp-mode', 'deathmatch');
    await host.click('.mp-create');
    await host.waitForFunction(() => window.game.netHost && window.game.match && window.game.squad);
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
    // The member draws its knife; the host stands 1.2 m in front of the member's character, armoured.
    await member.evaluate(() => {
      const g = window.game;
      g.weapons.equipSlot(g.weapons.loadout.findIndex((w) => w.def.id === 'karambit'));
    });
    await member.waitForTimeout(600);
    await host.waitForFunction(() => window.game.squad.bots.some((b) => b.remote && b.alive));
    const placed = await host.evaluate(() => {
      const g = window.game;
      const b = g.squad.bots.find((x) => x.remote);
      const c = b.controller.position;
      g.combat.protection = 0;
      g.combat.armor = 100;
      g.player.position.set(c.x, c.y, c.z - 1.2);
      g.player.velocity.set(0, 0, 0);
      const line = g.match.scores.get(b.id);
      return { hostWire: g.netHost.wire('local'), memberBot: b.id, hostKills: g.match.scores.get('local').kills, memberKills: line?.kills ?? 0 };
    });
    // Hold the host there; the member aims at the host's character as it sees it and slashes once.
    pin = setInterval(() => host.evaluate((id) => {
      const g = window.game;
      const c = g.squad.bots.find((x) => x.id === id).controller.position;
      if (!g.combat.dead) {
        g.player.position.set(c.x, c.y, c.z - 1.2);
        g.player.velocity.set(0, 0, 0);
      }
    }, placed.memberBot).catch(() => {}), 50);
    await member.waitForTimeout(800);
    await member.waitForFunction((id) => {
      const g = window.game;
      const q = g.netClient.puppets.all.get(id);
      return q && q.alive && q.position.distanceTo(g.player.position) < 1.6;
    }, placed.hostWire);
    const swung = await member.evaluate((id) => {
      const g = window.game;
      const nc = g.netClient;
      const hostPuppet = nc.puppets.all.get(id);
      const p = g.player;
      const dx = hostPuppet.position.x - p.position.x;
      const dz = hostPuppet.position.z - p.position.z;
      p.yaw = Math.atan2(-dx, -dz);
      p.pitch = Math.atan2(hostPuppet.position.y + 1.1 - (p.position.y + p.eyeHeight), Math.hypot(dx, dz));
      const poll = g.input.poll.bind(g.input);
      let n = 0;
      g.input.poll = (out) => {
        poll(out);
        if (n++ < 1) out.fire = true;
      };
      return { dist: Math.hypot(dx, dz), weapon: g.weapons.weapon.def.id };
    }, placed.hostWire);
    assert.equal(swung.weapon, 'karambit');
    assert.ok(swung.dist < 1.8, `in reach (${swung.dist.toFixed(2)} m)`);
    await host.waitForFunction(() => window.game.combat.dead, null, { timeout: 10000 });
    clearInterval(pin);
    await member.evaluate(() => {
      const g = window.game;
      g.input.poll = Object.getPrototypeOf(g.input).poll.bind(g.input);
    });
    const after1 = await host.evaluate((id) => {
      const g = window.game;
      return { dead: g.combat.dead, health: g.player.health, armor: g.combat.armor, deaths: g.match.scores.get('local').deaths, memberKills: g.match.scores.get(id)?.kills ?? 0, stats: { ...g.netHost.shotStats } };
    }, placed.memberBot);
    assert.deepEqual([after1.dead, after1.health, after1.armor, after1.deaths, after1.memberKills - placed.memberKills], [true, 0, 100, 1, 1], JSON.stringify(after1));
    // The member's screen: its kill once.
    await member.waitForFunction(() => (window.game.match.scores.get('local')?.kills ?? 0) >= 1);
    // A second slash on the body (0.6 s later, a valid rate): no second kill.
    await member.evaluate(async () => {
      const g = window.game;
      const nc = g.netClient;
      const o = g.player.position.clone();
      o.y += g.player.eyeHeight;
      const V = o.constructor;
      const d = new V(-Math.sin(g.player.yaw), Math.sin(g.player.pitch), -Math.cos(g.player.yaw)).normalize();
      await new Promise((r) => setTimeout(r, 600));
      nc.reportShot?.('karambit', o, d) ?? nc.send({ k: 'shot', w: 'karambit', o: [o.x, o.y, o.z], d: [d.x, d.y, d.z], rt: nc.renderTime() });
    });
    await host.waitForTimeout(800);
    const after2 = await host.evaluate((id) => ({ deaths: window.game.match.scores.get('local').deaths, memberKills: window.game.match.scores.get(id)?.kills ?? 0 }), placed.memberBot);
    assert.deepEqual([after2.deaths, after2.memberKills - placed.memberKills], [1, 1], 'no double kill');
    // Forged: six slashes sent at once; the host takes at most two.
    const before = await host.evaluate(() => ({ ...window.game.netHost.shotStats }));
    await member.evaluate(() => {
      const nc = window.game.netClient;
      const p = window.game.player;
      for (let i = 0; i < 6; i++) nc.send({ k: 'shot', w: 'karambit', o: [p.position.x, p.position.y + 1.6, p.position.z], d: [0, 0, -1], rt: nc.renderTime() });
    });
    await host.waitForFunction((b) => {
      const s = window.game.netHost.shotStats;
      const sum = (o) => Object.values(o).reduce((a, x) => a + x, 0);
      return sum(s) - sum(b) >= 6;
    }, before);
    const delta = await host.evaluate((b) => {
      const s = window.game.netHost.shotStats;
      const out = {};
      for (const k of new Set([...Object.keys(s), ...Object.keys(b)])) out[k] = (s[k] ?? 0) - (b[k] ?? 0);
      return out;
    }, before);
    const judged = (delta.miss ?? 0) + (delta.world ?? 0) + (delta.target ?? 0);
    assert.ok(judged <= 2 && (delta.rate ?? 0) >= 4, JSON.stringify(delta));
    assert.deepEqual([host.errors, member.errors], [[], []]);
  } finally {
    clearInterval(pin);
    await host.context().close();
    await member.context().close();
  }
});
