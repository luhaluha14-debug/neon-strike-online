import * as THREE from 'three';
import type { HitscanResult } from '../combat/HitscanSystem';
import type { Weapon } from '../weapons/Weapon';
import type { AudioEngine } from './AudioEngine';
import type { SoundId } from './weaponSounds';

const SPEED_OF_SOUND = 343;

/**
 * Air takes the crack out of a far gunshot: full range up close, a low-pass from 10 m on
 * (~13 kHz at 10 m, ~7 kHz at 50 m, ~3 kHz at 100 m, 1.2 kHz floor). Undefined = no filter.
 */
export function distantLowpass(distance: number): number | undefined {
  if (distance < 10) return undefined;
  return Math.max(1200, 16000 * Math.exp(-distance / 60));
}
/**
 * How much of a gunshot goes to the room reverb with distance: a close shot is mostly the dry
 * crack, a far one mostly the space it was fired in (heard after the walls and buildings).
 */
export function reverbSend(distance: number): number {
  return 0.16 + 0.5 * Math.min(Math.max(distance - 5, 0) / 60, 1);
}
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

  /**
   * One call per fired round / melee attack. `delay` spaces shots that fired within the same frame.
   * `confirm` false: the hit confirm is left to the caller (the game merges a round's pellets, HitFeedback).
   */
  onShot(weapon: Weapon, result: HitscanResult, delay: number, listener: THREE.Camera, confirm = true): void {
    const s = weapon.def.sounds;
    this.engine.play(s.fire, { group: 'shot', gain: s.fireVolume, rateJitter: 0.025, delay, wet: reverbSend(0) });
    if (s.cycle) this.engine.play(s.cycle, { group: 'foley', gain: 0.8, delay, wet: 0.05 });
    if (result.kind === 'miss') return;
    // Hit confirm, heard at the shooter (not placed in the world), right after the shot.
    if (confirm && result.kind === 'target') this.hitConfirm(result.zone === 'head', delay + 0.02);
    if (s.hit) {
      this.engine.play(s.hit, { group: 'impact', gain: 0.8, rateJitter: 0.04, delay: delay + 0.03 });
      return;
    }
    this.impact(result.kind === 'target' ? 'impact.flesh' : 'impact', result.point, delay, listener);
  }

  /** Hit confirm at the shooter: this player's round hit someone (here, or resolved by the room's host). */
  hitConfirm(head: boolean, delay = 0): void {
    this.engine.play(head ? 'hit.head' : 'hit.body', { group: 'impact', gain: head ? 0.55 : 0.5, rateJitter: 0.03, delay });
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
      lowpass: distantLowpass(d),
      wet: reverbSend(d),
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
      wet: reverbSend(d) * 0.8,
    });
  }

  /** The player's own footstep (`gain` by gait: a walk is quiet). */
  footstep(gain: number): void {
    this.engine.play('step', { group: 'env', gain, rateJitter: 0.06, wet: 0.08 });
  }

  /** The player landing, by impact speed (m/s). */
  landing(speed: number): void {
    this.engine.play('land', { group: 'env', gain: Math.min(0.25 + speed * 0.06, 0.8), rateJitter: 0.05, wet: 0.1 });
  }

  /** A spent case hitting the floor near the player (brass tinkle or a shotgun hull). */
  caseDrop(hull: boolean, point: THREE.Vector3, listener: THREE.Camera): void {
    _dir.subVectors(point, listener.position);
    const d = _dir.length();
    if (d > 12) return;
    _dir.multiplyScalar(1 / Math.max(d, 1e-3));
    _right.set(1, 0, 0).applyQuaternion(listener.quaternion);
    this.engine.play(hull ? 'case.shell' : 'case.brass', {
      group: 'env',
      gain: 0.32 / (1 + d / 2.5),
      pan: _dir.dot(_right) * 0.6,
      rateJitter: 0.08,
      wet: 0.08,
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
      this.engine.play(cues[this.nextReloadCue].sound, { group: 'foley', gain: 0.75, rateJitter: 0.02, wet: 0.05 });
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
      wet: 0.1 + reverbSend(d) * 0.3,
    });
  }
}
