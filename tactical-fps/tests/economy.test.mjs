// Team match round economy and buy menu: money, prices and rewards (once
// per round / kill), the buy phase (작전 준비) with its own clock, buying
// through the real menu with the mouse, the bought gear issued to the real
// weapon system, gear reset / money carried over between rounds, the
// pointer lock and controls restored, and no economy outside the team match.
// Frames are driven at fixed 1/60 s with the real loop stopped.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, openGame, installFrameDriver } from './harness.mjs';

let env;
let page;

/** Waits until the canvas holds the pointer lock, the game has taken it (input active) and the HUD is in play. */
async function waitLocked() {
  await page.waitForFunction(
    () => document.pointerLockElement === window.game.renderer.domElement && window.game.input.active && document.querySelector('.hud').classList.contains('playing'),
  );
}

/** Opens the buy menu the way a player does: B while playing. */
async function openBuy() {
  await page.keyboard.press('KeyB');
  await page.waitForFunction(() => !document.querySelector('.buy-menu').hidden && !document.pointerLockElement && !window.game.input.active);
}

before(async () => {
  env = await startEnv();
  page = await openGame(env, { map: 'warehouse', mode: 'team' });
  await page.click('.play-button');
  await waitLocked();
  await page.mouse.move(0, 0);
  await installFrameDriver(page);
  await page.evaluate(() => {
    window.T.stopLoop();
    const g = window.game;
    const T = window.T;
    T.V = g.player.position.constructor;
    T.kill = (target, by = 'test') => {
      target.protection = 0;
      target.applyDamage({ amount: 999, zone: 'body', sourceId: by, weaponId: 'ar01', point: new T.V(), direction: new T.V(0, 0, 1), distance: 5 });
    };
    T.until = (phase, max = 2400) => {
      let n = 0;
      while (g.teamMatch.phase !== phase && n < max) {
        T.run(1);
        n++;
      }
      return n;
    };
    T.money = (id = 'local') => g.teamMatch.economy.money(id);
    T.gear = () => ({
      primary: g.buyLoadout.primary?.id ?? null,
      secondary: g.buyLoadout.secondary?.id ?? null,
      melee: g.buyLoadout.melee.id,
      weapons: g.weapons.loadout.map((w) => w.def.id),
      inHand: g.weapons.weapon.def.id,
    });
    T.reds = () => g.squad.bots.filter((b) => b.team === 'red');
    T.blues = () => g.squad.bots.filter((b) => b.team === 'blue');
    // The real loop ran for a moment after Play; start from a fresh match now that frames are driven by the test.
    g.restartMatch();
  });
});
after(async () => {
  await page?.context().close();
  await env?.close();
});

test('start: $3,000 for everyone, the knife issued for free, the buy phase open on its own clock', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const tm = g.teamMatch;
    return {
      phase: tm.phase,
      buyOpen: tm.buyOpen,
      buyTime: tm.phaseLeft,
      roundClock: tm.roundTimeLeft,
      money: [...tm.scores.keys()].map((id) => tm.economy.money(id)),
      gear: window.T.gear(),
      cfg: { ...tm.economy.config },
    };
  });
  assert.equal(r.phase, 'prep');
  assert.equal(r.buyOpen, true);
  assert.equal(r.buyTime, 15, 'buy time');
  assert.equal(r.roundClock, 120, 'the round clock does not run during the buy time');
  assert.deepEqual(r.money, Array(10).fill(3000));
  assert.deepEqual(r.gear, { primary: null, secondary: null, melee: 'Knife', weapons: ['karambit'], inHand: 'karambit' });
  assert.deepEqual(
    [r.cfg.startMoney, r.cfg.winReward, r.cfg.lossBase, r.cfg.killBonus, r.cfg.maxMoney, r.cfg.buyTime],
    [3000, 3000, 1900, 200, 16000, 15],
  );
});

