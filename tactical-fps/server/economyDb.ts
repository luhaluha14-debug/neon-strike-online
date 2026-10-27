import { createHash, randomUUID } from 'node:crypto';
import { DAILY_MISSIONS } from '../src/economy/EconomyRules';
import { LoadoutService } from '../src/economy/LoadoutService';
import { missionIncrement } from '../src/economy/MissionService';
import { matchReward, validMatchResult } from '../src/economy/RewardService';
import { ShopService } from '../src/economy/ShopService';
import { findSkin, slotKey } from '../src/economy/SkinCatalog';
import { SKIN_CATEGORIES, type AccountState, type EconomyError, type MatchResult, type MissionProgress, type OwnedItem, type SkinCategory, type Transaction } from '../src/economy/types';
import { audit } from './auth';
import { withTx, type Db, type Tx } from './db';

// The account economy on PostgreSQL. The rules are the shared ones of
// src/economy (catalog, prices, slot rules, rewards, missions); this file
// only turns their decisions into SQL, each request in one transaction
// with the account row locked (FOR UPDATE), so concurrent requests of one
// account run one after another and a failure changes nothing.

/** Ledger entries returned with the account. */
const LEDGER_VIEW = 50;

export type EconomyAnswer<T = unknown> = { status: number; body: { ok: true; account: AccountState; value: T } | { ok: false; error: EconomyError; account?: AccountState } };

const STATUS: Partial<Record<EconomyError, number>> = {
  unauthenticated: 401,
  unverified: 403,
  invalid_request: 400,
  unknown_item: 404,
  conflict: 409,
  storage_error: 503,
};

/** The account as the client shows it (the shared AccountState shape). */
export async function loadAccount(db: Db | Tx, accountId: string, day: string): Promise<AccountState | null> {
  const acc = await db.query<{ credits: string; revision: string }>('SELECT credits, revision FROM accounts WHERE account_id = $1', [accountId]);
  if (!acc.rows[0]) return null;
  // One after another: inside a transaction they share one connection.
  const items = await db.query<{ item_id: string; skin_id: string; acquired_at: Date; source: OwnedItem['source'] }>(
    'SELECT item_id, skin_id, acquired_at, source FROM inventory_items WHERE account_id = $1 ORDER BY acquired_at, item_id',
    [accountId],
  );
  const loadout = await db.query<{ slot: string; item_id: string }>('SELECT slot, item_id FROM loadout WHERE account_id = $1', [accountId]);
  const ledger = await db.query<{ tx_id: string; at: Date; kind: Transaction['kind']; amount: string; balance_after: string; ref: string; request_key: string | null }>(
    'SELECT tx_id, at, kind, amount, balance_after, ref, request_key FROM credit_ledger WHERE account_id = $1 ORDER BY seq DESC LIMIT $2',
    [accountId, LEDGER_VIEW],
  );
  const missions = await db.query<{ mission_id: string; progress: number; completed: boolean; claimed: boolean }>(
    'SELECT mission_id, progress, completed, claimed FROM missions WHERE account_id = $1 AND day = $2',
    [accountId, day],
  );
  const progress: Record<string, MissionProgress> = {};
  for (const m of DAILY_MISSIONS) progress[m.missionId] = { progress: 0, completed: false, claimed: false };
  for (const r of missions.rows) if (progress[r.mission_id]) progress[r.mission_id] = { progress: r.progress, completed: r.completed, claimed: r.claimed };
  return {
    schema: 1,
    accountId,
    revision: Number(acc.rows[0].revision),
    credits: Number(acc.rows[0].credits),
    items: items.rows.map((r) => ({ itemId: r.item_id, skinId: r.skin_id, acquiredAt: r.acquired_at.toISOString(), source: r.source })),
    loadout: Object.fromEntries(loadout.rows.map((r) => [r.slot, r.item_id])),
    ledger: ledger.rows.reverse().map((r) => ({
      txId: r.tx_id,
      at: r.at.toISOString(),
      kind: r.kind,
      amount: Number(r.amount),
      balanceAfter: Number(r.balance_after),
      ref: r.ref,
      ...(r.request_key ? { requestId: r.request_key } : {}),
    })),
    missions: { day, missions: progress, seenEvents: [] },
    settledMatches: [],
    requests: {},
    seq: 0,
  };
}

/** Locks the account row for the rest of the transaction; null = no such account. */
async function lockAccount(tx: Tx, accountId: string): Promise<{ credits: number; status: string } | null> {
  const r = await tx.query<{ credits: string; status: string }>('SELECT credits, status FROM accounts WHERE account_id = $1 FOR UPDATE', [accountId]);
  return r.rows[0] ? { credits: Number(r.rows[0].credits), status: r.rows[0].status } : null;
}

