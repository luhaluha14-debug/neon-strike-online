/* =========================================================================
   Online protocol, shared by server and client.

   The server runs the real Match.  Every client builds an identical "mirror"
   Match from the same start options (seed, humans, bot count, team size):
   loot, vehicles, spawn points, names and ids come out the same, so only the
   things that change have to be sent.

   client -> server   {t:'in', s:seq, c:cmd}          one per client tick (60 Hz)
                      {t:'act', a:'pick'|'drop'|'opts', ...}
   server -> client   {t:'start', ...}                match options + your id
                      {t:'s', ...}                    snapshot, 20 Hz
   ========================================================================= */
import { newInventory } from './items.js';

export const PROTOCOL = 3;
export const SNAP_EVERY = 3;              // server ticks per snapshot (60 / 3 = 20 Hz)
export const INTERP_DELAY = 0.1;          // remote players are drawn this far in the past (s)

const STANCE = ['stand', 'crouch', 'prone'];
const AIR = [null, 'plane', 'fall', 'chute'];
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

/* ---------------- players ---------------- */
export function packPlayer(p) {
  const b = p.body;
  const f = (p.alive ? 1 : 0) | (p.downed ? 2 : 0) | (p.ads ? 4 : 0) | (b.sprinting ? 8 : 0) | (p.reloading ? 16 : 0) |
    (b.onGround ? 32 : 0) | (p.throwHold ? 64 : 0) | (p.using ? 128 : 0) | (p.inStorm ? 256 : 0) |
    (STANCE.indexOf(b.stance) << 9) | (AIR.indexOf(p.air) << 11);
  const s = p.cur === 4 ? p.throwType || '' : p.slots[p.cur] ? p.slots[p.cur].id : 'fists';
  return [p.id, r2(b.pos.x), r2(b.pos.y), r2(b.pos.z), r3(p.yaw), r3(p.pitch), f, Math.ceil(p.hp), Math.ceil(p.dhp), p.cur, s,
    p.veh ? p.veh.id : 0, p.veh ? p.veh.seat : 0, r2(b.moveSpeed), r3(p.aimYaw), r3(p.aimPitch), p.kills, p.place,
    r2(b.vel.x), r2(b.vel.y), r2(b.vel.z), r2(p.adsT), p.shots];
}

/** apply everything except the position (the client interpolates that) */
export function unpackPlayer(p, a) {
  const f = a[6], b = p.body;
  p.alive = !!(f & 1); p.downed = !!(f & 2); p.ads = !!(f & 4); b.sprinting = !!(f & 8); p.reloading = !!(f & 16);
  b.onGround = !!(f & 32); p.throwHold = !!(f & 64); p.inStorm = !!(f & 256);
  if (!(f & 128)) p.using = null; else if (!p.using) p.using = { key: 'bandage', t: 0, dur: 1 };
  b.stance = STANCE[(f >> 9) & 3] || 'stand';
  p.air = AIR[(f >> 11) & 3];
  p.hp = a[7]; p.dhp = a[8];
  p.cur = a[9];
  if (p.cur === 4) p.throwType = a[10] || null;
  else if (!p.slots[p.cur] || p.slots[p.cur].id !== a[10]) {
    if (a[10] === 'fists') p.cur = 3;
    else p.slots[p.cur] = { id: a[10], mag: p.slots[p.cur] ? p.slots[p.cur].mag : 0 };
  }
  p.veh = a[11] ? { id: a[11], seat: a[12] } : null;
  b.moveSpeed = a[13]; p.aimYaw = a[14]; p.aimPitch = a[15]; p.kills = a[16]; p.place = a[17];
  b.vel.x = a[18]; b.vel.y = a[19]; b.vel.z = a[20]; p.adsT = a[21]; p.shots = a[22];
}

/** private state only the owner receives */
export function packMe(p, ack) {
  const b = p.body;
  return {
    ack,
    b: [r3(b.pos.x), r3(b.pos.y), r3(b.pos.z), r3(b.vel.x), r3(b.vel.y), r3(b.vel.z), b.onGround ? 1 : 0, b.stance, r3(b.stanceLock), b.sprinting ? 1 : 0,
      r3(b.airTime), r3(b.landT), r3(b.lastImpact), r3(b.moveSpeed), r3(b.jumpCd)],
    inv: p.inv.items, slots: p.slots, cur: p.cur, tt: p.throwType,
    rl: p.reloading ? [r2(p.reloadT), r2(p.reloadTotal)] : 0,
    use: p.using ? [p.using.key, r2(p.using.t), p.using.dur] : 0,
    sw: r2(p.switchT), bl: r2(p.blindT), dmg: Math.round(p.dmgDealt), bloom: r3(p.bloom), fcd: r3(p.fireCd),
    rv: p.reviving ? [p.reviving.id, r2(p.reviving.t)] : 0, rvb: p.revivedBy || 0,
    lh: r2(p.lastHitT), ls: r2(p.lastShotT), buf: p.buf
  };
}
export function unpackMe(p, o) {
  p.inv.items = o.inv; p.slots = o.slots; p.cur = o.cur; p.throwType = o.tt;
  p.reloading = !!o.rl; if (o.rl) { p.reloadT = o.rl[0]; p.reloadTotal = o.rl[1]; }
  p.using = o.use ? { key: o.use[0], t: o.use[1], dur: o.use[2] } : null;
  p.switchT = o.sw; p.blindT = o.bl; p.dmgDealt = o.dmg; p.bloom = o.bloom; p.fireCd = o.fcd;
  p.reviving = o.rv ? { id: o.rv[0], t: o.rv[1] } : null; p.revivedBy = o.rvb || null;
  p.lastHitT = o.lh; p.lastShotT = o.ls; p.buf = o.buf;
}
export function applyBody(b, a) {
  b.pos.x = a[0]; b.pos.y = a[1]; b.pos.z = a[2]; b.vel.x = a[3]; b.vel.y = a[4]; b.vel.z = a[5];
  b.onGround = !!a[6]; b.stance = a[7]; b.stanceLock = a[8]; b.sprinting = !!a[9];
  b.airTime = a[10]; b.landT = a[11]; b.lastImpact = a[12]; b.moveSpeed = a[13]; b.jumpCd = a[14];
}

