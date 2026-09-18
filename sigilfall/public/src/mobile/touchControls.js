/* =============================================================================
   touch controls.  a dynamic left stick, a right look area and a button
   cluster that lays itself out from the screen corners, so it fits a small
   phone and a tablet without a separate layout.  everything writes into the
   same InputManager the keyboard uses.
   ========================================================================== */
import { clamp } from '../core/math.js';
import { settings } from '../core/settings.js';
import { $, el } from '../ui/screens.js';
import { abilityOf } from '../characters/roster.js';

const TAP_MS = 190;
const TAP_PX = 14;

/* id, action, label, corner, x, y, radius.  x/y are offsets from that corner. */
const LAYOUT = [
  { id: 'fire', action: 'fire', label: '공격', corner: 'br', x: -96, y: -96, r: 46, cls: 'fire' },
  { id: 'jump', action: 'jump', label: '점프', corner: 'br', x: -192, y: -56, r: 28 },
  { id: 'dash', action: 'dash', label: 'Q', corner: 'br', x: -96, y: -202, r: 33, slot: 'q' },
  { id: 'ab1', action: 'ability1', label: '1', corner: 'br', x: -194, y: -152, r: 33, slot: 'a1' },
  { id: 'ab2', action: 'ability2', label: '2', corner: 'br', x: -272, y: -76, r: 33, slot: 'a2' },
  { id: 'ult', action: 'ultimate', label: 'E', corner: 'br', x: -280, y: -190, r: 37, slot: 'ult', cls: 'ult' },
  { id: 'alt', action: 'altFire', label: '보조', corner: 'br', x: -36, y: -216, r: 30, slot: 'rmb' },
  { id: 'crouch', action: 'crouch', label: '앉기', corner: 'bl', x: 46, y: -196, r: 27 },
  { id: 'refocus', action: 'refocus', label: 'R', corner: 'bl', x: 116, y: -240, r: 25 }
];

export class TouchControls {
  constructor(input, canvas) {
    this.input = input;
    this.canvas = canvas;
    this.root = $('touch');
    this.stick = $('stick');
    this.nub = $('stickNub');
    this.moveZone = $('moveZone');
    this.lookZone = $('lookZone');
    this.buttons = [];
    this.pointers = new Map();
    this.enabled = false;
    this.game = null;
    this.build();
    this.layout();
    this.bind();
    window.addEventListener('resize', () => this.layout());
    settings.onChange((k) => {
      if (k === 'touchScale' || k === 'leftHanded') this.layout();
      if (k === 'touchOpacity') this.root.style.setProperty('--touch-op', settings.get('touchOpacity'));
    });
    this.root.style.setProperty('--touch-op', settings.get('touchOpacity'));
  }

  build() {
    for (const def of LAYOUT) {
      const b = el('button', 'tbtn ' + (def.cls || ''));
      b.appendChild(el('span', 'lab', def.label));
      b.appendChild(el('div', 'sweep'));
      b.appendChild(el('div', 'cdn mono', ''));
      b.dataset.id = def.id;
      this.root.appendChild(b);
      this.buttons.push({ def, el: b, sweep: b.querySelector('.sweep'), num: b.querySelector('.cdn'), down: false });
    }
  }

  /* place everything from the corners; mirrored when the player is left handed */
  layout() {
    const W = window.innerWidth, H = window.innerHeight;
    const scale = clamp(Math.min(W, H) / 460, 0.72, 1.3) * clamp(settings.get('touchScale'), 0.7, 1.4);
    const mirror = !!settings.get('leftHanded');
    this.scale = scale;

    for (const b of this.buttons) {
      const d = b.def;
      let corner = d.corner;
      if (mirror) corner = corner === 'br' ? 'bl' : 'br';
      const r = d.r * scale;
      const x = d.x * scale, y = d.y * scale;
      b.el.style.width = b.el.style.height = (r * 2) + 'px';
      b.el.style.fontSize = (r * 0.46) + 'px';
      if (corner === 'br') {
        b.el.style.right = (-x - r) + 'px';
        b.el.style.left = 'auto';
      } else {
        b.el.style.left = ((mirror ? -x : x) - r) + 'px';
        b.el.style.right = 'auto';
      }
      b.el.style.bottom = (-y - r) + 'px';
      b.el.style.top = 'auto';
      b.corner = corner;
    }

    // the movement half and the look half swap with handedness
    const moveLeft = !mirror;
    this.moveZone.style.cssText =
      `left:${moveLeft ? 0 : W * 0.5}px;top:0;width:${W * 0.5}px;height:100%;`;
    this.lookZone.style.cssText =
      `left:${moveLeft ? W * 0.5 : 0}px;top:0;width:${W * 0.5}px;height:100%;`;
    this.stickRadius = 56 * scale;
    this.stick.style.width = this.stick.style.height = (this.stickRadius * 2.4) + 'px';
  }

