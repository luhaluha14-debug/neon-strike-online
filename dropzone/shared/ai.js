/* =========================================================================
   Bot brain.  Produces the same command objects a human produces, so bots
   obey exactly the same movement / weapon rules (and can later run on the
   server unchanged).
   States: LOOT, ROAM, ZONE, ENGAGE, CHASE, COVER, HEAL
   ========================================================================= */
import { clamp, wrapAngle, DEG, anglesFromDir } from './util.js';
import { WEAPONS } from './weapons.js';
import { ITEMS, invCount } from './items.js';
import { eyeHeight } from './movement.js';

export const BOT_DIFF = {
  easy: { react: 0.85, err: 4.2, errDecay: 0.9, turn: 2.6, sight: 60, fov: 110, burst: 0.3, pause: 0.6, comp: 0.25, lead: 0, head: 0.04, ads: 0.2, strafe: 0.35, fireCone: 5 },
  normal: { react: 0.48, err: 2.6, errDecay: 1.6, turn: 4.8, sight: 85, fov: 140, burst: 0.42, pause: 0.38, comp: 0.6, lead: 0.6, head: 0.18, ads: 0.6, strafe: 0.7, fireCone: 3.5 },
  hard: { react: 0.24, err: 1.5, errDecay: 2.6, turn: 8.5, sight: 120, fov: 160, burst: 0.6, pause: 0.22, comp: 0.85, lead: 1, head: 0.33, ads: 0.9, strafe: 1, fireCone: 2.5 }
};

const RANK = { fists: 0, hornet: 1, breaker: 2, wasp: 2, kestrel: 3 };

export class BotBrain {
  constructor(match, p, diff, r) {
    this.m = match;
    this.p = p;
    this.d = BOT_DIFF[diff] || BOT_DIFF.normal;
    this.state = 'LOOT';
    this.path = null; this.pathIdx = 0; this.goal = null; this.repathT = 0;
    this.target = null; this.seenT = -99; this.lastKnown = null; this.reactT = 0; this.awareT = -99;
    this.aimYaw = p.yaw; this.aimPitch = 0;
    this.errY = 0; this.errP = 0;
    this.recP = 0; this.recY = 0; this.lastShots = 0;
    this.burstT = 0; this.pauseT = 0;
    this.strafeDir = r < 0.5 ? 1 : -1; this.strafeT = 0;
    this.thinkT = r * 0.3; this.perceiveT = r * 0.2;
    this.stuckT = 0; this.lastPos = { x: p.body.pos.x, z: p.body.pos.z }; this.progressT = 0;
    this.lootTarget = null; this.ignoreItems = new Set();
    this.holdT = 0;
    this.personality = r;              // 0..1, bias for aggression
    this.coverPt = null;
    this.wantCrouch = false;
    this.scanT = 0; this.lookYaw = p.yaw;
  }

  /* ---------------- perception ---------------- */
  canSee(o) {
    const p = this.p, m = this.m;
    const ex = p.body.pos.x, ey = p.body.pos.y + eyeHeight(p.body), ez = p.body.pos.z;
    const ox = o.body.pos.x, oz = o.body.pos.z;
    const dx = ox - ex, dz = oz - ez;
    const d = Math.hypot(dx, dz);
    let sight = this.d.sight;
    if (o.body.stance === 'prone') sight *= 0.55; else if (o.body.stance === 'crouch') sight *= 0.8;
    if (d > sight) return false;
    const recentlyHit = m.time - this.awareT < 2.5;
    if (d > 6 && !recentlyHit) {
      const ang = Math.abs(wrapAngle(Math.atan2(-dx, -dz) - this.aimYaw));
      if (ang > (this.d.fov * DEG) / 2) return false;
    }
    if (d > 10 && o.body.moveSpeed < 1.5 && o.body.stance !== 'stand' && m.world.inBush(ox, oz, o.body.pos.y + 0.8)) return false;
    // line of sight to head or chest
    const hy = o.body.pos.y + (o.body.stance === 'stand' ? 1.55 : o.body.stance === 'crouch' ? 1.0 : 0.3);
    if (m.world.lineClear(ex, ey, ez, ox, hy, oz)) return true;
    const cy = o.body.pos.y + (o.body.stance === 'prone' ? 0.25 : 0.9);
    return m.world.lineClear(ex, ey, ez, ox, cy, oz);
  }

