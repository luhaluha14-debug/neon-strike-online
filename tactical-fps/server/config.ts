// Server settings, from environment variables only (never from the client
// bundle, never logged). DATABASE_URL is the one required value.

export interface ServerConfig {
  databaseUrl: string;
  port: number;
  host: string;
  /** Built game client served on `/` (null = API only). */
  staticDir: string | null;
  /** `Secure` session cookies (HTTPS only): on in production. */
  cookieSecure: boolean;
  sessionTtlMs: number;
  /** Time zone of the daily mission day. */
  missionTimeZone: string;
  /** Behind one reverse proxy (Render): the client IP is the last X-Forwarded-For entry. */
  trustProxy: boolean;
  /** Pool size. */
  dbPoolMax: number;
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const production = env.NODE_ENV === 'production';
  const databaseUrl = env.DATABASE_URL ?? '';
  if (!databaseUrl) throw new ConfigError('DATABASE_URL is not set');
  const int = (name: string, fallback: number, min: number, max: number) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`${name} must be an integer in ${min}..${max}`);
    return n;
  };
  const bool = (name: string, fallback: boolean) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    throw new ConfigError(`${name} must be true or false`);
  };
  const missionTimeZone = env.GRID_MISSION_TZ || 'Asia/Seoul';
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: missionTimeZone });
  } catch {
    throw new ConfigError('GRID_MISSION_TZ is not a valid time zone');
  }
  return {
    databaseUrl,
    port: int('PORT', 8080, 0, 65535),
    host: env.HOST || '0.0.0.0',
    staticDir: env.GRID_STATIC_DIR === '' ? null : (env.GRID_STATIC_DIR ?? 'dist'),
    cookieSecure: bool('GRID_COOKIE_SECURE', production),
    sessionTtlMs: int('GRID_SESSION_TTL_HOURS', 24 * 7, 1, 24 * 90) * 3600_000,
    missionTimeZone,
    trustProxy: bool('GRID_TRUST_PROXY', production),
    dbPoolMax: int('GRID_DB_POOL_MAX', 10, 1, 100),
  };
}

/** Mission day ("YYYY-MM-DD") of `at` in `timeZone` (server clock, never the client's). */
export function missionDay(timeZone: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}
