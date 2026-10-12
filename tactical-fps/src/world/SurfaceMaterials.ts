import * as THREE from 'three';
import type { QualityLevel } from '../config';

// Surface detail for the Blender maps.
//
// The map GLBs use flat-coloured materials only: no textures and almost no
// UVs (12 of 1004 primitives on Seoul). So instead of image textures, each
// material is classified by its name into a physical surface type and gets
// a small shader patch that adds world-space (triplanar) detail from one
// shared, procedurally generated noise texture:
//   - large-scale tone variation and stains (no visible tiling: two scales
//     at a non-integer ratio),
//   - roughness variation, fine grain as a bump on the normal,
//   - rain streaks on walls, dirt on upward faces, worn paint,
//   - laid units with joints: brick courses on walls, pavers and slab
//     joints on floors.
// One extra texture (256², ~0.35 MB with mips) for the whole map, no extra
// draw calls; shader programs are shared by all patched materials.
// Per quality preset:
//   low    - physical roughness / metalness per surface type only (no shader patch, no reflections)
//   medium - patch with 2 texture fetches (+1 on walls with streaks), reflections on glass / metal / water
//   high   - adds a separate fine-grain layer (3 fetches)

export type SurfaceKind =
  | 'asphalt'
  | 'concrete'
  | 'stone'
  | 'paver'
  | 'brick'
  | 'metal'
  | 'paintedMetal'
  | 'rust'
  | 'glass'
  | 'roadPaint'
  | 'paint'
  | 'carPaint'
  | 'wood'
  | 'dirt'
  | 'grass'
  | 'foliage'
  | 'rubber'
  | 'water'
  | 'light'
  | 'default';

interface SurfacePreset {
  /** Gets the sky environment map (reflections). Rough diffuse surfaces skip it: the sky fill light covers them far cheaper. */
  reflective: boolean;
  roughness: number;
  /** null = keep the GLB value. */
  metalness: number | null;
  envMapIntensity: number;
  /** Tone variation amount (0..~0.25). */
  colorVar: number;
  roughVar: number;
  /** Normal perturbation strength from the grain. */
  bump: number;
  /** Texture repeats per metre (detail layer). */
  scale: number;
  /** Vertical rain/grime streaks on walls. */
  streaks: number;
  /** Dirt collecting on upward-facing surfaces. */
  topDirt: number;
  /** Worn-through paint. */
  wear: number;
  /** Colour revealed by dirt / wear (linear). */
  wearColor: number;
  /** Fine aggregate / grain contrast (separate high-frequency layer). */
  grain: number;
  /** Laid units with joints: bricks on walls, pavers / slabs on floors. */
  pattern: Pattern | null;
}

interface Pattern {
  on: 'walls' | 'floors';
  /** Unit size incl. joint (m), along the surface and up / across. */
  size: readonly [number, number];
  /** Joint width (m). */
  joint: number;
  /** Row offset as a fraction of a unit (0.5 = running bond). */
  bond: number;
  /** Tone variation between units. */
  tone: number;
  /** Joint colour: fraction of the surface colour, or 0 = light mortar grey. */
  jointShade: number;
}

const P = (p: Partial<SurfacePreset>): SurfacePreset => ({
  reflective: false,
  roughness: 0.8,
  metalness: 0,
  envMapIntensity: 1,
  colorVar: 0.06,
  roughVar: 0.08,
  bump: 0,
  scale: 0.3,
  streaks: 0,
  topDirt: 0,
  wear: 0,
  wearColor: 0x4a443b,
  grain: 0.05,
  pattern: null,
  ...p,
});

