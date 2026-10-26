import type { AccountRepository } from './AccountRepository';
import type { EconomyClock } from './EconomyClock';
import { REQUEST_MEMORY, STARTING_CREDITS } from './EconomyRules';
import { InventoryService } from './InventoryService';
import { LoadoutService } from './LoadoutService';
import { MissionService } from './MissionService';
import { RewardService, validMatchResult } from './RewardService';
import { ShopService } from './ShopService';
import { SKIN_CATEGORIES, type AccountState, type EconomyError, type MatchResult, type OwnedItem, type SkinCategory } from './types';

/** Answer to a request: the account after it, or why it was refused (the account unchanged). */
export type EconomyResult<T = unknown> = { ok: true; account: AccountState; value: T } | { ok: false; error: EconomyError; account: AccountState };

/**
 * The one place that changes an account: credits, purchases, loadout,
 * match rewards, missions. Runs where the account is authoritative — in the
 * browser for the local build (LocalEconomyBackend), on the account server
 * online (the same code, behind an HTTP API).
 *
 * Guarantees:
 * - requests run one at a time (no interleaving between check and change);
 * - each change is made on a copy and only becomes the account once the
 *   repository has stored it (all or nothing: never charged without the item);
 * - a request id seen before returns the same outcome without running again
 *   (double clicks, resent requests);
 * - the repository refuses to overwrite a newer record (conflict, reported).
 */
export class EconomyAuthority {
  private state: AccountState | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly repo: AccountRepository,
    private readonly clock: EconomyClock,
    private readonly newAccountId: () => string = randomId,
  ) {}

  /** Loads the stored account, or creates (and stores) a new one. */
  async init(): Promise<AccountState> {
    return this.serial(async () => {
      const loaded = await this.repo.load();
      if (loaded) {
        this.state = loaded;
        return clone(loaded);
      }
      const fresh = newAccount(this.newAccountId(), this.clock.dayKey());
      const saved = await this.repo.save(fresh, null);
      if (!saved.ok) {
        // Another tab created it first: use theirs.
        const theirs = saved.reason === 'conflict' ? await this.repo.load() : null;
        this.state = theirs ?? fresh;
      } else this.state = fresh;
      return clone(this.state);
    });
  }

  /** A copy of the current account (never the live record). */
  account(): AccountState {
    if (!this.state) throw new Error('economy not initialised');
    return clone(this.state);
  }

  purchase(skinId: string, requestId: string): Promise<EconomyResult<OwnedItem | null>> {
    return this.change(requestId, (draft, at) => {
      const r = ShopService.buy(draft, skinId, at, requestId);
      return 'error' in r ? r.error : { value: r.item };
    });
  }

  equip(category: SkinCategory, target: string, itemId: string | null, requestId: string): Promise<EconomyResult<null>> {
    return this.change(requestId, (draft) => {
      if (!SKIN_CATEGORIES.includes(category) || typeof target !== 'string') return 'invalid_request';
      const error = LoadoutService.equip(draft, category, target, itemId);
      return error ?? { value: null };
    });
  }

  /** Settles a finished match once (reward + mission progress); the match id is the request id. */
  submitMatchResult(result: MatchResult): Promise<EconomyResult<{ credits: number }>> {
    const id = validMatchResult(result) ? `match:${result.matchId}` : null;
    if (!id) return Promise.resolve(this.refuse('invalid_request'));
    return this.change(id, (draft, at, day) => {
      if (RewardService.settled(draft, result.matchId)) return { value: { credits: 0 } };
      const credits = RewardService.settle(draft, result, at);
      MissionService.record(draft, day, result.matchId, result);
      return { value: { credits } };
    });
  }

  claimMission(missionId: string, requestId: string): Promise<EconomyResult<null>> {
    return this.change(requestId, (draft, at, day) => MissionService.claim(draft, day, missionId, at, requestId) ?? { value: null });
  }

  /** Brings daily missions to today's day key (shown state; stored with the next change). */
  async refreshDay(): Promise<AccountState> {
    return this.serial(async () => {
      if (!this.state) throw new Error('economy not initialised');
      const draft = clone(this.state);
      MissionService.roll(draft, this.clock.dayKey());
      return draft;
    });
  }

  // --- internals -------------------------------------------------------------

  private refuse(error: EconomyError): EconomyResult<never> {
    return { ok: false, error, account: this.state ? clone(this.state) : (undefined as unknown as AccountState) };
  }

  /** Runs `fn` alone, in order. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * One change: same request id → same outcome; otherwise apply `fn` to a
   * copy, store it, and only then make it the account.
   */
  private change<T>(requestId: string, fn: (draft: AccountState, at: string, day: string) => EconomyError | { value: T }): Promise<EconomyResult<T>> {
    return this.serial(async () => {
      const current = this.state;
      if (!current) throw new Error('economy not initialised');
      if (typeof requestId !== 'string' || requestId.length < 4 || requestId.length > 120) return this.refuse('invalid_request');
      const seen = current.requests[requestId];
      if (seen) return seen.ok ? { ok: true, account: clone(current), value: (seen.value ?? null) as T } : { ok: false, error: seen.error ?? 'invalid_request', account: clone(current) };
      const draft = clone(current);
      const day = this.clock.dayKey();
      MissionService.roll(draft, day);
      let out: EconomyError | { value: T };
      try {
        out = fn(draft, this.clock.nowIso(), day);
      } catch {
        out = 'invalid_request';
      }
      if (typeof out === 'string') {
        // Refusals change nothing and are not stored: the same request may succeed later (e.g. after earning credits).
        return { ok: false, error: out, account: clone(current) };
      }
      draft.requests[requestId] = { ok: true, value: out.value === undefined ? null : clone(out.value) };
      trimRequests(draft);
      draft.revision = current.revision + 1;
      const saved = await this.repo.save(draft, current.revision);
      if (!saved.ok) return { ok: false, error: saved.reason === 'conflict' ? 'conflict' : 'storage_error', account: clone(current) };
      this.state = draft;
      return { ok: true, account: clone(draft), value: out.value };
    });
  }
}

export function newAccount(accountId: string, day: string): AccountState {
  const a: AccountState = {
    schema: 1,
    accountId,
    revision: 1,
    credits: 0,
    items: [],
    loadout: {},
    ledger: [],
    missions: { day, missions: {}, seenEvents: [] },
    settledMatches: [],
    requests: {},
    seq: 0,
  };
  MissionService.roll(a, day);
  if (STARTING_CREDITS > 0) {
    a.credits = STARTING_CREDITS;
    a.seq++;
    a.ledger.push({ txId: `${accountId}-tx-${a.seq}`, at: new Date(0).toISOString(), kind: 'grant', amount: STARTING_CREDITS, balanceAfter: STARTING_CREDITS, ref: 'starting_credits' });
  }
  return a;
}

/** Quick lookups for a view of the account. */
export const AccountView = {
  owns: (a: AccountState, skinId: string) => InventoryService.ownsSkin(a, skinId),
  itemFor: (a: AccountState, skinId: string) => a.items.find((i) => i.skinId === skinId),
};

function trimRequests(a: AccountState): void {
  const keys = Object.keys(a.requests);
  for (let i = 0; i < keys.length - REQUEST_MEMORY; i++) delete a.requests[keys[i]];
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function randomId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return `grid-${c.randomUUID()}`;
  return `grid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