test('buy menu: B opens it without pausing, the mouse is free, view and trigger stay still; all catalog items are listed', async () => {
  const before = await page.evaluate(() => ({ yaw: window.game.player.yaw, pitch: window.game.player.pitch, shots: window.game.weapons.shotsFired }));
  await openBuy();
  // Mouse moves and a click on a non-interactive part of the menu (its title) do not reach the game.
  const title = await page.locator('.buy-title').boundingBox();
  await page.mouse.move(title.x + 5, title.y + 5);
  await page.mouse.move(title.x + title.width / 2, title.y + title.height / 2, { steps: 5 });
  await page.mouse.down();
  await page.mouse.up();
  await page.evaluate(() => window.T.run(30));
  const r = await page.evaluate(() => {
    const g = window.game;
    const cards = [...document.querySelectorAll('.buy-card')].map((c) => ({
      id: c.dataset.id,
      state: c.dataset.state,
      price: c.querySelector('.buy-price').textContent,
      tag: c.querySelector('.buy-tag').textContent,
    }));
    return {
      open: g.buyMenuOpen,
      paused: !document.querySelector('.hud').classList.contains('playing'),
      yaw: g.player.yaw,
      pitch: g.player.pitch,
      shots: g.weapons.shotsFired,
      buyClock: g.teamMatch.phaseLeft,
      money: document.querySelector('.buy-money').textContent,
      time: document.querySelector('.buy-time').textContent,
      loadout: document.querySelector('.buy-loadout').textContent,
      sections: [...document.querySelectorAll('.buy-section-title')].map((h) => h.textContent),
      cards,
    };
  });
  assert.equal(r.open, true);
  assert.equal(r.paused, false, 'opening the buy menu is not a pause');
  assert.equal(r.yaw, before.yaw, 'no view rotation from the free mouse');
  assert.equal(r.pitch, before.pitch);
  assert.equal(r.shots, before.shots, 'no shot from clicks on the menu');
  assert.ok(r.buyClock < 14.5, 'the buy clock keeps running behind the menu');
  assert.equal(r.money, '$3,000');
  assert.match(r.time, /^0:1[0-5]$/, 'buy time left, rounded up');
  assert.deepEqual(r.sections, ['주무기', '보조무기', '근접', '전술 장비']);
  assert.match(r.loadout, /주무기없음.*보조무기없음.*근접Knife/);
  const byId = Object.fromEntries(r.cards.map((c) => [c.id, c]));
  assert.deepEqual(Object.keys(byId).sort(), ['AR-01', 'ARMOR-01', 'FLASH-01', 'Knife', 'PIS-01', 'SG-01', 'SMG-01', 'SMOKE-01', 'SR-01']);
  assert.deepEqual([byId['AR-01'].price, byId['AR-01'].state, byId['AR-01'].tag], ['$2,700', 'buyable', '구매']);
  assert.deepEqual([byId['SR-01'].price, byId['SR-01'].state, byId['SR-01'].tag], ['$4,750', 'short', '자금 부족']);
  assert.deepEqual([byId.Knife.price, byId.Knife.state, byId.Knife.tag], ['무료', 'issued', '기본 지급']);
  // Every listed item has its game system now: all on sale (grenades show the count carried / the limit).
  for (const id of ['SMG-01', 'SG-01', 'PIS-01', 'ARMOR-01']) assert.deepEqual([byId[id].state, byId[id].tag], ['buyable', '구매'], id);
  assert.deepEqual([byId['FLASH-01'].state, byId['FLASH-01'].tag], ['buyable', '구매 (0/2)']);
  assert.deepEqual([byId['SMOKE-01'].state, byId['SMOKE-01'].tag], ['buyable', '구매 (0/1)']);
  assert.deepEqual(
    ['SMG-01', 'SG-01', 'PIS-01', 'ARMOR-01', 'FLASH-01', 'SMOKE-01'].map((id) => byId[id].price),
    ['$1,500', '$2,000', '$500', '$650', '$300', '$400'],
  );
});