  perceive() {
    const p = this.p, m = this.m;
    let best = null, bestD = Infinity;
    for (const o of m.players) {
      if (o === p || !o.alive || o.air === 'plane') continue;
      const d = Math.hypot(o.body.pos.x - p.body.pos.x, o.body.pos.z - p.body.pos.z);
      if (d > this.d.sight + 5) continue;
      // hearing gunfire: become aware of the shooter
      if (m.time - o.lastShotT < 0.3 && d < 85 && (!this.target || this.target === o)) {
        if (!this.lastKnown || m.time - this.seenT > 1.5) { this.lastKnown = { x: o.body.pos.x, y: o.body.pos.y, z: o.body.pos.z }; this.heardT = m.time; this.heardId = o.id; }
      }
      const pref = this.target === o ? d * 0.6 : d;          // stick to current target
      if (pref < bestD && this.canSee(o)) { best = o; bestD = pref; }
    }
    if (best) {
      if (this.target !== best) {
        this.target = best;
        this.reactT = this.d.react * (0.8 + Math.random() * 0.5) * (m.time - this.awareT < 2 ? 0.5 : 1);
        const e = this.d.err * (0.7 + Math.random() * 0.6);
        const a = Math.random() * Math.PI * 2;
        this.errY = Math.cos(a) * e * DEG; this.errP = Math.sin(a) * e * DEG * 0.6;
        this.aimHead = Math.random() < this.d.head;
      }
      this.seenT = m.time;
      this.lastKnown = { x: best.body.pos.x, y: best.body.pos.y, z: best.body.pos.z };
    } else if (this.target && (!this.target.alive || m.time - this.seenT > 8)) {
      this.target = null;
    }
  }

  onDamaged(attacker) {
    if (!attacker || attacker === this.p) return;
    this.awareT = this.m.time;
    if (!this.target || !this.target.alive || this.m.time - this.seenT > 1) {
      this.lastKnown = { x: attacker.body.pos.x, y: attacker.body.pos.y, z: attacker.body.pos.z };
      this.heardT = this.m.time; this.heardId = attacker.id;
    }
  }

  /* ---------------- inventory knowledge ---------------- */
  bestWeaponSlot(dist) {
    const p = this.p;
    let best = 3, bestScore = -1;
    for (let s = 0; s < 3; s++) {
      const sl = p.slots[s];
      if (!sl) continue;
      const w = WEAPONS[sl.id];
      const ammo = sl.mag + invCount(p.inv, 'ammo_' + w.ammo);
      if (ammo <= 0) continue;
      let sc = RANK[sl.id] || 1;
      if (dist !== undefined) {
        if (w.cat === 'shotgun') sc += dist < 14 ? 3 : dist > 35 ? -2 : 0;
        if (w.cat === 'smg') sc += dist < 30 ? 1.2 : dist > 60 ? -1 : 0;
        if (w.cat === 'ar') sc += dist > 25 ? 1.5 : 0;
      }
      if (sc > bestScore) { bestScore = sc; best = s; }
    }
    return best;
  }
  hasGun() { return this.bestWeaponSlot() !== 3; }
  /** distance at which this bot is willing to open fire with its best weapon */
  engageRange() {
    const s = this.bestWeaponSlot();
    const cat = s === 3 ? 'melee' : WEAPONS[this.p.slots[s].id].cat;
    const base = { melee: 5, shotgun: 24, smg: 45, pistol: 35, ar: 80 }[cat] || 40;
    return base * (this.d.sight / 85) * (0.8 + this.personality * 0.4);
  }
  wantsWeapon(key) {
    const p = this.p, w = WEAPONS[key];
    if (w.slot === 'side') return !p.slots[2];
    if (!p.slots[0] || !p.slots[1]) return !(p.slots[0] && p.slots[0].id === key) && !(p.slots[1] && p.slots[1].id === key);
    return false;
  }
  itemValue(it) {
    const p = this.p, def = ITEMS[it.key];
    if (!def) return 0;
    if (def.kind === 'weapon') return this.wantsWeapon(it.key) ? 3 + (RANK[it.key] || 0) : 0;
    if (def.kind === 'ammo') {
      for (let s = 0; s < 3; s++) if (p.slots[s] && 'ammo_' + WEAPONS[p.slots[s].id].ammo === it.key) return invCount(p.inv, it.key) < 90 ? 2 : 0.3;
      return 0;
    }
    if (def.kind === 'heal') return invCount(p.inv, it.key) < (it.key === 'medkit' ? 1 : 5) ? 1.5 : 0;
    return 0;
  }
  needsLoot() {
    const p = this.p;
    if (!this.hasGun()) return true;
    let ammo = 0;
    for (let s = 0; s < 3; s++) if (p.slots[s]) ammo += invCount(p.inv, 'ammo_' + WEAPONS[p.slots[s].id].ammo);
    return !p.slots[0] || ammo < 60 || invCount(p.inv, 'bandage') < 2;
  }
  findLoot(maxD) {
    const p = this.p;
    let best = null, bestS = -Infinity;
    for (const it of this.m.items) {
      if (this.ignoreItems.has(it.id)) continue;
      const d = Math.hypot(it.x - p.body.pos.x, it.z - p.body.pos.z);
      if (d > maxD || Math.abs(it.y - p.body.pos.y) > 2.5) continue;    // bots stay on their level
      // the nav grid is ground floor only: skip items on steps, crates, upper floors
      const k = this.m.nav.index(it.x, it.z);
      if (k < 0 || Math.abs(it.y - this.m.nav.floorY[k]) > 0.3) continue;
      const v = this.itemValue(it);
      if (v <= 0) continue;
      if (!this.m.zone.isInside(it.x, it.z, -5) && this.m.zone.stage === 'shrink') continue;
      const s = v * 12 - d;
      if (s > bestS) { bestS = s; best = it; }
    }
    return best;
  }

