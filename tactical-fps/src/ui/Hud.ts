import { PLAYER_CONFIG } from '../config';
import { MainMenu, type MenuMap, type MenuOption, type MenuWeapon } from './MainMenu';
import './theme.css';
import './hud.css';

/**
 * Minimal DOM HUD. Values are only written to the DOM when they change so the
 * HUD costs nothing per frame. The start/pause menu and loading screen live
 * in MainMenu; the methods below keep the game's existing calls working.
 */
export class Hud {
  readonly root: HTMLDivElement;
  readonly menu: MainMenu;
  private readonly healthValue: HTMLSpanElement;
  private readonly healthBar: HTMLDivElement;
  private readonly stats: HTMLDivElement;
  private readonly weaponName: HTMLDivElement;
  private readonly ammoMag: HTMLSpanElement;
  private readonly ammoReserve: HTMLSpanElement;
  private readonly weaponStatus: HTMLDivElement;
  private readonly reloadBar: HTMLDivElement;
  private lastHealth = -1;
  private lastAmmoKey = '';
  private lastReload = -1;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'hud');
    this.root.innerHTML = `
      <div class="crosshair" aria-hidden="true">
        <span class="ch-line ch-top"></span><span class="ch-line ch-bottom"></span>
        <span class="ch-line ch-left"></span><span class="ch-line ch-right"></span>
      </div>
      <div class="vitals">
        <div class="vitals-label">HP</div>
        <div class="vitals-main">
          <span class="health-value">100</span>
          <div class="health-track"><div class="health-bar"></div></div>
        </div>
      </div>
      <div class="weapon">
        <div class="loadout"></div>
        <div class="weapon-name">AR-01</div>
        <div class="ammo"><span class="ammo-mag">30</span><span class="ammo-sep">/</span><span class="ammo-reserve">90</span></div>
        <div class="weapon-status"></div>
        <div class="reload-track"><div class="reload-bar"></div></div>
      </div>
      <div class="stats"></div>`;
    parent.appendChild(this.root);

    this.healthValue = this.root.querySelector('.health-value')!;
    this.healthBar = this.root.querySelector('.health-bar')!;
    this.stats = this.root.querySelector('.stats')!;
    this.menu = new MainMenu(this.root);
    this.weaponName = this.root.querySelector('.weapon-name')!;
    this.ammoMag = this.root.querySelector('.ammo-mag')!;
    this.ammoReserve = this.root.querySelector('.ammo-reserve')!;
    this.weaponStatus = this.root.querySelector('.weapon-status')!;
    this.reloadBar = this.root.querySelector('.reload-bar')!;
  }

  setMapOptions(maps: readonly MenuMap[], currentId: string, onChange: (id: string) => void): void {
    this.menu.setMaps(maps, currentId, onChange);
  }

  setMapSelectEnabled(enabled: boolean): void {
    this.menu.setMapsEnabled(enabled);
  }

  setFrameLimitOptions<T extends string | number>(options: readonly MenuOption<T>[], current: T, onChange: (value: T) => void): void {
    this.menu.bindSelect('frame-limit', options, current, onChange);
  }

  setQualityOptions<T extends string>(options: readonly MenuOption<T>[], current: T, onChange: (value: T) => void): void {
    this.menu.bindSelect('quality', options, current, onChange);
  }

  /** Weapon cards on the menu's Weapons page; selecting one equips that loadout slot. */
  setWeaponOptions(weapons: readonly MenuWeapon[], onSelect: (slot: number) => void): void {
    this.menu.setWeapons(weapons, onSelect);
  }

  setWeaponOptionsEnabled(enabled: boolean): void {
    this.menu.setWeaponsEnabled(enabled);
  }

  onStart(handler: () => void): void {
    this.menu.onPlay(handler);
  }

  /** Loading screen with real progress (0..1) or an indeterminate bar (null). */
  setLoading(text: string, mapName = '', progress: number | null = null): void {
    this.menu.showLoading(mapName, progress, text);
  }

  setReady(text = '준비 완료'): void {
    this.menu.setReady(text);
  }

  setError(text: string): void {
    this.menu.setError(text);
  }

  /** `paused` = menu showing (before the first start, or after Esc). */
  setPaused(paused: boolean): void {
    this.menu.setVisible(paused);
    this.root.classList.toggle('playing', !paused);
  }

  /** After the first start the menu's primary button reads "계속하기". */
  setResumeMode(resume: boolean): void {
    this.menu.setPausedMode(resume);
  }

  setHealth(value: number): void {
    const hp = Math.max(0, Math.round(value));
    if (hp === this.lastHealth) return;
    this.lastHealth = hp;
    this.healthValue.textContent = String(hp);
    this.healthBar.style.transform = `scaleX(${hp / PLAYER_CONFIG.maxHealth})`;
    this.root.classList.toggle('low-health', hp <= 25);
  }

  /** Slot strip above the ammo counter: "1 AR-01  2 SR-01  3 KARAMBIT". */
  setLoadout(names: readonly string[], active: number): void {
    this.menu.setSelectedWeapon(active);
    const strip = this.root.querySelector<HTMLDivElement>('.loadout')!;
    strip.replaceChildren(
      ...names.map((n, i) => {
        const span = document.createElement('span');
        span.className = i === active ? 'slot active' : 'slot';
        span.textContent = `${i + 1} ${n}`;
        return span;
      }),
    );
  }

  /**
   * `magazine` is null for weapons without ammo (melee).
   * `reloadProgress` is 0..1 while reloading, null otherwise.
   */
  setWeapon(name: string, magazine: number | null, magazineSize: number, reserve: number, reloadProgress: number | null): void {
    const key = `${name}|${magazine}|${reserve}|${reloadProgress === null ? 0 : 1}`;
    if (key !== this.lastAmmoKey) {
      this.lastAmmoKey = key;
      this.weaponName.textContent = name;
      this.root.classList.toggle('no-ammo', magazine === null);
      if (magazine === null) {
        this.ammoMag.textContent = '—';
        this.ammoReserve.textContent = '';
        this.root.classList.remove('ammo-low', 'ammo-empty', 'reloading');
        this.weaponStatus.textContent = '';
        return;
      }
      this.ammoMag.textContent = String(magazine);
      this.ammoReserve.textContent = String(reserve);
      const reloading = reloadProgress !== null;
      const empty = magazine === 0;
      const low = magazine > 0 && magazine <= Math.ceil(magazineSize * 0.2);
      this.root.classList.toggle('ammo-low', low && !reloading);
      this.root.classList.toggle('ammo-empty', empty && !reloading);
      this.root.classList.toggle('reloading', reloading);
      this.weaponStatus.textContent = reloading
        ? '재장전 중'
        : empty
          ? reserve > 0
            ? 'R 재장전'
            : '탄약 없음'
          : '';
    }
    // Progress bar: quantize so the DOM is touched at most ~50 times per reload.
    const q = reloadProgress === null ? -1 : Math.round(reloadProgress * 50);
    if (q !== this.lastReload) {
      this.lastReload = q;
      this.reloadBar.style.transform = `scaleX(${q < 0 ? 0 : q / 50})`;
    }
  }

  setStatsVisible(visible: boolean): void {
    this.stats.classList.toggle('visible', visible);
    this.menu.setToggle('stats', visible);
  }

  get statsVisible(): boolean {
    return this.stats.classList.contains('visible');
  }

  setStats(text: string): void {
    this.stats.textContent = text;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  return e;
}
