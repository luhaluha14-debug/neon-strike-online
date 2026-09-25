/* =========================================================================
   Match simulation (authoritative game rules).
   Runs in the browser for offline play and will run unchanged on the server
   for online play.  Owns: players, bullets, ground items, zone, win check.
   Input = per-tick commands.  Output = state + a queue of events for FX/UI.
   ========================================================================= */
import { clamp, makeRng, hashInts, dirFromAngles, DEG, wrapAngle } from './util.js';
import { newBody, stepBody, setStance, eyeHeight, proneFits, MOVE } from './movement.js';
import { WEAPONS, falloffMul } from './weapons.js';
import { ITEMS, newInventory, invAdd, invTake, invCount, invRoomFor, rollLoot, rollSupply } from './items.js';
import { Zone } from './zone.js';
import { BotBrain } from './ai.js';
import { Plane, PLANE, stepAir } from './plane.js';
import { THROWABLES, THROW_ORDER, throwLaunch, stepProjectile, smokeBlocks } from './throwables.js';
import { VEHICLES, VEHICLE_TYPES, newVehicle, stepVehicle, vehToWorld, worldToVeh, vehCircles, vehDistance, rayVehicle } from './vehicles.js';
import { roadDist } from './mapgen.js';

export const TICK = 1 / 60;
export const CRATE_H = 1.05;          // supply crate height (items rest on top)
/** loot density: chance a spot has loot at all, and chances of extra item groups (by tier 0..3) */
export const LOOT_CHANCE = [0.8, 0.95, 1, 1];
export const LOOT_EXTRA = [[0.3], [0.5, 0.2], [0.6, 0.3], [0.7, 0.4]];
export const MAX_HP = 100;

const BOT_NAMES = ['Rook', 'Vesper', 'Kite', 'Mako', 'Halden', 'Juno', 'Brask', 'Tamsin', 'Oriel', 'Pike', 'Sable', 'Wren',
  'Doss', 'Lyle', 'Marrow', 'Quill', 'Nadir', 'Corvin', 'Isko', 'Tarn', 'Ember', 'Fenn', 'Garnet', 'Hollis', 'Ivo', 'Jett',
  'Kasimir', 'Lark', 'Moth', 'Nox', 'Odette', 'Pell', 'Rhune', 'Sten', 'Thea', 'Ulric', 'Vale', 'Wick', 'Yara', 'Zeph',
  'Ansel', 'Birch', 'Cato', 'Delta', 'Esk', 'Flint', 'Gale', 'Hask', 'Ilse'];

const SKINS = [0x5e6b4f, 0x6b5a45, 0x4f5d6b, 0x7a6f58, 0x505050, 0x6a4d4d, 0x4d6a63, 0x5d5872];

/* ---------------- hitboxes (local space, yaw-rotated, forward = -Z) ---------------- */
const HITBOX = {
  stand: { head: [0, 1.62, 0, 0.15], torso: [-0.27, 0.86, -0.16, 0.27, 1.5, 0.16], legs: [-0.2, 0, -0.14, 0.2, 0.86, 0.14] },
  crouch: { head: [0, 1.08, -0.1, 0.15], torso: [-0.27, 0.5, -0.24, 0.27, 0.98, 0.18], legs: [-0.22, 0, -0.32, 0.22, 0.5, 0.3] },
  prone: { head: [0, 0.3, -0.86, 0.15], torso: [-0.27, 0.04, -0.72, 0.27, 0.44, 0.1], legs: [-0.22, 0, 0.1, 0.22, 0.3, 0.98] }
};

function rayAABB(ox, oy, oz, dx, dy, dz, b, maxT) {
  let t0 = 0, t1 = maxT;
  for (let a = 0; a < 3; a++) {
    const o = a === 0 ? ox : a === 1 ? oy : oz, d = a === 0 ? dx : a === 1 ? dy : dz;
    const mn = b[a], mx = b[a + 3];
    if (Math.abs(d) < 1e-9) { if (o < mn || o > mx) return -1; continue; }
    let ta = (mn - o) / d, tb = (mx - o) / d;
    if (ta > tb) { const q = ta; ta = tb; tb = q; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return -1;
  }
  return t0;
}
function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r, maxT) {
  const lx = ox - cx, ly = oy - cy, lz = oz - cz;
  const b = lx * dx + ly * dy + lz * dz;
  const c = lx * lx + ly * ly + lz * lz - r * r;
  const disc = b * b - c;
  if (disc < 0) return -1;
  let t = -b - Math.sqrt(disc);
  if (t < 0) t = (c < 0) ? 0 : -1;
  return t >= 0 && t <= maxT ? t : -1;
}

/** ray vs a player's hitboxes. returns {t, part} or null */
export function rayHitPlayer(p, ox, oy, oz, dx, dy, dz, maxT) {
  const hb = HITBOX[p.body.stance];
  const cy = Math.cos(p.yaw), sy = Math.sin(p.yaw);
  const wx = ox - p.body.pos.x, wy = oy - p.body.pos.y, wz = oz - p.body.pos.z;
  const lox = wx * cy - wz * sy, loz = wx * sy + wz * cy;
  const ldx = dx * cy - dz * sy, ldz = dx * sy + dz * cy;
  let best = -1, part = null;
  const h = hb.head;
  let t = raySphere(lox, wy, loz, ldx, dy, ldz, h[0], h[1], h[2], h[3], maxT);
  if (t >= 0) { best = t; part = 'head'; }
  t = rayAABB(lox, wy, loz, ldx, dy, ldz, hb.torso, best >= 0 ? best : maxT);
  if (t >= 0 && (best < 0 || t < best)) { best = t; part = 'torso'; }
  t = rayAABB(lox, wy, loz, ldx, dy, ldz, hb.legs, best >= 0 ? best : maxT);
  if (t >= 0 && (best < 0 || t < best)) { best = t; part = 'legs'; }
  return best >= 0 ? { t: best, part } : null;
}

export function headPos(p) {
  const h = HITBOX[p.body.stance].head;
  const cy = Math.cos(p.yaw), sy = Math.sin(p.yaw);
  return { x: p.body.pos.x + h[0] * cy + h[2] * sy, y: p.body.pos.y + h[1], z: p.body.pos.z - h[0] * sy + h[2] * cy };
}
export function chestPos(p) {
  const tb = HITBOX[p.body.stance].torso;
  const lz = (tb[2] + tb[5]) / 2;
  const cy = Math.cos(p.yaw), sy = Math.sin(p.yaw);
  return { x: p.body.pos.x + lz * sy, y: p.body.pos.y + (tb[1] + tb[4]) / 2, z: p.body.pos.z + lz * cy };
}

/* ======================================================================= */
export class Match {
  /**
   * @param {object} o
   * @param {World} o.world
   * @param {NavGrid} o.nav
   * @param {number} o.seed
   * @param {number} o.bots           number of bots
   * @param {string} o.difficulty     easy | normal | hard
   * @param {Array}  o.humans         [{id,name}]
   */
  constructor(o) {
    this.world = o.world;
    this.nav = o.nav;
    this.seed = o.seed >>> 0;
    this.rng = makeRng(this.seed);
    this.time = 0;
    this.tick = 0;
    this.state = 'playing';
    this.winner = null;
    this.events = [];
    this.players = [];
    this.byId = new Map();
    this.items = [];
    this.itemById = new Map();
    this.bullets = [];
    this.projectiles = [];     // thrown grenades in flight / on the ground
    this.smokes = [];          // {x,y,z,r,t}
    this.fires = [];           // {x,y,z,r,t,owner}
    this.vehicles = [];
    this.vehById = new Map();
    this.supply = { planes: [], crates: [], at: null };   // supply drops
    this.world.dyn = [];
    this.nextId = 1;
    this.difficulty = o.difficulty || 'normal';
    this.zone = new Zone(makeRng(this.seed ^ 0x9e3779b9), this.world.playLimit || this.world.half, o.zonePhases);
    this.cheats = { god: new Set(), infAmmo: new Set() };
    this.deaths = 0;

    this.spawnLoot();
    if (o.vehicles !== false) this.spawnVehicles();
    const spots = this.pickSpawns((o.humans ? o.humans.length : 0) + (o.bots || 0));
    let si = 0;
    for (const h of o.humans || []) this.addPlayer({ id: h.id, name: h.name, isBot: false, spot: spots[si++] });
    const names = BOT_NAMES.slice();
    for (let i = 0; i < (o.bots || 0); i++) {
      const nm = names.splice(this.rng.int(0, names.length - 1), 1)[0] || ('Bot' + i);
      const p = this.addPlayer({ name: nm, isBot: true, spot: spots[si++] });
      p.brain = new BotBrain(this, p, o.difficulty || 'normal', this.rng.next());
    }
    // battle royale start: everyone boards the transport plane (drop:false = spawn on the ground)
    this.plane = null;
    if (o.drop !== false) {
      this.plane = new Plane(makeRng(this.seed ^ 0x5bd1e995), this.world.playLimit || this.world.half);
      for (const p of this.players) {
        p.air = 'plane';
        p.body.pos.x = this.plane.x; p.body.pos.y = this.plane.alt; p.body.pos.z = this.plane.z;
        p.body.onGround = false;
        p.yaw = this.plane.yaw;
        if (p.brain) p.brain.planDrop(this.plane);
      }
    }
  }

