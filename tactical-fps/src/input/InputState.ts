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
  /** Primary fire held. */
  fire: boolean;
  /** Reload key held (weapon code reacts to the press edge). */
  reload: boolean;
  /** Weapon slot requested this frame (0-based), -1 = none. */
  equipSlot: number;
  /** Swap to the previously held weapon. */
  equipLast: boolean;
  /** Scroll through the loadout: -1 / +1, 0 = none. */
  equipCycle: number;
  /** Inspect key held. */
  inspect: boolean;
}

export function createInputState(): InputState {
  return { moveX: 0, moveY: 0, lookYaw: 0, lookPitch: 0, jump: false, crouch: false, walk: false, fire: false, reload: false, equipSlot: -1, equipLast: false, equipCycle: 0, inspect: false };
}

export interface InputSource {
  /** Writes the current state into `out`, consuming accumulated look deltas. */
  poll(out: InputState): void;
  /**
   * Presses shorter than a frame are latched so they are never lost; the game
   * calls this after at least one simulation tick has seen them.
   */
  clearLatches(): void;
  /** True while the source is capturing (pointer lock on PC). */
  readonly active: boolean;
  dispose(): void;
}