export const SURFACE_PRESETS: Record<SurfaceKind, SurfacePreset> = {
  asphalt: P({ roughness: 0.93, colorVar: 0.18, roughVar: 0.06, bump: 0.9, scale: 0.45, grain: 0.35, wearColor: 0x1d1c1a }),
  concrete: P({
    roughness: 0.88, colorVar: 0.13, roughVar: 0.08, bump: 0.45, scale: 0.28, streaks: 0.2, topDirt: 0.25, grain: 0.16,
    // Cast slabs with saw-cut joints on floors and roofs.
    pattern: { on: 'floors', size: [2.4, 2.4], joint: 0.012, bond: 0, tone: 0.08, jointShade: 0.6 },
  }),
  stone: P({ roughness: 0.8, colorVar: 0.11, roughVar: 0.1, bump: 0.4, scale: 0.55, streaks: 0.1, topDirt: 0.15, grain: 0.22 }),
  paver: P({
    roughness: 0.84, colorVar: 0.1, roughVar: 0.1, bump: 0.5, scale: 0.55, topDirt: 0.2, grain: 0.2,
    pattern: { on: 'floors', size: [0.4, 0.2], joint: 0.008, bond: 0.5, tone: 0.18, jointShade: 0.5 },
  }),
  brick: P({
    roughness: 0.88, colorVar: 0.1, roughVar: 0.08, bump: 0.6, scale: 0.4, streaks: 0.16, grain: 0.12,
    // 215 x 65 mm bricks, 10 mm mortar, running bond.
    pattern: { on: 'walls', size: [0.225, 0.075], joint: 0.01, bond: 0.5, tone: 0.28, jointShade: 0 },
  }),
  metal: P({ reflective: true, roughness: 0.38, metalness: 0.85, colorVar: 0.06, roughVar: 0.2, bump: 0.08, scale: 0.9, streaks: 0.08 }),
  paintedMetal: P({ reflective: true, roughness: 0.55, metalness: 0.25, colorVar: 0.07, roughVar: 0.15, bump: 0.1, scale: 0.6, streaks: 0.22, wear: 0.12, wearColor: 0x3a2a20 }),
  rust: P({ roughness: 0.86, metalness: 0.15, colorVar: 0.2, roughVar: 0.1, bump: 0.5, scale: 0.6, streaks: 0.2, grain: 0.15 }),
  glass: P({ reflective: true, roughness: 0.06, metalness: 0.85, envMapIntensity: 1.1, colorVar: 0.03, roughVar: 0.05, scale: 0.15, streaks: 0.08, grain: 0 }),
  roadPaint: P({ roughness: 0.62, colorVar: 0.08, roughVar: 0.1, bump: 0.35, scale: 0.45, wear: 0.4, wearColor: 0x242322, grain: 0.2 }),
  paint: P({ roughness: 0.6, colorVar: 0.05, roughVar: 0.1, bump: 0.08, scale: 0.4, streaks: 0.12, wear: 0.04 }),
  carPaint: P({ reflective: true, roughness: 0.3, metalness: 0.35, colorVar: 0.02, roughVar: 0.06, scale: 0.5, topDirt: 0.1, grain: 0 }),
  wood: P({ roughness: 0.8, colorVar: 0.15, roughVar: 0.08, bump: 0.35, scale: 0.7, streaks: 0.1, grain: 0.1 }),
  dirt: P({ roughness: 0.96, colorVar: 0.22, roughVar: 0.04, bump: 0.7, scale: 0.5, grain: 0.3 }),
  grass: P({ roughness: 0.95, colorVar: 0.22, roughVar: 0.04, bump: 0.5, scale: 0.35, grain: 0.25 }),
  foliage: P({ roughness: 0.82, colorVar: 0.14, roughVar: 0.06, scale: 0.5 }),
  rubber: P({ roughness: 0.82, colorVar: 0.04, roughVar: 0.06, bump: 0.1, scale: 0.8 }),
  // Reflects the sky at grazing angles only; the stream bed colour shows looking down.
  water: P({ reflective: true, roughness: 0.1, metalness: 0, envMapIntensity: 0.65, colorVar: 0.05, roughVar: 0.03, bump: 0.25, scale: 0.6, grain: 0 }),
  light: P({ roughness: 0.3, colorVar: 0 }),
  default: P({ roughness: 0.7, colorVar: 0.06, roughVar: 0.08, bump: 0.15, scale: 0.4, streaks: 0.08 }),
};

