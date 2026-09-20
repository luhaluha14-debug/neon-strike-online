/* =============================================================================
   one room: its lobby, its match and the authoritative rules.

   authority model
     players move themselves and report what they hit.  the server checks every
     claim - the attacker was alive, the target was an enemy, the distance and
     the aim line agree with a recent position of that target, nothing solid sat
     between them, the ability was off cooldown and the damage is within what
     that ability can do - and only then applies it.  health, kills, score,
     respawns, ultimate charge and the match result are the server's alone.
     server-run bots are simulated here in full.

   what this does not stop: an aimbot.  a client that aims perfectly still has
   to hit, and the server cannot tell a good player from a good script.  that is
   the same trade this style of netcode always makes, and it is written down in
   the README rather than hidden.
   ========================================================================== */
import { MAPS, MAP_LIST, MODES, MODE_LIST, CHARACTERS, CHARACTER_LIST, CHARM_LIST, abilityOf, getCharm,
  RULES, falloffMul, fireInterval, worldFor, navFor } from './shared.js';
import { ServerBot } from './bot.js';

const LAG_WINDOW = 0.45;         // seconds of target history a claim may match
const DIST_SLACK = 4.0;          // metres between the claimed and the server distance
const AIM_SLACK = 1.6;           // metres a hit may sit off the reported aim line
const DAMAGE_SLACK = 1.75;       // headroom over the book value for buffs and domains
const TICK_HZ = 20;

const now = () => Date.now() / 1000;
const clamp = (v, a, b) => (v < a ? a : (v > b ? b : v));
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

let NEXT_BOT_ID = 100000;
const BOT_NAMES = ['서리', '단목', '유하', '나린', '청명', '해인', '도경', '소랑', '이후', '결'];

export class Room {
  constructor(code, isPublic, mode, mapChoice, onEmpty, opts = {}) {
    this.code = code;
    this.isPublic = isPublic;
    this.mode = MODE_LIST.includes(mode) ? mode : 'tdm';
    this.mapChoice = mapChoice;
    this.onEmpty = onEmpty;
    this.players = new Map();          // id -> player (humans and bots)
    this.hostId = 0;
    this.state = 'lobby';              // lobby | play | end
    this.map = null;
    this.world = null;
    this.nav = null;
    this.scores = {};
    this.countdownAt = 0;
    this.lastCountdown = -1;
    this.endsAt = 0;
    this.lastTick = now();
    this.domains = [];
    this.botLevel = opts.botLevel || 'normal';
    this.fillBots = opts.fillBots !== false;
  }

  get M() { return MODES[this.mode]; }
  capacity() { return this.M.maxPlayers; }
  humans() { return [...this.players.values()].filter((p) => !p.isBot); }
  bots() { return [...this.players.values()].filter((p) => p.isBot); }
  isFull() { return this.humans().length >= this.capacity(); }

  /* ------------------------------------------------------------- comms */
  send(p, obj) { if (!p.isBot) p.client.send(obj); }
  broadcast(obj, exceptId) {
    const s = JSON.stringify(obj);
    for (const p of this.players.values()) {
      if (p.isBot || p.id === exceptId) continue;
      p.client.send(s);
    }
  }

  info() {
    return {
      t: 'room', code: this.code, pub: this.isPublic, mode: this.mode, map: this.mapChoice,
      cur: this.map, host: this.hostId, state: this.state,
      cd: this.countdownAt ? Math.max(0, Math.ceil(this.countdownAt - now())) : 0,
      fill: this.fillBots, bots: this.botLevel, target: this.M.target,
      ps: [...this.players.values()].map((p) => ({
        id: p.id, name: p.name, team: p.team, ch: p.pendingCharacter, bot: !!p.isBot
      }))
    };
  }
  sendInfo() { this.broadcast(this.info()); }

  summary() {
    return {
      code: this.code, mode: this.mode, map: this.mapChoice, state: this.state,
      n: this.humans().length, max: this.capacity()
    };
  }

