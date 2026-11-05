// First-person camera motion: what a body does to the eye while it moves.
// Steps lift and drop the eye a little (walking less than running, crouched
// least) with a slight side-to-side shift and roll; a landing dips the eye by
// how hard it came down (a bunny hop barely, a fall from a roof clearly); in
// the air nothing bobs; standing still the eye breathes, barely. Aiming
// steadies all of it.
//
// Only the camera's POSITION (a few millimetres to a few centimetres) and its
// ROLL change. Pitch and yaw are never touched, so the crosshair stays exactly
// on the line every round is fired along (rounds come from the player's eye
// and look angles, not from the camera), and mouse sensitivity, aim
// sensitivity and recoil are unaffected. Pure state, no allocation.

export interface CameraMotionInput {
  /** Horizontal speed (m/s). */
  speed: number;
  /** Speed of a full run (m/s): the scale for "walking" vs "running". */
  runSpeed: number;
  /** Vertical velocity (m/s, + up). */
  vy: number;
  grounded: boolean;
  crouching: boolean;
  /** 0 = hip, 1 = fully aimed (scope): the motion is steadied. */
  aim: number;
}

/** Amplitudes (m / rad). Small on purpose: no swaying horizon, nothing to make anyone queasy. */
export const CAMERA_MOTION = {
  /** Eye drop per step at a full run; walking is about half, crouched a third. */
  bob: 0.011,
  /** Side shift per stride (m) and roll (rad) at a full run. */
  side: 0.004,
  roll: 0.0035,
  /** Distance per step (m) at a run; a walk takes shorter steps. */
  stepLength: 0.78,
  /** Landing dip: m per m/s of impact speed above `landFrom`, capped at `landMax`. */
  landPerSpeed: 0.0065,
  landFrom: 1.5,
  landMax: 0.075,
  /** Breathing at rest (m) and its rate (rad/s ≈ 0.27 Hz). */
  breath: 0.0016,
  breathRate: 1.7,
  /** What aiming leaves of the motion. */
  aimed: 0.25,
} as const;

export class CameraMotion {
  /** Offsets to apply this frame: up (m), right (m), roll (rad). */
  y = 0;
  x = 0;
  roll = 0;
  /** Stride phase (rad): one full turn = two steps (left, right). Shared with the weapon's bob. */
  phase = 0;
  /** Steps taken (footsteps) and landings (with impact speed) since the last read (`takeEvents`). */
  private steps = 0;
  private landing = 0;
  private amount = 0;
  private breathPhase = 0;
  private land = 0;
  private landVel = 0;
  private wasGrounded = true;
  private airVy = 0;
  private lastVy = 0;
  private aimS = 0;

  update(dt: number, m: CameraMotionInput): void {
    const C = CAMERA_MOTION;
    dt = Math.min(dt, 0.1);
    // Landing: grounded again after falling, or a hop that left again on the same tick (bunny hop:
    // the controller never reports the ground, but the fall turned into a climb).
    let impact = 0;
    if (m.grounded && !this.wasGrounded) impact = -this.airVy;
    else if (!m.grounded && this.lastVy < -1 && m.vy > 1) impact = -this.lastVy;
    if (!m.grounded) this.airVy = m.vy;
    this.wasGrounded = m.grounded;
    this.lastVy = m.vy;
    if (impact > C.landFrom) {
      const dip = Math.min((impact - C.landFrom) * C.landPerSpeed, C.landMax);
      // Spring impulse sized so the dip peaks near `dip`.
      this.landVel -= dip * 14;
      this.landing = Math.max(this.landing, impact);
    }
    // Landing spring: down quickly, back within ~0.4 s, no wobble.
    const steps = Math.ceil(dt / (1 / 240));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.landVel += (-140 * this.land - 22 * this.landVel) * h;
      this.land += this.landVel * h;
    }

    // Steps: the stride advances with distance covered on the ground.
    const run01 = m.runSpeed > 0 ? Math.min(m.speed / m.runSpeed, 1.25) : 0;
    const target = m.grounded && m.speed > 0.3 ? run01 : 0;
    this.amount += (target - this.amount) * (1 - Math.exp(-(target > this.amount ? 8 : 5) * dt));
    if (m.grounded && m.speed > 0.3) {
      const stepLen = C.stepLength * (0.7 + 0.3 * Math.min(run01, 1));
      const before = Math.floor(this.phase / Math.PI);
      this.phase += (m.speed / stepLen) * Math.PI * dt;
      this.steps += Math.floor(this.phase / Math.PI) - before;
      if (this.phase > Math.PI * 2000) this.phase -= Math.PI * 2000;
    }
    const gait = m.crouching ? 0.35 : 0.45 + 0.55 * Math.min(run01, 1);
    this.aimS += (Math.min(Math.max(m.aim, 0), 1) - this.aimS) * (1 - Math.exp(-12 * dt));
    const steady = 1 - (1 - C.aimed) * this.aimS;
    const a = this.amount * gait * steady;
    // The eye is lowest as each foot lands (twice per stride), shifts toward the stepping side.
    this.y = -Math.abs(Math.sin(this.phase)) * C.bob * a + this.land;
    this.x = Math.sin(this.phase) * C.side * a;
    this.roll = Math.sin(this.phase) * C.roll * a;

    // Breathing, only while nearly still.
    this.breathPhase += dt * C.breathRate;
    const still = Math.max(0, 1 - this.amount * 3);
    this.y += Math.sin(this.breathPhase) * C.breath * still * steady;
  }

  /** Footsteps and the hardest landing (impact speed, m/s; 0 = none) since the last call. */
  takeEvents(out: { steps: number; landing: number }): { steps: number; landing: number } {
    out.steps = this.steps;
    out.landing = this.landing;
    this.steps = 0;
    this.landing = 0;
    return out;
  }

  reset(): void {
    this.y = this.x = this.roll = 0;
    this.amount = this.land = this.landVel = 0;
    this.steps = this.landing = 0;
    this.wasGrounded = true;
    this.airVy = this.lastVy = 0;
  }
}
