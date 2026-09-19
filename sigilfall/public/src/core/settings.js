/* =============================================================================
   user settings: input, graphics, audio, aim assist and key bindings.
   auto-detects a sane graphics preset the first time the game is opened.
   ========================================================================== */
import { clamp } from './math.js';

const KEY = 'sigilfall.settings.v1';

export const DEFAULT_BINDS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  crouch: ['ControlLeft', 'KeyC'],
  sprint: ['ShiftLeft'],
  dash: ['KeyQ'],
  ability1: ['Digit1'],
  ability2: ['Digit2'],
  ultimate: ['KeyE'],
  refocus: ['KeyR'],
  scoreboard: ['Tab'],
  menu: ['Escape']
};

export const QUALITY_PRESETS = {
  low: {
    id: 'low', name: '낮음', renderScale: 0.7, shadows: false, shadowSize: 512,
    particles: 0.45, effects: 0.5, drawDistance: 0.7, antialias: false, fpsCap: 60
  },
  medium: {
    id: 'medium', name: '보통', renderScale: 0.85, shadows: true, shadowSize: 1024,
    particles: 0.8, effects: 0.8, drawDistance: 0.88, antialias: false, fpsCap: 0
  },
  high: {
    id: 'high', name: '높음', renderScale: 1, shadows: true, shadowSize: 2048,
    particles: 1, effects: 1, drawDistance: 1, antialias: true, fpsCap: 0
  }
};

function baseDefaults() {
  return {
    // input
    sensitivity: 0.0022,
    sensitivityAds: 0.72,           // multiplier while aiming down sight
    touchSensitivity: 0.0042,
    invertY: false,
    binds: JSON.parse(JSON.stringify(DEFAULT_BINDS)),
    toggleCrouch: false,
    toggleSprint: false,
    // aim assist (mobile only by default)
    aimAssist: null,                // filled by detect()
    aimAssistStrength: 0.75,        // 0..1
    aimAssistFov: 26,               // degrees off centre a target may sit
    aimAssistSticky: true,
    // display
    fov: 92,
    quality: null,                  // filled by detect()
    renderScale: null,
    shadows: null,
    particles: null,
    fpsCap: null,
    showFps: false,
    autoQuality: true,
    // hud
    crosshairStyle: 'cross',
    crosshairColor: '#e9f2ff',
    crosshairSize: 1,
    hitMarkers: true,
    damageNumbers: true,
    minimap: true,
    shake: 1,
    // mobile layout
    touchScale: 1,
    touchOpacity: 0.72,
    leftHanded: false,
    autoSprint: true,
    // audio
    master: 0.8,
    sfx: 1,
    music: 0.45,
    // misc
    name: '',
    lastCharacter: 'rift',
    charms: { rift: 'none', brand: 'none', warden: 'none', vein: 'none' }
  };
}

/* what is in the player's hand, not how wide the screen is.  iPadOS Safari
   reports a Macintosh user agent, so a tablet has to be recognised by its
   touch points; orientation is deliberately ignored, or turning the device
   would change the verdict. */
export function detectDevice() {
  const ua = navigator.userAgent || '';
  const mm = (q) => (window.matchMedia ? window.matchMedia(q).matches : false);
  const coarse = mm('(pointer: coarse)');
  const fine = mm('(pointer: fine)');
  const touch = ('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0;
  const phoneUa = /Android.*Mobile|iPhone|iPod|Windows Phone/i.test(ua);
  const tabletUa = /iPad|Tablet|PlayBook|Silk/i.test(ua) ||
    (/Macintosh/.test(ua) && touch) ||               // iPadOS in its Mac disguise
    (/Android/i.test(ua) && !/Mobile/i.test(ua));
  const short = Math.min(window.innerWidth || 1024, window.innerHeight || 768);

  const isTablet = touch && (tabletUa || (coarse && !phoneUa && short >= 600));
  const isPhone = touch && !isTablet && (phoneUa || (coarse && short < 600));
  const isMobile = isPhone || isTablet;

  const cores = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory || (isMobile ? 4 : 8);
  const dpr = window.devicePixelRatio || 1;
  let tier;
  if (isPhone) tier = (cores >= 8 && mem >= 6) ? 'medium' : 'low';
  else if (isTablet) tier = 'medium';
  else tier = (cores <= 4 || mem <= 4) ? 'medium' : 'high';

  return { isMobile, isPhone, isTablet, touch, coarse, fine, cores, mem, dpr, tier };
}

export class Settings {
  constructor() {
    this.device = detectDevice();
    this.data = baseDefaults();
    const preset = QUALITY_PRESETS[this.device.tier];
    this.data.quality = this.device.tier;
    this.data.renderScale = preset.renderScale;
    this.data.shadows = preset.shadows;
    this.data.particles = preset.particles;
    this.data.fpsCap = preset.fpsCap;
    // a finger aims worse than a mouse, so any touch-first device gets the
    // assist; it only ever acts on touch input anyway
    this.data.aimAssist = this.device.touch && this.device.coarse;
    if (this.device.isPhone) this.data.fov = 86;
    this.load();
    this.listeners = new Set();
  }

  load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved && typeof saved === 'object') {
        const binds = Object.assign({}, this.data.binds, saved.binds || {});
        Object.assign(this.data, saved);
        this.data.binds = binds;
      }
    } catch (e) { /* corrupted or blocked storage: keep defaults */ }
  }

  save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch (e) { /* private mode */ }
  }

  get(k) { return this.data[k]; }
  set(k, v) {
    this.data[k] = v;
    this.save();
    for (const fn of this.listeners) fn(k, v);
  }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  applyQuality(id) {
    const p = QUALITY_PRESETS[id];
    if (!p) return;
    this.data.quality = id;
    this.data.renderScale = p.renderScale;
    this.data.shadows = p.shadows;
    this.data.particles = p.particles;
    this.data.fpsCap = p.fpsCap;
    this.save();
    for (const fn of this.listeners) fn('quality', id);
  }

  get preset() { return QUALITY_PRESETS[this.data.quality] || QUALITY_PRESETS.medium; }

  /* the code a key is bound to, or null */
  actionForCode(code) {
    for (const [action, codes] of Object.entries(this.data.binds)) {
      if (codes.includes(code)) return action;
    }
    return null;
  }
  rebind(action, code) {
    // a key only ever drives one action
    for (const [a, codes] of Object.entries(this.data.binds)) {
      if (a === action) continue;
      const i = codes.indexOf(code);
      if (i >= 0) codes.splice(i, 1);
    }
    this.data.binds[action] = [code];
    this.save();
  }
  resetBinds() {
    this.data.binds = JSON.parse(JSON.stringify(DEFAULT_BINDS));
    this.save();
  }
  get lookSensitivity() { return clamp(this.data.sensitivity, 0.0002, 0.02); }
}

export const settings = typeof window !== 'undefined' ? new Settings() : null;
