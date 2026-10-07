// Data-only description of a weapon (guns and melee). Every weapon in the
// game is one of these; the runtime classes never hard-code per-weapon numbers.

export type FireMode = 'auto' | 'semi';

/** Drives view animation style and HUD; behavior itself comes from the numbers below. */
export type WeaponCategory = 'rifle' | 'sniper' | 'melee';

export interface RecoilProfile {
  /** Upward camera kick of the first shot (radians). */
  pitchPerShot: number;
  /** Extra upward kick added per consecutive shot (radians), up to `growthShots`. */
  pitchGrowthPerShot: number;
  growthShots: number;
  /** Total vertical climb is capped here (radians); past it the spray only drifts sideways. */
  maxPitch: number;
  /** Random horizontal kick range per shot (radians, ±). */
  yawJitter: number;
  /** Horizontal drift that starts after `yawDriftAfterShots` consecutive shots (radians/shot, ±, direction picked per burst). */
  yawDrift: number;
  yawDriftAfterShots: number;
  /** How quickly the camera catches up with the kick (1/s). Higher = snappier. */
  kickResponse: number;
  /** Time after the last shot before the view starts settling back (s). */
  recoveryDelay: number;
  /** Recovery speed back toward the pre-spray aim (radians/s). */
  recoverySpeed: number;
  /** Shots-in-a-row counter resets after this long without firing (s). */
  sprayResetTime: number;
}

export interface SpreadProfile {
  /** Cone half-angle while standing still on the ground (radians). 0 = perfectly on the crosshair. */
  standing: number;
  /** Added at full run speed (scaled by current speed). */
  moving: number;
  /** Added while airborne. */
  airborne: number;
  /** Multiplier while crouched. */
  crouchMultiplier: number;
}

export interface DamageProfile {
  base: number;
  headMultiplier: number;
  limbMultiplier: number;
  /** Full damage up to this distance (m). */
  falloffStart: number;
  /** Damage multiplier reached at `falloffEnd` and beyond. */
  falloffEnd: number;
  falloffMinMultiplier: number;
  /** Bullets stop existing past this (m). */
  maxRange: number;
}

/**
 * Where the first-person model sits in camera space (meters / radians).
 * Tune these per weapon without touching any weapon logic.
 */
export interface ViewmodelPose {
  position: readonly [number, number, number];
  rotation: readonly [number, number, number];
  scale: number;
}

/** Built-in placeholder models. */
export type ProceduralModelId = 'ar01' | 'sr01' | 'karambit';

/** How the weapon looks in first person. A Blender model can replace the procedural one later. */
export type WeaponViewSpec = (
  | { kind: 'procedural'; model: ProceduralModelId }
  | { kind: 'gltf'; url: string; fallback: ProceduralModelId }
) & { pose: ViewmodelPose };

export interface WeaponDefinition {
  id: string;
  displayName: string;
  category: WeaponCategory;
  fireMode: FireMode;
  /** Rounds per minute. */
  fireRate: number;
  /** 0 = no ammo at all (melee): attacks are only limited by `fireRate`. */
  magazineSize: number;
  /** Reserve ammo the weapon spawns with. */
  reserveAmmo: number;
  /** Seconds after switching to this weapon before it can attack. */
  equipTime: number;
  /** Seconds from pressing reload until the magazine is refilled. */
  reloadTime: number;
  /** Melee uses the same profile with a short `maxRange` (its reach). */
  damage: DamageProfile;
  spread: SpreadProfile;
  recoil: RecoilProfile;
  view: WeaponViewSpec;
}
