// Multiplayer relay (server/mp): rooms without sockets (quick join, codes,
// capacity, host hand-over, routing rules) and the real WebSocket server
// (health, version / name checks, routing with stamped senders, a host
// leaving, origins, message size and rate limits, the game page).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import WebSocket from 'ws';
import { ROOT } from './harness.mjs';

let vite;
let M;
let srv;
let url;
let staticDir;

before(async () => {
  vite = await createServer({ root: ROOT, logLevel: 'error', server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom' });
  M = { ...(await vite.ssrLoadModule('/server/mp/rooms.ts')), ...(await vite.ssrLoadModule('/server/mp/server.ts')), ...(await vite.ssrLoadModule('/src/net/Protocol.ts')) };
  staticDir = mkdtempSync(join(tmpdir(), 'grid-mp-static-'));
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>GRID</title>');
  srv = M.createMpServer({ staticDir, allowedOrigins: ['https://static.example'], log: () => {}, rate: 50, heartbeatMs: 200 });
  await new Promise((r) => srv.http.listen(0, '127.0.0.1', r));
  url = `127.0.0.1:${srv.http.address().port}`;
});
after(async () => {
  await srv?.close();
  await vite?.close();
  if (staticDir) rmSync(staticDir, { recursive: true, force: true });
});

// --- rooms (no sockets) -----------------------------------------------------------

function world(codes = ['AAAAA', 'BBBBB', 'CCCCC', 'DDDDD', 'EEEEE']) {
  let i = 0;
  const rooms = new M.Rooms(() => codes[i++ % codes.length]);
  const hi = (name = 'p') => {
    const id = rooms.connect();
    rooms.handle(id, { t: 'hello', v: M.MP_PROTOCOL, name });
    return id;
  };
  return { rooms, hi };
}

test('rooms: quick join fills one room per mode up to its capacity, then opens another; create always opens a new one', () => {
  const { rooms, hi } = world();
  const ids = Array.from({ length: 9 }, (_, i) => hi(`n${i}`));
  for (const id of ids) rooms.handle(id, { t: 'quick', mode: 'deathmatch', map: 'warehouse' });
  const codes = ids.map((id) => rooms.roomOf(id).code);
  assert.deepEqual(codes, [...Array(8).fill('AAAAA'), 'BBBBB'], '8 per deathmatch room');
  const t = hi('teamer');
  rooms.handle(t, { t: 'quick', mode: 'team', map: 'seoul' });
  assert.equal(rooms.roomOf(t).code, 'CCCCC', 'team rooms are separate');
  assert.equal(rooms.roomOf(t).capacity, 10);
  const c = hi('creator');
  rooms.handle(c, { t: 'create', mode: 'deathmatch', map: 'warehouse' });
  assert.equal(rooms.roomOf(c).code, 'DDDDD');
  assert.equal(rooms.roomOf(c).hostId, c);
});

test('rooms: join by code (any case), full rooms refuse, unknown codes refuse; nothing before hello', () => {
  const { rooms, hi } = world();
  const anon = rooms.connect();
  assert.deepEqual(rooms.handle(anon, { t: 'quick', mode: 'team', map: 'seoul' }), [{ to: anon, msg: { t: 'error', error: 'name' } }]);
  assert.equal(rooms.handle(anon, { t: 'hello', v: 999, name: 'x' })[0].msg.error, 'version');
  assert.equal(rooms.handle(anon, { t: 'hello', v: M.MP_PROTOCOL, name: '   ' })[0].msg.error, 'name');
  const host = hi('host');
  rooms.handle(host, { t: 'create', mode: 'deathmatch', map: 'warehouse' });
  const out = [];
  for (let i = 0; i < 7; i++) {
    const id = hi(`g${i}`);
    out.push(rooms.handle(id, { t: 'join', code: 'aaaaa' }));
  }
  assert.ok(out.every((o) => o[0].msg.t === 'room'));
  const late = hi('late');
  assert.equal(rooms.handle(late, { t: 'join', code: 'AAAAA' })[0].msg.error, 'full');
  assert.equal(rooms.handle(late, { t: 'join', code: 'ZZZZZ' })[0].msg.error, 'not_found');
  assert.equal(rooms.handle(late, { t: 'join', code: 'A0O1I' })[0].msg.error, 'not_found', 'look-alike characters are not codes');
  assert.equal(rooms.handle(late, { t: 'create', mode: 'arena', map: 'warehouse' })[0].msg.error, 'bad_request');
  assert.equal(rooms.handle(late, { t: 'create', mode: 'team', map: '../etc' })[0].msg.error, 'bad_request');
  assert.equal(M.cleanName('  <b>Kim</b>\u0007 '), 'bKim/b');
  assert.equal(M.cleanName('x'.repeat(40)).length, 16);
});

test('rooms: routing — members reach only their host, the host reaches one or all; senders are stamped by the server', () => {
  const { rooms, hi } = world();
  const h = hi('h');
  rooms.handle(h, { t: 'create', mode: 'team', map: 'seoul' });
  const a = hi('a');
  const b = hi('b');
  rooms.handle(a, { t: 'join', code: 'AAAAA' });
  rooms.handle(b, { t: 'join', code: 'AAAAA' });
  assert.deepEqual(rooms.handle(a, { t: 'relay', to: b, d: { x: 1 } }), [{ to: h, msg: { t: 'relay', from: a, d: { x: 1 } } }], 'a member cannot reach another member');
  assert.deepEqual(rooms.handle(h, { t: 'relay', to: b, d: 2 }), [{ to: b, msg: { t: 'relay', from: h, d: 2 } }]);
  assert.deepEqual(rooms.handle(h, { t: 'relay', d: 3 }).map((o) => o.to).sort(), [a, b].sort());
  assert.deepEqual(rooms.handle(h, { t: 'relay', to: 'p999', d: 4 }), [], 'not a member: dropped');
  const outsider = hi('o');
  assert.equal(rooms.handle(outsider, { t: 'relay', d: 5 })[0].msg.error, 'no_room');
  assert.equal(rooms.handle(a, { t: 'map', map: 'warehouse' })[0].msg.error, 'not_host');
  assert.ok(rooms.handle(h, { t: 'map', map: 'warehouse' }).every((o) => o.msg.room.map === 'warehouse'));
});

test('rooms: the host leaving hands the room to the longest-standing member; the last one out closes it', () => {
  const { rooms, hi } = world();
  const h = hi('h');
  rooms.handle(h, { t: 'create', mode: 'deathmatch', map: 'warehouse' });
  const a = hi('a');
  const b = hi('b');
  rooms.handle(a, { t: 'join', code: 'AAAAA' });
  rooms.handle(b, { t: 'join', code: 'AAAAA' });
  const out = rooms.disconnect(h);
  assert.deepEqual(
    out.map((o) => [o.to, o.msg.t, o.msg.id]),
    [
      [a, 'gone', h],
      [b, 'gone', h],
      [a, 'host', a],
      [b, 'host', a],
    ],
  );
  assert.equal(rooms.roomOf(b).hostId, a);
  rooms.handle(a, { t: 'leave' });
  rooms.handle(b, { t: 'leave' });
  assert.equal(rooms.roomCount, 0);
});

// --- sockets ------------------------------------------------------------------------

function client(headers = {}) {
  const ws = new WebSocket(`ws://${url}${M.MP_PATH}`, { headers });
  const inbox = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    inbox.push(m);
    for (const w of [...waiters]) if (w.pred(m)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(m);
    }
  });
  const c = {
    ws,
    inbox,
    open: () => new Promise((res, rej) => (ws.readyState === 1 ? res() : (ws.once('open', res), ws.once('error', rej)))),
    send: (m) => ws.send(JSON.stringify(m)),
    next: (pred, ms = 3000) =>
      new Promise((resolve, reject) => {
        const found = inbox.find(pred);
        if (found) {
          inbox.splice(inbox.indexOf(found), 1);
          return resolve(found);
        }
        const w = { pred, resolve: (m) => (inbox.splice(inbox.indexOf(m), 1), resolve(m)) };
        waiters.push(w);
        setTimeout(() => reject(new Error('timeout waiting for message')), ms);
      }),
    close: () => ws.close(),
  };
  return c;
}