/** Ordered: the first matching rule wins. Names come from the Blender material names. */
const RULES: readonly [RegExp, SurfaceKind][] = [
  [/lamp_glass|lampglass|headlight|taillight|led_strip|lamp_warm|lamp_head/i, 'light'],
  [/water|foam/i, 'water'],
  [/glass/i, 'glass'],
  [/asphalt/i, 'asphalt'],
  [/line_|marking|stencil|paint_yellow|hatch|buslane|zone_/i, 'roadPaint'],
  [/vh_paint|vh_bus|vh_truck|police_bus|taxi/i, 'carPaint'],
  [/tire|rubber|trashbag|cable|bumper|black_plastic/i, 'rubber'],
  [/rust/i, 'rust'],
  [/brick_lintel/i, 'stone'],
  [/mortar/i, 'concrete'],
  [/brick/i, 'brick'],
  [/paver|plaza_block|sidewalk_block|jamsil_tile|flagstone|steppingstone/i, 'paver'],
  [/granite|stone|paver|boulder|flagstone|ashlar|voussoir|curb|cascade|weir|cinder|outcrop|sidewalk_block|plaza_block/i, 'stone'],
  [/steel|_rail|alu|mullion|grate|iron|rebar|rim|lantern|chrome|stud_gold|bronze/i, 'metal'],
  [/frame|pole|gutter|shutter|louver|cladding|_rib|canopy|antenna|bars|tank|_ac$|dumpster|container|kiosk|metal|fan|roof_unit|seam|mech/i, 'paintedMetal'],
  [/bark|wood|ply|plank|bench|crate|cardboard/i, 'wood'],
  [/soil|mud|dirt|earth|gravel|pebble/i, 'dirt'],
  [/bank_grass|park_ground|grass/i, 'grass'],
  [/leaf|reed|vine|needle|broadleaf|iris|flower|forest|ginkgo|net_green|lovelock/i, 'foliage'],
  [/sign|awning|door|dancheong|gate|panel_red|column|lattice|plaque|eave|barricade|barrel|ramp|figurine|bike/i, 'paint'],
  [/concrete|conc|plinth|coping|cornice|pilaster|plaster|tile|panel|plaza|platform|barrier|bldg_|parapet|joint|spandrel|deck|weep|stain|grime|tie|broken|white|ridge|walkway/i, 'concrete'],
];

export function classifySurface(materialName: string): SurfaceKind {
  for (const [re, kind] of RULES) if (re.test(materialName)) return kind;
  return 'default';
}

/**
 * Upgrades every MeshStandardMaterial under `root` in place. Returns how many
 * materials of each kind were found (logged by the caller).
 */
export function enhanceMapMaterials(root: THREE.Object3D, quality: QualityLevel, envMap: THREE.Texture | null): Record<string, number> {
  const counts: Record<string, number> = {};
  const done = new Set<THREE.Material>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const mat = m as THREE.MeshStandardMaterial;
      if (!mat.isMeshStandardMaterial || done.has(mat)) continue;
      done.add(mat);
      const kind = classifySurface(mat.name);
      counts[kind] = (counts[kind] ?? 0) + 1;
      applySurface(mat, kind, quality);
      // Low quality: no sky reflections (and no shader patch, see applySurface).
      mat.envMap = SURFACE_PRESETS[kind].reflective && quality !== 'low' ? envMap : null;
    }
  });
  return counts;
}

function applySurface(mat: THREE.MeshStandardMaterial, kind: SurfaceKind, quality: QualityLevel): void {
  const p = SURFACE_PRESETS[kind];
  mat.roughness = p.roughness;
  if (p.metalness !== null) mat.metalness = p.metalness;
  mat.envMapIntensity = p.envMapIntensity;
  if (quality === 'low') {
    // Performance first: physical roughness / metalness only, zero per-pixel cost.
    // Without reflections, strong metalness would just render black.
    mat.metalness = Math.min(mat.metalness, 0.3);
    if (kind === 'light') mat.emissive.copy(mat.color).multiplyScalar(0.35);
    return;
  }
  if (kind === 'light') {
    // Lamp glass reads as lit, gently; daylight scene, so no bloom-style glow.
    mat.emissive.copy(mat.color).multiplyScalar(0.35);
    return;
  }
  if (kind === 'glass') {
    // Window glass: dark, tinted reflections of the sky instead of a flat colour.
    mat.color.multiplyScalar(0.55);
  }

  const uniforms = {
    surfNoise: { value: getNoiseTexture() },
    surfA: { value: new THREE.Vector4(p.colorVar, p.roughVar, p.bump, p.scale) },
    surfB: { value: new THREE.Vector4(p.streaks, p.topDirt, p.wear, 0) },
    surfC: { value: new THREE.Vector4(p.grain, p.pattern ? (p.pattern.on === 'walls' ? 1 : 2) : 0, p.pattern?.bond ?? 0, p.pattern?.tone ?? 0) },
    surfP: {
      value: p.pattern
        ? new THREE.Vector4(p.pattern.size[0], p.pattern.size[1], p.pattern.joint, p.pattern.jointShade)
        : new THREE.Vector4(1, 1, 0, 0),
    },
    surfWear: { value: new THREE.Color(p.wearColor) },
  };
  // Medium skips the separate fine-grain fetch (2 fetches instead of 3).
  const qualityDefine = quality === 'high' ? '' : '#define SURF_MEDIUM\n';
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSurfPos;\nvarying vec3 vSurfN;')
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\nvSurfPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvSurfN = normalize(mat3(modelMatrix) * objectNormal);',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + qualityDefine + SURF_PARS)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + SURF_COLOR)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n' + SURF_ROUGHNESS)
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + SURF_NORMAL);
  };
  // Same GLSL for every patched material: one program per light/fog setup, not per material.
  mat.customProgramCacheKey = () => 'surface-v3' + quality;
  mat.needsUpdate = true;
}

