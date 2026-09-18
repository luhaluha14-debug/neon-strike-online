/* =============================================================================
   server side bots.  they keep a room playable when only one or two people are
   in it, and they are simulated here so every client sees the same thing.

   they run a lighter combat model than the offline bots: attacks resolve
   against the collision world with a travel delay instead of a simulated
   projectile, and area sorcery is applied as scheduled ticks.  movement,
   pathing, cover, dodging and domain use are real.
   ========================================================================== */
import { CHARACTERS, abilityOf, RULES } from './shared.js';

const LEVELS = {
  easy: { aimError: 0.09, turn: 3.0, react: 0.55, burst: [0.25, 0.6], rest: [0.5, 1.1], hitBase: 0.45, ability: 0.3, cover: 0.3 },
  normal: { aimError: 0.04, turn: 5.0, react: 0.3, burst: [0.35, 0.9], rest: [0.25, 0.6], hitBase: 0.66, ability: 0.6, cover: 0.4 },
  hard: { aimError: 0.018, turn: 7.6, react: 0.16, burst: [0.5, 1.3], rest: [0.12, 0.35], hitBase: 0.84, ability: 0.9, cover: 0.5 }
};

const clamp = (v, a, b) => (v < a ? a : (v > b ? b : v));
const rnd = (a, b) => a + Math.random() * (b - a);
const angleDelta = (a, b) => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

export class ServerBot {
  constructor(room, p, level) {
    this.room = room;
    this.p = p;
    this.cfg = LEVELS[level] || LEVELS.normal;
    this.target = null;
    this.lastSeen = 0;
    this.goal = null;
    this.path = null;
    this.pathIdx = 0;
    this.nextPath = 0;
    this.nextThink = 0;
    this.fireUntil = 0;
    this.restUntil = 0;
    this.nextAbility = 0;
    this.strafe = Math.random() < 0.5 ? -1 : 1;
    this.flipAt = 0;
    this.pending = [];
    this.focus = 0;
    this.stuck = 0;
    this.lastPos = { x: 0, z: 0 };
  }

  get world() { return this.room.world; }
  get nav() { return this.room.nav; }
  get char() { return CHARACTERS[this.p.character]; }

  update(dt, t) {
    const p = this.p;
    this.runPending(t);
    if (!p.alive) return;
    if (t >= this.nextThink) {
      this.nextThink = t + 0.12;
      this.perceive(t);
      this.plan(t);
    }
    this.aim(dt, t);
    this.act(t);
    this.move(dt, t);
  }

