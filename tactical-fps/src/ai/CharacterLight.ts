import type * as THREE from 'three';

/**
 * Characters never go pitch black: a small constant light on the body's own colour (both teams
 * alike), so a figure in a dark doorway still has a readable shape against the wall behind it.
 * Not a glow and not an outline; it shows only where the body itself is in view (depth tested).
 * (Its own module so the weapons a character holds can share it without importing the body.)
 */
export const CHARACTER_LIFT = 0.11;
export function liftCharacterMaterial(m: THREE.MeshStandardMaterial, k = CHARACTER_LIFT): void {
  if (m.userData.lifted || m.emissive.getHex() !== 0) return;
  m.emissive.copy(m.color).multiplyScalar(k);
  m.userData.lifted = true;
}
