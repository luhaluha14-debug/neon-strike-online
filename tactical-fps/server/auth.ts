import { randomUUID } from 'node:crypto';
import { STARTING_CREDITS } from '../src/economy/EconomyRules';
import { signupProblem, USERNAME_PATTERN, PASSWORD_MAX, type AccountSummary, type AuthError } from '../src/economy/AccountProtocol';
import { isUniqueViolation, withTx, type Db, type Tx } from './db';
import { dummyHash, hashPassword, newSessionToken, tokenHash, verifyPassword } from './passwords';

// Sign-up, sign-in, sign-out and session lookup. The account of a request
// comes only from its session cookie, never from the request body.

export const LOGIN_WINDOW_MINUTES = 15;
export const LOGIN_MAX_FAILURES_PER_USER = 5;
export const LOGIN_MAX_FAILURES_PER_IP = 30;
export const SIGNUPS_PER_IP_PER_HOUR = 10;

export type AuthOutcome = { ok: true; account: AccountSummary; token: string; expiresAt: Date } | { ok: false; error: AuthError };

export interface SessionAccount {
  accountId: string;
  status: 'active' | 'suspended';
}

export async function audit(db: Db | Tx, accountId: string | null, event: string, ip: string | null, detail: Record<string, unknown> = {}): Promise<void> {
  await db.query('INSERT INTO audit_log (account_id, event, ip, detail) VALUES ($1, $2, $3, $4)', [accountId, event, ip, JSON.stringify(detail)]);
}

