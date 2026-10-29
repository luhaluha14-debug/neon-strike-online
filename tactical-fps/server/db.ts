import pg from 'pg';
import type { ServerConfig } from './config';

// PostgreSQL access: one pool, transactions, start-up retry. Every query
// in server/ goes through `client.query(text, params)` with `$n`
// placeholders: values are never put into SQL text.

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(config: Pick<ServerConfig, 'databaseUrl' | 'dbPoolMax'>): Db {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.dbPoolMax,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30_000,
    // A request never waits on the database forever.
    statement_timeout: 10_000,
    query_timeout: 15_000,
    application_name: 'grid-account',
  });
  // An idle client losing its connection must not crash the process: the pool drops it.
  pool.on('error', (err) => console.error('[db] idle client error:', describeDbError(err)));
  return pool;
}

/** Runs `fn` in one transaction: committed if it returns, rolled back (and rethrown) if it throws. */
export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Waits for the database at start-up (exponential back-off), then gives up with the last error. */
export async function waitForDb(db: Db, attempts = 5, firstDelayMs = 500): Promise<void> {
  let delay = firstDelayMs;
  for (let i = 1; ; i++) {
    try {
      await db.query('SELECT 1');
      return;
    } catch (err) {
      if (i >= attempts) throw err;
      console.warn(`[db] not reachable (attempt ${i}/${attempts}): ${describeDbError(err)}; retrying in ${delay} ms`);
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    }
  }
}

export async function dbHealthy(db: Db): Promise<boolean> {
  try {
    await db.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/**
 * Loggable description of a database error: code and message only. Never
 * the connection string, query parameters or a constraint's `detail`
 * (which can quote stored values).
 */
export function describeDbError(err: unknown): string {
  const e = err as { code?: string; message?: string } | null;
  const msg = (e?.message ?? String(err)).replace(/postgres(ql)?:\/\/\S+/gi, '<db-url>');
  return e?.code ? `${e.code} ${msg}` : msg;
}

/** Postgres unique_violation. */
export function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505';
}
