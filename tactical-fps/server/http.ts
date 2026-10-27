import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { ACCOUNT_SERVICE, CSRF_HEADER, type AuthError } from '../src/economy/AccountProtocol';
import { accountSummary, login, logout, sessionAccount, signup } from './auth';
import { missionDay, type ServerConfig } from './config';
import { dbHealthy, describeDbError, type Db } from './db';
import { claimMission, equip, loadAccount, purchase, type EconomyAnswer, type RequestContext } from './economyDb';

// HTTP layer: routes, JSON bodies, cookies, CSRF check, static files.
// Logs carry method, path, status and time only: no bodies, cookies,
// tokens or passwords.

export const SESSION_COOKIE = 'grid_session';
const BODY_LIMIT = 16 * 1024;

export interface AppOptions {
  db: Db;
  config: Pick<ServerConfig, 'cookieSecure' | 'sessionTtlMs' | 'missionTimeZone' | 'trustProxy' | 'staticDir'>;
  /** Mission day source (tests pin it); default: the server clock in the configured time zone. */
  day?: () => string;
  log?: (line: string) => void;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

type Json = Record<string, unknown>;

export function createApp(opts: AppOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const { db, config } = opts;
  const day = opts.day ?? (() => missionDay(config.missionTimeZone));
  const log = opts.log ?? ((line: string) => console.log(line));
  const staticRoot = config.staticDir ? resolve(config.staticDir) : null;

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}) => {
    const data = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(data), ...headers });
    res.end(data);
  };

  const cookie = (token: string, maxAgeSeconds: number) =>
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${config.cookieSecure ? '; Secure' : ''}`;

  const clientIp = (req: IncomingMessage): string => {
    if (config.trustProxy) {
      const fwd = req.headers['x-forwarded-for'];
      const list = (Array.isArray(fwd) ? fwd.join(',') : (fwd ?? '')).split(',').map((s) => s.trim()).filter(Boolean);
      // The proxy appends the address it saw: the last entry is the one a client cannot forge.
      if (list.length) return list[list.length - 1].slice(0, 64);
    }
    return (req.socket.remoteAddress ?? 'unknown').slice(0, 64);
  };

  async function api(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const method = req.method ?? 'GET';
    if (path === '/api/health' && method === 'GET') {
      const up = await dbHealthy(db);
      return send(res, up ? 200 : 503, { service: ACCOUNT_SERVICE, db: up ? 'up' : 'down' });
    }
    if (method !== 'GET') checkCsrf(req);
    const ip = clientIp(req);
    const token = readCookie(req, SESSION_COOKIE);

    if (path === '/api/auth/signup' && method === 'POST') {
      const body = await readJson(req);
      const r = await signup(db, body.username, body.password, ip, config.sessionTtlMs);
      if (!r.ok) return send(res, authStatus(r.error), { ok: false, error: r.error });
      return send(res, 201, { ok: true, account: r.account }, { 'set-cookie': cookie(r.token, Math.floor(config.sessionTtlMs / 1000)) });
    }
    if (path === '/api/auth/login' && method === 'POST') {
      const body = await readJson(req);
      const r = await login(db, body.username, body.password, ip, config.sessionTtlMs);
      if (!r.ok) return send(res, authStatus(r.error), { ok: false, error: r.error });
      return send(res, 200, { ok: true, account: r.account }, { 'set-cookie': cookie(r.token, Math.floor(config.sessionTtlMs / 1000)) });
    }
    if (path === '/api/auth/logout' && method === 'POST') {
      await logout(db, token, ip);
      return send(res, 200, { ok: true }, { 'set-cookie': cookie('', 0) });
    }

    // Everything below needs a live session; the account is the session's, never one named by the client.
    const session = await sessionAccount(db, token);
    // "Who am I" is not an error when signed out (no failed request in the browser console on every visit).
    if (path === '/api/auth/me' && method === 'GET' && (!session || session.status !== 'active'))
      return send(res, 200, { ok: true, account: null }, token && !session ? { 'set-cookie': cookie('', 0) } : {});
    if (!session) return send(res, 401, { ok: false, error: 'unauthenticated' }, token ? { 'set-cookie': cookie('', 0) } : {});
    if (session.status !== 'active') return send(res, 403, { ok: false, error: 'suspended' });

    if (path === '/api/auth/me' && method === 'GET') {
      return send(res, 200, { ok: true, account: await accountSummary(db, session.accountId) });
    }
    if (path === '/api/account' && method === 'GET') {
      return send(res, 200, { ok: true, account: await loadAccount(db, session.accountId, day()) });
    }
    if (path === '/api/match-results' && method === 'POST') {
      // No trusted match verification exists yet: a client report never pays.
      await readJson(req);
      return send(res, 403, { ok: false, error: 'unverified', account: await loadAccount(db, session.accountId, day()) });
    }
    const key = req.headers['idempotency-key'];
    const ctx: RequestContext = { accountId: session.accountId, key: typeof key === 'string' ? key : '', day: day(), ip };
    if (path === '/api/purchase' && method === 'POST') {
      const body = await readJson(req);
      return answer(res, await purchase(db, ctx, body.skinId));
    }
    if (path === '/api/equip' && method === 'POST') {
      const body = await readJson(req);
      return answer(res, await equip(db, ctx, body.category, body.target, body.itemId === undefined ? '' : body.itemId));
    }
    const claim = /^\/api\/missions\/([a-z0-9_.-]{1,40})\/claim$/.exec(path);
    if (claim && method === 'POST') {
      await readJson(req);
      return answer(res, await claimMission(db, ctx, claim[1]));
    }
    throw new HttpError(404, 'not_found');
  }

  function answer(res: ServerResponse, a: EconomyAnswer): void {
    send(res, a.status, a.body);
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    if (!staticRoot || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
    let rel: string;
    try {
      rel = normalize(decodeURIComponent(path)).replace(/^([/\\])+/, '');
    } catch {
      return false;
    }
    let file = join(staticRoot, rel);
    if (file !== staticRoot && !file.startsWith(staticRoot + sep)) return false;
    let info = await stat(file).catch(() => null);
    if (info?.isDirectory()) {
      file = join(file, 'index.html');
      info = await stat(file).catch(() => null);
    }
    if (!info?.isFile()) {
      // Client-side routes fall back to the game page; missing assets stay 404.
      if (rel.startsWith('assets') || extname(rel)) return false;
      file = join(staticRoot, 'index.html');
      info = await stat(file).catch(() => null);
      if (!info?.isFile()) return false;
    }
    const top = rel.split(/[/\\]/)[0];
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': info.size,
      // Same caching as the static site (render.yaml): hashed bundles forever, map files a day.
      'cache-control': top === 'assets' ? 'public, max-age=31536000, immutable' : top === 'maps' ? 'public, max-age=86400' : 'no-cache',
    });
    if (req.method === 'HEAD') res.end();
    else createReadStream(file).pipe(res);
    return true;
  }

  return (req, res) => {
    const started = Date.now();
    const path = (req.url ?? '/').split('?')[0];
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'same-origin');
    res.setHeader('x-frame-options', 'DENY');
    res.on('finish', () => {
      if (path.startsWith('/api/')) log(`${req.method} ${path} ${res.statusCode} ${Date.now() - started}ms`);
    });
    const done = (async () => {
      if (path.startsWith('/api/')) return api(req, res, path);
      if (await serveStatic(req, res, path)) return;
      throw new HttpError(404, 'not_found');
    })();
    done.catch((err: unknown) => {
      if (res.headersSent) return void res.destroy();
      if (err instanceof HttpError) return send(res, err.status, { ok: false, error: err.code });
      // Database or unexpected error: nothing was committed (each change is one transaction).
      log(`[error] ${req.method} ${path}: ${describeDbError(err)}`);
      send(res, 503, { ok: false, error: 'storage_error' });
    });
  };
}

function authStatus(error: AuthError): number {
  switch (error) {
    case 'invalid_credentials':
      return 401;
    case 'rate_limited':
      return 429;
    case 'suspended':
      return 403;
    case 'username_taken':
      return 409;
    default:
      return 400;
  }
}

/** Changing requests must come from the game page itself: the custom header plus, when sent, a same-host Origin. */
function checkCsrf(req: IncomingMessage): void {
  if (req.headers[CSRF_HEADER] !== '1') throw new HttpError(403, 'csrf');
  const origin = req.headers.origin;
  if (origin) {
    let host: string;
    try {
      host = new URL(origin).host;
    } catch {
      throw new HttpError(403, 'csrf');
    }
    const expected = req.headers.host;
    if (host !== expected) throw new HttpError(403, 'csrf');
  }
}

function readCookie(req: IncomingMessage, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      const v = part.slice(i + 1).trim();
      return v && /^[A-Za-z0-9_-]+$/.test(v) ? v : null;
    }
  }
  return null;
}

async function readJson(req: IncomingMessage): Promise<Json> {
  const type = req.headers['content-type'] ?? '';
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new HttpError(413, 'too_large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  if (!type.startsWith('application/json')) throw new HttpError(415, 'invalid_request');
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v as Json;
  } catch {
    throw new HttpError(400, 'invalid_request');
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.ktx2': 'image/ktx2',
  '.hdr': 'application/octet-stream',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};
