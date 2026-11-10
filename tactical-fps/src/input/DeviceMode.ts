// Which controls this device gets: PC (keyboard + mouse, pointer lock, the PC HUD) or touch (stick,
// buttons, the mobile HUD). Decided from several signals together, never the screen width alone:
// the primary pointer (coarse / fine), whether any pointer can hover, touch points, the screen's
// short side and orientation, and the input the player actually uses (a real mouse or a finger).
// The player can override it (PC / 모바일); their choice wins over the detection and is kept on this
// browser. `?touch=1` / `?touch=0` in the link still forces either (testing).

const KEY = 'tactical-fps.input-mode.v1';

export type InputModeSetting = 'auto' | 'pc' | 'mobile';
export type DeviceKind = 'phone' | 'tablet' | 'desktop';

export interface DeviceSignals {
  /** Primary pointer is coarse (a finger). */
  coarse: boolean;
  /** Some pointer is fine (a mouse / trackpad / stylus is connected). */
  anyFine: boolean;
  /** Some pointer can hover (a mouse / trackpad). */
  anyHover: boolean;
  /** Touch points the device reports (0 = no touch screen). */
  touchPoints: number;
  /** Short side of the screen (CSS px) and whether it is held in landscape. */
  shortSide: number;
  landscape: boolean;
}

export interface DeviceInfo {
  kind: DeviceKind;
  /** Touch controls when the setting is auto. */
  touch: boolean;
  /** Plain-language reason (settings page). */
  reason: string;
}

export function readSignals(): DeviceSignals {
  const mq = (q: string) => typeof matchMedia === 'function' && matchMedia(q).matches;
  const w = typeof screen !== 'undefined' && screen.width ? screen.width : innerWidth;
  const h = typeof screen !== 'undefined' && screen.height ? screen.height : innerHeight;
  return {
    coarse: mq('(pointer: coarse)'),
    anyFine: mq('(any-pointer: fine)'),
    anyHover: mq('(any-hover: hover)'),
    touchPoints: typeof navigator !== 'undefined' ? (navigator.maxTouchPoints ?? 0) : 0,
    shortSide: Math.min(w, h),
    landscape: innerWidth >= innerHeight,
  };
}

/**
 * Phone: a touch screen with a coarse primary pointer and no fine one, short side under 600 px.
 * Tablet: the same with a larger screen; with a keyboard / trackpad attached (a fine pointer that
 * hovers) it gets the PC controls, otherwise touch. Desktop: everything else (a touch laptop with a
 * mouse stays PC).
 */
export function classify(s: DeviceSignals): DeviceInfo {
  const touchScreen = s.touchPoints > 0;
  if (touchScreen && s.coarse && !s.anyFine) {
    return s.shortSide < 600 ? { kind: 'phone', touch: true, reason: '휴대폰 (터치 화면, 마우스 없음)' } : { kind: 'tablet', touch: true, reason: '태블릿 (터치 화면, 마우스·트랙패드 없음)' };
  }
  if (touchScreen && s.coarse && s.anyFine && s.anyHover) return { kind: 'tablet', touch: false, reason: '태블릿 + 키보드·트랙패드 (PC 조작)' };
  if (touchScreen && s.coarse) return { kind: 'tablet', touch: true, reason: '태블릿 (터치 화면)' };
  return { kind: 'desktop', touch: false, reason: touchScreen ? 'PC (터치 화면 + 마우스)' : 'PC (키보드·마우스)' };
}

/** `?touch=1` / `?touch=0` (tests, or forcing on a device), else null. */
export function urlTouchOverride(): boolean | null {
  const p = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('touch') : null;
  return p === '1' ? true : p === '0' ? false : null;
}

/** Touch controls or not: the link's override, then the player's choice, then the detection. */
export function resolveTouch(setting: InputModeSetting, info: DeviceInfo, url: boolean | null = urlTouchOverride()): boolean {
  if (url !== null) return url;
  if (setting === 'pc') return false;
  if (setting === 'mobile') return true;
  return info.touch;
}

export function loadInputMode(): InputModeSetting {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'pc' || v === 'mobile' || v === 'auto' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export function saveInputMode(m: InputModeSetting): void {
  try {
    localStorage.setItem(KEY, m);
  } catch {
    // Storage blocked: the choice lasts this visit only.
  }
}

/**
 * Auto mode, from the input actually used (only outside play, so a stray touch never swaps the controls
 * mid-fight): a real mouse button on a device with a fine pointer → PC; a finger on a touch screen →
 * touch. Returns the new touch state, or null when it stays as it is.
 */
export function touchFromInput(e: PointerEvent, touchNow: boolean, s: DeviceSignals): boolean | null {
  if (e.pointerType === 'mouse' && touchNow && s.anyFine) return false;
  if (e.pointerType === 'touch' && !touchNow && s.touchPoints > 0) return true;
  return null;
}
