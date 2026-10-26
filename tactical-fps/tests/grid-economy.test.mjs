// GRID economy core (src/economy): catalog checks, wallet, inventory,
// loadout, shop purchases, match rewards and daily missions, run in Node
// (Vite ssrLoadModule; no browser). Each test builds its own account on an
// in-memory repository with a fixed clock.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { ROOT } from './harness.mjs';

let vite;
let M;

before(async () => {
  vite = await createServer({ root: ROOT, logLevel: 'error', server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom' });
  const load = (p) => vite.ssrLoadModule(p);
  M = {
    ...(await load('/src/economy/SkinCatalog.ts')),
    ...(await load('/src/economy/EconomyAuthority.ts')),
    ...(await load('/src/economy/AccountRepository.ts')),
    ...(await load('/src/economy/EconomyClock.ts')),
    ...(await load('/src/economy/EconomyRules.ts')),
    ...(await load('/src/economy/RewardService.ts')),
    ...(await load('/src/economy/EconomyBackend.ts')),
  };
});
after(async () => {
  await vite?.close();
});

/** A fresh account (500 starting credits) on an in-memory store. */
async function fresh(day = '2026-10-26') {
  const repo = new M.MemoryAccountRepository();
  const clock = new M.FixedClock(day);
  let n = 0;
  const auth = new M.EconomyAuthority(repo, clock, () => 'acct-test');
  await auth.init();
  const rid = (k) => `${k}-${++n}-req`;
  return { repo, clock, auth, rid };
}

const match = (o = {}) => ({ matchId: 'm-0001', mode: 'team', outcome: 'completed', won: true, kills: { ar01: 4 }, roundWins: 5, durationSeconds: 600, ...o });

test('catalog: valid (unique ids, whole prices, known targets, one free unsold default per slot), all four categories, every weapon id', () => {
  assert.deepEqual(M.validateCatalog(M.SKIN_CATALOG), []);
  const cats = new Set(M.SKIN_CATALOG.map((s) => s.category));
  assert.deepEqual([...cats].sort(), ['character', 'gloves', 'knife', 'weapon']);
  assert.deepEqual(M.allSlots().sort(), ['character:player', 'gloves:player', 'knife:karambit', 'weapon:ar01', 'weapon:pis01', 'weapon:sg01', 'weapon:smg01', 'weapon:sr01']);
  // The checker catches bad data.
  const bad = [
    { ...M.SKIN_CATALOG[8], price: -5 },
    { ...M.SKIN_CATALOG[8], price: 1.5, skinId: 'x.frac' },
    { ...M.SKIN_CATALOG[8], skinId: 'x.target', targets: ['rpg'] },
    { ...M.SKIN_CATALOG[0], skinId: 'x.default', price: 10 },
  ];
  const problems = M.validateCatalog(bad);
  assert.ok(problems.some((p) => p.includes('invalid price -5')));
  assert.ok(problems.some((p) => p.includes('invalid price 1.5')));
  assert.ok(problems.some((p) => p.includes('invalid targets rpg')));
  assert.ok(problems.some((p) => p.includes('must be free')));
});

test('new account: starting credits with a ledger entry, default looks in every slot, nothing owned', async () => {
  const { auth } = await fresh();
  const a = auth.account();
  assert.equal(a.credits, M.STARTING_CREDITS);
  assert.equal(a.ledger.length, 1);
  assert.deepEqual([a.ledger[0].kind, a.ledger[0].amount, a.ledger[0].balanceAfter], ['grant', 500, 500]);
  assert.deepEqual(a.items, []);
  assert.deepEqual(a.loadout, {});
  assert.deepEqual(Object.keys(a.missions.missions).sort(), M.DAILY_MISSIONS.map((m) => m.missionId).sort());
});

test('purchase: catalog price charged, item added, ledger entry; owned → refused; too expensive → refused; unknown / default / bad id → refused; nothing changes on refusal', async () => {
  const { auth, rid } = await fresh();
  const ok = await auth.purchase('ar01.fde', rid('buy'));
  assert.equal(ok.ok, true);
  assert.equal(ok.account.credits, 100);
  assert.equal(ok.account.items.length, 1);
  assert.equal(ok.value.skinId, 'ar01.fde');
  const tx = ok.account.ledger.at(-1);
  assert.deepEqual([tx.kind, tx.amount, tx.balanceAfter, tx.ref], ['purchase', -400, 100, 'ar01.fde']);
  assert.match(tx.txId, /^acct-test-tx-\d+$/);
  const before = auth.account();
  for (const [id, error] of [
    ['ar01.fde', 'owned'],
    ['ar01.urban', 'insufficient_funds'],
    ['nope.skin', 'unknown_item'],
    ['ar01.default', 'not_for_sale'],
    [42, 'unknown_item'],
  ]) {
    const r = await auth.purchase(id, rid('buy'));
    assert.deepEqual([r.ok, r.error], [false, error], String(id));
  }
  assert.deepEqual(auth.account(), before, 'refusals change nothing');
});

test('purchase is atomic and idempotent: a failed save charges nothing; a resent request id is charged once; racing requests for one skin sell it once', async () => {
  const { auth, repo, rid } = await fresh();
  // Storage failure: no charge, no item, nothing remembered; the retry goes through once.
  repo.failSaves = 1;
  const before = auth.account();
  const failed = await auth.purchase('pis01.fde', rid('buy'));
  assert.deepEqual([failed.ok, failed.error], [false, 'storage_error']);
  assert.deepEqual(auth.account(), before);
  const retried = await auth.purchase('pis01.fde', rid('buy'));
  assert.deepEqual([retried.ok, retried.account.credits, retried.account.items.length], [true, 250, 1]);
  await auth.submitMatchResult(match({ matchId: 'm-0001' })); // +290 → 540
  // The same request sent twice at once (double click / resend): one charge, one item, same answer.
  const id = rid('buy');
  const [a, b] = await Promise.all([auth.purchase('gloves.coyote', id), auth.purchase('gloves.coyote', id)]);
  assert.deepEqual([a.ok, b.ok, a.value?.skinId, b.value?.skinId], [true, true, 'gloves.coyote', 'gloves.coyote']);
  assert.equal(auth.account().credits, 240);
  assert.equal(auth.account().items.filter((i) => i.skinId === 'gloves.coyote').length, 1);
  assert.equal(auth.account().ledger.filter((t) => t.ref === 'gloves.coyote').length, 1);
  // Two different requests racing for one skin: one sale, the other refused as owned.
  await auth.submitMatchResult(match({ matchId: 'm-0002' })); // +290 → 530
  const [c, d] = await Promise.all([auth.purchase('gloves.ranger', rid('buy')), auth.purchase('gloves.ranger', rid('buy'))]);
  assert.deepEqual([c.ok, d.ok, d.error], [true, false, 'owned']);
  assert.equal(auth.account().credits, 230);
  assert.ok(auth.account().credits >= 0);
});

test('loadout: only owned, fitting items; a weapon skin only on its own weapon; categories never cross; unequip = default; survives a reload of the account', async () => {
  const { auth, repo, rid, clock } = await fresh();
  const bought = await auth.purchase('ar01.fde', rid('buy'));
  const item = bought.value.itemId;
  const r = (cat, target, id) => auth.equip(cat, target, id, rid('eq')).then((x) => (x.ok ? 'ok' : x.error));
  assert.equal(await r('weapon', 'ar01', 'acct-test-item-999'), 'not_owned');
  assert.equal(await r('weapon', 'smg01', item), 'incompatible', 'AR-01 skin on the SMG');
  assert.equal(await r('gloves', 'player', item), 'incompatible', 'a weapon skin in the glove slot');
  assert.equal(await r('weapon', 'rpg', item), 'invalid_request');
  assert.equal(await r('weapon', 'ar01', item), 'ok');
  assert.deepEqual(auth.account().loadout, { 'weapon:ar01': item });
  // A fresh authority on the same store (a page reload): the same items and loadout.
  const again = new M.EconomyAuthority(repo, clock, () => 'other');
  const reloaded = await again.init();
  assert.deepEqual([reloaded.accountId, reloaded.loadout, reloaded.items.map((i) => i.skinId)], ['acct-test', { 'weapon:ar01': item }, ['ar01.fde']]);
  assert.equal(await r('weapon', 'ar01', null), 'ok');
  assert.deepEqual(auth.account().loadout, {}, 'back to the default look');
});

test('match rewards: completed matches pay by the rules (capped kill bonus); forfeit, abandoned, training and too-short matches pay 0; a match id pays once; bad reports are refused', async () => {
  const { auth } = await fresh();
  const pay = async (o) => {
    const r = await auth.submitMatchResult(match(o));
    return r.ok ? r.value.credits : r.error;
  };
  assert.equal(M.matchReward(match()), 100 + 150 + 40);
  assert.equal(await pay({ matchId: 'team-win' }), 290);
  assert.equal(await pay({ matchId: 'team-win' }), 290, 'resent: same answer');
  assert.equal(auth.account().credits, 500 + 290, '...but paid once');
  assert.equal(await pay({ matchId: 'team-loss', won: false, kills: { ar01: 30 } }), 100 + 100, 'kill bonus capped at 100');
  assert.equal(await pay({ matchId: 'dm-first', mode: 'deathmatch', won: true, kills: { ar01: 20, sr01: 5 }, roundWins: 0 }), 60 + 80 + 50);
  for (const [o, why] of [
    [{ matchId: 'forfeit-1', outcome: 'forfeit' }, 'forfeit'],
    [{ matchId: 'abandon-1', outcome: 'abandoned' }, 'abandoned'],
    [{ matchId: 'train-1', mode: 'training' }, 'training'],
    [{ matchId: 'short-1', durationSeconds: 20 }, 'shorter than a minute'],
  ]) assert.equal(await pay(o), 0, why);
  const credits = auth.account().credits;
  for (const o of [{ kills: { ar01: -3 } }, { kills: { ar01: 2.5 } }, { kills: { ar01: 9999 } }, { roundWins: 99 }, { mode: 'ranked' }, { matchId: '' }, { durationSeconds: -1 }]) {
    assert.equal(await pay({ matchId: 'bad-report', ...o }), 'invalid_request', JSON.stringify(o));
  }
  assert.equal(auth.account().credits, credits);
  const rewards = auth.account().ledger.filter((t) => t.kind === 'match_reward');
  assert.deepEqual(rewards.map((t) => t.ref), ['team-win', 'team-loss', 'dm-first']);
});

test('daily missions: progress only from completed matches, each match once; completion and claim are separate; one payout per claim; a new day starts over; training / forfeit never count', async () => {
  const { auth, clock, rid } = await fresh();
  const mission = (id) => auth.account().missions.missions[id];
  const claim = (id) => auth.claimMission(id, rid('claim')).then((r) => (r.ok ? 'ok' : r.error));
  assert.equal(await claim('daily.match'), 'not_completed');
  await auth.submitMatchResult(match({ matchId: 'train-9', mode: 'training', kills: { ar01: 50 } }));
  await auth.submitMatchResult(match({ matchId: 'forfeit-9', outcome: 'forfeit', kills: { ar01: 9 } }));
  assert.deepEqual(mission('daily.kills'), { progress: 0, completed: false, claimed: false }, 'training and forfeits move nothing');
  await auth.submitMatchResult(match({ matchId: 'match-a', kills: { ar01: 4, sr01: 2 }, roundWins: 2 }));
  await auth.submitMatchResult(match({ matchId: 'match-a', kills: { ar01: 4, sr01: 2 }, roundWins: 2 }));
  assert.deepEqual(mission('daily.kills'), { progress: 6, completed: false, claimed: false }, 'the same match counted once');
  assert.deepEqual(mission('daily.match'), { progress: 1, completed: true, claimed: false });
  assert.deepEqual(mission('daily.rounds'), { progress: 2, completed: false, claimed: false });
  await auth.submitMatchResult(match({ matchId: 'match-b', mode: 'deathmatch', kills: { sr01: 5 }, roundWins: 0 }));
  assert.deepEqual(mission('daily.kills'), { progress: 10, completed: true, claimed: false }, 'capped at the target');
  assert.deepEqual(mission('daily.sr01'), { progress: 3, completed: true, claimed: false });
  const before = auth.account().credits;
  const [x, y] = await Promise.all([claim('daily.kills'), claim('daily.kills')]);
  assert.deepEqual([x, y].sort(), ['already_claimed', 'ok']);
  assert.equal(await claim('daily.kills'), 'already_claimed');
  assert.equal(await claim('daily.nope'), 'unknown_item');
  assert.equal(auth.account().credits, before + 150, 'paid once');
  assert.equal(mission('daily.kills').claimed, true);
  // Next day: everything starts over (unclaimed rewards of yesterday lapse).
  clock.day = '2026-10-27';
  const today = await auth.refreshDay();
  assert.equal(today.missions.day, '2026-10-27');
  assert.ok(Object.values(today.missions.missions).every((p) => p.progress === 0 && !p.completed && !p.claimed));
  assert.equal(await claim('daily.match'), 'not_completed');
});

test('the client backend: one request per click target at a time; never sends a price; reports changes', async () => {
  const repo = new M.MemoryAccountRepository();
  const be = new M.LocalEconomyBackend(repo, new M.FixedClock('2026-10-26'));
  const changes = [];
  be.onChange = (a) => changes.push(a.credits);
  const a0 = await be.getAccount();
  assert.equal(a0.credits, 500);
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => be.purchase('ar01.fde')));
  assert.ok(results.every((r) => r.ok), 'five quick clicks: the same single purchase');
  const a1 = await be.getAccount();
  assert.equal(a1.credits, 100);
  assert.equal(a1.items.length, 1);
  assert.deepEqual(changes, [100]);
  const again = await be.purchase('ar01.fde');
  assert.deepEqual([again.ok, again.error], [false, 'owned']);
  assert.equal(M.LocalEconomyBackend.prototype.purchase.length, 1, 'purchase(skinId): no price parameter');
});

