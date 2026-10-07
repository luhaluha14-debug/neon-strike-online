import type * as THREE from 'three';
import type { WeaponViewSpec } from '../WeaponDefinition';
import { ProceduralRifleView } from './ProceduralRifleView';

/**
 * A first-person weapon model. Implementations only provide geometry and a
 * few named anchors; all motion (sway, bob, recoil, reload) is done by
 * ViewModelLayer so a Blender model can be swapped in without touching it.
 *
 * Model space: barrel points down -Z, +Y up, origin at the grip hand,
 * units in meters. For a GLB, name the empties `Muzzle`, `Magazine`,
 * `Grip_R` and `Grip_L` (hand anchors).
 */
export interface WeaponView {
  readonly object: THREE.Object3D;
  /** Where the muzzle flash appears. */
  readonly muzzle: THREE.Object3D;
  /** Optional: animated during reloads. */
  readonly magazine?: THREE.Object3D;
  /** Firing-hand pose on the pistol grip (+Y along the grip, +Z toward the stock). */
  readonly gripAnchor: THREE.Object3D;
  /** Off-hand pose under the handguard. */
  readonly supportAnchor: THREE.Object3D;
  dispose(): void;
}

export function createWeaponView(spec: WeaponViewSpec): WeaponView {
  switch (spec.kind) {
    case 'procedural':
      return new ProceduralRifleView();
    case 'gltf':
      // Placeholder until weapon GLBs exist: fall back to the procedural model.
      console.warn(`[weapon] GLB weapon views are not wired yet (${spec.url}); using the placeholder.`);
      return new ProceduralRifleView();
  }
}
