import * as THREE from 'three';
import { PLAYER_CONFIG } from '../config';
import type { BotPose } from './BotModel';
import { meleeSweep, type MeleeStyle } from '../weapons/meleeMotion';

// Phase 31: the motion a third-person character shares between its two bodies (BotModel, AgentModel).
// Presentation only: what it reads comes from the bot's / player's state and it never feeds anything back
// (hit capsule, aim, movement and damage are untouched).

/** Who is looking at the characters (the game camera) and how close one must be for the full animated body. */
export const CHARACTER_VIEW: { eye: THREE.Vector3 | null; nearRange: number } = { eye: null, nearRange: 40 };

/** Full animated body within this distance of the camera, per quality (beyond it the cheaper figure). */
export const CHARACTER_NEAR_RANGE = { low: 14, medium: 28, high: 45 } as const;

/** Eye height standing / crouched (PlayerController: capsule height minus the eye's offset from the top). */
const STAND_EYE = PLAYER_CONFIG.standHeight - PLAYER_CONFIG.eyeOffsetFromTop;
const CROUCH_DROP = PLAYER_CONFIG.standHeight - PLAYER_CONFIG.crouchHeight;

/** A jump to the next spot (respawn, teleport) rather than a step: the speed is not taken from it. */
const TELEPORT_SPEED = 25;

export class CharacterMotion {
  /**
   * Ground velocity the body walks at, from how far the character really moved this frame (smoothed): the
   * gait cycle then advances exactly as the feet move over the ground, so a planted foot does not slide even
   * when the reported velocity lags or leads (network samples, AI steering, a stop against a wall).
   */
  readonly velocity = new THREE.Vector3();
  /** Lean as shown, -1..1: eased toward the reported one (a network update arrives in steps). */
  lean = 0;
  /** 0 standing .. 1 crouched. */
  crouch = 0;
  /** Landing dip (m, ≤ 0), a damped spring kicked when the feet touch down. */
  land = 0;
  /** Seconds since the last knife slash (Infinity: none). */
  sinceSlash = Infinity;
  slashStyle: MeleeStyle = 'm9';
  private landVel = 0;
  private wasGrounded = true;
  private airVy = 0;
  private readonly last = new THREE.Vector3();
  private hasLast = false;
  private breath = Math.random() * 10;

  update(dt: number, p: BotPose): void {
    // Velocity from the displacement (dt 0: a still pose, e.g. the lobby figure).
    if (this.hasLast && dt > 0) {
      const vx = (p.feet.x - this.last.x) / dt;
      const vz = (p.feet.z - this.last.z) / dt;
      if (Math.hypot(vx, vz) > TELEPORT_SPEED) this.velocity.set(p.velocity.x, 0, p.velocity.z);
      else {
        const k = 1 - Math.exp(-18 * dt);
        this.velocity.x += (vx - this.velocity.x) * k;
        this.velocity.z += (vz - this.velocity.z) * k;
      }
    } else this.velocity.set(p.velocity.x, 0, p.velocity.z);
    if (!p.alive) this.velocity.set(0, 0, 0);
    this.last.copy(p.feet);
    this.hasLast = true;

    const lk = 1 - Math.exp(-16 * dt);
    this.lean += ((p.alive ? (p.lean ?? 0) : 0) - this.lean) * (dt > 0 ? lk : 1);
    const ck = 1 - Math.exp(-12 * dt);
    this.crouch += ((p.alive ? (p.crouch ?? 0) : 0) - this.crouch) * (dt > 0 ? ck : 1);

    // Landing: knees give a little, more for a harder landing.
    if (p.grounded && !this.wasGrounded && p.alive) {
      const impact = Math.max(-this.airVy, 3);
      this.landVel -= Math.min(impact / 6, 1.3) * 1.6;
    }
    if (!p.grounded) this.airVy = p.velocity.y;
    this.wasGrounded = p.grounded;
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.landVel += (-150 * this.land - 17 * this.landVel) * h;
      this.land += this.landVel * h;
    }
    this.sinceSlash += dt;
    this.breath += dt;
  }

  /** Eye height for the legs (crouch and landing included). */
  get eyeHeight(): number {
    return STAND_EYE - this.crouch * CROUCH_DROP + Math.min(0, this.land);
  }

  /** Slow breathing of a character standing still (rad of chest rise), 0 while moving. */
  breathing(move01: number): number {
    return Math.sin(this.breath * 1.6) * 0.012 * Math.max(0, 1 - move01 * 2);
  }

  /** Body roll into a sideways movement (rad, + to the right), small: a character leans into the step it takes. */
  strafeRoll(bodyYaw: number): number {
    const right = this.velocity.x * Math.cos(bodyYaw) - this.velocity.z * Math.sin(bodyYaw);
    return THREE.MathUtils.clamp(right / PLAYER_CONFIG.runSpeed, -1, 1) * 0.06;
  }

  /** A knife slash starts now (the same timing as the first-person one). */
  slash(style: MeleeStyle): void {
    this.slashStyle = style;
    this.sinceSlash = 0;
  }

  /** 0..1 sweep of the current slash (0: none). */
  get slashSweep(): number {
    return meleeSweep(this.sinceSlash);
  }

  reset(): void {
    this.hasLast = false;
    this.velocity.set(0, 0, 0);
    this.lean = 0;
    this.crouch = 0;
    this.land = this.landVel = 0;
    this.wasGrounded = true;
    this.sinceSlash = Infinity;
  }
}

/** 0 standing .. 1 crouched, from a capsule height (eased between the two by the controller). */
export function crouchOf(height: number): number {
  return Math.min(1, Math.max(0, (PLAYER_CONFIG.standHeight - height) / CROUCH_DROP));
}

/** Whether the full animated body should show for a character standing at `at` (world). */
export function nearCamera(at: THREE.Vector3): boolean {
  const eye = CHARACTER_VIEW.eye;
  if (!eye) return true;
  const r = CHARACTER_VIEW.nearRange;
  return at.distanceToSquared(eye) <= r * r;
}
