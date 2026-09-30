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
