// GRID shop, inventory (보관함) and missions in the real game page, with the
// mouse: tabs after the existing ones and the layout at three sizes, shop
// listing and prices, the purchase flow (preview → price / balance →
// confirm), a double click charged once, refusals, equipping from the
// inventory and the skins really worn in play (weapon materials, gloves,
// sleeves, legs), materials reused across weapon switches, the saved state
// after a reload, match rewards once per match (deathmatch / team, 대결
// 포기 = 0, training = none), and mission claims.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, openGame, installFrameDriver } from './harness.mjs';

let env;
let page;

const account = () => page.evaluate(() => window.game.economy.getAccount());
const waitAccount = () => page.waitForFunction(() => !!window.game.account);

before(async () => {
  env = await startEnv();
  page = await openGame(env, { map: 'warehouse', mode: 'training', width: 1280, height: 800 });
  page.setDefaultTimeout(60000);
  await waitAccount();
});
after(async () => {
  await page?.context().close();
  await env?.close();
});

test('menu: 보관함 · 상점 · 미션 tabs after the existing four (order and arrow keys unchanged); each page fits at three sizes', async () => {
  const tabs = await page.evaluate(() => [...document.querySelectorAll('.tab')].map((t) => t.textContent));
  assert.deepEqual(tabs, ['플레이', '무기', '설정', '조작', '보관함', '상점', '미션', '멀티플레이']);
  for (const [w, h] of [
    [1600, 900],
    [1024, 640],
    [600, 780],
  ]) {
    await page.setViewportSize({ width: w, height: h });
    for (const tab of ['inventory', 'shop', 'missions']) {
      await page.click('#tab-' + tab);
      const l = await page.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll('.menu *')) {
          const b = el.getBoundingClientRect();
          if (b.width && (b.right > innerWidth + 1 || b.left < -1)) out.push(el.className || el.tagName);
        }
        return { offenders: [...new Set(out)], sideways: document.documentElement.scrollWidth > innerWidth };
      });
      assert.deepEqual(l, { offenders: [], sideways: false }, `${w}x${h} ${tab}`);
    }
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.click('#tab-play');
});

test('sign-in is switched off: no account line, no account-server request; the offline record is used', async () => {
  const r = await page.evaluate(() => ({
    bars: document.querySelectorAll('.grid-account').length,
    dialog: !!document.querySelector('.grid-auth'),
    mode: window.game.accountSession.mode.kind,
    kind: window.game.economy.kind,
    api: performance.getEntriesByType('resource').filter((e) => new URL(e.name).pathname.startsWith('/api/')).length,
  }));
  assert.deepEqual(r, { bars: 0, dialog: false, mode: 'checking', kind: 'local', api: 0 });
});

test('shop: credits, four categories, every product with its catalog price; search filters; defaults are not sold', async () => {
  await page.click('#tab-shop');
  const read = () =>
    page.evaluate(() => ({
      credits: document.querySelector('#page-shop .grid-balance').textContent,
      cards: [...document.querySelectorAll('#page-shop .shop-cards [data-skin]')].map((c) => [c.dataset.skin, c.querySelector('.gc-price').textContent]),
    }));
  const r = await read();
  const expected = await page.evaluate(async () => {
    const { SKIN_CATALOG } = await import('/src/economy/SkinCatalog.ts');
    return Object.fromEntries(['weapon', 'character', 'knife', 'gloves'].map((c) => [c, SKIN_CATALOG.filter((s) => s.category === c && s.onSale).map((s) => [s.skinId, `${s.price.toLocaleString('en-US')} CR`])]));
  });
  assert.equal(r.credits, '500 CR');
  assert.deepEqual(r.cards, expected.weapon);
  for (const cat of ['character', 'knife', 'gloves']) {
    await page.click(`#shop-cat-${cat}`);
    assert.deepEqual((await read()).cards, expected[cat], cat);
  }
  await page.click('#shop-cat-weapon');
  await page.fill('#page-shop .grid-search', 'fde');
  assert.deepEqual((await read()).cards.map((c) => c[0]), ['ar01.fde', 'smg01.fde', 'pis01.fde']);
  await page.fill('#page-shop .grid-search', '');
  assert.ok(!(await read()).cards.some(([id]) => id.endsWith('.default')));
});

