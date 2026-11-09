import type { InputState } from './InputState';
import type { TouchSettings } from './TouchSettings';
import '../ui/touch.css';

// Phone / tablet controls: a move stick on the left (it appears where the
// thumb lands in the left part of the screen), a look drag anywhere else, and
// buttons on the right: fire (drag on it to aim while firing), aim down
// sights / scope (toggle), reload, jump, crouch (toggle), next weapon, and
// the use key / grenade / buy only when the game has them right now. Every
// finger is tracked by its own pointer id from touch-down to lift: several
// fingers at once (move + look + fire + jump), and a finger that slides off a
// button keeps that button until it lifts (it never presses another). A
// cancelled touch, a turn to portrait, the page going to the background or
// the end of the session clears everything. It only fills the same
// InputState the keyboard and mouse do: the game, its rules and the server
// see no difference (no aim help of any kind).

/** Look speed: radians per CSS pixel of drag at sensitivity 1 (a drag across a phone's height ≈ 90°). */
const LOOK_RAD_PER_PX = 0.0042;
/** Stick travel (px at scale 1) for full speed, and the dead zone (fraction of travel). */
const STICK_RADIUS = 56;
const DEAD_ZONE = 0.14;
/** Left part of the screen where a touch starts the move stick. */
const STICK_ZONE = 0.42;

type Act = 'fire' | 'aim' | 'reload' | 'jump' | 'crouch' | 'weapon' | 'use' | 'utility' | 'pause' | 'board' | 'buy';

type Finger =
  | { kind: 'stick'; ox: number; oy: number }
  | { kind: 'look'; x: number; y: number }
  | { kind: 'button'; act: Act; x: number; y: number };

/** What the game has right now, for the buttons that only make sense then. */
export interface TouchContext {
  use: boolean;
  utility: boolean;
  buy: boolean;
}

export interface TouchCallbacks {
  /** The pause button (the game shows its menu, as Esc does on a PC). */
  onPause(): void;
  /** Scoreboard held (true) / let go (false). */
  onBoard(held: boolean): void;
  /** The buy button (team match prep). */
  onBuy(): void;
}

export class TouchInput {
  readonly root: HTMLDivElement;
  /** The "turn to landscape" notice (shown by CSS in portrait). */
  readonly rotate: HTMLDivElement;
  active = false;
  /** Set by the game each frame: the view is zoomed (scope), so the ADS look speed applies. */
  zoomed = false;
  private settings: TouchSettings;
  private readonly fingers = new Map<number, Finger>();
  private readonly stickBase: HTMLElement;
  private readonly stickKnob: HTMLElement;
  private moveX = 0;
  private moveY = 0;
  private yaw = 0;
  private pitch = 0;
  private aimOn = false;
  private crouchOn = false;
  /** Taps shorter than a frame: kept until a simulation tick has seen them. */
  private latched = new Set<Act>();
  private slot = -1;
  private cycle = 0;
  private context: TouchContext = { use: false, utility: false, buy: false };

  constructor(
    parent: HTMLElement,
    settings: TouchSettings,
    private readonly cb: TouchCallbacks,
  ) {
    this.settings = settings;
    this.root = document.createElement('div');
    this.root.className = 'touch-ui';
    this.root.hidden = true;
    const b = (act: Act, label: string, extra = '') => `<button type="button" class="tc-btn tc-${act}${extra}" data-act="${act}" aria-label="${label}"><span>${label}</span></button>`;
    this.root.innerHTML = `
      <div class="tc-stick" aria-hidden="true"><div class="tc-knob"></div></div>
      <div class="tc-top">
        ${b('pause', 'Ⅱ', ' tc-small')}${b('board', '점수', ' tc-small')}${b('buy', '구매', ' tc-small')}
      </div>
      <div class="tc-cluster">
        ${b('fire', '발사')}${b('aim', '조준')}${b('reload', '장전')}${b('jump', '점프')}${b('crouch', '앉기')}${b('weapon', '무기')}${b('use', '사용')}${b('utility', '투척')}
      </div>
`;
    parent.appendChild(this.root);
    // Portrait: a notice over everything (menus too), until the phone is turned.
    this.rotate = document.createElement('div');
    this.rotate.className = 'tc-rotate';
    this.rotate.setAttribute('role', 'status');
    this.rotate.innerHTML = '<div class="tc-rotate-icon" aria-hidden="true"></div><div class="tc-rotate-title">가로 화면으로 돌려 주세요</div><div class="tc-rotate-sub">GRID는 가로 화면에서 플레이합니다.</div>';
    document.body.appendChild(this.rotate);
    this.stickBase = this.root.querySelector('.tc-stick')!;
    this.stickKnob = this.root.querySelector('.tc-knob')!;
    this.root.addEventListener('pointerdown', this.onDown);
    this.root.addEventListener('pointermove', this.onMove);
    this.root.addEventListener('pointerup', this.onUp);
    this.root.addEventListener('pointercancel', this.onCancel);
    // Capture also ends after every normal lift: only that finger (already handled by pointerup).
    this.root.addEventListener('lostpointercapture', this.onUp);
    // No browser gestures (scroll, zoom, long-press menu, text selection) on the controls.
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    this.root.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    window.addEventListener('blur', this.resetAll);
    window.addEventListener('resize', this.onResize);
    window.addEventListener('orientationchange', this.resetAll);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.applySettings(settings);
    this.setContext(this.context);
  }