  /** number of players still on board */
  onBoard() { let n = 0; for (const p of this.players) if (p.alive && p.air === 'plane') n++; return n; }

  emit(e) { this.events.push(e); }
  drainEvents() { const e = this.events; this.events = []; return e; }

  /* ---------------- setup ---------------- */
  pickSpawns(n) {
    const pool = this.world.spawnSpots.slice();
    const out = [];
    let minD = 38;
    while (out.length < n && minD > 4) {
      for (let tries = 0; tries < 400 && out.length < n; tries++) {
        const s = pool[this.rng.int(0, pool.length - 1)];
        if (out.every((o) => Math.hypot(o.x - s.x, o.z - s.z) >= minD)) out.push(s);
      }
      minD *= 0.7;
    }
    while (out.length < n) out.push(pool[this.rng.int(0, pool.length - 1)]);
    return out;
  }

  addPlayer({ id, name, isBot, spot }) {
    const pid = id !== undefined ? id : this.nextId++;
    if (typeof pid === 'number' && pid >= this.nextId) this.nextId = pid + 1;
    const g = this.world.supportHeight(spot.x, spot.z, 0.3, 1e4, 0);
    const p = {
      id: pid, name, isBot, team: pid, skin: SKINS[this.rng.int(0, SKINS.length - 1)],
      body: newBody(spot.x, g, spot.z),
      yaw: this.rng.range(-Math.PI, Math.PI), pitch: 0, aimYaw: 0, aimPitch: 0,
      hp: MAX_HP, alive: true, deathT: 0, air: null,
      slots: [null, null, null, { id: 'fists', mag: 0 }], cur: 3, switchT: 0,
      inv: newInventory(),
      fireCd: 0, bloom: 0, shots: 0, triggerHeld: false,
      reloadT: 0, reloadTotal: 0, reloading: false,
      ads: false, adsT: 0,
      using: null,
      kills: 0, dmgDealt: 0, place: 0,
      lastHitBy: null, lastHitT: -99, lastShotT: -99, lastFootT: 0,
      autoPickup: true, autoT: 0, autoReload: true,
      buf: { jump: 0, crouch: 0, prone: 0, reload: 0 },
      throwType: null, throwHold: false, throwLob: false, blindT: 0, veh: null,
      cmd: emptyCommand()
    };
    p.aimYaw = p.yaw;
    this.players.push(p);
    this.byId.set(p.id, p);
    return p;
  }

  spawnLoot() {
    for (const s of this.world.lootSpots) {
      const tier = clamp(s.tier, 0, 3);
      // first group: almost every spot has something; extra groups make busy spots
      const rolls = [LOOT_CHANCE[tier], ...LOOT_EXTRA[tier]];
      rolls.forEach((chance, g) => {
        if (!this.rng.chance(chance)) return;
        // later groups sit a little away from the spot so piles don't overlap
        const ga = this.rng.next() * Math.PI * 2, gr = g === 0 ? 0 : 0.9 + g * 0.35;
        const cx = s.x + Math.cos(ga) * gr, cz = s.z + Math.sin(ga) * gr;
        rollLoot(this.rng, tier).forEach(([key, count], i) => {
          const a = this.rng.next() * Math.PI * 2, r = i === 0 ? 0 : 0.45 + this.rng.next() * 0.25;
          this.dropItem(key, count, cx + Math.cos(a) * r, s.y + 0.3, cz + Math.sin(a) * r, 0, true, s.x, s.z);
        });
      });
    }
  }

