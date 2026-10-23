import { CAMERA_CONFIG } from '../config';
import { defaultControls, type ActionId } from './Controls';
import type { InputSource, InputState } from './InputState';

/** PC input: WASD + mouse look via Pointer Lock. Uses `code` so layouts (e.g. Korean IME) don't matter. */
export class KeyboardMouseInput implements InputSource {
  sensitivity = 1;
  /** Key per action (KeyboardEvent.code); see Controls.ts. Replaced by the settings at start. */
  bindings: Record<ActionId, string> = defaultControls().bindings;
  private keys = new Set<string>();
  private mouseButtons = 0;
  /** Keys / buttons pressed since the last tick consumed input (catches sub-frame taps). */
  private latchedKeys = new Set<string>();
  private latchedButtons = 0;
  /** Weapon selection is an event, not a held state: keep the latest request until a tick consumes it. */
  private requestedSlot = -1;
  private wheel = 0;
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
    document.addEventListener('wheel', this.handleWheel, { passive: true });
    document.addEventListener('pointerlockchange', this.handlePointerLockChange);
    document.addEventListener('contextmenu', this.handleContextMenu);
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
    const l = this.latchedKeys;
    const b = this.bindings;
    const held = (a: ActionId) => k.has(b[a]);
    const pressed = (a: ActionId) => k.has(b[a]) || l.has(b[a]);
    out.moveX = (held('right') ? 1 : 0) - (held('left') ? 1 : 0);
    out.moveY = (held('forward') ? 1 : 0) - (held('back') ? 1 : 0);
    out.jump = pressed('jump');
    // Left Ctrl always crouches too (the browser cannot block Ctrl+W, so C is the primary key).
    out.crouch = held('crouch') || k.has('ControlLeft');
    out.walk = held('walk');
    out.fire = ((this.mouseButtons | this.latchedButtons) & 1) !== 0;
    // Right button: held state only (a scope follows the button).
    out.aim = (this.mouseButtons & 4) !== 0;
    out.reload = pressed('reload');
    out.equipSlot = this.requestedSlot;
    out.equipLast = l.has(b.lastWeapon);
    out.equipCycle = Math.sign(this.wheel);
    out.utility = l.has(b.utility);
    out.inspect = pressed('inspect');
    out.lookYaw = this.yaw;
    out.lookPitch = this.pitch;
    this.yaw = 0;
    this.pitch = 0;
  }

  clearLatches(): void {
    this.latchedKeys.clear();
    this.latchedButtons = 0;
    this.requestedSlot = -1;
    this.wheel = 0;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.handleBlur);
    document.removeEventListener('mousemove', this.handleMouseMove);
    document.removeEventListener('mousedown', this.handleMouseDown);
    document.removeEventListener('mouseup', this.handleMouseUp);
    document.removeEventListener('wheel', this.handleWheel);
    document.removeEventListener('pointerlockchange', this.handlePointerLockChange);
    document.removeEventListener('contextmenu', this.handleContextMenu);
  }

  /** Right click while playing aims; never a browser context menu. */
  private handleContextMenu = (e: MouseEvent): void => {
    if (this.locked) e.preventDefault();
  };

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (!this.locked) return;
    this.keys.add(e.code);
    this.latchedKeys.add(e.code);
    const slot = (['slot1', 'slot2', 'slot3'] as const).findIndex((a) => this.bindings[a] === e.code);
    if (slot >= 0) this.requestedSlot = slot;
    // Stop Ctrl+W / Space scrolling / Tab focus etc. while playing.
    if (e.code === 'Space' || e.code === 'Tab' || e.ctrlKey || e.altKey) e.preventDefault();
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

  private handleWheel = (e: WheelEvent): void => {
    if (!this.locked || e.deltaY === 0) return;
    this.wheel = e.deltaY > 0 ? 1 : -1;
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