const SURF_PARS = /* glsl */ `
uniform sampler2D surfNoise;
uniform vec4 surfA; // colorVar, roughVar, bump, scale
uniform vec4 surfB; // streaks, topDirt, wear, -
uniform vec4 surfC; // grain, pattern mode (0 none, 1 walls, 2 floors), bond offset, unit tone variation
uniform vec4 surfP; // unit size x, y (m), joint width (m), joint shade
uniform vec3 surfWear;
varying vec3 vSurfPos;
varying vec3 vSurfN;

// Planar projection on the dominant axis: one texture fetch per layer. The
// maps are built from axis-aligned blocks, so seams on diagonal faces are rare.
vec2 surfPlane(vec3 p, vec3 a) {
  return (a.y >= a.x && a.y >= a.z) ? p.xz : (a.x >= a.z ? p.zy : p.xy);
}
float surfHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
// Same surface-gradient bump as three's perturbNormalArb, from a scalar height.
vec3 surfPerturb(vec3 pos, vec3 n, float h, float strength, float faceDir) {
  vec3 sx = dFdx(pos);
  vec3 sy = dFdy(pos);
  vec3 r1 = cross(sy, n);
  vec3 r2 = cross(n, sx);
  float det = dot(sx, r1) * faceDir;
  vec2 dh = vec2(dFdx(h), dFdy(h)) * strength;
  vec3 grad = sign(det) * (dh.x * r1 + dh.y * r2);
  return normalize(abs(det) * n - grad);
}
`;

const SURF_COLOR = /* glsl */ `
vec3 surfN = normalize(vSurfN);
vec3 surfAbs = abs(surfN);
// 1 for floors / roofs, 0 for walls.
float surfFlat = smoothstep(0.55, 0.8, surfAbs.y);
vec2 surfUV = surfPlane(vSurfPos, surfAbs);
vec4 surfD = texture2D(surfNoise, surfUV * surfA.w);
// Second, much larger layer at a non-integer ratio and offset: breaks up any repetition.
vec4 surfM = texture2D(surfNoise, (surfUV + vec2(17.3, 31.7)) * surfA.w * 0.137);
#ifdef SURF_MEDIUM
float surfGrain = surfD.b;
#else
// Fine aggregate, ~1 cm features.
float surfGrain = texture2D(surfNoise, surfUV * surfA.w * 6.3 + 0.37).b;
#endif
float surfBlot = surfM.g * 0.65 + surfD.g * 0.35;
float surfHeight = surfGrain * 0.6 + surfD.r * 0.4;
float surfRough = 0.0;

// Tone variation, stains and grain.
diffuseColor.rgb *= 1.0 + (surfBlot - 0.5) * 2.0 * surfA.x + (surfGrain - 0.5) * surfC.x;

// Laid units with joints (bricks on walls, pavers / slabs on floors).
if (surfC.y > 0.5) {
  bool surfWalls = surfC.y < 1.5;
  float apply = surfWalls ? 1.0 - surfFlat : surfFlat;
  if (apply > 0.0) {
    vec2 q = surfWalls ? vec2(surfAbs.x > surfAbs.z ? vSurfPos.z : vSurfPos.x, vSurfPos.y) : vSurfPos.xz;
    vec2 bc = q / surfP.xy;
    bc.x += mod(floor(bc.y), 2.0) * surfC.z;
    vec2 cell = floor(bc);
    vec2 f = fract(bc);
    vec2 jw = 0.5 * surfP.z / surfP.xy;
    vec2 aa = max(fwidth(bc), vec2(1e-5));
    vec2 e = smoothstep(jw - aa, jw + aa, f) * smoothstep(jw - aa, jw + aa, 1.0 - f);
    // Joints thinner than ~half a pixel fade out instead of aliasing; so does the unit tone.
    float jointVis = smoothstep(0.25, 0.8, min(jw.x / aa.x, jw.y / aa.y));
    float cellVis = 1.0 - smoothstep(0.2, 0.5, max(aa.x, aa.y));
    float m = mix(1.0, e.x * e.y, jointVis);
    float tone = 1.0 + (surfHash(cell) - 0.5) * surfC.w * cellVis;
    vec3 jointCol = surfP.w > 0.0 ? diffuseColor.rgb * surfP.w : vec3(0.36, 0.34, 0.31) * (0.85 + surfD.r * 0.3);
    diffuseColor.rgb = mix(diffuseColor.rgb, mix(jointCol, diffuseColor.rgb * tone, m), apply);
    surfHeight = mix(surfHeight, surfHeight * 0.3 + m * 0.8, apply * jointVis);
    surfRough += (1.0 - m) * 0.06 * apply;
  }
}

// Rain streaks running down walls.
float surfVert = 1.0 - surfFlat;
float surfStreak = 0.0;
if (surfB.x > 0.0 && surfVert > 0.0) surfStreak = texture2D(surfNoise, vec2((vSurfPos.x + vSurfPos.z) * surfA.w * 1.9, vSurfPos.y * surfA.w * 0.11)).a;
diffuseColor.rgb *= 1.0 - surfB.x * surfVert * smoothstep(0.42, 0.8, surfStreak);
// Ground and roofs collect dirt: a little darker overall, darker patches.
float surfUp = surfFlat * step(0.0, surfN.y);
diffuseColor.rgb *= 1.0 - surfB.y * 0.5 * surfUp;
diffuseColor.rgb = mix(diffuseColor.rgb, surfWear, surfB.y * surfUp * smoothstep(0.45, 0.8, surfM.r));
// Worn-through paint.
float surfWearMask = surfB.z * smoothstep(0.52, 0.78, surfD.a * 0.55 + surfM.g * 0.45);
diffuseColor.rgb = mix(diffuseColor.rgb, surfWear, surfWearMask);
surfRough += surfWearMask * 0.2;
`;