  /**
   * put an item on the ground.  (cx, cz) is where it was thrown from (loot spot
   * centre / dying player): if the spot is inside a wall or crate the item slides
   * back toward that origin, then searches outward, so nothing is ever buried.
   */
  dropItem(key, count, x, y, z, mag = 0, silent = false, cx = x, cz = z) {
    const W = this.world;
    const free = (px, pz) => { const g = W.supportHeight(px, pz, 0.1, y + 0.3, 0); return !W.overlaps(px, pz, 0.15, g + 0.05, g + 0.45); };
    if (!free(x, z)) {
      let found = false;
      for (const t of [0.25, 0.5, 0.75, 1]) {
        const px = x + (cx - x) * t, pz = z + (cz - z) * t;
        if (free(px, pz)) { x = px; z = pz; found = true; break; }
      }
      for (let r = 0.3; !found && r <= 1.8; r += 0.3) {
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2, px = cx + Math.cos(a) * r, pz = cz + Math.sin(a) * r;
          if (free(px, pz)) { x = px; z = pz; found = true; break; }
        }
      }
    }
    const g = W.supportHeight(x, z, 0.1, y + 0.3, 0);
    const it = { id: this.nextId++, key, count, mag, x, y: g, z };
    this.items.push(it);
    this.itemById.set(it.id, it);
    if (!silent) this.emit({ t: 'itemAdd', id: it.id });
    return it;
  }
  removeItem(it) {
    const i = this.items.indexOf(it);
    if (i >= 0) this.items.splice(i, 1);
    this.itemById.delete(it.id);
  }

  aliveCount() { let n = 0; for (const p of this.players) if (p.alive) n++; return n; }
  weaponOf(p) {
    if (p.cur === 4) return WEAPONS.throw;
    const s = p.slots[p.cur]; return s ? WEAPONS[s.id] : WEAPONS.fists;
  }
  slotOf(p) {
    if (p.cur === 4) return { id: 'throw', type: p.throwType, mag: p.throwType ? invCount(p.inv, p.throwType) : 0 };
    return p.slots[p.cur] || p.slots[3];
  }
  /** throwable types the player carries, in a fixed order */
  throwTypes(p) { return THROW_ORDER.filter((k) => invCount(p.inv, k) > 0); }

  /** slot 5: take a throwable in hand (press again to cycle types) */
  selectThrow(p, want = null) {
    const types = this.throwTypes(p);
    if (!types.length) { this.emit({ t: 'deny', id: p.id, why: 'nothrow' }); return false; }
    let type;
    if (want && types.includes(want)) type = want;
    else if (p.cur === 4 && p.throwType) type = types[(types.indexOf(p.throwType) + 1) % types.length];
    else type = types.includes(p.throwType) ? p.throwType : types[0];
    if (p.cur !== 4) { p.prevSlot = p.cur; p.switchT = WEAPONS.throw.equip; p.reloading = false; p.using = null; }
    p.cur = 4; p.throwType = type; p.throwHold = false;
    this.emit({ t: 'switch', id: p.id, w: 'throw', type });
    return true;
  }
  /** after a throw / drop: keep a throwable in hand if possible, otherwise go back to a gun */
  ensureThrowable(p) {
    if (p.cur !== 4) return;
    if (p.throwType && invCount(p.inv, p.throwType) > 0) return;
    const types = this.throwTypes(p);
    if (types.length) { p.throwType = types[0]; return; }
    const back = [p.prevSlot, 0, 1, 2, 3].find((i) => i !== undefined && i < 4 && p.slots[i]);
    this.switchTo(p, back ?? 3);
  }
  eye(p) { return { x: p.body.pos.x, y: p.body.pos.y + eyeHeight(p.body), z: p.body.pos.z }; }

  /* ---------------- commands ---------------- */
  setCommand(pid, cmd) {
    const p = this.byId.get(pid);
    if (!p) return;
    // edge-triggered fields accumulate until consumed by the next tick
    const prev = p.cmd;
    const merged = Object.assign({}, cmd);
    for (const k of EDGE_KEYS) merged[k] = cmd[k] || prev[k];
    if (cmd.slot === undefined || cmd.slot < 0) { merged.slot = prev.slot; merged.throwType = prev.throwType; }
    if (!cmd.use) merged.use = prev.use;
    p.cmd = merged;
  }

  /* ---------------- main step ---------------- */
  step(dt = TICK) {
    if (this.state === 'ended') { this.time += dt; return; }
    this.time += dt;
    this.tick++;
    this.pathBudget = 2;
    if (this.plane && !this.plane.done) this.stepPlane(dt);
    this.rebuildObstacles();
    for (const p of this.players) {
      if (!p.alive) continue;
      if (p.brain) p.brain.think(dt);
      if (p.air) this.stepAirPlayer(p, dt);
      else if (p.veh) this.stepOccupant(p, dt);
      else this.stepPlayer(p, dt);
    }
    this.stepVehicles(dt);
    this.separatePlayers();
    this.stepBullets(dt);
    this.stepProjectiles(dt);
    // the storm clock starts once the plane has left the island
    const zev = this.plane && !this.plane.left && !this.plane.done ? null : this.zone.update(dt);
    // supply drops: one soon after the flight, then one each time the storm starts closing in
    if (zev === 'shrink' && this.zone.phase <= 2) this.launchSupply();
    if (this.supply.at !== null && this.time >= this.supply.at) { this.supply.at = null; this.launchSupply(); }
    this.stepSupply(dt);
    if (zev) this.emit({ t: 'zone', ev: zev, phase: this.zone.phase });
    this.zoneDamage(dt);
    this.checkWin();
  }

  /* ---------------- plane / skydive ---------------- */
  stepPlane(dt) {
    const pl = this.plane;
    const ev = pl.update(dt);
    if (ev === 'enter') this.emit({ t: 'plane', ev: 'enter' });
    for (const p of this.players) {
      if (!p.alive || p.air !== 'plane') continue;
      p.body.pos.x = pl.x; p.body.pos.y = pl.alt; p.body.pos.z = pl.z;
      p.body.vel.x = pl.dx * PLANE.speed; p.body.vel.z = pl.dz * PLANE.speed; p.body.vel.y = 0;
    }
    // leaving the island (or the end of the route): everyone still on board is pushed out
    if (ev === 'leave' || pl.d >= pl.len) {
      for (const p of this.players) if (p.alive && p.air === 'plane') this.jumpOut(p);
      if (ev === 'leave' && this.supply.at === null && !this.supply.planes.length) this.supply.at = this.time + 35;
      this.emit({ t: 'plane', ev: 'leave' });
    }
  }

  jumpOut(p) {
    p.air = 'fall';
    p.body.pos.y = this.plane.alt - 3;
    p.body.vel.y = -4;
    p.chuteT = 0;
    this.emit({ t: 'jumpOut', id: p.id });
  }

  stepAirPlayer(p, dt) {
    const c = p.cmd, b = p.body;
    p.yaw = wrapAngle(c.yaw || 0);
    p.pitch = clamp(c.pitch || 0, -1.45, 1.45);
    p.aimYaw = p.yaw; p.aimPitch = p.pitch;
    const press = c.jump || c.interact;
    if (p.air === 'plane') {
      if (press && this.plane.inside) this.jumpOut(p);
    } else {
      const ev = stepAir(this.world, b, { fwd: c.fwd, right: c.right, yaw: p.yaw, pitch: p.pitch }, dt, p.air);
      if (p.air === 'fall' && (ev.height < PLANE.chuteAuto || (press && ev.height > PLANE.chuteMinManual))) {
        p.air = 'chute'; p.chuteT = 0;
        // the canopy catches air hard: most of the dive speed is gone at once
        b.vel.y = Math.max(b.vel.y, -12);
        this.emit({ t: 'chute', id: p.id });
      }
      if (p.air === 'chute') p.chuteT += dt;
      if (ev.landed !== undefined) {
        const was = p.air;
        p.air = null;
        this.emit({ t: 'landed', id: p.id, v: ev.landed });
        if (was === 'fall' && ev.landed > MOVE.fallSafe) this.damage(p, (ev.landed - MOVE.fallSafe) * MOVE.fallDmg, null, 'fall', null);
      }
    }
    for (const k of EDGE_KEYS) c[k] = false;
    c.slot = -1; c.use = null; c.cycle = 0; c.throwType = null;
  }

  stepPlayer(p, dt) {
    const c = p.cmd;
    const b = p.body;
    const w = this.weaponOf(p);
    // a prone body can't swing its head/feet into a wall: keep the old heading then
    const wantYaw = wrapAngle(c.yaw || 0);
    if (b.stance !== 'prone' || proneFits(this.world, b.pos.x, b.pos.z, b.pos.y, wantYaw) ||
        !proneFits(this.world, b.pos.x, b.pos.z, b.pos.y, p.yaw)) p.yaw = wantYaw;
    p.pitch = clamp(c.pitch || 0, -1.45, 1.45);
    p.aimYaw = wrapAngle(c.aimYaw !== undefined ? c.aimYaw : p.yaw);
    p.aimPitch = clamp(c.aimPitch !== undefined ? c.aimPitch : p.pitch, -1.5, 1.5);

    // ---- input buffering: a press that arrives during a short lock (weapon swap,
    // stance transition, landing) is retried for a moment instead of being lost ----
    const B = p.buf;
    if (c.jump) B.jump = 0.15;
    if (c.crouch) B.crouch = 0.4;
    if (c.prone) B.prone = 0.4;
    if (c.reload) B.reload = 0.6;

    // ---- stance ----
    if (B.crouch > 0) {
      const target = b.stance === 'crouch' ? 'stand' : 'crouch';
      if (setStance(this.world, b, target)) B.crouch = 0;
    }
    if (B.prone > 0) {
      const target = b.stance === 'prone' ? 'stand' : 'prone';
      if (setStance(this.world, b, target, p.yaw)) { B.prone = 0; if (target === 'prone') this.cancelReloadIfShell(p); }
    }

    // ---- weapon switch ----
    if (c.slot === 4) this.selectThrow(p, c.throwType || null);
    else if (c.slot !== undefined && c.slot >= 0 && c.slot !== p.cur && p.slots[c.slot]) this.switchTo(p, c.slot);
    if (c.cycle) {
      // the wheel goes through the four weapon slots and the throwable slot
      const has = (i) => (i === 4 ? this.throwTypes(p).length > 0 : !!p.slots[i]);
      for (let k = 1; k <= 5; k++) {
        const s = (p.cur + c.cycle * k + 10) % 5;
        if (has(s)) { if (s === 4) this.selectThrow(p); else this.switchTo(p, s); break; }
      }
    }
    if (p.blindT > 0) p.blindT = Math.max(0, p.blindT - dt);
    if (p.switchT > 0) p.switchT -= dt;

    // ---- item use ----
    if (c.use) this.startUse(p, c.use);
    if (p.using) {
      if (c.fire || c.jump || (c.sprint && c.fwd > 0.5)) { p.using = null; this.emit({ t: 'useCancel', id: p.id }); }
      else {
        p.using.t += dt;
        if (p.using.t >= p.using.dur) this.finishUse(p);
      }
    }

    // ---- ADS ----
    p.ads = !!c.ads && !b.sprinting && p.switchT <= 0;
    p.adsT = clamp(p.adsT + (p.ads ? dt / w.adsTime : -dt / (w.adsTime * 0.8)), 0, 1);

    // ---- move ----
    const firing = c.fire && !p.using;
    const ev = stepBody(this.world, b, {
      fwd: c.fwd, right: c.right, yaw: p.yaw,
      sprint: c.sprint && !firing && !p.reloading, walk: c.walk, jump: B.jump > 0,
      ads: p.ads, usingItem: !!p.using, moveMul: w.moveMul * (p.reloading ? 0.92 : 1)
    }, dt);
    if (ev.jumpUsed) B.jump = 0;
    if (ev.jumped) this.emit({ t: 'jump', id: p.id });
    if (ev.landed !== undefined && ev.landed > 3) this.emit({ t: 'land', id: p.id, v: ev.landed });
    if (ev.fallDamage) this.damage(p, ev.fallDamage, null, 'fall', null);
    if (!p.alive) return;

    // ---- reload ----
    if (B.reload > 0 && (this.startReload(p) || p.reloading)) B.reload = 0;
    this.updateReload(p, dt);
    for (const k in B) if (B[k] > 0) B[k] -= dt;

    // ---- fire ----
    p.bloom -= p.bloom * Math.min(1, w.spread.bloomDecay * dt);
    p.fireCd = Math.max(p.fireCd - dt, -dt);
    if (w.cat === 'throw') this.updateThrow(p, c);
    else if (c.fire) this.tryFire(p, w);
    else p.triggerHeld = false;
    // auto reload: an empty magazine reloads by itself as soon as it can
    // (not while healing; sprint / weapon swap simply delay it a few ticks)
    if (p.autoReload && !p.reloading && !p.using && p.fireCd <= 0) {
      const cw = this.weaponOf(p), cs = this.slotOf(p);
      if (cw.reloadType !== 'none' && cs.mag === 0 && (this.cheats.infAmmo.has(p.id) || invCount(p.inv, 'ammo_' + cw.ammo) > 0)) this.startReload(p);
    }

    // ---- interact / pickup ----
    if (c.interact) {
      const v = this.findVehicle(p);
      if (v) this.enterVehicle(p, v);
      else {
        const it = this.findPickup(p);
        if (it) this.pickup(p, it);
      }
      if (p.veh) { for (const k of EDGE_KEYS) c[k] = false; c.slot = -1; c.use = null; c.cycle = 0; c.throwType = null; return; }
    }
    p.autoT -= dt;
    if (p.autoPickup && p.autoT <= 0) { p.autoT = 0.25; this.autoPickup(p); }

    // consume edges
    for (const k of EDGE_KEYS) c[k] = false;
    c.slot = -1; c.use = null; c.cycle = 0; c.throwType = null;
  }

  /* ---------------- throwables ---------------- */
  /** hold fire = wind up (client shows the arc), release = throw; aim button = short lob */
  updateThrow(p, c) {
    if (p.switchT > 0 || p.fireCd > 0) { if (!c.fire) p.throwHold = false; return; }
    if (c.fire) { p.throwHold = true; p.throwLob = !!c.ads; if (p.using) { p.using = null; this.emit({ t: 'useCancel', id: p.id }); } return; }
    if (!p.throwHold) return;
    p.throwHold = false;
    const type = p.throwType;
    if (!type || invTake(p.inv, type, 1) <= 0) { this.ensureThrowable(p); return; }
    const L = throwLaunch(this.eye(p), p.aimYaw, p.aimPitch, p.throwLob, p.body.vel);
    const g = { id: this.nextId++, type, owner: p.id, ...L, fuse: THROWABLES[type].fuse, rest: false, bounces: 0 };
    this.projectiles.push(g);
    p.fireCd = 0.9;
    p.lastShotT = this.time;
    this.emit({ t: 'throw', id: p.id, type, gid: g.id });
    this.ensureThrowable(p);
  }

  stepProjectiles(dt) {
    for (const g of this.projectiles) {
      if (g.done) continue;
      g.fuse -= dt;
      const ev = stepProjectile(this.world, g, dt);
      if (ev === 'hit') this.emit({ t: 'bounce', x: g.x, y: g.y, z: g.z, type: g.type });
      if (g.fuse <= 0 || (ev === 'hit' && THROWABLES[g.type].impact)) this.detonate(g);
    }
    if (this.projectiles.some((g) => g.done)) this.projectiles = this.projectiles.filter((g) => !g.done);
    for (const s of this.smokes) { s.t -= dt; s.r = Math.min(s.maxR, s.r + dt * 4); if (s.t < 3) s.r = Math.max(0, s.r - dt * 2.5); }
    if (this.smokes.length && this.smokes[0].t <= 0) this.smokes = this.smokes.filter((s) => s.t > 0);
    for (const f of this.fires) {
      f.t -= dt;
      const owner = this.byId.get(f.owner) || null;
      for (const p of this.players) {
        if (!p.alive || p.air) continue;
        const dx = p.body.pos.x - f.x, dz = p.body.pos.z - f.z;
        if (dx * dx + dz * dz < f.r * f.r && Math.abs(p.body.pos.y - f.y) < 1.6) this.damage(p, f.dps * dt, owner, 'molotov', null);
      }
    }
    if (this.fires.length && this.fires.some((f) => f.t <= 0)) this.fires = this.fires.filter((f) => f.t > 0);
  }

  detonate(g) {
    g.done = true;
    const T = THROWABLES[g.type], owner = this.byId.get(g.owner) || null;
    const x = g.x, y = g.y + 0.15, z = g.z;
    this.emit({ t: 'detonate', type: g.type, x, y, z, gid: g.id });
    if (g.type === 'frag') {
      for (const p of this.players) {
        if (!p.alive || p.air === 'plane') continue;
        const c = { x: p.body.pos.x, y: p.body.pos.y + (p.body.stance === 'prone' ? 0.25 : 0.9), z: p.body.pos.z };
        const d = Math.hypot(c.x - x, c.y - y, c.z - z);
        if (d > T.radius) continue;
        // walls and cover stop fragments
        if (!this.world.lineClear(x, y + 0.2, z, c.x, c.y, c.z)) continue;
        const k = Math.pow(1 - d / T.radius, 1.25);
        this.damage(p, T.damage * k, owner, 'frag', { x: (c.x - x) / (d || 1), y: 0, z: (c.z - z) / (d || 1) }, 'torso', c);
      }
      for (const v of this.vehicles) {
        const d = Math.hypot(v.x - x, v.y + 0.6 - y, v.z - z);
        if (d < T.radius + 1) this.damageVehicle(v, T.damage * 1.2 * Math.max(0, 1 - d / (T.radius + 1)), owner);
      }
    } else if (g.type === 'smoke') {
      this.smokes.push({ x, y: y + 1.2, z, r: 1, maxR: T.smokeR, t: T.smokeT });
    } else if (g.type === 'flash') {
      for (const p of this.players) {
        if (!p.alive || p.air === 'plane') continue;
        const e = this.eye(p);
        const dx = x - e.x, dy = y - e.y, dz = z - e.z, d = Math.hypot(dx, dy, dz);
        if (d > T.flashR || !this.world.lineClear(x, y + 0.1, z, e.x, e.y, e.z)) continue;
        const cp = Math.cos(p.aimPitch);
        const facing = (-Math.sin(p.aimYaw) * cp * dx + Math.sin(p.aimPitch) * dy - Math.cos(p.aimYaw) * cp * dz) / (d || 1);
        const amount = T.blind * (1 - d / T.flashR) * (0.3 + 0.7 * Math.max(0, facing)) + (d < 4 ? 1.2 : 0);
        if (amount > 0.3) { p.blindT = Math.max(p.blindT, amount); this.emit({ t: 'blind', id: p.id, amount }); }
      }
    } else if (g.type === 'molotov') {
      const gy = this.world.supportHeight(x, z, 0.2, y + 0.3, 0);
      this.fires.push({ x, y: gy, z, r: T.fireR, t: T.fireT, dps: T.dps, owner: g.owner });
    }
  }

  /* ---------------- supply drops ---------------- */
  /** send a cargo plane that drops a crate at (x, z), or somewhere inside the next safe zone */
  launchSupply(x, z) {
    if (x === undefined) {
      const c = this.zone.stage === 'done' ? this.zone.cur : this.zone.next;
      const cand = this.world.spawnSpots.filter((s) => Math.hypot(s.x - c.x, s.z - c.z) < Math.max(8, c.r * 0.75));
      const sp = cand.length ? cand[this.rng.int(0, cand.length - 1)] : { x: c.x, z: c.z };
      x = sp.x; z = sp.z;
    }
    const a = this.rng.next() * Math.PI * 2, dx = Math.cos(a), dz = Math.sin(a), L = 420;
    const pl = { id: this.nextId++, ax: x - dx * L, az: z - dz * L, dx, dz, d: 0, len: L * 2, drop: L, alt: 205, x: x - dx * L, z: z - dz * L, tx: x, tz: z, dropped: false, yaw: Math.atan2(-dx, -dz) };
    this.supply.planes.push(pl);
    this.emit({ t: 'supplyPlane', id: pl.id, x, z });
    return pl;
  }

  stepSupply(dt) {
    const S = this.supply;
    for (const pl of S.planes) {
      pl.d += 45 * dt;
      pl.x = pl.ax + pl.dx * pl.d; pl.z = pl.az + pl.dz * pl.d;
      if (!pl.dropped && pl.d >= pl.drop) {
        pl.dropped = true;
        const cr = { id: this.nextId++, x: pl.tx, z: pl.tz, y: pl.alt - 6, landed: false, flareT: 0 };
        S.crates.push(cr);
        this.emit({ t: 'supplyDrop', id: cr.id, x: cr.x, z: cr.z });
      }
    }
    if (S.planes.some((pl) => pl.d > pl.len)) S.planes = S.planes.filter((pl) => pl.d <= pl.len);
    for (const cr of S.crates) {
      if (cr.landed) { if (cr.flareT > 0) cr.flareT -= dt; continue; }
      const ground = this.world.supportHeight(cr.x, cr.z, 0.6, cr.y, 0);
      cr.y -= 9 * dt;                          // under a big parachute
      if (cr.y > ground) continue;
      cr.y = ground; cr.landed = true; cr.flareT = 50;
      // contents sit on top of the crate
      const drops = rollSupply(this.rng);
      drops.forEach(([key, count], i) => {
        const a = (i / drops.length) * Math.PI * 2, r = i === 0 ? 0 : 0.32;
        const it = { id: this.nextId++, key, count, mag: key === 'longbow' ? 5 : 0, x: cr.x + Math.cos(a) * r, y: cr.y + CRATE_H, z: cr.z + Math.sin(a) * r, supply: true };
        this.items.push(it); this.itemById.set(it.id, it);
        this.emit({ t: 'itemAdd', id: it.id });
      });
      this.emit({ t: 'supplyLanded', id: cr.id, x: cr.x, y: cr.y, z: cr.z });
    }
  }

  /* ---------------- vehicles ---------------- */
  spawnVehicles() {
    const spots = this.world.vehicleSpots || [];
    for (const sp of spots) {
      if (!this.rng.chance(0.75)) continue;
      const type = VEHICLE_TYPES[this.rng.int(0, VEHICLE_TYPES.length - 1)];
      const y = this.world.supportHeight(sp.x, sp.z, 0.5, 1e4, 0);
      this.addVehicle(type, sp.x, y, sp.z, sp.yaw, 35 + this.rng.next() * 60);
    }
  }
  addVehicle(type, x, y, z, yaw, fuel = 80) {
    const v = newVehicle(this.nextId++, type, x, y, z, yaw, fuel);
    v.color = this.rng.int(0, 7);
    this.vehicles.push(v);
    this.vehById.set(v.id, v);
    return v;
  }
  rebuildObstacles() {
    const dyn = this.world.dyn;
    dyn.length = 0;
    for (const cr of this.supply.crates) if (cr.landed) dyn.push({ x: cr.x, z: cr.z, r: 0.72, y0: cr.y, y1: cr.y + CRATE_H, crate: cr.id });
    for (const v of this.vehicles) {
      const D = VEHICLES[v.type];
      for (const c of vehCircles(v)) dyn.push({ x: c.x, z: c.z, r: c.r * 0.95, y0: v.y + 0.2, y1: v.y + D.hgt, veh: v.id });
    }
  }
  driverOf(v) { return v.seats[0] !== null ? this.byId.get(v.seats[0]) || null : null; }

  /** vehicle within reach to get in */
  findVehicle(p) {
    let best = null, bd = 2.0;
    for (const v of this.vehicles) {
      if (v.dead || v.seats.every((s) => s !== null)) continue;
      if (Math.abs(p.body.pos.y - v.y) > 2) continue;
      const d = vehDistance(v, p.body.pos.x, p.body.pos.z);
      if (d < bd) { bd = d; best = v; }
    }
    return best;
  }
  enterVehicle(p, v, seat = -1) {
    if (seat < 0) seat = v.seats[0] === null ? 0 : v.seats.findIndex((s) => s === null);
    if (seat < 0 || v.seats[seat] !== null || v.dead) return false;
    v.seats[seat] = p.id;
    p.veh = { id: v.id, seat };
    p.reloading = false; p.using = null; p.ads = false; p.adsT = 0; p.throwHold = false;
    p.body.stance = 'crouch'; p.body.stanceLock = 0;
    this.syncOccupant(p, v);
    this.emit({ t: 'enterVeh', id: p.id, veh: v.id, seat });
    return true;
  }
  exitVehicle(p) {
    const v = this.vehById.get(p.veh.id), D = VEHICLES[v.type];
    const [sx, sz] = D.seats[p.veh.seat];
    const side = sx < 0 ? -1 : 1;
    const R = 0.33;
    const tries = [[side * (D.wid / 2 + 0.6), sz], [-side * (D.wid / 2 + 0.6), sz], [side * (D.wid / 2 + 0.6), D.len / 2 + 0.6], [0, D.len / 2 + 0.8], [0, -D.len / 2 - 0.8]];
    let spot = null;
    for (const [lx, lz] of tries) {
      const w = vehToWorld(v, lx, lz);
      const g = this.world.supportHeight(w.x, w.z, 0.25, v.y + 1, 0);
      if (!this.world.overlapsStatic(w.x, w.z, R, g + 0.05, g + 1.8)) { spot = { x: w.x, y: g, z: w.z }; break; }
    }
    if (!spot) spot = { x: v.x, y: v.y + VEHICLES[v.type].hgt + 0.1, z: v.z };        // climb out on top
    v.seats[p.veh.seat] = null;
    const speed = Math.abs(v.speed);
    p.veh = null;
    p.body.stance = 'stand';
    p.body.pos.x = spot.x; p.body.pos.y = spot.y; p.body.pos.z = spot.z;
    p.body.vel.x = -Math.sin(v.yaw) * v.speed * 0.5; p.body.vel.z = -Math.cos(v.yaw) * v.speed * 0.5; p.body.vel.y = 0;
    p.body.onGround = false;
    this.emit({ t: 'exitVeh', id: p.id, veh: v.id });
    if (speed > 9) this.damage(p, (speed - 9) * 4, null, 'fall', null);          // bailing out at speed hurts
  }
  changeSeat(p, seat) {
    const v = this.vehById.get(p.veh.id);
    if (seat >= v.seats.length || v.seats[seat] !== null) return;
    v.seats[p.veh.seat] = null; v.seats[seat] = p.id; p.veh.seat = seat;
    this.emit({ t: 'seat', id: p.id, seat });
  }
  syncOccupant(p, v) {
    const D = VEHICLES[v.type], st = D.seats[p.veh.seat];
    const w = vehToWorld(v, st[0], st[1]);
    p.body.pos.x = w.x; p.body.pos.z = w.z; p.body.pos.y = v.y + st[2];
    p.body.vel.x = -Math.sin(v.yaw) * v.speed; p.body.vel.z = -Math.cos(v.yaw) * v.speed; p.body.vel.y = 0;
    p.body.onGround = true; p.body.moveSpeed = 0; p.body.sprinting = false;
  }
  stepOccupant(p, dt) {
    const c = p.cmd, v = this.vehById.get(p.veh.id);
    p.yaw = wrapAngle(c.yaw || 0); p.pitch = clamp(c.pitch || 0, -1.45, 1.45);
    p.aimYaw = p.yaw; p.aimPitch = p.pitch;
    if (p.blindT > 0) p.blindT = Math.max(0, p.blindT - dt);
    if (c.interact) this.exitVehicle(p);
    else {
      if (c.slot >= 0 && c.slot < 4) this.changeSeat(p, c.slot);
      if (p.veh.seat === 0) v.input = { throttle: c.fwd || 0, steer: c.right || 0, handbrake: !!c.brake, boost: !!c.sprint };
    }
    for (const k of EDGE_KEYS) c[k] = false;
    c.slot = -1; c.use = null; c.cycle = 0; c.throwType = null;
  }

  damageVehicle(v, amount, attacker) {
    if (v.dead || amount <= 0) return;
    v.hp -= amount;
    if (attacker) v.lastHitBy = attacker.id;
    this.emit({ t: 'vehHit', veh: v.id, dmg: amount });
    if (v.hp <= 0) this.destroyVehicle(v, attacker || (v.lastHitBy ? this.byId.get(v.lastHitBy) : null));
  }
  destroyVehicle(v, attacker) {
    v.dead = true; v.hp = 0; v.speed = 0; v.burnT = 40; v.input = null;
    const D = VEHICLES[v.type];
    this.emit({ t: 'vehBoom', veh: v.id, x: v.x, y: v.y + 0.8, z: v.z });
    for (const pid of v.seats) {
      if (pid === null) continue;
      const p = this.byId.get(pid);
      if (p && p.alive) this.damage(p, 150, attacker && attacker !== p ? attacker : null, 'vehicle', null);
    }
    for (const p of this.players) {
      if (!p.alive || p.veh || p.air === 'plane') continue;
      const d = Math.hypot(p.body.pos.x - v.x, p.body.pos.y + 0.9 - v.y - 0.8, p.body.pos.z - v.z);
      if (d < 6.5 && this.world.lineClear(v.x, v.y + 1, v.z, p.body.pos.x, p.body.pos.y + 0.9, p.body.pos.z)) this.damage(p, 95 * (1 - d / 6.5), attacker, 'vehicle', null);
    }
    void D;
  }

  stepVehicles(dt) {
    for (const v of this.vehicles) {
      if (v.dead) { v.burnT = Math.max(0, v.burnT - dt); v.speed = 0; continue; }
      const drv = this.driverOf(v);
      const input = drv && drv.alive ? (v.input || {}) : {};
      const onRoad = roadDist(this.world, v.x, v.z) < 0.6;
      const ev = stepVehicle(this.world, v, input, dt, onRoad);
      const D = VEHICLES[v.type];
      if (ev.crash > 7) {
        this.damageVehicle(v, (ev.crash - 7) * 4.5, null);
        this.emit({ t: 'crash', veh: v.id, v: ev.crash, x: v.x, y: v.y + 0.6, z: v.z });
        if (ev.crash > 12) for (const pid of v.seats) { const o = pid !== null && this.byId.get(pid); if (o && o.alive) this.damage(o, (ev.crash - 12) * 3, null, 'vehicle', null); }
      }
      if (ev.landed > 10) this.damageVehicle(v, (ev.landed - 10) * 6, null);
      // running people over
      const sp = Math.abs(v.speed);
      for (const p of this.players) {
        if (!p.alive || p.veh || p.air) continue;
        if (Math.abs(p.body.pos.y - v.y) > 1.6) continue;
        if (vehDistance(v, p.body.pos.x, p.body.pos.z) > 0.35) continue;
        // knock the person out to the side of the car (never bulldoze them ahead of it)
        const loc = worldToVeh(v, p.body.pos.x, p.body.pos.z);
        const side = loc.x >= 0 ? 1 : -1;
        const out = vehToWorld(v, side * (D.wid / 2 + 0.45), loc.z);
        const rx = Math.cos(v.yaw) * side, rz = -Math.sin(v.yaw) * side;
        if (sp > 3.5 && (!p.lastRunT || this.time - p.lastRunT > 0.6)) {
          p.lastRunT = this.time;
          this.damage(p, sp * (2 + D.weight * 3), drv && drv.alive ? drv : null, 'vehicle', { x: rx, y: 0, z: rz });
          v.speed *= 0.9;
        }
        if (p.alive) this.nudge(p, out.x - p.body.pos.x, out.z - p.body.pos.z);
      }
      for (const pid of v.seats) { if (pid === null) continue; const o = this.byId.get(pid); if (o && o.alive) this.syncOccupant(o, v); }
    }
    // vehicle vs vehicle
    const vs = this.vehicles;
    for (let i = 0; i < vs.length; i++) {
      for (let j = i + 1; j < vs.length; j++) {
        const a = vs[i], b = vs[j];
        if (Math.abs(a.x - b.x) > 6 || Math.abs(a.z - b.z) > 6 || Math.abs(a.y - b.y) > 2) continue;
        let hit = false;
        for (const ca of vehCircles(a)) for (const cb of vehCircles(b)) if (Math.hypot(ca.x - cb.x, ca.z - cb.z) < ca.r + cb.r) hit = true;
        if (!hit) continue;
        const rel = Math.abs(a.speed - b.speed);
        const dx = b.x - a.x, dz = b.z - a.z, dl = Math.hypot(dx, dz) || 1;
        a.x -= dx / dl * 0.15; a.z -= dz / dl * 0.15; b.x += dx / dl * 0.15; b.z += dz / dl * 0.15;
        a.speed *= -0.3; b.speed *= -0.3;
        if (rel > 6) { this.damageVehicle(a, (rel - 6) * 3, null); this.damageVehicle(b, (rel - 6) * 3, null); this.emit({ t: 'crash', veh: a.id, v: rel, x: (a.x + b.x) / 2, y: a.y + 0.6, z: (a.z + b.z) / 2 }); }
      }
    }
  }

  /** line of sight for bots: world + smoke clouds */
  sightClear(ax, ay, az, bx, by, bz) {
    if (!this.world.lineClear(ax, ay, az, bx, by, bz)) return false;
    return !smokeBlocks(this.smokes, ax, ay, az, bx, by, bz);
  }

  switchTo(p, slot) {
    if (!p.slots[slot]) return;
    p.cur = slot;
    p.switchT = WEAPONS[p.slots[slot].id].equip;
    p.reloading = false; p.reloadT = 0;
    p.fireCd = Math.max(p.fireCd, 0);
    p.using = null;
    this.emit({ t: 'switch', id: p.id, w: p.slots[slot].id });
  }

  /* ---------------- firing ---------------- */
  spreadDeg(p, w) {
    const sp = w.spread, b = p.body;
    let s = sp.hip + (sp.ads - sp.hip) * p.adsT;
    s += sp.move * clamp(b.moveSpeed / MOVE.speed.run, 0, 1.3);
    if (!b.onGround) s += sp.air;
    if (b.stance === 'crouch') s *= sp.crouch;
    else if (b.stance === 'prone') s *= sp.prone;
    s += p.bloom * (1 - p.adsT * 0.6);
    return s;
  }

  tryFire(p, w) {
    const b = p.body;
    if (p.switchT > 0 || b.stanceLock > 0 && b.stance === 'prone' || p.using) return;
    if (b.sprinting) return;
    const slot = this.slotOf(p);
    if (w.mode === 'semi' && p.triggerHeld) return;
    if (p.reloading) {
      if (w.reloadType === 'shell' && slot.mag > 0) { p.reloading = false; p.reloadT = 0; }
      else return;
    }
    if (p.fireCd > 0) return;
    if (w.cat !== 'melee' && slot.mag <= 0) {
      if (!p.triggerHeld) {
        this.emit({ t: 'dry', id: p.id });
        this.startReload(p);
      }
      p.triggerHeld = true;
      return;
    }
    p.triggerHeld = true;
    let shotsThisTick = 0;
    while (p.fireCd <= 0 && (w.cat === 'melee' || slot.mag > 0) && shotsThisTick < 3) {
      this.fireOnce(p, w, slot);
      p.fireCd += 60 / w.rpm;
      shotsThisTick++;
      if (w.mode === 'semi') break;
    }
  }

  fireOnce(p, w, slot) {
    p.shots++;
    p.lastShotT = this.time;
    const e = this.eye(p);
    const dir = dirFromAngles(p.aimYaw, p.aimPitch);
    if (w.cat === 'melee') { this.melee(p, w, e, dir); return; }
    if (!this.cheats.infAmmo.has(p.id)) slot.mag--;
    const spread = this.spreadDeg(p, w) * DEG;
    const rng = makeRng(hashInts(typeof p.id === 'number' ? p.id : 7, p.shots, this.seed));
    // basis around dir
    let ux = 0, uy = 1, uz = 0;
    if (Math.abs(dir.y) > 0.99) { ux = 1; uy = 0; }
    let rx = dir.y * uz - dir.z * uy, ry = dir.z * ux - dir.x * uz, rz = dir.x * uy - dir.y * ux;
    const rl = Math.hypot(rx, ry, rz); rx /= rl; ry /= rl; rz /= rl;
    const vx = ry * dir.z - rz * dir.y, vy = rz * dir.x - rx * dir.z, vz = rx * dir.y - ry * dir.x;
    const pellets = [];
    for (let i = 0; i < w.pellets; i++) {
      const a = rng.next() * Math.PI * 2;
      // center weighted cone
      const r = spread * (w.spread.pellet ? Math.sqrt(rng.next()) : rng.next() * (0.35 + 0.65 * rng.next()));
      const ca = Math.cos(a) * Math.tan(r), sa = Math.sin(a) * Math.tan(r);
      let dx = dir.x + rx * ca + vx * sa, dy = dir.y + ry * ca + vy * sa, dz = dir.z + rz * ca + vz * sa;
      const l = Math.hypot(dx, dy, dz); dx /= l; dy /= l; dz /= l;
      const bl = {
        owner: p.id, w: slot.id, x: e.x, y: e.y, z: e.z,
        vx: dx * w.bulletSpeed, vy: dy * w.bulletSpeed, vz: dz * w.bulletSpeed,
        dist: 0, life: w.range / w.bulletSpeed + 0.3, alive: true, pellet: w.pellets > 1
      };
      this.bullets.push(bl);
      pellets.push([dx, dy, dz]);
    }
    p.bloom = Math.min(w.spread.bloomMax, p.bloom + w.spread.bloom);
    this.emit({ t: 'shot', id: p.id, w: slot.id, x: e.x, y: e.y, z: e.z, dirs: pellets, n: p.shots });
    // advance the new bullets by one tick immediately so point blank shots register this tick
  }

  melee(p, w, e, dir) {
    this.emit({ t: 'shot', id: p.id, w: 'fists', x: e.x, y: e.y, z: e.z, dirs: [[dir.x, dir.y, dir.z]], n: p.shots });
    const wallHit = this.world.raycast(e.x, e.y, e.z, dir.x, dir.y, dir.z, w.meleeRange, { bullets: true });
    const maxT = wallHit ? wallHit.t : w.meleeRange;
    let best = null;
    for (const o of this.players) {
      if (!o.alive || o === p) continue;
      const h = rayHitPlayer(o, e.x, e.y, e.z, dir.x, dir.y, dir.z, maxT + 0.3);
      if (h && (!best || h.t < best.h.t)) best = { o, h };
    }
    if (best) {
      const mul = best.h.part === 'head' ? w.headMul : 1;
      this.damage(best.o, w.damage * mul, p, 'fists', dir, best.h.part);
    }
  }

  stepBullets(dt) {
    const grav = 9.81;
    for (const bl of this.bullets) {
      if (!bl.alive) continue;
      bl.life -= dt;
      if (bl.life <= 0) { bl.alive = false; continue; }
      const nvy = bl.vy - grav * dt;
      const sx = bl.vx * dt, sy = (bl.vy + nvy) * 0.5 * dt, sz = bl.vz * dt;
      bl.vy = nvy;
      const L = Math.sqrt(sx * sx + sy * sy + sz * sz);
      const dx = sx / L, dy = sy / L, dz = sz / L;
      const wh = this.world.raycast(bl.x, bl.y, bl.z, dx, dy, dz, L, { bullets: true });
      let maxT = wh ? wh.t : L;
      let hitP = null, hitPart = null;
      const owner = this.byId.get(bl.owner);
      for (const o of this.players) {
        if (!o.alive || o.id === bl.owner || o.air === 'plane') continue;
        // broad phase: distance from body centre to segment
        const cx = o.body.pos.x - bl.x, cy = o.body.pos.y + 0.8 - bl.y, cz = o.body.pos.z - bl.z;
        const along = cx * dx + cy * dy + cz * dz;
        if (along < -2 || along > maxT + 2) continue;
        const px = cx - dx * along, py = cy - dy * along, pz = cz - dz * along;
        if (px * px + py * py + pz * pz > 2.6) continue;
        const h = rayHitPlayer(o, bl.x, bl.y, bl.z, dx, dy, dz, maxT);
        if (h && h.t <= maxT) { maxT = h.t; hitP = o; hitPart = h.part; }
      }
      let hitV = null;
      for (const v of this.vehicles) {
        if (Math.abs(v.x - bl.x) > maxT + 6 || Math.abs(v.z - bl.z) > maxT + 6) continue;
        const t = rayVehicle(v, bl.x, bl.y, bl.z, dx, dy, dz, maxT);
        if (t >= 0 && t < maxT) { maxT = t; hitV = v; hitP = null; }
      }
      const hx = bl.x + dx * maxT, hy = bl.y + dy * maxT, hz = bl.z + dz * maxT;
      bl.dist += maxT;
      if (hitV) {
        const w = WEAPONS[bl.w];
        this.damageVehicle(hitV, w.damage * 0.35 * falloffMul(w, bl.dist), owner);
        this.emit({ t: 'impact', x: hx, y: hy, z: hz, nx: -dx, ny: -dy, nz: -dz, mat: 'car' });
        bl.alive = false;
      } else if (hitP) {
        const w = WEAPONS[bl.w];
        const mul = hitPart === 'head' ? w.headMul : hitPart === 'legs' ? w.limbMul : 1;
        const dmg = w.damage * mul * falloffMul(w, bl.dist);
        this.damage(hitP, dmg, owner, bl.w, { x: dx, y: dy, z: dz }, hitPart, { x: hx, y: hy, z: hz });
        bl.alive = false;
      } else if (wh) {
        this.emit({ t: 'impact', x: hx, y: hy, z: hz, nx: wh.nx, ny: wh.ny, nz: wh.nz, mat: wh.box ? wh.box.kind : 'ground' });
        bl.alive = false;
      } else {
        bl.x = hx; bl.y = hy; bl.z = hz;
      }
    }
    if (this.bullets.length > 64) this.bullets = this.bullets.filter((b) => b.alive);
    else for (let i = this.bullets.length - 1; i >= 0; i--) if (!this.bullets[i].alive) this.bullets.splice(i, 1);
  }

  /* ---------------- damage / death ---------------- */
  damage(v, amount, attacker, cause, dir, part = 'torso', at = null) {
    if (this.cheats.god.has(v.id) || v.air === 'plane') return;
    if (!v.alive || amount <= 0) return;
    const before = v.hp;
    v.hp = Math.max(0, v.hp - amount);
    const dealt = before - v.hp;
    if (attacker && attacker !== v) { attacker.dmgDealt += dealt; v.lastHitBy = attacker.id; v.lastHitT = this.time; }
    if (v.using && cause !== 'zone') { v.using = null; this.emit({ t: 'useCancel', id: v.id }); }
    if (cause !== 'zone') {
      this.emit({
        t: 'hit', id: v.id, by: attacker ? attacker.id : null, dmg: dealt, part, cause,
        x: at ? at.x : v.body.pos.x, y: at ? at.y : v.body.pos.y + 1, z: at ? at.z : v.body.pos.z,
        dx: dir ? dir.x : 0, dz: dir ? dir.z : 0, kill: v.hp <= 0
      });
    }
    if (v.brain) v.brain.onDamaged(attacker, dealt);
    if (v.hp <= 0) this.kill(v, attacker, cause, part === 'head');
  }

  kill(v, attacker, cause, head) {
    if (v.veh) { const car = this.vehById.get(v.veh.id); if (car) car.seats[v.veh.seat] = null; v.veh = null; v.body.stance = 'stand'; }
    v.alive = false;
    v.hp = 0;
    v.deathT = this.time;
    v.place = this.aliveCount() + 1;
    v.using = null; v.reloading = false;
    this.deaths++;
    // zone / fall kill credit goes to whoever hit last within 10s
    let killer = attacker;
    if (!killer && v.lastHitBy !== null && this.time - v.lastHitT < 10) killer = this.byId.get(v.lastHitBy) || null;
    if (killer && killer !== v) killer.kills++;
    this.emit({ t: 'kill', id: v.id, by: killer ? killer.id : null, cause, head, place: v.place, x: v.body.pos.x, y: v.body.pos.y, z: v.body.pos.z });
    // drop everything
    const drops = [];
    for (let s = 0; s < 3; s++) if (v.slots[s]) drops.push([v.slots[s].id, 1, v.slots[s].mag]);
    for (const k in v.inv.items) drops.push([k, v.inv.items[k], 0]);
    const n = drops.length;
    drops.forEach(([key, count, mag], i) => {
      const a = (i / Math.max(1, n)) * Math.PI * 2, r = 0.5 + (i % 2) * 0.45;
      this.dropItem(key, count, v.body.pos.x + Math.cos(a) * r, v.body.pos.y + 0.6, v.body.pos.z + Math.sin(a) * r, mag, false, v.body.pos.x, v.body.pos.z);
    });
    v.slots = [null, null, null, { id: 'fists', mag: 0 }];
    v.inv.items = {};
    v.cur = 3; v.throwType = null; v.throwHold = false;
  }

  zoneDamage(dt) {
    const dps = this.zone.dps;
    for (const p of this.players) {
      if (!p.alive || p.air) continue;
      if (!this.zone.isInside(p.body.pos.x, p.body.pos.z)) {
        this.damage(p, dps * dt, null, 'zone', null);
        p.inStorm = true;
      } else p.inStorm = false;
    }
  }

  checkWin() {
    if (this.state !== 'playing') return;
    const alive = this.players.filter((p) => p.alive);
    if (alive.length <= 1) {
      this.state = 'ended';
      let w = alive[0];
      if (!w) {
        // everyone died on the same tick: the last one processed already holds place 1
        w = this.players.find((p) => p.place === 1) || this.players.slice().sort((a, b) => b.deathT - a.deathT)[0];
      }
      w.place = 1;
      this.winner = w.id;
      this.emit({ t: 'end', winner: w.id });
    }
  }

  /* ---------------- reload ---------------- */
  startReload(p) {
    const w = this.weaponOf(p), slot = this.slotOf(p);
    if (w.reloadType === 'none' || p.reloading || p.switchT > 0) return false;
    if (slot.mag >= w.mag) return false;
    const reserve = this.cheats.infAmmo.has(p.id) ? 999 : invCount(p.inv, 'ammo_' + w.ammo);
    if (reserve <= 0) { this.emit({ t: 'noAmmo', id: p.id }); return false; }
    if (p.body.sprinting) return false;
    p.using = null;
    p.reloading = true;
    if (w.reloadType === 'shell') p.reloadT = (w.reloadStart || 0.3) + w.reload;
    else p.reloadT = slot.mag === 0 ? w.reloadEmpty : w.reload;
    p.reloadTotal = p.reloadT;
    this.emit({ t: 'reload', id: p.id, w: slot.id, dur: p.reloadT, empty: slot.mag === 0 });
    return true;
  }
  cancelReloadIfShell(p) { if (p.reloading) { p.reloading = false; p.reloadT = 0; } }

  updateReload(p, dt) {
    if (!p.reloading) return;
    const w = this.weaponOf(p), slot = this.slotOf(p);
    p.reloadT -= dt;
    if (p.reloadT > 0) return;
    const key = 'ammo_' + w.ammo;
    const inf = this.cheats.infAmmo.has(p.id);
    if (w.reloadType === 'shell') {
      const got = inf ? 1 : invTake(p.inv, key, 1);
      slot.mag += got;
      this.emit({ t: 'shellIn', id: p.id });
      if (slot.mag < w.mag && (inf || invCount(p.inv, key) > 0) && got > 0) { p.reloadT += w.reload; p.reloadTotal = w.reload; return; }
      p.reloading = false;
      this.emit({ t: 'reloadDone', id: p.id });
      return;
    }
    const need = w.mag - slot.mag;
    const got = inf ? need : invTake(p.inv, key, need);
    slot.mag += got;
    p.reloading = false;
    this.emit({ t: 'reloadDone', id: p.id });
  }

  /* ---------------- items ---------------- */
  nearestVehicle(p, maxD) {
    let best = null, bd = maxD;
    for (const v of this.vehicles) { if (v.dead) continue; const d = vehDistance(v, p.body.pos.x, p.body.pos.z); if (d < bd) { bd = d; best = v; } }
    return best;
  }
  startUse(p, key) {
    const it = ITEMS[key];
    if (!it || (it.kind !== 'heal' && it.kind !== 'fuel') || invCount(p.inv, key) <= 0) return false;
    if (it.kind === 'fuel') {
      const v = this.nearestVehicle(p, 2.5);
      if (!v) { this.emit({ t: 'deny', id: p.id, why: 'novehicle' }); return false; }
      if (v.fuel >= 99) { this.emit({ t: 'deny', id: p.id, why: 'fuelfull' }); return false; }
    } else if (p.hp >= it.maxTo) { this.emit({ t: 'deny', id: p.id, why: 'hpfull' }); return false; }
    p.reloading = false;
    p.using = { key, t: 0, dur: it.useTime };
    this.emit({ t: 'useStart', id: p.id, key, dur: it.useTime });
    return true;
  }
  finishUse(p) {
    const key = p.using.key, it = ITEMS[key];
    p.using = null;
    if (it.kind === 'fuel') {
      const v = this.nearestVehicle(p, 3);
      if (!v || invTake(p.inv, key, 1) <= 0) return;
      v.fuel = Math.min(100, v.fuel + it.fuel);
      this.emit({ t: 'refuel', id: p.id, veh: v.id });
      return;
    }
    if (invTake(p.inv, key, 1) <= 0) return;
    p.hp = Math.min(Math.max(p.hp, Math.min(it.maxTo, p.hp + it.heal)), MAX_HP);
    this.emit({ t: 'healed', id: p.id, key, hp: p.hp });
  }

  /** item the player is looking at / standing on */
  findPickup(p, range = 2.4) {
    const e = this.eye(p);
    let best = null, bestScore = Infinity;
    for (const it of this.items) {
      const dx = it.x - p.body.pos.x, dz = it.z - p.body.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > range || Math.abs(it.y - p.body.pos.y) > 2.2) continue;
      const ang = Math.abs(wrapAngle(Math.atan2(-dx, -dz) - p.aimYaw));
      const score = d + (d > 0.6 ? ang * 1.2 : 0);
      if (score >= bestScore) continue;
      if (!this.world.lineClear(e.x, e.y, e.z, it.x, it.y + 0.25, it.z)) continue;
      best = it; bestScore = score;
    }
    return best;
  }

  pickup(p, it) {
    const def = ITEMS[it.key];
    if (!def) return false;
    if (def.kind === 'weapon') return this.pickupWeapon(p, it);
    const n = invAdd(p.inv, it.key, it.count);
    if (n <= 0) { this.emit({ t: 'deny', id: p.id, why: 'full' }); return false; }
    it.count -= n;
    this.emit({ t: 'pickup', id: p.id, key: it.key, n });
    if (it.count <= 0) { this.removeItem(it); this.emit({ t: 'itemRemove', id: it.id }); }
    else this.emit({ t: 'itemUpdate', id: it.id });
    return true;
  }

  pickupWeapon(p, it) {
    const w = WEAPONS[it.key];
    let slot = -1;
    if (w.slot === 'side') slot = 2;
    else if (!p.slots[0]) slot = 0;
    else if (!p.slots[1]) slot = 1;
    else slot = (p.cur === 0 || p.cur === 1) ? p.cur : 0;
    const old = p.slots[slot];
    if (old) {
      // unload magazine into the backpack when possible
      const key = 'ammo_' + WEAPONS[old.id].ammo;
      const back = WEAPONS[old.id].ammo ? invAdd(p.inv, key, old.mag) : 0;
      this.dropItem(old.id, 1, p.body.pos.x, p.body.pos.y + 0.5, p.body.pos.z, old.mag - back);
    }
    p.slots[slot] = { id: it.key, mag: it.mag || 0 };
    this.removeItem(it);
    this.emit({ t: 'itemRemove', id: it.id });
    this.emit({ t: 'pickup', id: p.id, key: it.key, n: 1 });
    // auto equip when holding fists or the slot we replaced
    if (p.cur === 3 || p.cur === slot || !old && p.cur === 2 && slot < 2) this.switchTo(p, slot);
    return true;
  }

  autoPickup(p) {
    const wanted = new Set();
    for (let s = 0; s < 3; s++) if (p.slots[s]) wanted.add('ammo_' + WEAPONS[p.slots[s].id].ammo);
    for (const it of this.items) {
      if (Math.abs(it.x - p.body.pos.x) > 1.5 || Math.abs(it.z - p.body.pos.z) > 1.5 || Math.abs(it.y - p.body.pos.y) > 1.5) continue;
      const def = ITEMS[it.key];
      if (!def) continue;
      if ((def.kind === 'ammo' && wanted.has(it.key)) || def.kind === 'heal') {
        if (invRoomFor(p.inv, it.key) > 0) this.pickup(p, it);
      } else if (def.kind === 'weapon' && p.isBot) {
        if (p.brain && p.brain.wantsWeapon(it.key)) this.pickupWeapon(p, it);
      }
    }
  }

  /** player initiated drop from the inventory UI */
  requestDrop(pid, key, count) {
    const p = this.byId.get(pid);
    if (!p || !p.alive) return false;
    if (key.startsWith('slot')) {
      const s = +key.slice(4);
      if (s < 0 || s > 2 || !p.slots[s]) return false;
      const old = p.slots[s];
      p.slots[s] = null;
      this.dropItem(old.id, 1, p.body.pos.x, p.body.pos.y + 0.5, p.body.pos.z, old.mag);
      if (p.cur === s) { p.reloading = false; this.switchTo(p, [0, 1, 2, 3].find((i) => p.slots[i]) ?? 3); }
      return true;
    }
    const n = invTake(p.inv, key, count);
    if (n <= 0) return false;
    this.dropItem(key, n, p.body.pos.x, p.body.pos.y + 0.5, p.body.pos.z);
    if (p.using && p.using.key === key && invCount(p.inv, key) <= 0) p.using = null;
    this.ensureThrowable(p);
    return true;
  }

  separatePlayers() {
    const ps = this.players;
    for (let i = 0; i < ps.length; i++) {
      const a = ps[i];
      if (!a.alive || a.air || a.veh) continue;
      for (let j = i + 1; j < ps.length; j++) {
        const b = ps[j];
        if (!b.alive || b.air || b.veh) continue;
        const dx = b.body.pos.x - a.body.pos.x, dz = b.body.pos.z - a.body.pos.z;
        if (Math.abs(dx) > 0.7 || Math.abs(dz) > 0.7) continue;
        if (Math.abs(b.body.pos.y - a.body.pos.y) > 1.5) continue;
        const d = Math.hypot(dx, dz);
        const minD = 0.6;
        if (d >= minD) continue;
        const nx = d > 1e-4 ? dx / d : 1, nz = d > 1e-4 ? dz / d : 0;
        const push = (minD - d) * 0.5;
        this.nudge(a, -nx * push, -nz * push);
        this.nudge(b, nx * push, nz * push);
      }
    }
  }
  nudge(p, dx, dz) {
    const b = p.body, r = MOVE.radius[b.stance], h = MOVE.height[b.stance];
    if (!this.world.overlaps(b.pos.x + dx, b.pos.z + dz, r, b.pos.y + 0.05, b.pos.y + h)) {
      b.pos.x += dx; b.pos.z += dz;
      // on a slope the push can move us under the terrain: keep the feet on it
      const g = this.world.groundAt(b.pos.x, b.pos.z);
      if (b.pos.y < g) b.pos.y = g;
    }
  }

  /* ---------------- dev cheats (disabled in release builds by the client) ---------------- */
  cheat(pid, what, arg) {
    const p = this.byId.get(pid);
    if (!p) return;
    if (what === 'god') { if (this.cheats.god.has(pid)) this.cheats.god.delete(pid); else this.cheats.god.add(pid); }
    if (what === 'ammo') { if (this.cheats.infAmmo.has(pid)) this.cheats.infAmmo.delete(pid); else this.cheats.infAmmo.add(pid); }
    if (what === 'tp' && arg) { p.air = null; p.body.pos.x = arg.x; p.body.pos.y = arg.y; p.body.pos.z = arg.z; p.body.vel.x = p.body.vel.y = p.body.vel.z = 0; p.body.onGround = false; }
    if (what === 'give' && arg) {
      const it = this.dropItem(arg, ITEMS[arg].kind === 'weapon' ? 1 : (ITEMS[arg].stack || 1), p.body.pos.x, p.body.pos.y + 0.5, p.body.pos.z);
      this.pickup(p, it);
    }
    if (what === 'heal') p.hp = MAX_HP;
    if (what === 'supply') this.launchSupply(p.body.pos.x - Math.sin(p.yaw) * 14, p.body.pos.z - Math.cos(p.yaw) * 14);
    if (what === 'vehicle') {
      const x = p.body.pos.x - Math.sin(p.yaw) * 5, z = p.body.pos.z - Math.cos(p.yaw) * 5;
      this.addVehicle(arg || 'sedan', x, this.world.supportHeight(x, z, 0.5, p.body.pos.y + 2, 0), z, p.yaw, 100);
    }
    if (what === 'killbots') for (const o of this.players) if (o.isBot && o.alive) this.damage(o, 999, null, 'dev', null);
    if (what === 'zone') this.zone.timer = Math.min(this.zone.timer, 1);
  }
}

export const EDGE_KEYS = ['jump', 'crouch', 'prone', 'reload', 'interact'];

export function emptyCommand() {
  return {
    fwd: 0, right: 0, yaw: 0, pitch: 0, aimYaw: undefined, aimPitch: undefined,
    fire: false, ads: false, sprint: false, walk: false, brake: false,
    jump: false, crouch: false, prone: false, reload: false, interact: false,
    slot: -1, use: null, cycle: 0
  };
}
