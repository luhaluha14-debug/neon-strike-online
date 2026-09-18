/* =============================================================================
   projectiles: shards, bolts, spirit rounds and the orbs that plant zones.
   they step in small slices so a fast bolt cannot tunnel through a wall or a
   fighter, and the meshes come from a pool so firing never allocates.
   ========================================================================== */
import { clamp } from '../core/math.js';
import { settings } from '../core/settings.js';
import { audio } from '../audio/audio.js';

const THREE = window.THREE;
const MAX_LIVE = 160;

export class ProjectileSystem {
  constructor(game) {
    this.game = game;
    this.list = [];
    this.pool = [];
    this.mats = new Map();
    this.geo = new THREE.SphereGeometry(0.5, 7, 5);
    this.geo.userData.shared = true;
    this.group = new THREE.Group();
    game.engine.scene.add(this.group);
  }

  material(color) {
    let m = this.mats.get(color);
    if (!m) {
      m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 });
      m.userData.shared = true;
      this.mats.set(color, m);
    }
    return m;
  }

  take(color) {
    const mesh = this.pool.pop() || new THREE.Mesh(this.geo, this.material(color));
    mesh.material = this.material(color);
    mesh.visible = true;
    this.group.add(mesh);
    return mesh;
  }
  give(mesh) {
    mesh.visible = false;
    this.group.remove(mesh);
    if (this.pool.length < 80) this.pool.push(mesh);
  }

  spawn(o) {
    if (this.list.length >= MAX_LIVE) this.retire(0, false);
    const f = o.owner;
    const eye = f.eye({});
    const p = {
      owner: f, ownerId: f.id, spec: o.spec, damage: o.damage,
      x: eye.x, y: eye.y, z: eye.z,
      vx: o.dir.x * o.speed, vy: o.dir.y * o.speed, vz: o.dir.z * o.speed,
      speed: o.speed, gravity: o.gravity || 0,
      radius: o.radius || 0.25, life: (o.range || 80) / o.speed + 0.1,
      travelled: 0, range: o.range || 80,
      pierce: o.pierce || 0, hits: null,
      homing: o.homing || 0, homingMarked: o.homingMarked || 0,
      splash: o.splash || null, zone: o.zone || null,
      color: o.color, scale: o.scale || 1, remote: !!o.remote
    };
    if (p.pierce > 0) p.hits = new Set();
    p.mesh = this.take(o.color);
    const s = p.radius * 2.1 * p.scale;
    p.mesh.scale.set(s, s, s * 2.6);
    p.mesh.position.set(p.x, p.y, p.z);
    this.list.push(p);
    return p;
  }

  retire(i, impact = true, hitPoint) {
    const p = this.list[i];
    if (!p) return;
    if (impact) {
      const x = hitPoint ? hitPoint.x : p.x, y = hitPoint ? hitPoint.y : p.y, z = hitPoint ? hitPoint.z : p.z;
      this.game.effects.impact(x, y, z, p.color, p.scale);
      if (p.splash) this.doSplash(p, x, y, z);
      if (p.zone) this.plantZone(p, x, y, z);
      audio.impactAt({ x, y, z }, p.zone ? 'zone' : 'hit');
    }
    this.give(p.mesh);
    this.list.splice(i, 1);
  }

  doSplash(p, x, y, z) {
    const g = this.game;
    const list = g.fightersInSphere(x, y, z, p.splash.radius, p.owner);
    for (const { f: o, dist } of list) {
      const k = clamp(1 - dist / (p.splash.radius + o.radius), 0.25, 1);
      g.damage(o, p.splash.dmg * k, p.owner, { kind: 'splash', ability: p.spec.id });
    }
    g.effects.blast(x, y, z, p.splash.radius, p.color);
  }

  plantZone(p, x, y, z) {
    const w = this.game.world;
    const gy = w.supportAt(x, z, y + 0.6, 0.4);
    this.game.zones.plant(p.owner, p.zone, { x, y: Math.min(y, gy + 0.1), z });
  }

  update(dt) {
    const g = this.game, w = g.world;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      p.life -= dt;
      if (p.life <= 0 || p.travelled > p.range) { this.retire(i, !!p.zone); continue; }

      if (p.homing) this.steer(p, dt);
      if (p.gravity) p.vy -= p.gravity * dt;

      let remaining = dt;
      let hit = false;
      // step in slices no longer than the projectile radius so nothing tunnels
      const stepTime = Math.min(dt, Math.max(0.004, p.radius / Math.max(1, p.speed)));
      while (remaining > 0 && !hit) {
        const t = Math.min(stepTime, remaining);
        remaining -= t;
        const nx = p.x + p.vx * t, ny = p.y + p.vy * t, nz = p.z + p.vz * t;
        const segLen = Math.hypot(nx - p.x, ny - p.y, nz - p.z);
        p.travelled += segLen;
        if (segLen > 1e-5) {
          const dx = (nx - p.x) / segLen, dy = (ny - p.y) / segLen, dz = (nz - p.z) / segLen;
          // fighters first: a bolt that grazes a wall behind a body still counts
          const fh = g.rayFighter(p.x, p.y, p.z, dx, dy, dz, segLen + p.radius, p.owner, {
            enemiesOf: p.owner, fat: p.radius * 0.9, ignoreWalls: true
          });
          if (fh && (!p.hits || !p.hits.has(fh.f.id))) {
            this.onFighterHit(p, fh, i);
            if (p.hits) {
              p.hits.add(fh.f.id);
              if (p.hits.size > p.pierce) { hit = true; break; }
            } else { hit = true; break; }
          }
          const wallT = w.raycast(p.x, p.y, p.z, dx, dy, dz, segLen + p.radius * 0.6);
          if (wallT < segLen + p.radius * 0.6) {
            p.x += dx * Math.max(0, wallT - 0.02);
            p.y += dy * Math.max(0, wallT - 0.02);
            p.z += dz * Math.max(0, wallT - 0.02);
            this.retire(i, true);
            hit = true;
            break;
          }
        }
        p.x = nx; p.y = ny; p.z = nz;
      }
      if (hit) continue;

      p.mesh.position.set(p.x, p.y, p.z);
      p.mesh.lookAt(p.x + p.vx, p.y + p.vy, p.z + p.vz);
      if (settings.preset.particles > 0.5 && (g.engine.frame & 1) === 0) {
        g.effects.trail(p.x, p.y, p.z, p.color, p.scale);
      }
    }
  }

  onFighterHit(p, fh, index) {
    const g = this.game;
    const dealt = g.damage(fh.f, p.damage, p.owner, {
      head: fh.head, headMul: p.spec.head, kind: 'projectile', ability: p.spec.id,
      dist: p.travelled, falloff: p.spec.falloff,
      dir: { x: p.vx / p.speed, z: p.vz / p.speed }
    });
    if (dealt > 0) p.owner.stats.hits++;
    if (p.spec.slow) { fh.f.slowUntil = g.now + p.spec.slow.dur; fh.f.slowMul = p.spec.slow.mul; }
    if (!p.hits || p.hits.size >= p.pierce) this.retire(index, true, fh.point);
    else g.effects.impact(fh.point.x, fh.point.y, fh.point.z, p.color, p.scale * 0.8);
  }

  /* gentle steering toward what the owner is looking at, stronger on a mark */
  steer(p, dt) {
    const g = this.game;
    let best = null, bestDot = 0.965;
    for (const f of g.fighters) {
      if (!f.alive || !g.isEnemy(p.owner, f)) continue;
      const dx = f.pos.x - p.x, dy = f.centerY - p.y, dz = f.pos.z - p.z;
      const d = Math.hypot(dx, dy, dz);
      if (d < 0.6 || d > 60) continue;
      const dot = (dx * p.vx + dy * p.vy + dz * p.vz) / (d * p.speed);
      const marked = g.now < f.markedUntil && f.markedBy === p.ownerId;
      const gate = marked ? 0.9 : bestDot;
      if (dot < gate) continue;
      if (!best || dot > best.dot) best = { f, dx, dy, dz, d, dot, marked };
    }
    if (!best) return;
    const rate = (best.marked ? p.homingMarked : p.homing) * dt;
    const nx = best.dx / best.d, ny = best.dy / best.d, nz = best.dz / best.d;
    p.vx += (nx * p.speed - p.vx) * clamp(rate, 0, 1);
    p.vy += (ny * p.speed - p.vy) * clamp(rate, 0, 1);
    p.vz += (nz * p.speed - p.vz) * clamp(rate, 0, 1);
    const l = Math.hypot(p.vx, p.vy, p.vz) || 1;
    p.vx = p.vx / l * p.speed; p.vy = p.vy / l * p.speed; p.vz = p.vz / l * p.speed;
  }

  dispose() {
    for (const p of this.list) this.give(p.mesh);
    this.list.length = 0;
    this.game.engine.scene.remove(this.group);
    this.pool.length = 0;
  }
}
