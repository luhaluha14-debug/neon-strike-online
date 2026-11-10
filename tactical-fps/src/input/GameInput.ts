import { KeyboardMouseInput } from './KeyboardMouseInput';
import type { InputState } from './InputState';
import { TouchInput, type TouchCallbacks } from './TouchInput';
import { loadTouchSettings, type TouchSettings } from './TouchSettings';

// The game's one input: the keyboard + mouse input itself (pointer lock on a
// PC, everything it did before, unchanged), plus the touch controls on a
// phone or tablet. Both write the same InputState; "playing" is the pointer
// lock on a PC and the touch session on a touch screen.

export class GameInput extends KeyboardMouseInput {
  readonly touch: TouchInput | null;
  private readonly lockListener: (locked: boolean) => void;

  constructor(element: HTMLElement, hudRoot: HTMLElement, touchMode: boolean, onLockChange: (locked: boolean) => void, touchCallbacks: TouchCallbacks, touchSettings: TouchSettings = loadTouchSettings()) {
    super(element, onLockChange);
    this.lockListener = onLockChange;
    this.touch = touchMode ? new TouchInput(hudRoot, touchSettings, touchCallbacks) : null;
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
