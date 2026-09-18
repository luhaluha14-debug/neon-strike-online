/* =============================================================================
   visual effects.  one additive point cloud carries every spark and trail, and
   a small pool of quads/cylinders carries rings, beams and slashes, so heavy
   fights do not allocate and phones can thin everything out with one setting.
   ========================================================================== */
import { clamp, rnd } from '../core/math.js';
import { settings } from '../core/settings.js';

const THREE = window.THREE;

export class Effects {
  constructor(game) {
    this.game = game;
    this.q = settings.preset.particles;
    this.max = Math.round(900 * clamp(this.q, 0.3, 1));
    this.group = new THREE.Group();
    game.engine.scene.add(this.group);

    // ---- point cloud ----
    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(this.max * 3);
    this.col = new Float32Array(this.max * 3);
    this.siz = new Float32Array(this.max);
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(this.siz, 1));
    this.geo = geo;
    const mat = new THREE.PointsMaterial({
      size: 0.16, vertexColors: true, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.group.add(this.points);
    this.parts = new Array(this.max);
    for (let i = 0; i < this.max; i++) {
      this.parts[i] = { alive: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, max: 1, r: 1, g: 1, b: 1, grav: 1, drag: 1 };
    }
    this.cursor = 0;
    geo.setDrawRange(0, 0);

    // ---- mesh pool ----
    this.quads = [];
    this.active = [];
    this.ringGeo = new THREE.RingGeometry(0.72, 1, 26);
    this.ringGeo.userData.shared = true;
    this.discGeo = new THREE.CircleGeometry(1, 20);
    this.discGeo.userData.shared = true;
    this.cylGeo = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);
    this.cylGeo.userData.shared = true;
    this.sphereGeo = new THREE.SphereGeometry(1, 10, 8);
    this.sphereGeo.userData.shared = true;
  }

  /* ------------------------------------------------------------ particles */
  emit(x, y, z, vx, vy, vz, life, color, size, grav = 1, drag = 1.6) {
    if (this.max === 0) return;
    let p = null;
    for (let i = 0; i < this.max; i++) {
      const idx = (this.cursor + i) % this.max;
      if (!this.parts[idx].alive) { p = this.parts[idx]; this.cursor = (idx + 1) % this.max; break; }
    }
    if (!p) { p = this.parts[this.cursor]; this.cursor = (this.cursor + 1) % this.max; }
    p.alive = true;
    p.x = x; p.y = y; p.z = z;
    p.vx = vx; p.vy = vy; p.vz = vz;
    p.life = p.max = life;
    p.grav = grav; p.drag = drag;
    p.size = size;
    const c = new THREE.Color(color);
    p.r = c.r; p.g = c.g; p.b = c.b;
  }

  burst(x, y, z, color, count, speed, life = 0.45, size = 0.16, grav = 1) {
    const n = Math.max(1, Math.round(count * this.q));
    for (let i = 0; i < n; i++) {
      const th = rnd(0, Math.PI * 2), ph = Math.acos(rnd(-1, 1));
      const s = speed * rnd(0.35, 1);
      this.emit(x, y, z,
        Math.sin(ph) * Math.cos(th) * s, Math.cos(ph) * s * 0.9 + 1.2, Math.sin(ph) * Math.sin(th) * s,
        life * rnd(0.7, 1.25), color, size * rnd(0.7, 1.3), grav);
    }
  }

