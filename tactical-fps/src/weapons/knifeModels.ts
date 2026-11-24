import type { WeaponViewSpec } from './WeaponDefinition';

// Knife models a GRID knife item swaps in for the M9 bayonet (Phase 27). The knife itself stays the same
// weapon (KARAMBIT in weapons.ts: damage, reach, swing rate); only the model changes, in first and third
// person. Phase 34: both files are the delivered models, brought into the M9 file's conventions (blade along
// +Y, edge toward -X, grip below the guard, metres) by tools/import-knife.mjs, so they share its pose.

const POSE = { position: [0.16, -0.115, -0.37], rotation: [-0.95, 1.1, 0.55], scale: 1 } as const;

export const KNIFE_MODEL_VIEWS: Readonly<Record<string, WeaponViewSpec>> = {
  // Claw blade, rubber grip with finger grooves, steel ring: held so the ring sits at the bottom of the fist.
  'model:karambit': {
    kind: 'gltf',
    url: '/weapons/karambit.glb',
    fallback: 'karambit',
    fit: { rotation: [0, -Math.PI / 2, 0], grip: { position: [0, -0.064, 0] }, hand: { width: 0.03, depth: 0.03, index: 'trigger' } },
    pose: POSE,
  },
  // Balisong: clip-point blade with a serrated spine, skeleton handles with camo inlays (shown open, one piece).
  'model:butterfly': {
    kind: 'gltf',
    url: '/weapons/butterfly.glb',
    fallback: 'karambit',
    fit: { rotation: [0, -Math.PI / 2, 0], grip: { position: [0, -0.069, 0] }, hand: { width: 0.026, depth: 0.012, index: 'trigger' } },
    pose: POSE,
  },
};

/** The model a knife item's asset shows (undefined: not a knife model; the M9 and its finishes). */
export function knifeViewSpec(assetId: string | undefined): WeaponViewSpec | undefined {
  return assetId ? KNIFE_MODEL_VIEWS[assetId] : undefined;
}
