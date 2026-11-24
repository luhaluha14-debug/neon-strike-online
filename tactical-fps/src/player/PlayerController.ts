import * as THREE from 'three';
import { CAMERA_CONFIG, LEAN_CONFIG, PLAYER_CONFIG } from '../config';
import type { InputState } from '../input/InputState';
import type { CollisionWorld, CapsuleHit } from '../world/CollisionWorld';

const _wish = new THREE.Vector3();
const _segment = new THREE.Line3();
const _down = new THREE.Vector3(0, -1, 0);
const _normal = new THREE.Vector3();
/** Phase 33: the lean's motion is integrated in steps of at most this (s): frame-rate independent. */
const LEAN_STEP = 1 / 240;
const _leanEye = new THREE.Vector3();
const _leanDir = new THREE.Vector3();

/**
 * Kinematic first-person character. `position` is the bottom of the capsule
 * (the feet). Runs on a fixed tick so the same code can later be used for
 * client prediction against an authoritative server.
 */
export class PlayerController {
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  grounded = false;
  crouching = false;
  /** Current capsule height, eased between stand and crouch. */
  height: number = PLAYER_CONFIG.standHeight;
  health: number = PLAYER_CONFIG.maxHealth;
  /**
   * Phase 30 lean as it is now, -1 (left) .. 1 (right): eased toward what is held and cut short by a wall at
   * that side. The eye, the camera, the shots and the hit capsule's top all follow it (leanShift).
   */
  lean = 0;
  /** Eased toward the held lean before the wall limit. */
  private leanWant = 0;
  /**
   * Phase 33: the lean's own speed (leans /s). The lean moves like a body does: it speeds up from rest, brakes
   * to stop exactly on the side held, and a switch to the other side turns over at speed through upright
   * (Phase 31's ease-in-out curve stopped there, at zero speed).
   */
  private leanVel = 0;
  /** The lean shown is held back by a wall (or still growing back out from one). */
  private leanCapped = false;

  private jumpHeld = false;
  /** Time left on a jump press made in the air (it fires on landing; see jumpBuffer). */
  private jumpBuffered = 0;
  /** Ticks on the ground in a row (0 on the tick it lands). */
  private groundTicks = 0;
  /** In the air because of a jump (air movement), not a fall (the original fall control). */
  private jumped = false;
  /** Pushed sideways by a wall or slope during this tick (any collision pass; see the wall-slide limit). */
  private wallContact = false;
  private readonly hit: CapsuleHit = { grounded: false, groundNormal: new THREE.Vector3(0, 1, 0), hitCeiling: false };

  constructor(private readonly world: CollisionWorld) {}

  teleport(position: THREE.Vector3, yaw: number): void {
    this.position.copy(position);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
    this.grounded = false;
    this.crouching = false;
    this.height = PLAYER_CONFIG.standHeight;
    this.jumpBuffered = 0;
    this.groundTicks = 0;
    this.jumped = false;
    this.wallContact = false;
    this.lean = this.leanWant = this.leanVel = 0;
    this.leanCapped = false;
  }

  /** Mouse look is applied per render frame for responsiveness, not per tick. */
  applyLook(input: InputState): void {
    this.yaw += input.lookYaw;
    this.pitch = THREE.MathUtils.clamp(this.pitch + input.lookPitch, -CAMERA_CONFIG.maxPitch, CAMERA_CONFIG.maxPitch);
    input.lookYaw = 0;
    input.lookPitch = 0;
  }

  /** Adds view rotation from outside sources (weapon recoil). */
  addViewKick(pitch: number, yaw: number): void {
    this.yaw += yaw;
    this.pitch = THREE.MathUtils.clamp(this.pitch + pitch, -CAMERA_CONFIG.maxPitch, CAMERA_CONFIG.maxPitch);
  }

  get eyeHeight(): number {
    return this.height - PLAYER_CONFIG.eyeOffsetFromTop;
  }

