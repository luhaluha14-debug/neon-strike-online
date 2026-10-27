// GRID account client pieces in Node, with a scripted fetch: server
// detection (a game page answering /api/health is "no server"), the server
// economy client (cookie session, CSRF header, one key per request reused
// for its one retry, nothing changed when unreachable, signed-out
// detection), switching between the offline record and the server account
// without copying anything, the "offline record is not moved" notice, and
// the sync policy (never overwrite on its own).

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
    ...(await load('/src/economy/AccountClient.ts')),
    ...(await load('/src/economy/AccountSession.ts')),
    ...(await load('/src/economy/AccountProtocol.ts')),
    ...(await load('/src/economy/EconomyBackend.ts')),
    ...(await load('/src/economy/AccountRepository.ts')),
    ...(await load('/src/economy/EconomyClock.ts')),
    ...(await load('/src/economy/RemoteEconomyBackend.ts')),
  };
});
after(async () => {
  await vite?.close();
});

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** fetch scripted by a route table; records every call. */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (path, init = {}) => {
    calls.push({ path, method: init.method ?? 'GET', headers: { ...(init.headers ?? {}) }, body: init.body, credentials: init.credentials });
    const r = routes[`${init.method ?? 'GET'} ${path}`] ?? routes[path];
    if (!r) return new Response('<!doctype html><title>game</title>', { status: 200, headers: { 'content-type': 'text/html' } });
    return typeof r === 'function' ? r(init, calls) : r.clone();
  };
  fn.calls = calls;
  return fn;
}

const serverAccount = (credits = 500, items = []) => ({ schema: 1, accountId: 'srv-1', revision: 1, credits, items, loadout: {}, ledger: [], missions: { day: '2026-10-27', missions: {}, seenEvents: [] }, settledMatches: [], requests: {}, seq: 0 });
const memoryStorage = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
};

test('server detection: the GRID health answer only; a game page, a 404, an error or a timeout mean no server', async () => {
  const health = (status, body) => fakeFetch({ '/api/health': json(status, body) });
  assert.equal(await M.probeAccountServer(health(200, { service: 'grid-account', db: 'up' })), 'online');
  assert.equal(await M.probeAccountServer(health(503, { service: 'grid-account', db: 'down' })), 'db_down');
  assert.equal(await M.probeAccountServer(fakeFetch({})), 'absent', 'dev server / static host: the game page');
  assert.equal(await M.probeAccountServer(health(200, { service: 'something-else' })), 'absent');
  assert.equal(await M.probeAccountServer(async () => new Response('', { status: 404 })), 'absent');
  assert.equal(await M.probeAccountServer(async () => Promise.reject(new TypeError('offline'))), 'absent');
  const slow = (_p, init) => new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))));
  assert.equal(await M.probeAccountServer(slow, 50), 'absent');
});

test('server economy client: session cookie + CSRF header, one key per request reused for its single retry; unreachable = nothing changed', async () => {
  let attempts = 0;
  const f = fakeFetch({
    'GET /api/account': json(200, { ok: true, account: serverAccount() }),
    'POST /api/purchase': () => {
      attempts++;
      if (attempts === 1) throw new TypeError('connection reset');
      return json(200, { ok: true, account: serverAccount(100, [{ itemId: 'i1', skinId: 'ar01.fde' }]), value: { itemId: 'i1' } });
    },
    'POST /api/equip': () => Promise.reject(new TypeError('offline')),
  });
  const b = new M.ServerEconomyBackend(f);
  const changes = [];
  b.onChange = (a) => changes.push(a.credits);
  await b.getAccount();
  const r = await b.purchase('ar01.fde');
  assert.equal(r.ok, true);
  const buys = f.calls.filter((c) => c.path === '/api/purchase');
  assert.equal(buys.length, 2);
  assert.equal(buys[0].headers['idempotency-key'], buys[1].headers['idempotency-key'], 'the retry reuses its key');
  assert.match(buys[0].headers['idempotency-key'], /^k-[\w-]{8,}$/);
  assert.equal(buys[0].headers['x-grid-csrf'], '1');
  assert.equal(buys[0].credentials, 'same-origin');
  assert.deepEqual(JSON.parse(buys[0].body), { skinId: 'ar01.fde' }, 'never a price or an account id');
  assert.deepEqual(changes, [100]);
  const e = await b.equip('weapon', 'ar01', 'i1');
  assert.deepEqual([e.ok, e.error, e.account.credits], [false, 'network', 100], 'unreachable: the last server account, nothing changed');
  const keys = f.calls.filter((c) => c.path === '/api/equip').map((c) => c.headers['idempotency-key']);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  assert.notEqual(keys[0], buys[0].headers['idempotency-key'], 'another request, another key');
});

test('server economy client: expired session → signed-out callback; refused client match result → unverified', async () => {
  const f = fakeFetch({
    'GET /api/account': json(200, { ok: true, account: serverAccount() }),
    'POST /api/missions/daily.match/claim': json(401, { ok: false, error: 'unauthenticated' }),
    'POST /api/match-results': json(403, { ok: false, error: 'unverified', account: serverAccount() }),
  });
  const b = new M.ServerEconomyBackend(f);
  const out = [];
  b.onSignedOut = (why) => out.push(why);
  await b.getAccount();
  assert.equal((await b.claimMission('daily.match')).error, 'unauthenticated');
  assert.deepEqual(out, ['unauthenticated']);
  const m = await b.submitMatchResult({ matchId: 'team-x-1', mode: 'team', outcome: 'completed', won: true, kills: {}, roundWins: 7, durationSeconds: 900 });
  assert.deepEqual([m.ok, m.error, m.account.credits], [false, 'unverified', 500]);
});

