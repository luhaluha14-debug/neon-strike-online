/* =========================================================================
   Mobile touch controls.
     left half  : floating virtual stick (push to the rim to sprint)
     right half : drag to look
     buttons    : fire (x2), aim, jump, crouch, prone, reload, pickup,
                  weapon swap, heal, inventory, map, view, pause
   Every button can be moved / resized in layout-edit mode; positions are
   stored as fractions of the screen so they survive rotation.
   ========================================================================= */

export const TOUCH_BUTTONS = [
  // id, label, action, mode (hold|tap), default x, y (fraction of screen, centre), size(px)
  ['fire', '발사', 'fire', 'hold', 0.885, 0.66, 86, true],
  ['fire2', '발사', 'fire', 'hold', 0.075, 0.42, 62, true],
  ['ads', '조준', 'ads', 'tap', 0.77, 0.5, 58],
  ['jump', '점프', 'jump', 'tap', 0.945, 0.84, 58],
  ['crouch', '앉기', 'crouch', 'tap', 0.855, 0.9, 54],
  ['prone', '엎드', 'prone', 'tap', 0.765, 0.9, 54],
  ['reload', '장전', 'reload', 'tap', 0.745, 0.73, 52],
  ['interact', '줍기', 'interact', 'tap', 0.64, 0.62, 56],
  ['swap', '무기\n교체', 'nextWeapon', 'tap', 0.66, 0.9, 52],
  ['heal', '회복', 'heal', 'tap', 0.3, 0.9, 50],
  ['inventory', '가방', 'inventory', 'tap', 0.2, 0.9, 50],
  ['map', '지도', 'map', 'tap', 0.1, 0.07, 42],
  ['view', '시점', 'view', 'tap', 0.165, 0.07, 42],
  ['pause', 'II', 'escape', 'tap', 0.035, 0.06, 40]
];

export class TouchControls {
  constructor(root, input, settings, onSave) {
    this.root = root;
    this.input = input;
    this.s = settings;
    this.onSave = onSave;
    this.edit = false;
    this.sel = null;
    this.stick = null;          // {id, ox, oy}
    this.look = new Map();      // pointerId -> {x,y}
    this.btns = {};
    this.build();
    addEventListener('resize', () => this.layout());
  }

