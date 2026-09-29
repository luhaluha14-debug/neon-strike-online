// Central tunables. Gameplay feel lives here so it can be tweaked without
// touching systems code (and later shared with an authoritative server).

export const MAP_CONFIG = {
  /** Path is relative to the Vite `public/` folder. */
  url: '/maps/Untitled.glb',

  /**
   * Nodes whose name starts with one of these prefixes are template/helper
   * objects left in the Blender scene (instancing sources, the default cube).
   * They sit at the world origin, so they are hidden and never collide.
   */
  hiddenPrefixes: ['Tpl_', 'Cube'],

  /**
   * Visible but non-solid geometry: decals, ground scatter, overhead cables,
   * signage and gameplay zone markers. Keeping them out of the collider
   * avoids snagging on tiny bumps and keeps the BVH small.
   */
  nonCollidingPrefixes: [
    'Ground_Pebble_',
    'Ground_Dirt_',
    'Ground_Joints_',
    'Ground_WallBase_',
    'Deco_Cables_',
    'Deco_Manholes',
    'Sign_Letter_',
    'Bldg_Site_Sign_Boards',
  ],

  /**
   * Gameplay volume markers (spawn / plant areas). Loaded into their own
   * group, hidden by default and shown with the F3 debug overlay.
   */
  zoneMarkerPrefix: 'Zone_',

  /** Empties exported from Blender that mark team spawn positions. */
  attackSpawnPrefix: 'ATK_SpawnPoint_',
  defenseSpawnPrefix: 'DEF_SpawnPoint_',

  /** Anything that falls below this height is respawned. */
  killPlaneY: -20,
} as const;

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
  far: 400,
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
