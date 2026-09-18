/* =============================================================================
   bot brains.  a bot runs the same fighter, the same physics and the same
   ability runtime a player does - it just decides with code instead of hands.

   loop:  perceive (who can I see, who hurt me)
          decide  (engage / hunt / take cover / reposition)
          move    (path on the nav grid, strafe, dash, jump)
          aim     (turn toward a lead point, with a difficulty dependent error)
          act     (fire, abilities, domain)
   ========================================================================== */
import { clamp, damp, rnd, angleDelta, pick } from '../core/math.js';
import { stepFighter } from '../combat/physics.js';

const LEVELS = {
  easy: {
    aimError: 0.075, turn: 3.2, react: 0.5, fireHold: [0.2, 0.5], pause: [0.35, 0.9],
    ability: 0.3, dodge: 0.12, ultWait: 3.2, lead: 0.35, range: 0.62, strafe: 0.5,
    coverHp: 0.3, jump: 0.05, trackLoss: 1.2
  },
  normal: {
    aimError: 0.032, turn: 5.2, react: 0.26, fireHold: [0.3, 0.9], pause: [0.15, 0.45],
    ability: 0.6, dodge: 0.35, ultWait: 1.6, lead: 0.7, range: 0.85, strafe: 0.85,
    coverHp: 0.38, jump: 0.14, trackLoss: 2.4
  },
  hard: {
    aimError: 0.013, turn: 8.2, react: 0.13, fireHold: [0.5, 1.4], pause: [0.05, 0.2],
    ability: 0.9, dodge: 0.7, ultWait: 0.5, lead: 1, range: 1, strafe: 1,
    coverHp: 0.45, jump: 0.26, trackLoss: 3.6
  }
};

export class BotBrain {
  constructor(game, fighter, level = 'normal') {
    this.game = game;
    this.f = fighter;
    this.cfg = LEVELS[level] || LEVELS.normal;
    this.level = level;
    this.state = 'hunt';
    this.target = null;
    this.lastSeenAt = -99;
    this.lastSeen = { x: 0, z: 0 };
    this.nextThink = 0;
    this.nextPath = 0;
    this.path = null;
    this.pathIdx = 0;
    this.goal = null;
    this.strafeDir = pick([-1, 1]);
    this.nextStrafeFlip = 0;
    this.fireUntil = 0;
    this.nextFireWindow = 0;
    this.nextAbility = 0;
    this.jumpUntil = 0;
    this.stuckT = 0;
    this.lastPos = { x: 0, z: 0 };
    this.aimJitter = { x: 0, y: 0 };
    this.nextJitter = 0;
  }

  get nav() { return this.game.nav; }

  update(dt) {
    const g = this.game, f = this.f, now = g.now;
    if (!f.alive) return;
    if (g.state !== 'live') { this.idle(dt); return; }

    if (now >= this.nextThink) {
      this.nextThink = now + 0.1 + Math.random() * 0.08;
      this.perceive();
      this.decide();
    }
    this.aim(dt);
    this.act();
    this.move(dt);
    f.updateEnergy(dt, now, g.domains.energyLocked(f));
  }

  idle(dt) {
    stepFighter(this.game.world, this.f, dt, { x: 0, z: 0, jump: false }, this.game.now);
  }

  /* ------------------------------------------------------------ perceive */
  perceive() {
    const g = this.game, f = this.f, now = g.now;
    let best = null, bestScore = -1e9;
    for (const o of g.fighters) {
      if (!o.alive || !g.isEnemy(f, o)) continue;
      const d = Math.hypot(o.pos.x - f.pos.x, o.pos.z - f.pos.z);
      const sees = g.canSee(f, o.pos.x, o.centerY, o.pos.z);
      if (!sees && d > 26) continue;
      let score = 90 - d * 1.4;
      if (sees) score += 45;
      if (o.hp / o.maxHp < 0.4) score += 22;
      if (o.id === f.lastAttackerId && now - f.lastDamageAt < 3) score += 26;
      if (o === this.target) score += 14;
      if (score > bestScore) { bestScore = score; best = { o, d, sees }; }
    }

    // a shade decoy pulls attention exactly like a real fighter for a moment
    const decoys = g.summons.decoysAgainst(f);
    for (const s of decoys) {
      const d = Math.hypot(s.pos.x - f.pos.x, s.pos.z - f.pos.z);
      if (d > 34) continue;
      if (!g.canSee(f, s.pos.x, s.pos.y + 1.1, s.pos.z)) continue;
      const score = 96 - d * 1.4 - this.cfg.ability * 20;
      if (score > bestScore) {
        bestScore = score;
        best = { o: decoyTarget(s), d, sees: true };
      }
    }

    if (best) {
      this.target = best.o;
      if (best.sees) {
        this.lastSeenAt = now;
        this.lastSeen.x = best.o.pos.x;
        this.lastSeen.z = best.o.pos.z;
      }
      this.visible = best.sees;
      this.tdist = best.d;
    } else {
      this.visible = false;
      if (now - this.lastSeenAt > this.cfg.trackLoss + 3) this.target = null;
    }
  }

