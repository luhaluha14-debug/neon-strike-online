import * as THREE from 'three';
import { CAMERA_CONFIG, PLAYER_CONFIG } from '../config';
import type { InputState } from '../input/InputState';
import type { CollisionWorld, CapsuleHit } from '../world/CollisionWorld';

const _wish = new THREE.Vector3();
const _segment = new THREE.Line3();
const _down = new THREE.Vector3(0, -1, 0);
const _normal = new THREE.Vector3();

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

  private jumpHeld = false;
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

    // Wish direction in world space from yaw only.
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    _wish.set(input.moveX * cos - input.moveY * sin, 0, -input.moveX * sin - input.moveY * cos);
    if (_wish.lengthSq() > 1) _wish.normalize();

    const maxSpeed = this.crouching ? cfg.crouchSpeed : input.walk ? cfg.walkSpeed : cfg.runSpeed;

    if (this.grounded) {
      // Friction then acceleration toward the target velocity (crisp, low-slide stops).
      const speed = Math.hypot(this.velocity.x, this.velocity.z);
      if (speed > 0) {
        const drop = speed * cfg.groundFriction * dt;
        const scale = Math.max(speed - drop, 0) / speed;
        this.velocity.x *= scale;
        this.velocity.z *= scale;
      }
      this.accelerate(_wish, maxSpeed, cfg.groundAccel, dt);

      if (input.jump && !this.jumpHeld && !this.crouching) {
        this.velocity.y = cfg.jumpVelocity;
        this.grounded = false;
      } else {
        this.velocity.y = 0;
      }
    } else {
      this.accelerate(_wish, maxSpeed * cfg.airControl + 0.01, cfg.airAccel, dt);
      this.velocity.y = Math.max(this.velocity.y - cfg.gravity * dt, -cfg.maxFallSpeed);
    }
    this.jumpHeld = input.jump;

    const wasGrounded = this.grounded;
    const jumped = this.velocity.y > 0;
    this.position.addScaledVector(this.velocity, dt);
    this.collide();

    // Stay glued to the ground when walking down ramps and small steps.
    if (wasGrounded && !this.grounded && !jumped) this.snapToGround();

    if (this.grounded && this.velocity.y < 0) this.velocity.y = 0;
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
    const dist = this.world.raycast(origin, _down, cfg.radius + cfg.groundSnapDistance, _normal);
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
