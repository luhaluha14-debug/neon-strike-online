/* =============================================================================
   domain expansion.  a domain is a short, loud bubble of rules: inside it the
   caster's sorcery changes and everyone else pays for standing there.  the
   rules themselves are data on the character's ult (spec.inside).
   ========================================================================== */
import { clamp } from '../core/math.js';
import { audio } from '../audio/audio.js';

const THREE = window.THREE;
const TICK = 0.5;

export class DomainSystem {
  constructor(game) {
    this.game = game;
    this.list = [];
    this.group = new THREE.Group();
    game.engine.scene.add(this.group);
    this.playerInside = null;
    this.nextId = 1;
  }

  open(owner, spec, opts = {}) {
    const g = this.game;
    // one domain per sorcerer: opening a second closes the first
    this.closeOf(owner, false);
    const d = {
      id: this.nextId++, owner, spec,
      x: opts.x ?? owner.pos.x, y: opts.y ?? owner.pos.y, z: opts.z ?? owner.pos.z,
      radius: spec.radius, endsAt: g.now + spec.dur + (owner.mods.domainDur || 0), nextTick: g.now + 0.3,
      follow: !!spec.follow, born: g.now
    };
    d.mesh = this.makeMesh(spec);
    d.mesh.position.set(d.x, d.y + 0.1, d.z);
    this.group.add(d.mesh);
    this.list.push(d);

    owner.ultActive = true;
    owner.ultEndsAt = d.endsAt;
    owner.domainId = d.id;

    if (spec.spawn) {
      for (let i = 0; i < spec.spawn.count; i++) {
        g.summons.spawn(owner, spec.spawn, {
          angle: (i / spec.spawn.count) * Math.PI * 2, fromDomain: d, abilityId: spec.id
        });
      }
    }
    g.effects.domainOpen(d);
    audio.domainOpen(owner === g.player);
    if (owner === g.player) {
      g.feel.domainPunch();
      g.hud.banner(spec.name, 1.4, spec.latin);
    } else if (g.isEnemy(g.player, owner)) {
      g.hud.banner('적 영역 전개', 1.2, spec.latin);
      g.feel.shake(0.5);
    }
    g.emit('domain', { d, owner });
    return d;
  }

