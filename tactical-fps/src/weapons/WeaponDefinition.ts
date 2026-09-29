// Data-only description of a firearm. Every gun in the game is one of these;
// the runtime classes never hard-code per-weapon numbers.

export type FireMode = 'auto' | 'semi';

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

/** How the weapon looks in first person. A Blender model can replace the procedural one later. */
export type WeaponViewSpec =
  | { kind: 'procedural'; style: 'rifle' }
  | { kind: 'gltf'; url: string; scale?: number };

export interface WeaponDefinition {
  id: string;
  displayName: string;
  fireMode: FireMode;
  /** Rounds per minute. */
  fireRate: number;
  magazineSize: number;
  /** Reserve ammo the weapon spawns with. */
  reserveAmmo: number;
  /** Seconds from pressing reload until the magazine is refilled. */
  reloadTime: number;
  damage: DamageProfile;
  spread: SpreadProfile;
  recoil: RecoilProfile;
  view: WeaponViewSpec;
}
