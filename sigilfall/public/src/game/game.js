/* =============================================================================
   the match.  owns the world, the fighters and every combat system, and runs
   them in a fixed order each frame.  offline it is authoritative; online it
   predicts locally and lets the server correct health, kills and score.
   ========================================================================== */
import { getMap } from '../world/mapData.js';
import { World } from '../world/collision.js';
import { NavGrid } from '../world/nav.js';
import { buildArena } from '../world/mapBuilder.js';
import { Fighter } from '../combat/fighter.js';
import { makeBody, updateBody, flashBody, startDeathFall, drawNameplate } from '../combat/bodies.js';
import { getMode, RULES } from './rules.js';
import { PlayerController } from './player.js';
import { ViewModel } from '../combat/viewmodel.js';
import { ProjectileSystem } from '../combat/projectiles.js';
import { ZoneSystem } from '../combat/zones.js';
import { DomainSystem } from '../combat/domains.js';
import { SummonSystem } from '../combat/summons.js';
import { Effects } from '../combat/effects.js';
import { Feel } from '../combat/feel.js';
import { AbilityRuntime } from '../combat/abilities.js';
import { BotBrain } from '../ai/bot.js';
import { Hud } from '../ui/hud.js';
import { audio } from '../audio/audio.js';
import { CHARACTER_LIST, CHARM_LIST } from '../characters/roster.js';
import { clamp, dist2, pick, rndInt } from '../core/math.js';

const BOT_NAMES = ['서리', '단목', '유하', '나린', '청명', '해인', '도경', '소랑', '이후', '결', '무향', '천류'];

export class Game {
  constructor(engine, input) {
    this.engine = engine;
    this.input = input;
    this.active = false;
    this.paused = false;
    this.now = 0;
    this.dt = 0;
    this.fighters = [];
    this.byId = new Map();
    this.player = null;
    this.scores = {};
    this.state = 'idle';            // idle | live | ended
    this.net = null;                // set when the match is online
    this.listeners = {};
    this._updater = null;
  }

  on(evt, fn) { (this.listeners[evt] ||= []).push(fn); return this; }
  emit(evt, data) { for (const fn of this.listeners[evt] || []) fn(data); }

  /* ------------------------------------------------------------ lifecycle */
  start(cfg) {
    this.stop();
    this.cfg = Object.assign({
      mode: 'tdm', map: 'shrine', character: 'rift', botCount: 6, botLevel: 'normal',
      playerName: '나', online: null
    }, cfg);

    this.mode = getMode(this.cfg.mode);
    this.mapDef = getMap(this.cfg.map);
    this.world = new World(this.mapDef);
    this.nav = new NavGrid(this.world);
    this.net = this.cfg.online || null;

    const built = buildArena(this.mapDef);
    this.engine.clearScene();
    this.engine.scene.background = built.env.background;
    this.engine.scene.fog = built.env.fog;
    this.engine.scene.add(built.group);
    this.arena = built.group;
    this.sun = built.sun;

    this.effects = new Effects(this);
    this.feel = new Feel(this);
    this.projectiles = new ProjectileSystem(this);
    this.zones = new ZoneSystem(this);
    this.domains = new DomainSystem(this);
    this.summons = new SummonSystem(this);
    this.abilities = new AbilityRuntime(this);

    this.now = 0;
    this.state = 'live';
    this.scores = {};
    this.fighters.length = 0;
    this.byId.clear();

    /* local player */
    const player = new Fighter({
      id: this.net ? this.net.selfId : 1, name: this.cfg.playerName || '나',
      character: this.cfg.character, charm: this.cfg.charm, isPlayer: true, team: 'a'
    });
    this.addFighter(player);
    this.player = player;
    this.controller = new PlayerController(this, player);
    this.hud = new Hud(this);

    if (!this.net) {
      this.fillBots();
      this.assignTeams();
      for (const f of this.fighters) this.scores[f.team] ??= 0;
    }

    if (!this.net) {
      let ai = 0, bi = 0, fi = 0;
      for (const f of this.fighters) {
        const slot = this.mode.ffa ? fi++ : (f.team === 'a' ? ai++ : bi++);
        this.spawnFighter(f, slot);
      }
    }

    this.active = true;
    this.paused = false;
    this._updater = this.engine.add((dt) => this.update(dt));
    this.hud.show(true);
    audio.playMatchStart();
    audio.startAmbient(this.mapDef.id);
    this.emit('start', this);
    return this;
  }