test('purchase flow with the mouse: preview, price and balance, confirm; a double click charges once; then 보유 중; too expensive is refused with the shortfall', async () => {
  await page.click('#page-shop [data-skin="ar01.fde"]');
  const view = await page.evaluate(() => ({
    name: document.querySelector('.gd-name').textContent,
    price: document.querySelector('.gd-price').textContent,
    balance: document.querySelector('.gd-balance').textContent,
    after: document.querySelector('.gd-after').textContent,
    art: !!document.querySelector('.gd-art .gc-art'),
  }));
  assert.deepEqual(view, { name: 'FDE 세라코트', price: '400 CR', balance: '500 CR', after: '100 CR', art: true });
  await page.click('.gd-primary');
  const confirm = await page.evaluate(() => document.querySelector('.gd-note').textContent);
  assert.equal(confirm, '400 CR를 사용해 「FDE 세라코트」을(를) 구매합니다.');
  await page.dblclick('.gd-confirm');
  await page.waitForSelector('.grid-dialog.step-done');
  // The result buttons wait a moment before they take clicks (the double click's second click is ignored).
  await page.waitForTimeout(400);
  const done = await page.evaluate(() => document.querySelector('.gd-note').textContent);
  const a = await account();
  assert.equal(done, '구매 완료 — 보관함에 추가되었습니다. 남은 크레딧 100 CR.');
  assert.equal(a.credits, 100, 'charged once');
  assert.deepEqual(a.items.map((i) => i.skinId), ['ar01.fde']);
  assert.equal(a.ledger.filter((t) => t.kind === 'purchase').length, 1);
  await page.click('.gd-close');
  assert.equal(await page.textContent('#page-shop [data-skin="ar01.fde"] .gc-price'), '보유 중');
  // Owned: no purchase button. Too expensive: refused with the shortfall, nothing charged.
  await page.click('#page-shop [data-skin="ar01.fde"]');
  assert.equal(await page.isVisible('.gd-primary'), false);
  assert.equal(await page.textContent('.gd-note'), '이미 보유한 스킨입니다. 보관함에서 장착할 수 있습니다.');
  await page.click('.gd-close');
  await page.click('#page-shop [data-skin="ar01.urban"]');
  const short = await page.evaluate(() => ({ disabled: document.querySelector('.gd-primary').disabled, note: document.querySelector('.gd-note').textContent, after: document.querySelector('.gd-after').textContent }));
  assert.deepEqual(short, { disabled: true, note: '크레딧이 부족합니다 (부족 800 CR).', after: '800 CR 부족' });
  await page.keyboard.press('Escape');
  assert.equal(await page.isVisible('.grid-dialog'), false, 'Esc closes the dialog');
  assert.equal((await account()).credits, 100);
});

test('equip from 보관함: the AR-01 in hand wears the FDE finish (skinned copies of its file materials); unequip restores the factory look; weapon switches reuse the materials; combat data untouched', async () => {
  await page.click('#tab-inventory');
  const before = await page.evaluate(() => {
    const g = window.game;
    return { damage: JSON.stringify(g.weapons.weapon.def.damage), defRef: g.weapons.weapon.def === g.weapons.loadout[0].def };
  });
  await page.click('#page-inventory [data-item]:not([data-item=""])');
  await page.waitForFunction(() => window.game.account.loadout['weapon:ar01']);
  const worn = () =>
    page.evaluate(() => {
      const g = window.game;
      const names = new Map();
      g.viewModel.currentView.object.traverse((o) => {
        if (o.isMesh) for (const m of [o.material].flat()) names.set(m.name, m.color?.getHexString());
      });
      return Object.fromEntries(names);
    });
  // Factory colours, read from the loaded file itself.
  const fileColor = (name) =>
    page.evaluate(async (name) => {
      const { loadedGltfScene } = await import('/src/weapons/view/GltfWeaponView.ts');
      let c = null;
      loadedGltfScene('/weapons/ar01.glb').traverse((o) => {
        if (o.isMesh && o.material.name === name) c = o.material.color.getHexString();
      });
      return c;
    }, name);
  const factoryPolymer = await fileColor('M4_Polymer');
  const factoryBarrel = await fileColor('M4_Barrel');
  const skinned = await worn();
  assert.equal(skinned['M4_Polymer@finish:ar01.fde'], '8a7553', 'body: FDE');
  assert.equal(skinned['M4_Magazine@finish:ar01.fde'], '2a2622', 'magazine: dark polymer');
  assert.equal(skinned['M4_Barrel'], factoryBarrel, 'the barrel keeps its own finish');
  const equippedCard = await page.textContent('#page-inventory .inv-card.equipped .gc-name');
  assert.equal(equippedCard, 'FDE 세라코트');
  // Switching weapons back and forth: no new skinned materials after the first.
  const counts = await page.evaluate(async () => {
    const g = window.game;
    const n0 = g.skins.materialCount;
    for (let i = 0; i < 6; i++) {
      g.weapons.equipSlot(i % 2 === 0 ? 1 : 0);
      g.showWeaponModel(g.weapons.weapon.def);
    }
    g.weapons.equipSlot(0);
    g.showWeaponModel(g.weapons.weapon.def);
    return [n0, g.skins.materialCount];
  });
  assert.equal(counts[0], counts[1]);
  const after = await page.evaluate(() => JSON.stringify(window.game.weapons.weapon.def.damage));
  assert.equal(after, before.damage, 'a skin never touches weapon data');
  // The factory file materials themselves were never edited.
  assert.equal(await fileColor('M4_Polymer'), factoryPolymer);
  assert.notEqual(factoryPolymer, '8a7553');
  // Back to the default look.
  await page.click('#page-inventory [data-slot="weapon:ar01"] [data-item=""]');
  await page.waitForFunction(() => !window.game.account.loadout['weapon:ar01']);
  const plain = await worn();
  assert.equal(plain['M4_Polymer'], factoryPolymer);
  assert.ok(!Object.keys(plain).some((n) => n.includes('@')));
});

