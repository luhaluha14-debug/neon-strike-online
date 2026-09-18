/* =============================================================================
   audio.  everything is synthesised with the Web Audio API - no files to load,
   nothing to wait for, and each sorcery gets its own timbre so you can fight by
   ear.  distant sounds are attenuated against the listener the game updates.
   ========================================================================== */
import { clamp, rnd } from '../core/math.js';
import { settings } from '../core/settings.js';

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.listenerPos = { x: 0, y: 0, z: 0 };
    this.ambient = null;
    this.lastAt = Object.create(null);
  }

  /* browsers only allow audio after a gesture, so the menu calls this */
  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = settings.get('master');
    this.master.connect(this.ctx.destination);

    this.sfxBus = this.ctx.createGain();
    this.sfxBus.gain.value = settings.get('sfx');
    this.sfxBus.connect(this.master);

    this.musicBus = this.ctx.createGain();
    this.musicBus.gain.value = settings.get('music');
    this.musicBus.connect(this.master);

    // a gentle limiter keeps a crowded fight from clipping
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.knee.value = 18;
    comp.ratio.value = 6;
    comp.attack.value = 0.004;
    comp.release.value = 0.14;
    this.sfxBus.disconnect();
    this.sfxBus.connect(comp);
    comp.connect(this.master);

    this.noiseBuf = this.makeNoise(1.6);
    this.ready = true;

    settings.onChange((k) => {
      if (!this.ctx) return;
      if (k === 'master') this.master.gain.value = settings.get('master');
      if (k === 'sfx') this.sfxBus.gain.value = settings.get('sfx');
      if (k === 'music') this.musicBus.gain.value = settings.get('music');
    });
  }

  makeNoise(sec) {
    const n = Math.floor(this.ctx.sampleRate * sec);
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  setListener(pos) { this.listenerPos = pos; }

  gainFor(pos, ref = 26) {
    if (!pos) return 1;
    const d = Math.hypot(pos.x - this.listenerPos.x, (pos.y || 0) - this.listenerPos.y, pos.z - this.listenerPos.z);
    return clamp(1 - d / (ref * 3), 0, 1) * clamp(ref / (ref + d * d * 0.02), 0.05, 1);
  }

  /* ---- primitives ---- */
  tone(o) {
    if (!this.ready) return;
    const t = this.ctx.currentTime + (o.delay || 0);
    const osc = this.ctx.createOscillator();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.f0, t);
    if (o.f1 !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t + o.dur);
    const g = this.ctx.createGain();
    const peak = Math.max(0.0001, (o.gain ?? 0.2));
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + (o.attack ?? 0.006));
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    let node = osc;
    if (o.filter) {
      const bq = this.ctx.createBiquadFilter();
      bq.type = o.filter;
      bq.frequency.value = o.cutoff || 1200;
      bq.Q.value = o.q || 1;
      osc.connect(bq);
      node = bq;
    }
    node.connect(g);
    g.connect(o.bus || this.sfxBus);
    osc.start(t);
    osc.stop(t + o.dur + 0.05);
  }

  noise(o) {
    if (!this.ready) return;
    const t = this.ctx.currentTime + (o.delay || 0);
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const bq = this.ctx.createBiquadFilter();
    bq.type = o.filter || 'bandpass';
    bq.frequency.setValueAtTime(o.f0 || 900, t);
    if (o.f1) bq.frequency.exponentialRampToValueAtTime(Math.max(40, o.f1), t + o.dur);
    bq.Q.value = o.q ?? 1.1;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, o.gain ?? 0.2), t + (o.attack ?? 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    src.connect(bq); bq.connect(g); g.connect(o.bus || this.sfxBus);
    src.start(t);
    src.stop(t + o.dur + 0.05);
  }

  /* rate limit so a full auto weapon does not stack into mush */
  throttle(key, ms) {
    const now = performance.now();
    if (this.lastAt[key] && now - this.lastAt[key] < ms) return false;
    this.lastAt[key] = now;
    return true;
  }

  /* ============================ game sounds ============================ */
  shoot(charId, spec, charge) {
    if (!this.ready) return;
    const g = 0.22;
    if (charId === 'vein') {
      this.tone({ type: 'sawtooth', f0: 420, f1: 90, dur: 0.16, gain: g, filter: 'lowpass', cutoff: 2400 });
      this.noise({ f0: 2600, f1: 500, dur: 0.1, gain: g * 0.5 });
    } else if (charId === 'warden') {
      this.tone({ type: 'triangle', f0: 620, f1: 300, dur: 0.14, gain: g * 0.8 });
      this.tone({ type: 'sine', f0: 1500, f1: 900, dur: 0.09, gain: g * 0.3 });
    } else {
      const c = charge || 0;
      this.tone({ type: 'square', f0: 300 + c * 260, f1: 120, dur: 0.14 + c * 0.1, gain: g * (0.8 + c * 0.5), filter: 'lowpass', cutoff: 1800 });
      this.noise({ f0: 1800, f1: 400, dur: 0.12, gain: g * 0.4 });
    }
    void spec;
  }
  shootAt(pos, charId, spec) {
    const v = this.gainFor(pos);
    if (v < 0.04 || !this.throttle('shootAt', 40)) return;
    this.tone({ type: 'square', f0: 260, f1: 110, dur: 0.12, gain: 0.18 * v, filter: 'lowpass', cutoff: 1400 });
    void charId; void spec;
  }

  beam(id) {
    this.tone({ type: 'sawtooth', f0: 900, f1: 180, dur: 0.3, gain: 0.26, filter: 'lowpass', cutoff: 3000 });
    this.noise({ f0: 3400, f1: 300, dur: 0.26, gain: 0.2 });
    if (id === 'lance' || id === 'cleave') this.tone({ type: 'sine', f0: 120, f1: 60, dur: 0.4, gain: 0.22 });
  }
  beamAt(pos, id) {
    const v = this.gainFor(pos);
    if (v < 0.05) return;
    this.tone({ type: 'sawtooth', f0: 700, f1: 160, dur: 0.26, gain: 0.2 * v, filter: 'lowpass', cutoff: 2200 });
    void id;
  }

  melee(landed, isPlayer, heavy) {
    if (!isPlayer) return;
    this.noise({ f0: heavy ? 900 : 1400, f1: 260, dur: heavy ? 0.22 : 0.13, gain: heavy ? 0.3 : 0.18 });
    this.tone({ type: 'triangle', f0: heavy ? 180 : 260, f1: 70, dur: heavy ? 0.2 : 0.12, gain: 0.2 });
    if (landed) this.tone({ type: 'square', f0: 140, f1: 60, dur: 0.1, gain: 0.22, delay: 0.02 });
  }
  meleeAt(pos, landed) {
    const v = this.gainFor(pos, 18);
    if (v < 0.05) return;
    this.noise({ f0: 1100, f1: 240, dur: 0.14, gain: 0.16 * v });
    if (landed) this.tone({ type: 'square', f0: 130, f1: 60, dur: 0.1, gain: 0.14 * v });
  }

  hit(head) {
    if (!this.throttle('hit', 28)) return;
    this.tone({ type: 'square', f0: head ? 1500 : 900, f1: head ? 700 : 420, dur: 0.07, gain: head ? 0.3 : 0.2 });
    if (head) this.tone({ type: 'sine', f0: 2400, f1: 1400, dur: 0.09, gain: 0.16, delay: 0.01 });
  }
  impactAt(pos, kind) {
    const v = this.gainFor(pos, 22);
    if (v < 0.05 || !this.throttle('impactAt', 35)) return;
    if (kind === 'zone') this.tone({ type: 'sine', f0: 200, f1: 70, dur: 0.4, gain: 0.2 * v });
    else this.noise({ f0: 1600, f1: 300, dur: 0.12, gain: 0.16 * v });
  }

  hurt() {
    if (!this.throttle('hurt', 120)) return;
    this.noise({ f0: 700, f1: 160, dur: 0.22, gain: 0.26, filter: 'lowpass' });
    this.tone({ type: 'sine', f0: 190, f1: 80, dur: 0.24, gain: 0.2 });
  }
  death() {
    this.tone({ type: 'sawtooth', f0: 260, f1: 50, dur: 0.9, gain: 0.3, filter: 'lowpass', cutoff: 900 });
    this.noise({ f0: 900, f1: 90, dur: 0.9, gain: 0.2 });
  }
  kill(streak) {
    const base = 660 + clamp(streak - 1, 0, 4) * 110;
    this.tone({ type: 'triangle', f0: base, dur: 0.1, gain: 0.26 });
    this.tone({ type: 'triangle', f0: base * 1.5, dur: 0.16, gain: 0.2, delay: 0.07 });
  }
  jump() { this.tone({ type: 'sine', f0: 320, f1: 520, dur: 0.1, gain: 0.1 }); }
  land(k) {
    this.noise({ f0: 420, f1: 110, dur: 0.16, gain: 0.1 + k * 0.16, filter: 'lowpass' });
  }
  footstep(sprint) {
    if (!this.throttle('step', 140)) return;
    this.noise({ f0: rnd(700, 1100), f1: 220, dur: 0.07, gain: sprint ? 0.09 : 0.055 });
  }
  dash() { this.noise({ f0: 2200, f1: 400, dur: 0.26, gain: 0.22 }); this.tone({ type: 'sine', f0: 520, f1: 180, dur: 0.22, gain: 0.14 }); }
  blink() {
    this.tone({ type: 'sine', f0: 1400, f1: 300, dur: 0.18, gain: 0.2 });
    this.tone({ type: 'sine', f0: 300, f1: 1500, dur: 0.16, gain: 0.14, delay: 0.05 });
  }
  cast(kind, isPlayer) {
    if (!isPlayer) return;
    if (kind === 'domain') {
      this.tone({ type: 'sine', f0: 90, f1: 220, dur: 0.6, gain: 0.3 });
      this.noise({ f0: 300, f1: 2400, dur: 0.6, gain: 0.2 });
    } else {
      this.tone({ type: 'triangle', f0: 380, f1: 720, dur: 0.14, gain: 0.14 });
    }
  }
  buff() { this.tone({ type: 'sine', f0: 420, f1: 880, dur: 0.3, gain: 0.18 }); }
  summon() {
    this.tone({ type: 'sawtooth', f0: 160, f1: 420, dur: 0.3, gain: 0.2, filter: 'lowpass', cutoff: 1400 });
    this.noise({ f0: 600, f1: 2000, dur: 0.3, gain: 0.14 });
  }
  houndBite(pos) {
    const v = this.gainFor(pos, 16);
    if (v < 0.05 || !this.throttle('bite', 90)) return;
    this.noise({ f0: 1500, f1: 300, dur: 0.1, gain: 0.16 * v });
  }
  parryStance() { this.tone({ type: 'triangle', f0: 700, f1: 520, dur: 0.12, gain: 0.14 }); }
  parry() {
    this.tone({ type: 'square', f0: 1500, f1: 900, dur: 0.12, gain: 0.3 });
    this.tone({ type: 'triangle', f0: 2600, f1: 1200, dur: 0.2, gain: 0.2, delay: 0.02 });
    this.noise({ f0: 4000, f1: 800, dur: 0.16, gain: 0.2 });
  }
  refocus() { this.tone({ type: 'sine', f0: 240, f1: 640, dur: 0.4, gain: 0.16 }); }
  chargeStart() { this.tone({ type: 'sine', f0: 180, f1: 700, dur: 0.9, gain: 0.1 }); }
  chargeFull() { this.tone({ type: 'triangle', f0: 1100, dur: 0.09, gain: 0.16 }); }
  deny() { if (this.throttle('deny', 220)) this.tone({ type: 'square', f0: 180, f1: 120, dur: 0.09, gain: 0.12 }); }

  domainOpen(isPlayer) {
    const g = isPlayer ? 0.45 : 0.3;
    this.tone({ type: 'sine', f0: 60, f1: 30, dur: 1.6, gain: g });
    this.tone({ type: 'sawtooth', f0: 220, f1: 40, dur: 1.2, gain: g * 0.5, filter: 'lowpass', cutoff: 1200 });
    this.noise({ f0: 200, f1: 3800, dur: 0.8, gain: g * 0.5 });
    this.tone({ type: 'triangle', f0: 880, f1: 440, dur: 0.9, gain: g * 0.3, delay: 0.1 });
  }
  domainClose(isPlayer) {
    const g = isPlayer ? 0.4 : 0.26;
    this.noise({ f0: 3000, f1: 120, dur: 0.7, gain: g });
    this.tone({ type: 'sine', f0: 140, f1: 40, dur: 0.8, gain: g });
  }

  playMatchStart() {
    this.init();
    this.tone({ type: 'sine', f0: 180, dur: 0.5, gain: 0.2, bus: this.musicBus });
    this.tone({ type: 'sine', f0: 270, dur: 0.6, gain: 0.16, delay: 0.16, bus: this.musicBus });
    this.tone({ type: 'sine', f0: 360, dur: 0.8, gain: 0.14, delay: 0.32, bus: this.musicBus });
  }
  playMatchEnd(won) {
    const base = won ? 330 : 220;
    [0, 0.18, 0.4].forEach((d, i) => this.tone({
      type: 'triangle', f0: base * (won ? 1 + i * 0.25 : 1 - i * 0.12), dur: 0.6,
      gain: 0.2, delay: d, bus: this.musicBus
    }));
  }

  /* a low room tone per arena; quiet enough to sit under everything */
  startAmbient(mapId) {
    if (!this.ready || this.ambient) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const bq = this.ctx.createBiquadFilter();
    bq.type = 'lowpass';
    bq.frequency.value = mapId === 'sunken' ? 420 : mapId === 'market' ? 300 : 240;
    bq.Q.value = 0.6;
    const g = this.ctx.createGain();
    g.gain.value = 0.05;
    src.connect(bq); bq.connect(g); g.connect(this.musicBus);
    src.start();
    this.ambient = { src, g };
  }
  stopAmbient() {
    if (!this.ambient) return;
    try { this.ambient.src.stop(); } catch (e) { /* already stopped */ }
    this.ambient = null;
  }
}

export const audio = new AudioEngine();
