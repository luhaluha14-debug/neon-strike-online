import { findSkin } from '../SkinCatalog';
import type { AccountState, OwnedItem } from '../types';

// Player-to-player skin trades: the server-side model only (no UI, no money).
// Items change owner here and nowhere else, inside one critical section that
// either moves every item of a trade or none. Cash payments, withdrawals and
// external cash trading are out of scope.

export type TradeState = 'open' | 'completed' | 'cancelled' | 'expired' | 'failed';

export type TradeError =
  | 'unknown_account'
  | 'suspended'
  | 'invalid_request'
  | 'not_owned'
  | 'not_tradable'
  | 'item_locked'
  | 'duplicate_skin'
  | 'unknown_trade'
  | 'not_a_party'
  | 'not_open'
  | 'expired'
  | 'storage_error';

export interface TradeOffer {
  readonly tradeId: string;
  readonly from: string;
  readonly to: string;
  /** Item instances `from` gives / wants from `to`. */
  readonly give: readonly string[];
  readonly want: readonly string[];
  state: TradeState;
  confirmed: { from: boolean; to: boolean };
  readonly createdAt: number;
  readonly expiresAt: number;
  closedAt?: number;
  failure?: TradeError;
}

/** Append-only audit record of every trade event. */
export interface AuditEntry {
  readonly at: number;
  readonly tradeId: string;
  readonly event: 'proposed' | 'confirmed' | 'completed' | 'cancelled' | 'expired' | 'failed' | 'refused';
  readonly by?: string;
  readonly detail?: string;
}

export interface TradeAccount {
  state: AccountState;
  suspended: boolean;
}

/**
 * Account storage for trades. `commit` must store every given account or
 * none (one database transaction in production).
 */
export interface TradeStore {
  get(accountId: string): TradeAccount | undefined;
  /** Ownership change: the accounts and its audit entries together, or nothing. */
  commit(updated: readonly AccountState[], audit: readonly AuditEntry[]): boolean;
  /** Events that change no account (proposals, confirmations, refusals, closures). */
  appendAudit(entry: AuditEntry): void;
  readonly audit: readonly AuditEntry[];
}

export class MemoryTradeStore implements TradeStore {
  readonly accounts = new Map<string, TradeAccount>();
  readonly audit: AuditEntry[] = [];
  /** Make the next commits fail (a database error). */
  failCommits = 0;

  get(accountId: string): TradeAccount | undefined {
    const a = this.accounts.get(accountId);
    return a ? { state: structuredClone(a.state), suspended: a.suspended } : undefined;
  }

  commit(updated: readonly AccountState[], audit: readonly AuditEntry[]): boolean {
    if (this.failCommits > 0) {
      this.failCommits--;
      return false;
    }
    for (const s of updated) {
      const a = this.accounts.get(s.accountId);
      if (!a) return false;
    }
    for (const s of updated) this.accounts.get(s.accountId)!.state = structuredClone(s);
    this.audit.push(...audit);
    return true;
  }

  appendAudit(entry: AuditEntry): void {
    this.audit.push(entry);
  }
}

export type TradeResult = { ok: true; trade: TradeOffer } | { ok: false; error: TradeError; trade?: TradeOffer };

export class TradeService {
  readonly trades = new Map<string, TradeOffer>();
  private readonly requests = new Map<string, TradeResult>();
  private seq = 0;

  constructor(
    private readonly store: TradeStore,
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs = 10 * 60 * 1000,
  ) {}

  /** `from` offers its `give` items for `to`'s `want` items. */
  propose(requestId: string, from: string, to: string, give: readonly string[], want: readonly string[]): TradeResult {
    return this.once(requestId, () => {
      if (from === to || give.length + want.length === 0 || hasDuplicates([...give, ...want])) return this.refuse('invalid_request');
      const a = this.store.get(from);
      const b = this.store.get(to);
      if (!a || !b) return this.refuse('unknown_account');
      if (a.suspended || b.suspended) return this.refuse('suspended');
      const problem = this.check(a.state, b.state, give, want);
      if (problem) return this.refuse(problem);
      const t: TradeOffer = {
        tradeId: `trade-${++this.seq}`,
        from,
        to,
        give: [...give],
        want: [...want],
        state: 'open',
        confirmed: { from: false, to: false },
        createdAt: this.now(),
        expiresAt: this.now() + this.ttlMs,
      };
      this.trades.set(t.tradeId, t);
      this.log(t.tradeId, 'proposed', from);
      return { ok: true, trade: snapshot(t) };
    });
  }

  /** A party confirms; once both have, the items move (all or none). */
  confirm(requestId: string, tradeId: string, accountId: string): TradeResult {
    return this.once(requestId, () => {
      const t = this.trades.get(tradeId);
      if (!t) return this.refuse('unknown_trade');
      if (accountId !== t.from && accountId !== t.to) return this.refuse('not_a_party', t);
      if (this.expireIfDue(t)) return this.refuse('expired', t);
      if (t.state !== 'open') return this.refuse('not_open', t);
      const me = this.store.get(accountId);
      if (!me || me.suspended) return this.refuse('suspended', t);
      t.confirmed[accountId === t.from ? 'from' : 'to'] = true;
      this.log(t.tradeId, 'confirmed', accountId);
      if (t.confirmed.from && t.confirmed.to) this.execute(t);
      // execute() may have closed it (completed / failed): read the state again.
      const after = t.state as TradeState;
      return after === 'failed' ? { ok: false, error: t.failure ?? 'storage_error', trade: snapshot(t) } : { ok: true, trade: snapshot(t) };
    });
  }

