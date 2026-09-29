/* =========================================================================
   Unified input.  Keyboard+mouse and touch both feed the same action state,
   so the game code never cares which device produced an action.
     held(action)      -> boolean
     consume(action)   -> true once per press (edge), kept until consumed
     move              -> {x: right, y: forward}  (-1..1)
     takeLook()        -> accumulated look delta in radians
   ========================================================================= */

export class Input {
  constructor(settings, canvas) {
    this.s = settings;
    this.canvas = canvas;
    this.heldSet = new Set();
    this.edges = new Set();
    this.lookX = 0; this.lookY = 0;
    this.touchMove = { x: 0, y: 0 };
    this.enabled = false;             // gameplay input active
    this.locked = false;
    this.adsToggled = false;
    this.crouchLatch = false;
    this.lastDevice = 'kbm';
    this.onRebind = null;             // when set, next key/mouse press is captured
    this.buildMap();

    addEventListener('keydown', (e) => this.onKey(e, true));
    addEventListener('keyup', (e) => this.onKey(e, false));
    addEventListener('blur', () => this.releaseAll());
    canvas.addEventListener('mousedown', (e) => this.onMouse(e, true));
    // key rebinding listens on the whole window: the settings screen covers the canvas
    addEventListener('mousedown', (e) => {
      if (!this.onRebind) return;
      e.preventDefault(); e.stopPropagation();
      const f = this.onRebind; this.onRebind = null; f('Mouse' + e.button);
    }, true);
    addEventListener('mouseup', (e) => this.onMouse(e, false));
    addEventListener('mousemove', (e) => {
      if (!this.locked || !this.enabled) return;
      // ignore absurd spikes some browsers emit on lock
      if (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return;
      this.lookX += e.movementX; this.lookY += e.movementY;
    });
    addEventListener('wheel', (e) => { if (this.enabled && this.locked) this.edges.add(e.deltaY > 0 ? 'nextWeapon' : 'prevWeapon'); }, { passive: true });
    addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) this.releaseAll();
      if (this.onLockChange) this.onLockChange(this.locked);
    });
  }

  buildMap() {
    this.codeToActions = new Map();
    for (const [action, codes] of Object.entries(this.s.keys)) {
      for (const c of codes) {
        if (!c) continue;
        if (!this.codeToActions.has(c)) this.codeToActions.set(c, []);
        this.codeToActions.get(c).push(action);
      }
    }
  }

  requestLock() {
    if (this.locked || !this.canvas.requestPointerLock) return;
    try {
      const r = this.canvas.requestPointerLock({ unadjustedMovement: true });
      if (r && r.catch) r.catch(() => { try { this.canvas.requestPointerLock(); } catch { /* ignore */ } });
    } catch { try { this.canvas.requestPointerLock(); } catch { /* ignore */ } }
  }
  exitLock() { if (document.pointerLockElement) document.exitPointerLock(); }

  onKey(e, down) {
    if (this.onRebind && down) { e.preventDefault(); const f = this.onRebind; this.onRebind = null; f(e.code === 'Escape' ? null : e.code); return; }
    if (e.target && (e.target.tagName === 'INPUT') && e.target.type !== 'range') return;
    const acts = this.codeToActions.get(e.code);
    if (e.code === 'Tab' || (acts && this.enabled)) e.preventDefault();
    if (down && e.code === 'Escape') { this.edges.add('escape'); return; }
    if (down && /^F([2-4]|[6-9]|10)$/.test(e.code)) { e.preventDefault(); this.edges.add('dev' + e.code); }
    this.lastDevice = 'kbm';
    if (!acts) return;
    for (const a of acts) this.setAction(a, down, e.repeat);
  }

  onMouse(e, down) {
    const acts = this.codeToActions.get('Mouse' + e.button);
    if (!acts) return;
    this.lastDevice = 'kbm';
    if (down && !this.locked) return;          // first click only acquires pointer lock
    for (const a of acts) this.setAction(a, down, false);
  }

  setAction(a, down, repeat = false) {
    if (down) {
      if (!this.heldSet.has(a) && !repeat) {
        this.edges.add(a);
        if (a === 'ads') this.adsToggled = !this.adsToggled;
        if (a === 'crouch') this.crouchLatch = true;
      }
      this.heldSet.add(a);
    } else {
      if (a === 'crouch' && this.s.crouchHold && this.heldSet.has(a)) this.edges.add('crouchRelease');
      this.heldSet.delete(a);
    }
  }

  /** used by the touch layer */
  press(a) { this.setAction(a, true); }
  release(a) { this.setAction(a, false); }
  tap(a) { this.setAction(a, true); this.setAction(a, false); }
  addLook(dx, dy) { this.lookX += dx; this.lookY += dy; this.lastDevice = 'touch'; }

  held(a) { return this.enabled && this.heldSet.has(a); }
  consume(a) { if (this.edges.has(a)) { this.edges.delete(a); return this.enabled || a === 'escape' || a.startsWith('dev'); } return false; }
  peek(a) { return this.edges.has(a); }
  clearEdges() { this.edges.clear(); }

  get ads() {
    if (!this.enabled) return false;
    // touch buttons are always toggles; keyboard/mouse follows the setting
    if (this.touchMode || !this.s.adsHold) return this.adsToggled;
    return this.heldSet.has('ads');
  }
  resetAds() { this.adsToggled = false; }

  get move() {
    let x = 0, y = 0;
    if (this.held('forward')) y += 1;
    if (this.held('back')) y -= 1;
    if (this.held('right')) x += 1;
    if (this.held('left')) x -= 1;
    x += this.touchMove.x; y += this.touchMove.y;
    const l = Math.hypot(x, y);
    if (l > 1) { x /= l; y /= l; }
    return { x, y };
  }

  takeLook() {
    const r = { x: this.lookX, y: this.lookY };
    this.lookX = 0; this.lookY = 0;
    return r;
  }

  releaseAll() {
    this.heldSet.clear();
    this.touchMove.x = 0; this.touchMove.y = 0;
  }
}
