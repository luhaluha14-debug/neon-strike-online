import { createServer } from 'node:http';
import { pruneAuthData } from './auth';
import { ConfigError, loadConfig } from './config';
import { createPool, describeDbError, waitForDb } from './db';
import { createApp } from './http';
import { migrate } from './migrations';

// GRID account server: serves the built game (dist/) and the account API
// (/api/*) on one origin, backed by PostgreSQL. Start: `npm run start`
// after `npm run build && npm run build:server`.

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createPool(config);
  await waitForDb(db);
  const applied = await migrate(db);
  console.log(applied.length ? `[db] migrations applied: ${applied.join(', ')}` : '[db] schema up to date');

  const server = createServer(createApp({ db, config }));
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 30_000;
  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
  const addr = server.address();
  console.log(`[grid] listening on ${typeof addr === 'object' && addr ? `${addr.address}:${addr.port}` : config.port}`);

  const prune = setInterval(() => void pruneAuthData(db).catch((err) => console.warn('[db] prune failed:', describeDbError(err))), 3600_000);
  prune.unref();

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[grid] ${signal}: closing`);
    clearInterval(prune);
    // Stop accepting, let open requests finish, then close the pool.
    server.close(() => {
      db.end().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
    server.closeIdleConnections();
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

main().catch((err) => {
  console.error(err instanceof ConfigError ? `[config] ${err.message}` : `[grid] start failed: ${describeDbError(err)}`);
  process.exit(1);
});
