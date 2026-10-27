import { ACCOUNT_SERVICE, CSRF_HEADER, type AccountSummary, type AuthError, type AuthResult } from './AccountProtocol';
import type { EconomyBackend } from './EconomyBackend';
import type { EconomyResult } from './EconomyAuthority';
import type { AccountState, EconomyError, MatchResult, OwnedItem, SkinCategory } from './types';

// Browser client of the GRID account server (same origin, /api/*). The
// session is an HttpOnly cookie the page cannot read; requests carry only
// what is wanted (skin id, slot, mission id) and an idempotency key. No
// URL, key or secret of the server is part of this bundle.

type FetchFn = typeof fetch;

/** Is a GRID account server answering on this origin? 'absent' = static hosting / dev server: offline mode. */
export async function probeAccountServer(fetchFn: FetchFn = (...a) => fetch(...a), timeoutMs = 4000): Promise<'online' | 'db_down' | 'absent'> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchFn('/api/health', { credentials: 'same-origin', signal: ctl.signal, cache: 'no-store' });
    // Static hosts and the dev server answer unknown paths with the game page: not a GRID server.
    const data = (await res.json().catch(() => null)) as { service?: string; db?: string } | null;
    if (data?.service !== ACCOUNT_SERVICE) return 'absent';
    return res.ok && data.db === 'up' ? 'online' : 'db_down';
  } catch {
    return 'absent';
  } finally {
    clearTimeout(timer);
  }
}

/** Sign-up, sign-in, sign-out, current account. */
export class AccountClient {
  constructor(private readonly fetchFn: FetchFn = (...a) => fetch(...a)) {}

  /** The signed-in account; `unauthenticated` when nobody is signed in. */
  async me(): Promise<AuthResult> {
    const r = await this.auth('GET', '/api/auth/me');
    return r.ok && !r.account ? { ok: false, error: 'unauthenticated' } : r;
  }

  signup(username: string, password: string): Promise<AuthResult> {
    return this.auth('POST', '/api/auth/signup', { username, password });
  }

  login(username: string, password: string): Promise<AuthResult> {
    return this.auth('POST', '/api/auth/login', { username, password });
  }

