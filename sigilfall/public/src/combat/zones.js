/* =============================================================================
   ground zones: the lure well, the ward stake and the blood rain.  a zone is a
   cylinder that ticks on everyone inside it and can pull, slow or drain.
   ========================================================================== */
import { clamp } from '../core/math.js';

const THREE = window.THREE;
const TICK = 0.5;

export class ZoneSystem {
  constructor(game) {
    this.game = game;
    this.list = [];
    this.group = new THREE.Group();
    game.engine.scene.add(this.group);
  }

  plant(owner, spec, pos) {
    const g = this.game;
    const z = {
      owner, spec, id: spec.id,
      x: pos.x, y: pos.y, z: pos.z,
      radius: spec.radius, endsAt: g.now + spec.dur,
      nextTick: g.now + 0.25, born: g.now
    };
    z.mesh = this.makeMesh(spec);
    z.mesh.position.set(z.x, z.y + 0.04, z.z);
    this.group.add(z.mesh);
    this.list.push(z);
    // the initial hit lands the moment it plants
    if (spec.dmg) {
      for (const { f: o, dist } of g.fightersInSphere(z.x, z.y + 1, z.z, z.radius, owner)) {
        g.damage(o, spec.dmg * clamp(1 - dist / (z.radius * 2), 0.5, 1), owner, { kind: 'zone', ability: spec.id });
      }
    }
    return z;
  }

  makeMesh(spec) {
    const g = new THREE.Group();
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(spec.radius, 28),
      new THREE.MeshBasicMaterial({ color: spec.color, transparent: true, opacity: 0.2, depthWrite: false })
    );
    disc.rotation.x = -Math.PI / 2;
    g.add(disc);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(spec.radius, 0.08, 6, 36),
      new THREE.MeshBasicMaterial({ color: spec.color, transparent: true, opacity: 0.7, depthWrite: false })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.05;
    g.add(ring);
    const pillar = new THREE.Mesh(
      new THREE.CylinderGeometry(spec.radius * 0.96, spec.radius, 2.4, 20, 1, true),
      new THREE.MeshBasicMaterial({
        color: spec.color, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false
      })
    );
    pillar.position.y = 1.2;
    g.add(pillar);
    g.userData = { disc, ring, pillar };
    return g;
  }

  update(dt) {
    const g = this.game, now = g.now;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const z = this.list[i];
      const spec = z.spec;
      const life = clamp((z.endsAt - now) / 0.4, 0, 1);
      z.mesh.userData.ring.rotation.z += dt * (spec.pull ? 2.6 : 0.8);
      z.mesh.userData.pillar.material.opacity = 0.07 * life;
      z.mesh.userData.disc.material.opacity = 0.2 * life;

      const inside = g.fightersInSphere(z.x, z.y + 1, z.z, z.radius, z.owner);
      for (const { f: o, dist } of inside) {
        if (spec.pull) {
          const dx = z.x - o.pos.x, dz = z.z - o.pos.z;
          const d = Math.hypot(dx, dz) || 1;
          o.pullVec = { x: (dx / d) * spec.pull, z: (dz / d) * spec.pull };
        }
        if (spec.slow) { o.slowUntil = now + 0.25; o.slowMul = spec.slow.mul; }
        void dist;
      }

      if (now >= z.nextTick) {
        z.nextTick = now + TICK;
        for (const { f: o } of inside) {
          if (!spec.tickDmg) continue;
          const dealt = g.damage(o, spec.tickDmg * TICK * 2, z.owner, { kind: 'zone', ability: spec.id, flinch: false });
          if (spec.drain && dealt > 0) g.heal(z.owner, dealt * spec.drain);
        }
        if (spec.tickDmg) g.effects.zonePulse(z);
      }

      if (now >= z.endsAt) {
        this.group.remove(z.mesh);
        this.list.splice(i, 1);
      }
    }
  }

  /* bots ask this before walking into something nasty */
  dangerAt(x, z, forFighter) {
    let worst = 0;
    for (const zone of this.list) {
      if (!this.game.isEnemy(forFighter, zone.owner)) continue;
      const d = Math.hypot(zone.x - x, zone.z - z);
      if (d < zone.radius + 1.5) worst = Math.max(worst, (zone.spec.tickDmg || 8) * (1 - d / (zone.radius + 1.5)));
    }
    return worst;
  }

  dispose() {
    for (const z of this.list) this.group.remove(z.mesh);
    this.list.length = 0;
    this.game.engine.scene.remove(this.group);
  }
}