  /** Portrait: the controls are covered by the "turn the phone" notice and take no input. */
  get portrait(): boolean {
    return innerHeight > innerWidth;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.root.hidden = false;
    this.resetAll();
  }

  stop(): void {
    if (!this.active) return;
    this.resetAll();
    this.active = false;
    this.root.hidden = true;
  }

  applySettings(s: TouchSettings): void {
    this.settings = s;
    const st = this.root.style;
    st.setProperty('--tc-scale', String(s.buttonScale));
    st.setProperty('--tc-opacity', String(s.opacity));
    st.setProperty('--tc-stick-x', `${s.stickX * 100}%`);
    st.setProperty('--tc-stick-y', `${s.stickY * 100}%`);
    st.setProperty('--tc-buttons-x', `${s.buttonsX * 100}vw`);
    st.setProperty('--tc-buttons-y', `${s.buttonsY * 100}vh`);
    this.placeStick(null);
  }

  /** Shows only the buttons the game has a use for now (no use key outside the C4 objective, ...). */
  setContext(c: TouchContext): void {
    if (c.use === this.context.use && c.utility === this.context.utility && c.buy === this.context.buy && this.root.dataset.ctx) return;
    this.context = { ...c };
    this.root.dataset.ctx = '1';
    this.button('use').hidden = !c.use;
    this.button('utility').hidden = !c.utility;
    this.button('buy').hidden = !c.buy;
  }

  /** Adds the touch state to `out` (after the keyboard / mouse wrote theirs). Consumes the look delta. */
  poll(out: InputState): void {
    if (!this.active) return;
    const held = (a: Act) => [...this.fingers.values()].some((f) => f.kind === 'button' && f.act === a);
    if (this.moveX !== 0 || this.moveY !== 0) {
      out.moveX = this.moveX;
      out.moveY = this.moveY;
    }
    out.lookYaw += this.yaw;
    out.lookPitch += this.pitch;
    this.yaw = 0;
    this.pitch = 0;
    out.fire ||= held('fire') || this.latched.has('fire');
    out.aim ||= this.aimOn;
    out.crouch ||= this.crouchOn;
    out.jump ||= held('jump') || this.latched.has('jump');
    out.reload ||= held('reload') || this.latched.has('reload');
    out.use ||= held('use');
    out.utility ||= this.latched.has('utility');
    if (this.slot >= 0) out.equipSlot = this.slot;
    if (this.cycle !== 0) out.equipCycle = this.cycle;
  }

  clearLatches(): void {
    this.latched.clear();
    this.slot = -1;
    this.cycle = 0;
  }

  /** Everything let go: no finger, no stick, no toggle, no pending tap. */
  readonly resetAll = (): void => {
    for (const id of this.fingers.keys()) {
      try {
        if (this.root.hasPointerCapture(id)) this.root.releasePointerCapture(id);
      } catch {
        // already gone
      }
    }
    const board = [...this.fingers.values()].some((f) => f.kind === 'button' && f.act === 'board');
    this.fingers.clear();
    this.moveX = this.moveY = this.yaw = this.pitch = 0;
    this.aimOn = this.crouchOn = false;
    this.clearLatches();
    for (const el of this.root.querySelectorAll('.tc-btn.on, .tc-btn.down')) el.classList.remove('on', 'down');
    this.placeStick(null);
    if (board) this.cb.onBoard(false);
  };

  /** Fingers down right now (tests). */
  get fingerCount(): number {
    return this.fingers.size;
  }

  dispose(): void {
    this.stop();
    window.removeEventListener('blur', this.resetAll);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('orientationchange', this.resetAll);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.root.remove();
    this.rotate.remove();
  }

  // --- internals -----------------------------------------------------------------------

  private button(act: Act): HTMLButtonElement {
    return this.root.querySelector<HTMLButtonElement>(`[data-act="${act}"]`)!;
  }

  private radius(): number {
    return STICK_RADIUS * this.settings.buttonScale;
  }

  /** The stick drawn at the thumb (`at`) or back at its home position (null). */
  private placeStick(at: { x: number; y: number } | null): void {
    const s = this.stickBase.style;
    if (at) {
      s.left = `${at.x}px`;
      s.top = `${at.y}px`;
      s.bottom = 'auto';
      this.stickBase.classList.add('live');
    } else {
      s.left = 'var(--tc-stick-x)';
      s.top = 'auto';
      s.bottom = 'var(--tc-stick-y)';
      this.stickBase.classList.remove('live');
      this.stickKnob.style.transform = '';
    }
  }

