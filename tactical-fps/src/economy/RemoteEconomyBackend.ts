import type { EconomyBackend } from './EconomyBackend';
import type { EconomyResult } from './EconomyAuthority';
import type { AccountState, EconomyError, MatchResult, OwnedItem, SkinCategory } from './types';

/**
 * Client of the account server (server/AccountApi.ts contract). Sends only
 * what is wanted (skin id, slot, mission id) with an idempotency key; shows
 * the account exactly as the server answers. Never writes browser storage:
 * if the server cannot be reached, nothing changes and the error says so.
 * Not wired into the game yet (there is no GRID account server).
 */
export class RemoteEconomyBackend implements EconomyBackend {
  readonly kind = 'remote' as const;
  onChange: ((account: AccountState) => void) | null = null;
  private last: AccountState | null = null;
  private readonly inFlight = new Map<string, Promise<EconomyResult<never>>>();

  constructor(
    private readonly baseUrl: string,
    /** Current sign-in token (from the identity provider), or null when signed out. */
    private readonly token: () => string | null,
    private readonly fetchFn: typeof fetch = (...a) => fetch(...a),
  ) {}

  async getAccount(): Promise<AccountState> {
    const r = await this.call<null>('GET', '/v1/account');
    if (!r.ok) throw new Error(r.error);
    return r.account;
  }

  purchase(skinId: string): Promise<EconomyResult<OwnedItem | null>> {
    return this.once(`buy:${skinId}`, () => this.call('POST', '/v1/purchase', { skinId }));
  }

  equip(category: SkinCategory, target: string, itemId: string | null): Promise<EconomyResult<null>> {
    return this.call('POST', '/v1/equip', { category, target, itemId });
  }

  submitMatchResult(result: MatchResult): Promise<EconomyResult<{ credits: number }>> {
    return this.call('POST', '/v1/match-results', { result });
  }

  claimMission(missionId: string): Promise<EconomyResult<null>> {
    return this.once(`claim:${missionId}`, () => this.call('POST', `/v1/missions/${encodeURIComponent(missionId)}/claim`));
  }

  private once<T>(key: string, fn: () => Promise<EconomyResult<T>>): Promise<EconomyResult<T>> {
    const pending = this.inFlight.get(key) as Promise<EconomyResult<T>> | undefined;
    if (pending) return pending;
    const p = fn().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, p as Promise<EconomyResult<never>>);
    return p;
  }

  /** One request; its idempotency key is its own (a retry of it reuses the key, no other request does). */
  private async call<T>(method: string, path: string, body?: unknown, key = method === 'GET' ? undefined : newKey(), attempt = 0): Promise<EconomyResult<T>> {
    const token = this.token();
    const fallback = this.last as AccountState;
    if (!token) return { ok: false, error: 'unauthenticated', account: fallback };
    let res: Response;
    try {
      res = await this.fetchFn(this.baseUrl + path, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      // Unreachable: the same key is kept for one retry, so a request that did arrive is not applied twice.
      if (attempt < 1) return this.call(method, path, body, key, attempt + 1);
      return { ok: false, error: 'network', account: fallback };
    }
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: EconomyError; account?: AccountState; value?: T };
    if (data.account) this.last = data.account;
    if (data.ok && data.account) {
      this.onChange?.(data.account);
      return { ok: true, account: data.account, value: data.value as T };
    }
    return { ok: false, error: data.error ?? 'invalid_request', account: data.account ?? fallback };
  }

}

function newKey(): string {
  const c = globalThis.crypto as Crypto | undefined;
  return c?.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * What to do when an account exists in this browser and online. Never
 * decides to overwrite on its own: anything but an identical record or an
 * empty side is a conflict the player resolves.
 */
export function planSync(local: AccountState | null, remote: AccountState | null): 'nothing' | 'use_remote' | 'offer_upload' | 'conflict' {
  if (!local && !remote) return 'nothing';
  if (!local) return 'use_remote';
  if (!remote) return 'offer_upload';
  const same = JSON.stringify({ c: local.credits, i: local.items, l: local.loadout }) === JSON.stringify({ c: remote.credits, i: remote.items, l: remote.loadout });
  return same ? 'use_remote' : 'conflict';
}
