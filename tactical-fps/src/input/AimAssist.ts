// Mobile aim assist (Phase 28): a weak help for aiming with a finger, touch controls only (never on a
// PC's mouse). It only ever reshapes the player's own look input of this frame:
//
// - no input, no help: with the finger still the view never moves (it cannot track or aim by itself);
// - friction: near an enemy the look slows a little, so a drag does not fly past it;
// - a small pull toward that enemy, never more than a fraction of the input's own size this frame;
// - only enemies the player can see now: inside the view, in range, not behind a wall or smoke (the
//   caller checks; anything off screen or hidden is not a candidate).
//
// Shots still leave through the crosshair and are judged by the hitscan as every other shot: the
// assist changes where the player looks, never a hit, damage or the host's rules.

export const AIM_ASSIST = {
  /** Help zone around an enemy (rad): wide up close, narrow far away, between these bounds. */
  minCone: 0.03,
  maxCone: 0.085,
  /** The zone is about this many times the enemy's own angular half-width. */
  coneScale: 1.6,
  /** Enemy half-width (m) for that angular size. */
  bodyHalfWidth: 0.5,
  /** At strength 1, on the enemy: the look slows by this fraction. */
  friction: 0.35,
  /** At strength 1, on the enemy: a pull of at most this fraction of the input's size. */
  pull: 0.25,
  /** Enemies farther than this (m) get no help. */
  range: 60,
} as const;

/** An enemy aim point as seen from the eye: its angular offset from the crosshair (rad, look-yaw / pitch sense). */
export interface AimCandidate {
  yaw: number;
  pitch: number;
  /** Distance (m), for the size of the help zone. */
  distance: number;
}

/** The help zone (rad) around an enemy `distance` m away. */
export function assistCone(distance: number): number {
  const a = Math.atan(AIM_ASSIST.bodyHalfWidth / Math.max(distance, 0.5)) * AIM_ASSIST.coneScale;
  return Math.min(AIM_ASSIST.maxCone, Math.max(AIM_ASSIST.minCone, a));
}

/**
 * The look input after the assist (written into `out`; `look` may be `out`). `strength` 0..1 (0 = off);
 * `candidates[0..count)` are the visible enemies' aim points. The output's size never exceeds the input's
 * by more than the pull fraction, and a zero input stays zero.
 */
export function assistLook(
  look: { yaw: number; pitch: number },
  candidates: readonly AimCandidate[],
  count: number,
  strength: number,
  out: { yaw: number; pitch: number },
): { yaw: number; pitch: number } {
  const iy = look.yaw;
  const ip = look.pitch;
  out.yaw = iy;
  out.pitch = ip;
  const m = Math.hypot(iy, ip);
  const s = Math.min(1, Math.max(0, strength));
  if (m === 0 || s === 0 || count === 0) return out;
  // The enemy nearest the crosshair inside its own help zone.
  let best = -1;
  let bestT = 0;
  for (let i = 0; i < count; i++) {
    const c = candidates[i];
    if (c.distance > AIM_ASSIST.range) continue;
    const a = Math.hypot(c.yaw, c.pitch);
    const t = 1 - a / assistCone(c.distance);
    if (t > bestT) {
      bestT = t;
      best = i;
    }
  }
  if (best < 0) return out;
  const c = candidates[best];
  const k = 1 - AIM_ASSIST.friction * s * bestT;
  out.yaw = iy * k;
  out.pitch = ip * k;
  // The pull: toward the enemy, bounded by the input's own size and never past the enemy.
  const a = Math.hypot(c.yaw, c.pitch);
  if (a > 1e-6) {
    const pull = Math.min(a, AIM_ASSIST.pull * s * bestT * m);
    out.yaw += (c.yaw / a) * pull;
    out.pitch += (c.pitch / a) * pull;
  }
  return out;
}

/** Mobile recoil assist: at strength 1 the view kick is this much smaller (never gone). */
export const RECOIL_ASSIST_MAX = 0.35;

/** View recoil size for a recoil assist strength 0..1 (1 = the weapon's full kick). */
export function recoilScaleFor(strength: number): number {
  return 1 - RECOIL_ASSIST_MAX * Math.min(1, Math.max(0, strength));
}

/** Wraps an angle to -π..π. */
export function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
