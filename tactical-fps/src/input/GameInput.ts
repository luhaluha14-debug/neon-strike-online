import { KeyboardMouseInput } from './KeyboardMouseInput';
import type { InputState } from './InputState';
import { TouchInput, type TouchCallbacks } from './TouchInput';
import { loadTouchSettings, type TouchSettings } from './TouchSettings';

// The game's one input: the keyboard + mouse input itself (pointer lock on a
// PC, everything it did before, unchanged), plus the touch controls on a
// phone or tablet. Both write the same InputState; "playing" is the pointer
// lock on a PC and the touch session on a touch screen.

export class GameInput extends KeyboardMouseInput {
  /** The touch controls, while the device is in touch mode (null on a PC). */
  touch: TouchInput | null;
  private readonly lockListener: (locked: boolean) => void;
  private touchSettings: TouchSettings;

  constructor(
    element: HTMLElement,
    private readonly hudRoot: HTMLElement,
    touchMode: boolean,
    onLockChange: (locked: boolean) => void,
    private readonly touchCallbacks: TouchCallbacks,
    touchSettings: TouchSettings = loadTouchSettings(),
  ) {
    super(element, onLockChange);
    this.lockListener = onLockChange;
    this.touchSettings = touchSettings;
    this.touch = touchMode ? new TouchInput(hudRoot, touchSettings, touchCallbacks) : null;
  }

  /**
   * Switches between the PC and the touch controls (settings, or auto mode seeing the other kind of
   * input). Whatever was held is let go first on both sides (no key, button, finger or toggle carries
   * over), playing stops, and the touch controls are built or removed.
   */
  setTouchMode(on: boolean, settings: TouchSettings = this.touchSettings): void {
    this.touchSettings = settings;
    if (on === this.touchMode) return;
    this.release();
    this.releaseAll();
    if (on) {
      this.touch = new TouchInput(this.hudRoot, settings, this.touchCallbacks);
    } else {
      this.touch?.dispose();
      this.touch = null;
    }
  }

  get touchMode(): boolean {
    return this.touch !== null;
  }

  override get active(): boolean {
    return super.active || !!this.touch?.active;
  }

  /** Start playing: capture the mouse (PC) or show the touch controls (touch screen). */
  override requestLock(): void {
    const t = this.touch;
    if (!t) {
      super.requestLock();
      return;
    }
    if (t.active) return;
    t.start();
    // Best effort on a phone: full screen, held in landscape (refused silently where not allowed).
    const el = document.documentElement;
    if (document.fullscreenEnabled && !document.fullscreenElement && new URLSearchParams(location.search).get('touch') !== '1')
      el.requestFullscreen?.({ navigationUI: 'hide' })
        ?.then(() => (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> })?.lock?.('landscape'))
        .catch(() => {});
    this.lockListener(true);
  }

  /** Stop playing (pause, menus, results): the touch session or the pointer lock ends. */
  release(): void {
    if (this.touch?.active) {
      this.touch.stop();
      this.lockListener(false);
    } else if (document.pointerLockElement) document.exitPointerLock();
  }

  override poll(out: InputState): void {
    super.poll(out);
    this.touch?.poll(out);
  }

  override clearLatches(): void {
    super.clearLatches();
    this.touch?.clearLatches();
  }

  override dispose(): void {
    super.dispose();
    this.touch?.dispose();
  }
}
