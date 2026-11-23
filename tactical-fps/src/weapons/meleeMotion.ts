// Phase 31: the knife slash timeline shared by the first-person view model and the third-person bodies, so a
// slash looks the same from both sides. The hit itself is judged when the slash is made (Phase 29); this is
// presentation only and changes nothing about reach, rate or the one-hit kill.

/** Duration of a slash (s). */
export const SLASH_TIME = 0.32;
/** The blade's full sweep comes this soon after the slash (s): the hit is judged at the slash (Phase 29). */
export const SLASH_STRIKE = 0.06;

/**
 * How each knife is used: the M9 bayonet slashes diagonally (forward grip), the karambit hooks across in a
 * reverse grip, the butterfly knife thrusts straight in.
 */
export type MeleeStyle = 'm9' | 'karambit' | 'butterfly';

/** The knife a held item shows (its model asset): the M9 for anything else. */
export function meleeStyleOf(assetId: string | undefined): MeleeStyle {
  if (assetId === 'model:karambit') return 'karambit';
  if (assetId === 'model:butterfly') return 'butterfly';
  return 'm9';
}

/** 0..1..0: a fast strike to full sweep at SLASH_STRIKE, then a slower eased return (0 outside a slash). */
export function meleeSweep(t: number): number {
  if (!(t >= 0) || t >= SLASH_TIME) return 0;
  if (t < SLASH_STRIKE) return Math.sin((t / SLASH_STRIKE) * (Math.PI / 2));
  return (1 - (t - SLASH_STRIKE) / (SLASH_TIME - SLASH_STRIKE)) ** 2;
}
