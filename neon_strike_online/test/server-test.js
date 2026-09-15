'use strict';
/* =========================================================================
   End-to-end server test with real WebSocket clients.
     npm test
   Covers rooms, quick match, hit validation (distance, walls, rate of fire),
   kills / respawn, abilities, ultimate, match end and forfeits.
   ========================================================================= */
process.env.PORT = process.env.PORT || '18080';
const WebSocket = require('ws');
const { server, rooms } = require('../server/server');

const URL = 'ws://127.0.0.1:' + process.env.PORT + '/ws';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passes = 0, failures = 0;

function check(name, cond, extra) {
  if (cond) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

function client(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const c = {
      ws, name, id: 0, sq: 0, pos: [0, 0, 0], msgs: [],
      send(o) {
        // honest shots look at their first target: fill in the aim direction unless the test sets one
        if (o && o.t === 'fire' && !o.d && Array.isArray(o.h) && o.h[0]) {
          for (const r of rooms.values()) {
            const me = r.players.get(c.id), v = r.players.get(o.h[0].id);
            if (!me || !v) continue;
            const ey = me.pos.y + me.height - 0.18, ty = v.pos.y + (o.h[0].hd ? v.height - 0.2 : v.height * 0.55);
            const dx = v.pos.x - me.pos.x, dy = ty - ey, dz = v.pos.z - me.pos.z, L = Math.hypot(dx, dy, dz) || 1;
            o.d = [dx / L, dy / L, dz / L];
          }
        }
        ws.send(typeof o === 'string' ? o : JSON.stringify(o));
      },
      clear() { c.msgs.length = 0; },
      all(type, pred = () => true) { return c.msgs.filter((m) => m.t === type && pred(m)); },
      async wait(type, pred = () => true, ms = 3000) {
        const end = Date.now() + ms;
        while (Date.now() < end) {
          const i = c.msgs.findIndex((m) => m.t === type && pred(m));
          if (i >= 0) return c.msgs.splice(i, 1)[0];
          await sleep(10);
        }
        return null;
      }
    };
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.t === 'snap') return;
      if (m.t === 'welcome') c.id = m.id;
      if (m.t === 'start') { const me = m.ps.find((p) => p.id === c.id); if (me) { c.sq = me.sq; c.pos = me.p.slice(); } }
      if (m.t === 'spawn' && m.id === c.id) { c.sq = m.sq; c.pos = m.p.slice(); }
      c.msgs.push(m);
    });
    ws.on('open', async () => {
      while (!c.id) await sleep(5);
      c.send({ t: 'hello', name });
      resolve(c);
    });
    ws.on('error', reject);
  });
}

/* walk in steps small enough for the server's speed check */
async function moveTo(c, x, y, z) {
  for (let i = 0; i < 40; i++) {
    const dx = x - c.pos[0], dz = z - c.pos[2], d = Math.hypot(dx, dz);
    const k = d > 8 ? 8 / d : 1;
    c.pos = [c.pos[0] + dx * k, y, c.pos[2] + dz * k];
    c.send({ t: 'st', sq: c.sq, p: c.pos, y: 0, pi: 0, h: 1.8, f: 0 });
    if (k === 1) break;
    await sleep(60);
  }
  await sleep(80);
}

