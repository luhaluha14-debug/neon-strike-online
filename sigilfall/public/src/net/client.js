/* =============================================================================
   the network client.

   the local player is simulated here and reported to the server 20 times a
   second; the server owns health, kills, score and respawns and corrects us.
   other players arrive as snapshots and are drawn ~110 ms in the past, smoothly
   interpolated, so a jittery connection still looks like a fight.
   ========================================================================== */
import { Fighter } from '../combat/fighter.js';
import { abilityOf } from '../characters/roster.js';
import { clamp, lerp, angleDelta } from '../core/math.js';
import { toast } from '../ui/screens.js';

const SEND_HZ = 20;
const INTERP_DELAY = 0.11;      // seconds we deliberately stay behind the server
const MAX_BUFFER = 24;

export class NetClient {
  constructor(app) {
    this.app = app;
    this.ws = null;
    this.selfId = 0;
    this.connected = false;
    this.room = null;
    this.game = null;
    this.handlers = Object.create(null);
    this.sendAcc = 0;
    this.claims = new Map();          // ability id -> [claims]
    this.buffers = new Map();         // fighter id -> snapshot buffer
    this.latency = 0;
    this.charm = app.cfg.charm || 'none';
    this.pingAt = 0;
    this.pingSeq = 0;
    this.lastSnapshotAt = 0;
  }