  stop() {
    if (this._updater) { this.engine.remove(this._updater); this._updater = null; }
    if (!this.active) return;
    this.active = false;
    this.controller?.dispose();
    this.hud?.show(false);
    this.hud?.dispose();
    this.effects?.dispose();
    this.summons?.dispose();
    this.zones?.dispose();
    this.domains?.dispose();
    this.projectiles?.dispose();
    this.engine.clearScene();
    audio.stopAmbient();
    this.fighters.length = 0;
    this.byId.clear();
    this.player = null;
    this.state = 'idle';
  }

  fillBots() {
    const want = Math.max(0, Math.min(this.cfg.botCount, this.mode.maxPlayers - 1));
    const names = BOT_NAMES.slice();
    for (let i = 0; i < want; i++) {
      const name = names.length ? names.splice(rndInt(0, names.length - 1), 1)[0] : 'BOT' + i;
      const bot = new Fighter({
        name, character: pick(CHARACTER_LIST), charm: pick(CHARM_LIST),
        isBot: true, botLevel: this.cfg.botLevel
      });
      bot.brain = new BotBrain(this, bot, this.cfg.botLevel);
      this.addFighter(bot);
    }
  }

  addFighter(f) {
    this.fighters.push(f);
    this.byId.set(f.id, f);
    // the player gets a body too: it shows up in the death camera and in the
    // third person beat a domain expansion takes
    f.mesh = makeBody(f, !f.isPlayer);
    f.mesh.visible = false;
    this.engine.scene.add(f.mesh);
    return f;
  }

  removeFighter(id) {
    const f = this.byId.get(id);
    if (!f) return;
    if (f.mesh) this.engine.scene.remove(f.mesh);
    this.byId.delete(id);
    const i = this.fighters.indexOf(f);
    if (i >= 0) this.fighters.splice(i, 1);
  }

  assignTeams() {
    if (this.mode.ffa) {
      for (const f of this.fighters) f.team = 'p' + f.id;
      return;
    }
    let a = 0, b = 0;
    for (const f of this.fighters) {
      if (f.isPlayer) { f.team = 'a'; a++; continue; }
      if (a <= b) { f.team = 'a'; a++; } else { f.team = 'b'; b++; }
    }
    this.refreshBodyTints();
  }

  refreshBodyTints() {
    for (const f of this.fighters) {
      if (!f.mesh || f.isPlayer) continue;
      const enemy = this.isEnemy(this.player, f);
      this.engine.scene.remove(f.mesh);
      f.mesh = makeBody(f, enemy);
      this.engine.scene.add(f.mesh);
    }
  }

  isEnemy(a, b) { return !!a && !!b && a !== b && a.team !== b.team; }
  enemiesOf(f) { return this.fighters.filter((o) => this.isEnemy(f, o)); }
  aliveEnemiesOf(f) { return this.fighters.filter((o) => o.alive && this.isEnemy(f, o)); }

  /* ------------------------------------------------------------ spawning */
  spawnPoint(f, slot) {
    const m = this.mapDef;
    const list = this.mode.ffa ? m.ffaSpots : (f.team === 'a' ? m.spawnsA : m.spawnsB);
    if (slot !== undefined && slot !== null) return list[slot % list.length];
    // pick the spot furthest from trouble
    let best = list[0], bestScore = -1e9;
    for (const s of list) {
      let score = Math.random() * 5;
      for (const o of this.fighters) {
        if (!o.alive || !this.isEnemy(f, o)) continue;
        const d = dist2(s[0], s[1], o.pos.x, o.pos.z);
        score += Math.min(d, 36);
        if (d < 20 && !this.world.segBlocked(s[0], 1.6, s[1], o.pos.x, o.centerY, o.pos.z)) score -= 60;
      }
      if (score > bestScore) { bestScore = score; best = s; }
    }
    return best;
  }

