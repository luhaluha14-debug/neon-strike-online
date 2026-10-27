// GRID account in the real game page against the real account server and
// PostgreSQL (Vite dev server → /api proxy → server/http.ts → tests/pg.mjs):
// sign-up from the shop page, the offline record not moved over (notice),
// purchase and equip saved on the server, the same account after a reload
// and in a second browser, client match results not paid, sign-out back to
// the offline record, a database outage (offline record, the game still
// playable) and reconnecting.
//
// Without PostgreSQL every test here is reported as skipped.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from 'vite';
import { startEnv, openGame, waitReady, installFrameDriver, ROOT } from './harness.mjs';
import { startPostgres } from './pg.mjs';

const PASSWORD = 'grid-e2e-password';
const PG = await startPostgres();
const skip = () => !PG && 'PostgreSQL not available (set GRID_TEST_DATABASE_URL or install PostgreSQL)';

let vite;
let M;
let db;
let deadDb;
let api;
let liveApp;
let deadApp;
let handler;
let env;
let page;
let username;

before(async () => {
  if (!PG) return;
  vite = await createServer({ root: ROOT, logLevel: 'error', server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom' });
  M = { ...(await vite.ssrLoadModule('/server/db.ts')), ...(await vite.ssrLoadModule('/server/migrations.ts')), ...(await vite.ssrLoadModule('/server/http.ts')) };
  db = M.createPool({ databaseUrl: PG.url, dbPoolMax: 10 });
  await M.migrate(db);
  deadDb = M.createPool({ databaseUrl: 'postgres://postgres@127.0.0.1:1/none', dbPoolMax: 1 });
  const config = { cookieSecure: false, sessionTtlMs: 3600_000, missionTimeZone: 'Asia/Seoul', trustProxy: false, staticDir: null };
  liveApp = M.createApp({ db, config, log: () => {} });
  deadApp = M.createApp({ db: deadDb, config, log: () => {} });
  handler = liveApp;
  api = http.createServer((req, res) => handler(req, res));
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  // The game's dev server forwards /api to it (vite.config.ts).
  process.env.GRID_API_PROXY = `http://127.0.0.1:${api.address().port}`;
  env = await startEnv();
  username = `e2e${Date.now().toString(36)}`;
});

after(async () => {
  await page?.context().close();
  await env?.close();
  delete process.env.GRID_API_PROXY;
  await new Promise((r) => (api ? (api.closeAllConnections(), api.close(r)) : r()));
  await db?.end();
  await deadDb?.end();
  await vite?.close();
  await PG?.drop();
});

const mode = (p) => p.evaluate(() => window.game.accountSession.mode.kind);
const balance = (p) => p.evaluate(() => document.querySelector('#page-shop .grid-balance').textContent);
const offlineRecord = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('grid.account.v1')));

async function serverAccount() {
  const r = await db.query('SELECT a.account_id, a.credits, (SELECT count(*)::int FROM inventory_items i WHERE i.account_id = a.account_id) AS items FROM accounts a WHERE username_lower = $1', [username]);
  return r.rows[0];
}

async function buyInShop(p, skinId) {
  await p.click('#tab-shop');
  await p.click(`#shop-cat-${skinId.startsWith('gloves.') ? 'gloves' : 'weapon'}`);
  await p.click(`.shop-cards [data-skin="${skinId}"]`);
  await p.click('.gd-primary');
  await p.click('.gd-confirm');
  await p.waitForSelector('.grid-dialog.step-done');
  await p.waitForTimeout(400); // result buttons ignore clicks for 350 ms (double-click guard)
  await p.click('.grid-dialog .gd-close');
}

