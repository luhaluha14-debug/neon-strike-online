/* =============================================================================
   sorcery that fights on its own: hounds, domain shades and the shade-step
   decoy.  they are simple pursuers, deliberately not as smart as a bot, so
   they pressure rather than replace the player.
   ========================================================================== */
import { clamp, rnd } from '../core/math.js';
import { stepSimple } from './physics.js';
import { audio } from '../audio/audio.js';

const THREE = window.THREE;

export class SummonSystem {
  constructor(game) {
    this.game = game;
    this.list = [];
    this.group = new THREE.Group();
    game.engine.scene.add(this.group);
  }

  spawn(owner, def, opts = {}) {
    const g = this.game;
    const ang = (opts.angle || 0) + owner.yaw + Math.PI;
    const dist = opts.fromDomain ? rnd(2, opts.fromDomain.radius * 0.6) : 1.4;
    const x = owner.pos.x + Math.sin(ang) * dist;
    const z = owner.pos.z + Math.cos(ang) * dist;
    const stationary = !def.speed;
    const s = {
      owner, kind: stationary ? 'turret' : 'hound', team: owner.team,
      abilityId: opts.abilityId || 'hound',
      hp: def.hp, maxHp: def.hp, speed: def.speed, dmg: def.dmg,
      rate: def.rate, range: def.range || 2.2,
      dieAt: g.now + def.dur, nextBite: 0,
      pos: { x, y: g.world.supportAt(x, z, owner.pos.y + 2, 0.34), z },
      vel: { x: 0, y: 0, z: 0 },
      radius: stationary ? 0.45 : 0.34, height: stationary ? 1.25 : 0.9, onGround: true,
      target: null, retargetAt: 0, boost: 1
    };
    s.mesh = stationary ? this.makeTurret(owner) : this.makeHound(owner);
    this.group.add(s.mesh);
    this.list.push(s);
    return s;
  }

  spawnDecoy(owner, def) {
    const g = this.game;
    const s = {
      owner, kind: 'decoy', team: owner.team,
      hp: def.hp, maxHp: def.hp, speed: 0, dmg: 0, rate: 1, range: 0,
      dieAt: g.now + def.dur, nextBite: 0,
      pos: { x: owner.pos.x, y: owner.pos.y, z: owner.pos.z },
      vel: { x: 0, y: 0, z: 0 }, radius: 0.4, height: 1.8, onGround: true,
      yaw: owner.yaw, target: null, retargetAt: 0, boost: 1
    };
    s.mesh = this.makeDecoy(owner);
    this.group.add(s.mesh);
    this.list.push(s);
    return s;
  }

