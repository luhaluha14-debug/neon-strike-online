import * as THREE from 'three';

// Overcast late-afternoon sky, kept in the existing look (the old flat
// background colour 0x9fb0bf sits between these horizon and zenith tones).
//
// - A sky dome (one draw call, follows the camera) replaces the flat
//   background colour with a soft gradient and a warm glow toward the sun.
// - The same gradient, plus a bright sun disc, is pre-filtered once into an
//   environment map so metal, glass, water and wet-ish surfaces reflect a sky
//   instead of nothing, and diffuse surfaces get sky-coloured ambient light.

export const SKY = {
  zenith: new THREE.Color(0x7d93a8),
  horizon: new THREE.Color(0xbcc7cf),
  ground: new THREE.Color(0x4e4b46),
  sunGlow: new THREE.Color(0xf3e2c4),
} as const;

/** Colour of the sky right at the horizon: the fog fades into it. */
export const HORIZON_COLOR = SKY.horizon;

function skyColor(dir: THREE.Vector3, sunDir: THREE.Vector3, out: THREE.Color): THREE.Color {
  const y = dir.y;
  if (y >= 0) {
    out.copy(SKY.horizon).lerp(SKY.zenith, Math.pow(y, 0.6));
  } else {
    out.copy(SKY.horizon).lerp(SKY.ground, Math.min(1, Math.pow(-y, 0.45) * 1.2));
  }
  // Broad warm glow around the sun direction.
  const glow = Math.pow(Math.max(0, dir.dot(sunDir)), 6) * 0.45;
  return out.lerp(SKY.sunGlow, glow);
}

function domeGeometry(sunDir: THREE.Vector3): THREE.BufferGeometry {
  const geo = new THREE.SphereGeometry(1, 48, 24);
  const pos = geo.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  const d = new THREE.Vector3();
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    d.fromBufferAttribute(pos, i).normalize();
    skyColor(d, sunDir, c);
    colors.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

/** Visible sky dome. Add to the scene and call `follow(camera)` every frame. */
export class SkyDome {
  readonly mesh: THREE.Mesh;

  constructor(sunDir: THREE.Vector3) {
    this.mesh = new THREE.Mesh(
      domeGeometry(sunDir),
      new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }),
    );
    this.mesh.name = 'SkyDome';
    // Drawn after the opaque world with depth testing, so only pixels where
    // the sky is actually visible get shaded (no full-screen overdraw).
    this.mesh.renderOrder = 1000;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
  }

  /** Keeps the dome centred on the camera, inside the far plane. */
  follow(camera: THREE.PerspectiveCamera): void {
    // 0.99: the sphere's faces (48 x 24 segments) sit >= 0.991 r from the centre, so inside the far plane.
    const r = camera.far * 0.99;
    this.mesh.matrix.makeScale(r, r, r).setPosition(camera.position);
    this.mesh.matrixWorld.copy(this.mesh.matrix);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

/** Pre-filtered (PMREM) environment map of the same sky with a sun disc. Built once. */
export function createSkyEnvironment(renderer: THREE.WebGLRenderer, sunDir: THREE.Vector3): THREE.Texture {
  const scene = new THREE.Scene();
  const dome = new THREE.Mesh(domeGeometry(sunDir), new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide }));
  scene.add(dome);
  // HDR sun disc: gives metals and glass a believable highlight in the sun direction.
  const sun = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(14, 12.5, 10.5) }));
  sun.position.copy(sunDir).multiplyScalar(0.9);
  scene.add(sun);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(scene, 0, 0.1, 10).texture;
  pmrem.dispose();
  dome.geometry.dispose();
  (dome.material as THREE.Material).dispose();
  sun.geometry.dispose();
  (sun.material as THREE.Material).dispose();
  return env;
}
