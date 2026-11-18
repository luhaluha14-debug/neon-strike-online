import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CHARACTER_LIFT, liftCharacterMaterial } from '../../ai/CharacterLight';
import { SkinRenderer } from '../../skins/SkinRenderer';
import { knifeViewSpec } from '../knifeModels';
import type { WeaponViewSpec } from '../WeaponDefinition';
import { WEAPONS } from '../weapons';
import { loadGltfScene, loadedGltfWeaponView } from './GltfWeaponView';
import { addWeaponGrain } from './WeaponSurface';
import type { WeaponView } from './WeaponView';

// The real weapon in a character's hands in third person (Phase 27): the same GLB the player sees in first
// person, made once per weapon into a light template — every visible part baked into the model's space,
// merged into one geometry per material (a handful of draw calls instead of dozens of nodes), with the grip
// at the origin. A character only ever creates meshes that share those geometries and the file's materials
// (or the skin's cached copies of them): switching weapons shows another set, nothing is built per frame.

export interface ThirdPersonTemplate {
  readonly parts: readonly { geometry: THREE.BufferGeometry; material: THREE.Material }[];
  /** Muzzle point, model space with the grip at the origin (null: a knife). */
  readonly muzzle: THREE.Vector3 | null;
  readonly triangles: number;
}

const templates = new Map<string, ThirdPersonTemplate>();
const loading = new Set<string>();
const failed = new Set<string>();

/**
 * Lighter files for third person (tools/third-person-lods.py): the heaviest first-person models reduced to a
 * few thousand triangles, same nodes, transforms and material names (so the fit and the skins hold). A
 * character's weapon is small on screen; with ten of them in view this matters on low-end and mobile GPUs.
 */
const THIRD_PERSON_FILES: Readonly<Record<string, string>> = {
  '/weapons/m9_bayonet.glb': '/weapons/tp/m9_bayonet.glb',
  '/weapons/sr01.glb': '/weapons/tp/sr01.glb',
  '/weapons/ar01.glb': '/weapons/tp/ar01.glb',
  '/weapons/lmg02.glb': '/weapons/tp/lmg02.glb',
};
/** Third-person spec → the first-person one it stands for (the fallback if its own file cannot load). */
const fullSpecOf = new Map<WeaponViewSpec, WeaponViewSpec>();
const lighter = new Map<WeaponViewSpec, WeaponViewSpec>();

function thirdPersonFile(spec: WeaponViewSpec): WeaponViewSpec {
  if (spec.kind !== 'gltf') return spec;
  const url = THIRD_PERSON_FILES[spec.url];
  if (!url) return spec;
  let tp = lighter.get(spec);
  if (!tp) {
    tp = { ...spec, url };
    lighter.set(spec, tp);
    fullSpecOf.set(tp, spec);
  }
  return failed.has(url) ? spec : tp;
}

/** Every file third person may show (preloaded with the first-person models). */
export function thirdPersonViews(specs: readonly WeaponViewSpec[]): WeaponViewSpec[] {
  return specs.map(thirdPersonFile).filter((s, i) => s !== specs[i]);
}
/** Weapon skins in third person (cached skinned copies of the file materials, one per skin and material). */
export const thirdPersonSkins = new SkinRenderer();

/** The model a character holding `weaponId` shows: the weapon's own, or the knife model a knife item picks. */
export function thirdPersonSpec(weaponId: string | undefined, assetId: string | undefined): WeaponViewSpec | null {
  const def = weaponId ? WEAPONS[weaponId] : undefined;
  if (!def) return null;
  return thirdPersonFile((def.category === 'melee' ? knifeViewSpec(assetId) : undefined) ?? def.view);
}

/** The template of `spec`, or null while its file loads (the load is started once; the stand-in shows meanwhile). */
export function thirdPersonTemplate(spec: WeaponViewSpec): ThirdPersonTemplate | null {
  if (spec.kind !== 'gltf') return null;
  // A lighter file that could not load: the first-person file instead.
  const full = fullSpecOf.get(spec);
  if (full && failed.has(spec.url)) return thirdPersonTemplate(full);
  const t = templates.get(spec.url);
  if (t) return t;
  const view = loadedGltfWeaponView(spec.url, spec.fit);
  if (!view) {
    if (!loading.has(spec.url)) {
      loading.add(spec.url);
      loadGltfScene(spec.url)
        .catch(() => void failed.add(spec.url))
        .finally(() => loading.delete(spec.url));
    }
    return null;
  }
  const built = buildTemplate(view);
  view.dispose();
  templates.set(spec.url, built);
  return built;
}

/** Templates made so far (diagnostics: one per weapon file, never per character). */
export function thirdPersonTemplateCount(): number {
  return templates.size;
}

function shown(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}

