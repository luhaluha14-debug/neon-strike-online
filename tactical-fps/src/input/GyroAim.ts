// Gyro aiming (Phase 28, touch controls only): turning the phone turns the view, on top of the finger's
// drag (both add up). The sensor is the browser's `devicemotion` rotation rate; it is asked for only when
// the player switches gyro on (iOS asks permission then), and checked: a browser or device that sends no
// rotation within a moment has no usable gyro, and the controls simply stay touch only (the game never
// depends on it). Nothing is allocated per event or per frame.

export type GyroStatus = 'off' | 'checking' | 'on' | 'unsupported' | 'denied';

/** How long to wait for a first rotation reading before calling the gyro unavailable (ms). */
export const GYRO_CHECK_MS = 1500;
/** Radians of view per radian the phone turns, at sensitivity 1. */
export const GYRO_GAIN = 1;
/** Readings further apart than this (s) are a pause (background, sensor gap): not integrated. */
const MAX_STEP = 0.1;

const DEG = Math.PI / 180;

/**
 * The view turn (rad, look sense: yaw + = left, pitch + = up) for a rotation rate (deg/s, device axes:
 * alpha about the screen normal, beta about the device's x, gamma about its y) held for `dt` seconds with
 * the screen at `angle` degrees (screen.orientation.angle: 0 portrait, 90 / 270 landscape).
 */
export function gyroTurn(alpha: number, beta: number, gamma: number, angle: number, dt: number, out: { yaw: number; pitch: number }): { yaw: number; pitch: number } {
  void alpha;
  const a = ((Math.round(angle / 90) * 90) % 360 + 360) % 360;
  let yaw: number;
  let pitch: number;
  // The screen's up axis turns the view sideways, its right axis up and down.
  if (a === 90) {
    yaw = beta;
    pitch = -gamma;
  } else if (a === 180) {
    yaw = -gamma;
    pitch = -beta;
  } else if (a === 270) {
    yaw = -beta;
    pitch = gamma;
  } else {
    yaw = gamma;
    pitch = beta;
  }
  out.yaw = yaw * DEG * dt;
  out.pitch = pitch * DEG * dt;
  return out;
}

function screenAngle(): number {
  const o = typeof screen !== 'undefined' ? (screen.orientation as ScreenOrientation | undefined) : undefined;
  if (o && typeof o.angle === 'number') return o.angle;
  const w = (globalThis as { orientation?: number }).orientation;
  return typeof w === 'number' ? w : 0;
}

type MotionPermission = { requestPermission?: () => Promise<'granted' | 'denied'> };

export class GyroAim {
  status: GyroStatus = 'off';
  /** Readings received since enabling (tests, the settings page). */
  readings = 0;
  private yaw = 0;
  private pitch = 0;
  private last = -1;
  private listening = false;
  private readonly turn = { yaw: 0, pitch: 0 };
  private checkTimer: ReturnType<typeof setTimeout> | null = null;
  private onStatus: ((s: GyroStatus) => void) | null = null;

  /** Does this browser have the motion sensor interface at all (before asking)? */
  static available(): boolean {
    return typeof window !== 'undefined' && typeof (window as { DeviceMotionEvent?: unknown }).DeviceMotionEvent !== 'undefined';
  }

  /**
   * Switches the gyro on: asks permission where the browser wants it (call from a tap), listens, and
   * reports 'on' with the first rotation reading, or 'unsupported' / 'denied'. `onStatus` hears later
   * changes too (a check that ends after this returns).
   */
  async enable(onStatus?: (s: GyroStatus) => void): Promise<GyroStatus> {
    this.onStatus = onStatus ?? this.onStatus;
    if (this.status === 'on' || this.status === 'checking') return this.status;
    if (!GyroAim.available()) return this.set('unsupported');
    const ctor = (window as unknown as { DeviceMotionEvent: MotionPermission }).DeviceMotionEvent;
    if (typeof ctor.requestPermission === 'function') {
      try {
        if ((await ctor.requestPermission()) !== 'granted') return this.set('denied');
      } catch {
        return this.set('denied');
      }
    }
    this.readings = 0;
    this.last = -1;
    this.listen(true);
    this.set('checking');
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.checkTimer = setTimeout(() => {
      this.checkTimer = null;
      if (this.status === 'checking') {
        this.listen(false);
        this.set('unsupported');
      }
    }, GYRO_CHECK_MS);
    return this.status;
  }

  disable(): void {
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.checkTimer = null;
    this.listen(false);
    this.yaw = this.pitch = 0;
    if (this.status === 'on' || this.status === 'checking') this.set('off');
  }

  /**
   * Hands the turn gathered since the last call to `out` (added), scaled by `sensitivity`; when `use` is
   * false it is dropped instead (gyro set to aiming only and not aiming, the controls not in play).
   */
  take(out: { lookYaw: number; lookPitch: number }, sensitivity: number, use: boolean): void {
    if (use && this.status === 'on') {
      out.lookYaw += this.yaw * sensitivity * GYRO_GAIN;
      out.lookPitch += this.pitch * sensitivity * GYRO_GAIN;
    }
    this.yaw = this.pitch = 0;
  }

  /** Feeds one reading (the `devicemotion` handler; tests call it with made-up rates). */
  reading(alpha: number | null, beta: number | null, gamma: number | null, at: number = performance.now()): void {
    if (beta === null || gamma === null || !Number.isFinite(beta) || !Number.isFinite(gamma)) return;
    this.readings++;
    if (this.status === 'checking') {
      if (this.checkTimer) clearTimeout(this.checkTimer);
      this.checkTimer = null;
      this.set('on');
    }
    const dt = this.last < 0 ? 0 : (at - this.last) / 1000;
    this.last = at;
    if (dt <= 0 || dt > MAX_STEP) return;
    gyroTurn(alpha ?? 0, beta, gamma, screenAngle(), dt, this.turn);
    this.yaw += this.turn.yaw;
    this.pitch += this.turn.pitch;
  }

  private readonly onMotion = (e: DeviceMotionEvent): void => {
    const r = e.rotationRate;
    if (r) this.reading(r.alpha, r.beta, r.gamma, e.timeStamp || performance.now());
  };

  private listen(on: boolean): void {
    if (on === this.listening || typeof window === 'undefined') return;
    this.listening = on;
    if (on) window.addEventListener('devicemotion', this.onMotion);
    else window.removeEventListener('devicemotion', this.onMotion);
  }

  private set(s: GyroStatus): GyroStatus {
    this.status = s;
    this.onStatus?.(s);
    return s;
  }
}
