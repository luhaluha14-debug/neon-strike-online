// Phase 24 arsenal in the team match: buying and choosing the new weapons (each its own item, next to the
// first ones), and a member's new weapons online through the real relay (host authority: the host checks
// each round against what the member bought, resolves the hits and credits the kill with the weapon).
//   9. buy menu with the mouse: the cards, prices and specs from the weapon definitions; LMG-02 (MG5)
//      listed but locked until its model is delivered; buying replaces the slot; number keys draw them
//  10. online: a member buys LMG-01 + PIS-02 from the host and fires both at the host player; the host
//      accepts every round (none refused as a weapon not bought), the damage lands, the kill is credited
//      as an LMG-01 kill on both sides and the kill feed names it

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

test('9. buy menu (mouse): the new weapons are their own cards with their real stats and prices; LMG-02 locked (model pending); buying replaces the slot; keys 1 / 2 draw them', async () => {
  const page = await openGame(env, { map: 'warehouse', mode: 'team', objective: 'elimination', width: 1280, height: 720 });
  try {
    await page.click('.play-button');
    await page.waitForFunction(() => window.game.input.active && document.pointerLockElement !== null);
    await installFrameDriver(page);
    await page.evaluate(() => {
      window.T.stopLoop();
      // Enough money for everything this test buys.
      window.game.teamMatch.economy.credit('local', 16000);
    });
    const cards = await page.evaluate(() =>
      Object.fromEntries(
        [...document.querySelectorAll('.buy-card')].map((c) => [c.dataset.id, { spec: c.querySelector('.buy-spec').textContent, price: c.querySelector('.buy-price').textContent, locked: c.classList.contains('locked') || c.dataset.state === 'locked' || c.getAttribute('aria-disabled') === 'true' }]),
      ),
    );
    for (const id of ['AR-01', 'SMG-01', 'SR-01', 'SG-01', 'PIS-01', 'AR-02', 'SMG-02', 'DMR-01', 'LMG-01', 'LMG-02', 'PIS-02']) assert.ok(cards[id], `card ${id}`);
    assert.match(cards['AR-02'].spec, /30 \/ 90발 · 자동 · 700 RPM · 피해 23/);
    assert.match(cards['SMG-02'].spec, /25 \/ 100발 · 자동 · 650 RPM · 피해 27/);
    assert.match(cards['DMR-01'].spec, /20 \/ 60발 · 반자동 · 200 RPM · 피해 58/);
    assert.match(cards['LMG-01'].spec, /100 \/ 200발 · 자동 · 750 RPM · 피해 22/);
    assert.match(cards['PIS-02'].spec, /15 \/ 45발 · 반자동 · 340 RPM · 피해 25/);
    assert.match(cards['LMG-02'].spec, /모델 준비 중/);
    assert.match(cards['DMR-01'].price, /4,000/);
    assert.match(cards['LMG-01'].price, /5,200/);

    await page.keyboard.press('KeyB');
    await page.waitForFunction(() => !document.querySelector('.buy-menu').hidden);
    const buyCard = async (id) => {
      await page.click(`.buy-card[data-id="${id}"]`);
      await page.evaluate(() => window.T.run(2));
      return page.evaluate(() => ({ money: window.game.teamMatch.economy.money('local'), weapons: window.game.weapons.loadout.map((w) => w.def.id), primary: window.game.buyLoadout.primary?.id ?? null, secondary: window.game.buyLoadout.secondary?.id ?? null }));
    };
    const m0 = await page.evaluate(() => window.game.teamMatch.economy.money('local'));
    // LMG-02: shown, not sold.
    const locked = await buyCard('LMG-02');
    assert.equal(locked.money, m0, 'nothing paid for LMG-02');
    assert.ok(!locked.weapons.includes('lmg02'));
    // Each new weapon is its own choice in its slot (the first ones stay what they are).
    for (const [id, weapon] of [['DMR-01', 'dmr01'], ['AR-02', 'ar02'], ['SMG-01', 'smg01'], ['SMG-02', 'smg02'], ['LMG-01', 'lmg01']]) {
      const r = await buyCard(id);
      assert.equal(r.primary, id, `${id} is the primary`);
      assert.equal(r.weapons[0], weapon, `${id}: ${weapon} issued`);
    }
    const sec = await buyCard('PIS-02');
    assert.equal(sec.secondary, 'PIS-02');
    assert.deepEqual(sec.weapons, ['lmg01', 'pis02', 'karambit']);
    // Out of the menu: the number keys draw them.
    await page.keyboard.press('KeyB');
    await page.waitForFunction(() => document.querySelector('.buy-menu').hidden);
    await page.click('canvas');
    await page.waitForFunction(() => window.game.input.active);
    const draw = async (k) => {
      await page.keyboard.press(String(k));
      return page.evaluate(() => {
        for (let i = 0; i < 120; i++) window.T.run(1);
        return window.game.weapons.weapon.def.id;
      });
    };
    assert.equal(await draw(2), 'pis02');
    assert.equal(await draw(1), 'lmg01');
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
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

test('10. online: a member buys LMG-01 + PIS-02 from the host; the host takes every round as the bought weapon, the damage lands, the kill is an LMG-01 kill on both sides', async () => {
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
    await play(host);
    await play(guest);
    const botId = await host.evaluate(() => window.game.squad.bots.find((b) => b.remote).id);
    // The host's money rules: the member gets enough for both, then buys through the host.
    await host.evaluate((id) => window.game.teamMatch.economy.credit(id, 16000), botId);
    await guest.evaluate(() => window.game.buy('LMG-01'));
    await guest.waitForFunction(() => window.game.weapons.loadout.some((w) => w.def.id === 'lmg01'));
    await guest.evaluate(() => window.game.buy('PIS-02'));
    await guest.waitForFunction(() => window.game.weapons.loadout.some((w) => w.def.id === 'pis02'));
    for (const p of [host, guest]) {
      await installFrameDriver(p);
      await p.evaluate(() => window.T.stopLoop());
    }
    const hostWire = await host.evaluate(() => window.game.net.id);
    await host.evaluate(() => {
      const g = window.game;
      while (g.teamMatch.phase !== 'live') window.T.run(1);
      for (const b of g.squad.bots) if (!b.remote) b.combat.applyDamage({ amount: 999, zone: 'body', sourceId: 'test', weaponId: 'test', point: b.position.clone(), direction: b.position.clone().set(0, 0, 1), distance: 1 });
      g.combat.protection = 0;
      g.player.health = 1000;
    });
    for (let i = 0; i < 100 && (await guest.evaluate(() => (window.T.run(2), window.game.teamMatch.phase))) !== 'live'; i++) {
      await host.evaluate(() => window.T.run(15));
      await guest.waitForTimeout(100);
    }
    assert.equal(await guest.evaluate(() => window.game.teamMatch.phase), 'live');
    // The member's character 8 m from the host player, facing it.
    const placed = await host.evaluate((id) => {
      const g = window.game;
      const p = g.player.position;
      const bot = g.squad.bots.find((b) => b.id === id);
      const V = p.constructor;
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2;
        const at = new V(p.x + Math.sin(a) * 8, p.y, p.z + Math.cos(a) * 8);
        const down = g.map.collision.raycast(new V(at.x, at.y + 1, at.z), new V(0, -1, 0), 3);
        if (down === null) continue;
        at.y = at.y + 1 - down;
        const eye = new V(at.x, at.y + 1.6, at.z);
        const chest = new V(p.x, p.y + 1.2, p.z);
        const dir = chest.clone().sub(eye);
        const len = dir.length();
        if (g.map.collision.raycast(eye, dir.normalize(), len) !== null) continue;
        bot.spawn(at, Math.atan2(-(p.x - at.x), -(p.z - at.z)));
        return true;
      }
      return false;
    }, botId);
    assert.ok(placed, 'a clear spot 8 m away');
    await guest.waitForTimeout(400);
    await host.evaluate(() => window.T.run(4));
    await guest.waitForTimeout(300);
    const aim = async () =>
      guest.evaluate((w) => {
        const g = window.game;
        window.T.run(2);
        const t = g.netClient.puppets.all.get(w).position;
        const p = g.player;
        const dx = t.x - p.position.x;
        const dz = t.z - p.position.z;
        p.yaw = Math.atan2(-dx, -dz);
        p.pitch = Math.atan2(t.y + 1.2 - (p.position.y + p.eyeHeight), Math.hypot(dx, dz));
      }, hostWire);
    const fire = async (slot, frames, hold) => {
      await guest.evaluate(
        ([slot, frames, hold]) => {
          const g = window.game;
          g.weapons.equipSlot(slot);
          while (g.weapons.weapon.status !== 'ready') window.T.run(1);
          window.T.shots0 = g.weapons.shotsFired;
          for (let i = 0; i < frames; i++) {
            g.input.mouseButtons = hold || i % 12 < 2 ? 1 : 0;
            window.T.run(1);
          }
          g.input.mouseButtons = 0;
          window.T.run(1);
        },
        [slot, frames, hold],
      );
      await guest.waitForTimeout(300);
      await host.evaluate(() => window.T.run(3));
      await guest.waitForTimeout(300);
      return guest.evaluate(() => ({ weapon: window.game.weapons.weapon.def.id, rounds: window.game.weapons.shotsFired - window.T.shots0 }));
    };
    const stats = () => host.evaluate(() => ({ ...window.game.netHost.shotStats, hp: window.game.combat.health }));
    await aim();
    const s0 = await stats();
    // LMG-01: a 0.8 s burst (48 frames, ~10 rounds at 750 RPM).
    const lmg = await fire(0, 48, true);
    const s1 = await stats();
    assert.equal(lmg.weapon, 'lmg01');
    assert.ok(lmg.rounds >= 8, `LMG-01 burst: ${lmg.rounds} rounds`);
    assert.equal(s1.weapon ?? 0, 0, 'no round refused as a weapon not bought');
    assert.ok((s1.target ?? 0) - (s0.target ?? 0) >= 3, `LMG-01 rounds hit the host (${(s1.target ?? 0) - (s0.target ?? 0)})`);
    assert.ok(s1.hp < s0.hp, `damage on the host (${s0.hp} → ${s1.hp})`);
    // PIS-02: aimed single shots.
    await aim();
    const pis = await fire(1, 48, false);
    const s2 = await stats();
    assert.equal(pis.weapon, 'pis02');
    assert.ok(pis.rounds >= 3, `PIS-02: ${pis.rounds} rounds`);
    assert.equal(s2.weapon ?? 0, 0, 'PIS-02 rounds accepted');
    assert.ok((s2.target ?? 0) > (s1.target ?? 0), 'PIS-02 rounds hit');
    // The kill with the LMG-01.
    await host.evaluate(() => (window.game.player.health = 30));
    await aim();
    await fire(0, 20, true);
    await guest.waitForTimeout(300);
    await host.evaluate(() => window.T.run(3));
    await guest.waitForTimeout(400);
    await guest.evaluate(() => window.T.run(3));
    const hostSide = await host.evaluate((id) => ({ alive: window.game.combat.alive, kills: window.game.teamMatch.scores.get(id).kills, feed: window.game.teamMatch.feed.filter((f) => f.killer === id).map((f) => f.weaponId) }), botId);
    const guestSide = await guest.evaluate(() => ({ kills: window.game.teamMatch.scores.get('local').kills, feed: window.game.teamMatch.feed.filter((f) => f.killer === 'local').map((f) => f.weaponId), text: (window.T.run(2), [...document.querySelectorAll('.killfeed')].map((e) => e.textContent).join(' | ')) }));
    assert.equal(hostSide.alive, false, 'the host player is down');
    assert.deepEqual({ kills: hostSide.kills, feed: hostSide.feed }, { kills: 1, feed: ['lmg01'] });
    assert.deepEqual({ kills: guestSide.kills, feed: guestSide.feed }, { kills: 1, feed: ['lmg01'] }, 'the member sees the same kill');
    assert.match(guestSide.text, /LMG-01/, `the kill feed names LMG-01 (${guestSide.text})`);
    assert.deepEqual(host.errors, []);
    assert.deepEqual(guest.errors, []);
  } finally {
    await host.context().close();
    await guest.context().close();
  }
});
