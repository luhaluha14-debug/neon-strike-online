// Touch controls layout and feel (phones / tablets), stored on this browser
// under its own key, apart from the PC controls (tactical-fps.controls.v1)
// and the general settings: nothing a PC player has set changes.

const KEY = 'tactical-fps.touch.v1';

export interface TouchSettings {
  /** Move stick centre: fraction of the screen width from the left, of the height from the bottom. */
  stickX: number;
  stickY: number;
  /** Button cluster: distance of its corner from the right / bottom edge, fraction of width / height. */
  buttonsX: number;
  buttonsY: number;
  /** Size of the stick and buttons (1 = default). */
  buttonScale: number;
  /** Look speed for a drag (1 = default). */
  lookSensitivity: number;
  /** Look speed multiplier while aiming down sights / scoped (on top of the scope's own slow-down). */
  adsSensitivity: number;
  /** Opacity of the controls (they never hide the view entirely). */
  opacity: number;
}

export const TOUCH_LIMITS = {
  stickX: [0.06, 0.4],
  stickY: [0.1, 0.6],
  buttonsX: [0.01, 0.3],
  buttonsY: [0.02, 0.4],
  buttonScale: [0.7, 1.4],
  lookSensitivity: [0.2, 3],
  adsSensitivity: [0.2, 1.5],
  opacity: [0.25, 1],
} as const satisfies Record<keyof TouchSettings, readonly [number, number]>;

export function defaultTouchSettings(): TouchSettings {
  return { stickX: 0.16, stickY: 0.3, buttonsX: 0.03, buttonsY: 0.06, buttonScale: 1, lookSensitivity: 1, adsSensitivity: 0.7, opacity: 0.7 };
}

/** Each value inside its limits (anything else falls back to the default). */
export function sanitizeTouchSettings(raw: unknown): TouchSettings {
  const d = defaultTouchSettings();
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out = { ...d };
  for (const k of Object.keys(d) as (keyof TouchSettings)[]) {
    const v = r[k];
    const [lo, hi] = TOUCH_LIMITS[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.min(hi, Math.max(lo, v));
  }
  return out;
}

export function loadTouchSettings(): TouchSettings {
  try {
    return sanitizeTouchSettings(JSON.parse(localStorage.getItem(KEY) ?? '{}'));
  } catch {
    return defaultTouchSettings();
  }
}

export function saveTouchSettings(s: TouchSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Storage blocked: the layout just won't persist.
  }
}

/**
 * A phone / tablet without a mouse: touch controls instead of the pointer lock. `?touch=1` / `?touch=0`
 * in the link forces either (testing on a PC, or a touch laptop with a mouse).
 */
export function isTouchDevice(): boolean {
  const p = new URLSearchParams(location.search).get('touch');
  if (p === '1') return true;
  if (p === '0') return false;
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const fine = typeof matchMedia === 'function' && matchMedia('(any-pointer: fine)').matches;
  return (navigator.maxTouchPoints ?? 0) > 0 && coarse && !fine;
}
