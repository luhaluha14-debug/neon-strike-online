import type { WeaponDefinition } from './WeaponDefinition';

export type WeaponStatus = 'ready' | 'reloading' | 'equipping';

/**
 * Ammo, fire-rate, reload and equip state for one weapon. Pure logic (no
 * rendering, no DOM, no input devices) so it runs the same for the local
 * player, future AI bots and a future server.
 *
 * Melee weapons are weapons with `magazineSize: 0`: they never use ammo and
 * attack as often as `fireRate` allows.
 */
export class Weapon {
  readonly def: WeaponDefinition;
  magazine: number;
  reserve: number;
  status: WeaponStatus = 'ready';
  /** Seconds left on the current reload. */
  reloadRemaining = 0;
  /** Seconds left before a freshly equipped weapon can attack. */
  equipRemaining = 0;
  /** Seconds since the last shot/attack (drives bolt cycling, slashes). */
  timeSinceShot = Infinity;

  /** Time until the next round may fire; may go negative inside a tick to keep the exact RPM. */
  private cooldown = 0;
  private triggerWasHeld = false;

  constructor(def: WeaponDefinition) {
    this.def = def;
    this.magazine = def.magazineSize;
    this.reserve = def.reserveAmmo;
  }

  get usesAmmo(): boolean {
    return this.def.magazineSize > 0;
  }

  get fireInterval(): number {
    return 60 / this.def.fireRate;
  }

  get reloadProgress(): number {
    return this.status === 'reloading' ? 1 - this.reloadRemaining / this.def.reloadTime : 0;
  }

  /** 0 → 1 while being drawn, 1 once ready. */
  get equipProgress(): number {
    return this.def.equipTime > 0 ? 1 - Math.max(this.equipRemaining, 0) / this.def.equipTime : 1;
  }

  get canReload(): boolean {
    return this.usesAmmo && this.status === 'ready' && this.magazine < this.def.magazineSize && this.reserve > 0;
  }

  /** Starts a reload if one is possible. Returns true when it started. */
  startReload(): boolean {
    if (!this.canReload) return false;
    this.status = 'reloading';
    this.reloadRemaining = this.def.reloadTime;
    return true;
  }

  /** Called when this weapon becomes the active one. An unfinished reload is cancelled (ammo unchanged). */
  equip(): void {
    this.status = 'equipping';
    this.reloadRemaining = 0;
    this.equipRemaining = this.def.equipTime;
    this.timeSinceShot = Infinity;
    this.triggerWasHeld = true; // a trigger held through the switch must be released first
  }

  /**
   * Advances timers by `dt` and returns how many rounds fire during this step
   * (0 or more; >1 only if `dt` is longer than the fire interval).
   */
  update(dt: number, triggerHeld: boolean): { shots: number; reloadFinished: boolean; dryFire: boolean } {
    let reloadFinished = false;
    let dryFire = false;
    let shots = 0;
    this.timeSinceShot += dt;

    if (this.status === 'equipping') {
      this.equipRemaining -= dt;
      if (this.equipRemaining <= 0) {
        this.equipRemaining = 0;
        this.status = 'ready';
      }
    } else if (this.status === 'reloading') {
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
      if (this.usesAmmo && this.magazine <= 0) {
        if (pressedThisStep) dryFire = true;
      } else {
        while (this.cooldown <= 0 && (!this.usesAmmo || this.magazine > 0)) {
          if (this.usesAmmo) this.magazine--;
          shots++;
          this.cooldown += this.fireInterval;
          this.timeSinceShot = 0;
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
    this.equipRemaining = 0;
    this.cooldown = 0;
    this.timeSinceShot = Infinity;
  }
}
