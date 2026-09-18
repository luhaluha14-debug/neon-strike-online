/* =============================================================================
   the ability runtime.  every attack in the game - a player's, a bot's, a
   remote player's replay - goes through tryCast(), which checks the gates
   (alive, busy, cooldown, energy, health) and then runs one behaviour per
   ability KIND.  adding a character means adding data, not code, unless it
   needs a brand new kind.
   ========================================================================== */
import { abilityOf } from '../characters/roster.js';
import { fireInterval, RULES } from '../game/rules.js';
import { clamp, dirFromAngles, lerp, rnd } from '../core/math.js';
import { audio } from '../audio/audio.js';

const SLOT_CD = { q: 'q', a1: 'a1', a2: 'a2', rmb: 'rmb' };

export class AbilityRuntime {
  constructor(game) {
    this.game = game;
    this.pending = [];        // casts waiting out their wind-up
  }

  /* --------------------------------------------------------------- gates */
  cooldownLeft(f, slot) {
    const key = SLOT_CD[slot];
    if (!key) return 0;
    return Math.max(0, f.cd[key] - this.game.now);
  }

  canCast(f, slot, quiet = true) {
    const g = this.game, now = g.now;
    if (!f.alive || g.state !== 'live') return false;
    const spec = abilityOf(f.charId, slot);
    if (!spec) return false;
    if (slot !== 'lmb' && f.isBusy(now)) return false;
    if (slot === 'lmb' && (now < f.nextFire || f.isBusy(now))) return false;
    if (slot === 'ult') return f.ultReady && !f.ultActive;
    if (this.cooldownLeft(f, slot) > 0) return false;
    if (spec.cost && f.energy < spec.cost) { if (!quiet) this.deny(f, 'energy'); return false; }
    if (spec.hpCost && f.hp <= spec.hpCost + 5) { if (!quiet) this.deny(f, 'hp'); return false; }
    return true;
  }

  deny(f, why) {
    if (f !== this.game.player) return;
    audio.deny();
    this.game.hud.warn(why === 'energy' ? '주력 부족' : '체력 부족');
  }

  /* ---------------------------------------------------------------- cast */
  tryCast(f, slot, opts = {}) {
    const g = this.game, now = g.now;
    const spec = abilityOf(f.charId, slot);
    if (!spec) return false;

    if (!this.canCast(f, slot, false)) {
      if (f === g.player && slot !== 'lmb' && !f.isBusy(now)) {
        if (slot === 'ult' && !f.ultReady) { audio.deny(); g.hud.warn('궁극기 충전 중'); }
      }
      return false;
    }

    if (spec.cost && !f.spendEnergy(spec.cost, now)) return false;
    if (spec.hpCost) {
      f.hp = Math.max(1, f.hp - spec.hpCost);
      g.effects.bloodCost(f);
    }
    if (slot === 'lmb') f.nextFire = now + fireInterval(spec) * this.rateMul(f);
    else if (SLOT_CD[slot]) f.cd[SLOT_CD[slot]] = now + spec.cd * this.cdMul(f);
    else if (slot === 'ult') { f.ult = 0; }

    const cast = spec.castTime || 0;
    if (cast > 0) {
      f.castUntil = now + cast;
      this.pending.push({ f, slot, spec, at: now + cast, opts });
      this.startupFx(f, spec, slot);
      return true;
    }
    this.execute(f, slot, spec, opts);
    return true;
  }

  rateMul(f) {
    let m = 1;
    const d = this.game.domains.ownBonus(f);
    if (d && d.ownRateMul) m /= d.ownRateMul;
    return m;
  }
  cdMul(f) {
    const d = this.game.domains.ownBonus(f);
    return d && d.ownCdRate ? 1 / d.ownCdRate : 1;
  }

  startupFx(f, spec, slot) {
    this.game.effects.castRing(f, spec.color || f.char.accent, spec.castTime);
    audio.cast(spec.kind, f === this.game.player);
    if (slot === 'ult' && f === this.game.player) this.game.controller.cinematic(spec.castTime + 0.45);
  }

  execute(f, slot, spec, opts = {}) {
    const g = this.game;
    const kind = spec.kind;
    const fn = this[kind + 'Kind'];
    if (!fn) { console.warn('unknown ability kind', kind); return; }
    fn.call(this, f, spec, slot, opts);
    if (spec.recover) f.recoverUntil = g.now + spec.recover;
    if (f === g.player) g.net?.sendAbility(slot, f, spec, opts);
    g.emit('cast', { f, slot, spec });
  }