  /* -------------------------------------------------------------- decide */
  decide() {
    const g = this.game, f = this.f, now = g.now, cfg = this.cfg;
    const hpFrac = f.hp / f.maxHp;
    const melee = f.char.primary.kind === 'melee';
    const idealRange = melee ? 2.4 : clamp(f.char.primary.range * 0.35, 9, 26);

    if (!this.target) {
      this.state = 'roam';
      if (!this.goal || Math.hypot(this.goal.x - f.pos.x, this.goal.z - f.pos.z) < 3) {
        this.goal = this.roamPoint();
        this.path = null;
      }
      return;
    }

    if (hpFrac < cfg.coverHp && now - f.lastDamageAt < 2.5 && this.visible) {
      this.state = 'cover';
      if (!this.goal || now > this.nextPath) {
        const spot = this.nav.coverNear(f.pos.x, f.pos.z, this.target.pos.x, this.target.pos.z, g.world, 14);
        this.goal = spot || this.roamPoint();
        this.path = null;
      }
      return;
    }

    if (this.visible) {
      this.state = 'engage';
      this.idealRange = idealRange;
      this.goal = { x: this.target.pos.x, z: this.target.pos.z };
    } else if (now - this.lastSeenAt < this.cfg.trackLoss + 4) {
      this.state = 'hunt';
      this.goal = { x: this.lastSeen.x, z: this.lastSeen.z };
    } else {
      this.state = 'roam';
      if (!this.goal || Math.hypot(this.goal.x - f.pos.x, this.goal.z - f.pos.z) < 3) {
        this.goal = this.roamPoint();
        this.path = null;
      }
    }
  }

  roamPoint() {
    const m = this.game.mapDef;
    const spots = m.ffaSpots.concat([[0, 0], [m.sx * 0.5, 0], [-m.sx * 0.5, 0], [0, m.sz * 0.5], [0, -m.sz * 0.5]]);
    const s = pick(spots);
    return { x: s[0] + rnd(-3, 3), z: s[1] + rnd(-3, 3) };
  }

  /* ----------------------------------------------------------------- aim */
  aim(dt) {
    const g = this.game, f = this.f, cfg = this.cfg;
    if (!this.target) return;
    const t = this.target;
    const spec = f.char.primary;

    if (g.now > this.nextJitter) {
      this.nextJitter = g.now + rnd(0.25, 0.7);
      this.aimJitter.x = rnd(-cfg.aimError, cfg.aimError);
      this.aimJitter.y = rnd(-cfg.aimError, cfg.aimError) * 0.6;
    }

    let px = t.pos.x, py = t.centerY + (Math.random() < 0.25 ? 0.35 : 0), pz = t.pos.z;
    if (spec.kind === 'projectile' && spec.speed) {
      const d = Math.hypot(px - f.pos.x, pz - f.pos.z);
      const lead = clamp(d / spec.speed, 0, 0.7) * cfg.lead;
      px += (t.vel?.x || 0) * lead;
      pz += (t.vel?.z || 0) * lead;
      py += Math.max(0, d * 0.004);
    }
    const dx = px - f.pos.x, dy = py - f.eyeY, dz = pz - f.pos.z;
    const dist = Math.hypot(dx, dy, dz) || 1;
    const wantYaw = Math.atan2(-dx, -dz) + this.aimJitter.x;
    const wantPitch = Math.asin(clamp(dy / dist, -1, 1)) + this.aimJitter.y;

    // a bot that just spotted you needs a beat before it can track
    const fresh = clamp((g.now - this.lastSeenAt) / cfg.react, 0, 1);
    const turn = cfg.turn * (this.visible ? 1 : 0.45) * (0.4 + fresh * 0.6);
    f.yaw += clamp(angleDelta(f.yaw, wantYaw), -turn * dt, turn * dt);
    f.pitch = clamp(damp(f.pitch, wantPitch, turn * 1.4, dt), -1.4, 1.4);
    f.aimDir();
  }

