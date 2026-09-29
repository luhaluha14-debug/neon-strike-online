/* Online server integration tests: real WebSocket clients against the server. */
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

process.env.QUICK_WAIT = '1';
const { startServer } = await import('../server/server.js');
const { Match, emptyCommand } = await import('../shared/game.js');
const { applyItemEvent } = await import('../shared/net.js');

function client(port) {
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  const c = { ws, msgs: [], waiters: [] };
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    c.msgs.push(m);
    for (const w of c.waiters.slice()) if (w.f(m)) { c.waiters.splice(c.waiters.indexOf(w), 1); w.res(m); }
  });
  c.send = (m) => ws.send(JSON.stringify(m));
  c.wait = (f, ms = 8000) => new Promise((res, rej) => {
    const hit = c.msgs.find(f);
    if (hit) { c.msgs.splice(c.msgs.indexOf(hit), 1); res(hit); return; }
    const w = { f, res };
    c.waiters.push(w);
    setTimeout(() => { const i = c.waiters.indexOf(w); if (i >= 0) { c.waiters.splice(i, 1); rej(new Error('timeout')); } }, ms);
  });
  c.open = new Promise((res) => ws.on('open', res));
  return c;
}

test('online: private duo room, identical mirror, inputs move the player, pickup, takeover', async () => {
  const { server, net, port } = await startServer(0, { quiet: true });
  try {
    const a = client(port), b = client(port);
    await a.open; await b.open;
    a.send({ t: 'hello', name: 'Alice' }); b.send({ t: 'hello', name: 'Bob<script>' });
    a.send({ t: 'create', mode: 2 });
    const room = await a.wait((m) => m.t === 'room');
    assert.equal(room.code.length, 4);
    b.send({ t: 'join', code: room.code });
    const r2 = await b.wait((m) => m.t === 'room' && m.players.length === 2);
    assert.equal(r2.players[1].name, 'Bobscript', 'names are cleaned');
    assert.equal(r2.players[0].team, r2.players[1].team, 'duo: second player joins the free seat');
    // only the host can start
    b.send({ t: 'start' });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(net.rooms.get(room.code).state, 'lobby');
    a.send({ t: 'start' });
    const sa = await a.wait((m) => m.t === 'start', 6000);
    const sb = await b.wait((m) => m.t === 'start', 6000);
    assert.equal(sa.seed, sb.seed);
    assert.notEqual(sa.you, sb.you);
    const srv = net.rooms.get(room.code).match;
    // the client mirror built from the start message matches the server
    const mirror = new Match({ world: net.world, nav: net.nav, seed: sa.seed, bots: sa.bots, difficulty: sa.difficulty, teamSize: sa.teamSize, humans: sa.humans, mirror: true });
    assert.equal(mirror.items.length, srv.items.length);
    assert.deepEqual(mirror.items.slice(0, 50).map((i) => [i.id, i.key, i.x]), srv.items.slice(0, 50).map((i) => [i.id, i.key, i.x]));
    assert.deepEqual(mirror.players.map((p) => [p.id, p.name, p.team]), srv.players.map((p) => [p.id, p.name, p.team]));
    assert.deepEqual(mirror.vehicles.map((v) => [v.id, v.type, v.x]), srv.vehicles.map((v) => [v.id, v.type, v.x]));
    assert.equal(srv.byId.get(sa.you).team, srv.byId.get(sb.you).team, 'humans share the duo');

    // put Alice on the ground next to an item, then walk forward with inputs
    const pa = srv.byId.get(sa.you);
    const it = srv.items.find((i) => ['bandage', 'ammo_light', 'medkit'].includes(i.key) && Math.abs(i.y - net.world.groundAt(i.x, i.z)) < 0.2);
    pa.air = null; pa.body.pos.x = it.x; pa.body.pos.z = it.z + 1; pa.body.pos.y = net.world.groundAt(it.x, it.z + 1); pa.body.onGround = true; pa.body.vel.y = 0;
    pa.autoPickup = false;
    a.send({ t: 'act', a: 'pick', id: it.id });
    const got = await a.wait((m) => m.t === 'e' && m.ev.some((e) => e.t === 'pickup' && e.id === sa.you));
    assert.ok(got);
    const snap = await a.wait((m) => m.t === 's' && m.me.inv[it.key] > 0);
    assert.ok(snap.me.inv[it.key] > 0, 'inventory in private snapshot');
    // far items can't be grabbed
    const far = srv.items.find((i) => Math.hypot(i.x - pa.body.pos.x, i.z - pa.body.pos.z) > 30);
    a.send({ t: 'act', a: 'pick', id: far.id });
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(srv.itemById.has(far.id));
    // item events carry the data the mirror needs
    const evs = a.msgs.filter((m) => m.t === 'e').flatMap((m) => m.ev);
    for (const e of evs) applyItemEvent(mirror, e);
    assert.equal(mirror.itemById.has(it.id), srv.itemById.has(it.id));

    // walk test on open ground: a spawn spot with nothing in front of it
    const W = net.world;
    const sp = W.spawnSpots.find((q) => { const y = W.groundAt(q.x, q.z) + 1; return [1, 2, 3, 4, 5, 6, 7, 8].every((d) => W.lineClear(q.x, y, q.z, q.x, W.groundAt(q.x, q.z - d) + 1, q.z - d) && Math.abs(W.groundAt(q.x, q.z - d) - W.groundAt(q.x, q.z)) < 0.6 && !W.inBush(q.x, q.z - d, y)); });
    pa.body.pos.x = sp.x; pa.body.pos.z = sp.z; pa.body.pos.y = W.groundAt(sp.x, sp.z);
    const x0 = pa.body.pos.x, z0 = pa.body.pos.z;
    for (let s = 1; s <= 60; s++) { const c = emptyCommand(); c.fwd = 1; c.yaw = 0; a.send({ t: 'in', s, c }); await new Promise((r) => setTimeout(r, 1000 / 60)); }
    a.send({ t: 'in', s: 61, c: { fwd: 'x', yaw: 1e9, fire: 'yes', slot: 99, use: {} } });   // garbage is sanitised
    const moved = await a.wait((m) => m.t === 's' && m.me.ack >= 61, 5000);
    // a burst of queued input is folded, not replayed faster than real time (no speed hack)
    const xb = moved.me.b[0], zb = moved.me.b[2];
    for (let s = 62; s <= 200; s++) { const c = emptyCommand(); c.fwd = 1; c.yaw = Math.PI; a.send({ t: 'in', s, c }); }
    const burst = await a.wait((m) => m.t === 's' && m.me.ack >= 200, 5000);
    assert.ok(Math.hypot(burst.me.b[0] - xb, burst.me.b[2] - zb) < 1.5, 'burst input folded');
    const dist = Math.hypot(moved.me.b[0] - x0, moved.me.b[2] - z0);
    assert.ok(dist > 3 && dist < 6, `walked ~4.7 m in one second (${dist.toFixed(2)})`);
    // the shared part of the snapshot lists every player
    assert.equal(moved.p.length, srv.players.length);

    // Bob leaves: a bot takes his player over
    b.ws.close();
    await new Promise((r) => setTimeout(r, 300));
    const pb = srv.byId.get(sb.you);
    assert.ok(pb.brain && pb.isBot, 'bot takeover');
    a.ws.close();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(net.rooms.size, 0, 'empty rooms close');
  } finally {
    net.close(); server.close();
  }
});

test('online: quick match starts by itself and fills with bots', async () => {
  const { server, net, port } = await startServer(0, { quiet: true });
  try {
    const a = client(port);
    await a.open;
    a.send({ t: 'hello', name: 'Solo' });
    a.send({ t: 'quick', mode: 4 });
    const room = await a.wait((m) => m.t === 'room');
    assert.equal(room.public, true);
    const st = await a.wait((m) => m.t === 'start', 6000);
    assert.equal(st.humans.length + st.bots, 24);
    assert.equal(st.teamSize, 4);
    const s = await a.wait((m) => m.t === 's');
    assert.ok(s.zone && s.plane && s.p.length === 24);
    // a room that already started is not joinable
    const b = client(port); await b.open;
    b.send({ t: 'join', code: room.code });
    const err = await b.wait((m) => m.t === 'err');
    assert.match(err.msg, /시작/);
    a.ws.close(); b.ws.close();
  } finally {
    net.close(); server.close();
  }
});
