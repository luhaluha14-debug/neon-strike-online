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

/**
 * Phase 32: how hard each kind of weapon shakes the eye per round (CameraMotion.shot): a pistol snaps, an SMG
 * buzzes lightly, a rifle thumps, a marksman / bolt-action rifle and a shotgun jolt, a machine gun shudders.
 */
export const SHOT_SHAKE = { pistol: 0.55, smg: 0.35, rifle: 0.5, dmr: 0.85, sniper: 1.15, shotgun: 1.1, lmg: 0.6, melee: 0 } as const;

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
  /**
   * Phase 32: shot shake — the eye's roll and a small push up / back from each round (presentation only: the
   * aim's pitch and yaw are the weapon's own recoil, untouched). Damped springs, settled within ~0.15 s.
   */
  private shotRoll = 0;
  private shotRollVel = 0;
  private shotLift = 0;
  private shotLiftVel = 0;

  /** A round fired: `k` how hard this weapon shakes the eye (SHOT_SHAKE), `side` -1..1 which way it rolls. */
  shot(k: number, side: number): void {
    const aimedK = 1 - 0.45 * this.aimS;
    this.shotRollVel += side * k * 0.09 * aimedK;
    this.shotLiftVel += k * 0.12 * aimedK;
  }

  /**
   * Phase 32: the player was hit from `angle` (0 ahead, + right): the eye flinches away from it a touch (roll
   * and a dip), by damage. Presentation only: the aim is untouched.
   */
  hurt(angle: number, amount: number): void {
    const k = Math.min(1, 0.3 + amount / 60);
    // (A negative roll tilts the view right, as a lean right does: a hit from the right tilts it left, + roll.)
    this.shotRollVel += Math.sin(angle) * k * 0.16;
    this.shotLiftVel -= k * 0.35;
  }

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
      this.shotRollVel += (-900 * this.shotRoll - 52 * this.shotRollVel) * h;
      this.shotRoll += this.shotRollVel * h;
      this.shotLiftVel += (-700 * this.shotLift - 50 * this.shotLiftVel) * h;
      this.shotLift += this.shotLiftVel * h;
    }
    // Settled: exactly at rest again (no lingering hair of roll).
    if (Math.abs(this.shotRoll) < 1e-5 && Math.abs(this.shotRollVel) < 1e-4) this.shotRoll = this.shotRollVel = 0;
    if (Math.abs(this.shotLift) < 1e-5 && Math.abs(this.shotLiftVel) < 1e-4) this.shotLift = this.shotLiftVel = 0;

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
    this.roll = Math.sin(this.phase) * C.roll * a + this.shotRoll;

    // Breathing, only while nearly still.
    this.breathPhase += dt * C.breathRate;
    const still = Math.max(0, 1 - this.amount * 3);
    this.y += Math.sin(this.breathPhase) * C.breath * still * steady;
    this.y += this.shotLift * 0.01;
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
    this.shotRoll = this.shotRollVel = this.shotLift = this.shotLiftVel = 0;
    this.steps = this.landing = 0;
    this.wasGrounded = true;
    this.airVy = this.lastVy = 0;
  }
}