function buildTemplate(view: WeaponView): ThirdPersonTemplate {
  const root = view.object;
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert();
  const grip = view.gripAnchor.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
  const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
  // Third person's own copies of the file's materials (one per material, shared by every character):
  // with the characters' light floor, so a weapon in a dark doorway is not pitch black either, while
  // the first-person model keeps the file's materials as they are.
  const own = new Map<THREE.Material, THREE.Material>();
  const ownCopy = (m: THREE.Material): THREE.Material => {
    let c = own.get(m);
    if (!c) {
      c = m.clone();
      if (m.userData.grain) {
        c.userData.grain = undefined;
        addWeaponGrain(c as THREE.MeshStandardMaterial);
      }
      if ((c as THREE.MeshStandardMaterial).isMeshStandardMaterial) liftCharacterMaterial(c as THREE.MeshStandardMaterial);
      own.set(m, c);
    }
    return c;
  };
  const rel = new THREE.Matrix4();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !shown(mesh)) return;
    const material = ownCopy((Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.Material);
    const src = mesh.geometry;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', src.getAttribute('position').clone());
    if (src.getAttribute('normal')) g.setAttribute('normal', src.getAttribute('normal').clone());
    if (src.index) g.setIndex(src.index.clone());
    else g.setIndex([...Array(src.getAttribute('position').count).keys()]);
    rel.multiplyMatrices(inv, mesh.matrixWorld);
    g.applyMatrix4(rel);
    g.translate(-grip.x, -grip.y, -grip.z);
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const list = byMaterial.get(material) ?? [];
    list.push(g);
    byMaterial.set(material, list);
  });
  const parts: { geometry: THREE.BufferGeometry; material: THREE.Material }[] = [];
  let triangles = 0;
  for (const [material, list] of byMaterial) {
    const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
    if (!merged) continue;
    if (list.length > 1) for (const g of list) g.dispose();
    merged.computeBoundingSphere();
    triangles += (merged.index?.count ?? 0) / 3;
    parts.push({ geometry: merged, material });
  }
  const muzzle = view.muzzle ? view.muzzle.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv).sub(grip) : null;
  return { parts, muzzle, triangles };
}

/**
 * The weapon a character holds, kept on its rifle mount (rifle space: -Z forward, the hand at `grip`).
 * `set` each frame is cheap: only a change of weapon or skin (or a file finishing loading) does anything.
 * Sets already made for this character are kept (a few at most) and shown again on a switch back.
 */
export class HeldWeapon {
  weaponId: string | undefined = undefined;
  assetId: string | undefined = undefined;
  /** The real model is in the hands (false: the stand-in rifle, while the file loads or for an unknown weapon). */
  real = false;
  private key = '';
  private readonly sets = new Map<string, THREE.Group>();

  constructor(
    private readonly mount: THREE.Object3D,
    private readonly grip: THREE.Vector3,
    /** Shows / hides the stand-in rifle and dresses it in a skin (the fallback look). */
    private readonly standIn: (visible: boolean, assetId: string | undefined) => void,
    /** Puts the muzzle point at a mount-space position (null: back to the stand-in's muzzle). */
    private readonly placeMuzzle: (mountSpace: THREE.Vector3 | null) => void,
    /**
     * Where a pistol or a knife is held (mount space; default: `grip`). A body whose rifle hand rests on its
     * chest holds them out in front instead, where they are not lost inside the torso.
     */
    private readonly shortGrip: THREE.Vector3 = grip,
  ) {}

  set(weaponId: string | undefined, assetId: string | undefined): void {
    const spec = thirdPersonSpec(weaponId, assetId);
    const template = spec ? thirdPersonTemplate(spec) : null;
    const key = `${weaponId ?? ''}|${assetId ?? ''}|${template ? 1 : 0}`;
    if (key === this.key) return;
    this.key = key;
    this.weaponId = weaponId;
    this.assetId = assetId;
    for (const g of this.sets.values()) g.visible = false;
    if (!template || !weaponId) {
      this.real = false;
      this.standIn(true, assetId);
      this.placeMuzzle(null);
      return;
    }
    this.real = true;
    this.standIn(false, undefined);
    const setKey = `${weaponId}|${assetId ?? ''}`;
    let g = this.sets.get(setKey);
    if (!g) {
      g = new THREE.Group();
      g.name = `held:${setKey}`;
      for (const p of template.parts) {
        const m = new THREE.Mesh(p.geometry, p.material);
        m.castShadow = false;
        m.receiveShadow = true;
        m.frustumCulled = false;
        g.add(m);
      }
      thirdPersonSkins.dressWeapon({ object: g }, weaponId, assetId);
      // A skinned copy keeps its original's light floor: on its own colour now.
      g.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (m?.isMeshStandardMaterial && m.userData.lifted && m.name.includes('@')) m.emissive.copy(m.color).multiplyScalar(CHARACTER_LIFT);
      });
      const category = WEAPONS[weaponId]?.category;
      g.position.copy(category === 'melee' || category === 'pistol' ? this.shortGrip : this.grip);
      // A knife is held point forward and up; guns as the rifle is.
      if (category === 'melee') g.rotation.set(-1.15, 0, 0);
      this.mount.add(g);
      this.sets.set(setKey, g);
      // A handful at most per character: the oldest set goes (its meshes only; geometry is shared).
      if (this.sets.size > 6) {
        const [oldKey, old] = this.sets.entries().next().value as [string, THREE.Group];
        old.removeFromParent();
        this.sets.delete(oldKey);
      }
    }
    g.visible = true;
    if (template.muzzle) {
      const p = template.muzzle.clone().applyEuler(g.rotation).add(g.position);
      this.placeMuzzle(p);
    } else this.placeMuzzle(g.position.clone());
  }

  /** Mesh sets made for this character (tests: no duplicates after any number of switches). */
  get setCount(): number {
    return this.sets.size;
  }

  dispose(): void {
    for (const g of this.sets.values()) g.removeFromParent();
    this.sets.clear();
  }
}
