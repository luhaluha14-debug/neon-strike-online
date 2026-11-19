// Phase 28 crossplay and mobile aids.
//
// Relay (no sockets): the platform a player says is checked (only 'pc' / 'mobile'), each room has a
// matching pool (mixed by default, PC only, mobile only) held on every way in (quick join, a new room, a
// code), parties enter rooms together on the leader's choice and a party of PC and mobile players always
// plays in the mixed pool; hosting, rejoining and the host hand-over are as before.
//
// Game (headless Chromium; phones are Playwright's mobile emulation, not real devices): the weak aim
// assist (only with the finger's own input, only enemies in view and not behind a wall or smoke, never on
// a PC), the recoil assist (the weapon's own pattern, smaller, never gone; a PC's untouched), the gyro (on
// with sensor readings, touch only when there are none), the touch HUD (left fire button, weapon picker,
// reload button state, fit to small screens, the layout kept after a reload), presets, the battery saver
// and the network line. Weapon data, damage and rate of fire are the same on both platforms.
// Rooms with real browsers: PC + phone in the mixed pool, the mobile and PC pools refusing the other
// platform by code, a PC + phone party entering together, rejoining and the host hand-over.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { startEnv, openGame, installFrameDriver, waitReady, ROOT } from './harness.mjs';
import { fingers, centre } from './mobile-touch.mjs';

let vite;
let relay;
let env;
let M;