test('buying: not enough money is refused with the reason and changes nothing; AR-01 costs exactly $2,700 and is issued', async () => {
  // Hover shows the balance after buying.
  await page.hover('.buy-card[data-id="AR-01"]');
  const after = await page.evaluate(() => document.querySelector('.buy-after').textContent);
  assert.equal(after, '구매 후 $300');
  // SR-01 ($4,750) with $3,000: refused.
  await page.click('.buy-card[data-id="SR-01"]');
  const refused = await page.evaluate(() => ({ money: window.T.money(), gear: window.T.gear(), fb: document.querySelector('.buy-feedback').textContent, err: document.querySelector('.buy-feedback').classList.contains('error') }));
  assert.equal(refused.money, 3000);
  assert.deepEqual(refused.gear, { primary: null, secondary: null, melee: 'Knife', weapons: ['karambit'], inHand: 'karambit' });
  assert.equal(refused.fb, '자금 부족: SR-01 $4,750 (부족 $1,750)');
  assert.equal(refused.err, true);
  // A locked item cannot be bought either (SMG-01 locked for this check only, then restored).
  await page.evaluate(async () => {
    const { findItem } = await import('/src/weapons/catalog.ts');
    const smg = findItem('SMG-01');
    window.T.unlock = { available: smg.available, lockedReason: smg.lockedReason };
    smg.available = false;
    smg.lockedReason = '준비 중: 테스트';
  });
  await page.click('.buy-card[data-id="SMG-01"]');
  const locked = await page.evaluate(async () => {
    const { findItem } = await import('/src/weapons/catalog.ts');
    Object.assign(findItem('SMG-01'), window.T.unlock);
    return { money: window.T.money(), primary: window.T.gear().primary, fb: document.querySelector('.buy-feedback').textContent };
  });
  assert.deepEqual(locked, { money: 3000, primary: null, fb: 'SMG-01: 준비 중: 테스트' });
  // AR-01.
  await page.click('.buy-card[data-id="AR-01"]');
  await page.evaluate(() => window.T.run(2));
  const bought = await page.evaluate(() => {
    const g = window.game;
    const w = g.weapons.loadout[0];
    return {
      money: window.T.money(),
      gear: window.T.gear(),
      mag: [w.magazine, w.reserve],
      fb: document.querySelector('.buy-feedback').textContent,
      shown: document.querySelector('.buy-money').textContent,
      card: document.querySelector('.buy-card[data-id="AR-01"]').dataset.state,
      hudSlots: [...document.querySelectorAll('.loadout .slot')].map((s) => s.textContent),
    };
  });
  assert.equal(bought.money, 300);
  assert.equal(bought.shown, '$300');
  assert.deepEqual(bought.gear, { primary: 'AR-01', secondary: null, melee: 'Knife', weapons: ['ar01', 'karambit'], inHand: 'ar01' });
  assert.deepEqual(bought.mag, [30, 90], 'the issued AR-01 is the real one: 30 / 90');
  assert.equal(bought.fb, 'AR-01 구매 완료 (-$2,700)');
  assert.equal(bought.card, 'owned');
  assert.deepEqual(bought.hudSlots, ['1 AR-01', '3 M9 BAYONET'], 'number keys: 1 primary, 3 knife');
  // Buying it again: refused, nothing changes.
  await page.click('.buy-card[data-id="AR-01"]');
  const again = await page.evaluate(() => ({ money: window.T.money(), weapons: window.T.gear().weapons, fb: document.querySelector('.buy-feedback').textContent }));
  assert.deepEqual(again, { money: 300, weapons: ['ar01', 'karambit'], fb: 'AR-01: 이미 보유한 장비입니다' });
  // Replacing it with SR-01 needs $4,750 - $2,700 refund = $2,050 > $300: refused, AR-01 kept.
  await page.click('.buy-card[data-id="SR-01"]');
  const noSwap = await page.evaluate(() => ({ money: window.T.money(), gear: window.T.gear() }));
  assert.equal(noSwap.money, 300);
  assert.equal(noSwap.gear.primary, 'AR-01');
  assert.deepEqual(noSwap.gear.weapons, ['ar01', 'karambit']);
});

