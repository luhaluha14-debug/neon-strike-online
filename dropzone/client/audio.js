/* =========================================================================
   Procedural audio (Web Audio synthesis, no asset files).
   Gunshots are spatialised by distance and direction:
     - volume falls with distance, a low-pass filter darkens far shots
     - sound arrives late (343 m/s), so you hear the crack after the flash
     - stereo pan from the listener's right vector
   ========================================================================= */

const SPEED_OF_SOUND = 343;

export class Audio {
  constructor() { this.ctx = null; this.ready = false; this.listener = { x: 0, y: 0, z: 0, rx: 1, rz: 0, fx: 0, fz: -1 }; this.volume = 0.7; }

  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try { this.ctx = new AC(); } catch { return; }
    const c = this.ctx;
    this.master = c.createGain(); this.master.gain.value = this.volume;
    this.comp = c.createDynamicsCompressor();
    this.comp.threshold.value = -12; this.comp.knee.value = 12; this.comp.ratio.value = 4; this.comp.attack.value = 0.004; this.comp.release.value = 0.25;
    this.master.connect(this.comp); this.comp.connect(c.destination);
    const len = c.sampleRate * 2, b = c.createBuffer(1, len, c.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = b;
    this.ready = true;
    this.startAmbience();
  }

  setVolume(v) { this.volume = v; if (this.master) this.master.gain.value = v; }
  setListener(x, y, z, yaw) {
    const L = this.listener;
    L.x = x; L.y = y; L.z = z;
    L.rx = Math.cos(yaw); L.rz = -Math.sin(yaw);
    L.fx = -Math.sin(yaw); L.fz = -Math.cos(yaw);
  }
  t() { return this.ctx.currentTime; }

