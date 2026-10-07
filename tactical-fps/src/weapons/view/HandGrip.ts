/**
 * How the firing hand closes around a weapon's grip. FirstPersonArms shapes
 * the glove from these numbers, so the arms never need to know which
 * weapon they hold.
 */
export interface HandGripProfile {
  /** Grip size where the hand wraps it (m): side to side, and front to back. */
  width: number;
  depth: number;
  /** Index finger: resting on a trigger, or through a finger ring (karambit). */
  index: 'trigger' | 'ring';
  /**
   * Raises the wrist along the grip axis (m). Thumbhole stocks need the
   * wrist to pass through the hole above the lower rail instead of below the grip.
   */
  wristLift?: number;
}

/** Optional per-weapon arm placement (weapon space, meters). */
export interface ArmPose {
  rightElbow?: readonly [number, number, number];
  leftElbow?: readonly [number, number, number];
}

/** A typical rifle pistol grip (the hand's reference shape). */
export const PISTOL_GRIP: HandGripProfile = { width: 0.036, depth: 0.045, index: 'trigger' };