test('one primary: another primary replaces it (refunded when bought this round); one secondary at most', async () => {
  const r = await page.evaluate(async () => {
    const g = window.game;
    const eco = g.teamMatch.economy;
    eco.credit('local', 5000); // $5,300
    const swap = g.buy('SR-01');
    const afterSwap = { money: window.T.money(), gear: window.T.gear(), fb: document.querySelector('.buy-feedback').textContent };
    const back = g.buy('AR-01');
    const afterBack = { money: window.T.money(), gear: window.T.gear() };
    // Secondary: PIS-01, once.
    const first = g.buy('PIS-01');
    const second = g.buy('PIS-01');
    const pis = g.weapons.loadout.find((w) => w.def.id === 'pis01');
    const withSecondary = {
      money: window.T.money(),
      gear: window.T.gear(),
      entries: g.buyLoadout.weapons().map((e) => e.item.id),
      pisAmmo: pis && [pis.magazine, pis.reserve],
      hudSlots: [...document.querySelectorAll('.loadout .slot')].map((s) => s.textContent),
    };
    g.buy('AR-01'); // already held: no-op
    return { swap: swap.ok, afterSwap, back: back.ok, afterBack, first: first.ok, second: second.reason, withSecondary, finalMoney: window.T.money() };
  });
  assert.equal(r.swap, true);
  assert.equal(r.afterSwap.money, 5300 + 2700 - 4750);
  assert.equal(r.afterSwap.fb, 'SR-01 구매 (AR-01 환불, -$2,050)');
  assert.deepEqual([r.afterSwap.gear.primary, r.afterSwap.gear.weapons], ['SR-01', ['sr01', 'karambit']]);
  assert.equal(r.back, true);
  assert.equal(r.afterBack.money, 5300, 'swapping back refunds SR-01 and charges AR-01');
  assert.deepEqual(r.afterBack.gear.weapons, ['ar01', 'karambit']);
  assert.equal(r.first, true);
  assert.equal(r.second, 'owned', 'the same secondary twice is refused');
  assert.deepEqual(r.withSecondary.entries, ['AR-01', 'PIS-01', 'Knife'], 'one primary, one secondary, the knife');
  assert.deepEqual(r.withSecondary.gear.weapons, ['ar01', 'pis01', 'karambit']);
  assert.deepEqual(r.withSecondary.pisAmmo, [12, 36], 'the real PIS-01: 12 / 36');
  assert.deepEqual(r.withSecondary.hudSlots, ['1 AR-01', '2 PIS-01', '3 M9 BAYONET']);
  assert.equal(r.withSecondary.money, 4800);
  assert.equal(r.finalMoney, 4800);
});

test('closing the menu re-captures the mouse; controls unchanged; keys 1 / 3 pick primary / knife', async () => {
  const controls0 = await page.evaluate(() => ({ s: window.game.input.sensitivity, b: { ...window.game.input.bindings } }));
  await page.click('.buy-close');
  await waitLocked();
  const r = await page.evaluate(() => ({ open: window.game.buyMenuOpen, hidden: document.querySelector('.buy-menu').hidden, s: window.game.input.sensitivity, b: { ...window.game.input.bindings } }));
  assert.equal(r.open, false);
  assert.equal(r.hidden, true);
  assert.equal(r.s, controls0.s);
  assert.deepEqual(r.b, controls0.b);
  // Still the buy phase: frozen. Keys pick weapons by role.
  await page.keyboard.press('Digit3');
  await page.evaluate(() => window.T.run(2));
  const knife = await page.evaluate(() => window.game.weapons.weapon.def.id);
  await page.keyboard.press('Digit2');
  await page.evaluate(() => window.T.run(2));
  const pistol = await page.evaluate(() => window.game.weapons.weapon.def.id);
  await page.keyboard.press('Digit1');
  await page.evaluate(() => window.T.run(2));
  const rifle = await page.evaluate(() => window.game.weapons.weapon.def.id);
  assert.deepEqual([knife, pistol, rifle], ['karambit', 'pis01', 'ar01']);
  // Esc out of the buy menu lands on the normal pause menu; Play resumes.
  await openBuy();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('.buy-menu').hidden && !document.querySelector('.hud').classList.contains('playing'));
  await page.click('.play-button');
  await waitLocked();
});

