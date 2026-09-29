import { CAMERA_CONFIG } from '../config';
import type { InputSource, InputState } from './InputState';

/** PC input: WASD + mouse look via Pointer Lock. Uses `code` so layouts (e.g. Korean IME) don't matter. */
export class KeyboardMouseInput implements InputSource {
  sensitivity = 1;
  private keys = new Set<string>();
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
    out.jump = k.has('Space');
    out.crouch = k.has('ControlLeft') || k.has('KeyC');
    out.walk = k.has('ShiftLeft');
    out.lookYaw = this.yaw;
    out.lookPitch = this.pitch;
    this.yaw = 0;
    this.pitch = 0;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.handleBlur);
    document.removeEventListener('mousemove', this.handleMouseMove);
    document.removeEventListener('pointerlockchange', this.handlePointerLockChange);
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (!this.locked) return;
    this.keys.add(e.code);
    // Stop Ctrl+W / Space scrolling etc. while playing.
    if (e.code === 'Space' || e.ctrlKey) e.preventDefault();
  };

  private handleKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private handleBlur = (): void => {
    this.keys.clear();
  };

  private handleMouseMove = (e: MouseEvent): void => {
    if (!this.locked) return;
    const s = CAMERA_CONFIG.mouseSensitivity * this.sensitivity;
    this.yaw -= e.movementX * s;
    this.pitch -= e.movementY * s;
  };

  private handlePointerLockChange = (): void => {
    this.locked = document.pointerLockElement === this.element;
    if (!this.locked) this.keys.clear();
    this.onLockChange(this.locked);
  };
}
