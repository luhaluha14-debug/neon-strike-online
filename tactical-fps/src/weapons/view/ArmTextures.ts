import * as THREE from 'three';

// Procedural cloth / glove textures for the first-person arms. Generated once
// on first use and shared by every FirstPersonArms instance (the arms are
// rebuilt on each weapon switch; these textures are never disposed).

export interface ArmTextureSet {
  /** Ripstop jacket fabric: albedo detail (multiplied by the material colour) + normal map. */
  fabricMap: THREE.Texture;
  fabricNormal: THREE.Texture;
  /** Glove shell: fine synthetic weave + normal map. */
  gloveMap: THREE.Texture;
  gloveNormal: THREE.Texture;
}

let cached: ArmTextureSet | null = null;

export function getArmTextures(): ArmTextureSet {
  if (cached) return cached;
  const fabric = heightField(128, (x, y, rnd) => {
    // Ripstop: a thicker thread every 16 px both ways over a fine 2 px weave.
    const rip = (x % 16 === 0 || y % 16 === 0 ? 0.3 : 0) + (x % 16 === 1 || y % 16 === 1 ? 0.12 : 0);
    const weave = ((x >> 1) + (y >> 1)) % 2 === 0 ? 0.14 : 0;
    return rip + weave + rnd() * 0.22;
  });
  const glove = heightField(128, (x, y, rnd) => {
    const weave = (x + y) % 3 === 0 ? 0.25 : 0;
    return weave + rnd() * 0.3;
  });
  cached = {
    fabricMap: albedoFrom(fabric, 0.84, 0.12),
    fabricNormal: normalFrom(fabric, 2.2),
    gloveMap: albedoFrom(glove, 0.9, 0.12),
    gloveNormal: normalFrom(glove, 1.4),
  };
  // Sleeve UVs: u around the arm (~25 cm), v along it (scaled to the forearm length): ~5 mm ripstop cells.
  cached.fabricMap.repeat.set(6, 8);
  cached.fabricNormal.repeat.set(6, 8);
  // Glove parts are small capsules / boxes with 0..1 UVs per part.
  cached.gloveMap.repeat.set(2, 2);
  cached.gloveNormal.repeat.set(2, 2);
  return cached;
}

interface Field {
  size: number;
  h: Float32Array;
}

function heightField(size: number, f: (x: number, y: number, rnd: () => number) => number): Field {
  let seed = 1234567;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) h[y * size + x] = f(x, y, rnd);
  // One box blur pass: soft threads instead of hard pixel steps.
  const out = new Float32Array(h.length);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += h[((y + dy + size) % size) * size + ((x + dx + size) % size)];
      out[y * size + x] = s / 9;
    }
  }
  return { size, h: out };
}

/** Albedo multiplier around `base` (white = keep material colour). */
function albedoFrom(field: Field, base: number, amount: number): THREE.DataTexture {
  const { size, h } = field;
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < h.length; i++) {
    const v = Math.round(Math.min(1, Math.max(0, base + (h[i] - 0.3) * amount)) * 255);
    data.set([v, v, v, 255], i * 4);
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  return finishTexture(tex);
}

function normalFrom(field: Field, strength: number): THREE.DataTexture {
  const { size, h } = field;
  const at = (x: number, y: number) => h[((y + size) % size) * size + ((x + size) % size)];
  const data = new Uint8Array(size * size * 4);
  const n = new THREE.Vector3();
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      n.set((at(x - 1, y) - at(x + 1, y)) * strength, (at(x, y - 1) - at(x, y + 1)) * strength, 1).normalize();
      data.set([(n.x * 0.5 + 0.5) * 255, (n.y * 0.5 + 0.5) * 255, (n.z * 0.5 + 0.5) * 255, 255], (y * size + x) * 4);
    }
  }
  return finishTexture(new THREE.DataTexture(data, size, size, THREE.RGBAFormat));
}

function finishTexture(tex: THREE.DataTexture): THREE.DataTexture {
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}
