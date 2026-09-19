/* =============================================================================
   PC input: keyboard for movement and abilities, mouse for aim and firing.
   pointer lock is requested by the game when a match starts.
   ========================================================================== */
import { settings } from '../core/settings.js';

export class KeyboardMouse {
  constructor(input, canvas) {
    this.input = input;
    this.canvas = canvas;
    this.locked = false;
    this.dragLook = false;              // set when pointer lock is unavailable
    this.dragging = false;
    this.rebindCapture = null;          // set by the settings screen
    this.onLockChange = null;

    this._keydown = (e) => {
      if (e.repeat) return;
      if (this.rebindCapture) {
        e.preventDefault();
        const fn = this.rebindCapture;
        this.rebindCapture = null;
        fn(e.code);
        return;
      }
      const a = settings.actionForCode(e.code);
      if (!a) return;
      if (e.code === 'Tab' || e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
      this.input.lastDevice = 'kbm';
      this.apply(a, true);
    };
    this._keyup = (e) => {
      const a = settings.actionForCode(e.code);
      if (!a) return;
      this.apply(a, false);
    };
    this._blur = () => this.input.clear();

    this._mousedown = (e) => {
      if (!this.locked && !this.dragLook) return;
      this.input.lastDevice = 'kbm';
      if (this.dragLook) this.dragging = true;
      if (e.button === 0) this.input.setHold('fire', true);
      else if (e.button === 2) this.input.setHold('altFire', true);
    };
    this._mouseup = (e) => {
      this.dragging = false;
      if (e.button === 0) this.input.setHold('fire', false);
      else if (e.button === 2) this.input.setHold('altFire', false);
    };
    this._mousemove = (e) => {
      if (!this.locked && !(this.dragLook && this.dragging)) return;
      const s = settings.lookSensitivity;
      const inv = settings.get('invertY') ? -1 : 1;
      const adsMul = this.adsActive ? settings.get('sensitivityAds') : 1;
      const dx = e.movementX !== undefined ? e.movementX : 0;
      const dy = e.movementY !== undefined ? e.movementY : 0;
      this.input.addLook(-dx * s * adsMul, -dy * s * adsMul * inv, 'kbm');
    };
    this._contextmenu = (e) => { if (this.locked) e.preventDefault(); };
    this._lockchange = () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (this.locked) { this.dragLook = false; this.dragging = false; }
      if (!this.locked) this.input.clear();
      this.onLockChange?.(this.locked);
    };

    window.addEventListener('keydown', this._keydown);
    window.addEventListener('keyup', this._keyup);
    window.addEventListener('blur', this._blur);
    window.addEventListener('mousedown', this._mousedown);
    window.addEventListener('mouseup', this._mouseup);
    window.addEventListener('mousemove', this._mousemove);
    window.addEventListener('contextmenu', this._contextmenu);
    document.addEventListener('pointerlockchange', this._lockchange);
  }

  apply(action, down) {
    const i = this.input;
    switch (action) {
      case 'forward': case 'back': case 'left': case 'right':
        i.setHold(action, down);
        this.syncMove();
        break;
      case 'sprint':
        if (settings.get('toggleSprint') && down) i.setHold('sprint', !i.isDown('sprint'));
        else if (!settings.get('toggleSprint')) i.setHold('sprint', down);
        break;
      case 'crouch':
        if (settings.get('toggleCrouch')) { if (down) i.setHold('crouch', !i.isDown('crouch')); }
        else i.setHold('crouch', down);
        break;
      case 'jump': i.setHold('jump', down); break;
      case 'scoreboard': i.setHold('scoreboard', down); break;
      default:
        if (down) i.press(action);
    }
  }

  syncMove() {
    const i = this.input;
    const x = (i.isDown('right') ? 1 : 0) - (i.isDown('left') ? 1 : 0);
    const z = (i.isDown('forward') ? 1 : 0) - (i.isDown('back') ? 1 : 0);
    i.setMove(x, z, 'kbm');
  }

  /* asks for pointer lock; if the browser will not give it (an iframe without
     the permission, or a tablet), the mouse falls back to drag-to-look */
  requestLock() {
    if (this.locked) return;
    this.dragging = false;
    let denied = false;
    try {
      const p = this.canvas.requestPointerLock?.();
      if (p && p.catch) p.catch(() => { denied = true; this.dragLook = true; });
    } catch (e) { denied = true; this.dragLook = true; }
    clearTimeout(this._lockTimer);
    this._lockTimer = setTimeout(() => {
      if (!this.locked) this.dragLook = true;
      else this.dragLook = false;
      void denied;
    }, 500);
  }
  exitLock() {
    clearTimeout(this._lockTimer);
    this.dragging = false;
    if (document.pointerLockElement) document.exitPointerLock();
  }

  dispose() {
    window.removeEventListener('keydown', this._keydown);
    window.removeEventListener('keyup', this._keyup);
    window.removeEventListener('blur', this._blur);
    window.removeEventListener('mousedown', this._mousedown);
    window.removeEventListener('mouseup', this._mouseup);
    window.removeEventListener('mousemove', this._mousemove);
    window.removeEventListener('contextmenu', this._contextmenu);
    document.removeEventListener('pointerlockchange', this._lockchange);
  }
}
