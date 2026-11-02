import type { RecoilProfile } from './WeaponDefinition';

/**
 * View recoil. Each shot adds a target kick; the view eases toward it
 * (`kickResponse`) and, after a short pause in firing, settles back by the
 * amount recoil added — never further, so a player who already pulled down
 * to compensate is not dragged below their aim. With `yawSwayShots` the
 * sideways drift follows the same S-shaped path every spray; with
 * `yawRecovery` the sideways kick settles back as well (what the player
 * already countered is not undone).
 */
export class RecoilController {
  /** Consecutive shots in the current spray. */
  shotIndex = 0;

  /** Kick still waiting to be applied to the view. */
  private pendingPitch = 0;
  private pendingYaw = 0;
  /** Recoil currently baked into the view that recovery may undo. */
  private appliedPitch = 0;
  private appliedYaw = 0;
  private timeSinceShot = Infinity;
  private driftSign = 1;

  constructor(private profile: RecoilProfile, private readonly random: () => number = Math.random) {}

  setProfile(profile: RecoilProfile): void {
    this.profile = profile;
    this.reset();
  }

  /** Accumulated climb of the current spray (radians), for HUD/debug. */
  get climb(): number {
    return this.appliedPitch + this.pendingPitch;
  }

  onShot(): void {
    const p = this.profile;
    if (this.timeSinceShot > p.sprayResetTime) {
      this.shotIndex = 0;
      this.driftSign = p.yawDriftSign ?? (this.random() < 0.5 ? -1 : 1);
    }
    const growth = Math.min(this.shotIndex, p.growthShots) * p.pitchGrowthPerShot;
    const room = Math.max(p.maxPitch - this.climb, 0);
    this.pendingPitch += Math.min(p.pitchPerShot + growth, room);

    let yaw = (this.random() * 2 - 1) * p.yawJitter;
    if (this.shotIndex >= p.yawDriftAfterShots) {
      // S pattern: a half cosine per `yawSwayShots` shots, so the drift eases out, turns and eases back.
      const n = this.shotIndex - p.yawDriftAfterShots;
      const sway = p.yawSwayShots ? Math.cos((Math.PI * (n + 0.5)) / p.yawSwayShots) : 1;
      yaw += this.driftSign * p.yawDrift * sway;
    }
    this.pendingYaw += yaw;

    this.shotIndex++;
    this.timeSinceShot = 0;
  }

  /**
   * The player's own vertical look input (radians, per frame). Pulling down
   * against the climb counts as compensation and reduces what recovery undoes.
   */
  absorbPlayerPitch(delta: number): void {
    if (delta < 0) this.appliedPitch = Math.max(0, this.appliedPitch + delta);
  }

  /** The player's own horizontal look input: turning against the sideways kick counts as compensation. */
  absorbPlayerYaw(delta: number): void {
    if (this.appliedYaw * delta >= 0) return;
    const left = Math.abs(this.appliedYaw) - Math.abs(delta);
    this.appliedYaw = left > 0 ? Math.sign(this.appliedYaw) * left : 0;
  }

  /** Writes the view delta (radians) to add this step into `out`. Positive pitch looks up. */
  update(dt: number, out: { pitch: number; yaw: number }): void {
    const p = this.profile;
    this.timeSinceShot += dt;

    // Ease the pending kick into the view.
    const k = 1 - Math.exp(-p.kickResponse * dt);
    const dPitch = this.pendingPitch * k;
    const dYaw = this.pendingYaw * k;
    this.pendingPitch -= dPitch;
    this.pendingYaw -= dYaw;
    this.appliedPitch += dPitch;
    if (p.yawRecovery) this.appliedYaw += dYaw;

    let recover = 0;
    let recoverYaw = 0;
    if (this.timeSinceShot > p.recoveryDelay) {
      const step = p.recoverySpeed * dt;
      if (this.appliedPitch > 0) {
        recover = Math.min(this.appliedPitch, step);
        // The sideways kick settles in step with the climb (both arrive back together).
        if (this.appliedYaw !== 0) recoverYaw = this.appliedYaw * (recover / this.appliedPitch);
        // Never faster than the recovery speed (the climb may already be gone: pulled down by the player).
        if (Math.abs(recoverYaw) > step) recoverYaw = Math.sign(recoverYaw) * step;
        this.appliedPitch -= recover;
      } else if (this.appliedYaw !== 0) {
        recoverYaw = Math.sign(this.appliedYaw) * Math.min(Math.abs(this.appliedYaw), step);
      }
      this.appliedYaw -= recoverYaw;
    }

    out.pitch = dPitch - recover;
    out.yaw = dYaw - recoverYaw;
  }

  reset(): void {
    this.shotIndex = 0;
    this.pendingPitch = 0;
    this.pendingYaw = 0;
    this.appliedPitch = 0;
    this.appliedYaw = 0;
    this.timeSinceShot = Infinity;
  }
}
