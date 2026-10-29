import { AccountClient, probeAccountServer, ServerEconomyBackend, SwitchableEconomyBackend } from './AccountClient';
import type { AccountSummary, AuthResult } from './AccountProtocol';
import { STARTING_CREDITS } from './EconomyRules';
import type { EconomyBackend } from './EconomyBackend';
import type { AccountState } from './types';

/**
 * Which account the GRID pages show:
 * - offline: no account server on this origin (static hosting, dev server)
 *   or it is down — this browser's offline record, as before;
 * - signed_out: a server is there, nobody signed in — the offline record,
 *   with sign-in offered;
 * - signed_in: the server account (the offline record is left untouched).
 */
export type AccountMode =
  | { kind: 'checking' }
  | { kind: 'offline'; reason: 'no_server' | 'server_down' }
  | { kind: 'signed_out'; reason?: 'expired' | 'suspended' }
  | { kind: 'signed_in'; account: AccountSummary };

/** What the offline record holds (shown when signing in: it is not moved to the account). */
export interface OfflineSummary {
  credits: number;
  items: number;
}

const NOTICE_KEY = 'grid.offline-notice.v1';

/**
 * GRID sign-in is switched off for now (the code stays): the game uses the
 * offline record only and never looks for an account server. A build with
 * VITE_GRID_ACCOUNTS=1 turns it back on.
 */
export const ACCOUNTS_ENABLED = import.meta.env.VITE_GRID_ACCOUNTS === '1';

export class AccountSession {
  mode: AccountMode = { kind: 'checking' };
  private readonly listeners: ((mode: AccountMode) => void)[] = [];
  private readonly client: AccountClient;

  constructor(
    readonly economy: SwitchableEconomyBackend,
    private readonly local: EconomyBackend,
    private readonly fetchFn: typeof fetch = (...a) => fetch(...a),
    private readonly storage: Storage | null = safeStorage(),
  ) {
    this.client = new AccountClient(fetchFn);
  }

  onModeChange(fn: (mode: AccountMode) => void): void {
    this.listeners.push(fn);
  }

  /** Looks for the account server and an existing session. The offline record stays in use until then. */
  async start(): Promise<AccountMode> {
    const server = await probeAccountServer(this.fetchFn);
    if (server === 'absent') return this.set({ kind: 'offline', reason: 'no_server' });
    if (server === 'db_down') return this.set({ kind: 'offline', reason: 'server_down' });
    const me = await this.client.me();
    if (me.ok) return this.enter(me.account);
    if (me.error === 'network' || me.error === 'storage_error') return this.set({ kind: 'offline', reason: 'server_down' });
    return this.set({ kind: 'signed_out' });
  }

  async login(username: string, password: string): Promise<AuthResult> {
    const r = await this.client.login(username, password);
    if (r.ok) await this.enter(r.account);
    return r;
  }

  async signup(username: string, password: string): Promise<AuthResult> {
    const r = await this.client.signup(username, password);
    if (r.ok) await this.enter(r.account);
    return r;
  }

  async logout(): Promise<void> {
    await this.client.logout();
    await this.leave();
  }

  /**
   * The offline record of this browser when it differs from a fresh one and
   * this account has not acknowledged that it is not moved over; else null.
   */
  async offlineNotice(): Promise<OfflineSummary | null> {
    if (this.mode.kind !== 'signed_in' || !this.storage) return null;
    const accountId = this.mode.account.accountId;
    if (this.acknowledged().includes(accountId)) return null;
    if (!this.storage.getItem('grid.account.v1')) return null;
    let a: AccountState;
    try {
      a = await this.local.getAccount();
    } catch {
      return null;
    }
    if (a.items.length === 0 && a.credits === STARTING_CREDITS) return null;
    return { credits: a.credits, items: a.items.length };
  }

  acknowledgeNotice(): void {
    if (this.mode.kind !== 'signed_in' || !this.storage) return;
    const ids = [...this.acknowledged(), this.mode.account.accountId].slice(-20);
    try {
      this.storage.setItem(NOTICE_KEY, JSON.stringify(ids));
    } catch {
      /* storage full / blocked: the notice shows again next time */
    }
  }

  private acknowledged(): string[] {
    try {
      const v = JSON.parse(this.storage?.getItem(NOTICE_KEY) ?? '[]');
      return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  private async enter(account: AccountSummary): Promise<AccountMode> {
    const server = new ServerEconomyBackend(this.fetchFn);
    server.onSignedOut = (reason) => void this.leave(reason === 'suspended' ? 'suspended' : 'expired');
    try {
      await this.economy.use(server);
    } catch {
      return this.set({ kind: 'offline', reason: 'server_down' });
    }
    return this.set({ kind: 'signed_in', account });
  }

  private async leave(reason?: 'expired' | 'suspended'): Promise<AccountMode> {
    if (this.economy.backend !== this.local) await this.economy.use(this.local).catch(() => undefined);
    return this.set(reason ? { kind: 'signed_out', reason } : { kind: 'signed_out' });
  }

  private set(mode: AccountMode): AccountMode {
    this.mode = mode;
    for (const l of this.listeners) l(mode);
    return mode;
  }
}

function safeStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
