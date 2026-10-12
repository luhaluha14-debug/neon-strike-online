import * as THREE from 'three';
import type { HitscanResult } from '../combat/HitscanSystem';
import type { Weapon } from '../weapons/Weapon';
import type { AudioEngine } from './AudioEngine';

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
    if (s.hit) {
      this.engine.play(s.hit, { group: 'impact', gain: 0.8, rateJitter: 0.04, delay: delay + 0.03 });
      return;
    }
    this.impact(result.point, delay, listener);
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

  /** Bullet impact at a world point: quieter and later with distance, panned left/right. */
  private impact(point: THREE.Vector3, delay: number, listener: THREE.Camera): void {
    _dir.subVectors(point, listener.position);
    const d = _dir.length();
    if (d > 120) return;
    _dir.multiplyScalar(1 / Math.max(d, 1e-3));
    _right.set(1, 0, 0).applyQuaternion(listener.quaternion);
    this.engine.play('impact', {
      group: 'impact',
      gain: 0.5 / (1 + d / 6),
      pan: _dir.dot(_right) * 0.7,
      rateJitter: 0.06,
      delay: delay + Math.min(d / SPEED_OF_SOUND, 0.3),
    });
  }
}