  /* ----------------------------------------------------------------- act */
  act() {
    const g = this.game, f = this.f, now = g.now, cfg = this.cfg, A = g.abilities;
    if (!this.target) return;
    const t = this.target;
    const dist = Math.hypot(t.pos.x - f.pos.x, t.pos.z - f.pos.z);
    const aimOff = this.aimOffset(t);
    const spec = f.char.primary;
    const inRange = dist < spec.range * cfg.range;

    // ultimate: only when it will actually catch somebody
    if (f.ultReady && !f.ultActive && this.visible && now > this.nextAbility) {
      const ult = f.char.ult;
      const near = g.fightersInSphere(f.pos.x, f.centerY, f.pos.z, ult.radius * 0.72, f).length;
      if (near >= 1 && now - this.lastSeenAt < cfg.ultWait) {
        if (A.tryCast(f, 'ult')) { this.nextAbility = now + 1.2; return; }
      }
    }

    if (now > this.nextAbility && this.visible && Math.random() < cfg.ability) {
      if (this.tryCombatAbility(dist, aimOff)) {
        this.nextAbility = now + rnd(0.5, 1.6) / clamp(cfg.ability, 0.2, 1);
        return;
      }
    }

    // energy discipline: top up while nobody is looking
    if (f.energy < spec.cost * 2 && (!this.visible || dist > 30)) A.refocus(f);

    if (!this.visible || !inRange) return;
    if (aimOff > 0.16 + cfg.aimError * 3) return;
    if (g.world.segBlocked(f.pos.x, f.eyeY, f.pos.z, t.pos.x, t.centerY, t.pos.z)) return;

    // fire in bursts rather than holding forever
    if (now > this.fireUntil && now > this.nextFireWindow) {
      this.fireUntil = now + rnd(cfg.fireHold[0], cfg.fireHold[1]);
      this.nextFireWindow = this.fireUntil + rnd(cfg.pause[0], cfg.pause[1]);
    }
    if (now < this.fireUntil) {
      f.ads = f.char.secondary.kind === 'ads' && dist > 22;
      A.tryCast(f, 'lmb');
    }
  }

  aimOffset(t) {
    const f = this.f;
    const dx = t.pos.x - f.pos.x, dy = t.centerY - f.eyeY, dz = t.pos.z - f.pos.z;
    const d = Math.hypot(dx, dy, dz) || 1;
    const dot = (dx * f.aim.x + dy * f.aim.y + dz * f.aim.z) / d;
    return Math.acos(clamp(dot, -1, 1));
  }

  /* picks whichever sorcery fits the moment; the data says what each one is */
  tryCombatAbility(dist, aimOff) {
    const f = this.f, A = this.game.abilities;
    const q = f.char.q, a1 = f.char.a1, a2 = f.char.a2;
    const melee = f.char.primary.kind === 'melee';
    const hpFrac = f.hp / f.maxHp;

    // heavy sorcery first when it lines up
    if (a2 && aimOff < 0.14 && this.inAbilityRange(a2, dist) && A.canCast(f, 'a2')) {
      if (A.tryCast(f, 'a2')) return true;
    }
    if (a1 && aimOff < 0.3 && this.inAbilityRange(a1, dist) && A.canCast(f, 'a1')) {
      if (A.tryCast(f, 'a1')) return true;
    }
    if (q && A.canCast(f, 'q')) {
      const wantClose = melee ? dist > 4 && dist < q.dist * 1.8 : false;
      const wantOut = hpFrac < 0.42 && dist < 9;
      const dodging = Math.random() < this.cfg.dodge * 0.5 && dist < 18;
      if (wantClose || dodging) { if (A.tryCast(f, 'q')) return true; }
      if (wantOut) {
        // dash away instead of into the fight
        f.yaw += Math.PI;
        f.aimDir();
        const ok = A.tryCast(f, 'q');
        f.yaw -= Math.PI;
        f.aimDir();
        if (ok) return true;
      }
    }
    if (f.char.secondary.kind === 'parry' && dist < 5 && Math.random() < this.cfg.dodge && A.canCast(f, 'rmb')) {
      if (A.tryCast(f, 'rmb')) return true;
    }
    if (f.char.secondary.kind === 'hitscan' && aimOff < 0.1 && A.canCast(f, 'rmb')) {
      if (A.tryCast(f, 'rmb')) return true;
    }
    return false;
  }

