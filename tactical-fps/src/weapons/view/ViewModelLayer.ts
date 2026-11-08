import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { ArmsAppearance } from '../../skins/SkinRenderer';
import { FirstPersonArms } from './FirstPersonArms';
import type { ViewmodelPose, WeaponCategory } from '../WeaponDefinition';
import type { WeaponAnimState, WeaponView } from './WeaponView';
import { pumpTravel } from './GltfWeaponView';
import { FLASH, MuzzleFlash, type FlashDetail } from './MuzzleFlash';

export interface ViewModelMotion {
  /** Look delta this frame (radians) — drives sway. */
  lookYaw: number;
  lookPitch: number;
  /** Horizontal speed normalized to run speed (0..1+). */
  speed01: number;
  grounded: boolean;
  crouching: boolean;
  /** Vertical velocity (m/s, + up): the weapon floats a little in the air. */
  vy?: number;
  /** 0 = hip, 1 = aimed: sway and bob steadied. */
  aim?: number;
  /** The camera's stride phase (rad, CameraMotion.phase): the weapon bobs in step with the eye. */
  stepPhase?: number;
}

/**
 * How heavy each kind of weapon feels in the hands (motion only; handling and balance untouched):
 * how far it sways and bobs, how quickly it follows the view (`follow`, 1/s: lower lags more), how
 * deep a landing pushes it down, how much it floats in the air.
 */
export const WEAPON_WEIGHT: Record<WeaponCategory, { sway: number; bob: number; follow: number; land: number; air: number }> = {
  rifle: { sway: 1, bob: 1, follow: 10, land: 1, air: 1 },
  smg: { sway: 0.8, bob: 0.85, follow: 14, land: 0.8, air: 0.85 },
  pistol: { sway: 0.6, bob: 0.65, follow: 16, land: 0.6, air: 0.7 },
  shotgun: { sway: 1.25, bob: 1.15, follow: 7.5, land: 1.3, air: 1.15 },
  sniper: { sway: 1.4, bob: 1.2, follow: 6.5, land: 1.45, air: 1.25 },
  melee: { sway: 0.7, bob: 0.8, follow: 15, land: 0.7, air: 0.8 },
};

/** Duration of the placeholder melee slash (s). */
const SLASH_TIME = 0.32;

interface ShotFeel {
  /** Impulse of the kick spring per shot. */
  kick: number;
  /** How the kick shows: muzzle rise (rad per unit) and push back toward the eye (m per unit). */
  rise: number;
  back: number;
  /** Random sideways roll impulse per shot (± rad/s): the weapon twists a little, never the same way twice. */
  roll: number;
  /** Peak of the muzzle light on the hands (the flash itself: MuzzleFlash FLASH). */
  light: number;
}

/**
 * Per weapon category: the rifle pushes back evenly, the SMG buzzes (small kicks, more twist), the
 * pistol snaps up (rise more than push), the shotgun and sniper shove hard.
 */
const SHOT_FEEL: Record<Exclude<WeaponCategory, 'melee'>, ShotFeel> = {
  // Peak of one shot: rise ~0.9°, push 6 mm, twist ~0.4°; a full-auto spray holds ~1.5° / 1 cm.
  rifle: { kick: 1.0, rise: 0.64, back: 0.25, roll: 0.29, light: 1.6 },
  // ~2° / 13 mm, then the bolt.
  sniper: { kick: 1.9, rise: 0.75, back: 0.28, roll: 0.43, light: 2.6 },
  // ~0.6° / 4 mm per shot, more twist: a buzz rather than a shove.
  smg: { kick: 0.75, rise: 0.57, back: 0.22, roll: 0.36, light: 1.3 },
  // ~2.2° / 15 mm, then the pump.
  shotgun: { kick: 2.2, rise: 0.72, back: 0.28, roll: 0.57, light: 2.8 },
  // Snaps up ~2°, hardly pushes back (3 mm).
  pistol: { kick: 1.1, rise: 1.3, back: 0.11, roll: 0.43, light: 1.2 },
};
const RIFLE_FEEL = SHOT_FEEL.rifle;

