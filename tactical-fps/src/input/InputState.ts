// Device-agnostic input snapshot. Gameplay code only reads this, so a touch
// controller (virtual stick + look pad) can be added later without touching
// the player controller.

export interface InputState {
  /** Strafe axis, -1 (left) .. 1 (right). */
  moveX: number;
  /** Forward axis, -1 (back) .. 1 (forward). */
  moveY: number;
  /** Accumulated look delta since last consume, in radians. */
  lookYaw: number;
  lookPitch: number;
  jump: boolean;
  crouch: boolean;
  walk: boolean;
}

export function createInputState(): InputState {
  return { moveX: 0, moveY: 0, lookYaw: 0, lookPitch: 0, jump: false, crouch: false, walk: false };
}

export interface InputSource {
  /** Writes the current state into `out`, consuming accumulated look deltas. */
  poll(out: InputState): void;
  /** True while the source is capturing (pointer lock on PC). */
  readonly active: boolean;
  dispose(): void;
}
