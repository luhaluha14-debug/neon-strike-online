import type { QualityLevel } from '../config';

// Automatic graphics quality (the settings' "자동"). The starting level comes
// from what the device can do (WebGL without a performance caveat, texture
// size limit, cores, memory, touch screen), never from the GPU's name; a
// level measured on this device in earlier sessions wins over that guess.
// While playing, frame times are measured after a warm-up: a sustained drop
// lowers the level on the spot (pixel ratio, shadows: what can change
// without reloading), a short drop, a hitch or a tab switch does not. A
// level that ran well with room to spare is remembered so the next load
// starts one step higher, unless that step already failed here (the
// ceiling): a level is never raised during play, and never raised back to
// one that was too slow, so it cannot flap. Choosing a level by hand turns
// all of this off; choosing 자동 again starts over.

export const LEVELS: readonly QualityLevel[] = ['low', 'medium', 'high'];

export const AUTO_QUALITY = {
  /** Seconds of play not measured after starting, a level change, coming back to the tab or a hitch. */
  warmup: 5,
  /** Seconds of play per measured window. */
  window: 4,
  /** A frame longer than this (s) is a hitch (tab switch, garbage collection, shader compile): the window is dropped. */
  hitch: 0.25,
  /** Too slow: average under this many frames per second... */
  slowFps: 40,
  /** ...or one frame in twenty longer than this (s): uneven frames. */
  slowP95: 1 / 24,
  /** Windows in a row too slow before lowering the level: a drop shorter than a window touches two at most. */
  slowWindows: 3,
  /** Room to spare: average at least this... */
  fastFps: 58,
  /** ...and one frame in twenty no longer than this (s). */
  fastP95: 1 / 40,
  /** Windows in a row with room to spare before the next load may start one step higher. */
  fastWindows: 3,
  /** Seconds between two changes during play. */
  minGap: 30,
} as const;

/** What the device reports. `gpu` null: no WebGL information (safe guess, as before). */
export interface DeviceInfo {
  cores: number | null;
  coarsePointer: boolean;
  /** navigator.deviceMemory (GB), where the browser has it. */
  memoryGb: number | null;
  gpu: GpuInfo | null;
}

export interface GpuInfo {
  /** WebGL runs without a major performance caveat (false: software rendering / blocklisted GPU). */
  hardware: boolean;
  maxTextureSize: number;
}

/** Remembered on this browser between sessions (auto only). */
export interface AutoState {
  /** Level to start at next time (measured), or null: not measured yet. */
  level: QualityLevel | null;
  /** Highest level allowed: a level that was too slow here is never chosen again (null: none). */
  ceiling: QualityLevel | null;
}

const rank = (q: QualityLevel): number => LEVELS.indexOf(q);
const lower = (q: QualityLevel): QualityLevel => LEVELS[Math.max(0, rank(q) - 1)];
const higher = (q: QualityLevel): QualityLevel => LEVELS[Math.min(LEVELS.length - 1, rank(q) + 1)];
const atMost = (q: QualityLevel, cap: QualityLevel | null): QualityLevel => (cap && rank(q) > rank(cap) ? cap : q);

/** Level from the device alone. Never 'high': that is only reached by measuring. */
export function guessQuality(d: DeviceInfo): QualityLevel {
  const lowEnd = (d.cores ?? 4) <= 4 || d.coarsePointer || (d.memoryGb !== null && d.memoryGb <= 2);
  if (!d.gpu) return lowEnd ? 'low' : 'medium';
  if (!d.gpu.hardware || lowEnd || d.gpu.maxTextureSize < 8192) return 'low';
  return 'medium';
}

/** Level an automatic session starts at. */
export function initialQuality(d: DeviceInfo, state: AutoState): QualityLevel {
  return atMost(state.level ?? guessQuality(d), state.ceiling);
}

export type AutoDecision = { kind: 'lower'; level: QualityLevel } | { kind: 'remember'; state: AutoState };

/**
 * Measures one automatic session. `frame(dt, measuring)` each frame with the real frame time;
 * `measuring` false while the frame does not count (menu, lobby, hidden tab, loading).
 * Returns a decision when there is one: lower the level now, or a new state to remember.
 */