test('a completed deathmatch pays once (shown on the result screen); restarting it before the end pays nothing; training has no match to pay', async () => {
  assert.equal(await page.evaluate(() => window.game.matchRecord), null, 'training: no match record');
  await page.click('#tab-play');
  await page.selectOption('select[data-setting="mode"]', 'deathmatch');
  await page.click('.play-button');
  await page.waitForFunction(() => document.pointerLockElement === window.game.renderer.domElement && window.game.input.active);
  await installFrameDriver(page);
  const r = await page.evaluate(async () => {
    const g = window.game;
    const T = window.T;
    T.stopLoop();
    const first = g.matchRecord.id;
    // Left before its end: a new match, the old one is never paid.
    g.restartMatch();
    const second = g.matchRecord.id;
    T.run(2);
    // Play to the end (the time limit, after more than a minute).
    g.match.elapsed = 75;
    g.match.timeLeft = 0.01;
    T.run(2);
    for (let i = 0; i < 50 && !document.querySelector('.match-hud .results-reward')?.textContent; i++) await new Promise((res) => setTimeout(res, 50));
    const reward = document.querySelector('.match-hud .results-reward').textContent;
    const a = await g.economy.getAccount();
    // The results again (re-entering the result screen): nothing more.
    g.settleMatch('completed');
    await g.economy.submitMatchResult({ matchId: second, mode: 'deathmatch', outcome: 'completed', won: true, kills: { ar01: 30 }, roundWins: 0, durationSeconds: 999 });
    const b = await g.economy.getAccount();
    return { first, second, over: g.match.over, reward, gained: a.credits - 100, ledger: a.ledger.filter((t) => t.kind === 'match_reward').map((t) => t.ref), again: b.credits - a.credits };
  });
  assert.notEqual(r.first, r.second);
  assert.equal(r.over, true);
  assert.ok(r.gained >= 60, `paid for the completed match (${r.gained})`);
  assert.equal(r.reward, `GRID 크레딧 +${r.gained} CR`);
  assert.deepEqual(r.ledger, [r.second], 'only the completed match, not the restarted one');
  assert.equal(r.again, 0, 'never twice');
  await page.evaluate(() => document.exitPointerLock());
});

