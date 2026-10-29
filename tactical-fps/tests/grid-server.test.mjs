// GRID online groundwork, in Node: the reference account server
// (server/AccountApi.ts) behind a real HTTP server, called by the client
// backend (RemoteEconomyBackend) — authentication, server-decided prices
// and balances, idempotency keys, concurrent purchases, storage failure and
// retry, unreachable server, unverified match results, sync planning — and
// the server-side trade model (server/TradeService.ts): state changes,
// atomic ownership transfer, replays, locks, expiry, cancellation,
// suspended accounts, failed commits, audit log.
//
// This is a model of the service, not a deployed server: there is no GRID
// account server, database or identity provider yet.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from 'vite';
import { ROOT } from './harness.mjs';

let vite;
let M;

before(async () => {
  vite = await createServer({ root: ROOT, logLevel: 'error', server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom' });
  const load = (p) => vite.ssrLoadModule(p);
  M = {
    ...(await load('/src/economy/server/AccountApi.ts')),
    ...(await load('/src/economy/server/TradeService.ts')),
    ...(await load('/src/economy/RemoteEconomyBackend.ts')),
    ...(await load('/src/economy/AccountRepository.ts')),
    ...(await load('/src/economy/EconomyClock.ts')),
    ...(await load('/src/economy/EconomyAuthority.ts')),
  };
});
after(async () => {
  await vite?.close();
});

/** The account server on a local port; tokens "token-<user>" belong to <user>. */
async function startServer(options = {}) {
  const repos = new Map();
  const repoFor = (id) => {
    if (!repos.has(id)) repos.set(id, new M.MemoryAccountRepository());
    return repos.get(id);
  };
  const api = new M.AccountApi({ verify: (t) => (/^token-[a-z]+$/.test(t) ? t.slice(6) : null) }, repoFor, new M.FixedClock('2026-10-26'), options);
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const r = await api.handle({ method: req.method, path: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : undefined });
    res.writeHead(r.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(r.body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, repos, close: () => new Promise((r) => server.close(r)) };
}

test('account API: no sign-in → 401 and nothing changes; the price is the server’s (a price in the request is ignored); the client shows the server’s balance', async () => {
  const s = await startServer();
  try {
    const anon = await fetch(s.url + '/v1/purchase', { method: 'POST', headers: { 'idempotency-key': 'k-0001', 'content-type': 'application/json' }, body: JSON.stringify({ skinId: 'ar01.fde' }) });
    assert.equal(anon.status, 401);
    assert.deepEqual(await anon.json(), { ok: false, error: 'unauthenticated' });
    const bad = await fetch(s.url + '/v1/account', { headers: { authorization: 'Bearer forged' } });
    assert.equal(bad.status, 401);
    assert.equal(s.repos.size, 0, 'no account was touched');
    // A tampered client sends its own price and balance: the server charges the catalog price from its own balance.
    const tampered = await fetch(s.url + '/v1/purchase', { method: 'POST', headers: { authorization: 'Bearer token-ana', 'idempotency-key': 'k-0002', 'content-type': 'application/json' }, body: JSON.stringify({ skinId: 'ar01.fde', price: 0, credits: 999999 }) });
    const t = await tampered.json();
    assert.deepEqual([tampered.status, t.ok, t.account.credits], [200, true, 100]);
    const client = new M.RemoteEconomyBackend(s.url, () => 'token-ana');
    const a = await client.getAccount();
    assert.equal(a.credits, 100, 'the client shows the server balance');
    const signedOut = new M.RemoteEconomyBackend(s.url, () => null);
    const r = await signedOut.purchase('gloves.coyote');
    assert.deepEqual([r.ok, r.error], [false, 'unauthenticated']);
  } finally {
    await s.close();
  }
});

const poster = (url, user) => (key, path, body) =>
  fetch(url + path, { method: 'POST', headers: { authorization: `Bearer token-${user}`, 'idempotency-key': key, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));

test('account API: concurrent purchases of one skin sell it once; a resent idempotency key is applied once', async () => {
  const s = await startServer();
  try {
    const bob = poster(s.url, 'bob');
    const racing = await Promise.all([bob('k-a1', '/v1/purchase', { skinId: 'gloves.coyote' }), bob('k-a2', '/v1/purchase', { skinId: 'gloves.coyote' }), bob('k-a3', '/v1/purchase', { skinId: 'gloves.coyote' })]);
    assert.deepEqual(racing.map((r) => r.ok).sort(), [false, false, true]);
    assert.deepEqual(racing.filter((r) => !r.ok).map((r) => r.error), ['owned', 'owned']);
    const cat = poster(s.url, 'cat');
    const resent = await Promise.all([cat('k-b1', '/v1/purchase', { skinId: 'ar01.fde' }), cat('k-b1', '/v1/purchase', { skinId: 'ar01.fde' })]);
    assert.deepEqual(resent.map((r) => r.ok), [true, true], 'the same answer twice');
    const bobAcc = await s.repos.get('bob').load();
    const catAcc = await s.repos.get('cat').load();
    assert.deepEqual([bobAcc.credits, bobAcc.items.length], [200, 1]);
    assert.deepEqual([catAcc.credits, catAcc.items.length, catAcc.ledger.filter((t) => t.kind === 'purchase').length], [100, 1, 1], 'charged once');
  } finally {
    await s.close();
  }
});

test('account API: a storage failure is reported and changes nothing; the retry with the same key goes through once; an unreachable server changes nothing on the client', async () => {
  const s = await startServer();
  try {
    const dan = poster(s.url, 'dan');
    const client = new M.RemoteEconomyBackend(s.url, () => 'token-dan');
    await client.getAccount();
    s.repos.get('dan').failSaves = 1;
    const failed = await dan('k-c1', '/v1/purchase', { skinId: 'ar01.fde' });
    assert.deepEqual([failed.status, failed.ok, failed.error, failed.account.credits], [503, false, 'storage_error', 500]);
    const retry = await dan('k-c1', '/v1/purchase', { skinId: 'ar01.fde' });
    const again = await dan('k-c1', '/v1/purchase', { skinId: 'ar01.fde' });
    assert.deepEqual([retry.ok, again.ok, (await s.repos.get('dan').load()).credits], [true, true, 100]);
    // The client refreshes (now 100), then the server goes away: the client reports it; nothing local is written.
    assert.equal((await client.getAccount()).credits, 100);
    await s.close();
    const r = await client.purchase('gloves.coyote');
    assert.deepEqual([r.ok, r.error], [false, 'network']);
    assert.equal(r.account.credits, 100, 'last server state shown, unchanged');
    assert.equal(typeof globalThis.localStorage, 'undefined', 'the remote client has no local store to touch (Node)');
  } finally {
    await s.close().catch(() => {});
  }
});

test('account API: match results reported by a client are not paid online (only server-verified ones); a trusted test build pays them once; missions claim once', async () => {
  const s = await startServer();
  const t = await startServer({ trustClientResults: true });
  try {
    const result = { matchId: 'team-online-1', mode: 'team', outcome: 'completed', won: true, kills: { sr01: 3 }, roundWins: 3, durationSeconds: 700 };
    const r = await poster(s.url, 'eve')('k-d1', '/v1/match-results', { result });
    assert.deepEqual([r.status, r.ok, r.error], [403, false, 'unverified']);
    const eve = poster(t.url, 'eve');
    const paid = await eve('k-d2', '/v1/match-results', { result });
    const twice = await eve('k-d3', '/v1/match-results', { result });
    assert.deepEqual([paid.value.credits, twice.value.credits], [100 + 150 + 30, 280], 'resent: the same answer…');
    assert.equal((await t.repos.get('eve').load()).ledger.filter((x) => x.kind === 'match_reward').length, 1, '…paid once');
    const claims = await Promise.all([eve('k-d4', '/v1/missions/daily.sr01/claim'), eve('k-d5', '/v1/missions/daily.sr01/claim')]);
    assert.deepEqual(claims.map((c) => c.ok ? 'ok' : c.error).sort(), ['already_claimed', 'ok']);
    const acc = await t.repos.get('eve').load();
    assert.equal(acc.credits, 500 + 280 + 200);
  } finally {
    await s.close();
    await t.close();
  }
});

test('sync planning never overwrites on its own: identical → use the server copy; only one side → explicit choice; both differ → conflict', async () => {
  const a = M.newAccount('acct', '2026-10-26');
  const b = structuredClone(a);
  assert.equal(M.planSync(null, null), 'nothing');
  assert.equal(M.planSync(null, b), 'use_remote');
  assert.equal(M.planSync(a, null), 'offer_upload');
  assert.equal(M.planSync(a, b), 'use_remote');
  b.credits += 50;
  assert.equal(M.planSync(a, b), 'conflict');
});

// --- Trades -------------------------------------------------------------------------

/** Two accounts, each owning some skins (as the server would hold them). */
function tradeWorld(now = { t: 1000 }) {
  const store = new M.MemoryTradeStore();
  const mk = (id, skins) => {
    const a = M.newAccount(id, '2026-10-26');
    a.items = skins.map((skinId, k) => ({ itemId: `${id}-item-${k + 1}`, skinId, acquiredAt: '2026-10-26T00:00:00Z', source: 'purchase' }));
    store.accounts.set(id, { state: a, suspended: false });
  };
  mk('ana', ['ar01.fde', 'gloves.coyote']);
  mk('bob', ['karambit.oxide', 'character.urban']);
  mk('cid', ['ar01.ranger']);
  const svc = new M.TradeService(store, () => now.t, 60_000);
  const owners = () => {
    const out = {};
    for (const [id, a] of store.accounts) for (const i of a.state.items) (out[i.itemId] ??= []).push(id);
    return out;
  };
  return { store, svc, now, owners };
}

test('trade: both confirm → the same item instances change owner in one step, the giver’s loadout is cleared, the audit log has every step; a resent confirm moves nothing twice', async () => {
  const { store, svc, owners } = tradeWorld();
  store.accounts.get('ana').state.loadout['weapon:ar01'] = 'ana-item-1';
  const p = svc.propose('r-0001', 'ana', 'bob', ['ana-item-1'], ['bob-item-1']);
  assert.equal(p.ok, true);
  assert.deepEqual(p.trade.confirmed, { from: false, to: false });
  const c1 = svc.confirm('r-0002', p.trade.tradeId, 'ana');
  assert.equal(c1.trade.state, 'open', 'one side is not enough');
  const c2 = svc.confirm('r-0003', p.trade.tradeId, 'bob');
  assert.equal(c2.trade.state, 'completed');
  const o = owners();
  assert.deepEqual([o['ana-item-1'], o['bob-item-1']], [['bob'], ['ana']]);
  assert.ok(Object.values(o).every((list) => list.length === 1), 'no item in two accounts');
  assert.deepEqual(store.accounts.get('ana').state.loadout, {}, 'the traded skin left the loadout');
  assert.equal(store.accounts.get('bob').state.items.find((i) => i.itemId === 'ana-item-1').source, 'trade');
  // Replays: same request id → same answer, nothing moves again.
  const replay = svc.confirm('r-0003', p.trade.tradeId, 'bob');
  assert.deepEqual(replay, c2);
  assert.deepEqual(owners(), o);
  const events = store.audit.filter((e) => e.tradeId === p.trade.tradeId).map((e) => e.event);
  assert.deepEqual(events, ['proposed', 'confirmed', 'confirmed', 'completed']);
});

test('trade: refused when an item is not owned, not tradable, already in an open trade, would duplicate a skin, an account is suspended, or the request is malformed', async () => {
  const { store, svc } = tradeWorld();
  const err = (r) => (r.ok ? 'ok' : r.error);
  assert.equal(err(svc.propose('r-1001', 'ana', 'bob', ['bob-item-1'], [])), 'not_owned');
  store.accounts.get('ana').state.items.push({ itemId: 'ana-item-x', skinId: 'ar01.default', acquiredAt: '', source: 'grant' });
  assert.equal(err(svc.propose('r-1002', 'ana', 'bob', ['ana-item-x'], [])), 'not_tradable');
  assert.equal(err(svc.propose('r-1003', 'ana', 'cid', ['ana-item-2'], [])), 'ok');
  assert.equal(err(svc.propose('r-1004', 'ana', 'bob', ['ana-item-2'], [])), 'item_locked', 'already offered to cid');
  store.accounts.get('cid').state.items.push({ itemId: 'cid-item-9', skinId: 'ar01.fde', acquiredAt: '', source: 'purchase' });
  assert.equal(err(svc.propose('r-1005', 'ana', 'cid', ['ana-item-1'], [])), 'duplicate_skin');
  store.accounts.get('bob').suspended = true;
  assert.equal(err(svc.propose('r-1006', 'ana', 'bob', [], ['bob-item-2'])), 'suspended');
  for (const [from, to, give, want] of [
    ['ana', 'ana', ['ana-item-1'], []],
    ['ana', 'bob', [], []],
    ['ana', 'bob', ['ana-item-1', 'ana-item-1'], []],
  ]) assert.equal(err(svc.propose('r-' + Math.random().toString(36).slice(2, 8), from, to, give, want)), 'invalid_request');
  assert.equal(err(svc.propose('r-1007', 'ana', 'zed', ['ana-item-1'], [])), 'unknown_account');
});

test('trade: cancelled, expired and failed trades keep every item where it was; a suspension or a failed commit at confirmation moves nothing', async () => {
  const { store, svc, now, owners } = tradeWorld();
  const before = owners();
  const a = svc.propose('r-2001', 'ana', 'bob', ['ana-item-1'], ['bob-item-1']);
  assert.equal(svc.cancel('r-2002', a.trade.tradeId, 'cid').error, 'not_a_party');
  assert.equal(svc.cancel('r-2003', a.trade.tradeId, 'bob').trade.state, 'cancelled');
  assert.equal(svc.confirm('r-2004', a.trade.tradeId, 'ana').error, 'not_open');
  const b = svc.propose('r-2005', 'ana', 'bob', ['ana-item-1'], ['bob-item-1']);
  svc.confirm('r-2006', b.trade.tradeId, 'ana');
  now.t += 61_000;
  assert.equal(svc.confirm('r-2007', b.trade.tradeId, 'bob').error, 'expired');
  const c = svc.propose('r-2008', 'ana', 'bob', ['ana-item-1'], ['bob-item-1']);
  svc.confirm('r-2009', c.trade.tradeId, 'ana');
  store.failCommits = 1;
  const failed = svc.confirm('r-2010', c.trade.tradeId, 'bob');
  assert.deepEqual([failed.ok, failed.error, failed.trade.state], [false, 'storage_error', 'failed']);
  const d = svc.propose('r-2011', 'ana', 'bob', ['ana-item-2'], []);
  svc.confirm('r-2012', d.trade.tradeId, 'ana');
  store.accounts.get('bob').suspended = true;
  assert.equal(svc.confirm('r-2013', d.trade.tradeId, 'bob').error, 'suspended');
  assert.deepEqual(owners(), before, 'every item still with its owner');
  // Only trade d is still open (bob's suspended confirmation was refused): it holds its one item.
  assert.deepEqual([...svc.lockedItems()], ['ana-item-2']);
  store.accounts.get('bob').suspended = false;
  now.t += 61_000;
  assert.equal(svc.expireDue(), 1);
  assert.equal(svc.lockedItems().size, 0, 'expired trades release their items');
});