  /* --------------------------------------------------------------- quads */
  takeQuad(geo, color, opacity, blending = THREE.AdditiveBlending) {
    let q = this.quads.pop();
    if (!q) {
      q = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        transparent: true, depthWrite: false, side: THREE.DoubleSide
      }));
    }
    q.geometry = geo;
    q.material.color.set(color);
    q.material.opacity = opacity;
    q.material.blending = blending;
    q.material.needsUpdate = true;
    q.visible = true;
    q.scale.set(1, 1, 1);
    q.rotation.set(0, 0, 0);
    this.group.add(q);
    return q;
  }
  pushEffect(mesh, life, fn, opacity) {
    this.active.push({ mesh, t: 0, life, fn, o0: opacity });
    return mesh;
  }
  release(e) {
    this.group.remove(e.mesh);
    e.mesh.visible = false;
    if (this.quads.length < 48) this.quads.push(e.mesh);
  }

  /* ============================== effects ============================== */
  muzzle(f, color) {
    if (this.q < 0.4) return;
    const eye = f.eye({}), d = f.aim;
    const x = eye.x + d.x * 0.7, y = eye.y + d.y * 0.7 - 0.12, z = eye.z + d.z * 0.7;
    this.burst(x, y, z, color, 5, 5, 0.14, 0.13, 0.2);
  }

  trail(x, y, z, color, scale) {
    this.emit(x, y, z, rnd(-0.3, 0.3), rnd(-0.2, 0.3), rnd(-0.3, 0.3), 0.22, color, 0.1 * scale, 0.1, 2.4);
  }

  impact(x, y, z, color, scale = 1) {
    this.burst(x, y, z, color, 9 * scale, 5.5 * scale, 0.32, 0.13 * scale, 1.1);
    const ring = this.takeQuad(this.ringGeo, color, 0.75);
    ring.position.set(x, y, z);
    ring.lookAt(this.game.engine.camera.position);
    this.pushEffect(ring, 0.22, (m, k) => {
      m.scale.setScalar(0.3 + k * 1.5 * scale);
      m.material.opacity = 0.75 * (1 - k);
    }, 0.75);
  }

  hitSpark(victim, opts) {
    const color = opts.head ? 0xffd76a : 0xff6b52;
    this.burst(victim.pos.x, victim.centerY, victim.pos.z, color, opts.head ? 12 : 7, 4.5, 0.3, 0.12, 1.3);
  }

  bloodCost(f) {
    this.burst(f.pos.x, f.centerY, f.pos.z, 0xb02744, 8, 3, 0.4, 0.12, 1.6);
  }

  blast(x, y, z, radius, color) {
    const s = this.takeQuad(this.sphereGeo, color, 0.4);
    s.position.set(x, y, z);
    this.pushEffect(s, 0.3, (m, k) => {
      m.scale.setScalar(radius * (0.25 + k * 0.95));
      m.material.opacity = 0.4 * (1 - k);
    }, 0.4);
    this.burst(x, y, z, color, 18, 8, 0.5, 0.17, 1.2);
  }

  beam(eye, dir, len, color, width) {
    const mesh = this.takeQuad(this.cylGeo, color, 0.8);
    mesh.scale.set(width * 0.5, len, width * 0.5);
    const mid = { x: eye.x + dir.x * len / 2, y: eye.y + dir.y * len / 2, z: eye.z + dir.z * len / 2 };
    mesh.position.set(mid.x, mid.y, mid.z);
    mesh.lookAt(eye.x + dir.x * len, eye.y + dir.y * len, eye.z + dir.z * len);
    mesh.rotateX(Math.PI / 2);
    this.pushEffect(mesh, 0.16, (m, k) => {
      m.material.opacity = 0.8 * (1 - k);
      m.scale.x = width * 0.5 * (1 - k * 0.6);
      m.scale.z = m.scale.x;
    }, 0.8);
    for (let i = 0; i < 10 * this.q; i++) {
      const t = rnd(0.1, 1) * len;
      this.emit(eye.x + dir.x * t, eye.y + dir.y * t, eye.z + dir.z * t,
        rnd(-1, 1), rnd(-0.5, 1.5), rnd(-1, 1), 0.3, color, 0.13, 0.4);
    }
  }

  slash(f, dir, spec, heavy) {
    const color = spec.color || f.char.accent;
    const dist = spec.range * 0.55;
    const x = f.pos.x + dir.x * dist, y = f.centerY + 0.15, z = f.pos.z + dir.z * dist;
    const arc = this.takeQuad(this.ringGeo, color, heavy ? 0.85 : 0.6);
    arc.position.set(x, y, z);
    arc.lookAt(f.pos.x, f.centerY, f.pos.z);
    arc.rotation.z = rnd(0, Math.PI);
    this.pushEffect(arc, heavy ? 0.24 : 0.16, (m, k) => {
      m.scale.set(spec.range * (0.6 + k * 0.8), spec.range * (0.6 + k * 0.8) * 0.55, 1);
      m.material.opacity = (heavy ? 0.85 : 0.6) * (1 - k);
    }, 0.8);
    this.burst(x, y, z, color, heavy ? 14 : 7, 5, 0.26, 0.14, 0.7);
  }

  castRing(f, color, dur) {
    const ring = this.takeQuad(this.ringGeo, color, 0.6);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(f.pos.x, f.pos.y + 0.08, f.pos.z);
    const follow = f;
    this.pushEffect(ring, Math.max(0.2, dur), (m, k) => {
      m.position.set(follow.pos.x, follow.pos.y + 0.08, follow.pos.z);
      m.scale.setScalar(1.6 * (1.15 - k * 0.55));
      m.material.opacity = 0.6 * (1 - k * 0.8);
    }, 0.6);
  }

  spawnFlash(f) {
    const ring = this.takeQuad(this.ringGeo, f.char.accent, 0.8);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(f.pos.x, f.pos.y + 0.1, f.pos.z);
    this.pushEffect(ring, 0.5, (m, k) => {
      m.scale.setScalar(0.6 + k * 3.4);
      m.material.opacity = 0.8 * (1 - k);
    }, 0.8);
  }

  deathBurst(f) {
    this.burst(f.pos.x, f.centerY, f.pos.z, f.char.accent, 26, 6.5, 0.7, 0.16, 1.4);
    this.burst(f.pos.x, f.centerY, f.pos.z, 0x8c2b2b, 14, 4, 0.8, 0.14, 1.8);
  }

  blink(from, to, color, height) {
    for (const p of [from, to]) {
      const col = this.takeQuad(this.cylGeo, color, 0.55);
      col.position.set(p.x, p.y + height * 0.5, p.z);
      col.scale.set(0.5, height, 0.5);
      this.pushEffect(col, 0.3, (m, k) => {
        m.material.opacity = 0.55 * (1 - k);
        m.scale.x = m.scale.z = 0.5 * (1 + k * 1.4);
      }, 0.55);
    }
    const steps = Math.round(10 * this.q);
    for (let i = 0; i <= steps; i++) {
      const t = i / Math.max(1, steps);
      this.emit(from.x + (to.x - from.x) * t, from.y + height * 0.5, from.z + (to.z - from.z) * t,
        rnd(-0.6, 0.6), rnd(-0.4, 0.8), rnd(-0.6, 0.6), 0.34, color, 0.14, 0.2);
    }
  }

  dashTrail(f, color, dur) {
    const follow = f;
    const col = this.takeQuad(this.cylGeo, color, 0.35);
    this.pushEffect(col, dur + 0.1, (m, k) => {
      m.position.set(follow.pos.x, follow.pos.y + 0.9, follow.pos.z);
      m.scale.set(0.6, 1.8, 0.6);
      m.material.opacity = 0.35 * (1 - k);
      if ((this.game.engine.frame & 1) === 0) {
        this.emit(follow.pos.x, follow.pos.y + rnd(0.2, 1.6), follow.pos.z,
          rnd(-0.5, 0.5), rnd(0, 0.6), rnd(-0.5, 0.5), 0.3, color, 0.13, 0.15);
      }
    }, 0.35);
  }

  buffAura(f, color, dur) {
    const follow = f;
    const ring = this.takeQuad(this.ringGeo, color, 0.55);
    ring.rotation.x = -Math.PI / 2;
    this.pushEffect(ring, dur, (m, k) => {
      m.position.set(follow.pos.x, follow.pos.y + 0.08 + Math.sin(k * 12) * 0.05, follow.pos.z);
      m.scale.setScalar(1.1);
      m.material.opacity = 0.55 * (1 - k * 0.5);
    }, 0.55);
  }

  summonRing(f, color) {
    const ring = this.takeQuad(this.ringGeo, color, 0.7);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(f.pos.x, f.pos.y + 0.06, f.pos.z);
    this.pushEffect(ring, 0.45, (m, k) => {
      m.scale.setScalar(0.8 + k * 1.8);
      m.material.opacity = 0.7 * (1 - k);
    }, 0.7);
  }

  parryStance(f, color, dur) {
    const follow = f;
    const disc = this.takeQuad(this.discGeo, color, 0.28);
    this.pushEffect(disc, dur, (m, k) => {
      const d = follow.aim;
      m.position.set(follow.pos.x + d.x * 1.1, follow.centerY + d.y * 0.6, follow.pos.z + d.z * 1.1);
      m.lookAt(follow.pos.x, follow.centerY, follow.pos.z);
      m.scale.setScalar(1.15);
      m.material.opacity = 0.28 * (1 - k * 0.5);
    }, 0.28);
  }

  parryFlash(f) {
    this.burst(f.pos.x, f.centerY, f.pos.z, 0xffd08a, 20, 7, 0.4, 0.17, 0.8);
    const ring = this.takeQuad(this.ringGeo, 0xffd08a, 0.9);
    ring.position.set(f.pos.x, f.centerY, f.pos.z);
    ring.lookAt(this.game.engine.camera.position);
    this.pushEffect(ring, 0.3, (m, k) => {
      m.scale.setScalar(0.6 + k * 2.6);
      m.material.opacity = 0.9 * (1 - k);
    }, 0.9);
  }

  markTag(f, dur) {
    const follow = f;
    const ring = this.takeQuad(this.ringGeo, 0xb6ffe2, 0.7);
    this.pushEffect(ring, dur, (m, k) => {
      m.position.set(follow.pos.x, follow.pos.y + follow.height + 0.45, follow.pos.z);
      m.lookAt(this.game.engine.camera.position);
      m.scale.setScalar(0.34);
      m.material.opacity = 0.7 * (1 - k * 0.4) * (follow.alive ? 1 : 0);
    }, 0.7);
  }

  zonePulse(z) {
    const ring = this.takeQuad(this.ringGeo, z.spec.color, 0.5);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(z.x, z.y + 0.1, z.z);
    this.pushEffect(ring, 0.5, (m, k) => {
      m.scale.setScalar(z.radius * (0.35 + k * 0.7));
      m.material.opacity = 0.5 * (1 - k);
    }, 0.5);
  }

  domainOpen(d) {
    const ring = this.takeQuad(this.ringGeo, d.spec.color, 0.95);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(d.x, d.y + 0.12, d.z);
    this.pushEffect(ring, 0.7, (m, k) => {
      m.scale.setScalar(1 + k * d.radius * 1.15);
      m.material.opacity = 0.95 * (1 - k);
    }, 0.95);
    this.burst(d.x, d.y + 1.4, d.z, d.spec.color, 60, 13, 0.9, 0.2, 0.5);
  }

  domainPulse(d) {
    if (this.q < 0.5) return;
    for (let i = 0; i < 8 * this.q; i++) {
      const a = rnd(0, Math.PI * 2), r = rnd(0, d.radius);
      this.emit(d.x + Math.cos(a) * r, d.y + rnd(0.2, 3), d.z + Math.sin(a) * r,
        0, rnd(0.4, 1.6), 0, 0.9, d.spec.color, 0.15, -0.15, 0.8);
    }
  }

  domainCollapse(d) {
    this.burst(d.x, d.y + 1.4, d.z, d.spec.color, 70, 16, 0.8, 0.22, 1.1);
    const s = this.takeQuad(this.sphereGeo, d.spec.color, 0.5);
    s.position.set(d.x, d.y + 1.2, d.z);
    this.pushEffect(s, 0.45, (m, k) => {
      m.scale.setScalar(d.radius * (1 - k * 0.92));
      m.material.opacity = 0.5 * (1 - k * 0.5);
    }, 0.5);
  }

  /* ---------------------------------------------------------------- frame */
  update(dt) {
    // particles
    let n = 0;
    const pos = this.pos, col = this.col, siz = this.siz;
    for (let i = 0; i < this.max; i++) {
      const p = this.parts[i];
      if (!p.alive) continue;
      p.life -= dt;
      if (p.life <= 0) { p.alive = false; continue; }
      p.vy -= 9.5 * p.grav * dt;
      const drag = Math.max(0, 1 - p.drag * dt);
      p.vx *= drag; p.vz *= drag; p.vy *= drag;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      const k = p.life / p.max;
      pos[n * 3] = p.x; pos[n * 3 + 1] = p.y; pos[n * 3 + 2] = p.z;
      col[n * 3] = p.r * k; col[n * 3 + 1] = p.g * k; col[n * 3 + 2] = p.b * k;
      siz[n] = p.size * (0.4 + k * 0.6);
      n++;
    }
    this.geo.setDrawRange(0, n);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
    this.geo.attributes.size.needsUpdate = true;
    if (n > 0) this.geo.computeBoundingSphere?.();

    // quads
    for (let i = this.active.length - 1; i >= 0; i--) {
      const e = this.active[i];
      e.t += dt;
      const k = clamp(e.t / e.life, 0, 1);
      e.fn(e.mesh, k);
      if (k >= 1) { this.release(e); this.active.splice(i, 1); }
    }
  }

  dispose() {
    for (const e of this.active) this.release(e);
    this.active.length = 0;
    this.game.engine.scene.remove(this.group);
    this.quads.length = 0;
  }
}