  /* ------------------------------------------------------------- roster */
  makeFighter(opts) {
    const ch = CHARACTER_LIST.includes(opts.character) ? opts.character : 'rift';
    const c = CHARACTERS[ch];
    const charm = getCharm(opts.charm);
    return {
      id: opts.id, name: opts.name, client: opts.client || null,
      isBot: !!opts.isBot, brain: null,
      character: ch, pendingCharacter: ch, charm, pendingCharm: charm, team: null,
      alive: false, hp: 0, maxHp: Math.round(c.hp * (charm.mods.hp || 1)),
      pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 },
      yaw: 0, pitch: 0, height: RULES.standHeight, radius: c.radius,
      onGround: true, crouch: false, sprint: false, flags: 0,
      hist: [], lastStateAt: 0, spawnSeq: 0, spawnAt: -99, respawnAt: 0,
      ult: 0, ultActive: false, ultEndsAt: 0,
      cd: { q: 0, a1: 0, a2: 0, rmb: 0 },
      fireCredit: 2, fireAt: 0,
      markedUntil: 0, markedBy: 0, slowUntil: 0, slowMul: 1, iframeUntil: 0,
      dashUntil: 0, dashArmorUntil: 0, energy: c.energy.max,
      killStreak: 0, streakAt: -99,
      stats: newStats()
    };
  }

  addPlayer(client, character, charm) {
    const p = this.makeFighter({ id: client.id, name: client.name, client, character, charm });
    p.team = this.teamFor(p);
    this.players.set(p.id, p);
    if (!this.hostId) this.hostId = p.id;
    if (this.state === 'play') {
      this.resetFighter(p);
      this.scores[p.team] ??= 0;
      p.respawnAt = now() + 1;
      this.send(p, this.startMsg());
      this.broadcast({ t: 'joined', p: this.pub(p) }, p.id);
    }
    this.syncBots();
    this.sendInfo();
    return p;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    if (this.hostId === id) {
      const next = this.humans()[0];
      this.hostId = next ? next.id : 0;
    }
    if (!this.humans().length) { this.onEmpty(); return; }
    if (this.state === 'play') {
      this.broadcast({ t: 'left', id });
      if (this.M.ffa) delete this.scores[p.team];
      this.syncBots();
      const teams = new Set([...this.players.values()].map((o) => o.team));
      if (this.players.size < 2 || teams.size < 2) this.endMatch([...teams][0] || null, 'forfeit');
    } else {
      this.syncBots();
    }
    this.sendInfo();
  }

  teamFor(p) {
    if (this.M.ffa) return 'p' + p.id;
    let a = 0, b = 0;
    for (const o of this.players.values()) {
      if (o === p) continue;
      if (o.team === 'a') a++; else if (o.team === 'b') b++;
    }
    return a <= b ? 'a' : 'b';
  }
  reassignTeams() {
    const list = [...this.players.values()];
    list.forEach((o) => { o.team = null; });
    list.forEach((o) => { o.team = this.teamFor(o); });
  }

  /* bots top the room up so a half empty lobby is still a match */
  syncBots() {
    if (!this.fillBots) return;
    const want = Math.max(0, Math.min(this.M.botFill, this.M.maxPlayers) - this.humans().length);
    const have = this.bots();
    for (let i = have.length; i > want; i--) {
      const bot = have[i - 1];
      this.players.delete(bot.id);
      if (this.state === 'play') this.broadcast({ t: 'left', id: bot.id });
    }
    for (let i = have.length; i < want; i++) {
      const used = new Set([...this.players.values()].map((p) => p.name));
      const name = BOT_NAMES.find((n) => !used.has(n)) || ('상대' + (i + 1));
      const bot = this.makeFighter({
        id: NEXT_BOT_ID++, name, isBot: true,
        character: CHARACTER_LIST[(Math.random() * CHARACTER_LIST.length) | 0],
        charm: CHARM_LIST[(Math.random() * CHARM_LIST.length) | 0]
      });
      bot.team = this.teamFor(bot);
      this.players.set(bot.id, bot);
      if (this.state === 'play') {
        this.resetFighter(bot);
        this.scores[bot.team] ??= 0;
        bot.brain = new ServerBot(this, bot, this.botLevel);
        this.spawn(bot);
        this.broadcast({ t: 'joined', p: this.pub(bot) });
      }
    }
  }

  /* -------------------------------------------------------------- input */
  onMessage(client, m) {
    const p = this.players.get(client.id);
    if (!p) return;
    switch (m.t) {
      case 'start':
        if (client.id !== this.hostId || this.state !== 'lobby' || this.isPublic) return;
        this.startMatch();
        break;
      case 'settings': {
        if (client.id !== this.hostId || this.state !== 'lobby' || this.isPublic) return;
        if (MODE_LIST.includes(m.mode) && m.mode !== this.mode) {
          if (m.mode === 'duel' && this.humans().length > 2) {
            return this.send(p, { t: 'err', m: '결투는 2명까지만 가능합니다' });
          }
          this.mode = m.mode;
          this.reassignTeams();
          this.syncBots();
        }
        if (MAP_LIST.includes(m.map) || m.map === 'random') this.mapChoice = m.map;
        if (['easy', 'normal', 'hard'].includes(m.bots)) this.botLevel = m.bots;
        if (typeof m.fill === 'boolean') { this.fillBots = m.fill; this.syncBots(); }
        this.sendInfo();
        break;
      }
      case 'char':
        if (m.cm) p.pendingCharm = getCharm(m.cm);
        if (!CHARACTER_LIST.includes(m.ch)) return;
        p.pendingCharacter = m.ch;
        if (this.state !== 'play') { p.character = m.ch; p.charm = p.pendingCharm; }
        this.sendInfo();
        break;
      case 'st': this.onState(p, m); break;
      case 'fire': this.onFire(p, m); break;
      case 'abil': this.onAbility(p, m); break;
      case 'hit': this.onHitClaim(p, m); break;
      default: break;
    }
  }

  onState(p, m) {
    if (this.state !== 'play' || !p.alive || m.sq !== p.spawnSeq) return;
    if (!Array.isArray(m.p) || m.p.length !== 3) return;
    const t = now();
    const A = MAPS[this.map];
    const x = num(m.p[0], NaN), y = num(m.p[1], NaN), z = num(m.p[2], NaN);
    if (!Number.isFinite(x + y + z)) return;
    const nx = clamp(x, -A.sx, A.sx), ny = clamp(y, -2, 40), nz = clamp(z, -A.sz, A.sz);
    // generous, because dashes and blinks are legitimate teleports
    const allowed = 16 + (t - p.lastStateAt) * 30;
    if (Math.hypot(nx - p.pos.x, nz - p.pos.z) > allowed && t - p.spawnAt > 0.5) {
      this.send(p, { t: 'pos', p: [r2(p.pos.x), r2(p.pos.y), r2(p.pos.z)], sq: p.spawnSeq });
      return;
    }
    p.pos.x = nx; p.pos.y = ny; p.pos.z = nz;
    p.lastStateAt = t;
    p.yaw = num(m.y);
    p.pitch = clamp(num(m.pi), -1.6, 1.6);
    p.height = clamp(num(m.h, RULES.standHeight), RULES.crouchHeight - 0.05, RULES.standHeight);
    p.flags = num(m.f) & 0x3f;
    // bit 8 means "dashing behind a sorcery that blunts damage"
    if (p.flags & 8) p.dashArmorUntil = t + 0.12;
    p.energy = clamp(num(m.e, p.energy), 0, 100);
    p.hist.push({ t, x: nx, y: ny, z: nz, h: p.height });
    while (p.hist.length && t - p.hist[0].t > 1.2) p.hist.shift();
  }

  /* a basic attack: rate limited, then each claimed hit is checked */
  onFire(p, m) {
    if (this.state !== 'play' || !p.alive) return;
    const spec = CHARACTERS[p.character].primary;
    const t = now();
    const rate = fireInterval(spec) * 0.82;          // a little slack for jitter
    p.fireCredit = Math.min(2, p.fireCredit + (t - p.fireAt) / rate);
    p.fireAt = t;
    if (p.fireCredit < 0.85) return;
    p.fireCredit -= 1;
    p.stats.shots++;
    const ends = sanitizeEnds(m.e);
    const dir = sanitizeDir(m.d);
    this.broadcast({ t: 'shot', id: p.id, s: 'lmb', d: dir, e: ends }, p.id);
    this.resolveClaims(p, m.h, spec, 'lmb', dir);
  }

  /* an ability cast: cooldown and charge are the server's to allow */
  onAbility(p, m) {
    if (this.state !== 'play' || !p.alive) return;
    const slot = m.s;
    const spec = abilityOf(p.character, slot);
    if (!spec) return;
    const t = now();

    if (slot === 'ult') {
      if (p.ult < RULES.ult.max - 0.5 || p.ultActive) return;
      p.ult = 0;
      p.ultActive = true;
      p.ultEndsAt = t + spec.dur + spec.castTime + ((p.charm && p.charm.mods.domainDur) || 0);
      this.openDomain(p, spec, m);
    } else if (slot === 'q' || slot === 'a1' || slot === 'a2' || slot === 'rmb') {
      if (spec.cd && t < p.cd[slot] - 0.25) return;
      if (spec.cd) p.cd[slot] = t + this.cooldownFor(p, slot, spec);
      if (spec.iframe) p.iframeUntil = t + spec.iframe;
      if (spec.hpCost) p.hp = Math.max(1, p.hp - spec.hpCost);
    } else if (slot !== 'refocus') return;

    const dir = sanitizeDir(m.d);
    this.broadcast({
      t: 'abil', id: p.id, s: slot, d: dir, p: sanitizePos(m.p), c: num(m.c, 0)
    }, p.id);
    this.resolveClaims(p, m.h, spec, slot, dir);
  }

  /* damage claimed after the fact: zone ticks, splashes, summon bites */
  onHitClaim(p, m) {
    if (this.state !== 'play' || !p.alive) return;
    const spec = specById(p.character, m.a);
    if (!spec) return;
    this.resolveClaims(p, m.h, spec, m.s || 'lmb', sanitizeDir(m.d));
  }

  resolveClaims(p, claims, spec, slot, claimedDir) {
    if (!Array.isArray(claims) || !claims.length) return;
    const t = now();
    // the direction a shot was fired in has to match the orientation everyone
    // else was shown; otherwise the packet contradicts itself and is dropped
    const stateDir = dirFrom(p.yaw, p.pitch);
    let aim = stateDir;
    if (claimedDir) {
      const dot = claimedDir[0] * stateDir.x + claimedDir[1] * stateDir.y + claimedDir[2] * stateDir.z;
      if (Math.acos(clamp(dot, -1, 1)) > 0.7) return;
      aim = { x: claimedDir[0], y: claimedDir[1], z: claimedDir[2] };
    }
    const direct = spec.kind === 'projectile' || spec.kind === 'hitscan' ||
      spec.kind === 'melee' || spec.kind === 'charge';
    const maxDmg = maxDamageOf(spec) * DAMAGE_SLACK;
    const reach = reachOf(spec) + DIST_SLACK;
    // a swing covers an arc and a beam has width: both let a hit sit legitimately
    // off the centre line, so the tolerance has to know the shape of the attack
    const slack = AIM_SLACK +
      (spec.kind === 'melee' ? (spec.range || 3) * Math.sin(spec.arc || 0.8) : 0) +
      (spec.width ? spec.width * 0.5 : 0);
    for (const h of claims.slice(0, 8)) {
      if (!h || typeof h !== 'object') continue;
      const v = this.players.get(h.id);
      if (!v || v === p || !v.alive || v.team === p.team) continue;
      const dist = Math.hypot(v.pos.x - p.pos.x, v.pos.y - p.pos.y, v.pos.z - p.pos.z);
      if (dist > reach) continue;
      if (direct && !this.plausible(p, v, h, dist, aim, slack)) continue;
      if (!direct && this.blockedFromHistory(p, v)) continue;
      let dmg = clamp(num(h.n, 0), 0, maxDmg);
      if (dmg <= 0) continue;
      if (spec.falloff) dmg = Math.min(dmg, maxDmg * falloffMul(spec.falloff, dist) * 1.05);
      const head = !!h.hd && direct;
      p.stats.hits++;
      if (head) p.stats.heads++;
      const dx = v.pos.x - p.pos.x, dz = v.pos.z - p.pos.z;
      const dl = Math.hypot(dx, dz) || 1;
      this.damage(v, dmg, p, { head, dirX: dx / dl, dirZ: dz / dl, ability: spec.id });
      if (spec.mark) { v.markedUntil = t + spec.mark.dur; v.markedBy = p.id; }
      if (spec.slow) { v.slowUntil = t + spec.slow.dur; v.slowMul = spec.slow.mul; }
    }
  }

  /* could the attacker really have hit that target, from there, just now? */
  plausible(p, v, claim, dist, aim, slack = AIM_SLACK) {
    const t = now();
    const eye = { x: p.pos.x, y: p.pos.y + p.height - RULES.eyeDrop, z: p.pos.z };
    const samples = [v.pos];
    for (let i = v.hist.length - 1; i >= 0 && t - v.hist[i].t < LAG_WINDOW; i--) samples.push(v.hist[i]);
    const claimed = num(claim.d, dist);
    for (const s of samples) {
      const h = s.h || v.height;
      for (const yy of [s.y + h * 0.55, s.y + h - 0.25]) {
        const dx = s.x - eye.x, dy = yy - eye.y, dz = s.z - eye.z;
        const d = Math.hypot(dx, dy, dz);
        if (Math.abs(d - claimed) > DIST_SLACK + d * 0.12) continue;
        const along = dx * aim.x + dy * aim.y + dz * aim.z;
        if (along <= 0) continue;
        const off = Math.sqrt(Math.max(0, d * d - along * along));
        if (off > slack + d * 0.09) continue;
        if (!this.world.segBlocked(eye.x, eye.y, eye.z, s.x, yy, s.z)) return true;
      }
    }
    return false;
  }

  /* for indirect damage we only ask that the two were not separated by a wall */
  blockedFromHistory(p, v) {
    const t = now();
    const samples = [v.pos];
    for (let i = v.hist.length - 1; i >= 0 && t - v.hist[i].t < LAG_WINDOW * 2; i--) samples.push(v.hist[i]);
    for (const s of samples) {
      if (!this.world.segBlocked(p.pos.x, p.pos.y + 1.2, p.pos.z, s.x, s.y + 1.0, s.z)) return false;
    }
    return true;
  }

  /* cooldowns are the server's to decide, charm included */
  cooldownFor(p, slot, spec) {
    const m = p.charm ? p.charm.mods : {};
    let cd = spec.cd * (m.cdMul || 1);
    if (slot === 'q' && m.cdQ) cd += m.cdQ;
    return Math.max(0.5, cd);
  }

  /* ------------------------------------------------------------- domains */
  openDomain(p, spec, m) {
    this.domains = this.domains.filter((d) => d.owner !== p);
    const pos = sanitizePos(m.p) || [p.pos.x, p.pos.y, p.pos.z];
    this.domains.push({
      owner: p, spec, x: pos[0], y: pos[1], z: pos[2],
      radius: spec.radius, endsAt: now() + spec.dur + spec.castTime,
      nextTick: now() + spec.castTime + 0.5, follow: !!spec.follow
    });
  }

  tickDomains(t) {
    for (let i = this.domains.length - 1; i >= 0; i--) {
      const d = this.domains[i];
      if (!d.owner.alive || t >= d.endsAt) {
        d.owner.ultActive = false;
        // the collapse only pays out for a domain the server ran itself
        if (d.owner.isBot && d.spec.finish && d.owner.alive) {
          for (const o of this.players.values()) {
            if (!o.alive || o.team === d.owner.team) continue;
            const dist = Math.hypot(o.pos.x - d.x, o.pos.z - d.z);
            if (dist > d.spec.finish.radius) continue;
            this.damage(o, d.spec.finish.dmg * clamp(1 - dist / (d.spec.finish.radius * 1.35), 0.35, 1),
              d.owner, { ability: d.spec.id });
          }
        }
        this.domains.splice(i, 1);
        continue;
      }
      if (d.follow) { d.x = d.owner.pos.x; d.y = d.owner.pos.y; d.z = d.owner.pos.z; }
      if (!d.owner.isBot || t < d.nextTick) continue;
      d.nextTick = t + 0.5;
      const tick = d.spec.inside && d.spec.inside.enemyTick;
      if (!tick) continue;
      for (const o of this.players.values()) {
        if (!o.alive || o.team === d.owner.team) continue;
        if (Math.hypot(o.pos.x - d.x, o.pos.z - d.z) > d.radius) continue;
        if (Math.abs(o.pos.y - d.y) > d.radius) continue;
        this.damage(o, tick, d.owner, { ability: d.spec.id, quiet: true });
      }
    }
  }

  insideEnemyDomain(f) {
    for (const d of this.domains) {
      if (d.owner.team === f.team) continue;
      if (Math.hypot(f.pos.x - d.x, f.pos.z - d.z) <= d.radius) return d;
    }
    return null;
  }

  /* -------------------------------------------------------------- damage */
  damage(v, amount, attacker, opts = {}) {
    if (!v.alive || this.state !== 'play') return 0;
    const t = now();
    if (t < v.iframeUntil) return 0;
    if (t - v.spawnAt < RULES.spawnProtect) amount *= RULES.spawnProtectMul;
    if (t < v.markedUntil) amount *= 1.14;
    if (v.charm && v.charm.mods.taken) amount *= v.charm.mods.taken;
    if (t < (v.dashArmorUntil || 0)) {
      const dash = abilityOf(v.character, 'q');
      if (dash && dash.armor) amount *= dash.armor;
    }
    const dealt = Math.max(1, Math.round(amount));
    v.hp -= dealt;
    v.lastAttackerId = attacker ? attacker.id : 0;

    if (attacker && attacker !== v) {
      attacker.stats.damage += Math.min(dealt, v.hp + dealt);
      this.addUlt(attacker, dealt * RULES.ult.perDamage);
    }
    this.addUlt(v, dealt * RULES.ult.perDamageTaken);
    this.broadcast({
      t: 'dmg', v: v.id, a: attacker ? attacker.id : 0, n: dealt,
      hp: Math.max(0, v.hp), hd: opts.head ? 1 : 0, ab: opts.ability || ''
    });
    if (v.hp <= 0) this.kill(v, attacker, opts);
    return dealt;
  }

  kill(v, attacker, opts = {}) {
    const t = now();
    v.alive = false;
    v.hp = 0;
    v.ultActive = false;
    v.respawnAt = t + this.M.respawn;
    v.stats.deaths++;
    v.hist.length = 0;
    this.domains = this.domains.filter((d) => d.owner !== v);
    if (attacker && attacker !== v) {
      attacker.stats.kills++;
      this.addUlt(attacker, RULES.ult.perKill);
      attacker.killStreak = t - attacker.streakAt < RULES.killStreakWindow ? attacker.killStreak + 1 : 1;
      attacker.streakAt = t;
      attacker.stats.best = Math.max(attacker.stats.best, attacker.killStreak);
      this.scores[attacker.team] = (this.scores[attacker.team] || 0) + 1;
    }
    this.broadcast({
      t: 'kill', v: v.id, a: attacker ? attacker.id : 0, hd: opts.head ? 1 : 0,
      st: attacker ? attacker.killStreak : 0, sc: this.scores
    });
    if (attacker && this.scores[attacker.team] >= this.M.target) this.endMatch(attacker.team, 'score');
  }

  addUlt(p, amount) {
    if (p.ultActive) return;
    const gain = amount * ((p.charm && p.charm.mods.ultGain) || 1);
    p.ult = clamp(p.ult + gain, 0, RULES.ult.max);
  }

  /* ---------------------------------------------------------- match flow */
  startMatch() {
    this.map = this.mapChoice === 'random'
      ? MAP_LIST[(Math.random() * MAP_LIST.length) | 0] : this.mapChoice;
    this.world = worldFor(this.map);
    this.nav = navFor(this.map);
    this.state = 'play';
    this.countdownAt = 0;
    this.scores = {};
    this.domains.length = 0;
    this.reassignTeams();
    let ai = 0, bi = 0, fi = 0;
    for (const p of this.players.values()) {
      this.scores[p.team] = 0;
      p.character = p.pendingCharacter;
      this.resetFighter(p);
      if (p.isBot) p.brain = new ServerBot(this, p, this.botLevel);
      const slot = this.M.ffa ? fi++ : (p.team === 'a' ? ai++ : bi++);
      this.spawn(p, slot, true);
    }
    this.broadcast(this.startMsg());
    this.sendInfo();
  }

  startMsg() {
    return {
      t: 'start', mode: this.mode, map: this.map, target: this.M.target, sc: this.scores,
      ps: [...this.players.values()].map((p) => this.pub(p))
    };
  }

  pub(p) {
    return {
      id: p.id, name: p.name, team: p.team, ch: p.character, bot: !!p.isBot,
      alive: p.alive, hp: p.hp, p: [r2(p.pos.x), r2(p.pos.y), r2(p.pos.z)],
      yaw: r2(p.yaw), sq: p.spawnSeq
    };
  }

  resetFighter(p) {
    const c = CHARACTERS[p.character];
    if (p.pendingCharm) p.charm = p.pendingCharm;
    p.maxHp = Math.round(c.hp * ((p.charm && p.charm.mods.hp) || 1));
    p.radius = c.radius;
    p.alive = false;
    p.hp = 0;
    p.ult = 0;
    p.ultActive = false;
    p.cd = { q: 0, a1: 0, a2: 0, rmb: 0 };
    p.markedUntil = p.slowUntil = p.iframeUntil = p.dashUntil = p.dashArmorUntil = 0;
    p.hist.length = 0;
    p.stats = newStats();
    p.energy = c.energy.max;
  }

  spawnPoint(p, slot) {
    const m = MAPS[this.map];
    const list = this.M.ffa ? m.ffaSpots : (p.team === 'a' ? m.spawnsA : m.spawnsB);
    if (slot !== undefined && slot !== null) return list[slot % list.length];
    let best = list[0], bestScore = -1e9;
    for (const s of list) {
      let score = Math.random() * 6;
      for (const o of this.players.values()) {
        if (!o.alive || o.team === p.team) continue;
        const d = Math.hypot(o.pos.x - s[0], o.pos.z - s[1]);
        score += Math.min(d, 36);
        if (d < 20 && !this.world.segBlocked(s[0], 1.6, s[1], o.pos.x, o.pos.y + 1.1, o.pos.z)) score -= 60;
      }
      if (score > bestScore) { bestScore = score; best = s; }
    }
    return best;
  }

  spawn(p, slot, silent) {
    const s = this.spawnPoint(p, slot);
    const c = CHARACTERS[p.pendingCharacter] ? p.pendingCharacter : p.character;
    p.character = c;
    this.resetFighter(p);
    p.hp = p.maxHp;
    p.alive = true;
    p.height = RULES.standHeight;
    p.pos = { x: s[0], y: this.world.supportAt(s[0], s[1], 60, p.radius), z: s[1] };
    p.vel = { x: 0, y: 0, z: 0 };
    p.yaw = Math.atan2(p.pos.x, p.pos.z);
    p.pitch = 0;
    p.spawnSeq++;
    p.spawnAt = p.lastStateAt = now();
    p.fireCredit = 2;
    if (!silent) this.broadcast(Object.assign({ t: 'spawn' }, this.pub(p)));
  }

  endMatch(winTeam, why) {
    if (this.state !== 'play') return;
    this.state = 'end';
    this.endsAt = now() + 12;
    this.domains.length = 0;
    this.broadcast({
      t: 'end', win: winTeam, why, sc: this.scores,
      stats: [...this.players.values()].map((p) => ({
        id: p.id, name: p.name, ch: p.character, team: p.team, bot: !!p.isBot,
        k: p.stats.kills, d: p.stats.deaths, dmg: Math.round(p.stats.damage),
        s: p.stats.shots, h: p.stats.hits, hs: p.stats.heads
      }))
    });
    this.sendInfo();
  }

  /* ---------------------------------------------------------------- tick */
  tick() {
    const t = now();
    const dt = Math.min(0.25, t - this.lastTick);
    this.lastTick = t;

    if (this.state === 'lobby') {
      if (!this.isPublic) return;
      if (this.humans().length >= 1) {
        if (!this.countdownAt) this.countdownAt = t + (this.humans().length >= 2 ? 6 : 12);
        if (t >= this.countdownAt) { this.startMatch(); return; }
      } else this.countdownAt = 0;
      const cd = this.countdownAt ? Math.ceil(this.countdownAt - t) : 0;
      if (cd !== this.lastCountdown) { this.lastCountdown = cd; this.sendInfo(); }
      return;
    }

    if (this.state === 'end') {
      if (t >= this.endsAt) {
        this.state = 'lobby';
        this.map = null;
        this.lastCountdown = -1;
        this.countdownAt = 0;
        this.sendInfo();
      }
      return;
    }

    for (const p of this.players.values()) {
      if (this.state !== 'play') break;
      if (!p.alive) {
        if (t >= p.respawnAt) this.spawn(p);
        continue;
      }
      if (p.ultActive && t >= p.ultEndsAt) p.ultActive = false;
      this.addUlt(p, dt * RULES.ult.perSecond);
      if (p.isBot && p.brain) p.brain.update(dt, t);
    }
    this.tickDomains(t);
    if (this.state === 'play') this.snapshot(t);
  }

  snapshot(t) {
    const rows = [];
    for (const p of this.players.values()) {
      let f = p.alive ? 1 : 0;
      if (p.crouch || (p.flags & 2)) f |= 2;
      if (p.flags & 4) f |= 4;                       // aiming down sight
      if (p.ultActive) f |= 8;
      if (t < p.markedUntil) f |= 16;
      if (t < p.dashUntil) f |= 32;
      rows.push([p.id, r2(p.pos.x), r2(p.pos.y), r2(p.pos.z), r2(p.yaw), r2(p.pitch),
        r2(p.height), f, Math.max(0, Math.round(p.hp))]);
    }
    const base = { t: 'snap', s: Date.now(), ps: rows };
    for (const p of this.players.values()) {
      if (p.isBot) continue;
      base.u = Math.round(p.ult * 10) / 10;
      base.cd = [r3(Math.max(0, p.cd.q - t)), r3(Math.max(0, p.cd.a1 - t)),
        r3(Math.max(0, p.cd.a2 - t)), r3(Math.max(0, p.cd.rmb - t))];
      p.client.send(JSON.stringify(base));
    }
  }
}

