// Central tunables. Gameplay feel lives here so it can be tweaked without
// touching systems code (and later shared with an authoritative server).

// Map-specific settings (node naming rules, fog, view distance) live in maps.ts.

export const PLAYER_CONFIG = {
  radius: 0.35,
  standHeight: 1.8,
  crouchHeight: 1.2,
  /** Eye height measured down from the top of the capsule. */
  eyeOffsetFromTop: 0.12,

  runSpeed: 5.4,
  walkSpeed: 2.8,
  crouchSpeed: 2.2,

  groundAccel: 60,
  groundFriction: 9,
  airAccel: 12,
  airControl: 0.35,

  jumpVelocity: 5.2,
  gravity: 18,
  maxFallSpeed: 40,

  /** cos(max walkable slope). 0.7 ≈ 45°. */
  walkableNormalY: 0.7,
  /** How far below the feet we look to keep the player glued to ramps/steps. */
  groundSnapDistance: 0.35,

  crouchTransitionSpeed: 8,

  maxHealth: 100,
} as const;

/**
 * ARMOR-01 (team match vest). Kept apart from health: a covered hit takes
 * `absorb` of its damage out of the armour instead (as long as there is
 * armour left), wearing `wearPerAbsorbed` armour points per point stopped.
 * There is no helmet in the game, so head hits are never reduced.
 */
export const ARMOR_CONFIG = {
  max: 100,
  absorb: 0.3,
  wearPerAbsorbed: 1,
  /** Hit zones the vest covers (PlayerCombat zones: head / body / limb). */
  zones: ['body'] as readonly string[],
} as const;

/**
 * Thrown utility (FLASH-01 / SMOKE-01): carry limits, throw, flight and
 * effects. Prices are in the catalog. Everything grenade-related reads from here.
 */
export const GRENADE_CONFIG = {
  /** Most of each type one player can carry. */
  maxCarry: { flash: 2, smoke: 1 } as Record<'flash' | 'smoke', number>,
  /** Seconds to draw a grenade before it can be thrown. */
  drawTime: 0.35,
  /** Throw speed (m/s) along the view, plus `throwLift` upward, plus the thrower's own velocity. */
  throwSpeed: 15,
  throwLift: 2.2,
  /** Spawns this far in front of the eye. */
  throwOffset: 0.35,
  /** Flight: gravity (m/s²), ball radius (m), bounce (normal speed kept) and slide friction (tangential speed kept). */
  gravity: 12,
  radius: 0.05,
  bounce: 0.42,
  friction: 0.7,
  /** Rolling on a floor: speed lost per second (exponential). */
  rollDrag: 2.5,
  flash: {
    /** Fuse from the throw (s). */
    fuse: 1.6,
    /** Longest blind (s): at point blank, looking straight at it. */
    maxBlind: 4.5,
    /** No effect beyond this distance (m); falls off with (d / range)². */
    range: 24,
    /** Share of the blind when it is behind the viewer (0..1), ramping to 1 when looked at. */
    behind: 0.12,
    /** Ignored when the result is shorter than this (s). */
    minBlind: 0.2,
    /** Last part of the blind (s) in which the white screen fades out. */
    fade: 1.4,
  },
  smoke: {
    /** Pops once it has come to rest after at least `fuse` s, at the latest after `maxFuse` s. */
    fuse: 1.2,
    maxFuse: 3,
    /** Seconds to grow to full size, seconds it lasts in all (incl. bloom), seconds it fades at the end. */
    bloom: 1.1,
    duration: 16,
    fadeOut: 2.5,
    /** Full radius (m) of the cloud, its centre this high above where the grenade stopped. */
    radius: 3.6,
    lift: 1.1,
    /** A sight line passing closer than radius × this to the centre is blocked (bots). */
    blockFactor: 0.9,
    /** Puffs drawn per cloud. */
    puffs: 22,
  },
} as const;

export const CAMERA_CONFIG = {
  fov: 78,
  near: 0.05,
  /** Radians per pixel at sensitivity 1. */
  mouseSensitivity: 0.0022,
  maxPitch: Math.PI / 2 - 0.01,
} as const;

export const SIM_CONFIG = {
  /** Fixed physics tick. Deterministic and network-friendly. */
  tickRate: 120,
  /** Clamp for long frames (tab switch, GC) to avoid the spiral of death. */
  maxFrameTime: 0.1,
} as const;

export type QualityLevel = 'low' | 'medium' | 'high';

export const QUALITY_PRESETS: Record<
  QualityLevel,
  { pixelRatioCap: number; shadows: boolean; shadowMapSize: number; antialias: boolean }
> = {
  low: { pixelRatioCap: 1, shadows: false, shadowMapSize: 1024, antialias: false },
  medium: { pixelRatioCap: 1.5, shadows: true, shadowMapSize: 2048, antialias: true },
  high: { pixelRatioCap: 2, shadows: true, shadowMapSize: 4096, antialias: true },
};