test('the buy phase ends on its clock: the round goes live, buying is closed, the bought rifle really fires', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    const frames = T.until('live');
    const tm = g.teamMatch;
    const late = g.buy('AR-01');
    const lateSr = g.buy('SR-01');
    return { frames, phase: tm.phase, buyOpen: tm.buyOpen, clock: tm.roundTimeLeft, late: late.reason, lateSr: lateSr.reason, money: T.money(), gear: T.gear(), menuOpen: g.buyMenuOpen };
  });
  assert.equal(r.phase, 'live');
  assert.equal(r.buyOpen, false);
  assert.ok(r.clock > 119.9, `round clock starts at 2:00 when the round goes live (${r.clock})`);
  assert.deepEqual([r.late, r.lateSr], ['phase', 'phase'], 'no buying after the round started');
  assert.equal(r.money, 4800, 'the $4,800 left after the slot checks');
  assert.equal(r.gear.inHand, 'ar01');
  assert.equal(r.menuOpen, false);
  // Fire the bought AR-01 with the real mouse.
  const before = await page.evaluate(() => ({ shots: window.game.weapons.shotsFired, mag: window.game.weapons.weapon.magazine }));
  await page.mouse.down();
  await page.evaluate(() => window.T.run(30));
  await page.mouse.up();
  await page.evaluate(() => window.T.run(2));
  const fired = await page.evaluate(() => ({ shots: window.game.weapons.shotsFired, mag: window.game.weapons.weapon.magazine, id: window.game.weapons.weapon.def.id }));
  assert.ok(fired.shots - before.shots >= 4, `fired ${fired.shots - before.shots} rounds`);
  assert.equal(before.mag - fired.mag, fired.shots - before.shots, 'one round off the magazine per shot');
  assert.equal(fired.id, 'ar01');
  // B does nothing once the round is live.
  await page.keyboard.press('KeyB');
  await page.evaluate(() => window.T.run(2));
  assert.equal(await page.evaluate(() => window.game.buyMenuOpen), false);
});

