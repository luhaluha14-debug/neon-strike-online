/* =============================================================================
   a fighter: the player, a bot or a remote player.  pure state plus an optional
   body mesh.  every combat rule reads from here and nothing else.
   ========================================================================== */
import { RULES } from '../game/rules.js';
import { getCharacter } from '../characters/roster.js';
import { clamp, dirFromAngles } from '../core/math.js';

let NEXT_LOCAL_ID = 1000;

export class Fighter {
  constructor(opts = {}) {
    this.id = opts.id || NEXT_LOCAL_ID++;
    this.name = opts.name || 'FIGHTER';
    this.team = opts.team || 'a';
    this.isPlayer = !!opts.isPlayer;
    this.isBot = !!opts.isBot;
    this.isRemote = !!opts.isRemote;
    this.botLevel = opts.botLevel || 'normal';

    this.pos = { x: 0, y: 0, z: 0 };
    this.vel = { x: 0, y: 0, z: 0 };
    this.yaw = 0; this.pitch = 0;
    this.height = RULES.standHeight;
    this.radius = 0.42;
    this.onGround = true;
    this.wasGround = true;
    this.crouch = false;
    this.sprint = false;
    this.ads = false;
    this.alive = false;
    this.spawnSeq = 0;

    this.mesh = null;
    this.aim = { x: 0, y: 0, z: -1 };
    this.stats = newStats();
    this.setCharacter(opts.character || 'rift');
  }

  setCharacter(id) {
    const c = getCharacter(id);
    this.charId = c.id;
    this.char = c;
    this.maxHp = c.hp;
    this.radius = c.radius;
    this.maxEnergy = c.energy.max;
    this.resetCombat();
  }

  resetCombat() {
    const t = 0;
    this.hp = this.maxHp;
    this.energy = this.maxEnergy;
    this.energyBlockUntil = t;
    this.ult = 0;
    this.ultActive = false;
    this.ultEndsAt = 0;
    this.meleeCount = 0;
    this.cd = { q: 0, a1: 0, a2: 0, rmb: 0, refocus: 0 };
    this.nextFire = 0;
    this.charge = 0;              // secondary charge, 0..1
    this.charging = false;
    this.castUntil = 0;           // wind-up: cannot fire or move fast
    this.recoverUntil = 0;
    this.dashUntil = 0;
    this.dashDir = { x: 0, z: 0 };
    this.dashSpeed = 0;
    this.dashKind = null;
    this.dashHits = null;
    this.iframeUntil = 0;
    this.parryUntil = 0;
    this.slowUntil = 0;
    this.slowMul = 1;
    this.markedUntil = 0;
    this.markedBy = 0;
    this.pullVec = null;
    this.stacks = 0;
    this.stackUntil = 0;
    this.buffs = Object.create(null);   // id -> { until, data }
    this.domainId = 0;
    this.lastDamageAt = -99;
    this.lastHitAt = -99;
    this.lastAttackerId = 0;
    this.spawnAt = -99;
    this.deathAt = -99;
    this.respawnAt = 0;
    this.killStreak = 0;
    this.streakAt = -99;
    this.refundHpUntil = 0;
    this.refundHp = 0;
    this.flinchUntil = 0;
  }

  resetStats() { this.stats = newStats(); }

  get eyeY() { return this.pos.y + this.height - RULES.eyeDrop; }
  eye(out = {}) { out.x = this.pos.x; out.y = this.eyeY; out.z = this.pos.z; return out; }
  aimDir(out) { return dirFromAngles(this.yaw, this.pitch, out || this.aim); }
  get centerY() { return this.pos.y + this.height * 0.55; }
  get headY() { return this.pos.y + this.height - RULES.headTop * 0.5; }

  hasBuff(id, now) { const b = this.buffs[id]; return !!b && b.until > now; }
  buff(id, now) { const b = this.buffs[id]; return b && b.until > now ? b : null; }
  addBuff(id, dur, now, data) { this.buffs[id] = { until: now + dur, data: data || null }; }
  clearBuff(id) { delete this.buffs[id]; }

  isBusy(now) { return now < this.castUntil || now < this.recoverUntil; }
  isDashing(now) { return now < this.dashUntil; }

  /* speed after every multiplier that is currently running */
  currentSpeed(now) {
    let s = this.char.speed;
    if (this.crouch) s *= RULES.crouchMul;
    else if (this.sprint && !this.ads && now > this.flinchUntil) s *= RULES.sprintMul;
    if (this.ads && this.char.secondary.kind === 'ads') s *= this.char.secondary.moveMul;
    if (now < this.slowUntil) s *= this.slowMul;
    if (now < this.castUntil) s *= 0.45;
    const sp = this.buff('speed', now);
    if (sp) s *= sp.data;
    return s;
  }

  addUlt(amount) {
    if (this.ultActive) return;
    this.ult = clamp(this.ult + amount, 0, RULES.ult.max);
  }
  get ultReady() { return this.ult >= RULES.ult.max - 0.01; }

  addStack(n, now) {
    this.stacks = clamp(this.stacks + n, 0, 5);
    this.stackUntil = now + 5;
  }
  stackCount(now) { return now < this.stackUntil ? this.stacks : 0; }

  spendEnergy(cost, now) {
    if (cost <= 0) return true;
    if (this.energy < cost) return false;
    this.energy -= cost;
    this.energyBlockUntil = now + this.char.energy.delay;
    return true;
  }

  updateEnergy(dt, now, locked) {
    if (locked) return;
    if (now < this.energyBlockUntil) return;
    const rate = this.char.energy.regen * (this.hasBuff('refocus', now) ? 4.2 : 1);
    this.energy = clamp(this.energy + rate * dt, 0, this.maxEnergy);
  }

  snapshot() {
    return {
      id: this.id, x: this.pos.x, y: this.pos.y, z: this.pos.z,
      yaw: this.yaw, pitch: this.pitch, h: this.height, hp: this.hp, alive: this.alive
    };
  }
}

export function newStats() {
  return { kills: 0, deaths: 0, assists: 0, damage: 0, shots: 0, hits: 0, heads: 0, best: 0 };
}
