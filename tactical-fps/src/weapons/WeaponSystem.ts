import * as THREE from 'three';
import type { HitscanResult, HitscanSystem } from '../combat/HitscanSystem';
import type { PlayerController } from '../player/PlayerController';
import { PLAYER_CONFIG } from '../config';
import { RecoilController } from './RecoilController';
import { Weapon } from './Weapon';
import type { WeaponDefinition } from './WeaponDefinition';

export interface WeaponEvents {
  onShot?(result: HitscanResult, origin: THREE.Vector3, direction: THREE.Vector3): void;
  onReloadStart?(): void;
  onReloadEnd?(): void;
  onDryFire?(): void;
}

export interface WeaponInput {
  fire: boolean;
  reload: boolean;
}

const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _kick = { pitch: 0, yaw: 0 };

/**
 * Drives the equipped weapon for one shooter: reads intent, advances the
 * weapon on the fixed simulation tick, resolves every round as its own
 * hitscan from the camera center, and applies recoil to the view.
 */
export class WeaponSystem {
  weapon: Weapon;
  readonly recoil: RecoilController;
  events: WeaponEvents = {};
  /** Shots fired since start (debug/tests). */
  shotsFired = 0;

  private reloadWasHeld = false;

  constructor(
    def: WeaponDefinition,
    private readonly owner: PlayerController,
    private readonly hitscan: HitscanSystem,
    private readonly ownerId = 'local',
  ) {
    this.weapon = new Weapon(def);
    this.recoil = new RecoilController(def.recoil);
  }

  equip(def: WeaponDefinition): void {
    this.weapon = new Weapon(def);
    this.recoil.setProfile(def.recoil);
  }

  /** Call once per rendered frame with the player's raw vertical look input. */
  onLookInput(pitchDelta: number): void {
    this.recoil.absorbPlayerPitch(pitchDelta);
  }

  step(input: WeaponInput, dt: number): void {
    const w = this.weapon;

    if (input.reload && !this.reloadWasHeld && w.startReload()) this.events.onReloadStart?.();
    this.reloadWasHeld = input.reload;

    const r = w.update(dt, input.fire);
    if (r.reloadFinished) this.events.onReloadEnd?.();
    if (r.dryFire) this.events.onDryFire?.();
    for (let i = 0; i < r.shots; i++) this.fireRound();

    this.recoil.update(dt, _kick);
    this.owner.addViewKick(_kick.pitch, _kick.yaw);
  }

  resetForRespawn(): void {
    this.weapon.resetAmmo();
    this.recoil.reset();
  }

  private fireRound(): void {
    const p = this.owner;
    const def = this.weapon.def;
    _origin.set(p.position.x, p.position.y + p.eyeHeight, p.position.z);

    // Bullets leave exactly through the crosshair (current view incl. recoil so far),
    // plus a movement-dependent cone. Standing still, first shots are pin-point.
    _euler.set(p.pitch, p.yaw, 0);
    _dir.set(0, 0, -1).applyEuler(_euler);
    const spread = this.currentSpread();
    if (spread > 0) applyCone(_dir, spread);

    const result = this.hitscan.fire({
      origin: _origin,
      direction: _dir,
      damage: def.damage,
      sourceId: this.ownerId,
      weaponId: def.id,
    });
    this.shotsFired++;
    this.recoil.onShot();
    this.events.onShot?.(result, _origin, _dir);
  }

  /** Current inaccuracy cone half-angle (radians). */
  currentSpread(): number {
    const s = this.weapon.def.spread;
    const p = this.owner;
    const speed01 = Math.min(Math.hypot(p.velocity.x, p.velocity.z) / PLAYER_CONFIG.runSpeed, 1);
    let spread = s.standing + s.moving * speed01;
    if (!p.grounded) spread += s.airborne;
    if (p.crouching) spread *= s.crouchMultiplier;
    return spread;
  }
}

const _t = new THREE.Vector3();
const _b = new THREE.Vector3();
/** Rotates `dir` by a random angle inside a cone (uniform over the disc). */
function applyCone(dir: THREE.Vector3, halfAngle: number): void {
  const r = Math.sqrt(Math.random()) * Math.tan(halfAngle);
  const a = Math.random() * Math.PI * 2;
  _t.set(dir.z, 0, -dir.x);
  if (_t.lengthSq() < 1e-8) _t.set(1, 0, 0);
  _t.normalize();
  _b.crossVectors(dir, _t);
  dir.addScaledVector(_t, Math.cos(a) * r).addScaledVector(_b, Math.sin(a) * r).normalize();
}