test('sign-up from the shop page: the offline record is not moved over (explicit notice), the server account starts at 500 CR', { skip: skip() }, async () => {
  page = await openGame(env, { mode: 'training', width: 1280, height: 800 });
  page.setDefaultTimeout(60000);
  await page.waitForFunction(() => window.game.accountSession.mode.kind === 'signed_out');
  // Offline (signed out): buy something on this browser's own record first.
  await buyInShop(page, 'gloves.coyote');
  const offline = await offlineRecord(page);
  assert.equal(offline.items.length, 1);
  await page.click('#tab-shop');
  assert.match(await page.textContent('#page-shop .grid-account'), /오프라인 기록/);
  await page.click('#page-shop .grid-account [data-account="signup"]');
  await page.fill('.grid-auth input[name="username"]', username);
  await page.fill('.grid-auth input[name="password"]', 'short');
  await page.click('.grid-auth .ga-submit');
  await page.waitForFunction(() => document.querySelector('.grid-auth .ga-error')?.textContent.includes('비밀번호'));
  await page.fill('.grid-auth input[name="password"]', PASSWORD);
  await page.click('.grid-auth .ga-submit');
  await page.waitForSelector('.grid-auth .ga-notice');
  const notice = await page.textContent('.grid-auth .ga-notice');
  assert.match(notice, new RegExp(`크레딧 ${offline.credits.toLocaleString('en-US')} CR, 스킨 1개`));
  await page.click('.grid-auth .ga-ack');
  assert.equal(await mode(page), 'signed_in');
  assert.match(await page.textContent('#page-shop .grid-account'), new RegExp(`계정 ${username}`));
  assert.equal(await balance(page), '500 CR');
  const s = await serverAccount();
  assert.deepEqual([Number(s.credits), s.items], [500, 0], 'nothing of the offline record reached the server');
  assert.deepEqual(await offlineRecord(page), offline, 'the offline record itself is untouched');
  // The password is not kept anywhere in the page.
  const html = await page.content();
  assert.ok(!html.includes(PASSWORD));
});

test('signed in: purchase and equip go to the server; after a reload the same account, loadout and look', { skip: skip() }, async () => {
  await buyInShop(page, 'ar01.fde');
  assert.equal(await balance(page), '100 CR', '500 − 400 (server price of FDE 세라코트)');
  await page.click('#tab-inventory');
  await page.click('#inv-cat-weapon');
  await page.click('.inv-card[data-skin="ar01.fde"] .gc-equip');
  await page.waitForFunction(() => document.querySelector('.inv-card[data-skin="ar01.fde"]')?.classList.contains('equipped'));
  const s = await serverAccount();
  const after = await page.evaluate(() => window.game.economy.getAccount());
  assert.equal(Number(s.credits), after.credits);
  assert.equal(s.items, 1);
  assert.deepEqual(Object.keys(after.loadout), ['weapon:ar01']);
  const offlineBefore = await offlineRecord(page);
  await page.reload();
  await waitReady(page);
  await page.waitForFunction(() => window.game.accountSession.mode.kind === 'signed_in' && window.game.account?.items.length === 1);
  const again = await page.evaluate(() => window.game.account);
  assert.equal(again.credits, after.credits);
  assert.deepEqual(again.loadout, after.loadout);
  assert.equal(await page.evaluate(() => window.game.weaponSkinAsset({ id: 'ar01', category: 'rifle' })), 'finish:ar01.fde', 'the AR-01 wears the FDE finish again');
  assert.deepEqual(await offlineRecord(page), offlineBefore);
});

test('a second browser: sign in, the same server account (no notice for a fresh offline record)', { skip: skip() }, async () => {
  const other = await openGame(env, { mode: 'training', width: 1280, height: 800 });
  other.setDefaultTimeout(60000);
  try {
    await other.waitForFunction(() => window.game.accountSession.mode.kind === 'signed_out');
    await other.click('#tab-shop');
    await other.click('#page-shop .grid-account [data-account="login"]');
    await other.fill('.grid-auth input[name="username"]', username);
    await other.fill('.grid-auth input[name="password"]', 'wrong-password-123');
    await other.click('.grid-auth .ga-submit');
    await other.waitForFunction(() => document.querySelector('.grid-auth .ga-error')?.textContent === '아이디 또는 비밀번호가 맞지 않습니다.');
    await other.fill('.grid-auth input[name="password"]', PASSWORD);
    await other.click('.grid-auth .ga-submit');
    await other.waitForFunction(() => window.game.accountSession.mode.kind === 'signed_in' && document.querySelector('.grid-auth').hidden);
    const a = await other.evaluate(() => window.game.economy.getAccount());
    const b = await page.evaluate(() => window.game.economy.getAccount());
    assert.deepEqual(a, b);
    await other.click('#tab-shop');
    assert.equal(await balance(other), await balance(page));
  } finally {
    await other.context().close();
  }
});

