import * as THREE from 'three';

type Vec3 = readonly [number, number, number];

/**
 * Small toolkit for building procedural first-person weapon models.
 * Model space follows WeaponView: barrel/blade forward along -Z, +Y up,
 * +X right, meters. Everything created here is tracked so dispose() frees it.
 */
export class ModelKit {
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly textures: THREE.Texture[] = [];

  mat(params: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial(params);
    this.materials.push(m);
    return m;
  }

  /** A canvas-drawn texture (patterns, gradients) — no image files needed. */
  canvasTexture(width: number, height: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    draw(c.getContext('2d')!, width, height);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    this.textures.push(t);
    return t;
  }

  track<T extends THREE.BufferGeometry>(g: T): T {
    this.geometries.push(g);
    return g;
  }

  mesh(parent: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material, pos: Vec3 = [0, 0, 0], rot: Vec3 = [0, 0, 0], name = ''): THREE.Mesh {
    const m = new THREE.Mesh(this.track(geometry), material);
    m.position.set(pos[0], pos[1], pos[2]);
    m.rotation.set(rot[0], rot[1], rot[2]);
    m.name = name;
    parent.add(m);
    return m;
  }

  box(parent: THREE.Object3D, size: Vec3, material: THREE.Material, pos: Vec3, rot: Vec3 = [0, 0, 0], name = ''): THREE.Mesh {
    return this.mesh(parent, new THREE.BoxGeometry(size[0], size[1], size[2]), material, pos, rot, name);
  }

  /**
   * Cylinder (or cone) along an axis. For axis 'z', `rBack` is the radius at
   * +Z (toward the shooter) and `rFront` at -Z.
   */
  cyl(
    parent: THREE.Object3D,
    rBack: number,
    rFront: number,
    length: number,
    material: THREE.Material,
    pos: Vec3,
    axis: 'x' | 'y' | 'z' = 'z',
    segments = 16,
    name = '',
  ): THREE.Mesh {
    const g = new THREE.CylinderGeometry(rBack, rFront, length, segments);
    if (axis === 'z') g.rotateX(Math.PI / 2);
    else if (axis === 'x') g.rotateZ(-Math.PI / 2);
    return this.mesh(parent, g, material, pos, [0, 0, 0], name);
  }

  /** Flat disc facing +Z (or -Z when `back` is false): lenses, caps. */
  disc(parent: THREE.Object3D, radius: number, material: THREE.Material, pos: Vec3, facingBack = true, segments = 24): THREE.Mesh {
    const g = new THREE.CircleGeometry(radius, segments);
    if (!facingBack) g.rotateY(Math.PI);
    return this.mesh(parent, g, material, pos);
  }

  /**
   * Side-profile extrusion: `outline` points are (z, y) pairs as seen from
   * the right side; the shape is extruded symmetrically along X by
   * `thickness`. Holes cut through (thumbholes, finger rings). UVs are the
   * raw (z, y) coordinates in meters, so textures should set `repeat`.
   */
  profile(
    parent: THREE.Object3D,
    outline: readonly (readonly [number, number])[],
    thickness: number,
    material: THREE.Material,
    opts: { holes?: readonly (readonly (readonly [number, number])[])[]; bevel?: number; x?: number; curveSegments?: number; name?: string } = {},
  ): THREE.Mesh {
    const shape = new THREE.Shape(outline.map(([z, y]) => new THREE.Vector2(z, y)));
    for (const hole of opts.holes ?? []) shape.holes.push(new THREE.Path(hole.map(([z, y]) => new THREE.Vector2(z, y))));
    return this.extrudeShape(parent, shape, thickness, material, opts);
  }

  /** Like profile(), for shapes built with curves (bezier blades etc.). */
  extrudeShape(
    parent: THREE.Object3D,
    shape: THREE.Shape,
    thickness: number,
    material: THREE.Material,
    opts: { bevel?: number; x?: number; curveSegments?: number; name?: string } = {},
  ): THREE.Mesh {
    const bevel = opts.bevel ?? 0;
    const depth = Math.max(thickness - bevel * 2, 0.0005);
    const g = new THREE.ExtrudeGeometry(shape, {
      depth,
      bevelEnabled: bevel > 0,
      bevelThickness: bevel,
      bevelSize: bevel,
      bevelSegments: 2,
      curveSegments: opts.curveSegments ?? 12,
    });
    // Shape (x, y) → model (z, y); extrusion axis → model X, centered.
    g.translate(0, 0, -depth / 2);
    g.rotateY(-Math.PI / 2);
    return this.mesh(parent, g, material, [opts.x ?? 0, 0, 0], [0, 0, 0], opts.name ?? '');
  }

  dispose(): void {
    this.geometries.forEach((g) => g.dispose());
    this.materials.forEach((m) => m.dispose());
    this.textures.forEach((t) => t.dispose());
  }
}

/** Overwrites UVs with model-space (z, y) normalized to the mesh's own bounds (for gradients along a blade). */
export function planarUVsZY(geometry: THREE.BufferGeometry): void {
  geometry.computeBoundingBox();
  const b = geometry.boundingBox!;
  const pos = geometry.getAttribute('position');
  const uv = new Float32Array(pos.count * 2);
  const dz = b.max.z - b.min.z || 1;
  const dy = b.max.y - b.min.y || 1;
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = (pos.getZ(i) - b.min.z) / dz;
    uv[i * 2 + 1] = (pos.getY(i) - b.min.y) / dy;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}