  inAbilityRange(spec, dist) {
    const r = spec.range || (spec.dist ? spec.dist : spec.radius ? spec.radius * 2 : 10);
    return dist < r * 0.95 && dist > (spec.kind === 'zone' ? 3 : 0);
  }

  /* ---------------------------------------------------------------- move */
  move(dt) {
    const g = this.game, f = this.f, now = g.now, cfg = this.cfg;
    let wx = 0, wz = 0, jump = false;

    const goal = this.goal;
    if (goal) {
      if (!this.path || now > this.nextPath ||
        (this.pathGoal && Math.hypot(this.pathGoal.x - goal.x, this.pathGoal.z - goal.z) > 3.5)) {
        this.nextPath = now + rnd(0.6, 1.1);
        this.pathGoal = { x: goal.x, z: goal.z };
        this.path = this.nav.path(f.pos.x, f.pos.z, goal.x, goal.z);
        this.pathIdx = 0;
      }
      const wp = this.currentWaypoint();
      if (wp) {
        const dx = wp.x - f.pos.x, dz = wp.z - f.pos.z;
        const d = Math.hypot(dx, dz) || 1;
        wx = dx / d; wz = dz / d;
        if (d < 1.1) this.pathIdx++;
      }
    }

    if (this.state === 'engage' && this.target) {
      const t = this.target;
      const dx = t.pos.x - f.pos.x, dz = t.pos.z - f.pos.z;
      const d = Math.hypot(dx, dz) || 1;
      const ideal = this.idealRange || 12;
      const toward = (d - ideal) / Math.max(4, ideal);
      wx = (dx / d) * clamp(toward, -1, 1);
      wz = (dz / d) * clamp(toward, -1, 1);
      // circle strafe, flipping direction now and then so it is not readable
      if (now > this.nextStrafeFlip) {
        this.nextStrafeFlip = now + rnd(0.8, 2.2);
        this.strafeDir *= Math.random() < 0.6 ? -1 : 1;
      }
      // a melee fighter that circles at range never arrives: close first
      const melee = f.char.primary.kind === 'melee';
      const strafe = cfg.strafe * (melee && d > 6 ? 0.2 : 1);
      const sx = -dz / d * this.strafeDir, sz = dx / d * this.strafeDir;
      wx += sx * strafe;
      wz += sz * strafe;
      if (Math.random() < cfg.jump * dt * 8 && f.onGround) jump = true;
    }

    // avoid standing in someone else's zone
    const danger = g.zones.dangerAt(f.pos.x, f.pos.z, f);
    if (danger > 0) {
      let ax = 0, az = 0;
      for (const z of g.zones.list) {
        if (!g.isEnemy(f, z.owner)) continue;
        const dx = f.pos.x - z.x, dz = f.pos.z - z.z;
        const d = Math.hypot(dx, dz) || 1;
        if (d < z.radius + 2) { ax += dx / d; az += dz / d; }
      }
      wx += ax * 1.5; wz += az * 1.5;
    }

    // unstick: if we have not moved in a while, pick a new plan and hop
    const moved = Math.hypot(f.pos.x - this.lastPos.x, f.pos.z - this.lastPos.z);
    this.lastPos.x = f.pos.x; this.lastPos.z = f.pos.z;
    if (moved < 0.02 && (Math.abs(wx) + Math.abs(wz)) > 0.2) {
      this.stuckT += dt;
      if (this.stuckT > 0.45) {
        this.stuckT = 0;
        this.path = null;
        this.nextPath = 0;
        this.goal = this.roamPoint();
        jump = true;
      }
    } else this.stuckT = 0;

    const len = Math.hypot(wx, wz);
    if (len > 1) { wx /= len; wz /= len; }
    const closing = this.state === 'engage' && this.target &&
      f.char.primary.kind === 'melee' &&
      Math.hypot(this.target.pos.x - f.pos.x, this.target.pos.z - f.pos.z) > 6;
    f.sprint = len > 0.4 && (this.state !== 'engage' || closing);
    f.crouch = false;

    stepFighter(g.world, f, dt, { x: wx, z: wz, jump }, now);
  }

  currentWaypoint() {
    if (!this.path || this.pathIdx >= this.path.length) return this.goal;
    return this.path[this.pathIdx];
  }
}

/* a decoy pretends to be a fighter for exactly as long as the bot believes it */
function decoyTarget(s) {
  return {
    isDecoy: true, pos: s.pos, vel: s.vel, alive: true,
    get centerY() { return s.pos.y + 1.1; },
    hp: s.hp, maxHp: s.maxHp, id: -1
  };
}