test('signed in: a completed deathmatch is not paid from the client report (unverified), the game itself runs as before', { skip: skip() }, async () => {
  const before = await serverAccount();
  await page.click('#tab-play');
  await page.selectOption('select[data-setting="mode"]', 'deathmatch');
  await page.click('.play-button');
  await page.waitForFunction(() => window.game.input.active);
  await installFrameDriver(page);
  const reward = await page.evaluate(async () => {
    const g = window.game;
    window.T.stopLoop();
    window.T.run(2);
    g.match.elapsed = 75;
    g.match.timeLeft = 0.01;
    window.T.run(2);
    for (let i = 0; i < 100 && !document.querySelector('.match-hud .results-reward')?.textContent; i++) await new Promise((r) => setTimeout(r, 50));
    return { text: document.querySelector('.match-hud .results-reward').textContent, over: g.match.over };
  });
  assert.equal(reward.over, true);
  assert.equal(reward.text, 'GRID 크레딧: 서버가 확인하지 않은 경기 결과는 반영되지 않습니다.');
  const after = await serverAccount();
  assert.equal(Number(after.credits), Number(before.credits));
  assert.equal((await db.query('SELECT count(*)::int AS n FROM match_rewards')).rows[0].n, 0);
  await page.evaluate(() => document.exitPointerLock());
  await page.click('.match-hud .results-menu');
});

test('database outage: the page falls back to the offline record and stays playable; reconnecting restores the account', { skip: skip() }, async () => {
  const offline = await offlineRecord(page);
  handler = deadApp;
  await page.reload();
  await waitReady(page);
  await page.waitForFunction(() => window.game.accountSession.mode.kind === 'offline');
  assert.equal(await page.evaluate(() => window.game.accountSession.mode.reason), 'server_down');
  await page.click('#tab-shop');
  assert.match(await page.textContent('#page-shop .grid-account'), /계정 서버에 연결할 수 없음/);
  assert.equal(await page.evaluate(() => window.game.account.credits), offline.credits, 'the offline record, never presented as the account');
  // Training still starts.
  await page.click('#tab-play');
  await page.selectOption('select[data-setting="mode"]', 'training');
  await page.click('.play-button');
  await page.waitForFunction(() => window.game.input.active);
  await page.evaluate(() => document.exitPointerLock());
  await page.waitForFunction(() => !window.game.input.active);
  // Back up: "다시 연결" signs in with the still-valid session.
  handler = liveApp;
  await page.evaluate(() => window.game.hud.menu.showPage('shop'));
  await page.click('#page-shop .grid-account [data-account="retry"]');
  await page.waitForFunction(() => window.game.accountSession.mode.kind === 'signed_in');
  assert.equal(await page.evaluate(() => window.game.account.credits), Number((await serverAccount()).credits));
});

test('sign-out: back to the offline record of this browser, unchanged', { skip: skip() }, async () => {
  const offline = await offlineRecord(page);
  await page.click('#page-shop .grid-account [data-account="logout"]');
  await page.waitForFunction(() => window.game.accountSession.mode.kind === 'signed_out');
  assert.equal(await page.evaluate(() => window.game.account.credits), offline.credits);
  assert.equal(await balance(page), `${offline.credits.toLocaleString('en-US')} CR`);
  await page.reload();
  await waitReady(page);
  await page.waitForFunction(() => window.game.accountSession.mode.kind === 'signed_out');
  // The browser can no longer act on the server account.
  const r = await page.evaluate(() => fetch('/api/account', { credentials: 'same-origin' }).then((res) => res.status));
  assert.equal(r, 401);
});