  makeHound(owner) {
    const c = owner.char;
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.42, 0.92),
      new THREE.MeshLambertMaterial({ color: c.trim }));
    body.position.y = 0.5;
    g.add(body);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.34),
      new THREE.MeshLambertMaterial({ color: c.accent }));
    head.position.set(0, 0.62, -0.56);
    g.add(head);
    const eye = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.06, 0.04),
      new THREE.MeshBasicMaterial({ color: 0xffd9a0 }));
    eye.position.set(0, 0.66, -0.73);
    g.add(eye);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.34, 0.11),
          new THREE.MeshLambertMaterial({ color: c.trim }));
        leg.position.set(sx * 0.16, 0.17, sz * 0.3);
        g.add(leg);
      }
    }
    g.userData = { bob: rnd(0, 6) };
    return g;
  }

  /* something bolted together out of whatever was lying around, and left to
     shoot on its own */
  makeTurret(owner) {
    const c = owner.char;
    const g = new THREE.Group();
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.34, 0.62),
      new THREE.MeshLambertMaterial({ color: c.trim }));
    base.position.y = 0.17;
    g.add(base);
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.44, 0.46),
      new THREE.MeshLambertMaterial({ color: c.color }));
    body.position.y = 0.58;
    g.add(body);
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 0.7),
      new THREE.MeshLambertMaterial({ color: c.accent }));
    barrel.position.set(0, 0.62, -0.42);
    g.add(barrel);
    const eye = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.08, 0.05),
      new THREE.MeshBasicMaterial({ color: c.accent }));
    eye.position.set(0, 0.72, -0.24);
    g.add(eye);
    g.userData = { bob: 0, barrel, turret: true };
    return g;
  }

  makeDecoy(owner) {
    const g = new THREE.Group();
    const m = new THREE.MeshBasicMaterial({
      color: owner.char.accent, transparent: true, opacity: 0.4, depthWrite: false
    });
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.1, 0.4), m);
    torso.position.y = 1.15;
    g.add(torso);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.32, 0.32), m);
    head.position.y = 1.86;
    g.add(head);
    g.userData = { bob: 0 };
    return g;
  }

  /* bots shoot decoys, so they need to be findable */
  decoysAgainst(fighter) {
    return this.list.filter((s) => s.kind === 'decoy' && this.game.isEnemy(fighter, s.owner));
  }

  hurt(s, dmg) {
    s.hp -= dmg;
    if (s.hp <= 0) s.dieAt = 0;
  }

  onOwnerDeath(owner) {
    for (const s of this.list) {
      if (s.owner === owner) s.dieAt = Math.min(s.dieAt, this.game.now + 0.4);
    }
  }

  update(dt) {
    const g = this.game, now = g.now;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const s = this.list[i];
      if (now >= s.dieAt) {
        g.effects.impact(s.pos.x, s.pos.y + 0.6, s.pos.z, s.owner.char.accent, 0.8);
        this.group.remove(s.mesh);
        this.list.splice(i, 1);
        continue;
      }
      if (s.kind === 'decoy') {
        s.mesh.position.set(s.pos.x, s.pos.y, s.pos.z);
        s.mesh.rotation.y = s.yaw + Math.PI;
        const fade = clamp((s.dieAt - now) / 0.6, 0, 1);
        s.mesh.children.forEach((c) => { c.material.opacity = 0.4 * fade; });
        continue;
      }

      // hounds pick a target and keep it for a moment so they do not dither
      if (!s.target || !s.target.alive || now > s.retargetAt) {
        s.target = this.pickTarget(s);
        s.retargetAt = now + 1.2;
      }
      const boost = g.domains.ownBonus(s.owner)?.summonBoost || 1;
      if (s.target && s.kind === 'turret') {
        // it cannot chase, so it only fires at what it can actually see
        const dx = s.target.pos.x - s.pos.x, dz = s.target.pos.z - s.pos.z;
        const d = Math.hypot(dx, dz) || 1;
        s.yaw = Math.atan2(-dx, -dz);
        s.vel.x = s.vel.z = 0;
        const eyeY = s.pos.y + 0.7;
        const clear = d <= s.range &&
          !g.world.segBlocked(s.pos.x, eyeY, s.pos.z, s.target.pos.x, s.target.centerY, s.target.pos.z);
        if (clear && now >= s.nextBite) {
          s.nextBite = now + s.rate;
          g.damage(s.target, s.dmg * boost, s.owner, { kind: 'summon', ability: s.abilityId, flinch: false });
          g.effects.beam({ x: s.pos.x, y: eyeY, z: s.pos.z },
            { x: -Math.sin(s.yaw), y: (s.target.centerY - eyeY) / d, z: -Math.cos(s.yaw) },
            d, s.owner.char.accent, 0.3);
          g.effects.impact(s.target.pos.x, s.target.centerY, s.target.pos.z, s.owner.char.accent, 0.7);
          audio.houndBite(s.pos);
        }
      } else if (s.target) {
        const dx = s.target.pos.x - s.pos.x, dz = s.target.pos.z - s.pos.z;
        const d = Math.hypot(dx, dz) || 1;
        const want = s.speed * boost;
        if (d > s.range * 0.8) {
          s.vel.x += ((dx / d) * want - s.vel.x) * clamp(dt * 7, 0, 1);
          s.vel.z += ((dz / d) * want - s.vel.z) * clamp(dt * 7, 0, 1);
          // hop over ledges rather than grinding into them
          if (s.onGround && g.world.blockedAt(s.pos.x + (dx / d) * 0.6, s.pos.z + (dz / d) * 0.6,
            s.radius, s.pos.y, s.pos.y + s.height) > s.pos.y + 0.1) s.vel.y = 6.4;
        } else {
          s.vel.x *= 0.7; s.vel.z *= 0.7;
          if (now >= s.nextBite) {
            s.nextBite = now + s.rate;
            g.damage(s.target, s.dmg * boost, s.owner, { kind: 'summon', ability: s.abilityId, flinch: false });
            g.effects.impact(s.target.pos.x, s.target.centerY, s.target.pos.z, s.owner.char.accent, 0.9);
            audio.houndBite(s.pos);
          }
        }
        s.yaw = Math.atan2(-dx, -dz);
      } else {
        s.vel.x *= 0.9; s.vel.z *= 0.9;
      }
      stepSimple(g.world, s, dt);

      const u = s.mesh.userData;
      u.bob += dt * 9;
      const hop = u.turret ? 0 : Math.abs(Math.sin(u.bob)) * 0.06;
      s.mesh.position.set(s.pos.x, s.pos.y + hop, s.pos.z);
      s.mesh.rotation.y = (s.yaw || 0) + Math.PI;
    }
  }

  pickTarget(s) {
    const g = this.game;
    let best = null, bestScore = -1e9;
    for (const f of g.fighters) {
      if (!f.alive || !g.isEnemy(s.owner, f)) continue;
      const d = Math.hypot(f.pos.x - s.pos.x, f.pos.z - s.pos.z);
      let score = 60 - d;
      if (g.now < f.markedUntil && f.markedBy === s.owner.id) score += 30;
      if (score > bestScore) { bestScore = score; best = f; }
    }
    return best;
  }

  dispose() {
    for (const s of this.list) this.group.remove(s.mesh);
    this.list.length = 0;
    this.game.engine.scene.remove(this.group);
  }
}
