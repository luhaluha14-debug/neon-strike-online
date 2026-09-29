import type { WeaponDefinition } from './WeaponDefinition';

export type WeaponStatus = 'ready' | 'reloading';

/**
 * Ammo, fire-rate and reload state for one gun. Pure logic (no rendering, no
 * DOM) so it can run unchanged on a server later.
 */
export class Weapon {
  readonly def: WeaponDefinition;
  magazine: number;
  reserve: number;
  status: WeaponStatus = 'ready';
  /** Seconds left on the current reload. */
  reloadRemaining = 0;

  /** Time until the next round may fire; may go negative inside a tick to keep the exact RPM. */
  private cooldown = 0;
  private triggerWasHeld = false;

  constructor(def: WeaponDefinition) {
    this.def = def;
    this.magazine = def.magazineSize;
    this.reserve = def.reserveAmmo;
  }

  get fireInterval(): number {
    return 60 / this.def.fireRate;
  }

  get reloadProgress(): number {
    return this.status === 'reloading' ? 1 - this.reloadRemaining / this.def.reloadTime : 0;
  }

  get canReload(): boolean {
    return this.status === 'ready' && this.magazine < this.def.magazineSize && this.reserve > 0;
  }

  /** Starts a reload if one is possible. Returns true when it started. */
  startReload(): boolean {
    if (!this.canReload) return false;
    this.status = 'reloading';
    this.reloadRemaining = this.def.reloadTime;
    return true;
  }

  /**
   * Advances timers by `dt` and returns how many rounds fire during this step
   * (0 or more; >1 only if `dt` is longer than the fire interval).
   */
  update(dt: number, triggerHeld: boolean): { shots: number; reloadFinished: boolean; dryFire: boolean } {
    let reloadFinished = false;
    let dryFire = false;
    let shots = 0;

    if (this.status === 'reloading') {
      this.reloadRemaining -= dt;
      if (this.reloadRemaining <= 0) {
        this.finishReload();
        reloadFinished = true;
      }
    }

    this.cooldown -= dt;
    const pressedThisStep = triggerHeld && !this.triggerWasHeld;
    const wantsFire = this.def.fireMode === 'auto' ? triggerHeld : pressedThisStep;

    if (wantsFire && this.status === 'ready') {
      if (this.magazine <= 0) {
        if (pressedThisStep) dryFire = true;
      } else {
        while (this.cooldown <= 0 && this.magazine > 0) {
          this.magazine--;
          shots++;
          this.cooldown += this.fireInterval;
          if (this.def.fireMode === 'semi') break;
        }
      }
    }
    // Don't bank fire time while idle: the next trigger pull fires immediately, but not faster than the RPM.
    if (this.cooldown < 0) this.cooldown = 0;

    this.triggerWasHeld = triggerHeld;
    return { shots, reloadFinished, dryFire };
  }

  private finishReload(): void {
    const needed = this.def.magazineSize - this.magazine;
    const loaded = Math.min(needed, this.reserve);
    this.magazine += loaded;
    this.reserve -= loaded;
    this.status = 'ready';
    this.reloadRemaining = 0;
  }

  /** Refills everything (respawn / new round). */
  resetAmmo(): void {
    this.magazine = this.def.magazineSize;
    this.reserve = this.def.reserveAmmo;
    this.status = 'ready';
    this.reloadRemaining = 0;
    this.cooldown = 0;
  }
}