(async () => {
  if (!server.listening) await new Promise((r) => server.on('listening', r));
  console.log('\nNEON STRIKE server test');

  const A = await client('ALPHA'), B = await client('BRAVO');

  console.log('\n[rooms]');
  B.send({ t: 'join', code: 'ZZZZ', hero: 'sniper' });
  check('joining a room that does not exist is refused', !!(await B.wait('err')));

  A.send({ t: 'create', mode: 'tdm', map: 'plaza', hero: 'assault' });
  const r1 = await A.wait('room');
  check('creating a room returns a 4-character code', r1 && /^[A-Z2-9]{4}$/.test(r1.code), r1);
  B.send({ t: 'join', code: r1.code.toLowerCase(), hero: 'sniper' });
  check('second player joins by code (case-insensitive)', !!(await B.wait('room', (m) => m.ps.length === 2)));

  B.send({ t: 'start' });
  await sleep(150);
  check('only the host can start', !B.all('start').length);
  A.send({ t: 'start' });
  const sA = await A.wait('start'), sB = await B.wait('start');
  check('both players receive the match start', !!(sA && sB));
  const room = rooms.get(r1.code);
  const pa = room.players.get(A.id), pb = room.players.get(B.id);
  check('players are put on opposite teams', pa.team !== pb.team, [pa.team, pb.team]);

  console.log('\n[hit validation]');
  await moveTo(A, -24, 0, -12);
  await moveTo(B, -24, 0, -2);
  await sleep(450);                                   // let older positions leave the lag window
  check('server accepted normal movement', Math.abs(pa.pos.z + 12) < 0.01 && Math.abs(pb.pos.z + 2) < 0.01, [pa.pos, pb.pos]);

  B.clear();
  A.send({ t: 'fire', e: [[-24, 1, -2]], h: [{ id: B.id, hd: 0, d: 10.02 }] });
  const d1 = await B.wait('dmg');
  check('valid body shot deals rifle damage (17)', d1 && d1.n === 17 && d1.hp === 125 - 17, d1);
  check('the victim sees the shooter\'s tracer', !!(await B.wait('shot', (m) => m.id === A.id)));

  await sleep(250); B.clear();
  A.send({ t: 'fire', e: [], h: [{ id: B.id, hd: 0, d: 30 }] });
  await sleep(150);
  check('a claim with the wrong distance is rejected', !B.all('dmg').length);

  await sleep(400); B.clear();
  A.send({ t: 'fire', d: [1, 0, 0], e: [], h: [{ id: B.id, hd: 0, d: 10.02 }] });
  await sleep(150);
  check('a claim while aiming somewhere else is rejected', !B.all('dmg').length);
  A.send({ t: 'fire', d: 'nope', e: [], h: [{ id: B.id, hd: 0, d: 10.02 }] });
  await sleep(150);
  check('a claim without a valid aim direction is rejected', !B.all('dmg').length);

  await sleep(400); B.clear();
  for (let i = 0; i < 10; i++) A.send({ t: 'fire', e: [], h: [{ id: B.id, hd: 0, d: 10.02 }] });
  await sleep(200);
  const burst = B.all('dmg').length;
  check('rate of fire is enforced (10 shots at once -> at most 2 land)', burst >= 1 && burst <= 2, burst);

  await moveTo(A, -24, 0, -8);
  await moveTo(B, -15, 0, -8);
  await sleep(500);
  check('(sanity) the west lane wall blocks that line', room.ctx.segBlocked(-24, 1.62, -8, -15, 0.99, -8) === true);
  B.clear();
  A.send({ t: 'fire', e: [], h: [{ id: B.id, hd: 0, d: 9.02 }] });
  await sleep(150);
  check('a shot through a wall is rejected', !B.all('dmg').length);

  console.log('\n[kills and respawn]');
  await moveTo(B, -24, 0, 2);
  await sleep(500);
  A.clear(); B.clear();
  let killMsg = null;
  for (let i = 0; i < 8 && !killMsg; i++) {
    A.send({ t: 'fire', e: [], h: [{ id: B.id, hd: 1, d: 10 }] });
    await sleep(130);
    killMsg = A.all('kill')[0] || null;
  }
  check('headshots kill and add a point for the team', killMsg && killMsg.a === A.id && killMsg.v === B.id && killMsg.hd === 1 && killMsg.sc[pa.team] === 1, killMsg);
  B.clear();
  A.send({ t: 'fire', e: [], h: [{ id: B.id, hd: 1, d: 10 }] });
  await sleep(150);
  check('a dead player cannot be damaged', !B.all('dmg').length);
  const sp = await B.wait('spawn', (m) => m.id === B.id, 4500);
  check('the victim respawns with full health', sp && sp.alive && sp.hp === 125, sp);

  const before = Object.assign({}, pb.pos);
  B.send({ t: 'st', sq: sp.sq - 1, p: [0, 0, 0], y: 0, pi: 0, h: 1.8, f: 0 });
  await sleep(100);
  check('state from a previous life is ignored', pb.pos.x === before.x && pb.pos.z === before.z);

  await sleep(600);
  B.send({ t: 'st', sq: B.sq, p: [pb.pos.x, pb.pos.y, pb.pos.z], y: 0, pi: 0, h: 1.8, f: 0 });
  await sleep(40); B.clear();
  B.send({ t: 'st', sq: B.sq, p: [pb.pos.x, pb.pos.y, pb.pos.z - 30 * Math.sign(pb.pos.z || 1)], y: 0, pi: 0, h: 1.8, f: 0 });
  check('a teleport is corrected by the server', !!(await B.wait('pos')));

  console.log('\n[abilities]');
  A.clear(); B.clear();
  pa.ult = 40;
  A.send({ t: 'abil', k: 'u' });
  await sleep(150);
  check('an ultimate without full charge is refused', !B.all('abil').length);
  pa.ult = 100;
  A.send({ t: 'abil', k: 'u' });
  check('a charged ultimate is accepted and shown to others', !!(await B.wait('abil', (m) => m.id === A.id && m.k === 'u')) && pa.ultActive);
  A.send({ t: 'abil', k: 'q' });
  await B.wait('abil', (m) => m.k === 'q');
  B.clear();
  A.send({ t: 'abil', k: 'q' });
  await sleep(150);
  check('ability cooldowns are enforced', !B.all('abil').length);

  B.pos = [pb.pos.x, pb.pos.y, pb.pos.z];
  await moveTo(B, -24, 0, 4);
  await sleep(100);
  pb.ult = 100; A.clear();
  const dy = 1.8 * 0.6 - 1.62, dz = -12, L = Math.hypot(dy, dz);
  B.send({ t: 'abil', k: 'u', d: [0, dy / L, dz / L] });
  const rail = await A.wait('dmg', (m) => m.a === B.id);
  check('sniper RAIL SHOT down the lane deals 190+', rail && rail.n >= 190, rail);

  console.log('\n[match end]');
  const spA = await A.wait('spawn', (m) => m.id === A.id, 4500);
  check('the railed player respawns', !!spA);
  await moveTo(A, -24, 0, -8);
  await sleep(500);
  room.scores[pb.team] = room.M.target - 1;
  pb.ult = 100;
  B.send({ t: 'abil', k: 'u', d: [0, dy / L, dz / L] });
  const end = await A.wait('end', () => true, 3000);
  check('reaching the kill target ends the match for the right team', end && end.win === pb.team && end.stats.length === 2, end);

  console.log('\n[quick match]');
  const C = await client('CHARLIE'), D = await client('DELTA');
  C.send({ t: 'quick', hero: 'shock' });
  const rc = await C.wait('room');
  D.send({ t: 'quick', hero: 'assault' });
  const rd = await D.wait('room', (m) => m.ps.length === 2);
  check('quick match puts both players in the same public room', rc && rd && rc.code === rd.code && rd.pub === true);
  check('a public room counts down once two players are in', !!(await D.wait('room', (m) => m.cd > 0, 1500)));
  D.send('this is not json');
  D.send({ t: 'fire', h: 'nope', e: 5 });
  D.send({ t: 'st', p: ['x'] });
  C.send({ t: 'join', code: rc.code, hero: 'shock' });
  await sleep(150);
  check('the server survives malformed messages', D.ws.readyState === WebSocket.OPEN);

  console.log('\n[free for all + forfeit]');
  const E = await client('ECHO'), F = await client('FOXTROT');
  E.send({ t: 'create', mode: 'ffa', map: 'colosseum', hero: 'shock' });
  const re = await E.wait('room');
  F.send({ t: 'join', code: re.code, hero: 'sniper' });
  await F.wait('room', (m) => m.ps.length === 2);
  E.send({ t: 'start' });
  const se = await E.wait('start');
  check('free for all gives every player their own team', se && se.ps[0].team !== se.ps[1].team && se.ps.every((p) => p.team[0] === 'p'), se && se.ps);
  check('colosseum spawns stand on the raised ring', se && se.ps.every((p) => Math.abs(p.p[1] - 1) < 0.01), se && se.ps.map((p) => p.p));
  F.ws.close();
  check('the match ends by forfeit when the only opponent leaves', !!(await E.wait('end', (m) => m.why === 'forfeit')));

  console.log('\n' + passes + ' passed, ' + failures + ' failed\n');
  for (const c of [A, B, C, D, E]) c.ws.close();
  setTimeout(() => process.exit(failures ? 1 : 0), 100);
})().catch((e) => { console.error(e); process.exit(1); });