/** Changes the balance and appends the ledger entry (the DB refuses a negative balance). */
async function moveCredits(tx: Tx, accountId: string, amount: number, kind: Transaction['kind'], ref: string, scope = '', requestKey: string | null = null): Promise<number> {
  const r = await tx.query<{ credits: string }>(
    'UPDATE accounts SET credits = credits + $2, revision = revision + 1, updated_at = now() WHERE account_id = $1 RETURNING credits',
    [accountId, amount],
  );
  const balance = Number(r.rows[0].credits);
  await tx.query('INSERT INTO credit_ledger (tx_id, account_id, kind, amount, balance_after, ref, scope, request_key) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [
    randomUUID(),
    accountId,
    kind,
    amount,
    balance,
    ref,
    scope,
    requestKey,
  ]);
  return balance;
}

async function bumpRevision(tx: Tx, accountId: string): Promise<void> {
  await tx.query('UPDATE accounts SET revision = revision + 1, updated_at = now() WHERE account_id = $1', [accountId]);
}

type Decision<T> = { error: EconomyError } | { value: T };

/**
 * Runs one changing request under its idempotency key: the first request
 * with a key does the work and stores its answer in the same transaction;
 * a resent request (same key) gets that answer back without running again.
 * A key reused for a different request is refused (409 conflict).
 */
async function idempotent<T>(db: Db, accountId: string, key: string, endpoint: string, request: unknown, day: string, work: (tx: Tx) => Promise<Decision<T>>): Promise<EconomyAnswer<T>> {
  if (typeof key !== 'string' || key.length < 8 || key.length > 100 || !/^[\w.:-]+$/.test(key)) return refuse('invalid_request');
  const hash = createHash('sha256').update(JSON.stringify([endpoint, request])).digest('hex');
  return withTx(db, async (tx) => {
    // Account row first: every request of this account (any key) queues here. Locking it after the key
    // insert would deadlock (that insert's foreign-key check takes a share lock on the same row).
    if (!(await lockAccount(tx, accountId))) return refuse('unauthenticated');
    const fresh = await tx.query('INSERT INTO idempotency_keys (account_id, key, endpoint, request_hash) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING key', [accountId, key, endpoint, hash]);
    if (!fresh.rows[0]) {
      const seen = await tx.query<{ endpoint: string; request_hash: string; status_code: number; response: { ok: boolean; error?: EconomyError; value?: T } }>(
        'SELECT endpoint, request_hash, status_code, response FROM idempotency_keys WHERE account_id = $1 AND key = $2',
        [accountId, key],
      );
      const row = seen.rows[0];
      const account = (await loadAccount(tx, accountId, day))!;
      if (!row || !row.response || row.endpoint !== endpoint || row.request_hash !== hash) return { status: 409, body: { ok: false, error: 'conflict', account } };
      const prior = row.response;
      return { status: row.status_code, body: prior.ok ? { ok: true, account, value: prior.value as T } : { ok: false, error: prior.error!, account } };
    }
    const decision = await work(tx);
    const answer = 'error' in decision ? { ok: false as const, error: decision.error } : { ok: true as const, value: decision.value };
    const status = answer.ok ? 200 : (STATUS[answer.error] ?? 409);
    await tx.query('UPDATE idempotency_keys SET status_code = $3, response = $4 WHERE account_id = $1 AND key = $2', [accountId, key, status, JSON.stringify(answer)]);
    const account = (await loadAccount(tx, accountId, day))!;
    return { status, body: answer.ok ? { ok: true, account, value: answer.value } : { ok: false, error: answer.error, account } };
  });
}

function refuse(error: EconomyError): EconomyAnswer<never> {
  return { status: STATUS[error] ?? 409, body: { ok: false, error } };
}

export interface RequestContext {
  accountId: string;
  key: string;
  day: string;
  ip: string;
}

/** Buys `skinId` at the server catalog price from the server balance: charge, ledger and item together. */
export function purchase(db: Db, ctx: RequestContext, skinId: unknown): Promise<EconomyAnswer<OwnedItem | null>> {
  const id = typeof skinId === 'string' ? skinId.slice(0, 80) : '';
  return idempotent<OwnedItem | null>(db, ctx.accountId, ctx.key, 'purchase', { skinId: id }, ctx.day, async (tx) => {
    const account = (await loadAccount(tx, ctx.accountId, ctx.day))!;
    const problem = ShopService.check(account, id);
    if (problem) {
      await audit(tx, ctx.accountId, 'purchase_refused', ctx.ip, { skinId: id, error: problem });
      return { error: problem };
    }
    const skin = findSkin(id)!;
    await moveCredits(tx, ctx.accountId, -skin.price, 'purchase', skin.skinId, '', ctx.key);
    const item = await tx.query<{ item_id: string; acquired_at: Date }>(
      `INSERT INTO inventory_items (item_id, account_id, skin_id, source) VALUES ($1, $2, $3, 'purchase') RETURNING item_id, acquired_at`,
      [randomUUID(), ctx.accountId, skin.skinId],
    );
    await audit(tx, ctx.accountId, 'purchase', ctx.ip, { skinId: skin.skinId, price: skin.price });
    const row = item.rows[0];
    return { value: { itemId: row.item_id, skinId: skin.skinId, acquiredAt: row.acquired_at.toISOString(), source: 'purchase' } };
  });
}

