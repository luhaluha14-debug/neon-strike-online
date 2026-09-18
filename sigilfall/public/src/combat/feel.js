/* =============================================================================
   game feel: recoil, screen shake, the small camera dip on landing, the brief
   slow motion on a domain expansion.  it never changes what happens, only how
   hard it lands, and every amount respects the player's shake setting.
   ========================================================================== */
import { clamp, damp, rnd } from '../core/math.js';
import { settings } from '../core/settings.js';

export class Feel {
  constructor(game) {
    this.game = game;
    this.shakeAmp = 0;
    this.shakeX = this.shakeY = this.shakeZ = 0;
    this.kickPitch = this.kickYaw = 0;
    this.kickPitchV = this.kickYawV = 0;
    this.roll = 0;
    this.rollTarget = 0;
    this.dip = 0;
    this.dipV = 0;
    this.fovPunch = 0;
    this.timeScale = 1;
    this.slowUntil = 0;
    this.slowTo = 1;
    this.freeze = 0;
  }

  get scale() { return clamp(settings.get('shake'), 0, 2); }

  shake(amount) { this.shakeAmp = Math.min(1.4, this.shakeAmp + amount * this.scale); }

  recoil(power, spec) {
    const p = power * (spec && spec.kind === 'melee' ? 0.4 : 1);
    this.kickPitchV += p * 0.055;
    this.kickYawV += rnd(-1, 1) * p * 0.02;
    this.fovPunch = Math.min(3.5, this.fovPunch + p * 0.9);
    this.shake(p * 0.05);
  }

  meleeSwing(heavy) {
    this.kickYawV += rnd(-1, 1) * (heavy ? 0.05 : 0.025);
    this.kickPitchV += heavy ? 0.05 : 0.02;
    this.fovPunch = Math.min(4, this.fovPunch + (heavy ? 2.2 : 1));
    if (heavy) this.freeze = Math.max(this.freeze, 0.045);
  }

  hitMarker(head, kill) {
    this.game.hud.hitMarker(head, kill);
    this.freeze = Math.max(this.freeze, kill ? 0.06 : (head ? 0.035 : 0.018));
  }

  damageShake(frac) {
    this.shake(clamp(frac * 2.2, 0.08, 0.7));
    this.dipV += clamp(frac * 2.6, 0.05, 0.5);
  }

  land(k) {
    this.dipV += k * 0.55;
    this.shake(k * 0.18);
  }

  killFlash() {
    this.fovPunch = Math.min(5, this.fovPunch + 2.2);
    this.shake(0.12);
  }

  blinkPunch() {
    this.fovPunch = Math.min(6, this.fovPunch + 4);
    this.shake(0.1);
  }

  domainPunch() {
    this.shake(1.1);
    this.slowMotion(0.45, 0.55);
    this.fovPunch = Math.min(8, this.fovPunch + 6);
  }

  slowMotion(dur, scale) {
    this.slowUntil = performance.now() / 1000 + dur;
    this.slowTo = scale;
  }

  update(realDt) {
    const now = performance.now() / 1000;

    // freeze frames sell impact without stealing control for long
    if (this.freeze > 0) {
      this.freeze = Math.max(0, this.freeze - realDt);
      this.timeScale = 0.06;
    } else if (now < this.slowUntil) {
      this.timeScale = this.slowTo;
    } else {
      this.timeScale = 1;
    }

    const dt = realDt;
    this.shakeAmp = damp(this.shakeAmp, 0, 7.5, dt);
    const a = this.shakeAmp * 0.16;
    this.shakeX = rnd(-a, a);
    this.shakeY = rnd(-a, a);
    this.shakeZ = rnd(-a, a) * 0.5;

    // recoil springs back toward centre
    this.kickPitchV = damp(this.kickPitchV, 0, 14, dt);
    this.kickYawV = damp(this.kickYawV, 0, 14, dt);
    this.kickPitch += this.kickPitchV * dt * 12;
    this.kickYaw += this.kickYawV * dt * 12;
    this.kickPitch = damp(this.kickPitch, 0, 9, dt);
    this.kickYaw = damp(this.kickYaw, 0, 9, dt);

    this.dipV = damp(this.dipV, 0, 12, dt);
    this.dip += this.dipV * dt * 9;
    this.dip = damp(this.dip, 0, 11, dt);

    this.fovPunch = damp(this.fovPunch, 0, 9, dt);

    // lean into strafing a touch
    const f = this.game.player;
    if (f && f.alive) {
      const right = Math.cos(f.yaw) * f.vel.x - Math.sin(f.yaw) * f.vel.z;
      this.rollTarget = clamp(-right / 9, -1, 1) * 0.026;
    } else this.rollTarget = 0;
    this.roll = damp(this.roll, this.rollTarget, 7, dt);
  }
}