function localBackend(storage) {
  return new M.LocalEconomyBackend(new M.LocalAccountRepository(storage), new M.FixedClock('2026-10-27'));
}

test('session: signing in switches to the server account without copying the offline record; the notice shows once per account; signing out shows the offline record again', async () => {
  const storage = memoryStorage();
  const local = localBackend(storage);
  // The offline record has a purchase of its own.
  await local.getAccount();
  assert.equal((await local.purchase('gloves.coyote')).ok, true);
  const offline = await local.getAccount();
  let signedIn = false;
  const f = fakeFetch({
    '/api/health': json(200, { service: 'grid-account', db: 'up' }),
    'GET /api/auth/me': () => json(200, { ok: true, account: signedIn ? { accountId: 'srv-1', username: 'kim', displayName: 'kim', status: 'active' } : null }),
    'POST /api/auth/login': () => ((signedIn = true), json(200, { ok: true, account: { accountId: 'srv-1', username: 'kim', displayName: 'kim', status: 'active' } })),
    'POST /api/auth/logout': () => ((signedIn = false), json(200, { ok: true })),
    'GET /api/account': json(200, { ok: true, account: serverAccount() }),
  });
  const economy = new M.SwitchableEconomyBackend(local);
  const shown = [];
  economy.onChange = (a) => shown.push(a.accountId === 'srv-1' ? 'server' : 'offline');
  const s = new M.AccountSession(economy, local, f, storage);
  const modes = [];
  s.onModeChange((m) => modes.push(m.kind));
  assert.equal((await s.start()).kind, 'signed_out');
  assert.equal(economy.kind, 'local');
  const r = await s.login('kim', 'long enough password');
  assert.equal(r.ok, true);
  assert.equal(economy.kind, 'remote');
  assert.equal((await economy.getAccount()).credits, 500, 'the server balance, not the offline one');
  // Nothing of the offline record was sent anywhere.
  for (const c of f.calls) assert.ok(!String(c.body ?? '').includes('gloves.coyote'));
  assert.deepEqual(await s.offlineNotice(), { credits: offline.credits, items: 1 });
  s.acknowledgeNotice();
  assert.equal(await s.offlineNotice(), null, 'acknowledged for this account');
  await s.logout();
  assert.equal(economy.kind, 'local');
  assert.deepEqual(await economy.getAccount(), offline, 'the offline record, unchanged');
  assert.deepEqual(modes, ['signed_out', 'signed_in', 'signed_out']);
  assert.deepEqual(shown, ['server', 'offline']);
  // A fresh offline record (nothing bought, starting credits) needs no notice.
  const fresh = memoryStorage();
  const s2 = new M.AccountSession(new M.SwitchableEconomyBackend(localBackend(fresh)), localBackend(fresh), f, fresh);
  await s2.login('kim', 'long enough password');
  assert.equal(await s2.offlineNotice(), null);
});

test('session: no server → offline (the offline record stays); database down → offline with retry; an expired session falls back to the offline record', async () => {
  const storage = memoryStorage();
  const local = localBackend(storage);
  const none = new M.AccountSession(new M.SwitchableEconomyBackend(local), local, fakeFetch({}), storage);
  assert.deepEqual(await none.start(), { kind: 'offline', reason: 'no_server' });
  const down = new M.AccountSession(new M.SwitchableEconomyBackend(local), local, fakeFetch({ '/api/health': json(503, { service: 'grid-account', db: 'down' }) }), storage);
  assert.deepEqual(await down.start(), { kind: 'offline', reason: 'server_down' });
  let expired = false;
  const f = fakeFetch({
    '/api/health': json(200, { service: 'grid-account', db: 'up' }),
    'GET /api/auth/me': json(200, { ok: true, account: { accountId: 'srv-1', username: 'kim', displayName: 'kim', status: 'active' } }),
    'GET /api/account': () => (expired ? json(401, { ok: false, error: 'unauthenticated' }) : json(200, { ok: true, account: serverAccount() })),
    'POST /api/purchase': json(401, { ok: false, error: 'unauthenticated' }),
  });
  const economy = new M.SwitchableEconomyBackend(local);
  const s = new M.AccountSession(economy, local, f, storage);
  assert.equal((await s.start()).kind, 'signed_in', 'an existing session is picked up');
  expired = true;
  const r = await economy.purchase('ar01.fde');
  assert.equal(r.error, 'unauthenticated');
  await new Promise((res) => setTimeout(res, 0));
  assert.deepEqual(s.mode, { kind: 'signed_out', reason: 'expired' });
  assert.equal(economy.kind, 'local');
});

test('sync policy stays: never overwrite on its own (identical → server copy, one side → explicit choice, both differ → conflict)', () => {
  const a = serverAccount(500);
  const b = serverAccount(300, [{ itemId: 'x', skinId: 'ar01.fde' }]);
  assert.equal(M.planSync(a, structuredClone(a)), 'use_remote');
  assert.equal(M.planSync(null, a), 'use_remote');
  assert.equal(M.planSync(a, null), 'offer_upload');
  assert.equal(M.planSync(a, b), 'conflict');
  assert.equal(M.planSync(null, null), 'nothing');
});

test('sign-up rules are shared by the form and the server', () => {
  assert.equal(M.signupProblem('ab', 'x'.repeat(12)), 'invalid_username');
  assert.equal(M.signupProblem('Good_Name1', 'x'.repeat(12)), null, 'compared in lower case');
  assert.equal(M.signupProblem('good', 'x'.repeat(9)), 'weak_password');
  assert.equal(M.signupProblem('good', 'x'.repeat(129)), 'weak_password');
  assert.equal(M.authMessage('invalid_credentials'), '아이디 또는 비밀번호가 맞지 않습니다.');
});