/** Pose offsets of the procedural animations this frame (relative to rest); reused, no per-frame garbage. */
const off = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 };

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
  /** Glove / sleeve skin, applied to every arm set this layer builds. */
  private armsLook: ArmsAppearance | null = null;
  /** Motion pivot: position/rotation offsets are applied here. */
  private readonly pivot = new THREE.Group();
  /** Muzzle flash at the current weapon's muzzle (star, flame prongs, brake jets, smoke). */
  readonly flash = new MuzzleFlash();
  /** Muzzle flash light on the hands and weapon; always in the scene (only its intensity changes, so no shader recompiles). */
  private readonly flashLight = new THREE.PointLight(0xffb468, 0, 1.4, 2);
  private flashPeak = 0;

  // Spring-ish state.
  private kick = 0;
  private kickVel = 0;
  /** How the current weapon's kick shows (from its category). */
  private feel: ShotFeel = RIFLE_FEEL;
  /** Sideways twist of the last shots (rad), sprung back like the kick. */
  private roll = 0;
  private rollVel = 0;
  /** Landing dip (sprung). */
  private land = 0;
  private landVel = 0;
  private wasGrounded = true;
  private airVy = 0;
  private air = 0;
  private aimS = 0;
  private breathPhase = 0;
  /** Category of the model in hand (the anim state already describes the next weapon during a holster). */
  private shownCategory: WeaponCategory = 'rifle';
  /** Switching: the model being put away until `holster` runs out, then `incoming` is drawn. */
  private incoming: { view: WeaponView; pose?: ViewmodelPose; category: WeaponCategory } | null = null;
  private holster = 0;
  private holsterTotal = 0;
  /** Draw progress the new model starts from (the weapon's draw began during the holster): remapped to 0..1. */
  private equipBase = 0;
  private lastEquip = 1;
  /** Reload progress last frame, and time since a reload completed (a shotgun racks its pump then). */
  private lastReload: number | null = null;
  private sinceReloadEnd = Infinity;
  private swayX = 0;
  private swayY = 0;
  private bobPhase = 0;
  private bobAmount = 0;
  private readonly magRest = new THREE.Vector3();
  private readonly fill = new THREE.HemisphereLight(0xc9d4de, 0x4a4238, 1.6);
  private readonly key = new THREE.DirectionalLight(0xfff1dc, 2.2);
  private ambient = 1;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(62, aspect, 0.01, 10);
    this.scene.add(this.pivot);
    this.scene.add(this.fill);
    this.key.position.set(0.6, 1, 0.4);
    this.scene.add(this.key);
    this.scene.add(this.flashLight);
  }

  /**
   * How much sky the player stands under (0 indoors .. 1 outside): the hands and weapon dim a little
   * indoors so they sit in the room like the walls around them (never below 75 %; 1 = as before).
   */
  setAmbient(sky: number): void {
    const k = 0.75 + 0.25 * Math.min(Math.max(sky, 0), 1);
    this.ambient += (k - this.ambient) * 0.08;
    this.fill.intensity = 1.6 * this.ambient;
    this.key.intensity = 2.2 * (0.6 + 0.4 * this.ambient * this.ambient);
  }

  /** Effects detail (graphics quality): low leaves out the smoke. */
  setEffectsDetail(detail: FlashDetail): void {
    this.flash.detail = detail;
  }

  /** World-space position of the muzzle as seen through `worldCamera` (for tracers); null for melee. */
  muzzleInWorld(worldCamera: THREE.Camera, out: THREE.Vector3): THREE.Vector3 | null {
    const m = this.view?.muzzle;
    if (!m) return null;
    this.scene.updateMatrixWorld();
    // The world camera as placed now (its matrix is otherwise only refreshed when a frame is drawn).
    worldCamera.updateMatrixWorld();
    m.getWorldPosition(out);
    return this.toWorld(out, worldCamera);
  }

  /**
   * A point of the view-model scene into the world, where the world camera shows it on the same pixel.
   * View-model space is camera space of its own camera; the two cameras differ in field of view
   * (62° vs the world's), so across the view the point is spread by the ratio of their tangents at
   * its own depth: a case or a tracer then starts exactly at the port / muzzle drawn on screen.
   */
  private toWorld(out: THREE.Vector3, worldCamera: THREE.Camera): THREE.Vector3 {
    out.applyMatrix4(this.camera.matrixWorldInverse);
    const wc = worldCamera as THREE.PerspectiveCamera;
    if (wc.isPerspectiveCamera) {
      const k = Math.tan(THREE.MathUtils.degToRad(wc.fov / 2)) / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
      out.x *= k;
      out.y *= k;
    }
    return out.applyMatrix4(worldCamera.matrixWorld);
  }

  /**
   * World-space position of the ejection port as seen through `worldCamera` (spent cases leave there), or null.
   * Returns the side the port is on: 1 right, -1 left (of the weapon, in view).
   */
  ejectInWorld(worldCamera: THREE.Camera, out: THREE.Vector3): number | null {
    const port = this.view?.ejectPort;
    if (!port || this.incoming) return null;
    this.scene.updateMatrixWorld();
    worldCamera.updateMatrixWorld();
    port.getWorldPosition(out);
    // Side of the weapon, in the model's own space (its pose in view does not matter): forward runs
    // from the grip to the muzzle, right is forward × up; a file modelled facing the other way still
    // gets its true side. Without a muzzle: the port's X.
    const obj = this.view!.object;
    const local = obj.worldToLocal(_side.copy(out));
    let side = local.x >= 0 ? 1 : -1;
    const muzzle = this.view!.muzzle;
    if (muzzle) {
      const m = obj.worldToLocal(muzzle.getWorldPosition(_side2));
      // Forward: grip to muzzle (horizontal); right = forward × up = (-fz, 0, fx).
      const g = this.view!.gripAnchor.position;
      const fx = m.x - g.x;
      const fz = m.z - g.z;
      side = (local.x - m.x) * -fz + (local.z - m.z) * fx >= 0 ? 1 : -1;
    }
    this.toWorld(out, worldCamera);
    return side;
  }

  /** The selected weapon's model: during a switch, the one about to be drawn (debug / tests). */
  get currentView(): WeaponView | null {
    return this.incoming?.view ?? this.view;
  }

  /** The model physically in the hands (during a switch, the one going down). */
  get inHand(): WeaponView | null {
    return this.view;
  }

  get currentArms(): FirstPersonArms | null {
    return this.arms;
  }

  /**
   * Puts a weapon model in the hands at its configured pose. With `holster` (s) the model in hand is
   * put away first and the new one drawn after it, inside the weapon's own draw time (a switch never
   * takes longer to be able to fire). A model given while one is still waiting replaces it.
   */
  setView(view: WeaponView, pose?: ViewmodelPose, holster = 0, category?: WeaponCategory): void {
    if (this.incoming) {
      // The waiting model is replaced (its GLB finished loading, or another switch): the holster goes on.
      if (this.incoming.view !== view) this.incoming.view.dispose();
      this.incoming = { view, pose, category: category ?? this.incoming.category };
      return;
    }
    if (holster > 0 && this.view) {
      this.incoming = { view, pose, category: category ?? this.shownCategory };
      this.holster = this.holsterTotal = holster;
      return;
    }
    this.install(view, pose, category);
  }

  private install(view: WeaponView, pose?: ViewmodelPose, category?: WeaponCategory): void {
    if (category) this.shownCategory = category;
    this.flash.object.removeFromParent();
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
    // The support hand reaches for the magazine on a reload (a moving part, or a fixed spot on one-piece models).
    this.arms = new FirstPersonArms(view.gripAnchor, view.supportAnchor, view.magazine ?? view.reloadGrab ?? undefined, view.rightHand, view.armPose);
    this.arms.applyLook(this.armsLook);
    this.pivot.add(this.arms.object);
    view.muzzle?.add(this.flash.object);
    this.flash.reset();
    this.kick = this.kickVel = 0;
    this.roll = this.rollVel = 0;
    if (view.magazine) this.magRest.copy(view.magazine.position);
    if (pose) this.setPose(pose);
  }

  /** Glove / sleeve skin for the current and every later arm set (null = factory). */
  setArmsLook(look: ArmsAppearance | null): void {
    this.armsLook = look;
    this.arms?.applyLook(look);
  }

  /** A fresh start (respawn, round start): a switch in progress completes, kicks and dips are cleared. */
  resetMotion(): void {
    if (this.incoming) {
      const { view, pose, category } = this.incoming;
      this.incoming = null;
      this.install(view, pose, category);
    }
    this.holster = this.holsterTotal = 0;
    this.equipBase = 0;
    this.kick = this.kickVel = this.roll = this.rollVel = this.land = this.landVel = 0;
    this.lastReload = null;
    this.sinceReloadEnd = Infinity;
    this.flash.reset();
  }

  /** A switch is putting the old model away (tests / debug). */
  get holstering(): boolean {
    return this.incoming !== null;
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
    const k = SHOT_FEEL[category];
    this.feel = k;
    this.kickVel += k.kick;
    this.rollVel += (Math.random() < 0.5 ? -1 : 1) * k.roll * (0.6 + Math.random() * 0.4);
    if (this.view?.muzzle) {
      this.flash.fire(FLASH[category]);
      this.view.muzzle.getWorldPosition(this.flashLight.position);
      this.flashPeak = k.light;
    }
  }

  update(dt: number, m: ViewModelMotion, anim: WeaponAnimState): void {
    // Recoil kick: damped spring back to rest. Fixed substeps keep it stable
    // even when a frame takes 100 ms.
    const stiffness = 220;
    const damping = 26;
    const steps = Math.ceil(dt / (1 / 240));
    const h = dt / steps;
    const wt = WEAPON_WEIGHT[this.shownCategory];
    // Landing after a jump or fall: a short dip of the weapon, deeper for a harder landing and a heavier weapon.
    if (m.grounded && !this.wasGrounded) {
      const impact = m.vy === undefined ? 5 : Math.max(-this.airVy, 0);
      this.landVel -= 0.7 * Math.min(Math.max(impact / 5, 0.35), 1.6) * wt.land;
    }
    if (!m.grounded && m.vy !== undefined) this.airVy = m.vy;
    this.wasGrounded = m.grounded;
    this.aimS += ((m.aim ?? 0) - this.aimS) * (1 - Math.exp(-12 * dt));
    const steady = 1 - 0.65 * this.aimS;
    // In the air the weapon floats against the motion: down a touch going up, up a touch falling.
    const airTarget = m.grounded || m.vy === undefined ? 0 : THREE.MathUtils.clamp(-m.vy * 0.0016, -0.008, 0.009) * wt.air;
    this.air += (airTarget - this.air) * (1 - Math.exp(-6 * dt));
    for (let i = 0; i < steps; i++) {
      this.kickVel += (-stiffness * this.kick - damping * this.kickVel) * h;
      this.kick += this.kickVel * h;
      this.rollVel += (-stiffness * this.roll - damping * this.rollVel) * h;
      this.roll += this.rollVel * h;
      this.landVel += (-120 * this.land - 18 * this.landVel) * h;
      this.land += this.landVel * h;
    }

    // Sway lags behind look input.
    const swayK = 1.2 * wt.sway * steady;
    const swayTargetX = THREE.MathUtils.clamp(-m.lookYaw * swayK, -0.03 * wt.sway, 0.03 * wt.sway);
    const swayTargetY = THREE.MathUtils.clamp(m.lookPitch * swayK, -0.03 * wt.sway, 0.03 * wt.sway);
    const s = 1 - Math.exp(-wt.follow * dt);
    this.swayX += (swayTargetX - this.swayX) * s;
    this.swayY += (swayTargetY - this.swayY) * s;

    // Walk bob.
    const moving = m.grounded ? Math.min(m.speed01, 1.2) : 0;
    this.bobAmount += (moving - this.bobAmount) * (1 - Math.exp(-8 * dt));
    // In step with the eye when the camera's stride is given (the weapon dips as each foot lands).
    if (m.stepPhase !== undefined) this.bobPhase = m.stepPhase + Math.PI / 2;
    else this.bobPhase += dt * (6 + 5 * m.speed01);
    const bobK = 0.008 * wt.bob * steady * this.bobAmount;
    const bobX = Math.sin(this.bobPhase) * bobK;
    const bobY = -Math.abs(Math.cos(this.bobPhase)) * bobK;
    // Breathing while standing still: a slow, barely visible rise and fall.
    this.breathPhase += dt * 1.7;
    const still = Math.max(0, 1 - this.bobAmount * 2);

    // Pose offsets from the placeholder animations (all relative to rest).
    off.x = off.y = off.z = off.rx = off.ry = off.rz = 0;
    // Moving: the weapon rolls a touch with each step; a landing dips it.
    off.rz += Math.sin(this.bobPhase) * 0.012 * this.bobAmount;
    // (A landing peaks at ~7 mm down and ~0.6° muzzle down, back up within half a second.)
    off.y += this.land * 0.3 + Math.sin(this.breathPhase) * 0.0012 * still + this.air;
    off.rx += this.land * 0.4 + Math.sin(this.breathPhase) * 0.002 * still;

    // Switching: the model in hand goes down first; the new one is drawn once it is out of view.
    let equip = anim.equip;
    if (this.incoming) {
      this.holster -= dt;
      const p = 1 - Math.max(this.holster, 0) / this.holsterTotal;
      drawOffset(this.shownCategory, easeIn(p));
      if (this.holster <= 0) {
        const { view, pose, category } = this.incoming;
        this.incoming = null;
        this.install(view, pose, category);
        this.equipBase = Math.min(anim.equip, 0.999);
      }
      equip = 0;
    } else {
      // A draw that starts over (another switch, a redraw) is not remapped.
      if (anim.equip < this.lastEquip - 1e-6 && anim.equip < this.equipBase) this.equipBase = 0;
      if (anim.equip >= 1) this.equipBase = 0;
      equip = this.equipBase > 0 ? Math.max(0, (anim.equip - this.equipBase) / (1 - this.equipBase)) : anim.equip;
      this.shownCategory = anim.category;
    }
    this.lastEquip = anim.equip;
    const showing = this.incoming === null;

    // A completed reload: the shotgun racks its pump (the reload ends with the pump sound).
    if (this.lastReload !== null && anim.reload === null && this.lastReload > 0.85) this.sinceReloadEnd = 0;
    else this.sinceReloadEnd += dt;
    this.lastReload = anim.reload;
    const sinceCycle = anim.category === 'shotgun' ? Math.min(anim.sinceShot, this.sinceReloadEnd) : anim.sinceShot;

    // Pump action: the weapon rocks a little while the off hand racks it.
    if (showing && anim.category === 'shotgun') {
      const pump = pumpTravel(sinceCycle);
      off.rz += pump * 0.05;
      off.rx += pump * 0.025;
      off.y -= pump * 0.006;
    }

    // Reload: each kind of weapon its own motion, timed to its reload sounds; the magazine drops out and back in.
    if (showing && anim.reload !== null) {
      reloadOffset(anim.category, anim.reload);
      if (this.view?.magazine) {
        const t = anim.reload;
        const out = t < 0.25 ? t / 0.25 : t < 0.6 ? 1 : Math.max(0, 1 - (t - 0.6) / 0.25);
        this.view.magazine.position.copy(this.magRest).addScaledVector(this.view.magazineDrop ?? DOWN, out * 0.25);
        this.view.magazine.visible = !(t > 0.3 && t < 0.55);
      }
    } else if (this.view?.magazine) {
      this.view.magazine.position.copy(this.magRest);
      this.view.magazine.visible = true;
    }

    // Draw: rise from below the screen edge, each kind of weapon its own way.
    if (showing) drawOffset(anim.category, 1 - easeOut(equip));

    // Melee slash: sweep from the right across the centre and back.
    if (showing && anim.category === 'melee' && anim.sinceShot < SLASH_TIME) {
      const sw = Math.sin((anim.sinceShot / SLASH_TIME) * Math.PI);
      off.x -= sw * 0.11;
      off.z -= sw * 0.06;
      off.ry += sw * 0.7;
      off.rz += sw * 0.55;
      off.rx -= sw * 0.25;
    }

    // Inspect: turn the weapon to show its side, then back.
    if (showing && anim.inspect !== null) {
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

    if (showing) {
      _anim.category = anim.category;
      _anim.equip = equip;
      _anim.reload = anim.reload;
      _anim.sinceShot = sinceCycle;
      _anim.fireInterval = anim.fireInterval;
      _anim.inspect = anim.inspect;
      _anim.empty = anim.empty;
      this.view?.animate?.(_anim);
    }
    this.arms?.update(showing ? anim.reload : null);

    const crouchOffset = m.crouching ? 0.01 : 0;
    const rest = this.restPosition;
    const rr = this.restRotation;
    this.pivot.position.set(
      rest.x + this.swayX + bobX + off.x,
      rest.y + this.swayY + bobY - crouchOffset + off.y,
      rest.z + this.kick * this.feel.back + off.z,
    );
    this.pivot.rotation.set(
      rr.x + this.kick * this.feel.rise + this.swayY * 0.8 + off.rx,
      rr.y + this.swayX * 0.8 + this.roll * 0.4 + off.ry,
      rr.z + this.roll + off.rz,
    );
    this.pivot.scale.setScalar(this.restScale);

    this.flash.update(dt);
    this.flashLight.intensity = this.flashPeak * this.flash.brightness;
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

function easeIn(t: number): number {
  const c = Math.min(Math.max(t, 0), 1);
  return c * c;
}

/** Scratch animation state handed to the model (sinceShot / equip remapped); no per-frame garbage. */
const DOWN = new THREE.Vector3(0, -1, 0);
const _side = new THREE.Vector3();
const _side2 = new THREE.Vector3();
const _anim: WeaponAnimState = { category: 'rifle', equip: 1, reload: null, sinceShot: Infinity, fireInterval: 1, inspect: null };

/**
 * Out-of-view pose of a draw / holster, `d` 0 (in hand) .. 1 (below the screen edge): rifles come up
 * rolling, the SMG flicks in from the right, the pistol swings up muzzle first, the shotgun and the
 * sniper rifle rise heavy and rolled, the knife flips in.
 */
const DRAW: Record<WeaponCategory, { x: number; y: number; rx: number; rz: number }> = {
  rifle: { x: 0, y: 0.24, rx: 0.75, rz: -0.25 },
  smg: { x: -0.04, y: 0.22, rx: 0.6, rz: -0.4 },
  pistol: { x: -0.03, y: 0.2, rx: 0.95, rz: 0.15 },
  shotgun: { x: 0, y: 0.26, rx: 0.55, rz: -0.45 },
  sniper: { x: -0.03, y: 0.28, rx: 0.5, rz: -0.35 },
  melee: { x: 0.02, y: 0.18, rx: 0.4, rz: 0.6 },
};
function drawOffset(category: WeaponCategory, d: number): void {
  if (d <= 0) return;
  const k = DRAW[category];
  off.x -= d * k.x;
  off.y -= d * k.y;
  off.rx -= d * k.rx;
  off.rz -= d * k.rz;
}

/** 0 → 1 → 0 bump over [at, at + width] (a short jolt at a reload sound). */
function bump(t: number, at: number, width: number): number {
  return t < at || t > at + width ? 0 : Math.sin(((t - at) / width) * Math.PI);
}

/**
 * Reload motion per kind of weapon, `t` 0..1 of the reload, with jolts where its sounds are
 * (weapons.ts `sounds.reload` / `reloadEnd`).
 */
function reloadOffset(category: WeaponCategory, t: number): void {
  const e = Math.sin(Math.min(t, 1) * Math.PI);
  switch (category) {
    case 'rifle':
      // Rolled right and dipped for the magazine (out 0.04, in 0.81), the charging handle at the end.
      off.y -= e * 0.07;
      off.rx -= e * 0.084;
      off.rz += e * 0.55;
      off.y += bump(t, 0.81, 0.08) * 0.01;
      off.z += bump(t, 0.9, 0.08) * 0.012;
      off.rx += bump(t, 0.9, 0.08) * 0.03;
      break;
    case 'smg':
      // Lighter: tipped in less, a slap at the magazine in (0.78).
      off.y -= e * 0.055;
      off.rx -= e * 0.07;
      off.rz += e * 0.4;
      off.x -= e * 0.015;
      off.y += bump(t, 0.78, 0.07) * 0.01;
      break;
    case 'pistol':
      // One hand: tilted left with the muzzle up, the magazine in at 0.72, the slide released at the end.
      off.y -= e * 0.045;
      off.x -= e * 0.02;
      off.rx += e * 0.18;
      off.rz -= e * 0.35;
      off.y += bump(t, 0.72, 0.07) * 0.008;
      off.rx -= bump(t, 0.93, 0.07) * 0.05;
      break;
    case 'shotgun':
      // Brought up muzzle high and canted left so the loading port underneath faces the eye (the support
      // hand feeds shells there), a push for every shell (0.15, 0.4, 0.65).
      off.y += e * 0.05;
      off.rx += e * 0.35;
      off.rz -= e * 0.3;
      for (const at of [0.15, 0.4, 0.65]) {
        const b = bump(t, at, 0.08);
        off.y += b * 0.008;
        off.z -= b * 0.01;
      }
      break;
    case 'sniper':
      // Heavy: dipped and rolled, the bolt opened and closed by the model (SniperRifleView.animateBolt).
      off.y -= e * 0.065;
      off.rx -= e * 0.07;
      off.rz += e * 0.45;
      break;
    case 'melee':
      break;
  }
}