  spawnFighter(f, slot) {
    const s = this.spawnPoint(f, slot);
    // a character or charm swap made while dead takes effect here
    if (f.pendingCharm && f.pendingCharm !== f.charm.id) {
      f.setCharm(f.pendingCharm);
      f.pendingCharm = null;
    }
    if (f.pendingCharacter && f.pendingCharacter !== f.charId) {
      f.setCharacter(f.pendingCharacter);
      f.pendingCharacter = null;
      if (f === this.player) {
        this.hud.buildAbilities();
        this.controller.view.dispose();
        this.controller.view = new ViewModel(this, f);
        document.getElementById('vitName').textContent = f.char.latin;
        this.emit('characterChanged', f);
      } else if (f.mesh) {
        this.engine.scene.remove(f.mesh);
        f.mesh = makeBody(f, this.isEnemy(this.player, f));
        this.engine.scene.add(f.mesh);
      }
    }
    f.resetCombat();
    f.alive = true;
    f.spawnSeq++;
    f.pos.x = s[0]; f.pos.z = s[1];
    f.pos.y = this.world.supportAt(s[0], s[1], 60, f.radius);
    f.vel.x = f.vel.y = f.vel.z = 0;
    f.height = RULES.standHeight;
    f.yaw = Math.atan2(f.pos.x, f.pos.z) + (this.mode.ffa ? Math.random() * 0.6 - 0.3 : 0);
    f.pitch = 0;
    f.spawnAt = this.now;
    if (f.mesh) { f.mesh.visible = !f.isPlayer; f.mesh.userData.deathT = 0; }
    if (f === this.player) {
      this.hud.onSpawn();
      this.effects.spawnFlash(f);
    }
    this.emit('spawn', f);
  }

  /* ------------------------------------------------------------ damage */
  /* opts: { head, kind, dir:{x,z}, ability, noUlt, trueDamage } */
  damage(victim, amount, attacker, opts = {}) {
    if (!victim || !victim.alive || this.state !== 'live') return 0;
    if (attacker && victim !== attacker && !this.isEnemy(attacker, victim)) return 0;
    const now = this.now;

    if (!opts.trueDamage) {
      if (now < victim.iframeUntil) return 0;
      if (now < victim.parryUntil && this.facesAttacker(victim, attacker)) {
        this.abilities.onParry(victim, attacker);
        return 0;
      }
      if (now - victim.spawnAt < RULES.spawnProtect) amount *= RULES.spawnProtectMul;
      if (victim.hasBuff('shield', now)) amount *= victim.buff('shield', now).data;
      if (victim.mods.taken) amount *= victim.mods.taken;
      if (now < victim.dashUntil && victim.dashSpec && victim.dashSpec.armor) amount *= victim.dashSpec.armor;
      if (now < victim.markedUntil) amount *= 1.14;
      amount *= this.domains.damageTakenMul(victim, attacker);
    }
    if (attacker) amount *= this.domains.damageDealtMul(attacker, opts);

    const dealt = Math.max(1, Math.round(amount));

    // online: the server owns health.  we only claim the hit and show feedback.
    if (this.net && attacker === this.player) {
      this.net.claimHit(victim, dealt, opts);
      this.hud.showDamage(victim, dealt, opts.head);
      this.feel.hitMarker(opts.head, false);
      flashBody(victim, 0.7);
      return dealt;
    }
    if (this.net && attacker !== this.player) return 0;     // remote damage arrives from the server

    victim.hp -= dealt;
    victim.lastDamageAt = now;
    victim.lastAttackerId = attacker ? attacker.id : 0;
    if (opts.flinch !== false) victim.flinchUntil = now + 0.25;
    flashBody(victim, 0.8);

    if (attacker && attacker !== victim) {
      if (now < attacker.refundHpUntil) {
        attacker.refundHpUntil = 0;
        this.heal(attacker, attacker.refundHp);
      }
      attacker.stats.damage += Math.min(dealt, victim.hp + dealt);
      attacker.lastHitAt = now;
      if (!opts.noUlt) attacker.addUlt(dealt * RULES.ult.perDamage);
      this.domains.onDamageDealt(attacker, dealt);
      if (attacker === this.player) {
        this.hud.showDamage(victim, dealt, opts.head);
        this.feel.hitMarker(opts.head, victim.hp <= 0);
        audio.hit(opts.head);
      }
    }
    if (victim === this.player) {
      victim.addUlt(dealt * RULES.ult.perDamageTaken);
      this.hud.onHurt(attacker, dealt);
      this.feel.damageShake(dealt / victim.maxHp);
      audio.hurt();
    }
    this.effects.hitSpark(victim, opts);
    if (victim.hp <= 0) this.kill(victim, attacker, opts);
    return dealt;
  }