export async function signup(db: Db, username: unknown, password: unknown, ip: string, ttlMs: number): Promise<AuthOutcome> {
  const problem = signupProblem(username, password);
  if (problem) return { ok: false, error: problem };
  const name = (username as string).toLowerCase();
  const recent = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM audit_log WHERE event = 'signup' AND ip = $1 AND at > now() - interval '1 hour'`,
    [ip],
  );
  if (Number(recent.rows[0].n) >= SIGNUPS_PER_IP_PER_HOUR) return { ok: false, error: 'rate_limited' };
  const hash = await hashPassword(password as string);
  const accountId = randomUUID();
  const session = newSessionToken();
  const expiresAt = new Date(Date.now() + ttlMs);
  try {
    await withTx(db, async (tx) => {
      await tx.query('INSERT INTO accounts (account_id, username, username_lower, password_hash, credits) VALUES ($1, $2, $3, $4, $5)', [accountId, name, name, hash, STARTING_CREDITS]);
      await tx.query('INSERT INTO profiles (account_id, display_name) VALUES ($1, $2)', [accountId, name]);
      if (STARTING_CREDITS > 0)
        await tx.query(`INSERT INTO credit_ledger (tx_id, account_id, kind, amount, balance_after, ref) VALUES ($1, $2, 'grant', $3, $3, 'starting_credits')`, [randomUUID(), accountId, STARTING_CREDITS]);
      await tx.query('INSERT INTO sessions (token_hash, account_id, expires_at) VALUES ($1, $2, $3)', [session.hash, accountId, expiresAt]);
      await audit(tx, accountId, 'signup', ip);
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, error: 'username_taken' };
    throw err;
  }
  return { ok: true, account: { accountId, username: name, displayName: name, status: 'active' }, token: session.token, expiresAt };
}

export async function login(db: Db, username: unknown, password: unknown, ip: string, ttlMs: number): Promise<AuthOutcome> {
  if (typeof username !== 'string' || typeof password !== 'string' || username.length > 64 || password.length > PASSWORD_MAX) return { ok: false, error: 'invalid_credentials' };
  const name = username.toLowerCase();
  const fails = await db.query<{ user_fails: string; ip_fails: string }>(
    `SELECT
       count(*) FILTER (WHERE username_lower = $1) AS user_fails,
       count(*) FILTER (WHERE ip = $2) AS ip_fails
     FROM login_attempts
     WHERE NOT success AND at > now() - make_interval(mins => $3) AND (username_lower = $1 OR ip = $2)`,
    [name, ip, LOGIN_WINDOW_MINUTES],
  );
  const { user_fails, ip_fails } = fails.rows[0];
  if (Number(user_fails) >= LOGIN_MAX_FAILURES_PER_USER || Number(ip_fails) >= LOGIN_MAX_FAILURES_PER_IP) {
    await audit(db, null, 'login_rate_limited', ip, { username: name });
    return { ok: false, error: 'rate_limited' };
  }
  const found = USERNAME_PATTERN.test(name)
    ? await db.query<{ account_id: string; username: string; password_hash: string; status: 'active' | 'suspended'; display_name: string }>(
        `SELECT a.account_id, a.username, a.password_hash, a.status, p.display_name
         FROM accounts a JOIN profiles p USING (account_id) WHERE a.username_lower = $1`,
        [name],
      )
    : { rows: [] };
  const row = found.rows[0];
  // Same work whether or not the user exists (no user-name probing by timing).
  const good = await verifyPassword(password, row?.password_hash ?? (await dummyHash()));
  if (!row || !good) {
    await db.query('INSERT INTO login_attempts (username_lower, ip, success) VALUES ($1, $2, false)', [name.slice(0, 64), ip]);
    await audit(db, row?.account_id ?? null, 'login_failed', ip, { username: name.slice(0, 64) });
    return { ok: false, error: 'invalid_credentials' };
  }
  if (row.status !== 'active') {
    await audit(db, row.account_id, 'login_refused_suspended', ip);
    return { ok: false, error: 'suspended' };
  }
  const session = newSessionToken();
  const expiresAt = new Date(Date.now() + ttlMs);
  await withTx(db, async (tx) => {
    await tx.query('INSERT INTO sessions (token_hash, account_id, expires_at) VALUES ($1, $2, $3)', [session.hash, row.account_id, expiresAt]);
    await tx.query('INSERT INTO login_attempts (username_lower, ip, success) VALUES ($1, $2, true)', [name, ip]);
    await audit(tx, row.account_id, 'login', ip);
  });
  return { ok: true, account: { accountId: row.account_id, username: row.username, displayName: row.display_name, status: row.status }, token: session.token, expiresAt };
}

export async function logout(db: Db, token: string | null, ip: string): Promise<void> {
  if (!token) return;
  const r = await db.query<{ account_id: string }>('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL RETURNING account_id', [tokenHash(token)]);
  if (r.rows[0]) await audit(db, r.rows[0].account_id, 'logout', ip);
}

/** The account of a live (unexpired, not revoked) session, or null. */
export async function sessionAccount(db: Db, token: string | null): Promise<SessionAccount | null> {
  if (!token || token.length > 100) return null;
  const r = await db.query<{ account_id: string; status: 'active' | 'suspended' }>(
    `SELECT s.account_id, a.status FROM sessions s JOIN accounts a USING (account_id)
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [tokenHash(token)],
  );
  const row = r.rows[0];
  return row ? { accountId: row.account_id, status: row.status } : null;
}

export async function accountSummary(db: Db, accountId: string): Promise<AccountSummary | null> {
  const r = await db.query<{ account_id: string; username: string; status: 'active' | 'suspended'; display_name: string }>(
    'SELECT a.account_id, a.username, a.status, p.display_name FROM accounts a JOIN profiles p USING (account_id) WHERE a.account_id = $1',
    [accountId],
  );
  const row = r.rows[0];
  return row ? { accountId: row.account_id, username: row.username, displayName: row.display_name, status: row.status } : null;
}

/** Housekeeping: drops long-expired sessions, old login attempts and idempotency keys. */
export async function pruneAuthData(db: Db): Promise<void> {
  await db.query(`DELETE FROM sessions WHERE expires_at < now() - interval '30 days' OR revoked_at < now() - interval '30 days'`);
  await db.query(`DELETE FROM login_attempts WHERE at < now() - interval '1 day'`);
  await db.query(`DELETE FROM idempotency_keys WHERE created_at < now() - interval '7 days'`);
}
