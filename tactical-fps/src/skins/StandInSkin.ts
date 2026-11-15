import * as THREE from 'three';
import { lookOf, type Finish } from './SkinLooks';

// The third-person stand-in rifle every character holds (BotModel / AgentModel buildBotRifle: one merged
// mesh in the gun material, one in the dark material) wearing a weapon skin (Phase 26-C): the gun mesh takes
// the skin's body finish (its accent when it has no body), the dark parts its metal finish. Only materials
// are swapped (shared, cached copies of the kit's own): no shape, no extra draw call, no combat state.

const cache = new Map<string, THREE.Material>();

function finished(base: THREE.Material, assetId: string, f: Finish): THREE.Material {
  const key = `${assetId}|${base.uuid}`;
  let m = cache.get(key);
  if (!m) {
    const copy = base.clone() as THREE.MeshStandardMaterial;
    copy.color.setHex(f.color);
    if (f.metalness !== undefined) copy.metalness = f.metalness;
    if (f.roughness !== undefined) copy.roughness = f.roughness;
    copy.name = `${base.name || 'standin'}@${assetId}`;
    cache.set(key, copy);
    m = copy;
  }
  return m;
}

/**
 * Dresses `rifle` (built with `gun` / `dark`) in the weapon look `assetId` (undefined / unknown / not a
 * weapon look: the kit's own materials back). Returns the asset now shown.
 */
export function dressStandIn(rifle: THREE.Object3D, gun: THREE.Material, dark: THREE.Material, assetId: string | undefined): string | undefined {
  const look = lookOf(assetId, 'weapon');
  const body = look ? (look.body ?? look.accent ?? null) : null;
  const metal = look ? (look.metal ?? null) : null;
  rifle.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const base = (mesh.userData.standInBase as THREE.Material | undefined) ?? (mesh.material as THREE.Material);
    mesh.userData.standInBase = base;
    const f = base === gun ? body : base === dark ? metal : null;
    mesh.material = f && assetId ? finished(base, assetId, f) : base;
  });
  return look ? assetId : undefined;
}

/** Skinned stand-in materials made so far (diagnostics: one per skin and kit material, never per character). */
export function standInMaterialCount(): number {
  return cache.size;
}