  private onVisibility = (): void => {
    if (document.hidden) this.resetAll();
  };

  private onResize = (): void => {
    // Turned to portrait (or the window changed shape under the fingers): let go of everything.
    this.resetAll();
  };

  private onDown = (e: PointerEvent): void => {
    if (!this.active) return;
    e.preventDefault();
    if (this.portrait) return;
    const target = e.target as HTMLElement;
    const btn = target.closest<HTMLElement>('[data-act]');
    let finger: Finger;
    if (btn && !btn.hidden) {
      const act = btn.dataset.act as Act;
      finger = { kind: 'button', act, x: e.clientX, y: e.clientY };
      this.press(act, btn);
    } else {
      // A tap on the weapon strip picks that weapon.
      const slot = [...document.querySelectorAll<HTMLElement>('.hud .loadout [data-slot]')].find((el) => {
        const b = el.getBoundingClientRect();
        return b.width > 0 && e.clientX >= b.left - 6 && e.clientX <= b.right + 6 && e.clientY >= b.top - 6 && e.clientY <= b.bottom + 6;
      });
      if (slot) {
        this.slot = Number(slot.dataset.slot);
        return;
      }
      if (e.clientX < innerWidth * STICK_ZONE && ![...this.fingers.values()].some((f) => f.kind === 'stick')) {
        finger = { kind: 'stick', ox: e.clientX, oy: e.clientY };
        this.placeStick({ x: e.clientX, y: e.clientY });
      } else finger = { kind: 'look', x: e.clientX, y: e.clientY };
    }
    this.fingers.set(e.pointerId, finger);
    try {
      this.root.setPointerCapture(e.pointerId);
    } catch {
      // synthetic pointer (tests) or already released
    }
  };

  private onMove = (e: PointerEvent): void => {
    const f = this.fingers.get(e.pointerId);
    if (!f || !this.active) return;
    e.preventDefault();
    if (f.kind === 'stick') {
      const r = this.radius();
      const dx = (e.clientX - f.ox) / r;
      const dy = (e.clientY - f.oy) / r;
      const len = Math.hypot(dx, dy);
      const mag = Math.min(1, len);
      const ux = len > 0 ? dx / len : 0;
      const uy = len > 0 ? dy / len : 0;
      // Full speed at the rim; nothing inside the dead zone; linear in between.
      const speed = mag < DEAD_ZONE ? 0 : (mag - DEAD_ZONE) / (1 - DEAD_ZONE);
      this.moveX = ux * speed;
      this.moveY = -uy * speed;
      this.stickKnob.style.transform = `translate(${ux * mag * r}px, ${uy * mag * r}px)`;
      return;
    }
    // Look: a free drag, or a drag on the fire button while it is held.
    if (f.kind === 'look' || (f.kind === 'button' && f.act === 'fire')) {
      const k = LOOK_RAD_PER_PX * this.settings.lookSensitivity * (this.zoomed ? this.settings.adsSensitivity : 1);
      this.yaw -= (e.clientX - f.x) * k;
      this.pitch -= (e.clientY - f.y) * k;
      f.x = e.clientX;
      f.y = e.clientY;
    }
  };

  private onUp = (e: PointerEvent): void => {
    this.lift(e.pointerId);
  };

  private onCancel = (): void => {
    // The system took the touches (a gesture, a call, a notification): everything lets go, toggles too.
    this.resetAll();
  };

  private lift(id: number): void {
    const f = this.fingers.get(id);
    if (!f) return;
    this.fingers.delete(id);
    if (f.kind === 'stick') {
      this.moveX = this.moveY = 0;
      this.placeStick(null);
    } else if (f.kind === 'button') {
      // Still held by another finger (two thumbs on one button): stays down.
      if (![...this.fingers.values()].some((g) => g.kind === 'button' && g.act === f.act)) {
        this.button(f.act).classList.remove('down');
        if (f.act === 'board') this.cb.onBoard(false);
      }
    }
  }

  private press(act: Act, el: HTMLElement): void {
    el.classList.add('down');
    switch (act) {
      case 'aim':
        this.aimOn = !this.aimOn;
        el.classList.toggle('on', this.aimOn);
        break;
      case 'crouch':
        this.crouchOn = !this.crouchOn;
        el.classList.toggle('on', this.crouchOn);
        break;
      case 'weapon':
        this.cycle = 1;
        break;
      case 'pause':
        this.cb.onPause();
        break;
      case 'board':
        this.cb.onBoard(true);
        break;
      case 'buy':
        this.cb.onBuy();
        break;
      default:
        this.latched.add(act);
    }
  }
}
