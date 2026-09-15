'use strict';
/* =========================================================================
   One room: lobby, match flow and the authoritative combat rules.
   Clients move themselves and report their shots; the server checks every
   claim (range, line of sight against recent positions, rate of fire) and
   owns health, damage, kills, score, respawns and ultimate charge.
   ========================================================================= */
const { maps, HEROES, MODES, HERO_LIST, MODE_LIST, MAP_LIST } = require('./shared');

const STAND_H = 1.8;
const BARRAGE = { dmg: 30, head: 1.8, rpm: 960, range: 120, fo0: 40, fo1: 90, foMin: 0.8, pellets: 1 };
const LAG_WINDOW = 0.4;          // seconds of target history a shot may be judged against
const DIST_TOLERANCE = 3.5;      // metres between claimed and server distance
const AIM_SLACK = 1.4;           // metres a hit may lie off the reported aim line (plus 7% of distance)
const MAX_PLAYERS = 6;

const clamp = (v, a, b) => (v < a ? a : (v > b ? b : v));
const lerp = (a, b, t) => a + (b - a) * t;
const nowS = () => Date.now() / 1000;
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const r2 = (v) => Math.round(v * 100) / 100;

class Room {
  constructor(code, isPublic, mode, mapChoice, onEmpty) {
    this.code = code;
    this.isPublic = isPublic;
    this.mode = mode;
    this.mapChoice = mapChoice;        // a map id or 'random'
    this.onEmpty = onEmpty;
    this.players = new Map();
    this.hostId = 0;
    this.state = 'lobby';              // lobby | play | end
    this.map = null;
    this.ctx = null;
    this.scores = {};
    this.countdownAt = 0;
    this.lastCd = -1;
    this.endAt = 0;
    this.lastTick = nowS();
  }

  get M() { return MODES[this.mode]; }
  capacity() { return this.mode === 'duel' ? 2 : MAX_PLAYERS; }
  isFull() { return this.players.size >= this.capacity(); }

  send(p, obj) { p.client.send(obj); }
  broadcast(obj, exceptId) {
    const s = JSON.stringify(obj);
    for (const p of this.players.values()) if (p.id !== exceptId) p.client.send(s);
  }

  /* ------------------------------------------------------------ lobby */
  info() {
    return {
      t: 'room', code: this.code, pub: this.isPublic, mode: this.mode, map: this.mapChoice,
      cur: this.map, host: this.hostId, state: this.state,
      cd: this.countdownAt ? Math.max(0, Math.ceil(this.countdownAt - nowS())) : 0,
      ps: [...this.players.values()].map((p) => ({ id: p.id, name: p.name, team: p.team, hero: p.pendingHero }))
    };
  }
  sendInfo() { this.broadcast(this.info()); }

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

  addPlayer(client, hero) {
    const h = HERO_LIST.includes(hero) ? hero : 'assault';
    const p = {
      id: client.id, name: client.name, client, hero: h, pendingHero: h, team: null,
      alive: false, hp: 0, maxHp: HEROES[h].hp, pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0,
      height: STAND_H, flags: 0, hist: [], lastStateAt: 0,
      respawnAt: 0, spawnSeq: 0, spawnedAt: 0,
      ult: 0, ultActive: false, ultEnd: 0, odEnd: 0, reconEnd: 0, barrierEnd: 0,
      dashEnd: 0, chargeEnd: 0, chargeHit: null, cdQ: 0, cdS: 0,
      fireCredit: 2, fireAt: 0, streak: 0, streakAt: -99, stats: newStats()
    };
    p.team = this.teamFor(p);
    this.players.set(p.id, p);
    if (!this.hostId) this.hostId = p.id;

    if (this.state === 'play') {
      // join a running match: sit out one second, then spawn like everyone else
      this.resetFighter(p);
      if (!(p.team in this.scores)) this.scores[p.team] = 0;
      p.respawnAt = nowS() + 1;
      this.send(p, this.startMsg());
      this.broadcast({ t: 'joined', p: this.pubPlayer(p) }, p.id);
    }
    this.sendInfo();
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    if (this.hostId === id) this.hostId = this.players.size ? this.players.keys().next().value : 0;
    if (!this.players.size) { this.onEmpty(); return; }
    if (this.state === 'play') {
      this.broadcast({ t: 'left', id });
      if (this.M.ffa) delete this.scores[p.team];
      const teams = new Set([...this.players.values()].map((o) => o.team));
      if (this.players.size < 2 || teams.size < 2) this.endMatch([...teams][0] || null, 'forfeit');
    }
    this.sendInfo();
  }

