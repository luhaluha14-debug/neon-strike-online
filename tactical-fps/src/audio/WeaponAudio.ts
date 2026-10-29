import * as THREE from 'three';
import type { HitscanResult } from '../combat/HitscanSystem';
import type { Weapon } from '../weapons/Weapon';
import type { AudioEngine } from './AudioEngine';
import type { SoundId } from './weaponSounds';

const SPEED_OF_SOUND = 343;
const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();

/**
 * Turns weapon-system events into sounds. Reads only the weapon definition's
 * `sounds` data and the weapon's own state, so it never affects gameplay.
 */
export class WeaponAudio {
  private reloadWeapon: Weapon | null = null;
  private nextReloadCue = 0;

  constructor(private readonly engine: AudioEngine) {}

  /** One call per fired round / melee attack. `delay` spaces shots that fired within the same frame. */
  onShot(weapon: Weapon, result: HitscanResult, delay: number, listener: THREE.Camera): void {
    const s = weapon.def.sounds;
    this.engine.play(s.fire, { group: 'shot', gain: s.fireVolume, rateJitter: 0.025, delay });
    if (s.cycle) this.engine.play(s.cycle, { group: 'foley', gain: 0.8, delay });
    if (result.kind === 'miss') return;
    // Hit confirm, heard at the shooter (not placed in the world), right after the shot.
    if (result.kind === 'target') {
      const head = result.zone === 'head';
      this.engine.play(head ? 'hit.head' : 'hit.body', { group: 'impact', gain: head ? 0.55 : 0.5, rateJitter: 0.03, delay: delay + 0.02 });
    }
    if (s.hit) {
      this.engine.play(s.hit, { group: 'impact', gain: 0.8, rateJitter: 0.04, delay: delay + 0.03 });
      return;
    }
    this.impact(result.kind === 'target' ? 'impact.flesh' : 'impact', result.point, delay, listener);
  }

  /**
   * Someone else's shot (a bot): the gunshot is quieter, later and panned with
   * distance; its impact as for the player's own rounds.
   */
  onRemoteShot(weapon: Weapon, origin: THREE.Vector3, result: HitscanResult, listener: THREE.Camera): void {
    _dir.subVectors(origin, listener.position);
    const d = _dir.length();
    if (d > 250) return;
    _dir.multiplyScalar(1 / Math.max(d, 1e-3));
    _right.set(1, 0, 0).applyQuaternion(listener.quaternion);
    const s = weapon.def.sounds;
    this.engine.play(s.fire, {
      group: 'shot',
      gain: (s.fireVolume * 0.9) / (1 + d / 14),
      pan: _dir.dot(_right) * 0.75,
      rateJitter: 0.03,
      delay: Math.min(d / SPEED_OF_SOUND, 0.4),
    });
    if (result.kind !== 'miss') this.impact(result.kind === 'target' ? 'impact.flesh' : 'impact', result.point, 0, listener);
  }

  /** A sound at a point in the world (grenades): quieter and later with distance, panned left/right. */
  world(id: SoundId, point: THREE.Vector3, gain: number, listener: THREE.Camera, range = 150): void {
    _dir.subVectors(point, listener.position);
    const d = _dir.length();
    if (d > range) return;
    _dir.multiplyScalar(1 / Math.max(d, 1e-3));
    _right.set(1, 0, 0).applyQuaternion(listener.quaternion);
    this.engine.play(id, {
      group: 'impact',
      gain: gain / (1 + d / 10),
      pan: _dir.dot(_right) * 0.7,
      rateJitter: 0.04,
      delay: Math.min(d / SPEED_OF_SOUND, 0.4),
    });
  }

  /** Something in the player's own hands (no distance). */
  local(id: SoundId, gain: number): void {
    this.engine.play(id, { group: 'foley', gain, rateJitter: 0.02 });
  }

  onDryFire(weapon: Weapon): void {
    const dry = weapon.def.sounds.dry;
    if (dry) this.engine.play(dry, { group: 'foley', gain: 0.7, rateJitter: 0.02 });
  }

  /** New weapon in hand: cut the previous weapon's handling sounds, play the draw. */
  onEquip(weapon: Weapon): void {
    this.engine.stopGroup('foley');
    this.reloadWeapon = null;
    this.engine.play(weapon.def.sounds.equip, { group: 'foley', gain: 0.6, rateJitter: 0.03 });
  }

  onReloadEnd(weapon: Weapon): void {
    const end = weapon.def.sounds.reloadEnd;
    if (end) this.engine.play(end, { group: 'foley', gain: 0.75 });
  }

  /** Per frame: plays reload cues as the reload passes them (a cancelled reload simply stops). */
  update(weapon: Weapon | undefined): void {
    if (!weapon || weapon.status !== 'reloading') {
      this.reloadWeapon = null;
      return;
    }
    if (this.reloadWeapon !== weapon) {
      this.reloadWeapon = weapon;
      this.nextReloadCue = 0;
    }
    const cues = weapon.def.sounds.reload ?? [];
    const p = weapon.reloadProgress;
    while (this.nextReloadCue < cues.length && cues[this.nextReloadCue].at <= p) {
      this.engine.play(cues[this.nextReloadCue].sound, { group: 'foley', gain: 0.75, rateJitter: 0.02 });
      this.nextReloadCue++;
    }
  }

  /** Bullet impact at a point (map surface or body): quieter and later with distance, panned left/right. */
  private impact(id: 'impact' | 'impact.flesh', point: THREE.Vector3, delay: number, listener: THREE.Camera): void {
    _dir.subVectors(point, listener.position);
    const d = _dir.length();
    if (d > 120) return;
    _dir.multiplyScalar(1 / Math.max(d, 1e-3));
    _right.set(1, 0, 0).applyQuaternion(listener.quaternion);
    this.engine.play(id, {
      group: 'impact',
      gain: (id === 'impact.flesh' ? 0.75 : 0.5) / (1 + d / 6),
      pan: _dir.dot(_right) * 0.7,
      rateJitter: 0.06,
      delay: delay + Math.min(d / SPEED_OF_SOUND, 0.3),
    });
  }
}
