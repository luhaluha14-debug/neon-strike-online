import { findSkin } from './SkinCatalog';
import type { AccountState, OwnedItem } from './types';

/**
 * A stored record made safe to use (Phase 26-C): whatever is broken falls back to the default without
 * touching what is fine. Items must be well-formed and unique per skin (skins this build does not know
 * are kept: a newer build may); a loadout slot is kept only when it names an owned item whose skin fits
 * that slot (anything else shows the slot's default skin). A record without an account id or a usable
 * balance is not an account at all: null (a fresh one is made).
 */
export function repairAccount(raw: unknown): AccountState | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as AccountState;
  if (a.schema !== 1 || typeof a.accountId !== 'string' || !a.accountId || !Number.isFinite(a.credits) || a.credits < 0) return null;
  const seen = new Set<string>();
  const items: OwnedItem[] = [];
  for (const i of Array.isArray(a.items) ? a.items : []) {
    if (!i || typeof i.itemId !== 'string' || typeof i.skinId !== 'string' || seen.has(i.skinId)) continue;
    seen.add(i.skinId);
    items.push(i);
  }
  a.items = items;
  const loadout: Record<string, string> = {};
  if (a.loadout && typeof a.loadout === 'object' && !Array.isArray(a.loadout))
    for (const [slot, itemId] of Object.entries(a.loadout)) {
      const item = typeof itemId === 'string' ? items.find((i) => i.itemId === itemId) : undefined;
      const skin = item ? findSkin(item.skinId) : undefined;
      const [category, target] = slot.split(':');
      if (skin && skin.category === category && skin.targets.includes(target)) loadout[slot] = itemId as string;
    }
  a.loadout = loadout;
  if (!a.missions || typeof a.missions !== 'object' || !a.missions.missions || typeof a.missions.missions !== 'object' || !Array.isArray(a.missions.seenEvents))
    a.missions = { day: '', missions: {}, seenEvents: [] };
  if (!Array.isArray(a.ledger)) a.ledger = [];
  if (!Array.isArray(a.settledMatches)) a.settledMatches = [];
  if (!a.requests || typeof a.requests !== 'object') a.requests = {};
  if (!Number.isInteger(a.seq) || a.seq < 0) a.seq = items.length + a.ledger.length;
  if (!Number.isInteger(a.revision) || a.revision < 1) a.revision = 1;
  return a;
}

// Where an account record lives. Every economy service goes through this
// interface; none of them touches browser storage itself, so the local
// store can be replaced by an online one without changing the services.

export type SaveResult = { ok: true } | { ok: false; reason: 'conflict' | 'storage_error' };

export interface AccountRepository {
  /** The stored account, or null when there is none yet. */
  load(): Promise<AccountState | null>;
  /**
   * Stores `next` only if the stored record still has `expectedRevision`
   * (null = must not exist yet). Never overwrites a newer record.
   */
  save(next: AccountState, expectedRevision: number | null): Promise<SaveResult>;
}

/** In-memory store (tests, or a session without storage). Can be told to fail. */
export class MemoryAccountRepository implements AccountRepository {
  private record: string | null = null;
  /** Make the next `failSaves` saves fail with a storage error. */
  failSaves = 0;
  saves = 0;

  async load(): Promise<AccountState | null> {
    return this.record ? (JSON.parse(this.record) as AccountState) : null;
  }

  async save(next: AccountState, expectedRevision: number | null): Promise<SaveResult> {
    if (this.failSaves > 0) {
      this.failSaves--;
      return { ok: false, reason: 'storage_error' };
    }
    const current = this.record ? (JSON.parse(this.record) as AccountState) : null;
    if ((current?.revision ?? null) !== expectedRevision) return { ok: false, reason: 'conflict' };
    this.record = JSON.stringify(next);
    this.saves++;
    return { ok: true };
  }

  /** Test aid: replace the stored record as another device would. */
  overwrite(state: AccountState): void {
    this.record = JSON.stringify(state);
  }
}

/** The browser's localStorage (offline / local build). Key `grid.account.v1`. */
export class LocalAccountRepository implements AccountRepository {
  constructor(
    private readonly storage: Storage | null = safeLocalStorage(),
    readonly key = 'grid.account.v1',
  ) {}

  async load(): Promise<AccountState | null> {
    try {
      const raw = this.storage?.getItem(this.key);
      if (!raw) return null;
      return repairAccount(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  async save(next: AccountState, expectedRevision: number | null): Promise<SaveResult> {
    if (!this.storage) return { ok: false, reason: 'storage_error' };
    try {
      // Another tab may have saved in between: compare revisions first.
      const raw = this.storage.getItem(this.key);
      const current = raw ? ((JSON.parse(raw) as AccountState).revision ?? null) : null;
      if (current !== expectedRevision) return { ok: false, reason: 'conflict' };
      this.storage.setItem(this.key, JSON.stringify(next));
      return { ok: true };
    } catch {
      return { ok: false, reason: 'storage_error' };
    }
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
