import * as THREE from 'three';
import type { WeaponView } from './WeaponView';

export interface ViewModelMotion {
  /** Look delta this frame (radians) — drives sway. */
  lookYaw: number;
  lookPitch: number;
  /** Horizontal speed normalized to run speed (0..1+). */
  speed01: number;
  grounded: boolean;
  crouching: boolean;
  /** 0..1 while reloading, otherwise null. */
  reloadProgress: number | null;
}

/** Hip position of the weapon in camera space. */
const HIP = new THREE.Vector3(0.13, -0.16, -0.44);

/**
 * Renders the held weapon in its own scene after the world, with the depth
 * buffer cleared, so it never clips into walls and can use its own FOV.
 * Owns all procedural motion so any WeaponView model gets it for free.
 */
export class ViewModelLayer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private view: WeaponView | null = null;
  /** Motion pivot: position/rotation offsets are applied here. */
  private readonly pivot = new THREE.Group();
  private readonly flash: THREE.Mesh;
  private flashTime = 0;

  // Spring-ish state.
  private kick = 0;
  private kickVel = 0;
  private swayX = 0;
  private swayY = 0;
  private bobPhase = 0;
  private bobAmount = 0;
  private magRestY = 0;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(62, aspect, 0.01, 10);
    this.scene.add(this.pivot);
    this.scene.add(new THREE.HemisphereLight(0xc9d4de, 0x4a4238, 1.6));
    const key = new THREE.DirectionalLight(0xfff1dc, 2.2);
    key.position.set(0.6, 1, 0.4);
    this.scene.add(key);

    this.flash = new THREE.Mesh(
      new THREE.PlaneGeometry(0.14, 0.14),
      new THREE.MeshBasicMaterial({
        map: makeFlashTexture(),
        color: 0xffd9a0,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    this.flash.visible = false;
  }

  setView(view: WeaponView): void {
    if (this.view) {
      this.pivot.remove(this.view.object);
      this.view.dispose();
    }
    this.view = view;
    this.pivot.add(view.object);
    view.muzzle.add(this.flash);
    this.magRestY = view.magazine?.position.y ?? 0;
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  onShot(): void {
    this.kickVel += 1.0;
    this.flashTime = 0.045;
    this.flash.rotation.z = Math.random() * Math.PI;
    this.flash.scale.setScalar(0.8 + Math.random() * 0.5);
  }

  update(dt: number, m: ViewModelMotion): void {
    // Recoil kick: damped spring back to rest. Fixed substeps keep it stable
    // even when a frame takes 100 ms.
    const stiffness = 220;
    const damping = 26;
    const steps = Math.ceil(dt / (1 / 240));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.kickVel += (-stiffness * this.kick - damping * this.kickVel) * h;
      this.kick += this.kickVel * h;
    }

    // Sway lags behind look input.
    const swayTargetX = THREE.MathUtils.clamp(-m.lookYaw * 1.2, -0.03, 0.03);
    const swayTargetY = THREE.MathUtils.clamp(m.lookPitch * 1.2, -0.03, 0.03);
    const s = 1 - Math.exp(-10 * dt);
    this.swayX += (swayTargetX - this.swayX) * s;
    this.swayY += (swayTargetY - this.swayY) * s;

    // Walk bob.
    const moving = m.grounded ? Math.min(m.speed01, 1.2) : 0;
    this.bobAmount += (moving - this.bobAmount) * (1 - Math.exp(-8 * dt));
    this.bobPhase += dt * (6 + 5 * m.speed01);
    const bobX = Math.sin(this.bobPhase) * 0.008 * this.bobAmount;
    const bobY = -Math.abs(Math.cos(this.bobPhase)) * 0.008 * this.bobAmount;

    // Reload: dip and roll, magazine drops out and back in.
    let reloadDip = 0;
    let reloadRoll = 0;
    if (m.reloadProgress !== null) {
      const t = m.reloadProgress;
      const envelope = Math.sin(Math.min(t, 1) * Math.PI);
      reloadDip = envelope * 0.07;
      reloadRoll = envelope * 0.55;
      if (this.view?.magazine) {
        const out = t < 0.25 ? t / 0.25 : t < 0.6 ? 1 : Math.max(0, 1 - (t - 0.6) / 0.25);
        this.view.magazine.position.y = this.magRestY - out * 0.25;
        this.view.magazine.visible = !(t > 0.3 && t < 0.55);
      }
    } else if (this.view?.magazine) {
      this.view.magazine.position.y = this.magRestY;
      this.view.magazine.visible = true;
    }

    const crouchOffset = m.crouching ? 0.01 : 0;
    this.pivot.position.set(
      HIP.x + this.swayX + bobX,
      HIP.y + this.swayY + bobY - reloadDip - crouchOffset,
      HIP.z + this.kick * 0.045,
    );
    this.pivot.rotation.set(this.kick * 0.06 + this.swayY * 0.8 - reloadDip * 1.2, this.swayX * 0.8, reloadRoll);

    if (this.flashTime > 0) {
      this.flashTime -= dt;
      this.flash.visible = true;
    } else {
      this.flash.visible = false;
    }
  }

  render(renderer: THREE.WebGLRenderer): void {
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
  }
}

function makeFlashTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 30);
  grad.addColorStop(0, 'rgba(255,250,235,1)');
  grad.addColorStop(0.25, 'rgba(255,200,120,0.8)');
  grad.addColorStop(1, 'rgba(255,150,60,0)');
  g.fillStyle = grad;
  g.beginPath();
  // Four-point star shape.
  for (let i = 0; i < 8; i++) {
    const r = i % 2 === 0 ? 31 : 9;
    const a = (i / 8) * Math.PI * 2;
    g.lineTo(32 + Math.cos(a) * r, 32 + Math.sin(a) * r);
  }
  g.closePath();
  g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