async function hello(name) {
  const c = client();
  await c.open();
  c.send({ t: 'hello', v: M.MP_PROTOCOL, name });
  c.id = (await c.next((m) => m.t === 'welcome')).id;
  return c;
}

test('server: health, game page, hello / quick join / relay over real sockets, host hand-over', async () => {
  const h = await fetch(`http://${url}${M.MP_PATH}/health`).then((r) => r.json());
  assert.equal(h.service, 'grid-mp');
  assert.match(await fetch(`http://${url}/`).then((r) => r.text()), /GRID/);
  const host = await hello('Host');
  host.send({ t: 'quick', mode: 'team', map: 'seoul' });
  const room = (await host.next((m) => m.t === 'room')).room;
  assert.equal(room.hostId, host.id);
  const guest = await hello('Guest');
  guest.send({ t: 'join', code: room.code.toLowerCase() });
  const groom = (await guest.next((m) => m.t === 'room')).room;
  assert.deepEqual(groom.members.map((m) => m.name), ['Host', 'Guest']);
  assert.equal((await host.next((m) => m.t === 'joined')).member.name, 'Guest');
  guest.send({ t: 'relay', d: { k: 'state', x: 1 } });
  assert.deepEqual(await host.next((m) => m.t === 'relay'), { t: 'relay', from: guest.id, d: { k: 'state', x: 1 } });
  host.send({ t: 'relay', d: { k: 'snap' } });
  assert.equal((await guest.next((m) => m.t === 'relay')).from, host.id);
  // A spoofed sender field is ignored: the server stamps the real one.
  guest.send({ t: 'relay', from: host.id, d: 'x' });
  assert.equal((await host.next((m) => m.t === 'relay')).from, guest.id);
  host.close();
  assert.deepEqual(await guest.next((m) => m.t === 'host'), { t: 'host', id: guest.id });
  guest.close();
});