  bind() {
    const onDown = (e) => {
      if (!this.enabled) return;
      const p = { id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now(), kind: null, btn: null };
      const btn = this.hitButton(e.clientX, e.clientY);
      if (btn) {
        p.kind = 'button';
        p.btn = btn;
        this.pressButton(btn, true);
      } else if (this.inMoveZone(e.clientX)) {
        p.kind = 'move';
        this.stick.classList.add('on');
        this.stick.style.left = (e.clientX - this.stickRadius * 1.2) + 'px';
        this.stick.style.top = (e.clientY - this.stickRadius * 1.2) + 'px';
        this.nub.style.transform = 'translate(0,0)';
      } else {
        p.kind = 'look';
      }
      this.pointers.set(e.pointerId, p);
      this.input.lastDevice = 'touch';
      e.preventDefault();
    };

    const onMove = (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (p.kind === 'look') {
        const s = settings.get('touchSensitivity') * (this.adsActive ? settings.get('sensitivityAds') : 1);
        const inv = settings.get('invertY') ? -1 : 1;
        this.input.addLook(-dx * s, -dy * s * inv, 'touch');
      } else if (p.kind === 'move') {
        const cx = p.sx, cy = p.sy;
        let ox = e.clientX - cx, oy = e.clientY - cy;
        const len = Math.hypot(ox, oy);
        const max = this.stickRadius;
        if (len > max) { ox = ox / len * max; oy = oy / len * max; }
        this.nub.style.transform = `translate(${ox}px,${oy}px)`;
        const dead = 0.14;
        let nx = ox / max, nz = -oy / max;
        const mag = Math.hypot(nx, nz);
        if (mag < dead) { nx = 0; nz = 0; }
        else {
          const k = (mag - dead) / (1 - dead) / mag;
          nx *= k; nz *= k;
        }
        this.input.setMove(nx, nz, 'touch');
      } else if (p.kind === 'button' && p.btn) {
        // sliding off a button releases it, like a real pad
        const still = this.hitButton(e.clientX, e.clientY) === p.btn;
        if (!still && p.btn.down) this.pressButton(p.btn, false);
        else if (still && !p.btn.down) this.pressButton(p.btn, true);
      }
      e.preventDefault();
    };

    const onUp = (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      this.pointers.delete(e.pointerId);
      if (p.kind === 'move') {
        this.stick.classList.remove('on');
        this.input.setMove(0, 0, 'touch');
      } else if (p.kind === 'button' && p.btn) {
        this.pressButton(p.btn, false);
      } else if (p.kind === 'look') {
        // a quick tap on the look area is a shot, the way phone shooters do it
        const dt = performance.now() - p.t;
        const moved = Math.hypot(e.clientX - p.sx, e.clientY - p.sy);
        if (dt < TAP_MS && moved < TAP_PX) {
          this.input.setHold('fire', true);
          setTimeout(() => this.input.setHold('fire', false), 90);
        }
      }
      e.preventDefault();
    };

    for (const [evt, fn] of [['pointerdown', onDown], ['pointermove', onMove], ['pointerup', onUp], ['pointercancel', onUp]]) {
      this.root.addEventListener(evt, fn, { passive: false });
    }
    this._handlers = { onDown, onMove, onUp };
  }

  inMoveZone(x) {
    const r = this.moveZone.getBoundingClientRect();
    return x >= r.left && x <= r.right;
  }

  hitButton(x, y) {
    for (const b of this.buttons) {
      if (b.el.classList.contains('hide')) continue;
      const r = b.el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (Math.hypot(x - cx, y - cy) <= r.width / 2 + 8) return b;
    }
    return null;
  }

  pressButton(b, down) {
    b.down = down;
    b.el.classList.toggle('down', down);
    const a = b.def.action;
    if (a === 'fire' || a === 'altFire' || a === 'crouch' || a === 'jump') this.input.setHold(a, down);
    else if (down) this.input.press(a);
    if (down && navigator.vibrate && settings.get('haptics') !== false) {
      try { navigator.vibrate(b.def.id === 'ult' ? 22 : 8); } catch (e) { /* unsupported */ }
    }
  }

  setEnabled(on, game) {
    this.enabled = on;
    this.game = game || null;
    this.root.classList.toggle('on', on);
    document.body.classList.toggle('touchui', on);
    if (!on) {
      this.pointers.clear();
      this.stick.classList.remove('on');
      for (const b of this.buttons) this.pressButton(b, false);
      this.input.setMove(0, 0, 'touch');
    } else {
      this.relabel();
    }
  }

  /* button faces follow the chosen character */
  relabel() {
    const g = this.game;
    if (!g || !g.player) return;
    for (const b of this.buttons) {
      if (!b.def.slot) continue;
      const spec = abilityOf(g.player.charId, b.def.slot);
      const lab = b.el.querySelector('.lab');
      lab.textContent = b.def.label;
      b.el.title = spec ? spec.name : '';
      let sub = b.el.querySelector('.sub');
      if (!sub) { sub = el('span', 'sub'); b.el.appendChild(sub); }
      sub.textContent = spec ? spec.name.slice(0, 4) : '';
    }
  }

  /* per frame: cooldown sweeps, ult glow, availability */
  update() {
    if (!this.enabled || !this.game || !this.game.player) return;
    const g = this.game, p = g.player;
    this.adsActive = p.ads;
    for (const b of this.buttons) {
      const slot = b.def.slot;
      if (!slot) continue;
      if (slot === 'ult') {
        const full = p.ultReady && !p.ultActive;
        b.el.classList.toggle('full', full);
        b.el.classList.toggle('cool', !full);
        b.sweep.style.setProperty('--sweep', (360 * (1 - clamp(p.ult / 100, 0, 1))) + 'deg');
        b.num.textContent = '';
        continue;
      }
      if (slot === 'rmb' && p.char.secondary.kind === 'ads') {
        b.el.classList.remove('cool');
        b.sweep.style.setProperty('--sweep', '0deg');
        continue;
      }
      const spec = abilityOf(p.charId, slot);
      const left = g.abilities.cooldownLeft(p, slot);
      const total = spec.cd || 1;
      b.el.classList.toggle('cool', left > 0.05);
      b.sweep.style.setProperty('--sweep', (360 * clamp(left / total, 0, 1)) + 'deg');
      b.num.textContent = left > 0.05 ? (left < 1 ? left.toFixed(1) : Math.ceil(left)) : '';
    }
  }
}