  async logout(): Promise<void> {
    await this.fetchFn('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { [CSRF_HEADER]: '1' } }).catch(() => undefined);
  }

  private async auth(method: string, path: string, body?: unknown): Promise<AuthResult> {
    let res: Response;
    try {
      res = await this.fetchFn(path, {
        method,
        credentials: 'same-origin',
        headers: { ...(method !== 'GET' ? { [CSRF_HEADER]: '1' } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      return { ok: false, error: 'network' };
    }
    const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: AuthError; account?: AccountSummary | null } | null;
    if (!data) return { ok: false, error: res.status >= 500 ? 'network' : 'invalid_request' };
    if (data.ok) return { ok: true, account: data.account as AccountSummary };
    return { ok: false, error: data.error ?? (res.status === 401 ? 'unauthenticated' : 'invalid_request') };
  }
}

/**
 * The economy of a signed-in account, decided by the server: balance,
 * prices, ownership, missions. Never writes browser storage; if the server
 * cannot be reached nothing changes and the error says so. Match results
 * are refused by the server (no trusted match verification yet).
 */
export class ServerEconomyBackend implements EconomyBackend {
  readonly kind = 'remote' as const;
  onChange: ((account: AccountState) => void) | null = null;
  /** The server said the session is gone (expired, signed out elsewhere, suspended). */
  onSignedOut: ((reason: 'unauthenticated' | 'suspended') => void) | null = null;
  private last: AccountState | null = null;
  private readonly inFlight = new Map<string, Promise<EconomyResult<never>>>();

  constructor(private readonly fetchFn: FetchFn = (...a) => fetch(...a)) {}

  async getAccount(): Promise<AccountState> {
    const r = await this.call<null>('GET', '/api/account');
    if (r.ok) return r.account;
    if (this.last) return this.last;
    throw new Error(r.error);
  }

  purchase(skinId: string): Promise<EconomyResult<OwnedItem | null>> {
    return this.once(`buy:${skinId}`, () => this.call('POST', '/api/purchase', { skinId }));
  }

  equip(category: SkinCategory, target: string, itemId: string | null): Promise<EconomyResult<null>> {
    return this.call('POST', '/api/equip', { category, target, itemId });
  }

  submitMatchResult(result: MatchResult): Promise<EconomyResult<{ credits: number }>> {
    return this.call('POST', '/api/match-results', { result });
  }

  claimMission(missionId: string): Promise<EconomyResult<null>> {
    return this.once(`claim:${missionId}`, () => this.call('POST', `/api/missions/${encodeURIComponent(missionId)}/claim`));
  }

  private once<T>(key: string, fn: () => Promise<EconomyResult<T>>): Promise<EconomyResult<T>> {
    const pending = this.inFlight.get(key) as Promise<EconomyResult<T>> | undefined;
    if (pending) return pending;
    const p = fn().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, p as Promise<EconomyResult<never>>);
    return p;
  }

  /** One request with its own idempotency key; a lost connection is retried once with the same key. */
  private async call<T>(method: string, path: string, body?: unknown, key = method === 'GET' ? undefined : newKey(), attempt = 0): Promise<EconomyResult<T>> {
    const fallback = this.last as AccountState;
    let res: Response;
    try {
      res = await this.fetchFn(path, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          ...(method !== 'GET' ? { [CSRF_HEADER]: '1' } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(key ? { 'idempotency-key': key } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      if (attempt < 1) return this.call(method, path, body, key, attempt + 1);
      return { ok: false, error: 'network', account: fallback };
    }
    const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: EconomyError; account?: AccountState; value?: T } | null;
    if (!data) return { ok: false, error: res.status >= 500 ? 'network' : 'invalid_request', account: fallback };
    if (data.account) this.last = data.account;
    if (data.ok && data.account) {
      if (method !== 'GET') this.onChange?.(data.account);
      return { ok: true, account: data.account, value: data.value as T };
    }
    const error = data.error ?? 'invalid_request';
    if (error === 'unauthenticated' || error === 'suspended') this.onSignedOut?.(error);
    return { ok: false, error, account: data.account ?? fallback };
  }
}

/**
 * The economy the game uses now: this browser's offline record or the
 * signed-in server account. Switching never copies anything between them.
 */
export class SwitchableEconomyBackend implements EconomyBackend {
  onChange: ((account: AccountState) => void) | null = null;
  private current: EconomyBackend;

  constructor(initial: EconomyBackend) {
    this.current = initial;
    this.attach(initial);
  }

  get kind(): 'local' | 'remote' {
    return this.current.kind;
  }

  get backend(): EconomyBackend {
    return this.current;
  }

  /** Uses `next` from now on and shows its account (throws, leaving the current one, if it cannot be loaded). */
  async use(next: EconomyBackend): Promise<AccountState> {
    const account = await next.getAccount();
    this.current.onChange = null;
    this.current = next;
    this.attach(next);
    this.onChange?.(account);
    return account;
  }

  getAccount(): Promise<AccountState> {
    return this.current.getAccount();
  }

  purchase(skinId: string): Promise<EconomyResult<OwnedItem | null>> {
    return this.current.purchase(skinId);
  }

  equip(category: SkinCategory, target: string, itemId: string | null): Promise<EconomyResult<null>> {
    return this.current.equip(category, target, itemId);
  }

  submitMatchResult(result: MatchResult): Promise<EconomyResult<{ credits: number }>> {
    return this.current.submitMatchResult(result);
  }

  claimMission(missionId: string): Promise<EconomyResult<null>> {
    return this.current.claimMission(missionId);
  }

  private attach(b: EconomyBackend): void {
    b.onChange = (a) => {
      if (this.current === b) this.onChange?.(a);
    };
  }
}

function newKey(): string {
  const c = globalThis.crypto as Crypto | undefined;
  return c?.randomUUID ? `k-${c.randomUUID()}` : `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
