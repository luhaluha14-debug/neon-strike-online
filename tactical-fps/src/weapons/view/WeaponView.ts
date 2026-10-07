import type * as THREE from 'three';
import type { ProceduralModelId, WeaponCategory, WeaponViewSpec } from '../WeaponDefinition';
import { loadGltfWeaponView } from './GltfWeaponView';
import { KarambitView } from './KarambitView';
import { ProceduralRifleView } from './ProceduralRifleView';
import { SniperRifleView } from './SniperRifleView';

import type { ArmPose, HandGripProfile } from './HandGrip';

export { PISTOL_GRIP, type ArmPose, type HandGripProfile } from './HandGrip';

/** Per-frame state a model can use to move its own parts (bolt, hammer, …). */
export interface WeaponAnimState {
  category: WeaponCategory;
  /** 0 → 1 while being drawn, 1 when ready. */
  equip: number;
  /** 0..1 while reloading, else null. */
  reload: number | null;
  /** Seconds since the last shot / attack. */
  sinceShot: number;
  /** Seconds between shots (bolt cycle length for bolt-actions). */
  fireInterval: number;
  /** 0..1 while inspecting, else null. */
  inspect: number | null;
}

/**
 * A first-person weapon model. Implementations only provide geometry,
 * anchors and (optionally) their own moving parts; generic motion (sway,
 * bob, recoil kick, equip, reload dip, melee swing, inspect) is done by
 * ViewModelLayer, and hands by FirstPersonArms, so a Blender model can be
 * swapped in without touching either.
 *
 * Model space: barrel/blade points down -Z, +Y up, +X right, meters.
 * For a GLB, add empties named `Grip_R` (firing hand), `Grip_L` (support
 * hand, optional), `Muzzle` (optional) and a node `Magazine` (optional).
 */
export interface WeaponView {
  readonly object: THREE.Object3D;
  /** Where the muzzle flash appears; null for melee. */
  readonly muzzle: THREE.Object3D | null;
  /** Optional: animated during reloads. */
  readonly magazine?: THREE.Object3D;
  /** Firing-hand pose (+Y along the grip, +Z toward the shooter). */
  readonly gripAnchor: THREE.Object3D;
  readonly rightHand: HandGripProfile;
  /** Off-hand pose (under the handguard); null = one-handed weapon, left arm hidden. */
  readonly supportAnchor: THREE.Object3D | null;
  /** Optional elbow placement when the default arm path would cut through the model. */
  readonly armPose?: ArmPose;
  /** Moves weapon-specific parts (e.g. the sniper bolt) each frame. */
  animate?(state: WeaponAnimState): void;
  dispose(): void;
}

function createProcedural(model: ProceduralModelId): WeaponView {
  switch (model) {
    case 'ar01':
      return new ProceduralRifleView();
    case 'sr01':
      return new SniperRifleView();
    case 'karambit':
      return new KarambitView();
  }
}

/**
 * Builds the model that can be shown right away: the procedural model, or
 * for a GLB spec its procedural fallback (shown while the file loads).
 */
export function createWeaponView(spec: WeaponViewSpec): WeaponView {
  return createProcedural(spec.kind === 'procedural' ? spec.model : spec.fallback);
}

/** Resolves to the final model for a GLB spec (null for procedural specs). */
export function loadWeaponView(spec: WeaponViewSpec): Promise<WeaponView> | null {
  return spec.kind === 'gltf' ? loadGltfWeaponView(spec.url) : null;
}
