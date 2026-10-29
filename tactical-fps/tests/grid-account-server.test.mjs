// GRID account server (server/) against a real PostgreSQL (tests/pg.mjs):
// migrations, sign-up / sign-in / sign-out / expiry / suspension, login rate
// limit, CSRF, account isolation, purchases (server price and balance, one
// transaction, idempotency keys, concurrency, rollback on a database
// failure, negative balance refused by the database), equip rules, refused
// client match results, verified match settlement and missions (paid once),
// persistence across a server restart and a second "browser", database
// outage, logs without secrets, backup and restore, static files.
//
// Without PostgreSQL binaries or GRID_TEST_DATABASE_URL every test here is
// reported as skipped.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import pg from 'pg';
import { ROOT } from './harness.mjs';
import { startPostgres } from './pg.mjs';

const DAY = '2026-10-27';
const PASSWORD = 'correct horse battery';

let vite;
let M;
let PG;
let db;
let srv;
let logs = [];
let staticDir;
let ipSeq = 0;

// Started before the tests are defined: `skip` is decided at definition time.
PG = await startPostgres();
const skip = () => !PG && 'PostgreSQL not available (set GRID_TEST_DATABASE_URL or install PostgreSQL)';

before(async () => {
  if (!PG) return;
  vite = await createServer({ root: ROOT, logLevel: 'error', server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom' });
  const load = (p) => vite.ssrLoadModule(p);
  M = {
    ...(await load('/server/db.ts')),
    ...(await load('/server/migrations.ts')),
    ...(await load('/server/http.ts')),
    ...(await load('/server/economyDb.ts')),
    ...(await load('/server/auth.ts')),
    ...(await load('/server/passwords.ts')),
    ...(await load('/server/config.ts')),
    ...(await load('/src/economy/SkinCatalog.ts')),
    ...(await load('/src/economy/EconomyRules.ts')),
  };
  staticDir = mkdtempSync(join(tmpdir(), 'grid-static-'));
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>GRID</title>');
  mkdirSync(join(staticDir, 'assets'));
  writeFileSync(join(staticDir, 'assets', 'app-abc.js'), 'console.log(1)');
  db = M.createPool({ databaseUrl: PG.url, dbPoolMax: 20 });
  await M.migrate(db);
  srv = await startApp(db);
});

after(async () => {
  await srv?.close();
  await db?.end();
  await vite?.close();
  await PG?.drop();
  if (staticDir) rmSync(staticDir, { recursive: true, force: true });
});

async function startApp(pool, opts = {}) {
  const app = M.createApp({
    db: pool,
    config: { cookieSecure: false, sessionTtlMs: 3600_000, missionTimeZone: 'Asia/Seoul', trustProxy: true, staticDir, ...opts },
    day: () => DAY,
    log: (l) => logs.push(l),
  });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => (server.closeAllConnections(), server.close(r))),
  };
}