test('sync: another device saved a newer record → this change is refused as a conflict, nothing is overwritten', async () => {
  const { auth, repo, rid } = await fresh();
  const theirs = auth.account();
  theirs.revision += 5;
  theirs.credits = 9999;
  repo.overwrite(theirs);
  const r = await auth.purchase('ar01.fde', rid('buy'));
  assert.deepEqual([r.ok, r.error], [false, 'conflict']);
  assert.equal((await repo.load()).credits, 9999, 'the newer record is kept');
});

test('looks: every sold skin has a look of its own kind for real file materials; unknown or failed assets fall back to the factory look', async () => {
  const L = await vite.ssrLoadModule('/src/skins/SkinLooks.ts');
  const kindFor = { weapon: 'weapon', knife: 'weapon', gloves: 'arms', character: 'outfit' };
  for (const s of M.SKIN_CATALOG) {
    if (s.isDefault) {
      assert.equal(s.assetId, 'default');
      continue;
    }
    const look = L.lookOf(s.assetId, kindFor[s.category]);
    assert.ok(look, `${s.skinId}: look ${s.assetId}`);
    if (look.kind === 'weapon') {
      const roles = L.WEAPON_MATERIAL_ROLES[s.targets[0]];
      assert.ok(roles, `${s.skinId}: material roles for ${s.targets[0]}`);
      for (const role of ['body', 'accent', 'metal']) if (look[role]) assert.ok(roles[role]?.length, `${s.skinId}: ${role} has materials`);
    }
  }
  assert.equal(L.lookOf('finish:does-not-exist', 'weapon'), null);
  assert.equal(L.lookOf('arms:gloves.coyote', 'weapon'), null, 'a look of the wrong kind is not used');
  assert.equal(L.lookOf(undefined, 'outfit'), null);
});
