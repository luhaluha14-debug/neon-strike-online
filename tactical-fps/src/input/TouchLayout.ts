// Per-button placement of the touch controls (버튼 배치 편집), stored on this browser apart from the
// touch settings. No layout (null) = the built-in default arrangement, exactly as before: a layout only
// lists the controls the player moved. Positions are the control's centre as a fraction of the safe
// area (inside the notch / home bar insets), so a layout made on one screen lands in the same place,
// relatively, on a screen of another shape; every control is then kept fully inside the safe area.

const KEY = 'tactical-fps.touch-layout.v1';

/** Controls that can be placed: the move stick's home position and every button. */
export const LAYOUT_IDS = ['stick', 'fire', 'aim', 'reload', 'jump', 'crouch', 'weapon', 'use', 'utility', 'pause', 'board', 'buy'] as const;
export type LayoutId = (typeof LAYOUT_IDS)[number];

export const LAYOUT_LABELS: Record<LayoutId, string> = {
  stick: '이동 조이스틱',
  fire: '발사',
  aim: '조준 (ADS)',
  reload: '장전',
  jump: '점프',
  crouch: '앉기',
  weapon: '무기 교체',
  use: '사용 (C4)',
  utility: '투척',
  pause: '일시정지',
  board: '점수판',
  buy: '구매',
};

export interface Placement {
  /** Centre, fraction of the safe area's width / height (0 = left / top edge). */
  x: number;
  y: number;
  /** Size multiplier of the control's own size (on top of the global 버튼 크기). */
  size: number;
  /** Opacity of this control (replaces the global 버튼 투명도 for it). */
  opacity: number;
}

export interface TouchLayout {
  v: 1;
  controls: Partial<Record<LayoutId, Placement>>;
}

export const PLACEMENT_LIMITS = { size: [0.6, 1.8], opacity: [0.2, 1] } as const;

export function emptyLayout(): TouchLayout {
  return { v: 1, controls: {} };
}

/**
 * A stored layout as it may be read back (old, edited by hand, cut off): any entry out of range, of an
 * unknown control or of the wrong shape makes the whole layout fall back to the default arrangement
 * (null), rather than half-applying it.
 */
export function sanitizeLayout(raw: unknown): TouchLayout | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || !r.controls || typeof r.controls !== 'object') return null;
  const out = emptyLayout();
  for (const [id, p] of Object.entries(r.controls as Record<string, unknown>)) {
    if (!(LAYOUT_IDS as readonly string[]).includes(id) || !p || typeof p !== 'object') return null;
    const q = p as Record<string, unknown>;
    const num = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
    if (!num(q.x, 0, 1) || !num(q.y, 0, 1) || !num(q.size, ...PLACEMENT_LIMITS.size) || !num(q.opacity, ...PLACEMENT_LIMITS.opacity)) return null;
    out.controls[id as LayoutId] = { x: q.x as number, y: q.y as number, size: q.size as number, opacity: q.opacity as number };
  }
  return out;
}

export function loadTouchLayout(): TouchLayout | null {
  try {
    const s = localStorage.getItem(KEY);
    return s ? sanitizeLayout(JSON.parse(s)) : null;
  } catch {
    return null;
  }
}

/** Saves a layout; null (or one that moves nothing) removes it: the default arrangement. */
export function saveTouchLayout(l: TouchLayout | null): void {
  try {
    if (!l || Object.keys(l.controls).length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(l));
  } catch {
    // Storage blocked: the layout lasts this visit only.
  }
}

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

let probe: HTMLDivElement | null = null;
/** The safe-area insets (notch, home bar) in CSS px, measured once per call through a hidden probe. */
export function safeInsets(): Insets {
  if (!probe) {
    probe = document.createElement('div');
    probe.style.cssText =
      'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
    document.body.appendChild(probe);
  }
  const c = getComputedStyle(probe);
  return { top: parseFloat(c.paddingTop) || 0, right: parseFloat(c.paddingRight) || 0, bottom: parseFloat(c.paddingBottom) || 0, left: parseFloat(c.paddingLeft) || 0 };
}

/**
 * Pixel centre of a placement on this screen, kept so a control of `w` × `h` px stays wholly inside the
 * safe area (the relative position is honoured as far as the screen allows).
 */
export function placementCentre(p: Placement, w: number, h: number, ins: Insets = safeInsets(), vw = innerWidth, vh = innerHeight): { x: number; y: number } {
  const aw = Math.max(1, vw - ins.left - ins.right);
  const ah = Math.max(1, vh - ins.top - ins.bottom);
  const clamp = (v: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v)));
  return {
    x: clamp(ins.left + p.x * aw, ins.left + w / 2, vw - ins.right - w / 2),
    y: clamp(ins.top + p.y * ah, ins.top + h / 2, vh - ins.bottom - h / 2),
  };
}

/** The relative position (placement x / y) of a pixel centre on this screen. */
export function relativeOf(cx: number, cy: number, ins: Insets = safeInsets(), vw = innerWidth, vh = innerHeight): { x: number; y: number } {
  const aw = Math.max(1, vw - ins.left - ins.right);
  const ah = Math.max(1, vh - ins.top - ins.bottom);
  return { x: Math.min(1, Math.max(0, (cx - ins.left) / aw)), y: Math.min(1, Math.max(0, (cy - ins.top) / ah)) };
}

/** Rectangles that overlap (by more than `slack` px), as pairs of indices. */
export function overlaps(rects: readonly { left: number; top: number; right: number; bottom: number }[], slack = 2): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > slack && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > slack) out.push([i, j]);
    }
  return out;
}