  /* ---------------- navigation ---------------- */
  goTo(x, z, force = false) {
    if (!force && this.goal && Math.hypot(this.goal.x - x, this.goal.z - z) < 2 && (this.path || this.pendingPath)) return;
    this.goal = { x, z };
    this.path = null;
    this.pendingPath = true;
    this.computePath();
  }
  /** A* is the expensive part of AI: the match hands out a small budget per tick */
  computePath() {
    if (this.m.pathBudget <= 0) return false;
    this.m.pathBudget--;
    this.path = this.m.nav.findPath(this.p.body.pos.x, this.p.body.pos.z, this.goal.x, this.goal.z, 5000);
    this.pendingPath = false;
    this.pathIdx = 0;
    this.repathT = 4 + Math.random() * 2;
    return true;
  }
  /** returns world move dir {x,z} (zero while waiting for a path) or null when arrived */
  follow(dt) {
    const p = this.p;
    if (this.pendingPath && !this.computePath()) return { x: 0, z: 0, d: 1, waiting: true };
    if (!this.path || this.pathIdx >= this.path.length) return null;
    this.repathT -= dt;
    if (this.repathT <= 0 && this.goal) this.goTo(this.goal.x, this.goal.z, true);
    if (!this.path) return null;
    let wp = this.path[this.pathIdx];
    let dx = wp.x - p.body.pos.x, dz = wp.z - p.body.pos.z;
    let d = Math.hypot(dx, dz);
    while (d < 0.7 && this.pathIdx < this.path.length - 1) {
      this.pathIdx++;
      wp = this.path[this.pathIdx];
      dx = wp.x - p.body.pos.x; dz = wp.z - p.body.pos.z; d = Math.hypot(dx, dz);
    }
    if (d < 0.6 && this.pathIdx >= this.path.length - 1) { this.path = null; return null; }
    return { x: dx / d, z: dz / d, d };
  }