  update(dt) {
    const g = this.game, now = g.now;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i];
      if (!p.f.alive) { this.pending.splice(i, 1); continue; }
      if (now >= p.at) {
        this.pending.splice(i, 1);
        this.execute(p.f, p.slot, p.spec, p.opts);
      }
    }
    // charged secondary builds up while the button is held
    for (const f of g.fighters) {
      if (!f.charging) continue;
      const spec = f.char.secondary;
      f.charge = clamp(f.charge + dt / spec.chargeTime, 0, 1);
      if (f === g.player && f.charge >= 1 && !f._chargeFull) { f._chargeFull = true; audio.chargeFull(); }
    }
    this.updateDashes(dt);
    void dt;
  }

  /* dashes damage what they run through, once per target */
  updateDashes() {
    const g = this.game, now = g.now;
    for (const f of g.fighters) {
      if (now >= f.dashUntil || !f.dashHits) continue;
      const spec = f.dashSpec;
      if (!spec || !spec.dmg) continue;
      for (const o of g.fighters) {
        if (!o.alive || !g.isEnemy(f, o) || f.dashHits.has(o.id)) continue;
        if (Math.hypot(o.pos.x - f.pos.x, o.pos.z - f.pos.z) > (spec.radius || 1.8) + o.radius) continue;
        if (Math.abs(o.pos.y - f.pos.y) > 2.2) continue;
        f.dashHits.add(o.id);
        g.damage(o, spec.dmg, f, { kind: 'dash', ability: spec.id, dir: { x: f.dashDir.x, z: f.dashDir.z } });
        if (spec.knock) this.knock(o, f.dashDir.x, f.dashDir.z, spec.knock);
        g.effects.impact(o.pos.x, o.centerY, o.pos.z, spec.color || f.char.accent, 1);
        audio.melee(true, f === g.player);
      }
    }
  }

  knock(target, dx, dz, power) {
    target.vel.x += dx * power;
    target.vel.z += dz * power;
    target.vel.y = Math.max(target.vel.y, power * 0.4);
    target.onGround = false;
  }

  /* --------------------------------------------------------------- charge */
  startCharge(f) {
    if (f.charging) return;
    const spec = f.char.secondary;
    if (spec.kind !== 'charge') return;
    if (f.isBusy(this.game.now) || this.cooldownLeft(f, 'rmb') > 0) return;
    if (f.energy < spec.cost) { this.deny(f, 'energy'); return; }
    f.charging = true;
    f.charge = 0;
    f._chargeFull = false;
    audio.chargeStart(f === this.game.player);
  }
  releaseCharge(f) {
    if (!f.charging) return;
    const spec = f.char.secondary;
    const charge = f.charge;
    f.charging = false;
    f.charge = 0;
    f._chargeFull = false;
    if (charge < 0.22) return;                  // a tap is a mis-click, not a shot
    if (!f.spendEnergy(spec.cost, this.game.now)) return;
    f.cd.rmb = this.game.now + (spec.cd || 0.3);
    this.execute(f, 'rmb', spec, { charge });
  }
  cancelCharge(f) { f.charging = false; f.charge = 0; f._chargeFull = false; }

  /* -------------------------------------------------------------- refocus */
  refocus(f) {
    const now = this.game.now;
    if (now < f.cd.refocus || f.energy >= f.maxEnergy - 1) return false;
    f.cd.refocus = now + 2.4;
    f.addBuff('refocus', 0.85, now);
    f.energyBlockUntil = 0;
    f.recoverUntil = now + 0.25;
    audio.refocus(f === this.game.player);
    this.game.effects.castRing(f, f.char.accent, 0.85);
    if (f === this.game.player) this.game.net?.sendAbility('refocus', f, { id: 'refocus' }, {});
    return true;
  }

  /* --------------------------------------------------------- hit handlers */
  /* called by game.damage when a parry window eats the hit */
  onParry(defender, attacker) {
    const spec = defender.char.secondary;
    const g = this.game, now = g.now;
    defender.parryUntil = 0;
    defender.cd.rmb = Math.max(0, now + (spec.cd || 5) - (spec.refund || 0));
    defender.addStack(spec.stackGain || 1, now);
    g.effects.parryFlash(defender);
    audio.parry(defender === g.player);
    if (attacker && Math.hypot(attacker.pos.x - defender.pos.x, attacker.pos.z - defender.pos.z) < (spec.range || 3.5)) {
      g.damage(attacker, spec.dmg || 40, defender, { kind: 'counter', ability: spec.id });
    }
    if (defender === g.player) g.hud.banner('반격', 0.7);
  }

  /* ============================== KINDS ================================== */

  projectileKind(f, spec, slot, opts) {
    const g = this.game;
    const dir = this.aimDir(f, spec, opts);
    let dmg = opts.charge !== undefined
      ? lerp(spec.dmg, spec.dmgMax || spec.dmg, opts.charge)
      : spec.dmg;
    // aiming down sight is a damage choice, not just a zoom
    if (slot === 'lmb' && f.ads && f.char.secondary.kind === 'ads') dmg *= f.char.secondary.dmgMul || 1;
    g.projectiles.spawn({
      owner: f, spec, dir, damage: dmg,
      speed: spec.speed, range: spec.range, radius: spec.radius,
      gravity: spec.gravity || 0, pierce: spec.pierce || 0,
      homing: spec.homing || 0, homingMarked: spec.homingMarked || 0,
      splash: spec.splash || null, color: spec.color || f.char.accent,
      scale: opts.charge !== undefined ? 0.7 + opts.charge * 0.9 : 1,
      zone: spec.kind === 'zone' ? spec : null
    });
    g.effects.muzzle(f, spec.color || f.char.accent);
    if (f === g.player) {
      g.feel.recoil(spec.kind === 'charge' ? 1.6 : 0.85, spec);
      audio.shoot(f.charId, spec, opts.charge);
    } else {
      audio.shootAt(f.pos, f.charId, spec);
    }
    f.stats.shots++;
  }

  zoneKind(f, spec, slot, opts) {
    // a zone is delivered by a projectile that plants it where it lands
    this.projectileKind(f, spec, slot, opts);
  }

  hitscanKind(f, spec, slot, opts) {
    const g = this.game;
    const dir = this.aimDir(f, spec, opts);
    const eye = f.eye({});
    const width = (spec.width || 0.6) * 0.5;
    const hits = g.rayFighters(eye.x, eye.y, eye.z, dir.x, dir.y, dir.z, spec.range, f, width);
    const wall = g.world.raycast(eye.x, eye.y, eye.z, dir.x, dir.y, dir.z, spec.range);
    const end = Math.min(spec.range, wall);
    let count = 0;
    f.stats.shots++;
    for (const h of hits) {
      if (count++ >= (spec.pierce || 1)) break;
      const dealt = g.damage(h.f, spec.dmg, f, {
        head: h.head, headMul: spec.head, kind: 'beam', ability: spec.id,
        dist: h.dist, dir: { x: dir.x, z: dir.z }
      });
      if (dealt > 0) f.stats.hits++;
      if (spec.slow) { h.f.slowUntil = g.now + spec.slow.dur; h.f.slowMul = spec.slow.mul; }
      if (spec.mark) {
        h.f.markedUntil = g.now + spec.mark.dur;
        h.f.markedBy = f.id;
        g.effects.markTag(h.f, spec.mark.dur);
      }
      g.effects.impact(h.point.x, h.point.y, h.point.z, spec.color || f.char.accent, 1.1);
    }
    g.effects.beam(eye, dir, end, spec.color || f.char.accent, spec.width || 0.6);
    if (f === g.player) {
      g.feel.recoil(1.1, spec);
      audio.beam(spec.id);
    } else audio.beamAt(f.pos, spec.id);
  }

  meleeKind(f, spec, slot, opts) {
    const g = this.game, now = g.now;
    f.meleeCount = (f.meleeCount || 0) + 1;
    const heavy = spec.comboEvery && f.meleeCount % spec.comboEvery === 0;
    const focus = f.buff('focus', now);
    const stacks = f.stackCount(now);
    let mul = heavy ? spec.comboMul : 1;
    mul *= 1 + stacks * 0.05;
    if (focus) mul *= focus.data.meleeMul;

    const dir = this.aimDir(f, spec, opts);
    const list = g.fightersInSphere(f.pos.x, f.centerY, f.pos.z, spec.range, f);
    let landed = 0;
    f.stats.shots++;
    for (const { f: o } of list) {
      const ox = o.pos.x - f.pos.x, oz = o.pos.z - f.pos.z;
      const len = Math.hypot(ox, oz) || 1;
      const dot = (ox / len) * dir.x + (oz / len) * dir.z;
      if (dot < Math.cos(spec.arc || 0.8)) continue;
      if (g.world.segBlocked(f.pos.x, f.centerY, f.pos.z, o.pos.x, o.centerY, o.pos.z)) continue;
      const head = Math.abs(o.headY - f.eyeY) < 0.45 && f.pitch > 0.12;
      const dealt = g.damage(o, spec.dmg * mul, f, {
        head, headMul: spec.head, kind: 'melee', ability: spec.id, dir: { x: dir.x, z: dir.z }
      });
      if (dealt > 0) {
        landed++;
        f.stats.hits++;
        if (focus && focus.data.lifesteal) g.heal(f, dealt * focus.data.lifesteal);
      }
      g.effects.impact(o.pos.x, o.centerY, o.pos.z, spec.color || f.char.accent, heavy ? 1.6 : 1);
    }
    if (landed) {
      f.addStack(spec.stackGain || 1, now);
      if (focus && focus.data.consumeOnHit) f.clearBuff('focus');
    }
    g.effects.slash(f, dir, spec, heavy);
    if (f === g.player) {
      g.feel.meleeSwing(heavy);
      audio.melee(landed > 0, true, heavy);
    } else audio.meleeAt(f.pos, landed > 0);
  }

  dashKind(f, spec, slot, opts) {
    const g = this.game, now = g.now;
    const dir = this.aimDir(f, spec, opts, true);
    const len = Math.hypot(dir.x, dir.z) || 1;
    f.dashDir.x = dir.x / len; f.dashDir.z = dir.z / len;
    f.dashSpeed = spec.speed || 22;
    f.dashUntil = now + (spec.dist / f.dashSpeed);
    f.dashKind = 'dash';
    f.dashSpec = spec;
    f.dashHits = new Set();
    f.vel.y = Math.max(f.vel.y, 0.6);
    if (spec.iframe) f.iframeUntil = now + spec.iframe;
    if (spec.refund) { f.refundHpUntil = now + spec.refund.window; f.refundHp = spec.refund.hp; }
    if (spec.decoy) g.summons.spawnDecoy(f, spec.decoy);
    g.effects.dashTrail(f, spec.color || f.char.accent, f.dashUntil - now);
    audio.dash(f === g.player);
  }

  blinkKind(f, spec, slot, opts) {
    const g = this.game, now = g.now, w = g.world;
    const dir = this.aimDir(f, spec, opts, true);
    const len = Math.hypot(dir.x, dir.z) || 1;
    const dx = dir.x / len, dz = dir.z / len;
    const from = { x: f.pos.x, y: f.pos.y, z: f.pos.z };
    let bestX = f.pos.x, bestY = f.pos.y, bestZ = f.pos.z;
    const stepLen = 0.5, steps = Math.ceil(spec.dist / stepLen);
    for (let i = 1; i <= steps; i++) {
      const t = i * stepLen;
      const x = from.x + dx * t, z = from.z + dz * t;
      const y = w.supportAt(x, z, Math.max(from.y, bestY) + 1.0, f.radius);
      if (!w.fits(x, y, z, f.radius, f.height)) break;
      bestX = x; bestY = y; bestZ = z;
    }
    f.pos.x = bestX; f.pos.y = bestY; f.pos.z = bestZ;
    f.vel.x *= 0.3; f.vel.z *= 0.3;
    if (f.vel.y < 0) f.vel.y = 0;
    if (spec.iframe) f.iframeUntil = now + spec.iframe;
    g.effects.blink(from, f.pos, spec.color || f.char.accent, f.height);
    audio.blink(f === g.player);
    if (f === g.player) g.feel.blinkPunch();
  }

  buffKind(f, spec) {
    const g = this.game;
    f.addBuff(spec.id === 'focus' ? 'focus' : spec.id, spec.dur, g.now, spec.buff || {});
    if (spec.buff && spec.buff.speed) f.addBuff('speed', spec.dur, g.now, spec.buff.speed);
    g.effects.buffAura(f, spec.color || f.char.accent, spec.dur);
    audio.buff(f === g.player);
    if (f === g.player) g.hud.banner(spec.name, 0.6);
  }

  summonKind(f, spec) {
    const g = this.game;
    for (let i = 0; i < (spec.count || 1); i++) {
      g.summons.spawn(f, spec.summon, { angle: rnd(-0.6, 0.6) + i * 0.7 });
    }
    g.effects.summonRing(f, spec.color || f.char.accent);
    audio.summon(f === g.player);
  }

  parryKind(f, spec) {
    const g = this.game;
    f.parryUntil = g.now + spec.window;
    g.effects.parryStance(f, spec.color || f.char.accent, spec.window);
    audio.parryStance(f === g.player);
  }

  adsKind() { /* aiming is a hold state, handled by the controller */ }

  chargeKind(f, spec, slot, opts) { this.projectileKind(f, spec, slot, opts); }

  domainKind(f, spec, slot, opts) {
    const g = this.game;
    g.domains.open(f, spec, opts);
  }

  /* ---------------------------------------------------------------- utils */
  aimDir(f, spec, opts, flatten = false) {
    const d = opts.dir ? { x: opts.dir.x, y: opts.dir.y, z: opts.dir.z } : dirFromAngles(f.yaw, f.pitch, {});
    if (flatten) {
      d.y = 0;
      const l = Math.hypot(d.x, d.z) || 1;
      d.x /= l; d.z /= l;
    }
    const spread = spec.spread || 0;
    if (spread > 0) {
      const mul = f.ads ? (f.char.secondary.spreadMul || 1) : 1;
      d.x += rnd(-spread, spread) * mul;
      d.y += rnd(-spread, spread) * mul;
      d.z += rnd(-spread, spread) * mul;
      const l = Math.hypot(d.x, d.y, d.z) || 1;
      d.x /= l; d.y /= l; d.z /= l;
    }
    return d;
  }
}

export { RULES };