  /* a parry only covers the half of the world the defender is looking at */
  facesAttacker(defender, attacker) {
    if (!attacker) return false;
    const dx = attacker.pos.x - defender.pos.x, dz = attacker.pos.z - defender.pos.z;
    const l = Math.hypot(dx, dz) || 1;
    const fx = -Math.sin(defender.yaw), fz = -Math.cos(defender.yaw);
    return (dx / l) * fx + (dz / l) * fz > 0.25;
  }

  heal(f, amount) {
    if (!f || !f.alive) return 0;
    const before = f.hp;
    f.hp = clamp(f.hp + amount, 0, f.maxHp);
    if (f === this.player && f.hp > before) this.hud.flashHeal();
    return f.hp - before;
  }

  kill(victim, attacker, opts = {}) {
    if (!victim.alive) return;
    victim.alive = false;
    victim.hp = 0;
    victim.deathAt = this.now;
    victim.respawnAt = this.now + this.mode.respawn;
    victim.stats.deaths++;
    victim.charging = false;
    this.domains.onFighterDeath(victim);
    this.summons.onOwnerDeath(victim);
    startDeathFall(victim);
    this.effects.deathBurst(victim);

    if (attacker && attacker !== victim) {
      attacker.stats.kills++;
      attacker.addUlt(RULES.ult.perKill);
      attacker.killStreak = (this.now - attacker.streakAt < RULES.killStreakWindow) ? attacker.killStreak + 1 : 1;
      attacker.streakAt = this.now;
      attacker.stats.best = Math.max(attacker.stats.best, attacker.killStreak);
      if (!this.net) this.scores[attacker.team] = (this.scores[attacker.team] || 0) + 1;
      if (attacker === this.player) {
        this.feel.killFlash();
        audio.kill(attacker.killStreak);
        this.hud.onKill(attacker.killStreak);
      }
    }
    this.hud.killFeed(attacker, victim, opts);
    if (victim === this.player) {
      this.hud.onDeath(attacker);
      this.controller.onDeath();
      audio.death();
    }
    this.emit('kill', { victim, attacker });
    if (!this.net) this.checkVictory();
  }

  checkVictory() {
    if (this.state !== 'live') return;
    for (const [team, sc] of Object.entries(this.scores)) {
      if (sc >= this.mode.target) return this.endMatch(team, 'score');
    }
    return undefined;
  }

  endMatch(winTeam, why) {
    if (this.state === 'ended') return;
    this.state = 'ended';
    this.controller?.releaseLook();
    audio.playMatchEnd(winTeam === this.player?.team);
    this.emit('end', { winTeam, why, scores: this.scores, fighters: this.fighters.slice() });
  }

  /* ------------------------------------------------------------ queries */
  /* first fighter along a ray.  returns { f, dist, head, point } or null */
  rayFighter(ox, oy, oz, dx, dy, dz, maxDist, shooter, opts = {}) {
    let best = null;
    const wallDist = opts.ignoreWalls ? maxDist : this.world.raycast(ox, oy, oz, dx, dy, dz, maxDist);
    const limit = Math.min(maxDist, wallDist + 0.02);
    for (const f of this.fighters) {
      if (!f.alive || f === shooter) continue;
      if (opts.enemiesOf && !this.isEnemy(opts.enemiesOf, f)) continue;
      const hit = rayCapsule(ox, oy, oz, dx, dy, dz, f, limit, opts.fat || 0);
      if (!hit) continue;
      if (!best || hit.dist < best.dist) best = Object.assign({ f }, hit);
    }
    return best;
  }

