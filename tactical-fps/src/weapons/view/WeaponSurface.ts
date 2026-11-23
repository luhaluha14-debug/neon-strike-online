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
      realisticFinish(mat);
      addWeaponGrain(mat);
    }
  });
}

/**
 * Phase 31: the files' plain materials brought into physically plausible ranges (once, on the file's own
 * materials — a skin sets its own colours on its copies afterwards, so every skin keeps its look):
 *  - metal finishes (parkerized / anodized steel, aluminium): a dark finish still reflects about 6–8 % of the
 *    light (a near-0 colour on a metal reads as a black hole with no highlight at all); roughness kept in the
 *    range of a worn matte to satin finish;
 *  - polymer and paint: a black plastic is never quite 0 (about 3 % albedo); never mirror-smooth;
 *  - rubber: the darkest, fully matte, no metal;
 *  - glass, bores and cavities stay as they are.
 * Also mends a file defect: the SR-01's olive stock was exported without its colour (white).
 */
export function realisticFinish(material: THREE.Material): void {
  const m = material as THREE.MeshStandardMaterial;
  if (!m.isMeshStandardMaterial || m.userData.finish) return;
  m.userData.finish = true;
  const white = m.color.r > 0.99 && m.color.g > 0.99 && m.color.b > 0.99;
  if (/^Stock_Olive$/i.test(m.name) && white) {
    m.color.setHex(0x59603c);
    m.metalness = 0;
    m.roughness = 0.62;
    return;
  }
  if (m.roughness < 0.1 || /glass|lens|bore|cavity/i.test(m.name)) return;
  const floor = (f: number) => {
    const lum = 0.2126 * m.color.r + 0.7152 * m.color.g + 0.0722 * m.color.b;
    if (lum >= f) return;
    if (lum <= 1e-4) m.color.setRGB(f, f, f);
    else {
      // Same hue, lifted to the floor.
      m.color.multiplyScalar(f / lum);
    }
  };
  if (/rubber|groove/i.test(m.name)) {
    floor(0.018);
    m.metalness = 0;
    m.roughness = Math.max(m.roughness, 0.85);
  } else if (m.metalness >= 0.55) {
    floor(0.065);
    m.roughness = THREE.MathUtils.clamp(m.roughness, 0.28, 0.6);
  } else {
    floor(0.03);
    m.roughness = Math.max(m.roughness, 0.45);
  }
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
