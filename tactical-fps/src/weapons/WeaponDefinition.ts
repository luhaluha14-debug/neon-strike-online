import type { SoundId } from '../audio/weaponSounds';
import type { ArmPose, HandGripProfile } from './view/HandGrip';
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

type Vec3 = readonly [number, number, number];

/**
 * Fitting for a GLB exported without the game's anchor nodes or in other axes.
 * Applied to the loaded scene at runtime; the file itself is used as exported.
 * Everything below is in model space (after `rotation`): -Z forward, +Y up, +X right.
 */
export interface GltfFit {
  /** Euler rotation (rad, XYZ) that turns the file's axes into model space. */
  rotation?: Vec3;
  /** Firing-hand anchor when the file has no `Grip_R` node (+Y along the grip, +Z toward the shooter). */
  grip?: { position: Vec3; rotation?: Vec3 };
  /** Support-hand anchor when the file has no `Grip_L` node. */
  support?: { position: Vec3; rotation?: Vec3 };
  /** Muzzle flash position when the file has no `Muzzle` node. */
  muzzle?: Vec3;
  /** File nodes gathered into the part the reload animation drops out. */
  magazine?: readonly string[];
  /** File nodes gathered into the bolt (cycled after each shot), pivoting on the bore axis at `pivot`. */
  bolt?: { nodes: readonly string[]; pivot: Vec3 };
  /** Glove shape around the grip (defaults to a rifle pistol grip). */
  hand?: HandGripProfile;
  armPose?: ArmPose;
}

/** How the weapon looks in first person: a built-in procedural model or a Blender GLB. */
export type WeaponViewSpec = (
  | { kind: 'procedural'; model: ProceduralModelId }
  | { kind: 'gltf'; url: string; fallback: ProceduralModelId; fit?: GltfFit }
) & { pose: ViewmodelPose };

/** Sound cues of one weapon (ids from `audio/weaponSounds`). Presentation only. */
export interface WeaponSounds {
  /** One per shot / attack. */
  fire: SoundId;
  /** Per-weapon loudness of `fire` (linear, 1 = reference). */
  fireVolume: number;
  /** Melee: extra contact sound when the attack hits something. */
  hit?: SoundId;
  /** Played after every shot (e.g. bolt cycle), stopped if the weapon is put away. */
  cycle?: SoundId;
  /** Trigger pulled on an empty magazine. */
  dry?: SoundId;
  equip: SoundId;
  /** Reload cues at reload progress 0..1, matching the view model's magazine motion. */
  reload?: readonly { at: number; sound: SoundId }[];
  /** When the reload completes. */
  reloadEnd?: SoundId;
}

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
  sounds: WeaponSounds;
}