/* ---------------------------------------------------------------- helpers */
function newStats() {
  return { kills: 0, deaths: 0, damage: 0, shots: 0, hits: 0, heads: 0, best: 0 };
}
function dirFrom(yaw, pitch) {
  const cp = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
}
function sanitizeDir(d) {
  if (!Array.isArray(d) || d.length !== 3) return null;
  const x = num(d[0], NaN), y = num(d[1], NaN), z = num(d[2], NaN);
  const l = Math.hypot(x, y, z);
  return Number.isFinite(l) && l > 0.4 ? [r3(x / l), r3(y / l), r3(z / l)] : null;
}
function sanitizePos(p) {
  if (!Array.isArray(p) || p.length !== 3) return null;
  const v = p.map((n) => num(n, NaN));
  return v.every(Number.isFinite) ? v.map(r2) : null;
}
function sanitizeEnds(e) {
  if (!Array.isArray(e)) return [];
  const out = [];
  for (const p of e.slice(0, 4)) {
    const s = sanitizePos(p);
    if (s) out.push(s);
  }
  return out;
}
function specById(character, id) {
  for (const slot of ['lmb', 'rmb', 'q', 'a1', 'a2', 'ult']) {
    const s = abilityOf(character, slot);
    if (s && s.id === id) return s;
  }
  // a summon reports the ability that created it, and only its owner may claim it
  if (id === 'hound') {
    for (const slot of ['a1', 'a2', 'ult']) {
      const s = abilityOf(character, slot);
      const def = s && (s.summon || (s.spawn && s.spawn.dmg ? s.spawn : null));
      if (def) return { id: 'hound', kind: 'summon', dmg: def.dmg, range: 4 };
    }
  }
  return null;
}
function maxDamageOf(spec) {
  const parts = [spec.dmgMax || 0, spec.dmg || 0, (spec.tickDmg || 0) * 2,
    spec.summon ? spec.summon.dmg : 0, spec.spawn ? spec.spawn.dmg : 0];
  let best = Math.max(...parts);
  if (spec.head) best *= spec.head;
  if (spec.comboMul) best *= spec.comboMul;
  if (spec.buff && spec.buff.meleeMul) best *= spec.buff.meleeMul;
  if (spec.inside && spec.inside.enemyTick) best = Math.max(best, spec.inside.enemyTick * 2);
  if (spec.finish) best = Math.max(best, spec.finish.dmg);
  if (spec.splash) best = Math.max(best, spec.splash.dmg);
  return Math.max(12, best);
}
function reachOf(spec) {
  return Math.max(spec.range || 0, spec.radius || 0, spec.dist || 0,
    spec.splash ? spec.splash.radius : 0,
    spec.summon || spec.spawn ? 40 : 0, 6);
}

export { newStats };
