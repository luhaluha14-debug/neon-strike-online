import type { AccountRepository } from '../AccountRepository';
import type { EconomyClock } from '../EconomyClock';
import { EconomyAuthority, type EconomyResult } from '../EconomyAuthority';
import type { EconomyError, MatchResult, SkinCategory } from '../types';

// Reference account server: the HTTP contract of docs/grid-economy.md as a
// plain request handler (no framework, no sockets), so it can be mounted in
// any Node server and tested in-process. Every change goes through the same
// EconomyAuthority as the local build; the server alone decides balances,
// prices, ownership and rewards.
//
// Not included (needs the real service): the sign-in itself (TokenVerifier
// is the seam for an existing identity provider; no passwords live here),
// a database (AccountRepository per account), and match verification (the
// server only pays matches its own game server reports: client-reported
// results are refused unless `trustClientResults` is set for a test build).

/** Turns a bearer token into an account id (an existing, audited identity provider in production). */
export interface TokenVerifier {
  verify(token: string): string | null;
}

export interface ApiRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body?: unknown;
}

export interface ApiResponse {
  status: number;
  body: { ok: boolean; error?: EconomyError; account?: unknown; value?: unknown };
}

const STATUS: Partial<Record<EconomyError, number>> = {
  unauthenticated: 401,
  unverified: 403,
  invalid_request: 400,
  unknown_item: 404,
  conflict: 409,
  storage_error: 503,
};

export class AccountApi {
  private readonly authorities = new Map<string, EconomyAuthority>();

  constructor(
    private readonly verifier: TokenVerifier,
    private readonly repoFor: (accountId: string) => AccountRepository,
    private readonly clock: EconomyClock,
    private readonly options: { trustClientResults?: boolean } = {},
  ) {}

  async handle(req: ApiRequest): Promise<ApiResponse> {
    const auth = req.headers['authorization'] ?? req.headers['Authorization'];
    const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const accountId = token ? this.verifier.verify(token) : null;
    if (!accountId) return fail('unauthenticated');
    const authority = await this.authority(accountId);
    const key = req.headers['idempotency-key'] ?? req.headers['Idempotency-Key'];
    const body = (req.body ?? {}) as Record<string, unknown>;
    const route = `${req.method.toUpperCase()} ${req.path}`;
    try {
      if (route === 'GET /v1/account') return { status: 200, body: { ok: true, account: await authority.refreshDay() } };
      if (!key || typeof key !== 'string') return fail('invalid_request');
      if (route === 'POST /v1/purchase') return reply(await authority.purchase(String(body.skinId ?? ''), key));
      if (route === 'POST /v1/equip') {
        const itemId = body.itemId === null ? null : String(body.itemId ?? '');
        return reply(await authority.equip(body.category as SkinCategory, String(body.target ?? ''), itemId, key));
      }
      if (route === 'POST /v1/match-results') {
        if (!this.options.trustClientResults) return fail('unverified');
        return reply(await authority.submitMatchResult(body.result as MatchResult));
      }
      const claim = /^POST \/v1\/missions\/([\w.-]+)\/claim$/.exec(route);
      if (claim) return reply(await authority.claimMission(claim[1], key));
      return { status: 404, body: { ok: false, error: 'invalid_request' } };
    } catch {
      return fail('storage_error');
    }
  }

  private async authority(accountId: string): Promise<EconomyAuthority> {
    let a = this.authorities.get(accountId);
    if (!a) {
      a = new EconomyAuthority(this.repoFor(accountId), this.clock, () => accountId);
      this.authorities.set(accountId, a);
      await a.init();
    }
    return a;
  }
}

function reply(r: EconomyResult): ApiResponse {
  return r.ok ? { status: 200, body: { ok: true, account: r.account, value: r.value } } : { status: STATUS[r.error] ?? 422, body: { ok: false, error: r.error, account: r.account } };
}

function fail(error: EconomyError): ApiResponse {
  return { status: STATUS[error] ?? 422, body: { ok: false, error } };
}
