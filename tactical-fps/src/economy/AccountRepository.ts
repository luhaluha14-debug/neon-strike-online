import type { AccountState } from './types';

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
      const parsed = JSON.parse(raw) as AccountState;
      return parsed && parsed.schema === 1 ? parsed : null;
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
