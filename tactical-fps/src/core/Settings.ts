import type { QualityLevel } from '../config';
import { parseFrameLimit, type FrameLimit } from './FrameLoop';

// Per-browser preferences. Stored locally so the page link stays the same
// for every map and setting.

const KEY = 'tactical-fps.settings.v1';

export interface Settings {
  mapId: string | null;
  frameLimit: FrameLimit;
  /** null = pick automatically from the device. */
  quality: QualityLevel | null;
  /** Effects volume 0..1. */
  volume: number;
}

/**
 * Render resolution as a fraction of the quality level's pixel ratio (1 = full). Fewer pixels for a
 * slow phone; only the picture changes, nothing the game decides. Stored under its own key, so the
 * settings record keeps its format.
 */
export const RENDER_SCALE_OPTIONS = [1, 0.85, 0.7, 0.5] as const;
const RENDER_KEY = 'tactical-fps.render.v1';

export function loadRenderScale(): number {
  try {
    const v = Number(localStorage.getItem(RENDER_KEY));
    return (RENDER_SCALE_OPTIONS as readonly number[]).includes(v) ? v : 1;
  } catch {
    return 1;
  }
}

export function saveRenderScale(v: number): void {
  try {
    localStorage.setItem(RENDER_KEY, String(v));
  } catch {
    // Storage blocked: the scale just won't persist.
  }
}

const DEFAULTS: Settings = { mapId: null, frameLimit: 'max', quality: null, volume: 0.75 };

export function parseQuality(value: unknown): QualityLevel | null {
  return value === 'low' || value === 'medium' || value === 'high' ? value : null;
}

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Record<keyof Settings, unknown>>;
    return {
      mapId: typeof raw.mapId === 'string' ? raw.mapId : DEFAULTS.mapId,
      frameLimit: parseFrameLimit(raw.frameLimit) ?? DEFAULTS.frameLimit,
      quality: parseQuality(raw.quality),
      volume: typeof raw.volume === 'number' && raw.volume >= 0 && raw.volume <= 1 ? raw.volume : DEFAULTS.volume,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Private mode / storage blocked: settings just won't persist.
  }
}