/** A browser: its own cookie jar and client address. */
function browser(base = () => srv.url) {
  const ip = `10.0.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;
  let cookie = '';
  const b = {
    ip,
    get cookie() {
      return cookie;
    },
    set cookie(v) {
      cookie = v;
    },
    async req(method, path, body, headers = {}) {
      const res = await fetch(base() + path, {
        method,
        headers: {
          'x-forwarded-for': ip,
          ...(method !== 'GET' ? { 'x-grid-csrf': '1' } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(cookie ? { cookie } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = res.headers.get('set-cookie');
      if (set) {
        const v = set.split(';')[0];
        cookie = v.endsWith('=') ? '' : v;
      }
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {}
      return { status: res.status, body: json, text, setCookie: set };
    },
    signup: (username, password = PASSWORD) => b.req('POST', '/api/auth/signup', { username, password }),
    login: (username, password = PASSWORD) => b.req('POST', '/api/auth/login', { username, password }),
    account: () => b.req('GET', '/api/account'),
    buy: (skinId, key = newKey()) => b.req('POST', '/api/purchase', { skinId }, { 'idempotency-key': key }),
    equip: (category, target, itemId, key = newKey()) => b.req('POST', '/api/equip', { category, target, itemId }, { 'idempotency-key': key }),
    claim: (missionId, key = newKey()) => b.req('POST', `/api/missions/${missionId}/claim`, undefined, { 'idempotency-key': key }),
  };
  return b;
}

let userSeq = 0;
const uname = (p = 'u') => `${p}${Date.now().toString(36).slice(-4)}${++userSeq}`;
const newKey = () => `k-${crypto.randomUUID()}`;

/** A signed-in browser with a fresh account. */
async function player(prefix) {
  const b = browser();
  const name = uname(prefix);
  const r = await b.signup(name);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  b.name = name;
  b.id = r.body.account.accountId;
  return b;
}

const onSale = () => M.SKIN_CATALOG.filter((s) => s.onSale && !s.isDefault);
const cheapest = () => [...onSale()].sort((a, b) => a.price - b.price)[0];

async function ledgerSum(accountId) {
  const r = await db.query('SELECT coalesce(sum(amount), 0)::bigint AS s, count(*)::int AS n FROM credit_ledger WHERE account_id = $1', [accountId]);
  return { sum: Number(r.rows[0].s), n: r.rows[0].n };
}

const verified = (matchId, over = {}) => ({ matchId, mode: 'team', outcome: 'completed', won: true, kills: { ar01: 4, sr01: 3 }, roundWins: 7, durationSeconds: 900, ...over });

// --- schema ----------------------------------------------------------------------

test('migrations apply once, also when two servers start together', { skip: skip() }, async () => {
  const again = await Promise.all([M.migrate(db), M.migrate(db)]);
  assert.deepEqual(again, [[], []]);
  const v = await db.query('SELECT version, name FROM schema_migrations ORDER BY version');
  assert.deepEqual(v.rows, [{ version: 1, name: 'init' }]);
  // A fresh database: two concurrent migrators, exactly one applies.
  const url = await PG.createSibling('mig');
  const p2 = M.createPool({ databaseUrl: url, dbPoolMax: 4 });
  try {
    const both = await Promise.all([M.migrate(p2), M.migrate(p2)]);
    assert.deepEqual(both.flat(), [1]);
  } finally {
    await p2.end();
  }
});

test('the catalog the server sells from is the shared one (32 skins: 8 default looks + 24 on sale, valid)', { skip: skip() }, () => {
  assert.equal(M.SKIN_CATALOG.length, 32);
  assert.equal(M.SKIN_CATALOG.filter((s) => s.isDefault).length, 8);
  assert.equal(onSale().length, 24);
  assert.deepEqual(M.validateCatalog(M.SKIN_CATALOG), []);
});

// --- auth ------------------------------------------------------------------------

test('sign-up: account with 500 starting credits, HttpOnly session cookie, no plaintext secrets stored', { skip: skip() }, async () => {
  const b = browser();
  const name = uname('Signup');
  const r = await b.signup(name);
  assert.equal(r.status, 201);
  assert.equal(r.body.account.username, name.toLowerCase());
  assert.match(r.setCookie, /^grid_session=[A-Za-z0-9_-]{40,};/);
  assert.match(r.setCookie, /HttpOnly/);
  assert.match(r.setCookie, /SameSite=Lax/);
  const token = b.cookie.split('=')[1];
  const a = await b.account();
  assert.equal(a.status, 200);
  assert.equal(a.body.account.credits, M.STARTING_CREDITS);
  assert.deepEqual(a.body.account.ledger.map((t) => [t.kind, t.amount, t.ref]), [['grant', 500, 'starting_credits']]);
  // Stored secrets: scrypt hash only; the session token only as its SHA-256.
  const row = (await db.query('SELECT password_hash FROM accounts WHERE account_id = $1', [r.body.account.accountId])).rows[0];
  assert.match(row.password_hash, /^scrypt\$32768\$8\$1\$/);
  assert.ok(!row.password_hash.includes(PASSWORD));
  const sessions = (await db.query('SELECT token_hash FROM sessions WHERE account_id = $1', [r.body.account.accountId])).rows;
  assert.equal(sessions.length, 1);
  assert.equal(Buffer.compare(sessions[0].token_hash, M.tokenHash(token)), 0);
  const dump = JSON.stringify((await db.query('SELECT * FROM sessions s JOIN audit_log l USING (account_id) WHERE s.account_id = $1', [r.body.account.accountId])).rows);
  assert.ok(!dump.includes(token) && !dump.includes(PASSWORD));
});

test('sign-up validation and unique user names (case-insensitive)', { skip: skip() }, async () => {
  const b = browser();
  assert.equal((await b.signup('ab')).body.error, 'invalid_username');
  assert.equal((await b.signup('bad name!')).body.error, 'invalid_username');
  assert.equal((await b.signup(uname('w'), 'short')).body.error, 'weak_password');
  const name = uname('dup');
  assert.equal((await browser().signup(name)).status, 201);
  const again = await browser().signup(name.toUpperCase());
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'username_taken');
  // Same name at once from two browsers: one account.
  const race = uname('race');
  const both = await Promise.all([browser().signup(race), browser().signup(race)]);
  assert.deepEqual(both.map((r) => r.status).sort(), [201, 409]);
});

test('login, wrong password, unknown user (same answer), logout revokes the session', { skip: skip() }, async () => {
  const p = await player('login');
  const other = browser();
  const wrong = await other.login(p.name, 'not the password');
  const unknown = await other.login(uname('nobody'), 'not the password');
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.body, unknown.body);
  assert.equal(wrong.body.error, 'invalid_credentials');
  const ok = await other.login(p.name.toUpperCase());
  assert.equal(ok.status, 200);
  assert.equal(ok.body.account.accountId, p.id);
  const me = await other.req('GET', '/api/auth/me');
  assert.equal(me.body.account.username, p.name);
  const saved = other.cookie;
  assert.equal((await other.req('POST', '/api/auth/logout')).status, 200);
  assert.equal(other.cookie, '');
  assert.deepEqual((await other.req('GET', '/api/auth/me')).body, { ok: true, account: null }, 'signed out: no account, not an error');
  other.cookie = saved; // a stolen copy of the old cookie no longer works
  assert.equal((await other.account()).status, 401);
  assert.deepEqual((await other.req('GET', '/api/auth/me')).body, { ok: true, account: null });
  // The first browser's own session is unaffected.
  assert.equal((await p.account()).status, 200);
});

test('login rate limit: 5 failures for a user name block it (even the right password) for 15 minutes', { skip: skip() }, async () => {
  const p = await player('limit');
  const attacker = browser();
  for (let i = 0; i < 5; i++) assert.equal((await attacker.login(p.name, `guess-${i}-xxxxxx`)).status, 401);
  const blocked = await attacker.login(p.name);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error, 'rate_limited');
  assert.equal((await browser().login(p.name)).status, 429, 'per user name, from any address');
  // Window passed: allowed again.
  await db.query(`UPDATE login_attempts SET at = at - interval '16 minutes' WHERE username_lower = $1`, [p.name]);
  assert.equal((await browser().login(p.name)).status, 200);
});

test('sign-up rate limit per client address', { skip: skip() }, async () => {
  const b = browser();
  const codes = [];
  for (let i = 0; i < 11; i++) codes.push((await b.signup(uname('flood'))).status);
  assert.deepEqual(codes, [...Array(10).fill(201), 429]);
});

test('expired and suspended sessions are refused', { skip: skip() }, async () => {
  const p = await player('exp');
  await db.query(`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE account_id = $1`, [p.id]);
  const r = await p.account();
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'unauthenticated');
  assert.equal((await p.login(p.name)).status, 200);
  await db.query(`UPDATE accounts SET status = 'suspended' WHERE account_id = $1`, [p.id]);
  assert.equal((await p.account()).status, 403);
  assert.equal((await p.buy(cheapest().skinId)).body.error, 'suspended');
  const login = await browser().login(p.name);
  assert.equal(login.status, 403);
  assert.equal(login.body.error, 'suspended');
});

test('CSRF: changing requests need the GRID header and a same-host Origin', { skip: skip() }, async () => {
  const p = await player('csrf');
  const noHeader = await p.req('POST', '/api/purchase', { skinId: cheapest().skinId }, { 'x-grid-csrf': '', 'idempotency-key': newKey() });
  assert.equal(noHeader.status, 403);
  const foreign = await p.req('POST', '/api/purchase', { skinId: cheapest().skinId }, { origin: 'https://evil.example', 'idempotency-key': newKey() });
  assert.equal(foreign.status, 403);
  const same = await p.req('POST', '/api/purchase', { skinId: cheapest().skinId }, { origin: srv.url, 'idempotency-key': newKey() });
  assert.equal(same.status, 200);
  assert.equal((await p.account()).body.account.items.length, 1);
});

test('isolation: the account is the session’s; ids in the request body are ignored', { skip: skip() }, async () => {
  const a = await player('isoa');
  const b = await player('isob');
  const skin = cheapest();
  const bought = await b.buy(skin.skinId);
  const bItem = bought.body.value.itemId;
  // A names B everywhere it can: nothing of B is read or changed.
  const view = await a.req('GET', `/api/account?accountId=${b.id}`);
  assert.equal(view.body.account.accountId, a.id);
  assert.equal(view.body.account.items.length, 0);
  const sneaky = await a.req('POST', '/api/purchase', { skinId: onSale()[1].skinId, accountId: b.id }, { 'idempotency-key': newKey() });
  assert.equal(sneaky.body.account.accountId, a.id);
  const eq = await a.equip(skin.category, skin.targets[0], bItem);
  assert.equal(eq.body.error, 'not_owned');
  const bNow = (await b.account()).body.account;
  assert.equal(bNow.credits, M.STARTING_CREDITS - skin.price);
  assert.equal(bNow.items.length, 1);
  assert.deepEqual(bNow.loadout, {});
  // Same idempotency key in two accounts: independent requests.
  const c = await player('isoc');
  const d = await player('isod');
  const key = newKey();
  const r1 = await c.buy(cheapest().skinId, key);
  const r2 = await d.buy(cheapest().skinId, key);
  assert.deepEqual([r1.status, r2.status], [200, 200], 'both buy: D is not given C’s replay');
  assert.notEqual(r1.body.value.itemId, r2.body.value.itemId);
  assert.equal(r1.body.account.accountId, c.id);
  assert.equal(r2.body.account.accountId, d.id);
});

// --- purchases -------------------------------------------------------------------

test('purchase: server price and balance, ledger and item in one change; refusals change nothing', { skip: skip() }, async () => {
  const p = await player('buy');
  const skin = cheapest();
  const r = await p.req('POST', '/api/purchase', { skinId: skin.skinId, price: 0, credits: 999999 }, { 'idempotency-key': newKey() });
  assert.equal(r.status, 200);
  const acc = r.body.account;
  assert.equal(acc.credits, M.STARTING_CREDITS - skin.price);
  assert.equal(r.body.value.skinId, skin.skinId);
  assert.deepEqual(acc.items.map((i) => i.skinId), [skin.skinId]);
  const last = acc.ledger.at(-1);
  assert.deepEqual([last.kind, last.amount, last.balanceAfter, last.ref], ['purchase', -skin.price, acc.credits, skin.skinId]);
  const refusals = {
    owned: skin.skinId,
    unknown_item: 'no.such.skin',
    not_for_sale: 'ar01.default',
    insufficient_funds: [...onSale()].sort((a, b) => b.price - a.price)[0].skinId,
  };
  for (const [error, skinId] of Object.entries(refusals)) {
    const x = await p.buy(skinId);
    assert.equal(x.body.ok, false);
    assert.equal(x.body.error, error, skinId);
    assert.equal(x.body.account.credits, acc.credits);
  }
  const s = await ledgerSum(p.id);
  assert.equal(s.sum, acc.credits);
  assert.equal(s.n, 2);
});

test('idempotency: a resent purchase returns the first answer, charges once; a key reused for another request is refused', { skip: skip() }, async () => {
  const p = await player('idem');
  const skin = cheapest();
  const key = newKey();
  const first = await p.buy(skin.skinId, key);
  const again = await p.buy(skin.skinId, key);
  assert.equal(again.status, 200);
  assert.deepEqual(again.body.value, first.body.value);
  assert.equal(again.body.account.credits, first.body.account.credits);
  const other = await p.buy(onSale()[3].skinId, key);
  assert.equal(other.status, 409);
  assert.equal(other.body.error, 'conflict');
  // Five copies of one request at once: one charge, one item, the same answer for all.
  const p2 = await player('idem2');
  const k2 = newKey();
  const all = await Promise.all(Array.from({ length: 5 }, () => p2.buy(skin.skinId, k2)));
  assert.ok(all.every((r) => r.status === 200 && r.body.value.itemId === all[0].body.value.itemId));
  const acc = (await p2.account()).body.account;
  assert.equal(acc.items.length, 1);
  assert.equal(acc.credits, M.STARTING_CREDITS - skin.price);
  assert.equal((await ledgerSum(p2.id)).n, 2);
  // A refusal is replayed too (the same key never runs twice).
  const k3 = newKey();
  assert.equal((await p2.buy('no.such.skin', k3)).body.error, 'unknown_item');
  assert.equal((await p2.buy('no.such.skin', k3)).body.error, 'unknown_item');
  // Missing / malformed keys are refused.
  assert.equal((await p2.req('POST', '/api/purchase', { skinId: skin.skinId })).body.error, 'invalid_request');
  assert.equal((await p2.buy(skin.skinId, 'short')).body.error, 'invalid_request');
});

test('concurrent purchases (different keys): never below zero, ledger = balance, each item once', { skip: skip() }, async () => {
  const p = await player('conc');
  const skins = onSale().filter((s) => s.price <= M.STARTING_CREDITS);
  // Every affordable skin at once, each twice: only what 500 CR covers succeeds, never the same skin twice.
  const results = await Promise.all([...skins, ...skins].map((s) => p.buy(s.skinId)));
  const acc = (await p.account()).body.account;
  assert.ok(acc.credits >= 0);
  const okSkins = results.filter((r) => r.status === 200).map((r) => r.body.value.skinId);
  assert.equal(new Set(okSkins).size, okSkins.length, 'no skin bought twice');
  assert.deepEqual(acc.items.map((i) => i.skinId).sort(), [...okSkins].sort());
  const spent = okSkins.reduce((s, id) => s + M.findSkin(id).price, 0);
  assert.equal(acc.credits, M.STARTING_CREDITS - spent);
  const ledger = await ledgerSum(p.id);
  assert.equal(ledger.sum, acc.credits);
  assert.equal(ledger.n, 1 + okSkins.length);
  for (const r of results.filter((r) => r.status !== 200)) assert.ok(['owned', 'insufficient_funds'].includes(r.body.error), r.body.error);
});

test('rollback: a database failure mid-purchase changes nothing (no charge, no ledger, no key); a retry then works once', { skip: skip() }, async () => {
  const p = await player('rb');
  const skin = cheapest();
  await db.query(`CREATE OR REPLACE FUNCTION grid_test_fail() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$ LANGUAGE plpgsql`);
  await db.query(`CREATE TRIGGER grid_test_fail BEFORE INSERT ON inventory_items FOR EACH ROW EXECUTE FUNCTION grid_test_fail()`);
  const key = newKey();
  let failed;
  try {
    failed = await p.buy(skin.skinId, key);
  } finally {
    await db.query('DROP TRIGGER grid_test_fail ON inventory_items');
  }
  assert.equal(failed.status, 503);
  assert.equal(failed.body.error, 'storage_error');
  const acc = (await p.account()).body.account;
  assert.equal(acc.credits, M.STARTING_CREDITS, 'the charge before the failure was rolled back');
  assert.equal(acc.items.length, 0);
  assert.equal((await ledgerSum(p.id)).n, 1);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM idempotency_keys WHERE account_id = $1', [p.id])).rows[0].n, 0);
  assert.ok(logs.some((l) => l.includes('injected failure')), 'the failure is logged');
  // Same key again (the client's retry): now it goes through, once.
  const retry = await p.buy(skin.skinId, key);
  assert.equal(retry.status, 200);
  assert.equal((await p.buy(skin.skinId, key)).body.value.itemId, retry.body.value.itemId);
  assert.equal((await p.account()).body.account.credits, M.STARTING_CREDITS - skin.price);
});

test('the database itself refuses a negative balance and a second payout of the same reward', { skip: skip() }, async () => {
  const p = await player('chk');
  await assert.rejects(db.query('UPDATE accounts SET credits = -1 WHERE account_id = $1', [p.id]), (e) => e.code === '23514');
  await assert.rejects(
    db.query(`INSERT INTO credit_ledger (tx_id, account_id, kind, amount, balance_after, ref) VALUES (gen_random_uuid(), $1, 'grant', 500, 1000, 'starting_credits')`, [p.id]),
    (e) => e.code === '23505',
  );
  await assert.rejects(db.query(`INSERT INTO inventory_items (item_id, account_id, skin_id, source) VALUES (gen_random_uuid(), $1, $2, 'grant'), (gen_random_uuid(), $1, $2, 'grant')`, [p.id, cheapest().skinId]), (e) => e.code === '23505');
  // The loadout can only point at the account's own items.
  const b = await player('chk2');
  const bought = await b.buy(cheapest().skinId);
  await assert.rejects(db.query(`INSERT INTO loadout (account_id, slot, item_id) VALUES ($1, 'weapon:ar01', $2)`, [p.id, bought.body.value.itemId]), (e) => e.code === '23503');
});

// --- equip -----------------------------------------------------------------------

test('equip: owned and fitting only; reset to default; saved', { skip: skip() }, async () => {
  const p = await player('eq');
  const skin = onSale().find((s) => s.category === 'weapon' && s.price <= 500);
  const item = (await p.buy(skin.skinId)).body.value.itemId;
  const other = skin.targets[0] === 'ar01' ? 'sr01' : 'ar01';
  assert.equal((await p.equip('weapon', other, item)).body.error, 'incompatible');
  assert.equal((await p.equip('knife', 'karambit', item)).body.error, 'incompatible');
  assert.equal((await p.equip('weapon', 'nope', item)).body.error, 'invalid_request');
  assert.equal((await p.equip('hat', skin.targets[0], item)).body.error, 'invalid_request');
  assert.equal((await p.equip('weapon', skin.targets[0], crypto.randomUUID())).body.error, 'not_owned');
  const ok = await p.equip('weapon', skin.targets[0], item);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.account.loadout[`weapon:${skin.targets[0]}`], item);
  assert.equal((await p.account()).body.account.loadout[`weapon:${skin.targets[0]}`], item);
  const reset = await p.equip('weapon', skin.targets[0], null);
  assert.deepEqual(reset.body.account.loadout, {});
});

// --- rewards and missions ------------------------------------------------------------

test('client match reports never pay: 403 unverified, balance unchanged', { skip: skip() }, async () => {
  const p = await player('mr');
  const r = await p.req('POST', '/api/match-results', { result: verified('client-claimed-win-1') });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'unverified');
  const acc = (await p.account()).body.account;
  assert.equal(acc.credits, M.STARTING_CREDITS);
  assert.equal(acc.missions.missions['daily.match'].progress, 0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM match_rewards WHERE account_id = $1', [p.id])).rows[0].n, 0);
});

test('verified match settlement (server-only path): paid once, unpaid endings, mission progress, claims paid once', { skip: skip() }, async () => {
  const p = await player('vm');
  const r1 = await M.settleVerifiedMatch(db, p.id, verified('team-verified-0001'), DAY);
  assert.deepEqual(r1, { ok: true, credits: 100 + 150 + 70, duplicate: false });
  const dup = await Promise.all([1, 2, 3].map(() => M.settleVerifiedMatch(db, p.id, verified('team-verified-0001'), DAY)));
  assert.ok(dup.every((d) => d.ok && d.credits === 0 && d.duplicate));
  for (const [id, over] of [
    ['train-0001', { mode: 'training' }],
    ['forf-0001', { outcome: 'forfeit' }],
    ['aband-0001', { outcome: 'abandoned' }],
    ['short-0001', { durationSeconds: 59 }],
  ])
    assert.equal((await M.settleVerifiedMatch(db, p.id, verified(id, over), DAY)).credits, 0, id);
  assert.equal((await M.settleVerifiedMatch(db, p.id, verified('bad-0001', { kills: { ar01: -1 } }), DAY)).error, 'invalid_request');
  let acc = (await p.account()).body.account;
  assert.equal(acc.credits, 500 + 320);
  const ms = acc.missions.missions;
  assert.deepEqual(
    Object.fromEntries(Object.entries(ms).map(([k, v]) => [k, [v.progress, v.completed]])),
    // the short match (59 s) still counts for missions, as offline: only training / forfeit / abandoned don't.
    { 'daily.match': [1, true], 'daily.kills': [10, true], 'daily.rounds': [3, true], 'daily.sr01': [3, true] },
  );
  // Claims: once each, also when sent concurrently with different keys.
  assert.equal((await p.claim('daily.unknown')).body.error, 'unknown_item');
  const claims = await Promise.all([1, 2, 3, 4].map(() => p.claim('daily.kills')));
  assert.equal(claims.filter((c) => c.status === 200).length, 1);
  assert.ok(claims.filter((c) => c.status !== 200).every((c) => c.body.error === 'already_claimed'));
  acc = (await p.account()).body.account;
  assert.equal(acc.credits, 500 + 320 + 150);
  assert.equal(acc.missions.missions['daily.kills'].claimed, true);
  // Another day: missions start over and nothing carries.
  const q = await player('vm2');
  assert.equal((await q.claim('daily.match')).body.error, 'not_completed');
  const sum = await ledgerSum(p.id);
  assert.equal(sum.sum, acc.credits);
});

// --- persistence, outage, logs ------------------------------------------------------

test('persistence: after a server restart (new pool) and in a second browser the account is the same', { skip: skip() }, async () => {
  const p = await player('persist');
  const skin = cheapest();
  const item = (await p.buy(skin.skinId)).body.value.itemId;
  await p.equip(skin.category, skin.targets[0], item);
  const before = (await p.account()).body.account;
  await srv.close();
  await db.end();
  db = M.createPool({ databaseUrl: PG.url, dbPoolMax: 20 });
  assert.deepEqual(await M.migrate(db), []);
  srv = await startApp(db);
  // The old session survives the restart (it lives in the database).
  const same = (await p.account()).body.account;
  assert.deepEqual(same, before);
  // Another browser, fresh login: identical account.
  const second = browser();
  assert.equal((await second.login(p.name)).status, 200);
  assert.deepEqual((await second.account()).body.account, before);
});

test('database down: health 503, requests answer storage_error, nothing half-done; recovers when it is back', { skip: skip() }, async () => {
  const p = await player('down');
  const dead = M.createPool({ databaseUrl: 'postgres://postgres@127.0.0.1:1/none', dbPoolMax: 2 });
  const s = await startApp(dead);
  try {
    const h = await fetch(s.url + '/api/health');
    assert.equal(h.status, 503);
    assert.deepEqual(await h.json(), { service: 'grid-account', db: 'down' });
    const q = browser(() => s.url);
    q.cookie = p.cookie;
    const r = await q.buy(cheapest().skinId);
    assert.equal(r.status, 503);
    assert.equal(r.body.error, 'storage_error');
  } finally {
    await s.close();
    await dead.end();
  }
  const h = await fetch(srv.url + '/api/health');
  assert.deepEqual([h.status, await h.json()], [200, { service: 'grid-account', db: 'up' }]);
  assert.equal((await p.account()).body.account.credits, M.STARTING_CREDITS);
});

test('logs: method, path, status only — no passwords, tokens, cookies or database URL', { skip: skip() }, async () => {
  logs = [];
  const p = await player('logs');
  await p.login(p.name);
  await p.buy(cheapest().skinId);
  await browser().login(p.name, 'wrong password here');
  assert.ok(logs.some((l) => /^POST \/api\/auth\/login 200 \d+ms$/.test(l)));
  const all = logs.join('\n');
  for (const secret of [PASSWORD, 'wrong password here', p.cookie.split('=')[1], PG.url]) assert.ok(!all.includes(secret), 'leaked into logs');
  assert.ok(!/grid_session|cookie/i.test(all));
  assert.equal(M.describeDbError(new Error(`connect failed for ${PG.url}`)).includes(PG.url), false);
});

test('backup and restore: pg_dump / pg_restore give back the same accounts', { skip: skip() || (!PG?.bin && 'no pg_dump') }, async () => {
  const p = await player('backup');
  await p.buy(cheapest().skinId);
  const before = (await p.account()).body.account;
  const dir = mkdtempSync(join(tmpdir(), 'grid-dump-'));
  const file = join(dir, 'grid.dump');
  try {
    execFileSync(join(PG.bin, 'pg_dump'), ['-Fc', '-f', file, '-d', PG.url]);
    const target = await PG.createSibling('restore');
    execFileSync(join(PG.bin, 'pg_restore'), ['--no-owner', '-d', target, file]);
    const restored = M.createPool({ databaseUrl: target, dbPoolMax: 2 });
    try {
      assert.deepEqual(await M.migrate(restored), [], 'restored schema is current');
      const acc = await M.loadAccount(restored, p.id, DAY);
      assert.deepEqual(acc, before);
      // Sessions and passwords come back too: the player signs in on the restored server.
      const s = await startApp(restored);
      try {
        const b = browser(() => s.url);
        assert.equal((await b.login(p.name)).status, 200);
        assert.equal((await b.account()).body.account.credits, before.credits);
      } finally {
        await s.close();
      }
    } finally {
      await restored.end();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- HTTP surface ---------------------------------------------------------------------

test('static files and API errors: game page, hashed assets cached, no path traversal, JSON 404 / 400 / 413', { skip: skip() }, async () => {
  const page = await fetch(srv.url + '/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>GRID<\/title>/);
  const asset = await fetch(srv.url + '/assets/app-abc.js');
  assert.match(asset.headers.get('cache-control'), /immutable/);
  assert.equal((await fetch(srv.url + '/assets/missing.js')).status, 404);
  // Encoded ../ must not leave the static folder (the project's package.json sits two levels up).
  for (const p of ['/..%2fpackage.json', '/..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/package.json', '/..%5c..%5cpackage.json']) {
    const r = await fetch(srv.url + p);
    assert.ok(!(await r.text()).includes('"devDependencies"'), p);
  }
  const b = await player('http');
  assert.equal((await b.req('GET', '/api/nope')).status, 404);
  const bad = await fetch(srv.url + '/api/purchase', { method: 'POST', headers: { 'x-grid-csrf': '1', 'content-type': 'application/json', cookie: b.cookie, 'idempotency-key': newKey() }, body: '{not json' });
  assert.equal(bad.status, 400);
  const big = await fetch(srv.url + '/api/purchase', { method: 'POST', headers: { 'x-grid-csrf': '1', 'content-type': 'application/json', cookie: b.cookie, 'idempotency-key': newKey() }, body: JSON.stringify({ skinId: 'x'.repeat(20000) }) });
  assert.equal(big.status, 413);
  assert.equal((await fetch(srv.url + '/api/account')).status, 401);
});
