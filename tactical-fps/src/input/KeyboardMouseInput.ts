import { CAMERA_CONFIG } from '../config';
import type { InputSource, InputState } from './InputState';

/** PC input: WASD + mouse look via Pointer Lock. Uses `code` so layouts (e.g. Korean IME) don't matter. */
export class KeyboardMouseInput implements InputSource {
  sensitivity = 1;
  private keys = new Set<string>();
  private mouseButtons = 0;
  /** Keys / buttons pressed since the last tick consumed input (catches sub-frame taps). */
  private latchedKeys = new Set<string>();
  private latchedButtons = 0;
  private yaw = 0;
  private pitch = 0;
  private locked = false;
  private readonly onLockChange: (locked: boolean) => void;

  constructor(private readonly element: HTMLElement, onLockChange: (locked: boolean) => void) {
    this.onLockChange = onLockChange;
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.handleBlur);
    document.addEventListener('mousemove', this.handleMouseMove);
    document.addEventListener('mousedown', this.handleMouseDown);
    document.addEventListener('mouseup', this.handleMouseUp);
    document.addEventListener('pointerlockchange', this.handlePointerLockChange);
  }

  get active(): boolean {
    return this.locked;
  }

  requestLock(): void {
    // `unadjustedMovement` gives raw mouse input where supported.
    const req = this.element.requestPointerLock({ unadjustedMovement: true } as PointerLockOptions) as
      | Promise<void>
      | undefined;
    req?.catch(() => this.element.requestPointerLock());
  }

  poll(out: InputState): void {
    const k = this.keys;
    out.moveX = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    out.moveY = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    const l = this.latchedKeys;
    out.jump = k.has('Space') || l.has('Space');
    out.crouch = k.has('ControlLeft') || k.has('KeyC');
    out.walk = k.has('ShiftLeft');
    out.fire = ((this.mouseButtons | this.latchedButtons) & 1) !== 0;
    out.reload = k.has('KeyR') || l.has('KeyR');
    out.lookYaw = this.yaw;
    out.lookPitch = this.pitch;
    this.yaw = 0;
    this.pitch = 0;
  }

  clearLatches(): void {
    this.latchedKeys.clear();
    this.latchedButtons = 0;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.handleBlur);
    document.removeEventListener('mousemove', this.handleMouseMove);
    document.removeEventListener('mousedown', this.handleMouseDown);
    document.removeEventListener('mouseup', this.handleMouseUp);
    document.removeEventListener('pointerlockchange', this.handlePointerLockChange);
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (!this.locked) return;
    this.keys.add(e.code);
    this.latchedKeys.add(e.code);
    // Stop Ctrl+W / Space scrolling etc. while playing.
    if (e.code === 'Space' || e.ctrlKey) e.preventDefault();
  };

  private handleKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private handleBlur = (): void => {
    this.keys.clear();
    this.mouseButtons = 0;
  };

  private handleMouseDown = (e: MouseEvent): void => {
    // Only clicks made while captured count; the click that acquires the lock never fires.
    if (!this.locked) return;
    this.mouseButtons |= 1 << e.button;
    this.latchedButtons |= 1 << e.button;
  };

  private handleMouseUp = (e: MouseEvent): void => {
    this.mouseButtons &= ~(1 << e.button);
  };

  private handleMouseMove = (e: MouseEvent): void => {
    if (!this.locked) return;
    // Some browsers emit one bogus huge delta right after locking or on button presses.
    if (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return;
    const s = CAMERA_CONFIG.mouseSensitivity * this.sensitivity;
    this.yaw -= e.movementX * s;
    this.pitch -= e.movementY * s;
  };

  private handlePointerLockChange = (): void => {
    this.locked = document.pointerLockElement === this.element;
    if (!this.locked) {
      this.keys.clear();
      this.mouseButtons = 0;
      this.clearLatches();
    }
    this.onLockChange(this.locked);
  };
}