  step(input: InputState, dt: number): void {
    const cfg = PLAYER_CONFIG;
    this.updateCrouch(input.crouch, dt);
    this.updateLean(input.lean ?? 0, dt);

    // Wish direction in world space from yaw only.
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    _wish.set(input.moveX * cos - input.moveY * sin, 0, -input.moveX * sin - input.moveY * cos);
    if (_wish.lengthSq() > 1) _wish.normalize();

    const maxSpeed = this.crouching ? cfg.crouchSpeed : input.walk ? cfg.walkSpeed : cfg.runSpeed;
    // A jump is a fresh press (holding the key does not hop again); pressed in the air it waits for the landing.
    const pressed = input.jump && !this.jumpHeld;
    this.wallContact = false;
    /** Ground ticks: speed before accelerating, to limit a wall slide (see below); -1 = not a ground tick. */
    let groundPre = -1;
    if (pressed && !this.grounded) this.jumpBuffered = cfg.jumpBuffer;

    if (this.grounded && this.groundTicks === 0 && (pressed || this.jumpBuffered > 0) && !this.crouching) {
      // Bunny hop: jumping again on the very tick of landing skips the ground friction, so a
      // well-timed hop keeps its speed (a late one has already lost some to friction).
      this.velocity.y = cfg.jumpVelocity;
      this.grounded = false;
      this.jumpBuffered = 0;
      this.jumped = true;
      this.airMove(_wish, maxSpeed, dt);
    } else if (this.grounded) {
      this.groundTicks++;
      // Friction then acceleration toward the target velocity (crisp, low-slide stops).
      const speed = Math.hypot(this.velocity.x, this.velocity.z);
      if (speed > 0) {
        const drop = speed * cfg.groundFriction * dt;
        const scale = Math.max(speed - drop, 0) / speed;
        this.velocity.x *= scale;
        this.velocity.z *= scale;
      }
      groundPre = Math.hypot(this.velocity.x, this.velocity.z);
      this.accelerate(_wish, maxSpeed, cfg.groundAccel, dt);

      if (pressed && !this.crouching) {
        this.velocity.y = cfg.jumpVelocity;
        this.grounded = false;
        this.jumped = true;
      } else {
        this.velocity.y = 0;
      }
    } else {
      if (this.jumped) this.airMove(_wish, maxSpeed, dt);
      else this.accelerate(_wish, maxSpeed * cfg.fallControl + 0.01, cfg.fallAccel, dt);
      this.velocity.y = Math.max(this.velocity.y - cfg.gravity * dt, -cfg.maxFallSpeed);
    }
    this.jumpHeld = input.jump;
    this.jumpBuffered = Math.max(0, this.jumpBuffered - dt);

    const wasGrounded = this.grounded;
    const jumped = this.velocity.y > 0;
    this.position.addScaledVector(this.velocity, dt);
    this.collide();

    // Stay glued to the ground when walking down ramps and small steps.
    if (wasGrounded && !this.grounded && !jumped) this.snapToGround();

    if (this.grounded && this.velocity.y < 0) this.velocity.y = 0;
    if (groundPre >= 0 && this.wallContact) {
      // Running diagonally into a wall: the wall takes away the part of the velocity going into it
      // each tick, so the acceleration never sees the wish speed reached and kept adding along the
      // wall (up to ~14 m/s). Pushed by a wall, a ground tick may not end faster than it began or
      // than the move speed. (Walking up ramps and steps stays under the move speed: unchanged.)
      const h = Math.hypot(this.velocity.x, this.velocity.z);
      const limit = Math.max(groundPre, maxSpeed);
      if (h > limit) {
        this.velocity.x *= limit / h;
        this.velocity.z *= limit / h;
      }
    }
    if (!this.grounded) this.groundTicks = 0;
    else this.jumped = false;
  }