  onMessage(client, m) {
    const p = this.players.get(client.id);
    if (!p) return;
    switch (m.t) {
      case 'start':
        if (client.id !== this.hostId || this.state !== 'lobby' || this.isPublic) return;
        if (this.players.size < 2) return this.send(p, { t: 'err', m: '2명 이상 모여야 시작할 수 있습니다' });
        this.startMatch();
        break;
      case 'settings':
        if (client.id !== this.hostId || this.state !== 'lobby' || this.isPublic) return;
        if (MODE_LIST.includes(m.mode) && m.mode !== this.mode) {
          if (m.mode === 'duel' && this.players.size > 2) return this.send(p, { t: 'err', m: 'DUEL은 2명까지만 가능합니다' });
          this.mode = m.mode;
          this.reassignTeams();
        }
        if (MAP_LIST.includes(m.map) || m.map === 'random') this.mapChoice = m.map;
        this.sendInfo();
        break;
      case 'hero':
        if (!HERO_LIST.includes(m.hero)) return;
        p.pendingHero = m.hero;
        if (this.state !== 'play') p.hero = m.hero;
        this.sendInfo();
        break;
      case 'st': this.onState(p, m); break;
      case 'fire': this.onFire(p, m); break;
      case 'abil': this.onAbility(p, m); break;
    }
  }

  /* ------------------------------------------------------------ match flow */
  startMatch() {
    this.map = this.mapChoice === 'random' ? MAP_LIST[(Math.random() * MAP_LIST.length) | 0] : this.mapChoice;
    this.ctx = maps[this.map];
    this.state = 'play';
    this.countdownAt = 0;
    this.scores = {};
    this.reassignTeams();
    const A = this.ctx.ARENA;
    let sa = 0, sb = 0, sf = 0;
    for (const p of this.players.values()) {
      this.scores[p.team] = 0;
      p.hero = p.pendingHero;
      this.resetFighter(p);
      const slot = this.M.ffa ? A.ffaSlots[sf++ % A.ffaSlots.length] : (p.team === 'a' ? sa++ : sb++);
      this.spawn(p, slot, true);
    }
    this.broadcast(this.startMsg());
    this.sendInfo();
  }

  startMsg() {
    return {
      t: 'start', mode: this.mode, map: this.map, target: this.M.target, sc: this.scores,
      ps: [...this.players.values()].map((p) => this.pubPlayer(p))
    };
  }

  pubPlayer(p) {
    return {
      id: p.id, name: p.name, team: p.team, hero: p.hero, alive: p.alive, hp: p.hp,
      p: [r2(p.pos.x), r2(p.pos.y), r2(p.pos.z)], yaw: r2(p.yaw), sq: p.spawnSeq
    };
  }

  resetFighter(p) {
    p.stats = newStats();
    p.alive = false; p.hp = 0;
    p.ult = 0; p.ultActive = false; p.ultEnd = 0;
    p.odEnd = p.reconEnd = p.barrierEnd = p.dashEnd = p.chargeEnd = 0;
    p.cdQ = p.cdS = 0;
    p.streak = 0; p.streakAt = -99;
    p.hist = [];
  }

  spawn(p, slot, silent) {
    const A = this.ctx.ARENA;
    const list = this.M.ffa ? A.spawnsA.concat(A.spawnsB) : (p.team === 'a' ? A.spawnsA : A.spawnsB);
    const s = slot !== undefined ? list[slot % list.length] : this.chooseSpawn(p, list);
    p.hero = p.pendingHero;
    p.maxHp = HEROES[p.hero].hp;
    p.hp = p.maxHp;
    p.alive = true;
    p.height = STAND_H;
    p.pos = { x: s[0], y: this.ctx.supportAt(s[0], s[1], 50, 0.36), z: s[1] };
    p.yaw = Math.atan2(p.pos.x, p.pos.z);
    p.pitch = 0;
    p.spawnSeq++;
    p.spawnedAt = p.lastStateAt = nowS();
    p.hist = [];
    p.dashEnd = p.chargeEnd = p.barrierEnd = 0;
    p.fireCredit = 2;
    if (!silent) this.broadcast(Object.assign({ t: 'spawn' }, this.pubPlayer(p)));
  }

