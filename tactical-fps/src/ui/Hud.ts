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
  private readonly hitMarker: HTMLDivElement;
  private hitMarkerAnim: Animation | null = null;
  private readonly vignette: HTMLDivElement;
  private readonly damageDir: HTMLDivElement;
  private readonly vitals: HTMLDivElement;
  private readonly death: HTMLDivElement;
  private readonly deathSeconds: HTMLSpanElement;
  private readonly deathBar: HTMLDivElement;
  private damageAnims: Animation[] = [];
  /** Tenths of a second shown on the death panel (-1 = hidden). */
  private lastDeathTenths = -1;
  private lastHealth = -1;
  private lastAmmoKey = '';
  private lastReload = -1;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'hud');
    this.root.innerHTML = `
      <div class="damage-vignette" aria-hidden="true"></div>
      <div class="damage-dir" aria-hidden="true"><span class="damage-arc"></span></div>
      <div class="crosshair" aria-hidden="true">
        <span class="ch-line ch-top"></span><span class="ch-line ch-bottom"></span>
        <span class="ch-line ch-left"></span><span class="ch-line ch-right"></span>
        <div class="hitmarker"><span class="hm hm-tl"></span><span class="hm hm-tr"></span><span class="hm hm-bl"></span><span class="hm hm-br"></span></div>
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
      <div class="death" role="status" hidden>
        <div class="death-title">사망</div>
        <div class="death-timer">리스폰까지 <span class="death-seconds">3.0</span>초</div>
        <div class="death-track"><div class="death-bar"></div></div>
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
    this.hitMarker = this.root.querySelector('.hitmarker')!;
    this.vignette = this.root.querySelector('.damage-vignette')!;
    this.damageDir = this.root.querySelector('.damage-dir')!;
    this.vitals = this.root.querySelector('.vitals')!;
    this.death = this.root.querySelector('.death')!;
    this.deathSeconds = this.root.querySelector('.death-seconds')!;
    this.deathBar = this.root.querySelector('.death-bar')!;
  }

  /**
   * The player took `amount` damage from `angle` (radians, 0 = straight ahead,
   * positive = to the right): red screen edges scaled by the damage, a marker
   * pointing at the shooter, and a flash on the health panel.
   */
  showDamage(amount: number, angle: number): void {
    for (const a of this.damageAnims) a.cancel();
    const peak = Math.min(0.2 + (amount / 100) * 0.5, 0.65);
    this.damageDir.style.transform = `rotate(${angle}rad)`;
    this.damageAnims = [
      this.vignette.animate([{ opacity: peak }, { opacity: 0 }], { duration: 550, easing: 'ease-out' }),
      this.damageDir.animate([{ opacity: 1 }, { opacity: 1, offset: 0.4 }, { opacity: 0 }], { duration: 1100, easing: 'linear' }),
      this.vitals.animate([{ backgroundColor: 'rgba(208, 86, 63, 0.55)' }, { backgroundColor: 'rgba(17, 19, 21, 0.62)' }], { duration: 450, easing: 'ease-out' }),
    ];
  }

  /** Death panel with the respawn countdown; `secondsLeft` null hides it. */
  setDeath(secondsLeft: number | null, total: number): void {
    const tenths = secondsLeft === null ? -1 : Math.ceil(secondsLeft * 10);
    if (tenths === this.lastDeathTenths) return;
    this.lastDeathTenths = tenths;
    this.death.hidden = tenths < 0;
    this.root.classList.toggle('dead', tenths >= 0);
    if (tenths < 0) return;
    this.deathSeconds.textContent = (tenths / 10).toFixed(1);
    this.deathBar.style.transform = `scaleX(${1 - Math.min(tenths / 10 / total, 1)})`;
  }

  /** Brief X around the crosshair when a shot hits a target: red for the head, bigger on a kill. */
  showHitMarker(head: boolean, kill: boolean): void {
    const m = this.hitMarker;
    m.classList.toggle('head', head);
    m.classList.toggle('kill', kill);
    this.hitMarkerAnim?.cancel();
    this.hitMarkerAnim = m.animate([{ opacity: 1 }, { opacity: 1, offset: 0.5 }, { opacity: 0 }], {
      duration: kill ? 300 : 120,
      easing: 'linear',
    });
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