  runPending(t) {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (t < this.pending[i].at) continue;
      const job = this.pending.splice(i, 1)[0];
      try { job.fn(); } catch (e) { /* the target may have left */ }
    }
  }
  later(delay, fn) { this.pending.push({ at: Date.now() / 1000 + delay, fn }); }

  sees(o) {
    const p = this.p;
    return !this.world.segBlocked(p.pos.x, p.pos.y + p.height - RULES.eyeDrop, p.pos.z,
      o.pos.x, o.pos.y + o.height * 0.55, o.pos.z);
  }

  perceive(t) {
    const p = this.p;
    let best = null, bestScore = -1e9;
    for (const o of this.room.players.values()) {
      if (o === p || !o.alive || o.team === p.team) continue;
      const d = Math.hypot(o.pos.x - p.pos.x, o.pos.z - p.pos.z);
      const sees = this.sees(o);
      if (!sees && d > 24) continue;
      let score = 90 - d * 1.5 + (sees ? 45 : 0);
      if (o.hp / o.maxHp < 0.45) score += 20;
      if (o === this.target) score += 12;
      if (score > bestScore) { bestScore = score; best = { o, d, sees }; }
    }
    if (best) {
      this.target = best.o;
      this.dist = best.d;
      this.visible = best.sees;
      if (best.sees) this.lastSeen = t;
    } else {
      this.visible = false;
      if (t - this.lastSeen > 5) this.target = null;
    }
  }

  plan(t) {
    const p = this.p;
    const melee = this.char.primary.kind === 'melee';
    this.ideal = melee ? 2.4 : clamp(this.char.primary.range * 0.33, 9, 24);
    if (!this.target) {
      if (!this.goal || Math.hypot(this.goal.x - p.pos.x, this.goal.z - p.pos.z) < 3) this.goal = this.roam();
      this.mode = 'roam';
      return;
    }
    const hpFrac = p.hp / p.maxHp;
    if (hpFrac < this.cfg.cover && this.visible) {
      this.mode = 'cover';
      if (t > this.nextPath) {
        const spot = this.nav.coverNear(p.pos.x, p.pos.z, this.target.pos.x, this.target.pos.z, this.world, 14);
        this.goal = spot || this.roam();
        this.path = null;
      }
      return;
    }
    this.mode = this.visible ? 'engage' : 'hunt';
    this.goal = { x: this.target.pos.x, z: this.target.pos.z };
  }

  /* wander toward the contested middle rather than standing in spawn */
  roam() {
    const nav = this.nav;
    const reach = nav.nx * nav.cell * 0.45;
    for (let i = 0; i < 24; i++) {
      const k = (Math.random() * nav.walk.length) | 0;
      if (!nav.walk[k]) continue;
      const x = nav.cx(k), z = nav.cz(k);
      if (Math.hypot(x, z) > reach) continue;
      return { x, z };
    }
    return { x: 0, z: 0 };
  }

  aim(dt, t) {
    const p = this.p, cfg = this.cfg;
    if (!this.target) return;
    const o = this.target;
    const dx = o.pos.x - p.pos.x;
    const dy = (o.pos.y + o.height * 0.55) - (p.pos.y + p.height - RULES.eyeDrop);
    const dz = o.pos.z - p.pos.z;
    const d = Math.hypot(dx, dy, dz) || 1;
    const wantYaw = Math.atan2(-dx, -dz);
    const wantPitch = Math.asin(clamp(dy / d, -1, 1));
    const ready = clamp((t - this.lastSeen) / cfg.react, 0, 1);
    const turn = cfg.turn * (this.visible ? 1 : 0.4) * (0.35 + ready * 0.65);
    p.yaw += clamp(angleDelta(p.yaw, wantYaw), -turn * dt, turn * dt);
    p.pitch += clamp(wantPitch - p.pitch, -turn * dt, turn * dt);
  }

  aimOff(o) {
    const p = this.p;
    const dx = o.pos.x - p.pos.x;
    const dy = (o.pos.y + o.height * 0.55) - (p.pos.y + p.height - RULES.eyeDrop);
    const dz = o.pos.z - p.pos.z;
    const d = Math.hypot(dx, dy, dz) || 1;
    const cp = Math.cos(p.pitch);
    const ax = -Math.sin(p.yaw) * cp, ay = Math.sin(p.pitch), az = -Math.cos(p.yaw) * cp;
    return Math.acos(clamp((dx * ax + dy * ay + dz * az) / d, -1, 1));
  }

  act(t) {
    const p = this.p, cfg = this.cfg;
    if (!this.target || !this.visible) return;
    const o = this.target;
    const off = this.aimOff(o);

    if (p.ult >= RULES.ult.max - 0.5 && !p.ultActive && t > this.nextAbility && this.dist < 16) {
      this.castUlt(t);
      this.nextAbility = t + 1.5;
      return;
    }
    if (t > this.nextAbility && Math.random() < cfg.ability && off < 0.35) {
      if (this.castAbility(t, off)) {
        this.nextAbility = t + rnd(0.6, 1.8);
        return;
      }
    }

    const spec = this.char.primary;
    if (this.dist > spec.range * 0.85 || off > 0.14 + cfg.aimError * 3) return;
    if (t > this.fireUntil && t > this.restUntil) {
      this.fireUntil = t + rnd(cfg.burst[0], cfg.burst[1]);
      this.restUntil = this.fireUntil + rnd(cfg.rest[0], cfg.rest[1]);
    }
    if (t >= this.fireUntil) return;
    const gap = 60 / spec.rpm;
    if (t - (this.lastShot || 0) < gap) return;
    this.lastShot = t;
    this.shoot(spec, o, off, t);
  }

  /* one attack: told to everyone for the visuals, resolved here for the damage */
  shoot(spec, o, off, t) {
    const p = this.p;
    p.stats.shots++;
    const dir = this.dirVec();
    const eye = [p.pos.x, p.pos.y + p.height - RULES.eyeDrop, p.pos.z];
    const end = [eye[0] + dir.x * spec.range, eye[1] + dir.y * spec.range, eye[2] + dir.z * spec.range];
    this.room.broadcast({ t: 'shot', id: p.id, s: 'lmb', d: [dir.x, dir.y, dir.z], e: [end.map((v) => Math.round(v * 100) / 100)] });

    // aim error decides the hit; distance and cover make it harder
    const chance = this.cfg.hitBase * clamp(1 - off / 0.2, 0.15, 1) *
      clamp(1 - this.dist / (spec.range * 1.2), 0.25, 1);
    if (Math.random() > chance) return;
    const travel = spec.kind === 'projectile' && spec.speed ? this.dist / spec.speed : 0;
    const head = Math.random() < 0.13;
    const dmg = spec.dmg * (head ? spec.head : 1) * (this.focus > t ? 1.6 : 1);
    this.later(travel, () => {
      if (!o.alive || !p.alive) return;
      if (!this.sees(o)) return;
      p.stats.hits++;
      this.room.damage(o, dmg, p, { head, ability: spec.id });
    });
  }

  castAbility(t, off) {
    const p = this.p;
    for (const slot of ['a2', 'a1', 'q']) {
      const spec = abilityOf(p.character, slot);
      if (!spec || t < p.cd[slot]) continue;
      if (!this.wants(slot, spec, off)) continue;
      p.cd[slot] = t + spec.cd;
      if (spec.hpCost) p.hp = Math.max(1, p.hp - spec.hpCost);
      const dir = this.dirVec();
      this.room.broadcast({
        t: 'abil', id: p.id, s: slot, d: [dir.x, dir.y, dir.z],
        p: [Math.round(p.pos.x * 100) / 100, Math.round(p.pos.y * 100) / 100, Math.round(p.pos.z * 100) / 100]
      });
      this.applyAbility(spec, slot, t);
      return true;
    }
    return false;
  }

  wants(slot, spec, off) {
    const melee = this.char.primary.kind === 'melee';
    if (spec.kind === 'dash' || spec.kind === 'blink') {
      return (melee && this.dist > 5 && this.dist < spec.dist * 1.5) || (this.p.hp / this.p.maxHp < 0.4);
    }
    if (spec.kind === 'zone') return this.dist > 4 && this.dist < (spec.range || 40);
    if (spec.kind === 'summon') return this.dist < 30;
    if (spec.kind === 'buff') return this.dist < 8;
    if (spec.kind === 'parry') return this.dist < 5;
    return off < 0.16 && this.dist < (spec.range || 12);
  }

  applyAbility(spec, slot, t) {
    const p = this.p, o = this.target;
    const dir = this.dirVec();
    switch (spec.kind) {
      case 'dash':
      case 'blink': {
        const dist = spec.dist || 8;
        const away = p.hp / p.maxHp < 0.4 ? -1 : 1;
        this.slide(dir.x * away, dir.z * away, dist, spec.kind === 'blink');
        if (spec.iframe) p.iframeUntil = t + spec.iframe;
        if (spec.dmg && o && this.dist < 3.5) this.room.damage(o, spec.dmg, p, { ability: spec.id });
        break;
      }
      case 'hitscan': {
        if (!o) break;
        if (this.aimOff(o) < 0.16 && this.dist < spec.range && this.sees(o)) {
          this.room.damage(o, spec.dmg, p, { ability: spec.id });
          if (spec.slow) { o.slowUntil = t + spec.slow.dur; o.slowMul = spec.slow.mul; }
          if (spec.mark) { o.markedUntil = t + spec.mark.dur; o.markedBy = p.id; }
        }
        break;
      }
      case 'zone': {
        if (!o) break;
        const zx = o.pos.x, zz = o.pos.z;
        const ticks = Math.max(1, Math.round(spec.dur / 0.9));
        for (let i = 0; i < ticks; i++) {
          this.later(0.4 + i * 0.9, () => {
            for (const v of this.room.players.values()) {
              if (!v.alive || v.team === p.team) continue;
              if (Math.hypot(v.pos.x - zx, v.pos.z - zz) > spec.radius) continue;
              this.room.damage(v, (spec.tickDmg || spec.dmg * 0.4) * 0.9, p, { ability: spec.id, quiet: true });
            }
          });
        }
        break;
      }
      case 'summon': {
        const bites = 5;
        for (let i = 0; i < bites; i++) {
          this.later(1 + i * (spec.summon.rate + 0.2), () => {
            const v = this.target;
            if (!v || !v.alive || !p.alive) return;
            if (Math.hypot(v.pos.x - p.pos.x, v.pos.z - p.pos.z) > 32) return;
            this.room.damage(v, spec.summon.dmg, p, { ability: 'hound', quiet: true });
          });
        }
        break;
      }
      case 'buff':
        this.focus = t + (spec.dur || 2);
        break;
      case 'parry':
        p.iframeUntil = t + (spec.window || 0.4);
        break;
      default:
        break;
    }
    void slot;
  }

  castUlt(t) {
    const p = this.p;
    const spec = abilityOf(p.character, 'ult');
    p.ult = 0;
    p.ultActive = true;
    p.ultEndsAt = t + spec.dur + spec.castTime;
    const dir = this.dirVec();
    this.room.broadcast({
      t: 'abil', id: p.id, s: 'ult', d: [dir.x, dir.y, dir.z],
      p: [Math.round(p.pos.x * 100) / 100, Math.round(p.pos.y * 100) / 100, Math.round(p.pos.z * 100) / 100]
    });
    this.room.openDomain(p, spec, { p: [p.pos.x, p.pos.y, p.pos.z] });
  }

  dirVec() {
    const p = this.p, cp = Math.cos(p.pitch);
    return { x: -Math.sin(p.yaw) * cp, y: Math.sin(p.pitch), z: -Math.cos(p.yaw) * cp };
  }

  /* a dash or blink, kept legal against the collision world */
  slide(dx, dz, dist, instant) {
    const p = this.p;
    const len = Math.hypot(dx, dz) || 1;
    const nx = dx / len, nz = dz / len;
    const step = 0.5;
    let moved = 0;
    for (let d = step; d <= dist; d += step) {
      const x = p.pos.x + nx * d, z = p.pos.z + nz * d;
      const y = this.world.supportAt(x, z, p.pos.y + 1, p.radius);
      if (!this.world.fits(x, y, z, p.radius, p.height)) break;
      moved = d;
    }
    if (moved <= 0) return;
    if (instant) {
      p.pos.x += nx * moved;
      p.pos.z += nz * moved;
      p.pos.y = this.world.supportAt(p.pos.x, p.pos.z, p.pos.y + 1, p.radius);
    } else {
      p.dashUntil = Date.now() / 1000 + 0.25;
      p.dashDir = { x: nx, z: nz };
      p.dashLeft = moved;
    }
  }

  /* ------------------------------------------------------------- movement */
  move(dt, t) {
    const p = this.p;
    let wx = 0, wz = 0;

    if (p.dashLeft > 0) {
      const step = Math.min(p.dashLeft, 24 * dt);
      p.dashLeft -= step;
      p.vel.x = p.dashDir.x * 24;
      p.vel.z = p.dashDir.z * 24;
    } else if (this.goal) {
      if (!this.path || t > this.nextPath) {
        this.nextPath = t + rnd(0.7, 1.3);
        this.path = this.nav.path(p.pos.x, p.pos.z, this.goal.x, this.goal.z);
        this.pathIdx = 0;
      }
      const wp = this.path && this.pathIdx < this.path.length ? this.path[this.pathIdx] : this.goal;
      if (wp) {
        const dx = wp.x - p.pos.x, dz = wp.z - p.pos.z;
        const d = Math.hypot(dx, dz) || 1;
        wx = dx / d; wz = dz / d;
        if (d < 1.1) this.pathIdx++;
      }
    }

    if (this.mode === 'engage' && this.target) {
      const dx = this.target.pos.x - p.pos.x, dz = this.target.pos.z - p.pos.z;
      const d = Math.hypot(dx, dz) || 1;
      const toward = clamp((d - this.ideal) / Math.max(4, this.ideal), -1, 1);
      wx = (dx / d) * toward - (dz / d) * this.strafe * 0.9;
      wz = (dz / d) * toward + (dx / d) * this.strafe * 0.9;
      if (t > this.flipAt) { this.flipAt = t + rnd(0.9, 2.4); if (Math.random() < 0.5) this.strafe *= -1; }
    }

    const len = Math.hypot(wx, wz);
    if (len > 1) { wx /= len; wz /= len; }
    const c = this.char;
    let speed = c.speed * (this.mode === 'engage' ? 1 : RULES.sprintMul);
    if (t < p.slowUntil) speed *= p.slowMul;
    const accel = c.accel;
    p.vel.x += clamp(wx * speed - p.vel.x, -accel * dt, accel * dt);
    p.vel.z += clamp(wz * speed - p.vel.z, -accel * dt, accel * dt);

    p.vel.y -= RULES.gravity * dt;
    const before = { x: p.pos.x, z: p.pos.z };
    this.world.moveXZ(p, p.vel.x * dt, p.vel.z * dt);
    p.pos.y += p.vel.y * dt;
    const ground = this.world.supportAt(p.pos.x, p.pos.z, p.pos.y + 0.34, p.radius * 0.85);
    if (p.pos.y <= ground + 0.001 && p.vel.y <= 0) {
      p.pos.y = ground;
      p.vel.y = 0;
      p.onGround = true;
    } else p.onGround = false;
    if (p.pos.y < -6) { p.pos.y = this.world.groundAt(p.pos.x, p.pos.z); p.vel.y = 0; }

    // hop a ledge, or replan, when we stop getting anywhere
    const moved = Math.hypot(p.pos.x - before.x, p.pos.z - before.z);
    if (moved < 0.01 && len > 0.2) {
      this.stuck += dt;
      if (this.stuck > 0.4) {
        this.stuck = 0;
        if (p.onGround) p.vel.y = c.jump;
        this.path = null;
        this.nextPath = 0;
        this.goal = this.roam();
      }
    } else this.stuck = 0;

    p.hist.push({ t, x: p.pos.x, y: p.pos.y, z: p.pos.z, h: p.height });
    while (p.hist.length && t - p.hist[0].t > 1.2) p.hist.shift();
  }
}
