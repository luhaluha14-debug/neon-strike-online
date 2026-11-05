import * as THREE from 'three';

// Surface detail for the weapon models' plain materials (the GLB files ship
// without textures, and without UVs on most parts). A small shader patch adds
// what a texture would: metal parts get a fine machined grain and patches of
// wear in their roughness (highlights break up the way they do on real steel),
// polymer and painted parts a fine stipple in roughness and a faint tone
// variation. Driven by each part's own vertex positions (in metres: the part's
// scale applied), so it sticks to the part as it moves and needs no UVs. Colour, metalness and roughness stay what
// the file or a skin sets (only varied around them), so every skin keeps its look.

const GRAIN_KEY = 'weapon-grain';

/** Model parts left over from modelling (boolean cutters) that the file still contains. */
const CUTTER = /cutter|^fh_slot_\d+$|^stock_slot$/i;

let cutterMaterial: THREE.MeshStandardMaterial | null = null;

/**
 * Prepares a freshly loaded weapon scene once (shared by all its views): the
 * leftover cutter parts, untextured white in the file, become the dark cavity
 * they were meant to cut (a slot, a port, a hole); every other material gets
 * the surface grain.
 */
export function prepareWeaponScene(scene: THREE.Object3D): void {
  const seen = new Set<THREE.Material>();
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mat = mesh.material;
    if (Array.isArray(mat)) return;
    if (CUTTER.test(mesh.name) && !mat.name) {
      cutterMaterial ??= new THREE.MeshStandardMaterial({ name: 'Cavity', color: 0x0b0b0c, metalness: 0.2, roughness: 0.9 });
      mesh.material = cutterMaterial;
      return;
    }
    if (!seen.has(mat)) {
      seen.add(mat);
      addWeaponGrain(mat);
    }
  });
}

/** Adds the surface grain to a weapon material (idempotent; also used on skinned copies). */
export function addWeaponGrain(material: THREE.Material): void {
  const m = material as THREE.MeshStandardMaterial;
  if (!m.isMeshStandardMaterial || m.userData.grain) return;
  // Very smooth parts (scope glass) stay clean.
  if (m.roughness < 0.1) return;
  const metal = m.metalness >= 0.55;
  m.userData.grain = metal ? 'metal' : 'poly';
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGrainPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGrainPos = position * vec3(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz), length(modelMatrix[2].xyz));');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vGrainPos;\n${NOISE}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${metal ? METAL_ROUGHNESS : POLY_ROUGHNESS}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${metal ? METAL_TONE : POLY_TONE}`);
  };
  m.customProgramCacheKey = () => `${GRAIN_KEY}-${metal ? 'metal' : 'poly'}`;
  m.needsUpdate = true;
}

const NOISE = /* glsl */ `
float grainHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float grainNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(grainHash(i), grainHash(i + vec3(1.0, 0.0, 0.0)), f.x), mix(grainHash(i + vec3(0.0, 1.0, 0.0)), grainHash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
    mix(mix(grainHash(i + vec3(0.0, 0.0, 1.0)), grainHash(i + vec3(1.0, 0.0, 1.0)), f.x), mix(grainHash(i + vec3(0.0, 1.0, 1.0)), grainHash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y),
    f.z);
}
`;

// Metal: soft patches of handling wear (smoother, brighter) over a fine machined grain.
const METAL_ROUGHNESS = /* glsl */ `
{
  float wear = smoothstep(0.55, 0.85, grainNoise(vGrainPos * 38.0));
  float fine = grainNoise(vGrainPos * 300.0);
  roughnessFactor = clamp(roughnessFactor * (0.92 + fine * 0.22) - wear * 0.12, 0.05, 1.0);
}
`;
const METAL_TONE = /* glsl */ `
diffuseColor.rgb *= 0.94 + 0.1 * smoothstep(0.55, 0.85, grainNoise(vGrainPos * 38.0));
`;

// Polymer / paint: a fine stipple (grip texture) and a slight blotchy tone.
const POLY_ROUGHNESS = /* glsl */ `
roughnessFactor = clamp(roughnessFactor * (0.86 + grainNoise(vGrainPos * 450.0) * 0.26), 0.05, 1.0);
`;
const POLY_TONE = /* glsl */ `
diffuseColor.rgb *= 0.95 + 0.08 * grainNoise(vGrainPos * 24.0) + 0.04 * grainNoise(vGrainPos * 450.0);
`;