  build() {
    const r = this.root;
    r.innerHTML = '';
    // zones
    this.left = document.createElement('div');
    this.left.className = 'zone';
    Object.assign(this.left.style, { left: '0', top: '15%', width: '45%', bottom: '0' });
    this.right = document.createElement('div');
    this.right.className = 'zone';
    Object.assign(this.right.style, { left: '45%', top: '0', right: '0', bottom: '0' });
    r.append(this.left, this.right);
    this.base = document.createElement('div'); this.base.className = 'stickBase hide';
    this.knob = document.createElement('div'); this.knob.className = 'stickKnob hide';
    r.append(this.base, this.knob);

    this.left.addEventListener('pointerdown', (e) => this.stickDown(e));
    this.right.addEventListener('pointerdown', (e) => this.lookDown(e));
    addEventListener('pointermove', (e) => this.move(e), { passive: false });
    addEventListener('pointerup', (e) => this.up(e));
    addEventListener('pointercancel', (e) => this.up(e));

    for (const [id, label, action, mode, , , size, big] of TOUCH_BUTTONS) {
      const b = document.createElement('div');
      b.className = 'tb' + (big ? ' big' : '');
      b.textContent = label;
      b.style.whiteSpace = 'pre';
      b.dataset.id = id;
      r.appendChild(b);
      const st = { el: b, id, action, mode, size, pid: null };
      this.btns[id] = st;
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (this.edit) { this.startDrag(st, e); return; }
        try { b.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        st.pid = e.pointerId; st.lx = e.clientX; st.ly = e.clientY;
        b.classList.add('press');
        if (mode === 'hold') this.input.press(action); else this.input.tap(action);
        this.buzz(8);
      });
      const end = (e) => {
        if (st.pid !== e.pointerId) return;
        st.pid = null;
        b.classList.remove('press');
        if (mode === 'hold') this.input.release(action);
      };
      b.addEventListener('pointerup', end);
      b.addEventListener('pointercancel', end);
      b.addEventListener('lostpointercapture', end);
      // dragging on the fire button also turns the camera
      b.addEventListener('pointermove', (e) => {
        if (st.pid !== e.pointerId || this.edit || action !== 'fire') return;
        this.input.addLook((e.clientX - st.lx) * this.sensMul(), (e.clientY - st.ly) * this.sensMul());
        st.lx = e.clientX; st.ly = e.clientY;
      });
    }
    this.layout();
  }

  sensMul() { return 1.35 * this.s.touchSens; }
  buzz(ms) { if (this.s.vibrate && navigator.vibrate) try { navigator.vibrate(ms); } catch { /* ignore */ } }

  layout() {
    const W = innerWidth, H = innerHeight;
    const lay = this.s.layout || {};
    for (const [id, , , , dx, dy, size] of TOUCH_BUTTONS) {
      const st = this.btns[id];
      const L = lay[id] || {};
      const s = size * (L.s || 1) * this.s.btnScale;
      const x = (L.x !== undefined ? L.x : dx) * W, y = (L.y !== undefined ? L.y : dy) * H;
      Object.assign(st.el.style, { width: s + 'px', height: s + 'px', left: (x - s / 2) + 'px', top: (y - s / 2) + 'px', opacity: this.s.btnOpacity, fontSize: Math.max(10, s * 0.2) + 'px' });
    }
  }

  setVisible(v) { this.root.classList.toggle('hide', !v); }
  setState(id, on) { if (this.btns[id]) this.btns[id].el.classList.toggle('on', !!on); }
  setEnabled(id, on) { if (this.btns[id]) this.btns[id].el.style.filter = on ? '' : 'grayscale(1) brightness(.6)'; }

  /* ---------------- stick ---------------- */
  stickDown(e) {
    if (this.edit || this.stick) return;
    e.preventDefault();
    this.stick = { id: e.pointerId, ox: e.clientX, oy: e.clientY };
    this.base.classList.remove('hide'); this.knob.classList.remove('hide');
    this.base.style.left = e.clientX + 'px'; this.base.style.top = e.clientY + 'px';
    this.knob.style.left = e.clientX + 'px'; this.knob.style.top = e.clientY + 'px';
  }
  lookDown(e) {
    if (this.edit) return;
    e.preventDefault();
    this.look.set(e.pointerId, { x: e.clientX, y: e.clientY });
  }
  move(e) {
    if (this.drag && this.drag.pid === e.pointerId) { this.dragMove(e); return; }
    if (this.stick && e.pointerId === this.stick.id) {
      e.preventDefault();
      const R = 58;
      let dx = e.clientX - this.stick.ox, dy = e.clientY - this.stick.oy;
      const d = Math.hypot(dx, dy);
      if (d > R * 1.6) {           // floating stick follows the finger
        this.stick.ox += dx - (dx / d) * R * 1.6; this.stick.oy += dy - (dy / d) * R * 1.6;
        this.base.style.left = this.stick.ox + 'px'; this.base.style.top = this.stick.oy + 'px';
        dx = e.clientX - this.stick.ox; dy = e.clientY - this.stick.oy;
      }
      const k = Math.min(1, Math.hypot(dx, dy) / R);
      const nx = dx / Math.max(1, Math.hypot(dx, dy)), ny = dy / Math.max(1, Math.hypot(dx, dy));
      this.input.touchMove.x = nx * k; this.input.touchMove.y = -ny * k;
      this.knob.style.left = (this.stick.ox + nx * Math.min(Math.hypot(dx, dy), R)) + 'px';
      this.knob.style.top = (this.stick.oy + ny * Math.min(Math.hypot(dx, dy), R)) + 'px';
      // push past the rim upward = sprint
      const sprint = Math.hypot(dx, dy) > R * 1.25 && -ny > 0.7;
      if (sprint !== this.sprinting) { this.sprinting = sprint; if (sprint) this.input.press('sprint'); else this.input.release('sprint'); }
      return;
    }
    const l = this.look.get(e.pointerId);
    if (l) {
      e.preventDefault();
      this.input.addLook((e.clientX - l.x) * this.sensMul(), (e.clientY - l.y) * this.sensMul());
      l.x = e.clientX; l.y = e.clientY;
    }
  }
  up(e) {
    if (this.drag && this.drag.pid === e.pointerId) { this.drag = null; return; }
    if (this.stick && e.pointerId === this.stick.id) {
      this.stick = null;
      this.input.touchMove.x = 0; this.input.touchMove.y = 0;
      if (this.sprinting) { this.sprinting = false; this.input.release('sprint'); }
      this.base.classList.add('hide'); this.knob.classList.add('hide');
    }
    this.look.delete(e.pointerId);
  }

  /* ---------------- layout editing ---------------- */
  setEdit(on) {
    this.edit = on;
    this.root.classList.toggle('edit', on);
    this.setVisible(on || this.visible);
    this.sel = null;
  }
  startDrag(st, e) {
    this.sel = st.id;
    for (const k in this.btns) this.btns[k].el.style.outlineColor = k === st.id ? '#fff' : '';
    this.drag = { pid: e.pointerId, st, ox: e.clientX, oy: e.clientY };
  }
  dragMove(e) {
    const { st } = this.drag;
    const lay = this.s.layout || (this.s.layout = {});
    const L = lay[st.id] || (lay[st.id] = {});
    L.x = Math.min(0.98, Math.max(0.02, e.clientX / innerWidth));
    L.y = Math.min(0.98, Math.max(0.02, e.clientY / innerHeight));
    this.layout();
  }
  resizeSel(mul) {
    if (!this.sel) return;
    const lay = this.s.layout || (this.s.layout = {});
    const L = lay[this.sel] || (lay[this.sel] = {});
    L.s = Math.min(2, Math.max(0.6, (L.s || 1) * mul));
    this.layout();
  }
  resetLayout() { this.s.layout = null; this.layout(); }
  save() { if (this.onSave) this.onSave(); }
}

export function isTouchDevice() {
  if (/[?&]touch=1/.test(location.search)) return true;
  if (/[?&]touch=0/.test(location.search)) return false;
  return (window.matchMedia && matchMedia('(pointer: coarse)').matches) || 'ontouchstart' in window;
}