  chooseSpawn(p, list) {
    let best = list[0], bestScore = -1e9;
    for (const s of list) {
      let score = Math.random() * 6;
      for (const o of this.players.values()) {
        if (!o.alive || o.team === p.team) continue;
        const d = Math.hypot(o.pos.x - s[0], o.pos.z - s[1]);
        score += Math.min(d, 34) * 0.9;
        if (d < 18 && !this.ctx.segBlocked(s[0], 1.5, s[1], o.pos.x, o.pos.y + 1.5, o.pos.z)) score -= 55;
      }
      if (score > bestScore) { bestScore = score; best = s; }
    }
    return best;
  }

  endMatch(win, why) {
    if (this.state !== 'play') return;
    this.state = 'end';
    this.endAt = nowS() + 10;
    this.broadcast({
      t: 'end', win, why, sc: this.scores,
      stats: [...this.players.values()].map((p) => [p.id, p.stats.kills, p.stats.deaths, Math.round(p.stats.dmg), p.stats.shots, p.stats.hits, p.stats.hs])
    });
    this.sendInfo();
  }

  /* ------------------------------------------------------------ player input */
  onState(p, m) {
    if (this.state !== 'play' || !p.alive || m.sq !== p.spawnSeq || !Array.isArray(m.p) || m.p.length !== 3) return;
    const x = num(m.p[0], NaN), y = num(m.p[1], NaN), z = num(m.p[2], NaN);
    if (!Number.isFinite(x + y + z)) return;
    const A = this.ctx.ARENA, t = nowS();
    const nx = clamp(x, -A.sx, A.sx), ny = clamp(y, 0, 40), nz = clamp(z, -A.sz, A.sz);
    // speed check with room for dashes, blinks, knockback and network stalls
    const allowed = 14 + (t - p.lastStateAt) * 25;
    if (Math.hypot(nx - p.pos.x, nz - p.pos.z) > allowed && t - p.spawnedAt > 0.5) {
      this.send(p, { t: 'pos', p: [r2(p.pos.x), r2(p.pos.y), r2(p.pos.z)], sq: p.spawnSeq });
      return;
    }
    p.pos = { x: nx, y: ny, z: nz };
    p.lastStateAt = t;
    p.yaw = num(m.y);
    p.pitch = clamp(num(m.pi), -1.6, 1.6);
    p.height = clamp(num(m.h, STAND_H), 1.1, STAND_H);
    p.flags = num(m.f) & 6;                       // crouch / aiming bits only
    p.hist.push({ t, x: nx, y: ny, z: nz, h: p.height });
    while (p.hist.length && t - p.hist[0].t > 1) p.hist.shift();
  }