  /** Either party withdraws an open trade; nothing moves. */
  cancel(requestId: string, tradeId: string, accountId: string): TradeResult {
    return this.once(requestId, () => {
      const t = this.trades.get(tradeId);
      if (!t) return this.refuse('unknown_trade');
      if (accountId !== t.from && accountId !== t.to) return this.refuse('not_a_party', t);
      if (t.state !== 'open') return this.refuse('not_open', t);
      this.close(t, 'cancelled', accountId);
      return { ok: true, trade: snapshot(t) };
    });
  }

  /** Closes every open trade past its expiry (run periodically). */
  expireDue(): number {
    let n = 0;
    for (const t of this.trades.values()) if (this.expireIfDue(t)) n++;
    return n;
  }

  /** Items held by open trades (cannot be offered again until those close). */
  lockedItems(): Set<string> {
    const s = new Set<string>();
    for (const t of this.trades.values()) if (t.state === 'open') for (const id of [...t.give, ...t.want]) s.add(id);
    return s;
  }

  // --- internals -------------------------------------------------------------

  /** Why these items cannot be traded between these accounts now (null = they can). */
  private check(a: AccountState, b: AccountState, give: readonly string[], want: readonly string[]): TradeError | null {
    const locked = this.lockedItems();
    const side = (owner: AccountState, other: AccountState, ids: readonly string[]): TradeError | null => {
      for (const id of ids) {
        const item = owner.items.find((i) => i.itemId === id);
        if (!item) return 'not_owned';
        if (!findSkin(item.skinId)?.tradable) return 'not_tradable';
        if (locked.has(id)) return 'item_locked';
        // One instance per skin per account: the receiver must not already have it.
        if (other.items.some((i) => i.skinId === item.skinId)) return 'duplicate_skin';
      }
      return null;
    };
    return side(a, b, give) ?? side(b, a, want);
  }

  /** Moves the items of a fully confirmed trade in one commit, or marks it failed with nothing moved. */
  private execute(t: TradeOffer): void {
    const a = this.store.get(t.from);
    const b = this.store.get(t.to);
    if (!a || !b || a.suspended || b.suspended) return this.fail(t, a && b ? 'suspended' : 'unknown_account');
    // Re-check against the current records (the trade's own items are locked by itself, so leave them out).
    this.trades.delete(t.tradeId);
    const problem = this.check(a.state, b.state, t.give, t.want);
    this.trades.set(t.tradeId, t);
    if (problem) return this.fail(t, problem);
    const moved = [...move(a.state, b.state, t.give), ...move(b.state, a.state, t.want)];
    for (const s of [a.state, b.state]) s.revision++;
    const at = this.now();
    const audit: AuditEntry[] = [{ at, tradeId: t.tradeId, event: 'completed', detail: moved.join(',') }];
    if (!this.store.commit([a.state, b.state], audit)) return this.fail(t, 'storage_error');
    t.state = 'completed';
    t.closedAt = at;
  }

  private fail(t: TradeOffer, error: TradeError): void {
    t.failure = error;
    this.close(t, 'failed', undefined, error);
  }

  private expireIfDue(t: TradeOffer): boolean {
    if (t.state !== 'open' || this.now() < t.expiresAt) return false;
    this.close(t, 'expired');
    return true;
  }

  private close(t: TradeOffer, state: 'cancelled' | 'expired' | 'failed', by?: string, detail?: string): void {
    t.state = state;
    t.closedAt = this.now();
    this.log(t.tradeId, state, by, detail);
  }

  private log(tradeId: string, event: AuditEntry['event'], by?: string, detail?: string): void {
    this.store.appendAudit({ at: this.now(), tradeId, event, ...(by ? { by } : {}), ...(detail ? { detail } : {}) });
  }

  private refuse(error: TradeError, t?: TradeOffer): TradeResult {
    this.log(t?.tradeId ?? '-', 'refused', undefined, error);
    return t ? { ok: false, error, trade: snapshot(t) } : { ok: false, error };
  }

  /** The same request id always gets the first answer (a resent confirm never moves items twice). */
  private once(requestId: string, fn: () => TradeResult): TradeResult {
    if (typeof requestId !== 'string' || requestId.length < 4) return { ok: false, error: 'invalid_request' };
    const seen = this.requests.get(requestId);
    if (seen) return seen;
    const r = fn();
    this.requests.set(requestId, r);
    return r;
  }
}

/** Moves item instances (same ids) from one account to another; clears them from the giver's loadout. */
function move(fromAcc: AccountState, toAcc: AccountState, ids: readonly string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const i = fromAcc.items.findIndex((x) => x.itemId === id);
    const [item] = fromAcc.items.splice(i, 1);
    for (const [slot, eq] of Object.entries(fromAcc.loadout)) if (eq === id) delete fromAcc.loadout[slot];
    const moved: OwnedItem = { ...item, source: 'trade' };
    toAcc.items.push(moved);
    out.push(`${id}:${fromAcc.accountId}->${toAcc.accountId}`);
  }
  return out;
}

function hasDuplicates(ids: readonly string[]): boolean {
  return new Set(ids).size !== ids.length;
}

function snapshot(t: TradeOffer): TradeOffer {
  return structuredClone(t);
}
