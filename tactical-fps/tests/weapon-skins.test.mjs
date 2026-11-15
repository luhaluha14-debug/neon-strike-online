// Phase 26-C weapon skins: default looks for free, buying with GRID credits (refused when short or already
// owned), per-weapon equip / unequip (only owned skins), the stored record coming back after a reload and
// repaired when broken, the skin on the first-person model and on the stand-in rifle the others see, and in
// a room: the host checks every claim (a registered skin that fits the weapon; ownership cannot be proven
// without an account server, see src/skins/SkinClaims.ts), shows it to everyone, and keeps it through a
// rejoin and a host hand-over. Skins are looks only: weapon data is never touched.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { startEnv, openGame, waitReady, ROOT } from './harness.mjs';

let vite;
let relay;
let env;
let M;

before(async () => {
  vite = await createServer({ root: ROOT, logLevel: 'error', server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom' });
  const load = (p) => vite.ssrLoadModule(p);
  M = {
    ...(await load('/src/economy/SkinCatalog.ts')),
    ...(await load('/src/economy/EconomyAuthority.ts')),
    ...(await load('/src/economy/AccountRepository.ts')),
    ...(await load('/src/economy/EconomyClock.ts')),
    ...(await load('/src/economy/LoadoutService.ts')),
    ...(await load('/src/skins/SkinClaims.ts')),
  };
  const { createMpServer } = await load('/server/mp/server.ts');
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

/** An account on an in-memory store: fresh (500 credits) or with `credits`. */
async function account(credits) {
  const repo = new M.MemoryAccountRepository();
  if (credits !== undefined) {
    const a = M.newAccount('acct-skins', '2026-11-13');
    a.credits = credits;
    await repo.save(a, null);
  }
  const auth = new M.EconomyAuthority(repo, new M.FixedClock('2026-11-13'), () => 'acct-skins');
  await auth.init();
  let n = 0;
  return { repo, auth, rid: (k) => `${k}-${++n}` };
}
const shown = (a, target) => M.LoadoutService.equipped(a, 'weapon', target)?.skinId;
const itemOf = (a, skinId) => a.items.find((i) => i.skinId === skinId)?.itemId;

// --- the economy (Node) -------------------------------------------------------------------------

test('1. default skins for free: a new account shows every weapon’s default look, owns nothing, pays nothing; SMG-02 has its slot and skins', async () => {
  const { auth } = await account();
  const a = auth.account();
  assert.equal(a.credits, 500);
  assert.deepEqual(a.items, []);
  for (const w of ['ar01', 'smg02', 'sr01']) {
    const d = M.LoadoutService.equipped(a, 'weapon', w);
    assert.deepEqual([d.skinId, d.isDefault, d.price, d.onSale], [`${w}.default`, true, 0, false]);
  }
  assert.deepEqual(M.validateCatalog(M.SKIN_CATALOG), []);
  // Test skins on AR-01, SMG-02 and SR-01 (each with an id, a name, its weapon, a price and a look).
  for (const w of ['ar01', 'smg02', 'sr01']) {
    const sold = M.SKIN_CATALOG.filter((s) => s.category === 'weapon' && s.targets.includes(w) && !s.isDefault);
    assert.ok(sold.length >= 1, w);
    for (const s of sold) assert.ok(s.skinId && s.name && s.price > 0 && s.assetId.startsWith('finish:'), s.skinId);
  }
  assert.deepEqual(M.findSkin('smg02.coyote').targets, ['smg02']);
});

test('2–4. buying with credits: the catalog price is charged once; too few credits refused (nothing changes); a second purchase of an owned skin refused', async () => {
  const { auth, rid } = await account();
  const r = await auth.purchase('smg02.coyote', rid('buy'));
  assert.equal(r.ok, true);
  assert.equal(r.account.credits, 500 - 450);
  assert.ok(itemOf(r.account, 'smg02.coyote'));
  const short = await auth.purchase('smg02.gunmetal', rid('buy'));
  assert.deepEqual([short.ok, short.error, short.account.credits, short.account.items.length], [false, 'insufficient_funds', 50, 1]);
  const again = await auth.purchase('smg02.coyote', rid('buy'));
  assert.deepEqual([again.ok, again.error, again.account.credits, again.account.items.length], [false, 'owned', 50, 1]);
  // Defaults are not for sale, unknown ids are not things.
  assert.equal((await auth.purchase('smg02.default', rid('buy'))).error, 'not_for_sale');
  assert.equal((await auth.purchase('smg02.gold', rid('buy'))).error, 'unknown_item');
});

test('5 / 8. equip per weapon, each slot on its own; unequip back to the default; an unowned or misfit skin is refused', async () => {
  const { auth, rid } = await account(5000);
  for (const id of ['ar01.fde', 'smg02.coyote', 'sr01.olive']) assert.equal((await auth.purchase(id, rid('buy'))).ok, true);
  let a = auth.account();
  for (const [w, id] of [['ar01', 'ar01.fde'], ['smg02', 'smg02.coyote'], ['sr01', 'sr01.olive']]) a = (await auth.equip('weapon', w, itemOf(a, id), rid('eq'))).account;
  assert.deepEqual(['ar01', 'smg02', 'sr01'].map((w) => shown(a, w)), ['ar01.fde', 'smg02.coyote', 'sr01.olive']);
  // Unequip SMG-02 only: the other two stay.
  a = (await auth.equip('weapon', 'smg02', null, rid('eq'))).account;
  assert.deepEqual(['ar01', 'smg02', 'sr01'].map((w) => shown(a, w)), ['ar01.fde', 'smg02.default', 'sr01.olive']);
  // An SMG-02 skin on the AR-01: refused; an item that is not there: refused; nothing moved.
  const misfit = await auth.equip('weapon', 'ar01', itemOf(a, 'smg02.coyote'), rid('eq'));
  assert.deepEqual([misfit.ok, misfit.error], [false, 'incompatible']);
  const unowned = await auth.equip('weapon', 'smg02', 'acct-skins-item-999', rid('eq'));
  assert.deepEqual([unowned.ok, unowned.error], [false, 'not_owned']);
  assert.deepEqual(['ar01', 'smg02', 'sr01'].map((w) => shown(auth.account(), w)), ['ar01.fde', 'smg02.default', 'sr01.olive']);
});

test('6. a broken stored record: what is fine is kept, the rest shows default skins (never an error); an unusable one starts over', () => {
  const good = M.newAccount('acct-r', '2026-11-13');
  good.items = [
    { itemId: 'i1', skinId: 'ar01.fde', acquiredAt: '2026-11-13T00:00:00Z', source: 'purchase' },
    { itemId: 'i1b', skinId: 'ar01.fde', acquiredAt: '2026-11-13T00:00:00Z', source: 'purchase' },
    { itemId: 'i2', skinId: 'smg02.coyote', acquiredAt: '2026-11-13T00:00:00Z', source: 'purchase' },
    { itemId: 7, skinId: null },
    'junk',
  ];
  good.loadout = { 'weapon:ar01': 'i1', 'weapon:sr01': 'i2', 'weapon:smg02': 'missing', 'weapon:nope': 'i1', 'gloves:player': 42 };
  const r = M.repairAccount(JSON.parse(JSON.stringify(good)));
  assert.deepEqual(r.items.map((i) => i.itemId), ['i1', 'i2'], 'well-formed, one per skin');
  assert.deepEqual(r.loadout, { 'weapon:ar01': 'i1' }, 'only an owned item that fits its slot');
  assert.equal(M.LoadoutService.equipped(r, 'weapon', 'sr01').skinId, 'sr01.default');
  assert.equal(M.LoadoutService.equipped(r, 'weapon', 'smg02').skinId, 'smg02.default');
  // Not arrays / objects at all.
  const r2 = M.repairAccount({ ...M.newAccount('acct-r2', '2026-11-13'), items: 'x', loadout: [1], ledger: null, missions: 3, requests: 'y' });
  assert.deepEqual([r2.items, r2.loadout, r2.ledger], [[], {}, []]);
  assert.equal(M.LoadoutService.equipped(r2, 'weapon', 'ar01').skinId, 'ar01.default');
  // Not an account: a new one is made by the caller.
  for (const bad of [null, 'x', 5, {}, { schema: 2 }, { ...good, accountId: '' }, { ...good, credits: -1 }, { ...good, credits: 'lots' }]) assert.equal(M.repairAccount(bad), null);
});

test('8. the room’s check of a claim: registered skins on the weapons they fit pass; unknown, misfit, default, malformed and oversized claims do not', () => {
  const v = M.catalogClaimVerifier.verify;
  assert.deepEqual(v({ ar01: 'ar01.fde', smg02: 'smg02.coyote', sr01: 'sr01.olive', karambit: 'karambit.satin' }), { ar01: 'ar01.fde', smg02: 'smg02.coyote', sr01: 'sr01.olive', karambit: 'karambit.satin' });
  assert.deepEqual(v({ ar01: 'smg02.coyote', sr01: 'nope', smg02: 'gloves.coyote', karambit: 'ar01.fde', pis01: 'pis01.default', lmg02: 'ar01.fde', ar02: 'x', smg01: 42 }), {});
  for (const bad of [null, 'ar01.fde', 7, ['ar01.fde'], { ar01: 'x'.repeat(200) }]) assert.deepEqual(v(bad), {});
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`w${i}`, 'ar01.fde']));
  assert.deepEqual(v({ ...many, ar01: 'ar01.fde' }), {}, 'past the limit nothing more is read');
  // A player's own claim names only what its record owns and has equipped.
  const a = M.newAccount('acct-c', '2026-11-13');
  a.items = [{ itemId: 'i1', skinId: 'smg02.coyote', acquiredAt: '', source: 'purchase' }];
  a.loadout = { 'weapon:smg02': 'i1', 'weapon:ar01': 'not-mine' };
  assert.deepEqual(M.ownClaims(a), { smg02: 'smg02.coyote' });
  // What a snapshot may show: a registered weapon / knife skin's look.
  assert.equal(M.shownAsset('smg02.coyote'), 'finish:smg02.coyote');
  for (const bad of [undefined, '', 'gloves.coyote', 'ar01.default', 'nope', 3]) assert.equal(M.shownAsset(bad), undefined);
});

// --- one browser ----------------------------------------------------------------------------------

/** The first-person model's materials: name → colour. */
const worn = (p) =>
  p.evaluate(() => {
    const names = {};
    window.game.viewModel.currentView.object.traverse((o) => {
      if (o.isMesh) for (const m of [o.material].flat()) names[m.name] = m.color?.getHexString();
    });
    return names;
  });

test('6–7. SMG-02 in hand: bought and equipped, the first-person model wears it; after a reload the item, the slot and the look come back; a broken record loads with defaults', async () => {
  const page = await openGame(env, { map: 'warehouse', mode: 'training', width: 960, height: 540 });
  try {
    const hold = (id) =>
      page.evaluate(async (id) => {
        const g = window.game;
        const { WEAPONS } = await import('/src/weapons/weapons.ts');
        g.weapons.setLoadout([WEAPONS[id], WEAPONS.karambit]);
        g.showWeaponModel(g.weapons.weapon.def);
      }, id);
    const before = await page.evaluate(async () => JSON.stringify((await import('/src/weapons/weapons.ts')).WEAPONS.smg02));
    const r = await page.evaluate(async () => {
      const g = window.game;
      const b = await g.economy.purchase('smg02.coyote');
      const item = b.account.items.find((i) => i.skinId === 'smg02.coyote').itemId;
      const e = await g.economy.equip('weapon', 'smg02', item);
      return { bought: b.ok, equipped: e.ok, credits: e.account.credits };
    });
    assert.deepEqual(r, { bought: true, equipped: true, credits: 50 });
    await hold('smg02');
    await page.waitForFunction(() => {
      let ok = false;
      window.game.viewModel.currentView.object.traverse((o) => o.isMesh && [o.material].flat().some((m) => m.name === 'RiflePolymer@finish:smg02.coyote') && (ok = true));
      return ok;
    });
    const w = await worn(page);
    assert.equal(w['RiflePolymer@finish:smg02.coyote'], '7d6a4f', 'polymer body: coyote');
    assert.equal(w['RifleMetal@finish:smg02.coyote'], '1a1b1d', 'metal: black cerakote');
    assert.ok('RifleRubber' in w && 'RifleBore' in w, 'rubber and bore keep their own');
    assert.equal(await page.evaluate(async () => JSON.stringify((await import('/src/weapons/weapons.ts')).WEAPONS.smg02)), before, 'weapon data untouched');
    // In the store: 보관함 shows the SMG-02 slot with the skin equipped.
    await page.click('#tab-inventory');
    assert.match(await page.textContent('#page-inventory [data-slot="weapon:smg02"] .inv-card.equipped .gc-name'), /코요테 탄 폴리머/);

    // Reload: the same account comes back.
    await page.reload();
    await waitReady(page);
    await page.waitForFunction(() => window.game.account);
    const back = await page.evaluate(() => ({ credits: window.game.account.credits, items: window.game.account.items.map((i) => i.skinId), slot: !!window.game.account.loadout['weapon:smg02'] }));
    assert.deepEqual(back, { credits: 50, items: ['smg02.coyote'], slot: true });
    await hold('smg02');
    await page.waitForFunction(() => {
      let ok = false;
      window.game.viewModel.currentView.object.traverse((o) => o.isMesh && [o.material].flat().some((m) => m.name === 'RiflePolymer@finish:smg02.coyote') && (ok = true));
      return ok;
    });

    // A broken record: the slot points at nothing, items are junk: it loads, with the default look.
    await page.evaluate(() => {
      const a = JSON.parse(localStorage.getItem('grid.account.v1'));
      a.loadout = { 'weapon:smg02': 'gone', 'weapon:ar01': { x: 1 } };
      a.items.push('junk', { itemId: 3 });
      localStorage.setItem('grid.account.v1', JSON.stringify(a));
    });
    await page.reload();
    await waitReady(page);
    await page.waitForFunction(() => window.game.account);
    const repaired = await page.evaluate(() => ({ credits: window.game.account.credits, items: window.game.account.items.map((i) => i.skinId), loadout: window.game.account.loadout }));
    assert.deepEqual(repaired, { credits: 50, items: ['smg02.coyote'], loadout: {} });
    await hold('smg02');
    await page.waitForTimeout(800);
    assert.ok(!Object.keys(await worn(page)).some((n) => n.includes('@')), 'the factory look');
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});

// --- a room ---------------------------------------------------------------------------------------

const enter = async (p, name, code) => {
  await p.click('#tab-multi');
  await p.fill('.mp-name', name);
  if (code) {
    await p.fill('.mp-code', code);
    await p.click('.mp-join-btn');
    await p.waitForFunction(() => window.game.netClient?.myId && window.game.match);
    return code;
  }
  await p.selectOption('.mp-mode', 'deathmatch');
  await p.click('.mp-create');
  await p.waitForFunction(() => window.game.netHost && window.game.match && window.game.squad);
  return (await p.textContent('.mp-room-code')).trim();
};
/** Buy + equip on this page's own record. */
const wear = (p, skinId, target) =>
  p.evaluate(
    async ([skinId, target]) => {
      const g = window.game;
      const b = await g.economy.purchase(skinId);
      const item = b.account.items.find((i) => i.skinId === skinId).itemId;
      return (await g.economy.equip('weapon', target, item)).ok;
    },
    [skinId, target],
  );
/** The host's view of the character a member plays: the skin on its rifle and the rifle's body colour. */
const hostSees = (host) =>
  host.evaluate(() => {
    const g = window.game;
    const i = g.squad.bots.findIndex((b) => b.remote);
    const m = i >= 0 ? g.squad['models'][i] : null;
    let body = null;
    m?.object.traverse((o) => o.isMesh && o.material.name?.includes('@finish:') && (body = o.material.color.getHexString()));
    return { skin: m?.weaponSkin ?? null, body };
  });
/** A member's view of another character (by wire id; the host's own is its session id). */
const memberSees = (p, id) =>
  p.evaluate((id) => {
    const pp = window.game.netClient.puppets.all.get(id);
    let body = null;
    pp?.model.object.traverse((o) => o.isMesh && o.material.name?.includes('@finish:') && (body = o.material.color.getHexString()));
    return { here: !!pp, skin: pp?.model.weaponSkin ?? null, body };
  }, id);

test('7–9. a room: each sees the other’s skin on the weapon held; a forged claim shows the default; rejoin and a host hand-over keep it; combat untouched', async () => {
  const host = await openGame(env, { mode: 'deathmatch', width: 480, height: 270 });
  const member = await openGame(env, { mode: 'training', width: 480, height: 270 });
  const third = await openGame(env, { mode: 'training', width: 480, height: 270 });
  const all = [host, member, third];
  for (const p of all) p.setDefaultTimeout(60000);
  try {
    // The member wears FDE on AR-01; the host wears OD green on SR-01.
    assert.equal(await wear(member, 'ar01.fde', 'ar01'), true);
    assert.equal(await wear(host, 'sr01.olive', 'sr01'), true);
    const code = await enter(host, 'Alpha');
    await enter(member, 'Bravo', code);
    await host.waitForFunction(() => window.game.squad.bots.some((b) => b.remote));
    // The member holds its AR-01: the host sees FDE on that character's rifle.
    await host.waitForFunction(() => {
      const g = window.game;
      const i = g.squad.bots.findIndex((b) => b.remote);
      return g.squad['models'][i]?.weaponSkin === 'finish:ar01.fde';
    });
    assert.deepEqual(await hostSees(host), { skin: 'finish:ar01.fde', body: '8a7553' });

    // The host holds AR-01 (no skin of its own there): the member sees the default; SR-01: OD green.
    const hostId = await host.evaluate(() => window.game.net.id);
    await member.waitForFunction((id) => window.game.netClient.puppets.all.has(id), hostId);
    assert.deepEqual(await memberSees(member, hostId), { here: true, skin: null, body: null });
    await host.evaluate(() => {
      const g = window.game;
      g.weapons.equipSlot(1);
      g.showWeaponModel(g.weapons.weapon.def);
    });
    await member.waitForFunction((id) => window.game.netClient.puppets.all.get(id)?.model.weaponSkin === 'finish:sr01.olive', hostId);
    assert.deepEqual(await memberSees(member, hostId), { here: true, skin: 'finish:sr01.olive', body: '4b4f36' });
    // First person on the host: the same skin on the real model.
    await host.waitForFunction(() => {
      let ok = false;
      window.game.viewModel.currentView.object.traverse((o) => o.isMesh && [o.material].flat().some((m) => m.name?.endsWith('@finish:sr01.olive')) && (ok = true));
      return ok;
    });

    // Forged claims straight to the host: none of these is a skin that fits the weapon → the default look.
    await member.evaluate(() => window.game.net.send({ k: 'looks', s: { ar01: 'smg02.coyote', sr01: 'nope', karambit: 'gloves.coyote', lmg02: 'ar01.fde', smg02: { evil: 1 } } }));
    await host.waitForFunction(() => {
      const g = window.game;
      const i = g.squad.bots.findIndex((b) => b.remote);
      return g.squad['models'][i]?.weaponSkin === undefined;
    });
    assert.deepEqual(await hostSees(host), { skin: null, body: null });
    // A registered, fitting skin the member does not own is shown: ownership cannot be proven here (documented limit).
    await member.evaluate(() => window.game.net.send({ k: 'looks', s: { ar01: 'ar01.urban' } }));
    await host.waitForFunction(() => {
      const g = window.game;
      const i = g.squad.bots.findIndex((b) => b.remote);
      return g.squad['models'][i]?.weaponSkin === 'finish:ar01.urban';
    });
    // The member's own record says again what it wears.
    await member.evaluate(() => window.game.netClient.sendLooks());
    await host.waitForFunction(() => {
      const g = window.game;
      const i = g.squad.bots.findIndex((b) => b.remote);
      return g.squad['models'][i]?.weaponSkin === 'finish:ar01.fde';
    });

    // Rejoin: the member leaves and comes back by code; its skin is shown again.
    await member.click('.mp-leave');
    await host.waitForFunction(() => !window.game.squad.bots.some((b) => b.remote));
    await enter(member, 'Bravo', code);
    await host.waitForFunction(() => {
      const g = window.game;
      const i = g.squad.bots.findIndex((b) => b.remote);
      return i >= 0 && g.squad['models'][i]?.weaponSkin === 'finish:ar01.fde';
    });

    // A third player watches; the host leaves: the member hosts now, and the third player sees its FDE rifle.
    await enter(third, 'Charlie', code);
    // While the host runs the match, the member's character goes by its seat (bot) id; once it hosts, by its own id.
    const seat = await host.evaluate(() => window.game.squad.bots.find((b) => b.remote).id);
    const memberId = await member.evaluate(() => window.game.net.id);
    await third.waitForFunction((id) => window.game.netClient.puppets.all.get(id)?.model.weaponSkin === 'finish:ar01.fde', seat);
    assert.deepEqual(await memberSees(third, seat), { here: true, skin: 'finish:ar01.fde', body: '8a7553' });
    await host.click('.mp-leave');
    await member.waitForFunction(() => window.game.netHost && window.game.match && window.game.squad);
    await third.waitForFunction((id) => window.game.netClient?.myId && window.game.netClient.puppets.all.get(id)?.model.weaponSkin === 'finish:ar01.fde', memberId);
    assert.deepEqual(await memberSees(third, memberId), { here: true, skin: 'finish:ar01.fde', body: '8a7553' });

    // Looks only: the weapon definitions and a hit's damage are what they were.
    const combat = await member.evaluate(async () => {
      const { WEAPONS } = await import('/src/weapons/weapons.ts');
      const { computeDamage } = await import('/src/combat/HitscanSystem.ts');
      return { ar01: [WEAPONS.ar01.damage.base, WEAPONS.ar01.fireRate, WEAPONS.ar01.magazineSize], hit: computeDamage(WEAPONS.ar01.damage, 'body', 10) };
    });
    assert.deepEqual(combat, { ar01: [24, 600, 30], hit: 24 });
    // One skinned stand-in material per skin and kit material, not per character or frame.
    assert.ok((await member.evaluate(async () => (await import('/src/skins/StandInSkin.ts')).standInMaterialCount())) <= 6);
    for (const p of all) assert.deepEqual(p.errors, []);
  } finally {
    for (const p of all) await p.context().close();
  }
});