const SURF_ROUGHNESS = /* glsl */ `
roughnessFactor = clamp(roughnessFactor + surfRough + (surfD.r - 0.5) * surfA.y * 2.0 + (surfBlot - 0.5) * surfA.y, 0.03, 1.0);
`;

const SURF_NORMAL = /* glsl */ `
// Fine grain as a bump; faded with distance so it never shimmers.
float surfFade = 1.0 - smoothstep(12.0, 45.0, length(vViewPosition));
if (surfA.z > 0.0 && surfFade > 0.0) normal = surfPerturb(-vViewPosition, normal, surfHeight, surfA.z * 0.012 * surfFade, faceDirection);
`;

// ---- Shared noise texture ----------------------------------------------------

let noiseTexture: THREE.DataTexture | null = null;

/**
 * 256² RGBA tileable noise, generated once:
 *   R: fbm (mid), G: large blotches, B: fine grain, A: ridged (cracks / streaks).
 */
export function getNoiseTexture(): THREE.DataTexture {
  if (noiseTexture) return noiseTexture;
  const N = 256;
  const data = new Uint8Array(N * N * 4);
  const channels = [
    (x: number, y: number) => fbm(x, y, 8, 5, 1),
    (x: number, y: number) => fbm(x, y, 4, 4, 2),
    (x: number, y: number) => fbm(x, y, 32, 3, 3),
    (x: number, y: number) => 1 - Math.abs(fbm(x, y, 6, 4, 4) * 2 - 1),
  ];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      for (let c = 0; c < 4; c++) data[i + c] = Math.round(Math.min(Math.max(channels[c](x / N, y / N), 0), 1) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  noiseTexture = tex;
  return tex;
}

/** Periodic value-noise fbm on the unit square (period = `base` cells at octave 0). */
function fbm(u: number, v: number, base: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let period = base;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(u * period, v * period, period, seed * 131 + o * 17);
    norm += amp;
    amp *= 0.5;
    period *= 2;
  }
  // Stretch the contrast a little: fbm clusters around 0.5.
  return 0.5 + (sum / norm - 0.5) * 1.6;
}

function valueNoise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const h = (a: number, b: number) => lattice(((a % period) + period) % period, ((b % period) + period) % period, seed);
  const a = h(xi, yi);
  const b = h(xi + 1, yi);
  const c = h(xi, yi + 1);
  const d = h(xi + 1, yi + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function lattice(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
