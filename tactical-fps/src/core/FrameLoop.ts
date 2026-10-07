// Drives the game's render/update callback with an optional frame cap.
//
// Browsers present at most one new image per display refresh, and only when
// the page yields to them between requestAnimationFrame callbacks. Loops
// that render outside rAF (MessageChannel / setTimeout) starve those
// presentation slots, so the screen ends up updating *less* often. The loop
// therefore always rides rAF: "max" runs at the monitor's full refresh rate
// (144/165/240 Hz on high-refresh displays) and lower caps skip refreshes.
// Going above the refresh rate needs the browser itself to be launched
// without vsync (e.g. Chrome's --disable-frame-rate-limit).

export type FrameLimit = 'max' | 240 | 144 | 120 | 60;

export const FRAME_LIMIT_OPTIONS: readonly { value: FrameLimit; label: string }[] = [
  { value: 'max', label: '최대 (모니터 주사율)' },
  { value: 240, label: '240 FPS' },
  { value: 144, label: '144 FPS' },
  { value: 120, label: '120 FPS' },
  { value: 60, label: '60 FPS' },
];

export function parseFrameLimit(value: unknown): FrameLimit | null {
  if (value === 'max') return value;
  const n = Number(value);
  return n === 240 || n === 144 || n === 120 || n === 60 ? n : null;
}

export class FrameLoop {
  private limit: FrameLimit = 'max';
  private running = false;
  private handle = 0;
  /** Time budget carried between refreshes so the average rate matches the cap. */
  private budget = 0;
  private last = 0;

  constructor(private readonly callback: (now: number) => void) {}

  get frameLimit(): FrameLimit {
    return this.limit;
  }

  setLimit(limit: FrameLimit): void {
    this.limit = limit;
    this.budget = 0;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.handle = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.handle);
  }

  private tick = (now: number): void => {
    if (!this.running) return;
    this.handle = requestAnimationFrame(this.tick);
    if (this.limit === 'max') {
      this.last = now;
      this.callback(now);
      return;
    }
    const interval = 1000 / this.limit;
    // Never bank more than one frame, so a hitch doesn't cause a burst.
    this.budget = Math.min(this.budget + (now - this.last), interval * 2);
    this.last = now;
    // Small tolerance: refresh timestamps jitter by a fraction of a millisecond.
    if (this.budget + 0.5 < interval) return;
    this.budget -= interval;
    this.callback(now);
  };
}