before(async () => {
  vite = await createServer({ root: ROOT, logLevel: 'error', server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom' });
  const load = (p) => vite.ssrLoadModule(p);
  M = {
    ...(await load('/server/mp/rooms.ts')),
    ...(await load('/src/net/Protocol.ts')),
    ...(await load('/src/input/AimAssist.ts')),
    ...(await load('/src/input/GyroAim.ts')),
    ...(await load('/src/input/TouchSettings.ts')),
    ...(await load('/src/core/AutoQuality.ts')),
    ...(await load('/src/game/PlatformStats.ts')),
    ...(await load('/src/weapons/weapons.ts')),
  };
  const { createMpServer } = await load('/server/mp/server.ts');
  relay = createMpServer({ staticDir: null, log: () => {} });
  await new Promise((r) => relay.http.listen(0, '127.0.0.1', r));
  process.env.GRID_MP_PROXY = `http://127.0.0.1:${relay.http.address().port}`;
  env = await startEnv();
  delete process.env.GRID_MP_PROXY;
});
after(async () => {
  await env?.close();
  await relay?.close();
  await vite?.close();
});

// --- relay --------------------------------------------------------------------------------------

function world() {
  let i = 0;
  let j = 0;
  const codes = ['AAAAA', 'BBBBB', 'CCCCC', 'DDDDD', 'EEEEE', 'FFFFF'];
  const parties = ['PARTY2', 'PARTY3', 'PARTY4'];
  const rooms = new M.Rooms(
    () => codes[i++ % codes.length],
    () => parties[j++ % parties.length],
  );
  const hi = (name, platform) => {
    const id = rooms.connect();
    const out = rooms.handle(id, platform === undefined ? { t: 'hello', v: M.MP_PROTOCOL, name } : { t: 'hello', v: M.MP_PROTOCOL, name, platform });
    return { id, out };
  };
  return { rooms, hi };
}
const errorOf = (out) => out.find((o) => o.msg.t === 'error')?.msg.error ?? null;

test('1 / 2. platform: only pc / mobile accepted (absent = an older client = pc); members carry it; it changes outside a room only', () => {
  const { rooms, hi } = world();
  const pc = hi('pc', 'pc');
  const phone = hi('phone', 'mobile');
  const old = hi('old');
  assert.equal(pc.out[0].msg.t, 'welcome');
  assert.equal(phone.out[0].msg.t, 'welcome');
  for (const bad of ['console', 'MOBILE', '', 1, null, { x: 1 }]) assert.equal(errorOf(hi('x', bad).out), 'platform', JSON.stringify(bad));
  rooms.handle(pc.id, { t: 'create', mode: 'deathmatch', map: 'warehouse' });
  rooms.handle(phone.id, { t: 'join', code: 'AAAAA' });
  rooms.handle(old.id, { t: 'join', code: 'AAAAA' });
  assert.deepEqual(
    rooms.roomOf(pc.id).members.map((m) => [m.name, m.platform]),
    [
      ['pc', 'pc'],
      ['phone', 'mobile'],
      ['old', 'pc'],
    ],
  );
  // In a room the platform it entered with stays; outside, a change is taken.
  assert.equal(errorOf(rooms.handle(phone.id, { t: 'platform', platform: 'pc' })), 'platform');
  assert.deepEqual(rooms.handle(phone.id, { t: 'platform', platform: 'mobile' }), [], 'the same platform again: nothing');
  rooms.handle(phone.id, { t: 'leave' });
  assert.deepEqual(rooms.handle(phone.id, { t: 'platform', platform: 'pc' }), []);
  assert.equal(errorOf(rooms.handle(phone.id, { t: 'platform', platform: 'tablet' })), 'platform');
  rooms.handle(phone.id, { t: 'join', code: 'AAAAA' });
  assert.equal(rooms.roomOf(phone.id).members.find((m) => m.id === phone.id).platform, 'pc');
});

test('3 / 4 / 5 / 7. pools: mixed by default (PC and mobile together), mobile only and PC only kept apart on quick join, a new room and a code; the list says it', () => {
  const { rooms, hi } = world();
  const p1 = hi('p1', 'pc').id;
  const m1 = hi('m1', 'mobile').id;
  // Default: one mixed room for both.
  rooms.handle(p1, { t: 'quick', mode: 'deathmatch', map: 'warehouse' });
  rooms.handle(m1, { t: 'quick', mode: 'deathmatch', map: 'warehouse' });
  assert.equal(rooms.roomOf(p1).code, rooms.roomOf(m1).code);
  assert.equal(rooms.roomOf(p1).pool, 'mixed');
  // Mobile only: a mobile room of its own, not the mixed one.
  const m2 = hi('m2', 'mobile').id;
  const m3 = hi('m3', 'mobile').id;
  rooms.handle(m2, { t: 'quick', mode: 'deathmatch', map: 'warehouse', pool: 'mobile' });
  rooms.handle(m3, { t: 'quick', mode: 'deathmatch', map: 'warehouse', pool: 'mobile' });
  const mobileRoom = rooms.roomOf(m2);
  assert.equal(mobileRoom.pool, 'mobile');
  assert.notEqual(mobileRoom.code, rooms.roomOf(p1).code);
  assert.equal(rooms.roomOf(m3).code, mobileRoom.code, 'the next mobile-only player finds it');
  // PC only: its own; a mobile player asking for PC only (or a PC for mobile only) is refused.
  const p2 = hi('p2', 'pc').id;
  rooms.handle(p2, { t: 'create', mode: 'team', map: 'seoul', pool: 'pc' });
  assert.equal(rooms.roomOf(p2).pool, 'pc');
  assert.equal(errorOf(rooms.handle(m1, { t: 'quick', mode: 'team', map: 'seoul', pool: 'pc' })), 'platform');
  assert.equal(errorOf(rooms.handle(p1, { t: 'create', mode: 'team', map: 'seoul', pool: 'mobile' })), 'platform');
  assert.equal(errorOf(rooms.handle(p1, { t: 'quick', mode: 'team', map: 'seoul', pool: 'console' })), 'bad_request');
  assert.equal(rooms.roomOf(p1).pool, 'mixed', 'a refused request leaves the player where it was');
  // By code: the room's pool holds too.
  const pcCode = rooms.roomOf(p2).code;
  assert.equal(errorOf(rooms.handle(m1, { t: 'join', code: pcCode })), 'platform');
  assert.equal(errorOf(rooms.handle(p1, { t: 'join', code: mobileRoom.code })), 'platform');
  const p3 = hi('p3', 'pc').id;
  assert.equal(rooms.handle(p3, { t: 'join', code: pcCode })[0].msg.t, 'room');
  // Mixed rooms take anyone by code.
  const m4 = hi('m4', 'mobile').id;
  assert.equal(rooms.handle(m4, { t: 'join', code: rooms.roomOf(p1).code })[0].msg.t, 'room');
  const list = rooms.list();
  assert.deepEqual(list.map((r) => [r.code, r.pool]).sort(), [
    [rooms.roomOf(p1).code, 'mixed'],
    [mobileRoom.code, 'mobile'],
    [pcCode, 'pc'],
  ].sort());
  // Host hand-over keeps the pool; bots and the rest as before.
  rooms.handle(p2, { t: 'leave' });
  assert.equal(rooms.roomOf(p3).hostId, p3);
  assert.equal(rooms.roomOf(p3).pool, 'pc');
});

test('6. parties: form, join by code (max 5), leave; only the leader picks; the whole party goes in together; a PC + mobile party plays mixed; rooms full or of the wrong pool refuse the whole party', () => {
  const { rooms, hi } = world();
  const lead = hi('lead', 'pc').id;
  const phone = hi('phone', 'mobile').id;
  const pc2 = hi('pc2', 'pc').id;
  const out = rooms.handle(lead, { t: 'party_create' });
  assert.equal(out[out.length - 1].msg.party.code, 'PARTY2');
  assert.equal(errorOf(rooms.handle(phone, { t: 'party_join', code: 'NOPE00' })), 'party_not_found');
  assert.equal(errorOf(rooms.handle(phone, { t: 'party_join', code: 'AAAAA' })), 'party_not_found', 'a room code is not a party code');
  const joined = rooms.handle(phone, { t: 'party_join', code: 'party2' });
  assert.deepEqual(joined.map((o) => o.to).sort(), [lead, phone].sort(), 'everyone in the party hears it');
  rooms.handle(pc2, { t: 'party_join', code: 'PARTY2' });
  assert.deepEqual(
    rooms.partyOf(lead).members.map((m) => [m.name, m.platform]),
    [
      ['lead', 'pc'],
      ['phone', 'mobile'],
      ['pc2', 'pc'],
    ],
  );
  // Only the leader picks the room.
  assert.equal(errorOf(rooms.handle(phone, { t: 'quick', mode: 'deathmatch', map: 'warehouse' })), 'party_leader');
  assert.equal(errorOf(rooms.handle(phone, { t: 'join', code: 'AAAAA' })), 'party_leader');
  // A PC + mobile party asking for PC only: mixed it is, all three in one room.
  const moved = rooms.handle(lead, { t: 'create', mode: 'team', map: 'seoul', pool: 'pc' });
  const room = rooms.roomOf(lead);
  assert.equal(room.pool, 'mixed');
  assert.equal(room.hostId, lead, 'the leader hosts the room it made');
  assert.deepEqual([rooms.roomOf(phone).code, rooms.roomOf(pc2).code], [room.code, room.code]);
  assert.ok(moved.some((o) => o.to === phone && o.msg.t === 'room'), 'each member is told its room');
  // The party moves on: out of the old room (it closes, empty), into a quick-joined one.
  const other = hi('other', 'pc').id;
  rooms.handle(other, { t: 'create', mode: 'deathmatch', map: 'warehouse' });
  rooms.handle(lead, { t: 'quick', mode: 'deathmatch', map: 'warehouse' });
  assert.equal(rooms.roomOf(phone).code, rooms.roomOf(other).code);
  assert.equal(rooms.roomOf(other).members.length, 4);
  assert.equal(rooms.roomOf(other).hostId, other, 'joining a room does not take its host');
  // A mobile-only room refuses the party (its PC players), by code too; a room without space for all of them as well.
  const m1 = hi('m1', 'mobile').id;
  rooms.handle(m1, { t: 'create', mode: 'deathmatch', map: 'warehouse', pool: 'mobile' });
  assert.equal(errorOf(rooms.handle(lead, { t: 'join', code: rooms.roomOf(m1).code })), 'platform');
  const duelHost = hi('d', 'pc').id;
  rooms.handle(duelHost, { t: 'create', mode: 'duel', map: 'warehouse' });
  assert.equal(errorOf(rooms.handle(lead, { t: 'join', code: rooms.roomOf(duelHost).code })), 'full');
  assert.equal(errorOf(rooms.handle(lead, { t: 'create', mode: 'duel', map: 'warehouse' })), 'full', 'three players never fit a 1대1');
  assert.equal(rooms.roomOf(phone).code, rooms.roomOf(other).code, 'refused: nobody moved');
  // Max 5.
  for (let i = 0; i < 2; i++) rooms.handle(hi(`x${i}`, 'pc').id, { t: 'party_join', code: 'PARTY2' });
  assert.equal(errorOf(rooms.handle(hi('sixth', 'pc').id, { t: 'party_join', code: 'PARTY2' })), 'party_full');
  // The leader leaves the party: the next member leads; a member leaving gets no party.
  const left = rooms.handle(lead, { t: 'party_leave' });
  assert.deepEqual(left.find((o) => o.to === lead).msg, { t: 'party', party: null });
  assert.equal(rooms.partyOf(phone).leaderId, phone);
  // Disconnecting drops the party member (and its room seat) as before.
  rooms.disconnect(phone);
  assert.equal(rooms.partyOf(pc2).leaderId, pc2);
  // A party of phones only keeps the mobile pool.
  const a = hi('a', 'mobile').id;
  const b = hi('b', 'mobile').id;
  rooms.handle(a, { t: 'party_create' });
  rooms.handle(b, { t: 'party_join', code: rooms.partyOf(a).code });
  rooms.handle(a, { t: 'quick', mode: 'team', map: 'seoul', pool: 'mobile' });
  assert.equal(rooms.roomOf(b).pool, 'mobile');
  assert.equal(rooms.roomOf(a).code, rooms.roomOf(b).code);
});

// --- the aids, as functions ------------------------------------------------------------------------

test('9. aim assist: no input → no movement; off at 0; only near an enemy (its help zone); at most a fraction of the input; never past the enemy; it cannot hold the aim against the player', () => {
  const out = { yaw: 0, pitch: 0 };
  const near = [{ yaw: 0.02, pitch: 0.005, distance: 10 }];
  assert.deepEqual(M.assistLook({ yaw: 0, pitch: 0 }, near, 1, 1, out), { yaw: 0, pitch: 0 }, 'a still finger: the view stays');
  assert.deepEqual(M.assistLook({ yaw: 0.01, pitch: 0 }, near, 1, 0, out), { yaw: 0.01, pitch: 0 }, 'strength 0: off');
  assert.deepEqual(M.assistLook({ yaw: 0.01, pitch: 0 }, [{ yaw: 0.4, pitch: 0, distance: 10 }], 1, 1, out), { yaw: 0.01, pitch: 0 }, 'far from the crosshair: nothing');
  assert.deepEqual(M.assistLook({ yaw: 0.01, pitch: 0 }, [{ yaw: 0.01, pitch: 0, distance: 70 }], 1, 1, out), { yaw: 0.01, pitch: 0 }, 'out of range: nothing');
  // Near: slowed a little and pulled a little; the size never grows past input × (1 + pull).
  const r = M.assistLook({ yaw: 0.008, pitch: 0 }, near, 1, 1, { yaw: 0, pitch: 0 });
  assert.ok(r.yaw > 0 && Math.hypot(r.yaw, r.pitch) <= 0.008 * (1 + M.AIM_ASSIST.pull) + 1e-9, JSON.stringify(r));
  assert.ok(r.pitch > 0, 'pulled toward the enemy (above)');
  // Moving away from it: the view still goes the player's way (friction + pull < the input).
  const away = M.assistLook({ yaw: -0.01, pitch: 0 }, near, 1, 1, { yaw: 0, pitch: 0 });
  assert.ok(away.yaw < 0, `the player's way wins (${away.yaw})`);
  // A tiny offset: the pull never overshoots the enemy.
  const tiny = M.assistLook({ yaw: 0.05, pitch: 0 }, [{ yaw: 0.0001, pitch: 0.0001, distance: 5 }], 1, 1, { yaw: 0, pitch: 0 });
  assert.ok(Math.abs(tiny.pitch) <= 0.0001 + 1e-12);
  // Help zone: wider up close, narrower far, within bounds.
  assert.ok(M.assistCone(3) > M.assistCone(40));
  assert.ok(M.assistCone(3) <= M.AIM_ASSIST.maxCone && M.assistCone(200) >= M.AIM_ASSIST.minCone);
  // Over many frames with the finger still after a drag: the view does not drift onto the enemy.
  let yaw = 0;
  const c = [{ yaw: 0.03, pitch: 0, distance: 10 }];
  for (let i = 0; i < 120; i++) {
    const input = i < 5 ? 0.001 : 0;
    c[0].yaw = 0.03 - yaw;
    yaw += M.assistLook({ yaw: input, pitch: 0 }, c, 1, 1, { yaw: 0, pitch: 0 }).yaw;
  }
  assert.ok(yaw < 0.006, `no tracking after the finger stops (${yaw.toFixed(4)} rad)`);
});

test('10. recoil assist: the kick at most 35 % smaller, never gone; 0 = the weapon as it is', () => {
  assert.equal(M.recoilScaleFor(0), 1);
  assert.equal(+M.recoilScaleFor(1).toFixed(3), 0.65);
  assert.equal(M.recoilScaleFor(5), M.recoilScaleFor(1), 'out of range: clamped');
  assert.equal(M.recoilScaleFor(-1), 1);
});

test('11. gyro: the turn follows the screen orientation (portrait / both landscapes), in the look sense; readings far apart are a pause', () => {
  const o = { yaw: 0, pitch: 0 };
  const deg = Math.PI / 180;
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  M.gyroTurn(0, 10, 20, 0, 0.1, o);
  assert.ok(near(o.yaw, 20 * deg * 0.1) && near(o.pitch, 10 * deg * 0.1), 'portrait: gamma turns, beta tilts');
  M.gyroTurn(0, 10, 20, 90, 0.1, o);
  assert.ok(near(o.yaw, 10 * deg * 0.1) && near(o.pitch, -20 * deg * 0.1), 'landscape (90)');
  M.gyroTurn(0, 10, 20, -90, 0.1, o);
  assert.ok(near(o.yaw, -10 * deg * 0.1) && near(o.pitch, 20 * deg * 0.1), 'landscape (270 / -90)');
  const g = new M.GyroAim();
  g.status = 'on';
  const look = { lookYaw: 0, lookPitch: 0 };
  g.reading(0, 0, 30, 1000);
  g.reading(0, 0, 30, 1016);
  g.reading(0, 0, 30, 1500);
  g.take(look, 1, true);
  assert.ok(Math.abs(look.lookYaw - 30 * deg * 0.016) < 1e-6, 'the 484 ms gap is not integrated');
  g.reading(0, 0, 30, 1516);
  g.take(look, 1, false);
  assert.ok(Math.abs(look.lookYaw - 30 * deg * 0.016) < 1e-6, 'not in use: dropped');
});

test('presets, settings limits, the per-platform record and auto quality below low (touch only)', () => {
  const d = M.defaultTouchSettings();
  assert.deepEqual([d.aimAssist, d.recoilAssist, d.gyro, d.leftFire, d.batterySaver, d.autoSaver], [0.5, 0.5, 0, 0, 0, 1]);
  const s = M.sanitizeTouchSettings({ ...d, aimAssist: 9, recoilAssist: -2, gyro: 0.7, gyroSensitivity: 99 });
  assert.deepEqual([s.aimAssist, s.recoilAssist, s.gyro, s.gyroSensitivity], [1, 0, 1, 3]);
  for (const id of Object.keys(M.TOUCH_PRESETS)) {
    const p = M.applyTouchPreset(d, id);
    assert.deepEqual(M.sanitizeTouchSettings(p), p, id);
  }
  assert.equal(M.applyTouchPreset(d, 'battery').batterySaver, 1);
  assert.equal(M.applyTouchPreset(d, 'gyro').gyroAdsOnly, 1);
  // Record: counts only, sanitized.
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  try {
    M.recordPlatformMatch('mobile', 'team', { won: true, kills: 7, deaths: 3, seconds: 600 });
    M.recordPlatformMatch('pc', 'deathmatch', { won: false, kills: 4, deaths: 5, seconds: 300 });
    const ps = M.loadPlatformStats();
    assert.deepEqual(ps.mobile.team, { matches: 1, wins: 1, kills: 7, deaths: 3, seconds: 600 });
    assert.deepEqual(ps.pc.deathmatch, { matches: 1, wins: 0, kills: 4, deaths: 5, seconds: 300 });
    assert.match(M.describePlatformStats(ps), /PC: 1경기 · 0승.*모바일: 1경기 · 1승/);
    assert.deepEqual(M.sanitizePlatformStats({ pc: { team: { matches: -3, wins: 'x' } } }).pc.team, { matches: 0, wins: 0, kills: 0, deaths: 0, seconds: 0 });
  } finally {
    delete globalThis.localStorage;
  }
  // Auto quality: below low only when asked (touch); off = nothing below low, as before.
  const slow = (m) => {
    const out = [];
    for (let t = 0; t < 140; t += 1 / 20) {
      const d2 = m.frame(1 / 20, true);
      if (d2) out.push(d2.kind);
    }
    return out;
  };
  assert.deepEqual(slow(new M.AutoQualityMonitor('low', { level: null, ceiling: null })), []);
  const m = new M.AutoQualityMonitor('low', { level: null, ceiling: null });
  m.belowLow = true;
  assert.ok(slow(m).includes('floor'));
});

// --- in the game -----------------------------------------------------------------------------------

async function phone(opts = {}) {
  const page = await openGame(env, { mode: 'training', quality: 'low', width: 740, height: 360, mobile: true, ...opts });
  await page.tap('.play-button');
  await page.waitForFunction(() => window.game.input.active);
  await installFrameDriver(page);
  await page.evaluate(() => {
    window.T.stopLoop();
    window.T.run(30);
  });
  return page;
}

async function pc(opts = {}) {
  const page = await openGame(env, { mode: 'training', quality: 'low', width: 740, height: 360, ...opts });
  await installFrameDriver(page);
  await page.evaluate(() => {
    const g = window.game;
    window.T.stopLoop();
    // Playing without a real pointer lock (headless): the input counts as active.
    Object.defineProperty(g.input, 'active', { get: () => true });
    window.T.run(30);
  });
  return page;
}

/**
 * One training dummy right in front of the player (`yawOff` rad to the side, 8 m), the others far away;
 * the player's look input is `look` rad each frame from now on (a finger dragging, through the normal
 * input path). Returns nothing; read game.assistLast / the player's yaw.
 */
const stage = (page, { yawOff = 0.02, look = 0, dist = 8, behind = false, wall = false } = {}) =>
  page.evaluate(
    ({ yawOff, look, dist, behind, wall }) => {
      const g = window.game;
      const p = g.player;
      const targets = g.trainingRange.targets;
      const eye = p.position.clone();
      eye.y += p.eyeHeight;
      let d = dist;
      let a = p.yaw + yawOff + (behind ? Math.PI : 0);
      if (wall) {
        // A direction with a wall within 30 m: the dummy goes 2 m behind it.
        const dir = new eye.constructor();
        for (let i = 0; i < 64; i++) {
          const t = (i / 64) * Math.PI * 2;
          dir.set(-Math.sin(t), 0, -Math.cos(t));
          const hit = g.map.collision.raycast(eye, dir, 30);
          if (hit !== null && hit > 3) {
            a = t;
            d = hit + 2;
            p.yaw = t - yawOff;
            break;
          }
        }
      }
      for (const [i, t] of targets.entries()) {
        const at = i === 0 ? new eye.constructor(p.position.x - Math.sin(a) * d, p.position.y, p.position.z - Math.cos(a) * d) : new eye.constructor(p.position.x + 500, p.position.y - 200, p.position.z);
        t.base.copy(at);
        t.motion.sweep = 0;
        t['syncMatrices']();
      }
      p.pitch = Math.atan2(1.8 * 0.72 - p.eyeHeight, d);
      const poll = g.input.poll.bind(g.input);
      if (!g.__realPoll) g.__realPoll = poll;
      g.input.poll = (out) => {
        g.__realPoll(out);
        out.lookYaw += look;
      };
    },
    { yawOff, look, dist, behind, wall },
  );

const assistRun = (page, frames = 1) =>
  page.evaluate((frames) => {
    const g = window.game;
    let applied = 0;
    let candidates = 0;
    const y0 = g.player.yaw;
    for (let i = 0; i < frames; i++) {
      window.T.run(1);
      if (g.assistLast.applied) applied++;
      candidates = Math.max(candidates, g.assistLast.candidates);
    }
    return { applied, candidates, turned: g.player.yaw - y0, aids: g.mobileAids };
  }, frames);

test('9. in the game: a phone gets the weak assist near a dummy in view; none with the finger still, none for one behind the player or behind a wall or in smoke; a PC never; 0 = off', async () => {
  const page = await phone();
  try {
    // In view, 1.1° to the side, the finger dragging slowly toward it: helped.
    await stage(page, { yawOff: 0.02, look: 0.002 });
    const helped = await assistRun(page, 10);
    assert.equal(helped.aids, true);
    assert.ok(helped.candidates >= 1, JSON.stringify(helped));
    assert.ok(helped.applied >= 5, JSON.stringify(helped));
    // Finger still: the view does not move at all.
    await stage(page, { yawOff: 0.02, look: 0 });
    const still = await assistRun(page, 60);
    assert.equal(still.applied, 0);
    assert.equal(still.turned, 0, 'no input, no movement');
    // Behind the player (off screen): no candidate.
    await stage(page, { yawOff: 0.02, look: 0.002, behind: true });
    assert.deepEqual(await assistRun(page, 5).then((r) => [r.candidates, r.applied]), [0, 0]);
    // Behind a wall: no candidate.
    await stage(page, { yawOff: 0.01, look: 0.002, wall: true });
    assert.deepEqual(await assistRun(page, 5).then((r) => [r.candidates, r.applied]), [0, 0]);
    // In smoke: none.
    await stage(page, { yawOff: 0.02, look: 0.002 });
    await page.evaluate(() => {
      const g = window.game;
      g.__sb = g.grenades.sightBlocked;
      g.grenades.sightBlocked = () => true;
    });
    assert.deepEqual(await assistRun(page, 5).then((r) => [r.candidates, r.applied]), [0, 0]);
    await page.evaluate(() => (window.game.grenades.sightBlocked = window.game.__sb));
    // Off (0): nothing.
    await page.evaluate(() => (window.game.touchSettings.aimAssist = 0));
    await stage(page, { yawOff: 0.02, look: 0.002 });
    assert.equal((await assistRun(page, 10)).applied, 0);
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
  const desk = await pc();
  try {
    await stage(desk, { yawOff: 0.02, look: 0.002 });
    const r = await assistRun(desk, 20);
    assert.deepEqual([r.aids, r.applied], [false, 0], 'a PC: no aim assist');
    assert.deepEqual(desk.errors, []);
  } finally {
    await desk.context().close();
  }
});

/** The view's climb over a spray of `shots` rounds (rad), the shots fired and the damage profile used. */
const spray = (page, frames = 40) =>
  page.evaluate((frames) => {
    const g = window.game;
    const p = g.player;
    // Settle first (a spray before this one may still be recovering), then a fresh pattern.
    window.T.run(120);
    g.weapons.recoil.reset();
    const w = g.weapons.weapon;
    w.magazine = w.def.magazineSize;
    p.pitch = 0;
    p.yaw = 0;
    const climb = [];
    const n0 = g.weapons.shotsFired;
    const poll = g.input.poll.bind(g.input);
    g.input.poll = (out) => {
      poll(out);
      out.fire = true;
      out.lookYaw = out.lookPitch = 0;
    };
    for (let i = 0; i < frames; i++) {
      window.T.run(1);
      climb.push(p.pitch);
    }
    g.input.poll = poll;
    return { climb, shots: g.weapons.shotsFired - n0, weapon: w.def.id, damage: w.def.damage.base, rate: w.def.fireRate, scale: g.weapons.recoilScale };
  }, frames);

test('10. in the game: the recoil assist keeps the weapon’s own climb, at 65 % at full strength; a PC’s is unchanged; same shots, damage and rate of fire', async () => {
  const desk = await pc();
  const ph = await phone();
  try {
    const a = await spray(desk);
    await ph.evaluate(() => (window.game.touchSettings.recoilAssist = 1));
    const b = await spray(ph);
    await ph.evaluate(() => (window.game.touchSettings.recoilAssist = 0));
    const c = await spray(ph);
    assert.equal(a.scale, 1);
    assert.equal(+b.scale.toFixed(3), 0.65);
    assert.equal(c.scale, 1);
    assert.deepEqual([a.weapon, a.damage, a.rate, a.shots], [b.weapon, b.damage, b.rate, b.shots], 'same weapon, damage, fire rate and shots');
    assert.ok(a.shots > 3);
    const top = (x) => Math.max(...x.climb);
    assert.ok(top(a) > 0.01, 'the PC climbs as before');
    assert.ok(Math.abs(top(b) / top(a) - 0.65) < 0.03, `65 % of the climb (${(top(b) / top(a)).toFixed(3)})`);
    assert.ok(Math.abs(top(c) / top(a) - 1) < 0.02, 'off: the full climb');
    // The same shape: frame by frame the ratio holds while climbing.
    for (let i = 5; i < 25; i++) if (a.climb[i] > 0.003) assert.ok(Math.abs(b.climb[i] / a.climb[i] - 0.65) < 0.05, `frame ${i}`);
    assert.deepEqual([desk.errors, ph.errors], [[], []]);
  } finally {
    await desk.context().close();
    await ph.context().close();
  }
});

test('11. gyro: on, with readings the view turns (only while aiming when set so); no readings → unavailable, switched back off, touch carries on; a PC never', async () => {
  const page = await phone();
  try {
    // Nothing sends motion here (headless): switching it on finds no sensor.
    await page.evaluate(() => {
      const el = document.querySelector('input[data-touch-toggle="gyro"]');
      el.checked = true;
      el.dispatchEvent(new Event('change'));
    });
    await page.waitForFunction(() => window.game.gyro.status === 'checking', null, { timeout: 1000 });
    await page.waitForFunction(() => window.game.gyro.status === 'unsupported', null, { timeout: 5000 });
    const off = await page.evaluate(() => ({ setting: window.game.touchSettings.gyro, box: document.querySelector('input[data-touch-toggle="gyro"]').checked, text: document.querySelector('.gyro-status').textContent, active: window.game.input.active }));
    assert.deepEqual([off.setting, off.box, off.active], [0, false, true]);
    assert.match(off.text, /터치 조작으로 진행/);
    // A device that sends rotation: on; turning the phone turns the view.
    await page.evaluate(() => {
      const el = document.querySelector('input[data-touch-toggle="gyro"]');
      el.checked = true;
      el.dispatchEvent(new Event('change'));
    });
    // The sensor's readings (it sends them all the time) once the check listens.
    await page.waitForFunction(() => window.game.gyro.status === 'checking');
    await page.evaluate(() => window.dispatchEvent(new DeviceMotionEvent('devicemotion', { rotationRate: { alpha: 0, beta: 0, gamma: 0 }, interval: 16 })));
    assert.equal(await page.evaluate(() => window.game.gyro.status), 'on');
    const turn = (aim) =>
      page.evaluate(async (aim) => {
        const g = window.game;
        g.inputState.aim = false;
        const poll = g.input.poll.bind(g.input);
        g.input.poll = (out) => {
          poll(out);
          out.aim = aim;
        };
        const y0 = g.player.yaw;
        // 30°/s about the screen's up axis (landscape: device x = beta) for ~0.2 s.
        const angle = screen.orientation?.angle ?? 0;
        // The sensor's own clock: a reading every 16 ms however long this machine takes to draw a frame
        // (the event path itself was shown by the switch to 'on' above).
        const t0 = performance.now();
        for (let i = 0; i < 12; i++) {
          const rate = angle === 90 ? { alpha: 0, beta: 30, gamma: 0 } : angle === 270 ? { alpha: 0, beta: -30, gamma: 0 } : { alpha: 0, beta: 0, gamma: 30 };
          g.gyro.reading(rate.alpha, rate.beta, rate.gamma, t0 + i * 16);
          window.T.run(1);
        }
        g.input.poll = poll;
        return g.player.yaw - y0;
      }, aim);
    const free = await turn(false);
    assert.ok(free > 0.03, `turned left by the gyro (${free.toFixed(3)} rad)`);
    await page.evaluate(() => {
      const el = document.querySelector('input[data-touch-toggle="gyroAdsOnly"]');
      el.checked = true;
      el.dispatchEvent(new Event('change'));
    });
    assert.equal(Math.abs(await turn(false)) < 1e-6, true, 'aiming only: no turn while not aiming');
    assert.ok((await turn(true)) > 0.03, 'aiming: turns');
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
  const desk = await pc();
  try {
    const r = await desk.evaluate(() => {
      const g = window.game;
      g.touchSettings.gyro = 1;
      g.gyro.status = 'on';
      g.gyro.reading(0, 0, 30, 1000);
      g.gyro.reading(0, 0, 30, 1016);
      const y0 = g.player.yaw;
      window.T.run(1);
      return g.player.yaw - y0;
    });
    assert.equal(r, 0, 'a PC: the gyro never applies');
  } finally {
    await desk.context().close();
  }
});

test('12. touch HUD: left fire button fires; hold 무기 for the picker (lift on a weapon picks it), tap for the next; the reload button tells the ammo; small screens fit; the layout comes back after a reload', async () => {
  const page = await phone();
  try {
    const f = await fingers(page);
    // Left fire: off by default (not on the screen at all); on → shown, fires.
    assert.equal(await page.evaluate(() => document.querySelector('.tc-fire2')), null);
    await page.evaluate(() => {
      const el = document.querySelector('input[data-touch-toggle="leftFire"]');
      el.checked = true;
      el.dispatchEvent(new Event('change'));
    });
    const lf = await centre(page, '.tc-fire2');
    assert.ok(lf && lf.x < 740 * 0.3, JSON.stringify(lf));
    const before = await page.evaluate(() => window.game.weapons.shotsFired);
    await f.start(1, lf.x, lf.y);
    await page.evaluate(() => window.T.run(20));
    await f.end(1);
    assert.ok((await page.evaluate(() => window.game.weapons.shotsFired)) > before, 'the left button fires');
    // 무기 tap: the next weapon.
    const wb = await centre(page, '.tc-weapon');
    await f.tap(wb.x, wb.y);
    await page.evaluate(() => window.T.run(120));
    assert.equal(await page.evaluate(() => window.game.weapons.weapon.def.id), 'sr01');
    // Held: the picker; slide to the knife and let go.
    await f.start(2, wb.x, wb.y);
    await page.waitForTimeout(450);
    await page.evaluate(() => window.T.run(4)); // a hold: time and frames seen with the finger down
    assert.equal(await page.evaluate(() => window.game.input.touch.pickerOpen), true);
    const knife = await centre(page, '.tc-pick[data-pick="2"]');
    await f.move(2, knife.x, knife.y, 4);
    await f.end(2);
    await page.evaluate(() => window.T.run(120));
    const picked = await page.evaluate(() => ({ weapon: window.game.weapons.weapon.def.id, open: window.game.input.touch.pickerOpen }));
    assert.deepEqual(picked, { weapon: 'karambit', open: false });
    // Reload button: empty / low / reloading.
    const reloadState = () => page.evaluate(() => [...document.querySelector('.tc-reload').classList].filter((c) => ['low', 'empty', 'busy'].includes(c)).join(','));
    await page.evaluate(() => {
      const g = window.game;
      g.weapons.equipSlot(0);
      window.T.run(80);
      g.weapons.weapon.magazine = 0;
      window.T.run(1);
    });
    assert.equal(await reloadState(), 'empty');
    await page.evaluate(() => {
      window.game.weapons.weapon.magazine = 5;
      window.T.run(1);
    });
    assert.equal(await reloadState(), 'low');
    const rb = await centre(page, '.tc-reload');
    await f.tap(rb.x, rb.y);
    await page.evaluate(() => window.T.run(10));
    assert.equal(await reloadState(), 'busy');
    // 앉기: a tap toggles, a long hold stands up on release.
    const cb = await centre(page, '.tc-crouch');
    await f.tap(cb.x, cb.y);
    await page.evaluate(() => window.T.run(2));
    assert.equal(await page.evaluate(() => window.game.inputState.crouch), true);
    await f.tap(cb.x, cb.y);
    await page.evaluate(() => window.T.run(2));
    await f.start(3, cb.x, cb.y);
    await page.waitForTimeout(450);
    await page.evaluate(() => window.T.run(4));
    assert.equal(await page.evaluate(() => window.game.inputState.crouch), true, 'held: crouched');
    await f.end(3);
    await page.evaluate(() => window.T.run(2));
    assert.equal(await page.evaluate(() => window.game.inputState.crouch), false, 'let go: standing');
    // A layout with the left button moved: kept after a reload.
    await page.evaluate(() => localStorage.setItem('tactical-fps.touch-layout.v1', JSON.stringify({ v: 1, controls: { fire2: { x: 0.12, y: 0.35, size: 1.2, opacity: 0.8 } } })));
    await page.reload();
    await waitReady(page);
    await page.tap('.play-button');
    await page.waitForFunction(() => window.game.input.active);
    const kept = await page.evaluate(() => {
      const el = document.querySelector('.tc-fire2');
      const r = el.getBoundingClientRect();
      return { shown: !!el?.isConnected && !el.hidden, placed: el.classList.contains('placed'), x: (r.left + r.width / 2) / innerWidth, leftFire: window.game.touchSettings.leftFire };
    });
    assert.deepEqual([kept.shown, kept.placed, kept.leftFire], [true, true, 1]);
    assert.ok(Math.abs(kept.x - 0.12) < 0.05, JSON.stringify(kept));
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
  // Small and unusual screens: the cluster stays on screen, below the top bar and clear of the stick's side.
  for (const [w, h] of [
    [568, 320],
    [740, 360],
    [915, 412],
    [1024, 600],
    [640, 480],
  ]) {
    const p = await phone({ width: w, height: h });
    try {
      const r = await p.evaluate(() => {
        const top = document.querySelector('.tc-top').getBoundingClientRect();
        const rects = [...document.querySelectorAll('.tc-cluster .tc-btn')].filter((b) => !b.hidden).map((b) => b.getBoundingClientRect());
        const out = rects.filter((b) => b.left < 0 || b.top < 0 || b.right > innerWidth + 0.5 || b.bottom > innerHeight + 0.5).length;
        const underTop = rects.filter((b) => b.top < top.bottom).length;
        const stickSide = rects.filter((b) => b.left < innerWidth * 0.42 - 0.5).length;
        return { out, underTop, stickSide, fit: window.game.input.touch.fit };
      });
      assert.deepEqual([r.out, r.underTop, r.stickSide], [0, 0, 0], `${w}×${h}: ${JSON.stringify(r)}`);
      assert.ok(r.fit >= 0.7 && r.fit <= 1);
    } finally {
      await p.context().close();
    }
  }
});

test('7. mobile settings: a preset sets several at once and is kept after a reload; the battery saver caps at 30 FPS (auto quality not misled) and lowers the pixels; off again restores', async () => {
  const page = await phone();
  try {
    await page.evaluate(() => {
      document.querySelector('select[data-touch-preset]').value = 'precise';
      document.querySelector('.touch-preset-apply').click();
    });
    const t = await page.evaluate(() => window.game.touchSettings);
    assert.deepEqual([t.lookSensitivity, t.aimAssist, t.recoilAssist], [0.8, 0.7, 0.7]);
    const pr0 = await page.evaluate(() => window.game.renderer.getPixelRatio());
    await page.evaluate(() => {
      const el = document.querySelector('input[data-touch-toggle="batterySaver"]');
      el.checked = true;
      el.dispatchEvent(new Event('change'));
    });
    const saving = await page.evaluate(() => ({ cap: window.game.loop.cap, limit: window.game.loop.frameLimit, stored: JSON.parse(localStorage.getItem('tactical-fps.settings.v1') ?? '{}').frameLimit ?? 'max', pr: window.game.renderer.getPixelRatio(), perf: window.game.perfPriority }));
    assert.equal(saving.cap, 30);
    assert.equal(saving.limit, 'max', "the player's own frame limit is kept");
    assert.equal(saving.perf, true);
    assert.ok(saving.pr < pr0, `fewer pixels (${saving.pr} < ${pr0})`);
    await page.reload();
    await waitReady(page);
    const back = await page.evaluate(() => ({ t: window.game.touchSettings, cap: window.game.loop.cap }));
    assert.deepEqual([back.t.lookSensitivity, back.t.aimAssist, back.t.batterySaver, back.cap], [0.8, 0.7, 1, 30]);
    await page.evaluate(() => {
      const el = document.querySelector('input[data-touch-toggle="batterySaver"]');
      el.checked = false;
      el.dispatchEvent(new Event('change'));
    });
    assert.equal(await page.evaluate(() => window.game.loop.cap), null);
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
  const desk = await pc();
  try {
    const r = await desk.evaluate(() => {
      const g = window.game;
      g.touchSettings.batterySaver = 1;
      g['applyPower']();
      return { cap: g.loop.cap, saving: g.powerSaving };
    });
    assert.deepEqual(r, { cap: null, saving: false }, 'a PC: no battery saver');
  } finally {
    await desk.context().close();
  }
});

// --- rooms with real browsers ----------------------------------------------------------------------

const enter = async (p, name, how, { mode = 'deathmatch', pool = 'mixed', code } = {}) => {
  const click = (sel) => (p.__mobile ? p.tap(sel) : p.click(sel));
  await click('#tab-multi');
  await p.fill('.mp-name', name);
  await p.selectOption('.mp-mode', mode);
  await p.selectOption('.mp-pool', pool);
  if (how === 'join') await p.fill('.mp-code', code);
  await click(how === 'join' ? '.mp-join-btn' : how === 'quick' ? '.mp-quick' : '.mp-create');
};
const inRoom = (p) => p.waitForFunction(() => (window.game.netHost || window.game.netClient?.myId) && window.game.match);
const roomOf = (p) => p.evaluate(() => ({ code: window.game.net?.room?.code ?? null, pool: window.game.net?.room?.pool ?? null, platform: window.game.net?.platform ?? null, members: window.game.net?.room?.members.map((m) => m.platform).sort() ?? [] }));

test('3 / 4 / 5 / 7 / 8. rooms: a PC and a phone quick-join one mixed room; a phone-only room refuses a PC by code (and the other way); host hand-over and rejoin keep the pool; the network line shows', async () => {
  const desk = await openGame(env, { mode: 'training', width: 740, height: 360 });
  const ph = await openGame(env, { mode: 'training', width: 740, height: 360, mobile: true });
  const ph2 = await openGame(env, { mode: 'training', width: 740, height: 360, mobile: true });
  ph.__mobile = ph2.__mobile = true;
  const all = [desk, ph, ph2];
  for (const p of all) p.setDefaultTimeout(60000);
  try {
    // Mixed (the default): both in one room.
    await enter(desk, 'Desk', 'quick');
    await inRoom(desk);
    await enter(ph, 'Phone', 'quick');
    await inRoom(ph);
    const a = await roomOf(desk);
    const b = await roomOf(ph);
    assert.equal(a.code, b.code);
    assert.deepEqual([a.pool, a.platform, b.platform], ['mixed', 'pc', 'mobile']);
    await desk.waitForFunction(() => window.game.net.room.members.length === 2);
    assert.deepEqual((await roomOf(desk)).members, ['mobile', 'pc']);
    assert.match(await desk.textContent('.mp-room-pool'), /통합.*PC 1 · 모바일 1/);
    // The phone in a mixed room has its aids (a mobile player); the PC none.
    assert.deepEqual([await ph.evaluate(() => window.game.mobileAids), await desk.evaluate(() => window.game.mobileAids)], [true, false]);
    // Network line in play.
    await desk.click('#tab-play');
    await desk.click('.play-button').catch(() => {});
    await ph.waitForFunction(() => {
      const el = document.querySelector('.net-status');
      return el && !el.hidden && /ms|지연/.test(el.textContent);
    });
    // Phone-only room: the second phone makes one; the PC is refused by its code (with the reason shown).
    await enter(ph2, 'Phone2', 'create', { pool: 'mobile' });
    await inRoom(ph2);
    const mobileRoom = await roomOf(ph2);
    assert.equal(mobileRoom.pool, 'mobile');
    await desk.evaluate(() => window.game.input.release()); // back to the menu (as pause does)
    await desk.click('#tab-multi');
    await desk.waitForSelector('.mp-leave', { state: 'visible' });
    await desk.click('.mp-leave');
    await enter(desk, 'Desk', 'join', { code: mobileRoom.code });
    await desk.waitForFunction(() => /플랫폼/.test(document.querySelector('.mp-error').textContent));
    assert.equal(await desk.evaluate(() => window.game.net?.room ?? null), null, 'not let in');
    // The PC-only pool: refused for a phone in the menu itself (the hint) and by the relay.
    await ph.tap('.mp-leave');
    await ph.selectOption('.mp-pool', 'pc');
    assert.match(await ph.textContent('.mp-pool-hint'), /들어갈 수 없습니다/);
    await ph.tap('.mp-create');
    await ph.waitForFunction(() => /플랫폼/.test(document.querySelector('.mp-error').textContent));
    // The first phone joins the phone room by code; the room's host (phone 2) leaves: phone 1 hosts, the pool stays.
    await enter(ph, 'Phone', 'join', { code: mobileRoom.code, pool: 'mixed' });
    await inRoom(ph);
    await ph2.tap('.mp-leave');
    await ph.waitForFunction(() => window.game.netHost && window.game.net.room.members.length === 1);
    assert.equal((await roomOf(ph)).pool, 'mobile');
    // Rejoin by code: phone 2 comes back into the same phone room.
    await enter(ph2, 'Phone2', 'join', { code: mobileRoom.code });
    await inRoom(ph2);
    assert.deepEqual(await roomOf(ph2).then((r) => [r.code, r.pool, r.members]), [mobileRoom.code, 'mobile', ['mobile', 'mobile']]);
    for (const p of all) assert.deepEqual(p.errors, []);
  } finally {
    for (const p of all) await p.context().close();
  }
});

test('6 / 8. a party of a PC and a phone: formed by code, the phone waits for the leader; the leader’s quick join (asking PC only) takes both into one mixed room; the leader leaving hands the room over', async () => {
  const desk = await openGame(env, { mode: 'training', width: 740, height: 360 });
  const ph = await openGame(env, { mode: 'training', width: 740, height: 360, mobile: true });
  ph.__mobile = true;
  const all = [desk, ph];
  for (const p of all) p.setDefaultTimeout(60000);
  try {
    await desk.click('#tab-multi');
    await desk.fill('.mp-name', 'Leader');
    await desk.click('.mp-party-create');
    await desk.waitForSelector('.mp-party-in:not([hidden])');
    const code = (await desk.textContent('.mp-party-code-shown')).trim();
    assert.equal(code.length, 6);
    await ph.tap('#tab-multi');
    await ph.fill('.mp-name', 'Phone');
    await ph.fill('.mp-party-code', code);
    await ph.tap('.mp-party-join');
    await ph.waitForSelector('.mp-party-in:not([hidden])');
    await desk.waitForFunction(() => document.querySelectorAll('.mp-party-members li').length === 2);
    const member = await ph.evaluate(() => ({ quick: document.querySelector('.mp-quick').disabled, create: document.querySelector('.mp-create').disabled, note: document.querySelector('.mp-party-note').textContent }));
    assert.deepEqual([member.quick, member.create], [true, true], 'only the leader picks the room');
    assert.match(member.note, /파티장이 방을 고르면/);
    assert.deepEqual(await desk.evaluate(() => [...document.querySelectorAll('.mp-party-members [data-platform]')].map((li) => li.dataset.platform)), ['pc', 'mobile']);
    // The leader asks for PC only: a mixed party plays mixed; both go in.
    await desk.selectOption('.mp-pool', 'pc');
    assert.match(await desk.textContent('.mp-pool-hint'), /통합 매칭으로 들어갑니다/);
    await desk.selectOption('.mp-mode', 'deathmatch');
    await desk.click('.mp-quick');
    await inRoom(desk);
    await inRoom(ph);
    const a = await roomOf(desk);
    const b = await roomOf(ph);
    assert.equal(a.code, b.code);
    assert.equal(a.pool, 'mixed');
    assert.equal(await desk.evaluate(() => window.game.net.isHost), true);
    assert.equal(await ph.evaluate(() => !!window.game.netClient), true);
    // The phone plays as a mobile player in the host's match (a seat of its own).
    await desk.waitForFunction(() => window.game.squad.bots.some((x) => x.remote));
    // The leader leaves the room: the phone hosts it now, in the same room, the party still there.
    await desk.click('.mp-leave');
    await ph.waitForFunction(() => window.game.netHost && window.game.net.room.members.length === 1);
    assert.equal((await roomOf(ph)).code, a.code);
    assert.equal(await ph.evaluate(() => window.game.net.party?.members.length), 2);
    for (const p of all) assert.deepEqual(p.errors, []);
  } finally {
    for (const p of all) await p.context().close();
  }
});

test('8 (fair play). weapon data, health, movement and prices are one table for both platforms', async () => {
  const page = await phone();
  try {
    const r = await page.evaluate(async () => {
      const g = window.game;
      const { WEAPONS } = await import('/src/weapons/weapons.ts');
      const { PLAYER_CONFIG } = await import('/src/config.ts');
      return {
        weapons: Object.fromEntries(Object.values(WEAPONS).map((w) => [w.id, [w.damage.base, w.fireRate, w.price ?? null]])),
        hp: g.combat.maxHealth ?? PLAYER_CONFIG.maxHealth,
        run: PLAYER_CONFIG.runSpeed,
        jump: PLAYER_CONFIG.jumpSpeed ?? PLAYER_CONFIG.jumpVelocity ?? null,
      };
    });
    const node = {
      weapons: Object.fromEntries(Object.values(M.WEAPONS).map((w) => [w.id, [w.damage.base, w.fireRate, w.price ?? null]])),
    };
    assert.deepEqual(r.weapons, node.weapons);
    assert.equal(r.hp, 100);
    assert.ok(r.run > 0);
  } finally {
    await page.context().close();
  }
});