  onFire(p, m) {
    if (this.state !== 'play' || !p.alive) return;
    const t = nowS();
    const barrage = p.ultActive && p.hero === 'assault';
    const w = barrage ? BARRAGE : HEROES[p.hero].w;
    let rate = 60 / w.rpm;
    if (t < p.odEnd) rate /= 1.6;
    // token bucket: tolerates two packets arriving together, rejects a faster weapon
    p.fireCredit = Math.min(2, p.fireCredit + (t - p.fireAt) / rate);
    p.fireAt = t;
    if (p.fireCredit < 0.8) return;
    p.fireCredit -= 1;
    p.stats.shots += w.pellets;

    const ends = [];
    if (Array.isArray(m.e)) {
      for (const e of m.e.slice(0, w.pellets)) {
        if (Array.isArray(e) && e.length === 3 && e.every((v) => Number.isFinite(v))) ends.push(e.map(r2));
      }
    }
    this.broadcast({ t: 'shot', id: p.id, e: ends, u: barrage ? 1 : 0 }, p.id);

    const eye = { x: p.pos.x, y: p.pos.y + p.height - 0.18, z: p.pos.z };
    const aim = unit3(m.d);                    // where the shooter's crosshair pointed
    const byVictim = new Map();
    if (aim && Array.isArray(m.h)) {
      for (const h of m.h.slice(0, w.pellets)) {
        if (!h) continue;
        const v = this.players.get(h.id);
        const dist = num(h.d, -1);
        if (!v || v === p || !v.alive || v.team === p.team || dist < 0 || dist > w.range + 1) continue;
        if (!this.plausible(eye, aim, v, dist)) continue;
        let mult = 1;
        if (dist > w.fo0) mult = lerp(1, w.foMin, clamp((dist - w.fo0) / (w.fo1 - w.fo0), 0, 1));
        const head = !!h.hd;
        const e = byVictim.get(v) || { dmg: 0, head: false };
        e.dmg += w.dmg * mult * (head ? w.head : 1);
        e.head = e.head || head;
        byVictim.set(v, e);
        p.stats.hits++;
      }
    }
    for (const [v, e] of byVictim) {
      const dx = v.pos.x - p.pos.x, dz = v.pos.z - p.pos.z, dl = Math.hypot(dx, dz) || 1;
      if (e.head) p.stats.hs++;
      this.damage(v, e.dmg, p, e.head, dx / dl, dz / dl);
    }
    if (barrage && ends[0] && this.state === 'play') {
      const e = ends[0];
      if (Math.hypot(e[0] - eye.x, e[1] - eye.y, e[2] - eye.z) < w.range + 2) this.explode(e[0], e[1], e[2], 2.6, 22, p);
    }
  }

  /* could the shooter really have seen the target, at that distance, along its aim, recently? */
  plausible(eye, aim, v, dist) {
    const t = nowS();
    const samples = [v.pos];
    for (let i = v.hist.length - 1; i >= 0 && t - v.hist[i].t < LAG_WINDOW; i--) samples.push(v.hist[i]);
    for (const s of samples) {
      const h = s.h || v.height;
      for (const yy of [s.y + h * 0.55, s.y + h - 0.2]) {
        const dx = s.x - eye.x, dy = yy - eye.y, dz = s.z - eye.z;
        const d = Math.hypot(dx, dy, dz);
        if (Math.abs(d - dist) > DIST_TOLERANCE) continue;
        // the target has to sit near the crosshair line: body width, latency and spread slack
        const along = dx * aim[0] + dy * aim[1] + dz * aim[2];
        if (along <= 0) continue;
        if (Math.sqrt(Math.max(0, d * d - along * along)) > AIM_SLACK + d * 0.07) continue;
        if (!this.ctx.segBlocked(eye.x, eye.y, eye.z, s.x, yy, s.z)) return true;
      }
    }
    return false;
  }

  onAbility(p, m) {
    if (this.state !== 'play' || !p.alive) return;
    const t = nowS(), H = HEROES[p.hero];
    const out = { t: 'abil', id: p.id, k: m.k };
    if (m.k === 'q') {
      if (t < p.cdQ - 0.3) return;
      p.cdQ = t + H.q.cd;
      if (p.hero === 'assault') p.dashEnd = t + 0.26;
      else if (p.hero === 'shock') { p.chargeEnd = t + 0.42; p.chargeHit = new Set(); }
    } else if (m.k === 's') {
      if (t < p.cdS - 0.3) return;
      p.cdS = t + H.s.cd;
      if (p.hero === 'assault') p.odEnd = t + H.s.dur;
      else if (p.hero === 'sniper') p.reconEnd = t + H.s.dur;
      else p.barrierEnd = t + H.s.dur;
    } else if (m.k === 'u') {
      if (p.ult < 99.5 || p.ultActive) return;
      p.ult = 0;
      if (p.hero === 'assault') {
        p.ultActive = true; p.ultEnd = t + 4; p.odEnd = Math.max(p.odEnd, t + 4.2);
      } else if (p.hero === 'sniper') {
        const r = this.rail(p, m);
        if (r) { out.o = r.o; out.d = r.d; }
      } else {
        this.shockwave(p);
      }
    } else {
      return;
    }
    this.broadcast(out, p.id);
  }