  /* every fighter a wide beam touches, sorted by distance */
  rayFighters(ox, oy, oz, dx, dy, dz, maxDist, shooter, width, opts = {}) {
    const out = [];
    const wallDist = opts.ignoreWalls ? maxDist : this.world.raycast(ox, oy, oz, dx, dy, dz, maxDist);
    const limit = Math.min(maxDist, wallDist + 0.05);
    for (const f of this.fighters) {
      if (!f.alive || f === shooter) continue;
      if (shooter && !this.isEnemy(shooter, f)) continue;
      const hit = rayCapsule(ox, oy, oz, dx, dy, dz, f, limit, width);
      if (hit) out.push(Object.assign({ f }, hit));
    }
    out.sort((a, b) => a.dist - b.dist);
    return out;
  }

  fightersInSphere(x, y, z, radius, filterOwner, opts = {}) {
    const out = [];
    for (const f of this.fighters) {
      if (!f.alive) continue;
      if (filterOwner) {
        if (opts.allies ? this.isEnemy(filterOwner, f) : !this.isEnemy(filterOwner, f)) continue;
      }
      const d = Math.hypot(f.pos.x - x, f.centerY - y, f.pos.z - z);
      if (d <= radius + f.radius) out.push({ f, dist: d });
    }
    return out;
  }

  canSee(a, bx, by, bz) {
    return !this.world.segBlocked(a.pos.x, a.eyeY, a.pos.z, bx, by, bz);
  }

  /* ------------------------------------------------------------ frame */
  update(dt) {
    if (!this.active) return;
    if (this.paused) { this.hud.update(0); return; }
    const scale = this.feel.timeScale;
    this.dt = dt * scale;
    this.now += this.dt;
    const now = this.now;

    this.controller.update(this.dt, dt);
    this.net?.update(dt);

    for (const f of this.fighters) {
      if (f.isPlayer) continue;
      if (f.isBot) f.brain?.update(this.dt);
      if (this.net && f.isRemote) this.net.interpolate(f, dt);
    }

    if (!this.net) {
      for (const f of this.fighters) {
        if (f.alive || f.deathAt < 0) continue;
        if (now >= f.respawnAt && this.state === 'live') this.spawnFighter(f);
      }
    }

    this.abilities.update(this.dt);
    this.projectiles.update(this.dt);
    this.zones.update(this.dt);
    this.domains.update(this.dt);
    this.summons.update(this.dt);
    this.effects.update(this.dt, dt);
    this.feel.update(dt);

    const cam = this.engine.camera.position;
    for (const f of this.fighters) {
      updateBody(f, this.dt, now, cam);
      if (f.mesh && f.alive && !f.isPlayer) {
        drawNameplate(f.mesh.userData.plate, f, this.isEnemy(this.player, f));
      }
    }

    audio.setListener(this.engine.camera.position);
    this.hud.update(dt);
  }
}

/* capsule-ish fighter hit test: body cylinder plus a head sphere on top */
function rayCapsule(ox, oy, oz, dx, dy, dz, f, maxDist, fat = 0) {
  const r = f.radius + fat;
  const px = f.pos.x - ox, pz = f.pos.z - oz;
  const a = dx * dx + dz * dz;
  if (a < 1e-6) return null;
  const b = px * dx + pz * dz;
  const c = px * px + pz * pz - r * r;
  const disc = b * b - a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  let t = (b - sq) / a;
  if (t < 0) t = (b + sq) / a;
  if (t < 0 || t > maxDist) return null;
  const hy = oy + dy * t;
  const feet = f.pos.y, top = f.pos.y + f.height;
  if (hy < feet - 0.05 || hy > top + 0.08) return null;
  const head = hy >= top - RULES.headTop - fat * 0.5;
  return {
    dist: t, head,
    point: { x: ox + dx * t, y: hy, z: oz + dz * t }
  };
}