  makeMesh(spec) {
    const g = new THREE.Group();
    const shell = new THREE.Mesh(
      new THREE.SphereGeometry(spec.radius, 22, 16),
      new THREE.MeshBasicMaterial({
        color: spec.color, transparent: true, opacity: 0.14,
        side: THREE.BackSide, depthWrite: false
      })
    );
    g.add(shell);
    const rim = new THREE.Mesh(
      new THREE.SphereGeometry(spec.radius * 0.995, 16, 10),
      new THREE.MeshBasicMaterial({ color: spec.color, wireframe: true, transparent: true, opacity: 0.16, depthWrite: false })
    );
    g.add(rim);
    const floor = new THREE.Mesh(
      new THREE.RingGeometry(spec.radius * 0.82, spec.radius, 40),
      new THREE.MeshBasicMaterial({ color: spec.color, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0.06;
    g.add(floor);
    g.userData = { shell, rim, floor, t: 0 };
    return g;
  }

  contains(d, f) {
    const dx = f.pos.x - d.x, dy = f.centerY - (d.y + 1.2), dz = f.pos.z - d.z;
    return dx * dx + dy * dy + dz * dz <= d.radius * d.radius;
  }

  /* ------------------------------------------------------------ lookups */
  domainFor(f) {
    for (const d of this.list) if (d.owner === f && d.owner.ultActive) return d;
    return null;
  }
  /* the caster's own bonuses, but only while standing in their own domain */
  ownBonus(f) {
    const d = this.domainFor(f);
    if (!d || !this.contains(d, f)) return null;
    return d.spec.inside || null;
  }
  insideEnemyDomain(f) {
    for (const d of this.list) {
      if (!this.game.isEnemy(d.owner, f)) continue;
      if (this.contains(d, f)) return d;
    }
    return null;
  }
  energyLocked(f) {
    const d = this.insideEnemyDomain(f);
    return !!(d && d.spec.inside.enemyEnergyLock);
  }
  damageDealtMul(attacker, opts) {
    const b = this.ownBonus(attacker);
    if (!b) return 1;
    let m = 1;
    if (b.ownDmgMul) m *= b.ownDmgMul;
    if (b.ownMeleeMul && opts && (opts.kind === 'melee' || opts.kind === 'dash')) m *= b.ownMeleeMul;
    return m;
  }
  damageTakenMul() { return 1; }
  onDamageDealt(attacker, dealt) {
    const b = this.ownBonus(attacker);
    if (!b) return;
    const steal = b.lifesteal || b.ownLifesteal || 0;
    if (steal > 0) this.game.heal(attacker, dealt * steal);
  }
  onFighterDeath(f) {
    if (f.ultActive) this.closeOf(f, true);
    for (const d of this.list) if (d.owner === f) d.endsAt = Math.min(d.endsAt, this.game.now + 0.2);
  }

  closeOf(owner, withFinish) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      if (this.list[i].owner === owner) this.close(i, withFinish);
    }
  }

  close(i, withFinish = true) {
    const g = this.game, d = this.list[i];
    if (!d) return;
    if (withFinish && d.spec.finish && d.owner) {
      const fin = d.spec.finish;
      for (const { f: o, dist } of g.fightersInSphere(d.x, d.y + 1.2, d.z, fin.radius, d.owner)) {
        const k = clamp(1 - dist / (fin.radius * 1.35), 0.35, 1);
        g.damage(o, fin.dmg * k, d.owner, { kind: 'domain', ability: d.spec.id });
      }
      g.effects.domainCollapse(d);
      audio.domainClose(d.owner === g.player);
    }
    d.owner.ultActive = false;
    d.owner.domainId = 0;
    this.group.remove(d.mesh);
    this.list.splice(i, 1);
  }

  /* ------------------------------------------------------------ frame */
  update(dt) {
    const g = this.game, now = g.now;
    this.playerInside = null;

    for (let i = this.list.length - 1; i >= 0; i--) {
      const d = this.list[i];
      const spec = d.spec, inside = spec.inside || {};

      if (d.follow && d.owner.alive) {
        d.x = d.owner.pos.x; d.y = d.owner.pos.y; d.z = d.owner.pos.z;
      }
      const grow = clamp((now - d.born) / 0.45, 0, 1);
      const fade = clamp((d.endsAt - now) / 0.45, 0, 1);
      d.mesh.position.set(d.x, d.y + 0.1, d.z);
      d.mesh.scale.setScalar(clamp(grow, 0.04, 1));
      const u = d.mesh.userData;
      u.t += dt;
      // standing inside it, the shell is a tint, not a wall of colour
      const cam = g.engine.camera.position;
      const camIn = Math.hypot(cam.x - d.x, cam.y - (d.y + 1.2), cam.z - d.z) < d.radius;
      u.shell.material.opacity = (camIn ? 0.045 : 0.15) * fade;
      u.rim.material.opacity = ((camIn ? 0.05 : 0.15) + Math.sin(u.t * 3) * 0.03) * fade;
      u.floor.material.opacity = 0.5 * fade;
      u.rim.rotation.y += dt * 0.35;

      // everything standing in it
      for (const f of g.fighters) {
        if (!f.alive) continue;
        const isIn = this.contains(d, f);
        if (!isIn) continue;
        const enemy = g.isEnemy(d.owner, f);
        if (enemy) {
          if (inside.enemySlow) { f.slowUntil = now + 0.25; f.slowMul = inside.enemySlow; }
          if (inside.enemyPull) {
            const dx = d.x - f.pos.x, dz = d.z - f.pos.z;
            const len = Math.hypot(dx, dz) || 1;
            f.pullVec = { x: (dx / len) * inside.enemyPull, z: (dz / len) * inside.enemyPull };
          }
          if (inside.revealEnemies) { f.markedUntil = Math.max(f.markedUntil, now + 0.4); f.markedBy = d.owner.id; }
        } else if (f === d.owner) {
          if (inside.ownSpeedMul) f.addBuff('speed', 0.2, now, inside.ownSpeedMul);
        }
        if (f === g.player) this.playerInside = { d, enemy };
      }

      if (now >= d.nextTick) {
        d.nextTick = now + TICK;
        if (inside.enemyTick) {
          for (const { f: o } of g.fightersInSphere(d.x, d.y + 1.2, d.z, d.radius, d.owner)) {
            g.damage(o, inside.enemyTick * TICK * 2, d.owner, {
              kind: 'domain', ability: spec.id, flinch: false
            });
          }
        }
        g.effects.domainPulse(d);
      }

      if (now >= d.endsAt) this.close(i, true);
    }
  }

  dispose() {
    for (const d of this.list) this.group.remove(d.mesh);
    this.list.length = 0;
    this.game.engine.scene.remove(this.group);
  }
}