  /** Eases the lean toward `want` (-1..1) and keeps it clear of a wall at that side. */
  updateLean(want: number, dt: number): void {
    const target = Math.max(-1, Math.min(1, want));
    const A = LEAN_CONFIG.accel;
    const V = LEAN_CONFIG.speed;
    // Fixed small steps: the same motion at any frame / tick rate.
    const steps = Math.max(1, Math.ceil(dt / LEAN_STEP));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const d = target - this.leanWant;
      if (Math.abs(d) < 1e-4 && Math.abs(this.leanVel) < 0.2) {
        this.leanWant = target;
        this.leanVel = 0;
        continue;
      }
      const dir = Math.sign(d);
      // Brake once the stop needs all the room left; otherwise speed up toward the side held.
      const braking = Math.sign(this.leanVel) === dir && (this.leanVel * this.leanVel) / (2 * A) >= Math.abs(d);
      this.leanVel = Math.max(-V, Math.min(V, this.leanVel + (braking ? -dir : dir) * A * h));
      this.leanWant += this.leanVel * h;
      // Never past a full lean (a switch while moving fast toward one side coasts, then turns at the stop).
      if (Math.abs(this.leanWant) > 1) {
        this.leanWant = Math.sign(this.leanWant);
        this.leanVel = 0;
      }
      // Arrived (never past the side held).
      if ((target - this.leanWant) * dir <= 0) {
        this.leanWant = target;
        this.leanVel = 0;
      }
    }
    this.applyLeanLimit(this.leanWant, dt);
  }

  /** A lean another machine reported (a member's, on the host): the same wall limit here, so no peeking through. */
  setReportedLean(v: number): void {
    const l = Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
    this.leanWant = l;
    this.leanVel = 0;
    this.applyLeanLimit(l);
  }

  /**
   * The lean after the wall limit. A wall closing in cuts it at once (no peeking through); when the room opens
   * again (Phase 33) it grows back at most LEAN_CONFIG.wallRelease /s instead of jumping out (`dt` given).
   */
  private applyLeanLimit(want: number, dt = Infinity): void {
    if (Math.abs(want) < 1e-3) {
      this.lean = 0;
      this.leanCapped = false;
      return;
    }
    const side = Math.sign(want);
    _leanEye.set(this.position.x, this.position.y + this.eyeHeight, this.position.z);
    _leanDir.set(Math.cos(this.yaw) * side, 0, -Math.sin(this.yaw) * side);
    const reach = LEAN_CONFIG.offset * Math.abs(want);
    const hit = this.world.raycast(_leanEye, _leanDir, reach + LEAN_CONFIG.wallMargin);
    const room = hit === null ? reach : Math.max(0, Math.min(reach, hit - LEAN_CONFIG.wallMargin));
    let lean = side * (room / LEAN_CONFIG.offset);
    // Out from behind a wall edge: grow back smoothly rather than jump to the full lean held.
    if (this.leanCapped && Math.sign(this.lean) === side && Math.abs(lean) > Math.abs(this.lean)) {
      lean = side * Math.min(Math.abs(lean), Math.abs(this.lean) + LEAN_CONFIG.wallRelease * dt);
    }
    this.lean = lean;
    this.leanCapped = Math.abs(lean) < Math.abs(want) - 1e-4;
  }

  /** Where the lean puts the eye relative to the upright eye (world, m). */
  leanShift(out: THREE.Vector3): THREE.Vector3 {
    const k = this.lean * LEAN_CONFIG.offset;
    return out.set(Math.cos(this.yaw) * k, -Math.abs(this.lean) * LEAN_CONFIG.drop, -Math.sin(this.yaw) * k);
  }

  /** The eye in the world, lean included: where shots leave and the camera sits. */
  eyePosition(out: THREE.Vector3): THREE.Vector3 {
    this.leanShift(out);
    out.x += this.position.x;
    out.y += this.position.y + this.eyeHeight;
    out.z += this.position.z;
    return out;
  }

  /**
   * Air acceleration (see PLAYER_CONFIG.airAccel): the wish direction may add
   * at most `airWishSpeed` along itself, at `airAccel` × the move speed per
   * second. Never pushes the horizontal speed past `maxAirSpeed`.
   */
  private airMove(wishDir: THREE.Vector3, maxSpeed: number, dt: number): void {
    const cfg = PLAYER_CONFIG;
    const len = wishDir.length();
    if (len < 1e-4) return;
    const dirX = wishDir.x / len;
    const dirZ = wishDir.z / len;
    const wishSpeed = maxSpeed * len;
    const add = Math.min(wishSpeed, cfg.airWishSpeed) - (this.velocity.x * dirX + this.velocity.z * dirZ);
    if (add <= 0) return;
    const before = Math.hypot(this.velocity.x, this.velocity.z);
    const gain = Math.min(cfg.airAccel * wishSpeed * dt, add);
    this.velocity.x += dirX * gain;
    this.velocity.z += dirZ * gain;
    const after = Math.hypot(this.velocity.x, this.velocity.z);
    const limit = Math.max(before, cfg.maxAirSpeed);
    if (after > limit) {
      this.velocity.x *= limit / after;
      this.velocity.z *= limit / after;
    }
  }

  private accelerate(wishDir: THREE.Vector3, wishSpeed: number, accel: number, dt: number): void {
    const len = wishDir.length();
    if (len < 1e-4) return;
    const target = wishSpeed * len;
    const dirX = wishDir.x / len;
    const dirZ = wishDir.z / len;
    const current = this.velocity.x * dirX + this.velocity.z * dirZ;
    const add = target - current;
    if (add <= 0) return;
    const gain = Math.min(accel * target * dt, add);
    this.velocity.x += dirX * gain;
    this.velocity.z += dirZ * gain;
  }

  private capsuleSegment(out: THREE.Line3, height = this.height): THREE.Line3 {
    const r = PLAYER_CONFIG.radius;
    out.start.set(this.position.x, this.position.y + r, this.position.z);
    out.end.set(this.position.x, this.position.y + height - r, this.position.z);
    return out;
  }

  private collide(): void {
    const seg = this.capsuleSegment(_segment);
    const before = seg.start.clone();
    this.world.resolveCapsule(seg, PLAYER_CONFIG.radius, PLAYER_CONFIG.walkableNormalY, this.hit);

    const dx = seg.start.x - before.x;
    const dy = seg.start.y - before.y;
    const dz = seg.start.z - before.z;
    this.position.x += dx;
    this.position.y += dy;
    this.position.z += dz;

    // Remove velocity going into the surfaces we were pushed out of.
    const pushLen = Math.hypot(dx, dz);
    if (pushLen > 1e-6) this.wallContact = true;
    if (pushLen > 1e-6) {
      const nx = dx / pushLen;
      const nz = dz / pushLen;
      const into = this.velocity.x * nx + this.velocity.z * nz;
      if (into < 0) {
        this.velocity.x -= nx * into;
        this.velocity.z -= nz * into;
      }
    }
    if (this.hit.hitCeiling && this.velocity.y > 0) this.velocity.y = 0;
    this.grounded = this.hit.grounded && this.velocity.y <= 0;
  }

  private snapToGround(): void {
    const cfg = PLAYER_CONFIG;
    // Cast from the center of the bottom sphere; the sphere surface is `radius` below it.
    const origin = new THREE.Vector3(this.position.x, this.position.y + cfg.radius, this.position.z);
    const dist = this.world.raycast(origin, _down, cfg.radius + cfg.groundSnapDistance, _normal, true);
    if (dist === null) return;
    if (Math.abs(_normal.y) < cfg.walkableNormalY) return;
    this.position.y -= Math.max(dist - cfg.radius, 0);
    this.collide();
    if (!this.hit.grounded) {
      // Ray hit but capsule doesn't rest there (edge case) — treat as grounded anyway
      // since we've placed the feet on a walkable surface.
      this.grounded = true;
    }
  }

  private updateCrouch(wantCrouch: boolean, dt: number): void {
    const cfg = PLAYER_CONFIG;
    if (wantCrouch) {
      this.crouching = true;
    } else if (this.crouching) {
      // Only stand up if there is headroom.
      const seg = this.capsuleSegment(_segment, cfg.standHeight);
      seg.start.y += 0.05; // ignore the floor we're standing on
      if (!this.world.capsuleOverlaps(seg, cfg.radius - 0.02)) this.crouching = false;
    }
    const target = this.crouching ? cfg.crouchHeight : cfg.standHeight;
    const k = 1 - Math.exp(-cfg.crouchTransitionSpeed * dt);
    this.height += (target - this.height) * k;
    if (Math.abs(target - this.height) < 0.001) this.height = target;
  }
}
