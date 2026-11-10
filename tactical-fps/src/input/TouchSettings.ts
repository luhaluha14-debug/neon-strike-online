import { classify, readSignals, resolveTouch } from './DeviceMode';
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
  /**
   * Phase 25 touch conveniences (handling and readability only: no aim help, no change to damage, hit
   * boxes or the host's rules). On / off values are 0 / 1.
   * aimSmoothing: while aiming (ADS / scope), a drag's turn is eased in over a few frames (0 = off; the
   *   whole turn still arrives, nothing is added or aimed for the player).
   */
  aimSmoothing: number;
  /** 발사 버튼 고정: a tap starts firing, the next tap stops (instead of holding the button). */
  fireToggle: number;
  /** Semi-automatic weapons keep firing while the button is held, each round when the weapon allows it (its own fire rate). */
  fireRepeat: number;
  /** Larger minimap on the phone HUD. */
  minimapLarge: number;
  /** Larger ammo count, low ammo in colour. */
  ammoEmphasis: number;
  /** Steadier frame rate first: decorative effects (casings, muzzle smoke, the muzzle light) off. */
  perfPriority: number;
}

/** The on / off settings (stored as 0 / 1). */
export const TOUCH_TOGGLES = ['fireToggle', 'fireRepeat', 'minimapLarge', 'ammoEmphasis', 'perfPriority'] as const;

export const TOUCH_LIMITS = {
  stickX: [0.06, 0.4],
  stickY: [0.1, 0.6],
  buttonsX: [0.01, 0.3],
  buttonsY: [0.02, 0.4],
  buttonScale: [0.7, 1.4],
  lookSensitivity: [0.2, 3],
  adsSensitivity: [0.2, 1.5],
  opacity: [0.25, 1],
  aimSmoothing: [0, 0.8],
  fireToggle: [0, 1],
  fireRepeat: [0, 1],
  minimapLarge: [0, 1],
  ammoEmphasis: [0, 1],
  perfPriority: [0, 1],
} as const satisfies Record<keyof TouchSettings, readonly [number, number]>;

export function defaultTouchSettings(): TouchSettings {
  return {
    stickX: 0.16,
    stickY: 0.3,
    buttonsX: 0.03,
    buttonsY: 0.06,
    buttonScale: 1,
    lookSensitivity: 1,
    adsSensitivity: 0.7,
    opacity: 0.7,
    aimSmoothing: 0,
    fireToggle: 0,
    fireRepeat: 0,
    minimapLarge: 0,
    ammoEmphasis: 0,
    perfPriority: 0,
  };
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
  for (const k of TOUCH_TOGGLES) out[k] = out[k] >= 0.5 ? 1 : 0;
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

/** A device that gets the touch controls by detection alone (DeviceMode decides; `?touch=` still forces). */
export function isTouchDevice(): boolean {
  return resolveTouch('auto', classify(readSignals()));
}