test('team match: 대결 포기 pays 0 and closes the match; the mission page shows today, progress and a one-time claim', async () => {
  await page.evaluate(() => window.game.restartMatch());
  await page.selectOption('select[data-setting="mode"]', 'team');
  await page.click('.play-button');
  await page.waitForFunction(() => window.game.input.active);
  const before = await account();
  await page.evaluate(() => document.exitPointerLock());
  await page.waitForFunction(() => !window.game.input.active);
  await page.evaluate(() => window.T.run(1)); // the real loop is stopped: one frame updates the pause menu
  await page.click('.forfeit-button');
  await page.click('.confirm-forfeit');
  await page.waitForFunction(() => document.querySelector('.team-hud .results-reward').textContent !== '');
  const r = await page.evaluate(async () => ({
    reward: document.querySelector('.team-hud .results-reward').textContent,
    settled: window.game.matchRecord.settled,
    a: await window.game.economy.getAccount(),
  }));
  assert.equal(r.reward, 'GRID 크레딧: 대결 포기 — 보상 없음');
  assert.equal(r.settled, true);
  assert.equal(r.a.credits, before.credits);
  assert.ok(r.a.settledMatches.length === before.settledMatches.length + 1, 'the forfeited match id is closed');
  await page.click('.team-hud .results-menu');
  // Missions: the deathmatch above completed "경기 1회 완료"; claim it once.
  await page.click('#tab-missions');
  const row = '[data-mission-row="daily.match"]';
  const m = await page.evaluate((row) => ({ progress: document.querySelector(row + ' .gm-progress').textContent, state: document.querySelector(row + ' .gm-state').textContent, day: document.querySelector('.grid-day').textContent }), row);
  assert.equal(m.progress, '1 / 1');
  assert.equal(m.state, '완료');
  assert.match(m.day, /^\d{4}-\d{2}-\d{2} \(기기 날짜 기준\)$/);
  const c0 = (await account()).credits;
  await page.dblclick(row + ' .gm-claim');
  await page.waitForFunction((row) => document.querySelector(row + ' .gm-state').textContent === '수령함', row);
  assert.equal((await account()).credits, c0 + 100, 'claimed once');
  assert.equal(await page.isDisabled(row + ' .gm-claim'), true);
  const ledger = await page.evaluate(() => [...document.querySelectorAll('.grid-ledger tbody tr')].slice(0, 1).map((tr) => tr.textContent));
  assert.match(ledger[0], /^미션 보상경기 1회 완료\+100/);
});

test('gloves and uniform: bought and equipped, worn by the first-person hands, sleeves and legs; after a reload the same items and loadout come back', async () => {
  // Enough credits from the account itself (a completed team match, through the real authority).
  await page.evaluate(() => window.game.economy.submitMatchResult({ matchId: 'team-test-bonus-1', mode: 'team', outcome: 'completed', won: true, kills: { ar01: 10 }, roundWins: 5, durationSeconds: 900 }));
  await page.click('#tab-shop');
  await page.click('#shop-cat-gloves');
  await page.click('#page-shop [data-skin="gloves.coyote"]');
  await page.click('.gd-primary');
  await page.click('.gd-confirm');
  await page.waitForSelector('.grid-dialog.step-done');
  await page.waitForTimeout(400);
  await page.click('.gd-go-inv');
  assert.equal(await page.evaluate(() => document.querySelector('#tab-inventory').getAttribute('aria-selected')), 'true', 'straight to 보관함');
  await page.click('#page-inventory [data-slot="gloves:player"] [data-item]:not([data-item=""])');
  await page.waitForFunction(() => window.game.account.loadout['gloves:player']);
  const hands = await page.evaluate(() => window.game.viewModel.currentArms.lookColors);
  assert.deepEqual(hands, { glove: 0x6f5a42, pad: 0x8a7553, sleeve: 0x3b3f34, cuff: 0x2b2d28 }, 'gloves only: factory sleeves');
  // A uniform: sleeves in first person and the legs / jacket below change; the gloves stay.
  const uniform = await page.evaluate(async () => {
    const g = window.game;
    await g.economy.submitMatchResult({ matchId: 'team-test-bonus-2', mode: 'team', outcome: 'completed', won: true, kills: { ar01: 10 }, roundWins: 5, durationSeconds: 900 });
    const bought = await g.economy.purchase('character.urban');
    const item = bought.account.items.find((i) => i.skinId === 'character.urban').itemId;
    await g.economy.equip('character', 'player', item);
    return { arms: g.viewModel.currentArms.lookColors, body: g.body.lookColors };
  });
  assert.deepEqual(uniform.arms, { glove: 0x6f5a42, pad: 0x8a7553, sleeve: 0x5b5f63, cuff: 0x3a3d40 });
  assert.deepEqual(uniform.body, { pants: 0x5b5f63, jacket: 0x4c4f53, gear: 0x2c2e30, boot: 0x26272a });
  const credits = (await account()).credits;
  assert.ok(credits >= 0);
  // Reload: the account, items and loadout come back from storage; the hands are dressed again.
  await page.reload();
  await page.waitForFunction(() => window.game?.account && window.game.viewModel.currentArms, null, { timeout: 300000 });
  const back = await page.evaluate(() => ({ a: window.game.account, hands: window.game.viewModel.currentArms.lookColors }));
  assert.equal(back.a.credits, credits);
  assert.deepEqual(back.a.items.map((i) => i.skinId).sort(), ['ar01.fde', 'character.urban', 'gloves.coyote']);
  assert.ok(back.a.loadout['gloves:player'] && back.a.loadout['character:player']);
  assert.deepEqual([back.hands.glove, back.hands.sleeve], [0x6f5a42, 0x5b5f63]);
  assert.deepEqual(page.errors, []);
});
