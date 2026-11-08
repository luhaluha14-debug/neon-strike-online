// Frame timing for the F3 statistics overlay, so a player can measure the
// game on their own GPU: average FPS, "1% low" (the FPS of the slowest 1 % of
// frames), the frame time at the 99th percentile and the worst frame, over
// the last ~10 s. Frame times are kept in a fixed ring (no allocation per
// frame); the summary is worked out only when the overlay asks for it.

export const FRAME_WINDOW = 600;

export interface FrameSummary {
  frames: number;
  avgFps: number;
  /** FPS of the slowest 1 % of frames (the mean of their frame times). */
  low1Fps: number;
  /** Frame time (ms) at the 99th percentile, and the worst one. */
  p99Ms: number;
  maxMs: number;
  avgMs: number;
}

export class FrameStats {
  private readonly times = new Float32Array(FRAME_WINDOW);
  private readonly sorted = new Float32Array(FRAME_WINDOW);
  private next = 0;
  private count = 0;

  /** One drawn frame of `dt` seconds. */
  add(dt: number): void {
    if (!(dt > 0) || dt > 1) return; // a pause or a hidden tab is not a frame time
    this.times[this.next] = dt * 1000;
    this.next = (this.next + 1) % FRAME_WINDOW;
    if (this.count < FRAME_WINDOW) this.count++;
  }

  reset(): void {
    this.next = 0;
    this.count = 0;
  }

  summary(): FrameSummary | null {
    const n = this.count;
    if (n < 10) return null;
    const s = this.sorted.subarray(0, n);
    s.set(this.times.subarray(0, n));
    s.sort();
    let sum = 0;
    for (let i = 0; i < n; i++) sum += s[i];
    const slow = Math.max(1, Math.round(n * 0.01));
    let slowSum = 0;
    for (let i = n - slow; i < n; i++) slowSum += s[i];
    const avgMs = sum / n;
    return {
      frames: n,
      avgMs,
      avgFps: 1000 / avgMs,
      low1Fps: 1000 / (slowSum / slow),
      p99Ms: s[Math.min(n - 1, Math.floor(n * 0.99))],
      maxMs: s[n - 1],
    };
  }
}

/** The GPU / driver WebGL reports (shows whether rendering is on a real GPU or in software). */
export function webglRenderer(gl: WebGLRenderingContext | WebGL2RenderingContext): string {
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    return name;
  } catch {
    return 'unknown';
  }
}

/** True for software renderers (no GPU): SwiftShader, llvmpipe, Microsoft Basic Render Driver… */
export function isSoftwareRenderer(name: string): boolean {
  return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name);
}