/* ---------------- world ---------------- */
export function packVehicle(v) {
  return [v.id, r2(v.x), r2(v.y), r2(v.z), r3(v.yaw), r2(v.speed), Math.round(v.hp), r2(v.fuel), v.dead ? 1 : 0, r3(v.pitch), r3(v.roll), r3(v.steer), v.seats.map((s) => s || 0), v.onGround ? 1 : 0];
}
export function unpackVehicle(v, a) {
  v.speed = a[5]; v.hp = a[6]; v.fuel = a[7]; v.dead = !!a[8]; v.pitch = a[9]; v.roll = a[10]; v.steer = a[11];
  v.seats = a[12].map((s) => s || null); v.onGround = !!a[13];
}

export function packWorld(m) {
  const z = m.zone;
  return {
    time: r3(m.time), tick: m.tick, state: m.state, winner: m.winner ?? null, wt: m.winnerTeam ?? null,
    zone: [z.phase, z.stage, r2(z.timer), r2(z.cur.x), r2(z.cur.z), r2(z.cur.r), r2(z.next.x), r2(z.next.z), r2(z.next.r)],
    plane: m.plane ? [r2(m.plane.d), m.plane.inside ? 1 : 0, m.plane.left ? 1 : 0, m.plane.done ? 1 : 0] : 0,
    sup: {
      planes: m.supply.planes.map((p) => ({ ...p, x: r2(p.x), z: r2(p.z), d: r2(p.d) })),
      crates: m.supply.crates.map((c) => ({ ...c, y: r2(c.y) }))
    },
    pr: m.projectiles.map((g) => [g.id, g.type, r2(g.x), r2(g.y), r2(g.z), g.rest ? 1 : 0]),
    fi: m.fires.map((f) => [r2(f.x), r2(f.y), r2(f.z), r2(f.r), r2(f.t)]),
    sm: m.smokes.map((s) => [r2(s.x), r2(s.y), r2(s.z), r2(s.r), r2(s.t), s.maxR]),
    v: m.vehicles.map(packVehicle),
    p: m.players.map(packPlayer)
  };
}

/** zone / plane / supply / throwables: copied straight into the mirror */
export function applyWorld(m, s) {
  m.time = s.time; m.tick = s.tick; m.state = s.state;
  if (s.winner !== null) m.winner = s.winner;
  if (s.wt !== null) m.winnerTeam = s.wt;
  const z = m.zone, a = s.zone;
  z.phase = a[0]; z.stage = a[1]; z.timer = a[2];
  z.cur.x = a[3]; z.cur.z = a[4]; z.cur.r = a[5]; z.next.x = a[6]; z.next.z = a[7]; z.next.r = a[8];
  if (m.plane && s.plane) {
    m.plane.inside = !!s.plane[1]; m.plane.left = !!s.plane[2]; m.plane.done = !!s.plane[3];
  }
  m.supply.planes = s.sup.planes; m.supply.crates = s.sup.crates;
  // keep grenade objects (the renderer keys meshes by id)
  const old = new Map(m.projectiles.map((g) => [g.id, g]));
  m.projectiles = s.pr.map(([id, type, x, y, z2, rest]) => { const g = old.get(id) || { id, type }; g.tx = x; g.ty = y; g.tz = z2; if (g.x === undefined) { g.x = x; g.y = y; g.z = z2; } g.rest = !!rest; return g; });
  // smoke clouds are keyed by object identity in the effects pool: reuse by position
  const oldSm = m.smokes;
  m.smokes = s.sm.map(([x, y, z2, r, t, maxR]) => { const o = oldSm.find((q) => q.x === x && q.z === z2) || { x, y, z: z2 }; o.r = r; o.t = t; o.maxR = maxR; return o; });
  m.fires = s.fi.map(([x, y, z2, r, t]) => ({ x, y, z: z2, r, t }));
}

/** items that appeared after the start come with their full data */
export function itemData(it) { return { id: it.id, key: it.key, count: it.count, mag: it.mag, x: r3(it.x), y: r3(it.y), z: r3(it.z), supply: it.supply || false }; }

/** events are sent as-is, except that item events carry the item itself */
export function enrichEvent(m, e) {
  if (e.t === 'itemAdd' || e.t === 'itemUpdate') { const it = m.itemById.get(e.id); return it ? { ...e, item: itemData(it) } : e; }
  return e;
}

/** keep the mirror's ground items in step with the server */
export function applyItemEvent(m, e) {
  if (e.t === 'itemAdd' || e.t === 'itemUpdate') {
    if (!e.item) return;
    const old = m.itemById.get(e.id);
    if (old) Object.assign(old, e.item);
    else { const it = { ...e.item }; if (!it.supply) delete it.supply; m.items.push(it); m.itemById.set(it.id, it); }
  } else if (e.t === 'itemRemove') {
    const it = m.itemById.get(e.id);
    if (it) m.removeItem(it);
  }
}

/** a player the server took over (disconnect) or a fresh mirror player */
export function resetInventory(p) { p.inv = newInventory(); }

/* ---------------- room / lobby ---------------- */
export const MODES = { 1: '솔로', 2: '듀오', 4: '스쿼드' };
export const ROOM_MAX = 16;               // humans per room
export const ROOM_FILL = 24;              // bots fill the match up to this many players
