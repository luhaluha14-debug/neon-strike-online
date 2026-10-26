import { LocalAccountRepository, type AccountRepository } from './AccountRepository';
import { LocalClock, type EconomyClock } from './EconomyClock';
import { EconomyAuthority, type EconomyResult } from './EconomyAuthority';
import type { AccountState, MatchResult, OwnedItem, SkinCategory } from './types';

/**
 * What the game and its menus may ask of the economy: the only surface
 * the client uses. A request names what is wanted (a skin id, a slot, a
 * mission) — never a price or a balance; the answer carries the account
 * as the authority now holds it, and the client shows exactly that.
 *
 * Local build: LocalEconomyBackend runs the authority in the browser on
 * localStorage (trusted client: fine offline, not for a shared economy).
 * Online build: an HTTP client with the same methods, the authority on the
 * account server (see docs/grid-economy.md).
 */
export interface EconomyBackend {
  /** Which kind of backend: 'local' results are not server-verified. */
  readonly kind: 'local' | 'remote';
  getAccount(): Promise<AccountState>;
  purchase(skinId: string): Promise<EconomyResult<OwnedItem | null>>;
  equip(category: SkinCategory, target: string, itemId: string | null): Promise<EconomyResult<null>>;
  submitMatchResult(result: MatchResult): Promise<EconomyResult<{ credits: number }>>;
  claimMission(missionId: string): Promise<EconomyResult<null>>;
  /** Called after every account change the backend made (menus refresh, the game re-dresses). */
  onChange: ((account: AccountState) => void) | null;
}

export class LocalEconomyBackend implements EconomyBackend {
  readonly kind = 'local' as const;
  onChange: ((account: AccountState) => void) | null = null;
  private readonly authority: EconomyAuthority;
  private ready: Promise<AccountState> | null = null;
  /** Purchases / claims still being processed, by target: a second click joins the first request. */
  private readonly inFlight = new Map<string, Promise<EconomyResult<never>>>();

  constructor(repo: AccountRepository = new LocalAccountRepository(), clock: EconomyClock = new LocalClock()) {
    this.authority = new EconomyAuthority(repo, clock);
  }

  getAccount(): Promise<AccountState> {
    this.ready ??= this.authority.init();
    return this.ready.then(() => this.authority.refreshDay());
  }

  purchase(skinId: string): Promise<EconomyResult<OwnedItem | null>> {
    return this.once(`buy:${skinId}`, () => this.authority.purchase(skinId, requestId('buy')));
  }

  equip(category: SkinCategory, target: string, itemId: string | null): Promise<EconomyResult<null>> {
    return this.run(() => this.authority.equip(category, target, itemId, requestId('equip')));
  }

  submitMatchResult(result: MatchResult): Promise<EconomyResult<{ credits: number }>> {
    return this.run(() => this.authority.submitMatchResult(result));
  }

  claimMission(missionId: string): Promise<EconomyResult<null>> {
    return this.once(`claim:${missionId}`, () => this.authority.claimMission(missionId, requestId('claim')));
  }

  private async run<T>(fn: () => Promise<EconomyResult<T>>): Promise<EconomyResult<T>> {
    await this.getAccount();
    const r = await fn();
    if (r.ok) this.onChange?.(r.account);
    return r;
  }

  /** One request per key at a time: repeated clicks while it runs get the same answer. */
  private once<T>(key: string, fn: () => Promise<EconomyResult<T>>): Promise<EconomyResult<T>> {
    const pending = this.inFlight.get(key) as Promise<EconomyResult<T>> | undefined;
    if (pending) return pending;
    const p = this.run(fn).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, p as Promise<EconomyResult<never>>);
    return p;
  }
}

let counter = 0;
function requestId(kind: string): string {
  const c = globalThis.crypto as Crypto | undefined;
  return `${kind}-${c?.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`}`;
}
