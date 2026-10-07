import * as THREE from 'three';
import type { WeaponView } from './WeaponView';

/**
 * Placeholder AR-01 built from primitives: a boxy modern rifle with a
 * long slotted handguard, skeletal stock and a compact optic. Original
 * design, ~0.85 m long. Replace with a Blender GLB later (see WeaponView).
 */
export class ProceduralRifleView implements WeaponView {
  readonly object = new THREE.Group();
  readonly muzzle = new THREE.Object3D();
  readonly magazine = new THREE.Group();
  readonly gripAnchor = new THREE.Object3D();
  readonly supportAnchor = new THREE.Object3D();
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];

  constructor() {
    this.object.name = 'AR-01';
    const metal = this.mat(0x2e3134, 0.5, 0.45);
    const polymer = this.mat(0x3b3d3f, 0.05, 0.75);
    const furniture = this.mat(0x7a6e57, 0.02, 0.8);
    const glass = this.mat(0x1a2a30, 0.8, 0.15);

    // Receiver (upper + lower).
    this.box(0.055, 0.05, 0.3, metal, 0, 0.035, -0.02);
    this.box(0.05, 0.045, 0.2, polymer, 0, -0.005, 0.0);
    // Ejection port cover detail.
    this.box(0.004, 0.022, 0.07, polymer, 0.029, 0.04, -0.02);
    // Handguard: long, with vent slots on the sides.
    this.box(0.058, 0.06, 0.3, furniture, 0, 0.03, -0.32);
    for (let i = 0; i < 5; i++) {
      this.box(0.061, 0.012, 0.028, polymer, 0, 0.03, -0.22 - i * 0.05);
    }
    // Top rail running the length of receiver + handguard.
    this.box(0.024, 0.012, 0.58, metal, 0, 0.066, -0.17);
    // Barrel and muzzle device.
    this.cyl(0.011, 0.14, metal, 0, 0.03, -0.54);
    this.cyl(0.016, 0.055, metal, 0, 0.03, -0.63);
    this.muzzle.position.set(0, 0.03, -0.665);
    this.object.add(this.muzzle);
    // Front sight post (folded) near the end of the rail.
    this.box(0.018, 0.02, 0.02, metal, 0, 0.082, -0.44);

    // Optic: compact housing with a lens.
    this.box(0.034, 0.04, 0.1, metal, 0, 0.094, -0.08);
    this.box(0.028, 0.028, 0.004, glass, 0, 0.098, -0.131);
    this.box(0.028, 0.028, 0.004, glass, 0, 0.098, -0.029);

    // Pistol grip (angled back) and trigger guard.
    const grip = this.box(0.036, 0.1, 0.045, furniture, 0, -0.065, 0.075);
    grip.rotation.x = 0.32;
    this.gripAnchor.position.copy(grip.position);
    this.gripAnchor.rotation.x = 0.32;
    // Off hand under the handguard, a little toward the muzzle.
    this.supportAnchor.position.set(0, 0.0, -0.34);
    this.object.add(this.gripAnchor, this.supportAnchor);
    this.box(0.012, 0.008, 0.06, metal, 0, -0.038, 0.025);

    // Magazine (slightly curved: two angled blocks) — its own group for reload animation.
    this.magazine.position.set(0, -0.03, -0.055);
    const magTop = this.box(0.03, 0.08, 0.065, polymer, 0, -0.04, 0, this.magazine);
    magTop.rotation.x = 0.08;
    const magBottom = this.box(0.03, 0.07, 0.062, polymer, 0, -0.105, -0.012, this.magazine);
    magBottom.rotation.x = 0.26;
    this.object.add(this.magazine);

    // Skeletal stock: buffer tube + frame + butt pad.
    this.cyl(0.015, 0.16, metal, 0, 0.02, 0.19);
    this.box(0.03, 0.012, 0.18, furniture, 0, 0.045, 0.2);
    this.box(0.03, 0.012, 0.16, furniture, 0, -0.035, 0.215).rotation.x = -0.22;
    this.box(0.034, 0.1, 0.022, polymer, 0, 0.0, 0.29);

    this.object.traverse((o) => {
      o.frustumCulled = false;
    });
  }

  dispose(): void {
    this.geometries.forEach((g) => g.dispose());
    this.materials.forEach((m) => m.dispose());
  }

  private mat(color: number, metalness: number, roughness: number): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ color, metalness, roughness });
    this.materials.push(m);
    return m;
  }

  private box(
    w: number,
    h: number,
    d: number,
    mat: THREE.Material,
    x: number,
    y: number,
    z: number,
    parent: THREE.Object3D = this.object,
  ): THREE.Mesh {
    const g = new THREE.BoxGeometry(w, h, d);
    this.geometries.push(g);
    const mesh = new THREE.Mesh(g, mat);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  }

  private cyl(radius: number, length: number, mat: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
    const g = new THREE.CylinderGeometry(radius, radius, length, 12);
    g.rotateX(Math.PI / 2);
    this.geometries.push(g);
    const mesh = new THREE.Mesh(g, mat);
    mesh.position.set(x, y, z);
    this.object.add(mesh);
    return mesh;
  }
}
