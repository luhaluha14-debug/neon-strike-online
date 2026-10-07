import * as THREE from 'three';
import type { HitscanResult, HitscanSystem } from '../combat/HitscanSystem';
import type { PlayerController } from '../player/PlayerController';
import { PLAYER_CONFIG } from '../config';
import { RecoilController } from './RecoilController';
import { Weapon } from './Weapon';
import type { WeaponDefinition } from './WeaponDefinition';

export interface WeaponEvents {
  onShot?(result: HitscanResult, origin: THREE.Vector3, direction: THREE.Vector3, weapon: Weapon): void;
  onReloadStart?(): void;
  onReloadEnd?(): void;
  onDryFire?(): void;
  /** The active weapon changed (start of the equip animation). */
  onEquip?(weapon: Weapon, slot: number): void;
}

/**
 * What the shooter wants this tick. Device- and controller-independent:
 * the local player's input fills it today, an AI bot's decision layer can
 * fill exactly the same struct later.
 */
export interface WeaponCommand {
  fire: boolean;
  reload: boolean;
  /** Loadout slot to switch to (0-based), -1 = no change. */
  equipSlot?: number;
  /** Switch back to the previously held weapon. */
  equipLast?: boolean;
  /** Start the inspect animation (cosmetic). */
  inspect?: boolean;
}

const INSPECT_TIME = 2.6;

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
  /** One runtime Weapon per loadout slot; ammo is kept per weapon across switches. */
  readonly loadout: Weapon[];
  slot = 0;
  readonly recoil: RecoilController;
  events: WeaponEvents = {};
  /** Shots fired since start (debug/tests). */
  shotsFired = 0;
  /** Seconds left on the cosmetic inspect animation (0 = not inspecting). */
  inspectRemaining = 0;

  private lastSlot = 0;
  private reloadWasHeld = false;
  private inspectWasHeld = false;

  constructor(
    loadout: readonly WeaponDefinition[] | WeaponDefinition,
    private readonly owner: PlayerController,
    private readonly hitscan: HitscanSystem,
    private readonly ownerId = 'local',
  ) {
    const defs = Array.isArray(loadout) ? loadout : [loadout as WeaponDefinition];
    if (defs.length === 0) throw new Error('WeaponSystem needs at least one weapon');
    this.loadout = defs.map((d) => new Weapon(d));
    this.recoil = new RecoilController(defs[0].recoil);
  }

  /** The weapon currently in hand. */
  get weapon(): Weapon {
    return this.loadout[this.slot];
  }

  /** 0..1 while inspecting, null otherwise. */
  get inspectProgress(): number | null {
    return this.inspectRemaining > 0 ? 1 - this.inspectRemaining / INSPECT_TIME : null;
  }

  /** Switches to a loadout slot (no-op if already held or out of range). */
  equipSlot(slot: number): boolean {
    if (slot < 0 || slot >= this.loadout.length || slot === this.slot) return false;
    this.lastSlot = this.slot;
    this.slot = slot;
    this.weapon.equip();
    this.recoil.setProfile(this.weapon.def.recoil);
    this.inspectRemaining = 0;
    this.events.onEquip?.(this.weapon, slot);
    return true;
  }

  /** Call once per rendered frame with the player's raw vertical look input. */
  onLookInput(pitchDelta: number): void {
    this.recoil.absorbPlayerPitch(pitchDelta);
  }

  step(input: WeaponCommand, dt: number): void {
    if (input.equipLast) this.equipSlot(this.lastSlot);
    else if (input.equipSlot !== undefined && input.equipSlot >= 0) this.equipSlot(input.equipSlot);
    const w = this.weapon;

    if (input.reload && !this.reloadWasHeld && w.startReload()) {
      this.inspectRemaining = 0;
      this.events.onReloadStart?.();
    }
    this.reloadWasHeld = input.reload;

    if (input.inspect && !this.inspectWasHeld && w.status === 'ready') this.inspectRemaining = INSPECT_TIME;
    this.inspectWasHeld = !!input.inspect;
    if (this.inspectRemaining > 0) this.inspectRemaining = Math.max(0, this.inspectRemaining - dt);

    const r = w.update(dt, input.fire);
    if (r.shots > 0) this.inspectRemaining = 0;
    if (r.reloadFinished) this.events.onReloadEnd?.();
    if (r.dryFire) this.events.onDryFire?.();
    for (let i = 0; i < r.shots; i++) this.fireRound();

    this.recoil.update(dt, _kick);
    this.owner.addViewKick(_kick.pitch, _kick.yaw);
  }

  resetForRespawn(): void {
    for (const w of this.loadout) w.resetAmmo();
    this.recoil.reset();
    this.inspectRemaining = 0;
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
    this.events.onShot?.(result, _origin, _dir, this.weapon);
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