/** Equips an owned, fitting item in a slot (null = back to the default look). */
export function equip(db: Db, ctx: RequestContext, category: unknown, target: unknown, itemId: unknown): Promise<EconomyAnswer<null>> {
  const req = { category, target, itemId };
  return idempotent<null>(db, ctx.accountId, ctx.key, 'equip', req, ctx.day, async (tx) => {
    if (!SKIN_CATEGORIES.includes(category as SkinCategory) || typeof target !== 'string' || (itemId !== null && typeof itemId !== 'string')) return { error: 'invalid_request' };
    const account = (await loadAccount(tx, ctx.accountId, ctx.day))!;
    // The shared slot rules decide (ownership via this account's own items only, slot and target fit).
    const error = LoadoutService.equip(account, category as SkinCategory, target, itemId as string | null);
    if (error) return { error };
    const slot = slotKey(category as SkinCategory, target);
    if (itemId === null) await tx.query('DELETE FROM loadout WHERE account_id = $1 AND slot = $2', [ctx.accountId, slot]);
    else
      await tx.query(
        `INSERT INTO loadout (account_id, slot, item_id) VALUES ($1, $2, $3)
         ON CONFLICT (account_id, slot) DO UPDATE SET item_id = EXCLUDED.item_id, updated_at = now()`,
        [ctx.accountId, slot, itemId],
      );
    await bumpRevision(tx, ctx.accountId);
    await audit(tx, ctx.accountId, 'equip', ctx.ip, { slot, itemId });
    return { value: null };
  });
}

/** Pays a completed, unclaimed mission of today once. */
export function claimMission(db: Db, ctx: RequestContext, missionId: string): Promise<EconomyAnswer<null>> {
  return idempotent<null>(db, ctx.accountId, ctx.key, 'claim', { missionId }, ctx.day, async (tx) => {
    const def = DAILY_MISSIONS.find((m) => m.missionId === missionId);
    if (!def) return { error: 'unknown_item' };
    const r = await tx.query<{ completed: boolean; claimed: boolean }>('SELECT completed, claimed FROM missions WHERE account_id = $1 AND day = $2 AND mission_id = $3', [ctx.accountId, ctx.day, missionId]);
    const p = r.rows[0];
    if (p?.claimed) return { error: 'already_claimed' };
    if (!p?.completed) return { error: 'not_completed' };
    await tx.query('UPDATE missions SET claimed = true, updated_at = now() WHERE account_id = $1 AND day = $2 AND mission_id = $3', [ctx.accountId, ctx.day, missionId]);
    await moveCredits(tx, ctx.accountId, def.reward, 'mission_reward', missionId, ctx.day, ctx.key);
    await audit(tx, ctx.accountId, 'mission_claim', ctx.ip, { missionId, day: ctx.day, reward: def.reward });
    return { value: null };
  });
}

/**
 * Settles a match result the SERVER verified itself (a future authoritative
 * game server): reward and mission progress, once per match id. Not
 * reachable over HTTP: client reports are refused (`POST /api/match-results`
 * answers 403 unverified).
 */
export async function settleVerifiedMatch(db: Db, accountId: string, result: MatchResult, day: string): Promise<{ ok: true; credits: number; duplicate: boolean } | { ok: false; error: EconomyError }> {
  if (!validMatchResult(result)) return { ok: false, error: 'invalid_request' };
  return withTx(db, async (tx) => {
    if (!(await lockAccount(tx, accountId))) return { ok: false as const, error: 'unauthenticated' as const };
    const credits = matchReward(result);
    const first = await tx.query('INSERT INTO match_rewards (account_id, match_id, mode, outcome, credits) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING match_id', [
      accountId,
      result.matchId,
      result.mode,
      result.outcome,
      credits,
    ]);
    if (!first.rows[0]) return { ok: true as const, credits: 0, duplicate: true };
    if (credits > 0) await moveCredits(tx, accountId, credits, 'match_reward', result.matchId);
    const counted = await tx.query('INSERT INTO mission_events (account_id, day, event_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING event_id', [accountId, day, result.matchId]);
    if (counted.rows[0])
      for (const m of DAILY_MISSIONS) {
        const add = missionIncrement(m, result);
        if (add <= 0) continue;
        await tx.query(
          `INSERT INTO missions (account_id, day, mission_id, progress, completed) VALUES ($1, $2, $3, LEAST($4::int, $5::int), $5::int >= $4::int)
           ON CONFLICT (account_id, day, mission_id) DO UPDATE
             SET progress = LEAST($4::int, missions.progress + $5::int), completed = LEAST($4::int, missions.progress + $5::int) >= $4::int, updated_at = now()
             WHERE NOT missions.completed`,
          [accountId, day, m.missionId, m.target, add],
        );
      }
    await bumpRevision(tx, accountId);
    await audit(tx, accountId, 'match_settled', null, { matchId: result.matchId, credits });
    return { ok: true as const, credits, duplicate: false };
  });
}
