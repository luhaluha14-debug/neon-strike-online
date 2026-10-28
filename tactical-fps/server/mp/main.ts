import { createMpServer } from './server';

// Multiplayer relay entry (npm run start:mp after npm run build && npm run build:mp).
// Settings: PORT (8080), GRID_STATIC_DIR (dist; empty = API only),
// GRID_MP_ORIGINS (comma-separated page origins allowed besides this server's own).

const port = Number(process.env.PORT ?? 8080);
const staticDir = process.env.GRID_STATIC_DIR === '' ? null : (process.env.GRID_STATIC_DIR ?? 'dist');
const allowedOrigins = (process.env.GRID_MP_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const server = createMpServer({ staticDir, allowedOrigins });
server.http.listen(port, '0.0.0.0', () => console.log(`[mp] listening on ${port}`));

let stopping = false;
const stop = (signal: string) => {
  if (stopping) return;
  stopping = true;
  console.log(`[mp] ${signal}: closing`);
  void server.close().then(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