  /** output chain for a positioned sound.  returns {dest, v, delay, far} or null if inaudible */
  spatial(pos, range = 60, opts = {}) {
    const c = this.ctx, L = this.listener;
    if (!pos) return { dest: this.master, v: 1, delay: 0, far: 0, d: 0 };
    const dx = pos.x - L.x, dy = pos.y - L.y, dz = pos.z - L.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > range) return null;
    const v = Math.min(1, 1 / (1 + d / (opts.ref || 8))) * Math.max(0, 1 - d / range);
    if (v < 0.004) return null;
    const pan = d > 0.5 ? Math.max(-1, Math.min(1, (L.rx * dx + L.rz * dz) / d)) * 0.8 : 0;
    const behind = d > 0.5 ? (L.fx * dx + L.fz * dz) / d < -0.3 : false;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.max(500, 17000 * Math.exp(-d / (opts.muffle || 110))) * (behind ? 0.6 : 1);
    let node = lp;
    if (c.createStereoPanner) { const p = c.createStereoPanner(); p.pan.value = pan; lp.connect(p); node = p; }
    node.connect(this.master);
    return { dest: lp, v, delay: d > 25 ? d / SPEED_OF_SOUND : 0, far: Math.min(1, d / 200), d };
  }

  env(t0, peak, atk, dec, dest) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + atk + dec);
    g.connect(dest);
    return g;
  }
  noise(o) {
    const c = this.ctx, t0 = o.t;
    const s = c.createBufferSource(); s.buffer = this.noiseBuf; s.playbackRate.value = o.rate || 1;
    const f = c.createBiquadFilter(); f.type = o.type || 'lowpass';
    f.frequency.setValueAtTime(o.f0, t0);
    if (o.f1) f.frequency.exponentialRampToValueAtTime(Math.max(40, o.f1), t0 + o.dur);
    f.Q.value = o.q === undefined ? 1 : o.q;
    const g = this.env(t0, o.vol, o.atk === undefined ? 0.003 : o.atk, o.dec, o.dest || this.master);
    s.connect(f); f.connect(g);
    s.start(t0, Math.random() * Math.max(0, 1.9 - o.dur)); s.stop(t0 + o.dur + 0.05);
  }
  tone(o) {
    const c = this.ctx, t0 = o.t;
    const s = c.createOscillator(); s.type = o.type || 'sine';
    s.frequency.setValueAtTime(o.f0, t0);
    if (o.f1) s.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t0 + o.dur);
    const g = this.env(t0, o.vol, o.atk === undefined ? 0.004 : o.atk, o.dec, o.dest || this.master);
    s.connect(g); s.start(t0); s.stop(t0 + o.dur + 0.05);
  }
  budget() {
    const n = (this.ctx.currentTime * 10) | 0;
    if (this._bt !== n) { this._bt = n; this._bc = 0; }
    return ++this._bc < 14;
  }

  /* ---------------- weapons ---------------- */
  gunshot(kind, pos, local) {
    if (!this.ready) return;
    if (!local && !this.budget()) return;
    const sp = local ? { dest: this.master, v: 1, delay: 0, far: 0 } : this.spatial(pos, 600, { ref: 14, muffle: 140 });
    if (!sp) return;
    const t = this.t() + sp.delay, d = sp.dest, v = sp.v * (local ? 0.9 : 1.3), r = 0.94 + Math.random() * 0.12;
    const far = sp.far;
    const P = {
      rifle: { crack: 4400, body: 6000, sub: 210, tail: 0.36, vol: 1.2 },
      smg: { crack: 5200, body: 7000, sub: 260, tail: 0.24, vol: 0.95 },
      pistol: { crack: 4800, body: 5200, sub: 240, tail: 0.22, vol: 0.9 },
      shotgun: { crack: 3200, body: 4200, sub: 120, tail: 0.55, vol: 1.4 },
      punch: null
    }[kind];
    if (!P) { this.punch(pos, local); return; }
    if (far < 0.6) {
      this.noise({ t, dur: 0.025, type: 'highpass', f0: P.crack * r, q: 0.7, vol: 0.6 * v * (1 - far), atk: 0.0008, dec: 0.02, dest: d });
      this.noise({ t, dur: 0.16, type: 'lowpass', f0: P.body * r, f1: 350, q: 1.5, vol: P.vol * v, atk: 0.0012, dec: 0.15, dest: d });
    }
    this.tone({ t, dur: 0.16, type: 'sine', f0: P.sub * r, f1: 45, vol: 0.9 * v, atk: 0.001, dec: 0.15, dest: d });
    this.tone({ t, dur: 0.1, type: 'square', f0: P.sub * 0.7 * r, f1: 38, vol: 0.35 * v, atk: 0.001, dec: 0.09, dest: d });
    // environment tail: longer and darker with distance (distance cue)
    this.noise({ t: t + 0.015, dur: P.tail + far * 0.9, type: 'bandpass', f0: 1100 * (1 - far * 0.6), f1: 180, q: 0.6, vol: (0.28 + far * 0.4) * v, dec: P.tail + far * 0.85, dest: d });
    if (local && kind !== 'shotgun') this.noise({ t: t + 0.03, dur: 0.05, type: 'bandpass', f0: 2600, q: 4, vol: 0.12, dec: 0.045, dest: d });
  }
  punch(pos, local) {
    const sp = local ? { dest: this.master, v: 1, delay: 0 } : this.spatial(pos, 25);
    if (!sp) return;
    const t = this.t();
    this.noise({ t, dur: 0.08, type: 'lowpass', f0: 900, f1: 200, vol: 0.5 * sp.v, dec: 0.07, dest: sp.dest });
  }
  reload(pos, local, stage) {
    if (!this.ready) return;
    const sp = local ? { dest: this.master, v: 0.8 } : this.spatial(pos, 25, { ref: 3 });
    if (!sp) return;
    const t = this.t(), d = sp.dest, v = sp.v * 0.8;
    if (stage === 0) {
      this.noise({ t, dur: 0.06, type: 'bandpass', f0: 2100, q: 3, vol: 0.35 * v, dec: 0.05, dest: d });
      this.tone({ t: t + 0.01, dur: 0.06, type: 'square', f0: 420, f1: 180, vol: 0.12 * v, dec: 0.05, dest: d });
    } else if (stage === 1) {
      this.noise({ t, dur: 0.08, type: 'bandpass', f0: 1500, q: 2.2, vol: 0.4 * v, dec: 0.07, dest: d });
      this.tone({ t, dur: 0.09, type: 'square', f0: 240, f1: 90, vol: 0.18 * v, dec: 0.08, dest: d });
    } else {
      this.noise({ t, dur: 0.05, type: 'bandpass', f0: 3200, q: 5, vol: 0.3 * v, dec: 0.04, dest: d });
      this.noise({ t: t + 0.07, dur: 0.05, type: 'bandpass', f0: 2400, q: 5, vol: 0.3 * v, dec: 0.04, dest: d });
    }
  }
  shell(pos, local) {
    if (!this.ready) return;
    const sp = local ? { dest: this.master, v: 0.5 } : this.spatial(pos, 14, { ref: 2 });
    if (!sp) return;
    const t = this.t() + 0.25 + Math.random() * 0.15;
    this.tone({ t, dur: 0.04, type: 'triangle', f0: 5200 + Math.random() * 900, vol: 0.06 * sp.v, dec: 0.035, dest: sp.dest });
    this.tone({ t: t + 0.07, dur: 0.03, type: 'triangle', f0: 4800 + Math.random() * 900, vol: 0.04 * sp.v, dec: 0.025, dest: sp.dest });
  }
  dry() { if (!this.ready) return; const t = this.t(); this.noise({ t, dur: 0.04, type: 'highpass', f0: 3000, q: 2, vol: 0.22, dec: 0.035 }); this.tone({ t, dur: 0.04, type: 'square', f0: 700, f1: 300, vol: 0.08, dec: 0.035 }); }
  whiz(pos) {
    if (!this.ready) return;
    const sp = this.spatial(pos, 12, { ref: 3 }); if (!sp) return;
    const t = this.t();
    this.noise({ t, dur: 0.12, type: 'bandpass', f0: 3800, f1: 1600, q: 6, vol: 0.35 * sp.v, atk: 0.01, dec: 0.1, dest: sp.dest });
  }
  impact(pos, mat) {
    if (!this.ready || !this.budget()) return;
    const sp = this.spatial(pos, 35, { ref: 3 }); if (!sp) return;
    const t = this.t(), metal = mat === 'container' || mat === 'car' || mat === 'rail' || mat === 'pillar';
    if (metal) this.tone({ t, dur: 0.12, type: 'triangle', f0: 1800 + Math.random() * 800, f1: 900, vol: 0.18 * sp.v, dec: 0.1, dest: sp.dest });
    this.noise({ t, dur: 0.05, type: 'bandpass', f0: mat === 'ground' ? 700 : 1600, q: 1.5, vol: 0.3 * sp.v, dec: 0.045, dest: sp.dest });
  }

  /* ---------------- player ---------------- */
  footstep(pos, local, speed, surface) {
    if (!this.ready) return;
    const sp = local ? { dest: this.master, v: 0.35 } : this.spatial(pos, 38, { ref: 4, muffle: 60 });
    if (!sp) return;
    const t = this.t(), v = sp.v * Math.min(1.3, 0.4 + speed / 6), hard = surface === 'hard';
    this.noise({ t, dur: 0.07, type: 'lowpass', f0: hard ? 1400 : 700, f1: 200, q: 0.8, vol: 0.45 * v, dec: 0.06, dest: sp.dest });
    this.tone({ t, dur: 0.05, type: 'sine', f0: hard ? 140 : 90, f1: 50, vol: 0.3 * v, dec: 0.045, dest: sp.dest });
    if (!hard) this.noise({ t: t + 0.01, dur: 0.08, type: 'highpass', f0: 3000, q: 0.5, vol: 0.06 * v, dec: 0.07, dest: sp.dest });
  }
  land(pos, local, v) {
    if (!this.ready) return;
    const sp = local ? { dest: this.master, v: 0.6 } : this.spatial(pos, 30); if (!sp) return;
    const t = this.t(), k = Math.min(1.5, v / 8);
    this.noise({ t, dur: 0.12, type: 'lowpass', f0: 600, f1: 120, vol: 0.5 * k * sp.v, dec: 0.1, dest: sp.dest });
    this.tone({ t, dur: 0.1, type: 'sine', f0: 110, f1: 40, vol: 0.4 * k * sp.v, dec: 0.09, dest: sp.dest });
  }
  hitmark(head, kill) {
    if (!this.ready) return;
    const t = this.t();
    if (kill) { this.tone({ t, dur: 0.12, type: 'triangle', f0: 880, vol: 0.2, dec: 0.1 }); this.tone({ t: t + 0.08, dur: 0.18, type: 'triangle', f0: 1320, vol: 0.2, dec: 0.16 }); return; }
    if (head) { this.tone({ t, dur: 0.12, type: 'sine', f0: 2400, vol: 0.18, dec: 0.1 }); this.tone({ t, dur: 0.08, type: 'triangle', f0: 3600, vol: 0.08, dec: 0.07 }); return; }
    this.noise({ t, dur: 0.03, type: 'bandpass', f0: 2600, q: 3, vol: 0.35, dec: 0.025 });
  }
  hurt() { if (!this.ready) return; const t = this.t(); this.noise({ t, dur: 0.12, type: 'lowpass', f0: 800, f1: 200, vol: 0.4, dec: 0.1 }); this.tone({ t, dur: 0.1, type: 'sine', f0: 160, f1: 70, vol: 0.3, dec: 0.09 }); }
  pickup() { if (!this.ready) return; const t = this.t(); this.noise({ t, dur: 0.05, type: 'bandpass', f0: 1800, q: 2, vol: 0.25, dec: 0.045 }); this.tone({ t: t + 0.02, dur: 0.05, type: 'triangle', f0: 900, vol: 0.08, dec: 0.04 }); }
  heal() { if (!this.ready) return; const t = this.t(); this.tone({ t, dur: 0.2, type: 'sine', f0: 520, f1: 780, vol: 0.12, dec: 0.18 }); }
  ui(kind) {
    if (!this.ready) return;
    const t = this.t();
    if (kind === 'zone') { this.tone({ t, dur: 0.5, type: 'sawtooth', f0: 220, f1: 330, vol: 0.06, atk: 0.05, dec: 0.4 }); this.tone({ t: t + 0.5, dur: 0.5, type: 'sawtooth', f0: 220, f1: 330, vol: 0.06, atk: 0.05, dec: 0.4 }); return; }
    if (kind === 'deny') { this.tone({ t, dur: 0.08, type: 'square', f0: 180, vol: 0.06, dec: 0.07 }); return; }
    this.tone({ t, dur: 0.04, type: 'triangle', f0: 1200, vol: 0.06, dec: 0.035 });
  }
  win() { if (!this.ready) return; const t = this.t(); [523, 659, 784, 1046].forEach((f, i) => this.tone({ t: t + i * 0.12, dur: 0.4, type: 'triangle', f0: f, vol: 0.14, dec: 0.36 })); }
  lose() { if (!this.ready) return; const t = this.t(); [392, 330, 262].forEach((f, i) => this.tone({ t: t + i * 0.16, dur: 0.4, type: 'triangle', f0: f, vol: 0.12, dec: 0.36 })); }

  /* ---------------- throwables ---------------- */
  explosion(pos) {
    if (!this.ready) return;
    const sp = this.spatial(pos, 700, { ref: 18, muffle: 220 }); if (!sp) return;
    const t = this.t() + sp.delay, d = sp.dest, v = Math.min(1.4, sp.v * 1.6);
    this.noise({ t, dur: 0.05, type: 'highpass', f0: 2500, q: 0.5, vol: 0.8 * v * (1 - sp.far), atk: 0.001, dec: 0.04, dest: d });
    this.noise({ t, dur: 1.1, type: 'lowpass', f0: 3000, f1: 90, q: 0.9, vol: 1.5 * v, atk: 0.002, dec: 1.05, dest: d });
    this.tone({ t, dur: 0.9, type: 'sine', f0: 90, f1: 22, vol: 1.3 * v, atk: 0.002, dec: 0.85, dest: d });
    this.noise({ t: t + 0.08, dur: 1.6, type: 'bandpass', f0: 400, f1: 90, q: 0.5, vol: 0.45 * v, dec: 1.5, dest: d });
  }
  flashBang(pos) {
    if (!this.ready) return;
    const sp = this.spatial(pos, 300, { ref: 14 }); if (!sp) return;
    const t = this.t() + sp.delay, d = sp.dest, v = Math.min(1.3, sp.v * 1.5);
    this.noise({ t, dur: 0.18, type: 'highpass', f0: 1800, q: 0.4, vol: 1.2 * v, atk: 0.001, dec: 0.16, dest: d });
    this.tone({ t, dur: 0.3, type: 'square', f0: 180, f1: 60, vol: 0.5 * v, dec: 0.28, dest: d });
  }
  ringing(amount) {
    if (!this.ready) return;
    const t = this.t();
    this.tone({ t, dur: amount, type: 'sine', f0: 3150, vol: 0.1, atk: 0.05, dec: amount - 0.05 });
  }
  smokePop(pos) {
    if (!this.ready) return;
    const sp = this.spatial(pos, 60, { ref: 6 }); if (!sp) return;
    const t = this.t();
    this.noise({ t, dur: 2.5, type: 'bandpass', f0: 3200, f1: 1200, q: 0.8, vol: 0.28 * sp.v, atk: 0.05, dec: 2.4, dest: sp.dest });
  }
  fireBurst(pos) {
    if (!this.ready) return;
    const sp = this.spatial(pos, 80, { ref: 6 }); if (!sp) return;
    const t = this.t();
    this.noise({ t, dur: 0.1, type: 'highpass', f0: 3000, vol: 0.4 * sp.v, dec: 0.08, dest: sp.dest });           // glass
    this.noise({ t, dur: 0.9, type: 'lowpass', f0: 1400, f1: 300, vol: 0.6 * sp.v, atk: 0.02, dec: 0.85, dest: sp.dest });
  }
  crackle(pos) {
    if (!this.ready || !this.budget()) return;
    const sp = this.spatial(pos, 40, { ref: 4 }); if (!sp) return;
    this.noise({ t: this.t(), dur: 0.05, type: 'bandpass', f0: 1800 + Math.random() * 2000, q: 3, vol: 0.2 * sp.v, dec: 0.045, dest: sp.dest });
  }
  clink(pos) {
    if (!this.ready || !this.budget()) return;
    const sp = this.spatial(pos, 35, { ref: 3 }); if (!sp) return;
    this.tone({ t: this.t(), dur: 0.06, type: 'triangle', f0: 1900 + Math.random() * 700, vol: 0.12 * sp.v, dec: 0.05, dest: sp.dest });
  }
  throwWhoosh(pos, local) {
    if (!this.ready) return;
    const sp = local ? { dest: this.master, v: 0.5 } : this.spatial(pos, 25, { ref: 3 }); if (!sp) return;
    const t = this.t();
    this.tone({ t, dur: 0.05, type: 'square', f0: 2600, vol: 0.05 * sp.v, dec: 0.04, dest: sp.dest });          // pin
    this.noise({ t: t + 0.05, dur: 0.25, type: 'bandpass', f0: 700, f1: 1800, q: 1, vol: 0.3 * sp.v, atk: 0.04, dec: 0.2, dest: sp.dest });
  }

  /* ---------------- vehicles ---------------- */
  /** up to 4 engine voices for the nearest running vehicles: [{pos, speed, local, moto}] */
  setEngines(list) {
    if (!this.ready) return;
    const c = this.ctx, t = this.t();
    if (!this.engines) {
      this.engines = [];
      for (let i = 0; i < 4; i++) {
        const g = c.createGain(); g.gain.value = 0;
        const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
        const pan = c.createStereoPanner ? c.createStereoPanner() : null;
        lp.connect(g); if (pan) { g.connect(pan); pan.connect(this.master); } else g.connect(this.master);
        const o1 = c.createOscillator(); o1.type = 'sawtooth'; const o2 = c.createOscillator(); o2.type = 'square';
        const g1 = c.createGain(); g1.gain.value = 0.25; const g2 = c.createGain(); g2.gain.value = 0.12;
        o1.connect(g1); o2.connect(g2); g1.connect(lp); g2.connect(lp); o1.start(); o2.start();
        this.engines.push({ g, lp, pan, o1, o2 });
      }
    }
    const L = this.listener;
    for (let i = 0; i < 4; i++) {
      const e = this.engines[i], s = list[i];
      if (!s) { e.g.gain.setTargetAtTime(0, t, 0.15); continue; }
      const dx = s.pos.x - L.x, dz = s.pos.z - L.z, d = Math.hypot(dx, dz);
      const vol = s.local ? 0.2 : 0.28 * Math.max(0, 1 - d / 90) ** 2;
      const rpm = (s.moto ? 70 : 42) + Math.abs(s.speed) * (s.moto ? 6 : 3.4);
      e.o1.frequency.setTargetAtTime(rpm, t, 0.08); e.o2.frequency.setTargetAtTime(rpm * 0.5, t, 0.08);
      e.lp.frequency.setTargetAtTime(500 + Math.abs(s.speed) * 45, t, 0.1);
      e.g.gain.setTargetAtTime(vol, t, 0.1);
      if (e.pan) e.pan.pan.setTargetAtTime(d > 1 && !s.local ? Math.max(-1, Math.min(1, (L.rx * dx + L.rz * dz) / d)) * 0.8 : 0, t, 0.1);
    }
  }
  crash(pos, v) {
    if (!this.ready) return;
    const sp = this.spatial(pos, 120, { ref: 6 }); if (!sp) return;
    const t = this.t() + sp.delay, k = Math.min(1.4, v / 15) * sp.v;
    this.noise({ t, dur: 0.35, type: 'lowpass', f0: 2500, f1: 200, q: 0.8, vol: 0.9 * k, atk: 0.002, dec: 0.3, dest: sp.dest });
    this.tone({ t, dur: 0.25, type: 'square', f0: 90, f1: 40, vol: 0.4 * k, dec: 0.22, dest: sp.dest });
    this.noise({ t: t + 0.04, dur: 0.3, type: 'bandpass', f0: 3500, q: 3, vol: 0.2 * k, dec: 0.28, dest: sp.dest });
  }
  door(pos, local) {
    if (!this.ready) return;
    const sp = local ? { dest: this.master, v: 0.5 } : this.spatial(pos, 30, { ref: 3 }); if (!sp) return;
    this.noise({ t: this.t(), dur: 0.12, type: 'lowpass', f0: 900, f1: 200, vol: 0.5 * sp.v, dec: 0.1, dest: sp.dest });
  }

  /* ---------------- plane / skydive ---------------- */
  /** continuous sounds: plane engine drone (by distance) and free-fall wind (0..1) */
  setFlightSounds(planeDist, inPlane, wind) {
    if (!this.ready) return;
    const c = this.ctx, t = this.t();
    if (!this.drone) {
      const g = c.createGain(); g.gain.value = 0; g.connect(this.master);
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420; lp.connect(g);
      for (const f of [62, 93, 124.5]) { const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; const og = c.createGain(); og.gain.value = 0.3; o.connect(og); og.connect(lp); o.start(); }
      const n = c.createBufferSource(); n.buffer = this.noiseBuf; n.loop = true; const ng = c.createGain(); ng.gain.value = 0.5; n.connect(ng); ng.connect(lp); n.start();
      const wg = c.createGain(); wg.gain.value = 0; wg.connect(this.master);
      const wf = c.createBiquadFilter(); wf.type = 'bandpass'; wf.frequency.value = 700; wf.Q.value = 0.4; wf.connect(wg);
      const wn = c.createBufferSource(); wn.buffer = this.noiseBuf; wn.loop = true; wn.playbackRate.value = 0.7; wn.connect(wf); wn.start();
      this.drone = { g, lp, wg, wf };
    }
    const dv = inPlane ? 0.16 : planeDist < 900 ? 0.22 * Math.max(0, 1 - planeDist / 600) ** 2 : 0;
    this.drone.g.gain.setTargetAtTime(dv, t, 0.3);
    this.drone.lp.frequency.setTargetAtTime(inPlane ? 300 : 520, t, 0.3);
    this.drone.wg.gain.setTargetAtTime(wind * 0.35, t, 0.15);
    this.drone.wf.frequency.setTargetAtTime(500 + wind * 900, t, 0.2);
  }
  chuteOpen() {
    if (!this.ready) return;
    const t = this.t();
    this.noise({ t, dur: 0.35, type: 'lowpass', f0: 1800, f1: 200, q: 0.7, vol: 0.55, atk: 0.01, dec: 0.3 });
    this.tone({ t, dur: 0.2, type: 'sine', f0: 120, f1: 50, vol: 0.3, dec: 0.18 });
  }
  jumpOut() {
    if (!this.ready) return;
    const t = this.t();
    this.noise({ t, dur: 0.5, type: 'bandpass', f0: 900, f1: 2400, q: 0.5, vol: 0.35, atk: 0.05, dec: 0.4 });
  }

  startAmbience() {
    const c = this.ctx;
    const s = c.createBufferSource(); s.buffer = this.noiseBuf; s.loop = true;
    const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 420; f.Q.value = 0.5;
    const g = c.createGain(); g.gain.value = 0.035;
    const lfo = c.createOscillator(); lfo.frequency.value = 0.07;
    const lg = c.createGain(); lg.gain.value = 0.02;
    lfo.connect(lg); lg.connect(g.gain);
    s.connect(f); f.connect(g); g.connect(this.master);
    s.start(); lfo.start();
    this.ambGain = g;
    this.birdT = 3;
  }
  tickAmbience(dt, calm) {
    if (!this.ready) return;
    this.birdT -= dt;
    if (this.birdT <= 0) {
      this.birdT = 4 + Math.random() * 9;
      if (!calm) return;
      const t = this.t(), f = 2400 + Math.random() * 1600, pan = Math.random() * 2 - 1;
      let dest = this.master;
      if (this.ctx.createStereoPanner) { const p = this.ctx.createStereoPanner(); p.pan.value = pan; p.connect(this.master); dest = p; }
      for (let i = 0; i < 3; i++) this.tone({ t: t + i * 0.13, dur: 0.08, type: 'sine', f0: f, f1: f * 1.3, vol: 0.02, dec: 0.07, dest });
    }
  }
}
