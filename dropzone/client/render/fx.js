/* =========================================================================
   Pooled visual effects: bullet tracers, muzzle flashes, particles, decals.
   Nothing is allocated per shot -> no GC hitches during fights.
   ========================================================================= */
import * as THREE from 'three';

function glowTexture() {
  const S = 64, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,230,170,0.9)'); gr.addColorStop(1, 'rgba(255,160,60,0)');
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function dotTexture() {
  const S = 32, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.6)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
  return new THREE.CanvasTexture(c);
}

export class FX {
  constructor(scene, q) {
    this.scene = scene;
    this.q = q;
    // ---- tracers ----
    const tg = new THREE.BoxGeometry(1, 1, 1).translate(0, 0, -0.5);
    this.tracerMat = new THREE.MeshBasicMaterial({ color: 0xffdf9a, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    this.tracers = [];
    for (let i = 0; i < 96; i++) {
      const m = new THREE.Mesh(tg, this.tracerMat); m.visible = false; m.frustumCulled = false; m.renderOrder = 8;
      scene.add(m); this.tracers.push(m);
    }
    this.bulletData = new WeakMap();
    // ---- muzzle flashes ----
    const ft = glowTexture();
    this.flashes = [];
    for (let i = 0; i < 16; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: ft, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false }));
      s.visible = false; scene.add(s); this.flashes.push({ s, life: 0 });
    }
    this.flashLight = new THREE.PointLight(0xffc680, 0, 9, 2);
    if (q.effects >= 2) scene.add(this.flashLight);
    this.lightLife = 0;
    // ---- particles (single draw call) ----
    this.PN = q.effects === 0 ? 160 : 600;
    const pg = new THREE.BufferGeometry();
    this.pPos = new Float32Array(this.PN * 3); this.pCol = new Float32Array(this.PN * 3); this.pSize = new Float32Array(this.PN);
    pg.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    pg.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3));
    pg.setAttribute('size', new THREE.BufferAttribute(this.pSize, 1));
    const pm = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, vertexColors: true,
      uniforms: { map: { value: dotTexture() }, scale: { value: 300 } },
      vertexShader: `attribute float size; varying vec3 vC; varying float vA;
        void main(){ vC = color; vA = clamp(size * 4.0, 0.0, 1.0); vec4 mv = modelViewMatrix * vec4(position,1.0);
        gl_PointSize = size * 300.0 / max(0.1, -mv.z); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform sampler2D map; varying vec3 vC; varying float vA;
        void main(){ vec4 t = texture2D(map, gl_PointCoord); if (t.a < 0.05) discard; gl_FragColor = vec4(vC, t.a * vA); }`
    });
    this.points = new THREE.Points(pg, pm);
    this.points.frustumCulled = false;
    this.points.renderOrder = 7;
    scene.add(this.points);
    this.parts = [];
    for (let i = 0; i < this.PN; i++) this.parts.push({ life: 0, max: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, g: 0, s: 0, r: 1, gg: 1, b: 1, grow: 0 });
    this.pi = 0;
    // ---- decals ----
    const dg = new THREE.PlaneGeometry(0.09, 0.09);
    this.decalMat = new THREE.MeshBasicMaterial({ color: 0x151515, transparent: true, opacity: 0.8, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
    this.decals = [];
    for (let i = 0; i < (q.effects ? 80 : 24); i++) { const m = new THREE.Mesh(dg, this.decalMat); m.visible = false; scene.add(m); this.decals.push(m); }
    this.di = 0;
    this.tmpV = new THREE.Vector3(); this.tmpN = new THREE.Vector3(); this.up = new THREE.Vector3(0, 0, 1);
  }

  /** register where a bullet visually starts (muzzle) so tracers leave the gun, not the eye */
  tagBullet(b, mx, my, mz) {
    this.bulletData.set(b, { ox: mx - b.x, oy: my - b.y, oz: mz - b.z });
  }

  renderBullets(bullets, alpha, dt, camPos) {
    let n = 0;
    for (const b of bullets) {
      if (!b.alive || n >= this.tracers.length) continue;
      const d = this.bulletData.get(b);
      const hx = b.x + b.vx * dt * alpha, hy = b.y + b.vy * dt * alpha, hz = b.z + b.vz * dt * alpha;
      const trav = b.dist + Math.hypot(b.vx, b.vy, b.vz) * dt * alpha;
      const k = d ? Math.max(0, 1 - trav / 25) : 0;
      const x = hx + (d ? d.ox * k : 0), y = hy + (d ? d.oy * k : 0), z = hz + (d ? d.oz * k : 0);
      const sp = Math.hypot(b.vx, b.vy, b.vz);
      const len = Math.min(trav, b.pellet ? 1.5 : 5.5);
      if (len < 0.3) continue;
      const m = this.tracers[n++];
      m.visible = true;
      m.position.set(x, y, z);
      this.tmpV.set(x - b.vx / sp, y - b.vy / sp, z - b.vz / sp);
      m.lookAt(this.tmpV);
      m.rotateY(Math.PI);
      const dist = camPos ? Math.hypot(x - camPos.x, y - camPos.y, z - camPos.z) : 10;
      const w = Math.min(0.09, 0.012 + dist * 0.0012);
      m.scale.set(w, w, len);
    }
    for (let i = n; i < this.tracers.length; i++) this.tracers[i].visible = false;
  }

  muzzle(x, y, z, big, local) {
    const f = this.flashes.find((q) => q.life <= 0) || this.flashes[0];
    f.life = 0.05; f.s.visible = true;
    f.s.position.set(x, y, z);
    const sc = (big ? 0.7 : 0.45) * (0.8 + Math.random() * 0.4);
    f.s.scale.set(sc, sc, sc);
    f.s.material.rotation = Math.random() * 6;
    if (this.q.effects >= 2 && (local || Math.random() < 0.5)) { this.flashLight.position.set(x, y, z); this.flashLight.intensity = big ? 30 : 18; this.lightLife = 0.05; }
    if (this.q.effects >= 1) this.emit(x, y, z, 3, 0.8, 0.8, 0.8, 0.6, 0.35, 0.05, 1.5, 0.4, 0.4);
  }

  emit(x, y, z, count, r, g, b, speed, life, size, grav, spread = 1, up = 0.5, grow = 0) {
    const n = this.q.effects === 0 ? Math.ceil(count * 0.4) : count;
    for (let i = 0; i < n; i++) {
      const p = this.parts[this.pi]; this.pi = (this.pi + 1) % this.PN;
      p.life = p.max = life * (0.6 + Math.random() * 0.8);
      p.x = x; p.y = y; p.z = z;
      p.vx = (Math.random() * 2 - 1) * speed * spread; p.vy = (Math.random() * 0.8 + up) * speed; p.vz = (Math.random() * 2 - 1) * speed * spread;
      p.g = grav; p.s = size * (0.7 + Math.random() * 0.6); p.r = r; p.gg = g; p.b = b; p.grow = grow;
    }
  }

  impact(x, y, z, nx, ny, nz, mat) {
    const metal = mat === 'container' || mat === 'rail' || mat === 'car' || mat === 'pillar';
    const wood = mat === 'crate' || mat === 'fence' || mat === 'trunk' || mat === 'hay';
    const soil = mat === 'ground';
    const col = soil ? [0.45, 0.38, 0.28] : wood ? [0.55, 0.43, 0.28] : [0.7, 0.68, 0.64];
    for (let i = 0; i < (this.q.effects ? 7 : 3); i++) {
      const p = this.parts[this.pi]; this.pi = (this.pi + 1) % this.PN;
      p.life = p.max = 0.5 + Math.random() * 0.4;
      p.x = x + nx * 0.05; p.y = y + ny * 0.05; p.z = z + nz * 0.05;
      const s = 1.2 + Math.random() * 2;
      p.vx = nx * s + (Math.random() - 0.5) * 1.5; p.vy = ny * s + Math.random() * 1.2; p.vz = nz * s + (Math.random() - 0.5) * 1.5;
      p.g = 4; p.s = 0.05 + Math.random() * 0.06; p.r = col[0]; p.gg = col[1]; p.b = col[2]; p.grow = 0.25;
    }
    if (metal) this.emit(x + nx * 0.05, y + ny * 0.05, z + nz * 0.05, 5, 1, 0.8, 0.4, 4, 0.2, 0.025, 9, 1, 0.3);
    if (!soil) this.decal(x, y, z, nx, ny, nz);
  }

  blood(x, y, z, dx, dz, head) {
    this.emit(x, y, z, head ? 12 : 7, 0.55, 0.05, 0.04, 2.2, 0.45, head ? 0.08 : 0.06, 7, 1, 0.3, 0.1);
    for (let i = 0; i < 4; i++) {
      const p = this.parts[this.pi]; this.pi = (this.pi + 1) % this.PN;
      p.life = p.max = 0.35; p.x = x; p.y = y; p.z = z;
      p.vx = dx * 3 + (Math.random() - 0.5); p.vy = Math.random(); p.vz = dz * 3 + (Math.random() - 0.5);
      p.g = 6; p.s = 0.07; p.r = 0.45; p.gg = 0.04; p.b = 0.03; p.grow = 0.3;
    }
  }

  dust(x, y, z, amount) {
    this.emit(x, y + 0.05, z, Math.ceil(4 * amount), 0.55, 0.5, 0.42, 1.4, 0.6, 0.12, -0.3, 1.2, 0.1, 0.6);
  }

  decal(x, y, z, nx, ny, nz) {
    const m = this.decals[this.di]; this.di = (this.di + 1) % this.decals.length;
    m.visible = true;
    m.position.set(x + nx * 0.01, y + ny * 0.01, z + nz * 0.01);
    this.tmpN.set(nx, ny, nz);
    m.quaternion.setFromUnitVectors(this.up, this.tmpN);
    m.rotateZ(Math.random() * 6);
    const s = 0.7 + Math.random() * 0.6; m.scale.set(s, s, s);
  }

  update(dt) {
    for (const f of this.flashes) if (f.life > 0) { f.life -= dt; if (f.life <= 0) f.s.visible = false; }
    if (this.lightLife > 0) { this.lightLife -= dt; if (this.lightLife <= 0) this.flashLight.intensity = 0; }
    const P = this.pPos, C = this.pCol, S = this.pSize;
    for (let i = 0; i < this.PN; i++) {
      const p = this.parts[i];
      if (p.life <= 0) { S[i] = 0; continue; }
      p.life -= dt;
      p.vy -= p.g * dt;
      const drag = Math.exp(-2.5 * dt);
      p.vx *= drag; p.vz *= drag;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      p.s += p.grow * dt;
      const t = Math.max(0, p.life / p.max);
      P[i * 3] = p.x; P[i * 3 + 1] = p.y; P[i * 3 + 2] = p.z;
      C[i * 3] = p.r; C[i * 3 + 1] = p.gg; C[i * 3 + 2] = p.b;
      S[i] = p.s * Math.min(1, t * 3);
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true; g.attributes.color.needsUpdate = true; g.attributes.size.needsUpdate = true;
  }
}