  /* ------------------------------------------------------------ socket */
  url() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host + '/ws';
  }

  connect() {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let ws;
      try { ws = new WebSocket(this.url()); } catch (e) { return reject(e); }
      this.ws = ws;
      const fail = () => reject(new Error('서버에 연결하지 못했습니다'));
      ws.onopen = () => {
        this.connected = true;
        this.send({ t: 'hello', name: this.app.cfg.playerName });
        this.startPing();
        resolve();
      };
      ws.onerror = () => { if (!this.connected) fail(); };
      ws.onclose = () => {
        this.connected = false;
        this.stopPing();
        this.emit('close');
      };
      ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        this.onMessage(m);
      };
      setTimeout(() => { if (!this.connected) fail(); }, 8000);
    });
  }

  close() {
    this.stopPing();
    try { this.ws?.close(); } catch (e) { /* already closed */ }
    this.connected = false;
  }

  send(obj) {
    if (!this.ws || this.ws.readyState !== 1) return;
    this.ws.send(JSON.stringify(obj));
  }

  on(type, fn) { (this.handlers[type] ||= []).push(fn); return this; }
  emit(type, data) { for (const fn of this.handlers[type] || []) fn(data); }

  startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.pingAt = performance.now();
      this.send({ t: 'ping', c: ++this.pingSeq });
    }, 2000);
  }
  stopPing() { clearInterval(this.pingTimer); }

  /* ------------------------------------------------------------ lobby */
  setName(name) { this.send({ t: 'hello', name }); }
  listRooms() { this.send({ t: 'rooms' }); }
  quick(character, mode) { this.send({ t: 'quick', ch: character, cm: this.charm, mode }); }
  create(mode, map, character) { this.send({ t: 'create', mode, map, ch: character, cm: this.charm }); }
  join(code, character) { this.send({ t: 'join', code, ch: character, cm: this.charm }); }
  leave() { this.send({ t: 'leave' }); this.room = null; }
  setSettings(s) { this.send(Object.assign({ t: 'settings' }, s)); }
  startMatch() { this.send({ t: 'start' }); }
  sendCharacter(ch, charm) {
    if (charm) this.charm = charm;
    this.send({ t: 'char', ch, cm: this.charm });
  }

  /* ----------------------------------------------------------- inbound */
  onMessage(m) {
    switch (m.t) {
      case 'welcome': this.selfId = m.id; break;
      case 'pong': {
        const rtt = performance.now() - this.pingAt;
        this.latency = this.latency ? this.latency * 0.7 + rtt * 0.3 : rtt;
        break;
      }
      case 'rooms': this.emit('rooms', m.list); break;
      case 'room': this.room = m; this.emit('room', m); break;
      case 'err': toast(m.m, 'bad'); this.emit('err', m); break;
      case 'left-room': this.room = null; this.emit('leftRoom'); break;
      case 'start': this.onStart(m); break;
      case 'snap': this.onSnapshot(m); break;
      case 'spawn': this.onSpawn(m); break;
      case 'joined': this.onJoined(m.p); break;
      case 'left': this.onLeft(m.id); break;
      case 'dmg': this.onDamage(m); break;
      case 'kill': this.onKill(m); break;
      case 'shot': this.onShot(m); break;
      case 'abil': this.onAbility(m); break;
      case 'pos': this.onCorrection(m); break;
      case 'end': this.emit('end', m); break;
      default: break;
    }
  }

  /* the server told us the match is on: build the arena and everybody in it */
  onStart(m) {
    this.pendingStart = m;
    this.emit('matchStart', m);
  }

  /* called by the app once the Game exists */
  attach(game, startMsg) {
    this.game = game;
    this.buffers.clear();
    const me = game.player;
    me.id = this.selfId;
    game.byId.delete(me.id);
    game.byId.set(me.id, me);

    for (const p of startMsg.ps) {
      if (p.id === this.selfId) {
        me.team = p.team;
        me.spawnSeq = p.sq;
        me.alive = !!p.alive;
        me.hp = p.hp ?? me.maxHp;
        if (p.p) { me.pos.x = p.p[0]; me.pos.y = p.p[1]; me.pos.z = p.p[2]; }
        me.yaw = p.yaw || 0;
        me.vel.x = me.vel.y = me.vel.z = 0;
        me.spawnAt = game.now;
        if (p.ch && p.ch !== me.charId) me.setCharacter(p.ch);
        continue;
      }
      this.addRemote(p);
    }
    game.scores = Object.assign({}, startMsg.sc);
    game.refreshBodyTints();
    game.hud.buildAbilities();
    game.hud.onSpawn();
    if (me.alive) game.effects.spawnFlash(me);
    document.getElementById('vitName').textContent = me.char.latin;
  }

  addRemote(p) {
    const g = this.game;
    if (!g || g.byId.has(p.id)) return g?.byId.get(p.id);
    const f = new Fighter({
      id: p.id, name: p.name, team: p.team, character: p.ch, isRemote: true
    });
    f.alive = !!p.alive;
    f.hp = p.hp ?? f.maxHp;
    if (p.p) { f.pos.x = p.p[0]; f.pos.y = p.p[1]; f.pos.z = p.p[2]; }
    f.yaw = p.yaw || 0;
    f.spawnSeq = p.sq || 0;
    g.addFighter(f);
    this.buffers.set(f.id, []);
    return f;
  }

  onJoined(p) {
    if (!this.game) return;
    this.addRemote(p);
    this.game.hud.killFeed(null, { name: p.name + ' 입장', isPlayer: false });
  }

  onLeft(id) {
    if (!this.game) return;
    this.game.removeFighter(id);
    this.buffers.delete(id);
  }

  onSnapshot(m) {
    const g = this.game;
    if (!g || !g.active) return;
    const at = performance.now() / 1000;
    this.lastSnapshotAt = at;
    for (const row of m.ps) {
      const [id, x, y, z, yaw, pitch, h, flags, hp] = row;
      const f = g.byId.get(id);
      if (!f) continue;
      if (f === g.player) {
        // the server owns our health and our state flags, not our position
        if (hp !== Math.round(f.hp)) f.hp = hp;
        const alive = (flags & 1) === 1;
        if (!alive && f.alive) { /* the kill message handles the rest */ }
        continue;
      }
      let buf = this.buffers.get(id);
      if (!buf) this.buffers.set(id, buf = []);
      buf.push({ at, x, y, z, yaw, pitch, h, flags, hp });
      if (buf.length > MAX_BUFFER) buf.shift();
      f.hp = hp;
      const alive = (flags & 1) === 1;
      if (alive !== f.alive) {
        f.alive = alive;
        if (!alive && f.mesh) f.mesh.userData.deathT = 1;
      }
      f.crouch = !!(flags & 2);
      f.ads = !!(flags & 4);
      f.ultActive = !!(flags & 8);
      f.markedUntil = (flags & 16) ? g.now + 0.5 : f.markedUntil;
    }
    if (typeof m.u === 'number') g.player.ult = m.u;
    if (Array.isArray(m.cd)) {
      const p = g.player, slots = ['q', 'a1', 'a2', 'rmb'];
      for (let i = 0; i < slots.length; i++) {
        const want = g.now + m.cd[i];
        if (Math.abs(want - p.cd[slots[i]]) > 0.3) p.cd[slots[i]] = want;
      }
    }
  }

  /* draw other players slightly in the past, between two known positions */
  interpolate(f, dt) {
    const buf = this.buffers.get(f.id);
    if (!buf || !buf.length) return;
    const renderAt = performance.now() / 1000 - INTERP_DELAY;
    let a = null, b = null;
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i].at <= renderAt) { a = buf[i]; b = buf[i + 1] || null; break; }
    }
    if (!a) a = buf[0];
    const prevX = f.pos.x, prevZ = f.pos.z;
    if (b) {
      const t = clamp((renderAt - a.at) / Math.max(1e-4, b.at - a.at), 0, 1);
      f.pos.x = lerp(a.x, b.x, t);
      f.pos.y = lerp(a.y, b.y, t);
      f.pos.z = lerp(a.z, b.z, t);
      f.yaw = a.yaw + angleDelta(a.yaw, b.yaw) * t;
      f.pitch = lerp(a.pitch, b.pitch, t);
      f.height = lerp(a.h, b.h, t);
    } else {
      // nothing newer yet: keep walking the last known direction briefly
      const age = clamp(renderAt - a.at, 0, 0.25);
      const prev = buf[buf.length - 2];
      if (prev && a.at > prev.at) {
        const vx = (a.x - prev.x) / (a.at - prev.at);
        const vz = (a.z - prev.z) / (a.at - prev.at);
        f.pos.x = a.x + vx * age;
        f.pos.z = a.z + vz * age;
      } else {
        f.pos.x = a.x; f.pos.z = a.z;
      }
      f.pos.y = a.y;
      f.yaw = a.yaw;
      f.pitch = a.pitch;
      f.height = a.h;
    }
    if (dt > 0) {
      f.vel.x = (f.pos.x - prevX) / dt;
      f.vel.z = (f.pos.z - prevZ) / dt;
    }
    while (buf.length > 2 && buf[1].at < renderAt - 0.6) buf.shift();
  }

  onSpawn(m) {
    const g = this.game;
    if (!g) return;
    const f = g.byId.get(m.id) || this.addRemote(m);
    if (!f) return;
    f.alive = true;
    f.hp = m.hp;
    f.spawnSeq = m.sq;
    if (f.charId !== m.ch) {
      f.setCharacter(m.ch);
      if (f === g.player) {
        g.hud.buildAbilities();
        document.getElementById('vitName').textContent = f.char.latin;
      }
    }
    f.pos.x = m.p[0]; f.pos.y = m.p[1]; f.pos.z = m.p[2];
    f.yaw = m.yaw;
    f.vel.x = f.vel.y = f.vel.z = 0;
    f.resetCombat();
    f.hp = m.hp;
    f.spawnAt = g.now;
    this.buffers.set(f.id, []);
    if (f === g.player) {
      g.hud.onSpawn();
      g.effects.spawnFlash(f);
    } else if (f.mesh) {
      f.mesh.userData.deathT = 0;
    }
  }

  onDamage(m) {
    const g = this.game;
    if (!g) return;
    const v = g.byId.get(m.v), a = g.byId.get(m.a);
    if (!v) return;
    v.hp = m.hp;
    v.lastDamageAt = g.now;
    if (a) v.lastAttackerId = a.id;
    g.effects.hitSpark(v, { head: !!m.hd });
    if (v.mesh) v.mesh.userData.flash = 0.8;
    if (a === g.player && v !== g.player) {
      // our own claims already showed a number; this is the server's verdict
      g.hud.showDamage(v, m.n, !!m.hd);
    }
    if (v === g.player) {
      g.hud.onHurt(a, m.n);
      g.feel.damageShake(m.n / v.maxHp);
    }
  }

  onKill(m) {
    const g = this.game;
    if (!g) return;
    const v = g.byId.get(m.v), a = g.byId.get(m.a);
    g.scores = m.sc;
    if (!v) return;
    v.alive = false;
    v.hp = 0;
    v.stats.deaths++;
    v.deathAt = g.now;
    if (v.mesh) v.mesh.userData.deathT = 1;
    g.effects.deathBurst(v);
    g.domains.closeOf(v, false);
    if (a && a !== v) {
      a.stats.kills++;
      a.killStreak = m.st || 1;
    }
    g.hud.killFeed(a, v);
    if (a === g.player) {
      g.feel.killFlash();
      g.hud.onKill(m.st || 1);
    }
    if (v === g.player) {
      g.hud.onDeath(a);
      g.controller.onDeath();
    }
  }

  onShot(m) {
    const g = this.game;
    if (!g) return;
    const f = g.byId.get(m.id);
    if (!f || f === g.player) return;
    this.faceFrom(f, m.d);
    const spec = f.char.primary;
    g.abilities.execute(f, 'lmb', spec, { dir: m.d ? { x: m.d[0], y: m.d[1], z: m.d[2] } : undefined });
  }

  onAbility(m) {
    const g = this.game;
    if (!g) return;
    const f = g.byId.get(m.id);
    if (!f || f === g.player) return;
    const spec = abilityOf(f.charId, m.s);
    if (!spec) return;
    this.faceFrom(f, m.d);
    if (m.p) { /* the caster reported where the sorcery went off */ }
    g.abilities.execute(f, m.s, spec, {
      dir: m.d ? { x: m.d[0], y: m.d[1], z: m.d[2] } : undefined,
      charge: m.c || undefined
    });
  }

  faceFrom(f, d) {
    if (!d) return;
    f.yaw = Math.atan2(-d[0], -d[2]);
    f.pitch = Math.asin(clamp(d[1], -1, 1));
    f.aim.x = d[0]; f.aim.y = d[1]; f.aim.z = d[2];
  }

  onCorrection(m) {
    const g = this.game;
    if (!g || m.sq !== g.player.spawnSeq) return;
    g.player.pos.x = m.p[0];
    g.player.pos.y = m.p[1];
    g.player.pos.z = m.p[2];
    g.player.vel.x = g.player.vel.z = 0;
  }

  /* ----------------------------------------------------------- outbound */
  update(dt) {
    const g = this.game;
    if (!g || !g.active) return;
    this.flushClaims();
    this.sendAcc += dt;
    const step = 1 / SEND_HZ;
    if (this.sendAcc < step) return;
    this.sendAcc = 0;
    const p = g.player;
    if (!p.alive) return;
    let flags = 1;
    if (p.crouch) flags |= 2;
    if (p.ads) flags |= 4;
    this.send({
      t: 'st', sq: p.spawnSeq,
      p: [r2(p.pos.x), r2(p.pos.y), r2(p.pos.z)],
      y: r2(p.yaw), pi: r2(p.pitch), h: r2(p.height), f: flags,
      e: Math.round(p.energy)
    });
  }

  /* damage we believe we did; the server decides whether it counts */
  claimHit(victim, amount, opts = {}) {
    const g = this.game;
    if (!g) return;
    const ability = opts.ability || g.player.char.primary.id;
    const dist = opts.dist ?? Math.hypot(
      victim.pos.x - g.player.pos.x, victim.centerY - g.player.eyeY, victim.pos.z - g.player.pos.z);
    const list = this.claims.get(ability) || [];
    list.push({ id: victim.id, n: Math.round(amount), hd: opts.head ? 1 : 0, d: r2(dist) });
    this.claims.set(ability, list);
  }

  flushClaims() {
    if (!this.claims.size) return;
    for (const [ability, list] of this.claims) {
      this.send({ t: 'hit', a: ability, h: list.slice(0, 8) });
    }
    this.claims.clear();
  }

  /* our attacks, so everyone else can see and hear them */
  sendAbility(slot, f, spec, opts = {}) {
    if (slot === 'refocus') return this.send({ t: 'abil', s: 'refocus' });
    const d = opts.dir || f.aim;
    const msg = {
      t: slot === 'lmb' ? 'fire' : 'abil',
      s: slot,
      d: [r3(d.x), r3(d.y), r3(d.z)],
      p: [r2(f.pos.x), r2(f.pos.y), r2(f.pos.z)]
    };
    if (opts.charge !== undefined) msg.c = Math.round(opts.charge * 100) / 100;
    if (spec.kind === 'hitscan' || spec.kind === 'melee') {
      msg.e = [[r2(f.pos.x + d.x * (spec.range || 8)), r2(f.eyeY + d.y * (spec.range || 8)),
        r2(f.pos.z + d.z * (spec.range || 8))]];
    }
    this.send(msg);
  }

  get pingMs() { return Math.round(this.latency); }
  get healthy() { return this.connected && (performance.now() / 1000 - this.lastSnapshotAt) < 2; }
}

function r2(v) { return Math.round(v * 100) / 100; }
function r3(v) { return Math.round(v * 1000) / 1000; }