test('round won: $3,000 + $200 per enemy killed, paid exactly once; next round: the survivor keeps gear and ammo, money kept', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    const tm = g.teamMatch;
    const m0 = T.money();
    const ally0 = T.money(T.blues()[0].id);
    const reds = T.reds();
    // Two enemies by the player, the rest by a teammate.
    T.kill(reds[0].combat, 'local');
    T.kill(reds[1].combat, 'local');
    const afterKills = T.money();
    // The same kill reported again (duplicate event): no second bonus.
    tm.recordKill('local', reds[0].id, 'ar01', false);
    const afterDup = T.money();
    for (const b of reds.slice(2)) T.kill(b.combat, T.blues()[0].id);
    T.run(1);
    const afterWin = T.money();
    const settledAgain = tm.economy.settle({ round: 1, winner: 'blue' });
    // Result phase frames, HUD refreshes: nothing more is paid.
    T.run(120);
    const afterResult = T.money();
    const banner = document.querySelector('.team-hud .round-banner .rb-sub').textContent;
    const moneyHud = document.querySelector('.team-hud .ta-money').textContent;
    const ammoAtEnd = Object.fromEntries(g.weapons.loadout.map((w) => [w.def.id, [w.magazine, w.reserve]]));
    const inHandAtEnd = g.weapons.weapon.def.id;
    T.until('prep', 600);
    const next = { phase: tm.phase, round: tm.round, money: T.money(), gear: T.gear(), buyTime: tm.phaseLeft, clock: tm.roundTimeLeft };
    const carried = Object.fromEntries(g.weapons.loadout.map((w) => [w.def.id, [w.magazine, w.reserve]]));
    // Buying what is already held: refused, nothing charged or issued twice.
    const rebuy = g.buy('AR-01');
    const afterRebuy = { money: T.money(), weapons: g.weapons.loadout.map((w) => w.def.id) };
    // Replacing the carried-over AR-01 (bought last round): no refund, the full SR-01 price.
    const swap = g.buy('SR-01');
    const afterSwap = { money: T.money(), weapons: g.weapons.loadout.map((w) => w.def.id), fb: document.querySelector('.buy-feedback').textContent, pis: carried.pis01 && g.weapons.loadout.find((w) => w.def.id === 'pis01').magazine };
    return {
      ammoAtEnd,
      inHandAtEnd,
      carried,
      rebuy: rebuy.reason,
      afterRebuy,
      swap: swap.ok,
      afterSwap,
      m0,
      afterKills,
      afterDup,
      afterWin,
      settledAgain,
      afterResult,
      allyGain: T.money(T.blues()[0].id) - ally0,
      redMoney: T.money(reds[0].id),
      banner,
      moneyHud,
      next,
    };
  });
  assert.equal(r.m0, 4800);
  assert.equal(r.afterKills, 5200, 'two kills, $200 each');
  assert.equal(r.afterDup, 5200, 'a duplicate kill event pays nothing');
  assert.equal(r.afterWin, 8200, 'round win $3,000');
  assert.equal(r.settledAgain, false, 'a round settles once');
  assert.equal(r.afterResult, 8200);
  assert.equal(r.allyGain, 3 * 200 + 3000, 'the teammate who killed three gets the bonuses + the win');
  assert.equal(r.redMoney, 3000 + 1900, 'the losing side gets the first-loss reward');
  assert.equal(r.banner, '승리 보상 +$3,000');
  assert.equal(r.moneyHud, '$8,200');
  assert.equal(r.next.phase, 'prep');
  assert.equal(r.next.round, 2);
  assert.equal(r.next.money, 8200, 'money carries over');
  // The player survived: AR-01 + PIS-01 + knife stay, each with the ammo it had when the round ended.
  assert.deepEqual(r.next.gear, { primary: 'AR-01', secondary: 'PIS-01', melee: 'Knife', weapons: ['ar01', 'pis01', 'karambit'], inHand: r.inHandAtEnd }, 'the survivor keeps the gear');
  assert.deepEqual(r.carried, r.ammoAtEnd, 'magazines and reserves carried over as they were');
  assert.ok(r.ammoAtEnd.ar01[0] < 30, `the rifle really was fired (${r.ammoAtEnd.ar01})`);
  assert.equal(r.rebuy, 'owned');
  assert.deepEqual(r.afterRebuy, { money: 8200, weapons: ['ar01', 'pis01', 'karambit'] }, 'not charged, not issued again');
  assert.equal(r.swap, true);
  assert.equal(r.afterSwap.money, 8200 - 4750, 'a carried-over weapon is not refunded when replaced');
  assert.equal(r.afterSwap.fb, 'SR-01 구매 (AR-01 교체, -$4,750)');
  assert.deepEqual(r.afterSwap.weapons, ['sr01', 'pis01', 'karambit']);
  assert.equal(r.afterSwap.pis, r.ammoAtEnd.pis01[0], 'the pistol kept its magazine through the swap');
  assert.ok(r.next.buyTime > 14.9, 'a fresh 15 s buy time');
  assert.equal(r.next.clock, 120);
});

test('no bonus for teammates or kills after the round is decided; draws and loss streaks pay per the rules', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    const tm = g.teamMatch;
    T.until('live');
    const m0 = T.money();
    // A teammate death credited to the player (cannot happen with friendly fire off; must pay nothing even so).
    tm.recordKill('local', T.blues()[0].id, 'ar01', false);
    const afterFriendly = T.money();
    // Everyone dies in the same tick: a draw.
    for (const c of [g.combat, ...g.squad.bots.map((b) => b.combat)]) T.kill(c, 'test');
    T.run(1);
    const draw = tm.history.at(-1);
    const afterDraw = T.money();
    // A kill reported during the result phase: nothing.
    tm.recordKill('local', T.reds()[0].id, 'ar01', false);
    const afterLate = T.money();
    const streaks = Object.fromEntries(tm.economy.lossStreak);
    return { m0, afterFriendly, draw, afterDraw, afterLate, streaks, banner: document.querySelector('.team-hud .round-banner .rb-sub').textContent };
  });
  assert.equal(r.afterFriendly, r.m0, 'no bonus for a teammate');
  assert.equal(r.draw.winner, null);
  assert.equal(r.afterDraw, r.m0 + 1900, 'draw: $1,900 each');
  assert.equal(r.afterLate, r.afterDraw, 'nothing after the round is decided');
  assert.deepEqual(r.streaks, { blue: 0, red: 1 }, 'a draw leaves the loss streaks as they were');
  assert.equal(r.banner, '무승부 보상 +$1,900');
});

