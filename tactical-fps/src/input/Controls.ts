// Player-adjustable controls: mouse sensitivity and key bindings.
// Stored under their own key so the existing settings record keeps its format.

export type ActionId =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'jump'
  | 'walk'
  | 'crouch'
  | 'reload'
  | 'slot1'
  | 'slot2'
  | 'slot3'
  | 'lastWeapon'
  | 'utility'
  | 'inspect';

export interface ActionInfo {
  id: ActionId;
  label: string;
  group: '이동' | '전투';
  /** Default key (KeyboardEvent.code). */
  key: string;
  /** Extra fixed key that always works too (e.g. Ctrl for crouch). */
  alt?: string;
}

export const ACTIONS: readonly ActionInfo[] = [
  { id: 'forward', label: '앞으로', group: '이동', key: 'KeyW' },
  { id: 'back', label: '뒤로', group: '이동', key: 'KeyS' },
  { id: 'left', label: '왼쪽', group: '이동', key: 'KeyA' },
  { id: 'right', label: '오른쪽', group: '이동', key: 'KeyD' },
  { id: 'jump', label: '점프', group: '이동', key: 'Space' },
  { id: 'walk', label: '걷기 (조용히)', group: '이동', key: 'ShiftLeft' },
  { id: 'crouch', label: '앉기', group: '이동', key: 'KeyC', alt: 'ControlLeft' },
  { id: 'reload', label: '재장전', group: '전투', key: 'KeyR' },
  { id: 'slot1', label: '주무기 (AR-01)', group: '전투', key: 'Digit1' },
  { id: 'slot2', label: '저격총 (SR-01)', group: '전투', key: 'Digit2' },
  { id: 'slot3', label: '근접 (M9)', group: '전투', key: 'Digit3' },
  { id: 'lastWeapon', label: '이전 무기', group: '전투', key: 'KeyQ' },
  { id: 'utility', label: '투척 장비 (섬광 / 연막, 다시 누르면 전환)', group: '전투', key: 'Digit4' },
  { id: 'inspect', label: '무기 살펴보기', group: '전투', key: 'KeyF' },
];

/** Keys the game reserves (menu, overlays, respawn): never bindable. */
export const RESERVED_KEYS: readonly string[] = ['Escape', 'F3', 'F4'];

export const SENSITIVITY_MIN = 0.2;
export const SENSITIVITY_MAX = 4;

export interface ControlSettings {
  /** Multiplier on the base mouse sensitivity (1 = default). */
  sensitivity: number;
  bindings: Record<ActionId, string>;
}

const KEY = 'tactical-fps.controls.v1';

export function defaultControls(): ControlSettings {
  return { sensitivity: 1, bindings: Object.fromEntries(ACTIONS.map((a) => [a.id, a.key])) as Record<ActionId, string> };
}

export function loadControls(): ControlSettings {
  const c = defaultControls();
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as { sensitivity?: unknown; bindings?: Record<string, unknown> };
    if (typeof raw.sensitivity === 'number' && raw.sensitivity >= SENSITIVITY_MIN && raw.sensitivity <= SENSITIVITY_MAX) c.sensitivity = raw.sensitivity;
    for (const a of ACTIONS) {
      const k = raw.bindings?.[a.id];
      if (typeof k === 'string' && k && !RESERVED_KEYS.includes(k)) c.bindings[a.id] = k;
    }
  } catch {
    // Unreadable or blocked storage: defaults.
  }
  return c;
}

export function saveControls(c: ControlSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    // Storage blocked: the change still applies for this session.
  }
}

/**
 * Binds `action` to `code`. A key already used by another action moves to
 * that action's old key (a swap), so no action is ever left without a key.
 * Returns false for reserved keys.
 */
export function bindKey(c: ControlSettings, action: ActionId, code: string): boolean {
  if (RESERVED_KEYS.includes(code)) return false;
  const previous = c.bindings[action];
  for (const a of ACTIONS) if (a.id !== action && c.bindings[a.id] === code) c.bindings[a.id] = previous;
  c.bindings[action] = code;
  return true;
}

/** Short on-screen name of a key code ("KeyW" → "W", "Digit1" → "1"). */
export function keyLabel(code: string): string {
  const names: Record<string, string> = {
    Space: 'Space',
    ShiftLeft: 'L-Shift',
    ShiftRight: 'R-Shift',
    ControlLeft: 'L-Ctrl',
    ControlRight: 'R-Ctrl',
    AltLeft: 'L-Alt',
    AltRight: 'R-Alt',
    Tab: 'Tab',
    CapsLock: 'Caps',
    Backquote: '`',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backslash: '\\',
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    Enter: 'Enter',
    Backspace: 'Backspace',
  };
  if (names[code]) return names[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad/.test(code)) return 'Num ' + code.slice(6);
  return code;
}
