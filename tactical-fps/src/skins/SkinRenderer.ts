import * as THREE from 'three';
import type { WeaponView } from '../weapons/view/WeaponView';
import { lookOf, WEAPON_MATERIAL_ROLES, type ArmsLook, type Finish, type OutfitLook } from './SkinLooks';

/**
 * Puts skins on the existing models, apart from all combat state.
 *
 * Weapons and the knife: GLB views share their materials with the cached
 * file (and with every other view and thumbnail of it), so the originals are
 * never edited. Each mesh whose material plays a role in the skin gets a
 * skinned copy instead; the copy is made once per (skin, original material)
 * and reused for every later view, so switching weapons creates nothing new.
 * Geometry, anchors, hands and animation are untouched.
 */
export class SkinRenderer {
  private readonly cache = new Map<string, THREE.Material>();

  /** Dresses a freshly created weapon view of `weaponId` in `assetId` (no-op for the default look or unknown assets). */
  dressWeapon(view: WeaponView, weaponId: string, assetId: string | undefined): number {
    const look = lookOf(assetId, 'weapon');
    const roles = WEAPON_MATERIAL_ROLES[weaponId];
    if (!look || !roles || !assetId) return 0;
    const finishFor = new Map<string, Finish>();
    for (const role of ['body', 'accent', 'metal'] as const) {
      const f = look[role];
      if (f) for (const name of roles[role] ?? []) finishFor.set(name, f);
    }
    let changed = 0;
    view.object.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const swap = (m: THREE.Material): THREE.Material => {
        const f = finishFor.get(m.name);
        if (!f) return m;
        changed++;
        return this.skinned(assetId, m, f);
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
    });
    return changed;
  }

  /** Skinned copies made so far (diagnostics: stays flat while switching weapons). */
  get materialCount(): number {
    return this.cache.size;
  }

  private skinned(assetId: string, original: THREE.Material, f: Finish): THREE.Material {
    const key = `${assetId}|${original.uuid}`;
    let m = this.cache.get(key);
    if (!m) {
      const copy = original.clone() as THREE.MeshStandardMaterial;
      if (copy.color) copy.color.setHex(f.color);
      if (f.metalness !== undefined && 'metalness' in copy) copy.metalness = f.metalness;
      if (f.roughness !== undefined && 'roughness' in copy) copy.roughness = f.roughness;
      copy.name = `${original.name}@${assetId}`;
      this.cache.set(key, copy);
      m = copy;
    }
    return m;
  }
}

/** Glove and sleeve colours for the first-person arms (null fields = factory). */
export interface ArmsAppearance {
  glove: Finish | null;
  pad: Finish | null;
  sleeve: Finish | null;
  cuff: Finish | null;
}

/** The player's legs and jacket (null fields = factory). */
export interface BodyAppearance {
  pants: Finish | null;
  jacket: Finish | null;
  gear: Finish | null;
  boot: Finish | null;
}

export function armsAppearance(glovesAsset: string | undefined, characterAsset: string | undefined): ArmsAppearance {
  const g: ArmsLook | null = lookOf(glovesAsset, 'arms');
  const c: OutfitLook | null = lookOf(characterAsset, 'outfit');
  return { glove: g?.glove ?? null, pad: g?.pad ?? null, sleeve: c?.sleeve ?? null, cuff: c?.cuff ?? null };
}

export function bodyAppearance(characterAsset: string | undefined): BodyAppearance {
  const c = lookOf(characterAsset, 'outfit');
  return { pants: c?.pants ?? null, jacket: c?.jacket ?? null, gear: c?.gear ?? null, boot: c?.boot ?? null };
}

/** Sets a material to a finish, or back to its factory values. */
export function applyFinish(m: THREE.MeshStandardMaterial, f: Finish | null, factory: Required<Finish>): void {
  m.color.setHex(f?.color ?? factory.color);
  m.metalness = f?.metalness ?? factory.metalness;
  m.roughness = f?.roughness ?? factory.roughness;
}
