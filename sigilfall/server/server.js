/* =============================================================================
   SIGILFALL server: static files plus the websocket match service at /ws.
     npm install && npm start      ->  http://localhost:8080
   ========================================================================= */
import http from 'http';
import os from 'os';
import { WebSocketServer } from 'ws';
import { serveStatic } from './static.js';
import { Hub } from './hub.js';

const PORT = Number(process.env.PORT) || 8080;

const server = http.createServer((req, res) => { serveStatic(req, res); });
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 24 * 1024 });
const hub = new Hub();

wss.on('connection', (ws, req) => {
  const client = hub.connect(ws, req);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data) => hub.receive(client, data));
  ws.on('close', () => hub.disconnect(client));
  ws.on('error', () => {});
});

// drop sockets that stopped answering (closed lids, dead wifi)
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { /* closing */ }
  }
}, 15000);

// room simulation runs at a steady 20 Hz
const ticker = setInterval(() => hub.tick(), 50);

server.listen(PORT, () => {
  console.log('SIGILFALL server up');
  console.log('  local    : http://localhost:' + PORT);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) console.log('  same wifi: http://' + a.address + ':' + PORT);
    }
  }
});

function shutdown() {
  clearInterval(heartbeat);
  clearInterval(ticker);
  for (const ws of wss.clients) try { ws.close(); } catch (e) { /* already gone */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 800).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { server, hub };
