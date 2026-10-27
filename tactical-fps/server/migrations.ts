import type { Db } from './db';

// Schema migrations, applied in order at start-up. Each runs in its own
// transaction under an advisory lock (two instances starting together
// apply it once). Never edit an applied migration: add a new one.

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'init',
    sql: `
CREATE TABLE accounts (
  account_id     uuid PRIMARY KEY,
  username       text NOT NULL,
  username_lower text NOT NULL UNIQUE,
  password_hash  text NOT NULL,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  credits        bigint NOT NULL CHECK (credits >= 0),
  revision       bigint NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (username_lower = lower(username))
);

CREATE TABLE profiles (
  account_id   uuid PRIMARY KEY REFERENCES accounts (account_id) ON DELETE CASCADE,
  display_name text NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Session tokens are stored as SHA-256 hashes only.
CREATE TABLE sessions (
  token_hash   bytea PRIMARY KEY CHECK (length(token_hash) = 32),
  account_id   uuid NOT NULL REFERENCES accounts (account_id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz
);
CREATE INDEX sessions_account_idx ON sessions (account_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- One instance per skin per account.
CREATE TABLE inventory_items (
  item_id     uuid PRIMARY KEY,
  account_id  uuid NOT NULL REFERENCES accounts (account_id) ON DELETE CASCADE,
  skin_id     text NOT NULL,
  source      text NOT NULL CHECK (source IN ('purchase', 'grant', 'trade')),
  acquired_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, skin_id),
  UNIQUE (account_id, item_id)
);

-- The equipped item must belong to the same account (composite foreign key).
CREATE TABLE loadout (
  account_id uuid NOT NULL REFERENCES accounts (account_id) ON DELETE CASCADE,
  slot       text NOT NULL,
  item_id    uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, slot),
  FOREIGN KEY (account_id, item_id) REFERENCES inventory_items (account_id, item_id) ON DELETE CASCADE
);

-- Append-only credit ledger.
CREATE TABLE credit_ledger (
  tx_id         uuid PRIMARY KEY,
  seq           bigserial NOT NULL,
  account_id    uuid NOT NULL REFERENCES accounts (account_id) ON DELETE CASCADE,
  at            timestamptz NOT NULL DEFAULT now(),
  kind          text NOT NULL CHECK (kind IN ('purchase', 'match_reward', 'mission_reward', 'grant')),
  amount        bigint NOT NULL,
  balance_after bigint NOT NULL CHECK (balance_after >= 0),
  ref           text NOT NULL,
  -- Mission rewards: the mission day (the same mission pays again on another day).
  scope         text NOT NULL DEFAULT '',
  request_key   text
);
CREATE INDEX credit_ledger_account_idx ON credit_ledger (account_id, seq);
-- A reward or grant is paid at most once.
CREATE UNIQUE INDEX credit_ledger_once_idx ON credit_ledger (account_id, kind, ref, scope)
  WHERE kind IN ('match_reward', 'mission_reward', 'grant');

-- Idempotency keys: a resent request returns the stored answer.
CREATE TABLE idempotency_keys (
  account_id   uuid NOT NULL REFERENCES accounts (account_id) ON DELETE CASCADE,
  key          text NOT NULL CHECK (length(key) BETWEEN 8 AND 100),
  endpoint     text NOT NULL,
  request_hash text NOT NULL,
  status_code  int,
  response     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, key)
);
CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);

CREATE TABLE missions (
  account_id uuid NOT NULL REFERENCES accounts (account_id) ON DELETE CASCADE,
  day        date NOT NULL,
  mission_id text NOT NULL,
  progress   int NOT NULL DEFAULT 0 CHECK (progress >= 0),
  completed  boolean NOT NULL DEFAULT false,
  claimed    boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, day, mission_id),
  CHECK (NOT claimed OR completed)
);

-- Events (match ids) already counted for missions that day.
CREATE TABLE mission_events (
  account_id uuid NOT NULL REFERENCES accounts (account_id) ON DELETE CASCADE,
  day        date NOT NULL,
  event_id   text NOT NULL,
  at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, day, event_id)
);

-- Verified match results, settled once.
CREATE TABLE match_rewards (
  account_id uuid NOT NULL REFERENCES accounts (account_id) ON DELETE CASCADE,
  match_id   text NOT NULL,
  mode       text NOT NULL,
  outcome    text NOT NULL,
  credits    int NOT NULL CHECK (credits >= 0),
  settled_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, match_id)
);

-- Security / economy events. Never passwords, tokens or cookies.
CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  account_id uuid REFERENCES accounts (account_id) ON DELETE SET NULL,
  event      text NOT NULL,
  ip         text,
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_log_account_idx ON audit_log (account_id, at);
CREATE INDEX audit_log_event_ip_idx ON audit_log (event, ip, at);

CREATE TABLE login_attempts (
  id             bigserial PRIMARY KEY,
  at             timestamptz NOT NULL DEFAULT now(),
  username_lower text NOT NULL,
  ip             text NOT NULL,
  success        boolean NOT NULL
);
CREATE INDEX login_attempts_user_idx ON login_attempts (username_lower, at);
CREATE INDEX login_attempts_ip_idx ON login_attempts (ip, at);
`,
  },
];

const LOCK_ID = 7_420_031; // pg_advisory_lock key of GRID migrations

/** Applies every migration not yet applied. Returns the versions applied now. */
export async function migrate(db: Db, migrations: readonly Migration[] = MIGRATIONS): Promise<number[]> {
  const client = await db.connect();
  const applied: number[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version    int PRIMARY KEY,
      name       text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const done = new Set((await client.query<{ version: number }>('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
    for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
      if (done.has(m.version)) continue;
      try {
        await client.query('BEGIN');
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [m.version, m.name]);
        await client.query('COMMIT');
        applied.push(m.version);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
    client.release();
  }
  return applied;
}