export class AutoQualityMonitor {
  level: QualityLevel;
  state: AutoState;
  private warm = AUTO_QUALITY.warmup;
  private times: number[] = [];
  private elapsed = 0;
  private slow = 0;
  private fast = 0;
  private sinceChange = Infinity;
  private raised = false;

  constructor(level: QualityLevel, state: AutoState) {
    this.level = level;
    this.state = { ...state };
  }

  /** Start over with a warm-up (back to the tab, a new map, a pause): what came before does not count. */
  restart(): void {
    this.warm = AUTO_QUALITY.warmup;
    this.times = [];
    this.elapsed = 0;
    this.slow = 0;
    this.fast = 0;
  }

  frame(dt: number, measuring: boolean): AutoDecision | null {
    if (!measuring) {
      // Measuring stops: the next stretch of play starts with a warm-up of its own.
      if (this.warm < AUTO_QUALITY.warmup || this.times.length) this.restart();
      return null;
    }
    this.sinceChange += dt;
    if (dt > AUTO_QUALITY.hitch) {
      this.restart();
      return null;
    }
    if (this.warm > 0) {
      this.warm -= dt;
      return null;
    }
    this.times.push(dt);
    this.elapsed += dt;
    if (this.elapsed < AUTO_QUALITY.window) return null;
    const times = this.times;
    this.times = [];
    this.elapsed = 0;
    return this.judge(times);
  }

  private judge(times: number[]): AutoDecision | null {
    const total = times.reduce((s, t) => s + t, 0);
    const fps = times.length / total;
    const p95 = [...times].sort((a, b) => a - b)[Math.min(times.length - 1, Math.floor(times.length * 0.95))];
    const slow = fps < AUTO_QUALITY.slowFps || p95 > AUTO_QUALITY.slowP95;
    const fast = fps >= AUTO_QUALITY.fastFps && p95 <= AUTO_QUALITY.fastP95;
    this.slow = slow ? this.slow + 1 : 0;
    this.fast = fast ? this.fast + 1 : 0;

    if (this.slow >= AUTO_QUALITY.slowWindows && this.level !== 'low' && this.sinceChange >= AUTO_QUALITY.minGap) {
      const failed = this.level;
      this.level = lower(failed);
      this.state = { level: this.level, ceiling: atMost(this.level, this.state.ceiling) };
      this.sinceChange = 0;
      this.restart();
      return { kind: 'lower', level: this.level };
    }
    if (this.fast >= AUTO_QUALITY.fastWindows && !this.raised) {
      this.fast = 0;
      const next = atMost(higher(this.level), this.state.ceiling);
      // Ran well here: start here next time, or one step higher when that has not failed before.
      this.raised = true;
      if (this.state.level !== next) {
        this.state = { ...this.state, level: next };
        return { kind: 'remember', state: this.state };
      }
    }
    return null;
  }
}

const KEY = 'tactical-fps.auto-quality.v1';

const parseLevel = (v: unknown): QualityLevel | null => (v === 'low' || v === 'medium' || v === 'high' ? v : null);

export function loadAutoState(): AutoState {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    return { level: parseLevel(raw.level), ceiling: parseLevel(raw.ceiling) };
  } catch {
    return { level: null, ceiling: null };
  }
}

export function saveAutoState(state: AutoState | null): void {
  try {
    if (state) localStorage.setItem(KEY, JSON.stringify(state));
    else localStorage.removeItem(KEY);
  } catch {
    // Storage blocked: measured only for this session.
  }
}

/** What this browser reports about the device (no GPU names). */
export function readDevice(): DeviceInfo {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    cores: typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : null,
    coarsePointer: typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches,
    memoryGb: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
    gpu: probeGpu(),
  };
}

function probeGpu(): GpuInfo | null {
  try {
    const canvas = document.createElement('canvas');
    // Without the caveat flag WebGL also runs in software; with it, only on a usable GPU.
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) return null;
    const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    const strict = document.createElement('canvas');
    const hw = strict.getContext('webgl2', { failIfMajorPerformanceCaveat: true }) ?? strict.getContext('webgl', { failIfMajorPerformanceCaveat: true });
    (hw as WebGLRenderingContext | null)?.getExtension('WEBGL_lose_context')?.loseContext();
    return { hardware: !!hw, maxTextureSize: typeof maxTextureSize === 'number' ? maxTextureSize : 0 };
  } catch {
    return null;
  }
}