  /* ------------------------------------------------------------ damage */
  damage(v, dmg, a, head, dirx, dirz) {
    if (!v.alive || this.state !== 'play') return;
    const t = nowS();
    if (t < v.dashEnd) dmg *= 0.5;
    if (t < v.barrierEnd) {
      if (dirx !== undefined) {
        const fx = -Math.sin(v.yaw), fz = -Math.cos(v.yaw);
        dmg *= -(fx * dirx + fz * dirz) > -0.1 ? 0.55 : 0.9;   // 45% from the front, 10% from behind
      } else dmg *= 0.9;
    }
    if (t < a.reconEnd && a.hero === 'sniper') dmg *= 1.18;
    dmg = Math.round(dmg);
    if (dmg <= 0) return;
    v.hp -= dmg;
    a.stats.dmg += Math.min(dmg, v.hp + dmg);
    if (!(a.ultActive && a.hero === 'assault')) this.addUlt(a, dmg * 0.36);
    this.broadcast({ t: 'dmg', v: v.id, a: a.id, n: dmg, hp: Math.max(0, v.hp), hd: head ? 1 : 0 });
    if (v.hp <= 0) this.kill(v, a, head);
  }

  kill(v, a, head) {
    const t = nowS();
    v.alive = false; v.hp = 0;
    v.respawnAt = t + this.M.respawn;
    v.stats.deaths++;
    v.ultActive = false;
    v.odEnd = v.reconEnd = v.barrierEnd = v.dashEnd = v.chargeEnd = 0;
    if (a && a !== v) {
      a.stats.kills++;
      this.addUlt(a, 22);
      this.scores[a.team] = (this.scores[a.team] || 0) + 1;
      a.streak = t - a.streakAt < 4.2 ? a.streak + 1 : 1;
      a.streakAt = t;
    }
    this.broadcast({ t: 'kill', v: v.id, a: a ? a.id : 0, hd: head ? 1 : 0, st: a ? a.streak : 0, sc: this.scores });
    if (a && this.scores[a.team] >= this.M.target) this.endMatch(a.team, 'score');
  }

  addUlt(p, amt) {
    if (p.ultActive) return;
    p.ult = clamp(p.ult + amt, 0, 100);
  }

  explode(x, y, z, radius, dmg, a) {
    for (const o of this.players.values()) {
      if (!o.alive || o.team === a.team) continue;
      const d = Math.hypot(o.pos.x - x, o.pos.y + 0.9 - y, o.pos.z - z);
      if (d > radius) continue;
      this.damage(o, dmg * (0.4 + (1 - d / radius) * 0.6), a, false);
    }
  }

  rail(p, m) {
    if (!Array.isArray(m.d) || m.d.length !== 3) return null;
    let d = m.d.map((v) => num(v));
    const dl = Math.hypot(d[0], d[1], d[2]);
    if (dl < 0.5) return null;
    d = d.map((v) => v / dl);
    const o = [p.pos.x, p.pos.y + p.height - 0.18, p.pos.z];
    const t = nowS();
    p.stats.shots++;
    let hitAny = false;
    for (const v of this.players.values()) {
      if (!v.alive || v.team === p.team) continue;
      const samples = [v.pos].concat(v.hist.filter((s) => t - s.t < 0.3));
      let hit = false, head = false;
      for (const s of samples) {
        const h = s.h || v.height;
        const cx = s.x - o[0], cy = s.y + h * 0.6 - o[1], cz = s.z - o[2];
        const along = cx * d[0] + cy * d[1] + cz * d[2];
        if (along < 0 || along > 140) continue;
        const px = cx - d[0] * along, py = cy - d[1] * along, pz = cz - d[2] * along;
        if (px * px + py * py + pz * pz > 1.16) continue;          // 0.9 m beam + a little latency slack
        hit = true;
        const hy = s.y + h - 0.2 - o[1], th = cx * d[0] + hy * d[1] + cz * d[2];
        const qx = cx - d[0] * th, qy = hy - d[1] * th, qz = cz - d[2] * th;
        head = th > 0 && qx * qx + qy * qy + qz * qz < 0.09;
        break;
      }
      if (!hit) continue;
      hitAny = true;
      this.damage(v, head ? 260 : 190, p, head, d[0], d[2]);
    }
    if (hitAny) p.stats.hits++;
    return { o: o.map(r2), d: d.map((v) => Math.round(v * 1000) / 1000) };
  }