  findCover(from) {
    const p = this.p, m = this.m;
    const fy = from.y + 1.4;
    let best = null, bestD = Infinity;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + Math.random() * 0.3;
      for (const r of [3, 6, 10]) {
        const x = p.body.pos.x + Math.cos(a) * r, z = p.body.pos.z + Math.sin(a) * r;
        if (!m.nav.isWalk(x, z)) continue;
        const g = m.world.supportHeight(x, z, 0.3, p.body.pos.y + 1, 0);
        if (m.world.lineClear(from.x, fy, from.z, x, g + 1.1, z)) continue;    // still visible
        const toward = Math.hypot(x - from.x, z - from.z) < Math.hypot(p.body.pos.x - from.x, p.body.pos.z - from.z) ? 3 : 0;
        const sc = r + toward;
        if (sc < bestD) { bestD = sc; best = { x, z }; }
        break;
      }
    }
    return best;
  }

  /* ---------------- skydive ---------------- */
  /** pick where to land and when to jump (called once at match start) */
  planDrop(plane) {
    const W = this.m.world;
    let tx, tz;
    if (Math.random() < 0.72 && W.locations.length) {
      const L = W.locations[Math.floor(Math.random() * W.locations.length)];
      tx = L.x + (Math.random() - 0.5) * 50; tz = L.z + (Math.random() - 0.5) * 50;
    } else {
      const sp = W.spawnSpots[Math.floor(Math.random() * W.spawnSpots.length)];
      tx = sp.x; tz = sp.z;
    }
    // land on a clear outdoor spot, never on a roof
    let best = null, bd = Infinity;
    for (const sp of W.spawnSpots) { const d = (sp.x - tx) ** 2 + (sp.z - tz) ** 2; if (d < bd) { bd = d; best = sp; } }
    this.dropTarget = best ? { x: best.x + (Math.random() - 0.5) * 4, z: best.z + (Math.random() - 0.5) * 4 } : { x: tx, z: tz };
    // jump a little before the closest point of the route so we can glide the rest
    this.jumpAt = plane.project(this.dropTarget.x, this.dropTarget.z) - 20 - Math.random() * 35;
    this.wasAir = true;
  }

  thinkAir() {
    const p = this.p, m = this.m, c = p.cmd;
    c.fwd = 0; c.right = 0; c.fire = false; c.ads = false; c.sprint = false;
    if (p.air === 'plane') {
      c.yaw = m.plane.yaw; c.pitch = 0;
      if (m.plane.inside && m.plane.d >= this.jumpAt) c.jump = true;
      return;
    }
    const T = this.dropTarget || { x: p.body.pos.x, z: p.body.pos.z };
    const dx = T.x - p.body.pos.x, dz = T.z - p.body.pos.z, d = Math.hypot(dx, dz);
    if (d > 1) c.yaw = Math.atan2(-dx, -dz);
    const h = p.body.pos.y - m.world.groundAt(p.body.pos.x, p.body.pos.z);
    if (p.air === 'fall') {
      c.fwd = d > 6 ? 1 : 0;
      if (d > 150) c.jump = true;                  // far target: open the chute early and glide
      c.pitch = d < h * 0.45 ? -1.2 : 0;           // close enough: dive, otherwise glide
    } else {
      c.fwd = d > 3 ? 1 : 0;
      c.pitch = -0.3;
    }
    this.aimYaw = c.yaw; this.lookYaw = c.yaw;
  }

  /* ---------------- main ---------------- */
  think(dt) {
    const p = this.p, m = this.m, c = p.cmd;
    if (p.air) { this.thinkAir(); return; }
    if (this.wasAir) {
      // just landed: start looting right here
      this.wasAir = false;
      this.state = 'LOOT'; this.path = null; this.pendingPath = false; this.goal = null;
      this.lastPos.x = p.body.pos.x; this.lastPos.z = p.body.pos.z;
      this.thinkT = 0;
    }
    const w = m.weaponOf(p), slot = m.slotOf(p);
    // reset per tick inputs (edges are consumed by the sim)
    c.fwd = 0; c.right = 0; c.fire = false; c.ads = false; c.sprint = false; c.walk = false;

    this.perceiveT -= dt;
    if (this.perceiveT <= 0) { this.perceiveT = 0.18 + Math.random() * 0.08; this.perceive(); }

    this.thinkT -= dt;
    if (this.thinkT <= 0) { this.thinkT = 0.3 + Math.random() * 0.15; this.decide(); }

    // recoil bookkeeping: our own shots kick the aim like a human's view
    if (p.shots !== this.lastShots) {
      const n = p.shots - this.lastShots;
      this.lastShots = p.shots;
      const R = w.recoil;
      const mul = (p.ads ? R.ads : 1) * (1 - this.d.comp);
      this.recP += R.up * DEG * n * mul;
      this.recY += (R.bias + (Math.random() * 2 - 1) * R.side) * DEG * n * mul;
    }
    const rec = Math.min(1, w.recoil.recover * dt);
    this.recP -= this.recP * rec; this.recY -= this.recY * rec;

    let moveDir = null, wantYaw = this.lookYaw, wantPitch = 0, turnMul = 0.6;
    const tgt = this.target;
    const seeing = tgt && tgt.alive && m.time - this.seenT < 0.35;

    switch (this.state) {
      case 'ENGAGE': {
        if (!tgt || !tgt.alive) { this.state = 'ROAM'; break; }
        const dist = Math.hypot(tgt.body.pos.x - p.body.pos.x, tgt.body.pos.z - p.body.pos.z);
        // weapon choice
        const want = this.bestWeaponSlot(dist);
        if (want !== p.cur && !c.fire && this.burstT <= 0) c.slot = want;
        // aim
        const aim = this.aimAt(tgt, w);
        wantYaw = aim.yaw; wantPitch = aim.pitch; turnMul = 1;
        if (seeing) {
          this.reactT -= dt;
          this.errY *= Math.exp(-this.d.errDecay * dt); this.errP *= Math.exp(-this.d.errDecay * dt);
          const off = Math.abs(wrapAngle(this.aimYaw - wantYaw)) + Math.abs(this.aimPitch - wantPitch);
          const coneOk = off < (this.d.fireCone * DEG) * (dist < 10 ? 3 : 1) + 0.6 / Math.max(dist, 1);
          const hasAmmo = w.cat === 'melee' ? dist < 2.2 : slot.mag > 0;
          if (this.reactT <= 0 && coneOk && hasAmmo && p.switchT <= 0) {
            if (this.pauseT > 0) this.pauseT -= dt;
            else {
              c.fire = w.mode === 'semi' ? !p.triggerHeld : true;
              this.burstT += dt;
              const burstLen = this.d.burst * (dist < 15 ? 2.2 : dist > 50 ? 0.6 : 1);
              if (this.burstT > burstLen && w.mode === 'auto') { this.burstT = 0; this.pauseT = this.d.pause * (dist > 40 ? 1.8 : 1); }
            }
          }
          c.ads = dist > 18 && Math.random() < this.d.ads + 0.3 && w.cat !== 'shotgun' && w.cat !== 'melee';
          if (w.cat !== 'melee' && slot.mag === 0) { c.reload = true; this.state = 'COVER'; this.coverPt = this.findCover(tgt.body.pos); }
        }
        // movement: strafe + range keeping
        this.strafeT -= dt;
        if (this.strafeT <= 0) { this.strafeT = 0.5 + Math.random() * 1.1; if (Math.random() < 0.7) this.strafeDir *= -1; this.wantCrouch = dist > 25 && Math.random() < 0.35 * this.d.strafe; }
        const toX = (tgt.body.pos.x - p.body.pos.x) / Math.max(dist, 0.01), toZ = (tgt.body.pos.z - p.body.pos.z) / Math.max(dist, 0.01);
        let mx = -toZ * this.strafeDir * this.d.strafe, mz = toX * this.strafeDir * this.d.strafe;
        const pref = w.cat === 'shotgun' || w.cat === 'melee' ? 4 : w.cat === 'smg' ? 12 : w.cat === 'pistol' ? 15 : 30;
        if (!seeing) { this.state = 'CHASE'; break; }
        if (dist > pref * 1.4) { mx += toX; mz += toZ; }
        else if (dist < pref * 0.5 && w.cat !== 'melee') { mx -= toX * 0.7; mz -= toZ * 0.7; }
        if (w.cat === 'melee' && !this.hasGun()) {
          // unarmed vs armed: run away toward loot instead
          if (m.slotOf(tgt).id !== 'fists' && dist > 4) { this.state = 'LOOT'; break; }
          mx = toX; mz = toZ;
        }
        if (this.wantCrouch && p.body.stance === 'stand' && !p.body.stanceLock) c.crouch = true;
        if (!this.wantCrouch && p.body.stance === 'crouch' && Math.random() < 0.02) c.crouch = true;
        moveDir = { x: mx, z: mz };
        if (p.hp < 30 && tgt.hp > p.hp + 20 && this.personality < 0.7) { this.state = 'COVER'; this.coverPt = this.findCover(tgt.body.pos); }
        break;
      }
      case 'COVER': {
        if (p.body.stance === 'prone') c.prone = true;
        if (this.coverPt) {
          const dx = this.coverPt.x - p.body.pos.x, dz = this.coverPt.z - p.body.pos.z, d = Math.hypot(dx, dz);
          if (d > 0.8) { moveDir = { x: dx / d, z: dz / d }; c.sprint = !p.reloading || d > 4; }
          else if (p.body.stance === 'stand' && Math.random() < 0.3) c.crouch = true;
        }
        if (tgt && seeing) { const aim = this.aimAt(tgt, w); wantYaw = aim.yaw; wantPitch = aim.pitch; }
        if (!p.reloading && slot.mag === 0 && w.cat !== 'melee') { c.reload = true; if (invCount(p.inv, 'ammo_' + w.ammo) <= 0) c.slot = this.bestWeaponSlot(); }
        break;
      }
      case 'CHASE': {
        if (this.lastKnown) {
          const d = Math.hypot(this.lastKnown.x - p.body.pos.x, this.lastKnown.z - p.body.pos.z);
          if (d < 2) { this.lastKnown = null; this.state = 'ROAM'; break; }
          this.goTo(this.lastKnown.x, this.lastKnown.z);
          moveDir = this.follow(dt);
          wantYaw = Math.atan2(-(this.lastKnown.x - p.body.pos.x), -(this.lastKnown.z - p.body.pos.z));
          turnMul = 0.9;
          if (p.body.stance !== 'stand') c.crouch = p.body.stance === 'crouch';
        } else this.state = 'ROAM';
        break;
      }
      case 'HEAL': {
        if (!p.using) {
          const key = p.hp < 60 && invCount(p.inv, 'medkit') > 0 ? 'medkit' : invCount(p.inv, 'bandage') > 0 && p.hp < 75 ? 'bandage' : null;
          if (key) c.use = key; else this.state = 'ROAM';
        }
        if (p.body.stance === 'stand' && Math.random() < 0.05) c.crouch = true;
        this.scan(dt);
        wantYaw = this.lookYaw;
        break;
      }
      case 'LOOT': case 'ZONE': case 'ROAM': {
        if (this.state === 'LOOT' && this.lootTarget) {
          const it = this.lootTarget;
          if (!m.itemById.has(it.id)) { this.lootTarget = null; this.decide(); break; }
          const d = Math.hypot(it.x - p.body.pos.x, it.z - p.body.pos.z);
          if (d < 1.4) {
            // pick up exactly the item we walked to (humans use the look-at picker)
            if (this.itemValue(it) > 0) m.pickup(p, it);
            this.ignoreItems.add(it.id);
            this.lootTarget = null;
          } else { this.goTo(it.x, it.z); moveDir = this.follow(dt); if (!moveDir && d > 1.4 && !this.pendingPath) { this.ignoreItems.add(it.id); this.lootTarget = null; } }
        } else {
          if (!this.path && !this.pendingPath) { if (this.state === 'ROAM') this.holdT -= dt; if (this.holdT <= 0) this.pickRoam(); }
          moveDir = this.follow(dt);
        }
        if (moveDir && moveDir.waiting) { this.scan(dt); wantYaw = this.lookYaw; moveDir = null; }
        else if (moveDir) {
          wantYaw = Math.atan2(-moveDir.x, -moveDir.z);
          c.sprint = this.state === 'ZONE' || (this.state !== 'ROAM' && moveDir.d > 12) || m.zone.stage === 'shrink' && !m.zone.isInside(p.body.pos.x, p.body.pos.z, 5);
          if (p.body.stance !== 'stand' && !c.crouch) c[p.body.stance === 'crouch' ? 'crouch' : 'prone'] = true;
        } else { this.scan(dt); wantYaw = this.lookYaw; }
        // lost target recently heard: look there
        if (this.heardT && m.time - this.heardT < 2 && this.lastKnown) {
          wantYaw = Math.atan2(-(this.lastKnown.x - p.body.pos.x), -(this.lastKnown.z - p.body.pos.z)); turnMul = 0.9;
        }
        // switch to best weapon while roaming, reload when partially empty
        const want = this.bestWeaponSlot(40);
        if (want !== p.cur) c.slot = want;
        if (w.cat !== 'melee' && slot.mag < w.mag * 0.5 && !p.reloading && invCount(p.inv, 'ammo_' + w.ammo) > 0) c.reload = true;
        break;
      }
    }

    // ---- turn toward wanted angles (bounded turn rate) ----
    const turn = this.d.turn * turnMul * dt;
    const tyaw = wantYaw + (this.state === 'ENGAGE' ? this.errY : 0);
    const tp = wantPitch + (this.state === 'ENGAGE' ? this.errP : 0);
    const dy = wrapAngle(tyaw - this.aimYaw);
    this.aimYaw = wrapAngle(this.aimYaw + clamp(dy, -turn, turn));
    this.aimPitch += clamp(tp - this.aimPitch, -turn, turn);
    c.yaw = wrapAngle(this.aimYaw + this.recY);
    c.pitch = clamp(this.aimPitch + this.recP, -1.4, 1.4);
    c.aimYaw = c.yaw; c.aimPitch = c.pitch;

    // ---- convert world move dir to local fwd/right ----
    if (moveDir) {
      let mx = moveDir.x, mz = moveDir.z;
      const l = Math.hypot(mx, mz);
      if (l > 1e-3) { mx /= l; mz /= l; }
      // wall avoidance feelers
      this.unstick(dt, l > 1e-3);
      if (this.sidestep > 0) { const t = mx; mx = -mz * this.sideSign; mz = t * this.sideSign; this.sidestep -= dt; }
      const sy = Math.sin(c.yaw), cy = Math.cos(c.yaw);
      c.fwd = mx * -sy + mz * -cy;
      c.right = mx * cy + mz * -sy;
      if (c.fwd < 0.55) c.sprint = false;
    } else { this.progressT = 0; }
  }

  unstick(dt, moving) {
    const p = this.p;
    const d = Math.hypot(p.body.pos.x - this.lastPos.x, p.body.pos.z - this.lastPos.z);
    if (!moving) return;
    this.progressT += dt;
    if (this.progressT > 0.6) {
      if (d < 0.35) {
        this.stuckT += this.progressT;
        p.cmd.jump = true;
        if (this.stuckT > 1.2) { this.sidestep = 0.6; this.sideSign = Math.random() < 0.5 ? 1 : -1; }
        if (this.stuckT > 2.5) { this.stuckT = 0; if (this.goal) this.goTo(this.goal.x + (Math.random() - 0.5) * 6, this.goal.z + (Math.random() - 0.5) * 6, true); if (this.lootTarget) { this.ignoreItems.add(this.lootTarget.id); this.lootTarget = null; } }
      } else this.stuckT = 0;
      this.progressT = 0;
      this.lastPos.x = p.body.pos.x; this.lastPos.z = p.body.pos.z;
    }
  }

  scan(dt) {
    this.scanT -= dt;
    if (this.scanT <= 0) { this.scanT = 1 + Math.random() * 2; this.lookYaw = wrapAngle(this.aimYaw + (Math.random() - 0.5) * 2.4); }
  }

  aimAt(t, w) {
    const p = this.p;
    const ex = p.body.pos.x, ey = p.body.pos.y + eyeHeight(p.body), ez = p.body.pos.z;
    const st = t.body.stance;
    let ty = t.body.pos.y + (this.aimHead ? (st === 'stand' ? 1.6 : st === 'crouch' ? 1.07 : 0.3) : (st === 'stand' ? 1.15 : st === 'crouch' ? 0.8 : 0.25));
    let tx = t.body.pos.x, tz = t.body.pos.z;
    const dist = Math.hypot(tx - ex, tz - ez);
    if (w.bulletSpeed > 0) {
      const tt = dist / w.bulletSpeed;
      tx += t.body.vel.x * tt * this.d.lead; tz += t.body.vel.z * tt * this.d.lead;
      ty += 0.5 * 9.81 * tt * tt * this.d.lead;
    }
    return anglesFromDir(tx - ex, ty - ey, tz - ez);
  }

  pickRoam() {
    const p = this.p, m = this.m, z = m.zone;
    const tgtC = z.stage === 'shrink' || z.timer < 25 ? z.next : z.cur;
    const r = Math.max(4, tgtC.r * 0.7);
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * r;
      let x = tgtC.x + Math.cos(a) * d, zz = tgtC.z + Math.sin(a) * d;
      // don't wander too far in one go
      const dx = x - p.body.pos.x, dz = zz - p.body.pos.z, L = Math.hypot(dx, dz);
      if (L > 70 && this.state === 'ROAM') { x = p.body.pos.x + dx / L * 70; zz = p.body.pos.z + dz / L * 70; }
      if (m.nav.isWalk(x, zz)) { this.goTo(x, zz, true); this.holdT = 1 + Math.random() * 5 * (1 - this.personality); return; }
    }
  }

  decide() {
    const p = this.p, m = this.m, z = m.zone;
    const tgt = this.target;
    const seeing = tgt && tgt.alive && m.time - this.seenT < 0.5;
    if (this.state === 'COVER') {
      const slot = m.slotOf(p);
      const ready = !p.reloading && (slot.mag > 0 || m.weaponOf(p).cat === 'melee');
      if (ready && (p.hp > 35 || !seeing)) this.state = seeing ? 'ENGAGE' : (p.hp < 60 ? 'HEAL' : 'CHASE');
      if (m.time - this.seenT > 5 && ready) this.state = 'ROAM';
      return;
    }
    if (seeing) {
      const dist = Math.hypot(tgt.body.pos.x - p.body.pos.x, tgt.body.pos.z - p.body.pos.z);
      const shotAt = m.time - this.awareT < 3;
      const earlyLoot = m.time < 35 + this.personality * 35 && dist > 18 && this.needsLoot();
      if ((!this.hasGun() && dist > 5) || (earlyLoot && !shotAt)) {
        // unarmed: avoid fights, keep looting
      } else if (dist <= this.engageRange() || shotAt) { this.state = 'ENGAGE'; return; }
      else if (this.personality > 0.55 && this.hasGun() && p.hp > 50) { this.state = 'CHASE'; return; }
    }
    const outside = !z.isInside(p.body.pos.x, p.body.pos.z, 2);
    const nextFar = z.distOutside(p.body.pos.x, p.body.pos.z) > -3 || (z.stage === 'shrink' || z.timer < 20) && Math.hypot(p.body.pos.x - z.next.x, p.body.pos.z - z.next.z) > z.next.r - 3;
    if (outside || (nextFar && (z.stage === 'shrink' || z.timer < 20))) {
      if (this.state !== 'ZONE' || (!this.path && !this.pendingPath)) {
        this.state = 'ZONE';
        const c = z.stage === 'shrink' || z.timer < 20 ? z.next : z.cur;
        const a = Math.atan2(p.body.pos.z - c.z, p.body.pos.x - c.x);
        const rr = Math.max(0, c.r * 0.55);
        this.goTo(c.x + Math.cos(a) * rr, c.z + Math.sin(a) * rr, true);
      }
      return;
    }
    if (this.state === 'ZONE' && (this.path || this.pendingPath)) return;
    if (this.lastKnown && tgt && tgt.alive && m.time - this.seenT < 6 && p.hp > 40 && this.hasGun()) { this.state = 'CHASE'; return; }
    if (this.heardT && m.time - this.heardT < 4 && this.lastKnown && this.hasGun() && this.personality > 0.35 && p.hp > 50) { this.state = 'CHASE'; return; }
    const healable = (p.hp < 60 && (invCount(p.inv, 'bandage') > 0 || invCount(p.inv, 'medkit') > 0)) || (p.hp < 75 && invCount(p.inv, 'bandage') > 0 && p.hp < 70);
    if (healable && m.time - this.seenT > 2.5) { this.state = 'HEAL'; return; }
    if (this.state === 'HEAL' && p.using) return;
    if (this.needsLoot() || this.personality > 0.5) {
      const it = this.lootTarget && m.itemById.has(this.lootTarget.id) ? this.lootTarget : this.findLoot(this.needsLoot() ? 60 : 25);
      if (it) { this.state = 'LOOT'; this.lootTarget = it; return; }
    }
    if (this.state !== 'ROAM') { this.state = 'ROAM'; this.path = null; }
  }
}