test('a player who died loses the gear and starts the next round with the default issue; money stays', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    // The previous test ended the round with everyone dead (draw), the player included.
    const before = { money: T.money(), gear: T.gear(), alive: g.combat.alive, phase: g.teamMatch.phase };
    T.until('prep', 600);
    return { before, after: { money: T.money(), gear: T.gear(), alive: g.combat.alive, hp: g.player.health } };
  });
  assert.equal(r.before.alive, false);
  assert.deepEqual(r.before.gear.weapons, ['sr01', 'pis01', 'karambit'], 'still holding the gear when the round ended');
  assert.deepEqual(r.after.gear, { primary: null, secondary: null, melee: 'Knife', weapons: ['karambit'], inHand: 'karambit' }, 'gear lost on death');
  assert.equal(r.after.money, r.before.money, 'money carries over');
  assert.deepEqual([r.after.alive, r.after.hp], [true, 100]);
});

test('loss streak: $1,900, $2,400, $2,900, $3,400, $3,400; a win resets it; a draw keeps it; money capped at $16,000', async () => {
  const r = await page.evaluate(async () => {
    const { TeamEconomy, ECONOMY, lossReward } = await import('/src/game/Economy.ts');
    const eco = new TeamEconomy(ECONOMY, [
      { id: 'a', team: 'blue' },
      { id: 'b', team: 'red' },
    ]);
    const gains = [];
    let round = 1;
    // The wallet is emptied before each round so every gain is the full reward (no cap in the way).
    const play = (winner) => {
      eco.spend('a', eco.money('a'));
      const m = eco.money('a');
      eco.settle({ round: round++, winner });
      gains.push(eco.money('a') - m);
    };
    for (let i = 0; i < 5; i++) play('red'); // five losses for blue in a row
    const streak5 = eco.lossStreak.get('blue');
    play('blue'); // win: +3000, streak 0
    play('red'); // loss again: back to $1,900
    play(null); // draw: +$1,900, streak stays 1
    play('red'); // second loss in a row: $2,400
    // Cap: wins on a wallet that is not emptied, until it is full.
    for (let i = 0; i < 8; i++) eco.settle({ round: round++, winner: 'blue' });
    const capped = eco.money('a');
    const winAtCap = (() => {
      const m = eco.money('a');
      eco.settle({ round: round++, winner: 'blue' });
      return eco.money('a') - m;
    })();
    // Spend can never go below zero.
    const tooMuch = eco.spend('a', 999999);
    const left = eco.money('a');
    // Kill bonus: once per victim per round, never for a teammate or yourself.
    const eco2 = new TeamEconomy(ECONOMY, [
      { id: 'a', team: 'blue' },
      { id: 'a2', team: 'blue' },
      { id: 'b', team: 'red' },
    ]);
    const k = [eco2.onKill(1, 'a', 'b'), eco2.onKill(1, 'a', 'b'), eco2.onKill(1, 'a', 'a2'), eco2.onKill(1, 'a', 'a'), eco2.onKill(2, 'a', 'b')];
    return {
      table: [1, 2, 3, 4, 5, 6].map((s) => lossReward(ECONOMY, s)),
      gains,
      streak5,
      capped,
      winAtCap,
      tooMuch,
      left,
      k,
      kMoney: eco2.money('a'),
    };
  });
  assert.deepEqual(r.table, [1900, 2400, 2900, 3400, 3400, 3400]);
  assert.deepEqual(r.gains.slice(0, 9), [1900, 2400, 2900, 3400, 3400, 3000, 1900, 1900, 2400]);
  assert.equal(r.streak5, 5);
  assert.equal(r.capped, 16000, 'never above $16,000');
  assert.equal(r.winAtCap, 0);
  assert.equal(r.tooMuch, false);
  assert.equal(r.left, 16000, 'a refused spend changes nothing');
  assert.deepEqual(r.k, [true, false, false, false, true]);
  assert.equal(r.kMoney, 3000 + 400);
});

