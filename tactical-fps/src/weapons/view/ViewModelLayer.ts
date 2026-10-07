import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { FirstPersonArms } from './FirstPersonArms';
import type { ViewmodelPose, WeaponCategory } from '../WeaponDefinition';
import type { WeaponAnimState, WeaponView } from './WeaponView';

export interface ViewModelMotion {
  /** Look delta this frame (radians) — drives sway. */
  lookYaw: number;
  lookPitch: number;
  /** Horizontal speed normalized to run speed (0..1+). */
  speed01: number;
  grounded: boolean;
  crouching: boolean;
}

/** Duration of the placeholder melee slash (s). */
const SLASH_TIME = 0.32;

/**
 * Renders the held weapon in its own scene after the world, with the depth
 * buffer cleared, so it never clips into walls and can use its own FOV.
 * Owns all generic procedural motion (sway, bob, recoil kick, equip, reload
 * dip, melee slash, inspect) so any WeaponView model gets it for free; the
 * model only animates its own special parts via `animate()`.
 */
export class ViewModelLayer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  /**
   * Rest pose of the current weapon in camera space. Initialised from the
   * weapon definition's `view.pose`; can be changed live (e.g. from the dev
   * console) to tune offsets without touching weapon logic.
   */
  readonly restPosition = new THREE.Vector3(0.125, -0.115, -0.42);
  readonly restRotation = new THREE.Euler(0.03, 0.27, -0.1);
  restScale = 1;
  private view: WeaponView | null = null;
  private arms: FirstPersonArms | null = null;
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

  /** The model currently in hand (debug / tests). */
  get currentView(): WeaponView | null {
    return this.view;
  }

  get currentArms(): FirstPersonArms | null {
    return this.arms;
  }

  /** Puts a weapon model in the hands at its configured pose. */
  setView(view: WeaponView, pose?: ViewmodelPose): void {
    this.flash.removeFromParent();
    if (this.view) {
      this.pivot.remove(this.view.object);
      this.view.dispose();
    }
    if (this.arms) {
      this.pivot.remove(this.arms.object);
      this.arms.dispose();
    }
    this.view = view;
    this.pivot.add(view.object);
    // Arms attach to whatever anchors the weapon provides — no per-weapon code here.
    this.arms = new FirstPersonArms(view.gripAnchor, view.supportAnchor, view.magazine, view.rightHand, view.armPose);
    this.pivot.add(this.arms.object);
    view.muzzle?.add(this.flash);
    this.flashTime = 0;
    this.kick = this.kickVel = 0;
    this.magRestY = view.magazine?.position.y ?? 0;
    if (pose) this.setPose(pose);
  }

  setPose(pose: ViewmodelPose): void {
    this.restPosition.set(...pose.position);
    this.restRotation.set(...pose.rotation);
    this.restScale = pose.scale;
  }

  /**
   * Gives the held weapon soft studio reflections so metal and polymer read
   * correctly. Generated once; the view-model is tiny so it costs nothing per frame.
   */
  initEnvironment(renderer: THREE.WebGLRenderer): void {
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Visual feedback for one shot/attack; melee motion comes from `sinceShot` instead. */
  onShot(category: WeaponCategory): void {
    if (category === 'melee') return;
    this.kickVel += category === 'sniper' ? 1.9 : 1.0;
    if (this.view?.muzzle) {
      this.flashTime = 0.045;
      this.flash.rotation.z = Math.random() * Math.PI;
      this.flash.scale.setScalar((category === 'sniper' ? 1.5 : 0.8) + Math.random() * 0.5);
    }
  }

  update(dt: number, m: ViewModelMotion, anim: WeaponAnimState): void {
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

    // Pose offsets from the placeholder animations (all relative to rest).
    const off = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 };

    // Reload: dip and roll, magazine drops out and back in.
    if (anim.reload !== null) {
      const t = anim.reload;
      const envelope = Math.sin(Math.min(t, 1) * Math.PI);
      off.y -= envelope * 0.07;
      off.rx -= envelope * 0.07 * 1.2;
      off.rz += envelope * 0.55;
      if (this.view?.magazine) {
        const out = t < 0.25 ? t / 0.25 : t < 0.6 ? 1 : Math.max(0, 1 - (t - 0.6) / 0.25);
        this.view.magazine.position.y = this.magRestY - out * 0.25;
        this.view.magazine.visible = !(t > 0.3 && t < 0.55);
      }
    } else if (this.view?.magazine) {
      this.view.magazine.position.y = this.magRestY;
      this.view.magazine.visible = true;
    }

    // Equip: rise from below the screen edge.
    const drop = 1 - easeOut(anim.equip);
    off.y -= drop * 0.24;
    off.rx -= drop * 0.75;
    off.rz += drop * 0.25;

    // Melee slash: sweep from the right across the centre and back.
    if (anim.category === 'melee' && anim.sinceShot < SLASH_TIME) {
      const sw = Math.sin((anim.sinceShot / SLASH_TIME) * Math.PI);
      off.x -= sw * 0.11;
      off.z -= sw * 0.06;
      off.ry += sw * 0.7;
      off.rz += sw * 0.55;
      off.rx -= sw * 0.25;
    }

    // Inspect: turn the weapon to show its side, then back.
    if (anim.inspect !== null) {
      const e = Math.sin(anim.inspect * Math.PI);
      const wobble = Math.sin(anim.inspect * Math.PI * 2) * 0.15;
      if (anim.category === 'melee') {
        // Lift and tilt the blade toward the camera; small angles keep the forearm off-screen.
        off.rx -= e * 0.5;
        off.ry += wobble;
        off.rz -= e * 0.35;
        off.x -= e * 0.04;
        off.y += e * 0.04;
      } else {
        off.rz += e * 0.6;
        off.ry -= e * 0.45 + wobble;
        off.x -= e * 0.04;
        off.y += e * 0.03;
      }
    }

    this.view?.animate?.(anim);
    this.arms?.update(anim.reload);

    const crouchOffset = m.crouching ? 0.01 : 0;
    const rest = this.restPosition;
    const rr = this.restRotation;
    this.pivot.position.set(
      rest.x + this.swayX + bobX + off.x,
      rest.y + this.swayY + bobY - crouchOffset + off.y,
      rest.z + this.kick * 0.045 + off.z,
    );
    this.pivot.rotation.set(
      rr.x + this.kick * 0.06 + this.swayY * 0.8 + off.rx,
      rr.y + this.swayX * 0.8 + off.ry,
      rr.z + off.rz,
    );
    this.pivot.scale.setScalar(this.restScale);

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

function easeOut(t: number): number {
  const c = Math.min(Math.max(t, 0), 1);
  return 1 - (1 - c) * (1 - c);
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