  shockwave(p) {
    const R = 10;
    for (const o of this.players.values()) {
      if (!o.alive || o.team === p.team) continue;
      const dx = o.pos.x - p.pos.x, dz = o.pos.z - p.pos.z, d = Math.hypot(dx, dz);
      if (d > R) continue;
      const k = 1 - d / R;
      this.damage(o, lerp(55, 165, k), p, false);
      if (o.alive) {
        const nx = dx / (d || 1), nz = dz / (d || 1);
        this.send(o, { t: 'knock', v: [r2(nx * (9 + k * 13)), r2(5.5 + k * 3), r2(nz * (9 + k * 13))] });
      }
    }
  }

  chargeTick(p) {
    const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
    for (const o of this.players.values()) {
      if (!o.alive || o.team === p.team || p.chargeHit.has(o.id)) continue;
      if (Math.hypot(o.pos.x - p.pos.x, o.pos.z - p.pos.z) >= 1.9) continue;
      p.chargeHit.add(o.id);
      this.damage(o, 45, p, false, fx, fz);
      if (o.alive) this.send(o, { t: 'knock', v: [r2(fx * 13), 4.5, r2(fz * 13)] });
    }
  }

  /* ------------------------------------------------------------ tick (20 Hz) */
  tick() {
    const t = nowS(), dt = Math.min(0.2, t - this.lastTick);
    this.lastTick = t;

    if (this.state === 'lobby') {
      if (!this.isPublic) return;
      // quick-match rooms start on their own once two people are in
      if (this.players.size >= 2) {
        if (!this.countdownAt) this.countdownAt = t + 8;
        if (t >= this.countdownAt) { this.startMatch(); return; }
      } else this.countdownAt = 0;
      const cd = this.countdownAt ? Math.ceil(this.countdownAt - t) : 0;
      if (cd !== this.lastCd) { this.lastCd = cd; this.sendInfo(); }
      return;
    }
    if (this.state === 'end') {
      if (t >= this.endAt) { this.state = 'lobby'; this.map = null; this.lastCd = -1; this.sendInfo(); }
      return;
    }

    for (const p of this.players.values()) {
      if (this.state !== 'play') break;
      if (!p.alive) { if (t >= p.respawnAt) this.spawn(p); continue; }
      if (p.ultActive && t >= p.ultEnd) p.ultActive = false;
      if (!p.ultActive) this.addUlt(p, dt * 1.5);
      if (t < p.chargeEnd && p.chargeHit) this.chargeTick(p);
    }
    if (this.state === 'play') this.snapshot(t);
  }

  snapshot(t) {
    const rows = [];
    for (const p of this.players.values()) {
      let f = p.alive ? 1 : 0;
      f |= p.flags & 6;
      if (t < p.barrierEnd) f |= 8;
      if (p.ultActive) f |= 16;
      if (t < p.odEnd) f |= 32;
      if (t < p.reconEnd) f |= 64;
      rows.push([p.id, r2(p.pos.x), r2(p.pos.y), r2(p.pos.z), r2(p.yaw), r2(p.pitch), r2(p.height), f, p.hp]);
    }
    const msg = { t: 'snap', s: Date.now(), ps: rows, u: 0 };
    for (const p of this.players.values()) {
      msg.u = Math.floor(p.ult * 10) / 10;           // each client also learns its own ultimate charge
      p.client.send(JSON.stringify(msg));
    }
  }
}

function newStats() {
  return { kills: 0, deaths: 0, dmg: 0, shots: 0, hits: 0, hs: 0 };
}

/* a finite direction from the client, normalised; null when missing or broken */
function unit3(v) {
  if (!Array.isArray(v) || v.length !== 3) return null;
  const x = num(v[0], NaN), y = num(v[1], NaN), z = num(v[2], NaN);
  const L = Math.hypot(x, y, z);
  return Number.isFinite(L) && L > 0.5 ? [x / L, y / L, z / L] : null;
}

module.exports = { Room, HERO_LIST, MODE_LIST, MAP_LIST };