test('the existing team match still holds: lost round pays the loss reward to the player; clock win and spectating unchanged', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    const tm = g.teamMatch;
    T.until('live');
    const m0 = T.money();
    // The player dies and watches; BLUE loses the round by elimination.
    T.kill(g.combat, T.reds()[0].id);
    T.run(120);
    const spectating = document.querySelector('.death-note').textContent;
    const canBuyDead = g.buy('AR-01').reason;
    for (const b of T.blues()) T.kill(b.combat, T.reds()[0].id);
    T.run(1);
    const lost = tm.history.at(-1);
    const afterLoss = T.money();
    T.until('live');
    // Clock decides the next round: 5 vs 4.
    const step = g.squad.step;
    g.squad.step = (dt) => g.squad.hold(dt);
    T.kill(T.reds()[0].combat, 'local');
    tm.roundTimeLeft = 0.1;
    T.run(10);
    g.squad.step = step;
    return { m0, spectating, canBuyDead, lost: { winner: lost.winner, reason: lost.reason }, afterLoss, clockRound: tm.history.at(-1), money: T.money() };
  });
  assert.match(r.spectating, /^관전 중: /);
  assert.equal(r.canBuyDead, 'phase', 'no buying while dead / spectating');
  assert.deepEqual(r.lost, { winner: 'red', reason: 'elimination' });
  // Blue's streak was 0 (won round 1, draw kept it): first loss.
  assert.equal(r.afterLoss, r.m0 + 1900);
  assert.deepEqual([r.clockRound.winner, r.clockRound.reason, r.clockRound.alive.red], ['blue', 'time', 4]);
  assert.equal(r.money, r.afterLoss + 200 + 3000, 'kill bonus + win');
});

test('restart: a fresh economy ($3,000, knife only), nothing paid twice', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    g.restartMatch();
    const tm = g.teamMatch;
    return { money: [...tm.scores.keys()].map((id) => tm.economy.money(id)), gear: window.T.gear(), round: tm.round, phase: tm.phase, streaks: Object.fromEntries(tm.economy.lossStreak) };
  });
  assert.deepEqual(r.money, Array(10).fill(3000));
  assert.deepEqual(r.gear.weapons, ['karambit']);
  assert.deepEqual([r.round, r.phase], [1, 'prep']);
  assert.deepEqual(r.streaks, { blue: 0, red: 0 });
});

test('deathmatch and training: no buy phase, no economy, the standard loadout', async () => {
  await page.evaluate(() => document.exitPointerLock());
  await page.waitForFunction(() => !document.pointerLockElement);
  await page.click('#tab-play');
  for (const mode of ['deathmatch', 'training']) {
    await page.selectOption('select[data-setting="mode"]', mode);
    await page.click('.play-button');
    await waitLocked();
    await page.keyboard.press('KeyB');
    await page.evaluate(() => window.T.run(30));
    const r = await page.evaluate(() => {
      const g = window.game;
      return {
        teamMatch: g.teamMatch,
        buyOpen: g.buyMenuOpen,
        menuHidden: document.querySelector('.buy-menu').hidden,
        locked: document.pointerLockElement === g.renderer.domElement,
        weapons: g.weapons.loadout.map((w) => w.def.id),
        hudSlots: [...document.querySelectorAll('.loadout .slot')].map((s) => s.textContent),
        respawns: g.squad?.respawns ?? null,
        ff: g.hitscan.friendlyFire,
        buy: g.buy('AR-01').reason,
      };
    });
    assert.equal(r.teamMatch, null, mode);
    assert.equal(r.buyOpen, false, `${mode}: B does nothing`);
    assert.equal(r.menuHidden, true);
    assert.equal(r.locked, true, `${mode}: still playing`);
    assert.deepEqual(r.weapons, ['ar01', 'sr01', 'karambit'], `${mode}: the standard loadout is back`);
    assert.deepEqual(r.hudSlots, ['1 AR-01', '2 SR-01', '3 M9 BAYONET']);
    assert.equal(r.respawns, mode === 'deathmatch' ? true : null);
    assert.equal(r.ff, true);
    assert.equal(r.buy, 'phase');
    await page.evaluate(() => document.exitPointerLock());
    await page.waitForFunction(() => !document.pointerLockElement);
  }
  assert.deepEqual(page.errors, []);
});
