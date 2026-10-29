// Tiny offline DSP kit for building sound effects into plain sample arrays.
// Runs once at startup (not per shot), so clarity beats micro-optimisation.

export const SAMPLE_RATE = 48000;

/** Deterministic PRNG (mulberry32) so every variant sounds the same on every load. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buffer(seconds: number): Float32Array {
  return new Float32Array(Math.ceil(seconds * SAMPLE_RATE));
}

/** White noise in [-1, 1]. */
export function noise(seconds: number, rand: () => number): Float32Array {
  const out = buffer(seconds);
  for (let i = 0; i < out.length; i++) out[i] = rand() * 2 - 1;
  return out;
}

export type FilterType = 'lowpass' | 'highpass' | 'bandpass';

/**
 * RBJ biquad, in place. `freq` may be a function of time (seconds) for sweeps;
 * coefficients are then refreshed every 32 samples.
 */
export function biquad(x: Float32Array, type: FilterType, freq: number | ((t: number) => number), q = 0.707): Float32Array {
  let b0 = 0, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
  const set = (f: number): void => {
    const w = (2 * Math.PI * Math.min(Math.max(f, 10), SAMPLE_RATE * 0.45)) / SAMPLE_RATE;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    if (type === 'lowpass') {
      b0 = (1 - cos) / 2 / a0;
      b1 = (1 - cos) / a0;
      b2 = b0;
    } else if (type === 'highpass') {
      b0 = (1 + cos) / 2 / a0;
      b1 = -(1 + cos) / a0;
      b2 = b0;
    } else {
      b0 = alpha / a0;
      b1 = 0;
      b2 = -alpha / a0;
    }
    a1 = (-2 * cos) / a0;
    a2 = (1 - alpha) / a0;
  };
  const sweep = typeof freq === 'function' ? freq : null;
  set(sweep ? sweep(0) : (freq as number));
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    if (sweep && (i & 31) === 0) set(sweep(i / SAMPLE_RATE));
    const x0 = x[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    x[i] = y0;
  }
  return x;
}

/** Multiplies by an envelope function of time (seconds), in place. */
export function shape(x: Float32Array, env: (t: number) => number): Float32Array {
  for (let i = 0; i < x.length; i++) x[i] *= env(i / SAMPLE_RATE);
  return x;
}

/** Linear attack, exponential decay (time constant `tau`), starting at `start`. */
export function expEnv(attack: number, tau: number, start = 0): (t: number) => number {
  return (t) => {
    const u = t - start;
    if (u < 0) return 0;
    if (u < attack) return u / attack;
    return Math.exp(-(u - attack) / tau);
  };
}

/** Sine with an exponential pitch glide from `f0` to `f1` (time constant `glide`). */
export function glideSine(seconds: number, f0: number, f1: number, glide: number): Float32Array {
  const out = buffer(seconds);
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SAMPLE_RATE;
    const f = f1 + (f0 - f1) * Math.exp(-t / glide);
    phase += (2 * Math.PI * f) / SAMPLE_RATE;
    out[i] = Math.sin(phase);
  }
  return out;
}

/** Sum of decaying partials: small metal parts ringing. */
export function ring(seconds: number, partials: readonly [freq: number, amp: number, tau: number][]): Float32Array {
  const out = buffer(seconds);
  for (const [f, amp, tau] of partials) {
    const w = (2 * Math.PI * f) / SAMPLE_RATE;
    for (let i = 0; i < out.length; i++) out[i] += Math.sin(w * i) * amp * Math.exp(-i / SAMPLE_RATE / tau);
  }
  return out;
}

/** Adds `src * gain` into `dst` starting at `offset` seconds. */
export function mix(dst: Float32Array, src: Float32Array, gain = 1, offset = 0): Float32Array {
  const o = Math.round(offset * SAMPLE_RATE);
  const n = Math.min(src.length, dst.length - o);
  for (let i = 0; i < n; i++) dst[o + i] += src[i] * gain;
  return dst;
}

/** Gentle tanh saturation (adds density without hard clipping) then peak-normalise. */
export function finish(x: Float32Array, peak: number, drive = 1.4): Float32Array {
  let max = 0;
  for (let i = 0; i < x.length; i++) {
    x[i] = Math.tanh(x[i] * drive);
    max = Math.max(max, Math.abs(x[i]));
  }
  if (max > 0) {
    const k = peak / max;
    for (let i = 0; i < x.length; i++) x[i] *= k;
  }
  // 3 ms fade-out so a trimmed tail never clicks.
  const fade = Math.min(x.length, Math.round(0.003 * SAMPLE_RATE));
  for (let i = 0; i < fade; i++) x[x.length - 1 - i] *= i / fade;
  return x;
}