test('server: wrong protocol version, foreign page origin, oversized and too frequent messages are refused', async () => {
  const c = client();
  await c.open();
  c.send({ t: 'hello', v: 0, name: 'x' });
  assert.equal((await c.next((m) => m.t === 'error')).error, 'version');
  c.close();
  const foreign = client({ origin: 'https://evil.example' });
  await assert.rejects(foreign.open());
  const ok = client({ origin: 'https://static.example' });
  await ok.open();
  ok.close();
  const big = await hello('big');
  const closed = new Promise((r) => big.ws.once('close', (code) => r(code)));
  big.ws.send('x'.repeat(M.MAX_MESSAGE + 10));
  assert.equal(await closed, 1009, 'message too big');
  const spam = await hello('spam');
  for (let i = 0; i < 120; i++) spam.send({ t: 'ping', n: i });
  assert.equal((await spam.next((m) => m.t === 'error')).error, 'rate');
  spam.close();
});

test('server: a connection that stops answering pings is dropped and its room handed over', async () => {
  const host = await hello('H');
  host.send({ t: 'create', mode: 'deathmatch', map: 'warehouse' });
  const code = (await host.next((m) => m.t === 'room')).room.code;
  const g = await hello('G');
  g.send({ t: 'join', code });
  await g.next((m) => m.t === 'room');
  // Freeze the host's socket: it no longer answers pings.
  host.ws._socket.pause();
  host.ws.pong = () => {};
  host.ws.removeAllListeners('ping');
  host.ws._receiver.removeAllListeners('ping');
  assert.deepEqual(await g.next((m) => m.t === 'host', 5000), { t: 'host', id: g.id });
  g.close();
  host.ws.terminate();
});
