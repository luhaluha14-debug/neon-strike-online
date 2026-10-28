import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { MAX_MESSAGE, MP_PATH, MP_SERVICE, type ClientMessage, type ServerMessage } from '../../src/net/Protocol';
import { createStaticHandler } from '../static';
import { Rooms } from './rooms';

// Multiplayer relay: serves the built game and a WebSocket at /mp. Rooms and
// routing live in rooms.ts; this file is the sockets, limits and logs. Logs
// carry counts and error codes only, never game payloads or names.

export interface MpServerOptions {
  staticDir: string | null;
  /** Extra page origins allowed to connect (the static site); the server's own origin always is. */
  allowedOrigins?: readonly string[];
  log?: (line: string) => void;
  /** Messages per second per connection (burst = 1 s worth). */
  rate?: number;
  heartbeatMs?: number;
}

export interface MpServer {
  http: Server;
  rooms: Rooms;
  close(): Promise<void>;
}

export function createMpServer(opts: MpServerOptions): MpServer {
  const log = opts.log ?? ((l: string) => console.log(l));
  const rate = opts.rate ?? 120;
  const rooms = new Rooms();
  const serveStatic = createStaticHandler(opts.staticDir);
  const sockets = new Map<string, WebSocket>();
  const allowed = new Set((opts.allowedOrigins ?? []).map((o) => o.replace(/\/$/, '')));

  const http = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    res.setHeader('x-content-type-options', 'nosniff');
    if (path === `${MP_PATH}/health`) {
      const body = JSON.stringify({ service: MP_SERVICE, rooms: rooms.roomCount, players: rooms.clientCount });
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
      res.end(body);
      return;
    }
    serveStatic(req, res, path)
      .then((done) => {
        if (!done) {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('not found');
        }
      })
      .catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
  });

  const wss = new WebSocketServer({
    server: http,
    path: MP_PATH,
    maxPayload: MAX_MESSAGE,
    perMessageDeflate: false,
    verifyClient: ({ origin, req }: { origin: string; req: { headers: { host?: string } } }) => {
      if (!origin) return true; // not a browser page (tools, tests)
      try {
        const o = new URL(origin);
        return o.host === req.headers.host || allowed.has(o.origin);
      } catch {
        return false;
      }
    },
  });

  const send = (to: string, msg: ServerMessage) => {
    const ws = sockets.get(to);
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const deliver = (out: ReturnType<Rooms['handle']>) => {
    for (const o of out) send(o.to, o.msg);
  };

  wss.on('connection', (ws) => {
    const id = rooms.connect();
    if (!id) {
      ws.send(JSON.stringify({ t: 'error', error: 'server_full' } satisfies ServerMessage));
      ws.close(1013, 'full');
      return;
    }
    sockets.set(id, ws);
    let tokens = rate;
    let last = Date.now();
    let alive = true;
    ws.on('pong', () => (alive = true));
    (ws as WebSocket & { heartbeat?: () => boolean }).heartbeat = () => {
      if (!alive) return false;
      alive = false;
      ws.ping();
      return true;
    };
    ws.on('message', (data, isBinary) => {
      const now = Date.now();
      tokens = Math.min(rate, tokens + ((now - last) / 1000) * rate);
      last = now;
      if (tokens < 1) {
        send(id, { t: 'error', error: 'rate' });
        return;
      }
      tokens -= 1;
      if (isBinary) return;
      let m: ClientMessage;
      try {
        m = JSON.parse(data.toString()) as ClientMessage;
      } catch {
        send(id, { t: 'error', error: 'bad_request' });
        return;
      }
      deliver(rooms.handle(id, m));
    });
    ws.on('close', () => {
      sockets.delete(id);
      deliver(rooms.disconnect(id));
    });
    ws.on('error', () => ws.terminate());
  });

  // Dead connections (no pong) are dropped, which also hands their room to the next host.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const hb = (ws as WebSocket & { heartbeat?: () => boolean }).heartbeat;
      if (hb && !hb()) ws.terminate();
    }
  }, opts.heartbeatMs ?? 15_000);
  heartbeat.unref();

  const stats = setInterval(() => {
    if (rooms.clientCount) log(`[mp] ${rooms.clientCount} connected, ${rooms.roomCount} rooms`);
  }, 60_000);
  stats.unref();

  return {
    http,
    rooms,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(heartbeat);
        clearInterval(stats);
        for (const ws of wss.clients) ws.terminate();
        wss.close();
        http.closeAllConnections?.();
        http.close(() => resolve());
      }),
  };
}
