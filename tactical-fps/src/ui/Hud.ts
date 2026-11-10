import { ARMOR_CONFIG, PLAYER_CONFIG } from '../config';
import { MainMenu, type MenuMap, type MenuOption, type MenuWeapon } from './MainMenu';
import { formatKd, type CombatStats } from '../game/CombatStats';
import './theme.css';
import './hud.css';

/**
 * Minimal DOM HUD. Values are only written to the DOM when they change so the
 * HUD costs nothing per frame. The start/pause menu and loading screen live
 * in MainMenu; the methods below keep the game's existing calls working.
 */
/** Kills closer together than this count as one streak on the kill notice (ms). */
const KILL_STREAK_MS = 4000;

export class Hud {
  readonly root: HTMLDivElement;
  readonly menu: MainMenu;
  private readonly healthValue: HTMLSpanElement;
  private readonly healthBar: HTMLDivElement;
  /** Trails the health bar after damage (shows what was just lost), then catches up. */
  private readonly healthLag: HTMLDivElement;
  private readonly magBar: HTMLDivElement;
  private lastWeaponName = '';
  private readonly stats: HTMLDivElement;
  private readonly weaponName: HTMLDivElement;
  private readonly ammoMag: HTMLSpanElement;
  private readonly ammoReserve: HTMLSpanElement;
  private readonly weaponStatus: HTMLDivElement;
  private readonly reloadPrompt: HTMLDivElement;
  private readonly reloadBar: HTMLDivElement;
  private readonly hitMarker: HTMLDivElement;
  private hitMarkerAnim: Animation | null = null;
  private hitRingAnim: Animation | null = null;
  private killNoticeAnim: Animation | null = null;
  private readonly vignette: HTMLDivElement;
  private readonly damageDir: HTMLDivElement;
  private readonly vitals: HTMLDivElement;
  private readonly combat: HTMLDivElement;
  private readonly csKills: HTMLElement;
  private readonly csDeaths: HTMLElement;
  private readonly csKd: HTMLElement;
  private readonly csHs: HTMLElement;
  private readonly csDmg: HTMLElement;
  /** Combat record last shown (-1 = hidden), so the DOM is only touched when a number changes. */
  private readonly csShown = { kills: -1, deaths: -1, headshots: -1, damage: -1 };
  private readonly death: HTMLDivElement;
  private readonly deathSeconds: HTMLSpanElement;
  private readonly deathBar: HTMLDivElement;
  private damageAnims: Animation[] = [];
  /** Tenths of a second shown on the death panel (-1 = hidden). */
  private lastDeathTenths = -1;
  private lastHealth = -1;
  private lastAmmoKey = '';
  private killStreak = 0;
  private lastKillAt = -Infinity;
  private lastReload = -1;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'hud');
    this.root.innerHTML = `
      <div class="damage-vignette" aria-hidden="true"></div>
      <div class="damage-dir" aria-hidden="true"><span class="damage-arc"></span></div>
      <div class="crosshair" aria-hidden="true">
        <span class="ch-line ch-top"></span><span class="ch-line ch-bottom"></span>
        <span class="ch-line ch-left"></span><span class="ch-line ch-right"></span>
        <div class="hitmarker"><span class="hm hm-tl"></span><span class="hm hm-tr"></span><span class="hm hm-bl"></span><span class="hm hm-br"></span><span class="hm-ring"></span></div>
        <div class="kill-notice" aria-hidden="true"><span class="kn-mark"></span><span class="kn-text">처치</span><span class="kn-count"></span></div>
        <div class="reload-prompt" aria-hidden="true">R 재장전</div>
      </div>
      <div class="scope" aria-hidden="true"><span class="scope-h"></span><span class="scope-v"></span></div>
      <div class="smoke-veil" aria-hidden="true"></div>
      <div class="flash-white" aria-hidden="true"></div>
      <div class="vitals">
        <div class="vitals-label">HP</div>
        <div class="vitals-main">
          <span class="health-value">100</span>
          <div class="health-track"><div class="health-lag"></div><div class="health-bar"></div></div>
        </div>
        <div class="armor" hidden>
          <div class="vitals-label">AP</div>
          <div class="vitals-main">
            <span class="armor-value">0</span>
            <div class="health-track"><div class="armor-bar"></div></div>
          </div>
        </div>
      </div>
      <div class="combat-stats" hidden>
        <div class="cs-row"><span class="cs-k">KILLS</span><b class="cs-v cs-kills">0</b><span class="cs-k">DEATHS</span><b class="cs-v cs-deaths">0</b><span class="cs-k">K/D</span><b class="cs-v cs-kd">0.00</b></div>
        <div class="cs-row"><span class="cs-k">HEADSHOTS</span><b class="cs-v cs-hs">0</b><span class="cs-k">DAMAGE</span><b class="cs-v cs-dmg">0</b></div>
      </div>
      <div class="weapon">
        <div class="loadout"></div>
        <div class="utility" hidden><span class="ut ut-flash"></span><span class="ut ut-smoke"></span></div>
        <div class="weapon-name">AR-01</div>
        <div class="ammo"><span class="ammo-mag">30</span><span class="ammo-sep">/</span><span class="ammo-reserve">90</span></div>
        <div class="mag-track"><div class="mag-bar"></div></div>
        <div class="weapon-status"></div>
        <div class="reload-track"><div class="reload-bar"></div></div>
      </div>
      <div class="death" role="status" hidden>
        <div class="death-title">사망</div>
        <div class="death-timer">리스폰까지 <span class="death-seconds">3.0</span>초</div>
        <div class="death-track"><div class="death-bar"></div></div>
        <div class="death-note"></div>
      </div>
      <div class="stats"></div>`;
    parent.appendChild(this.root);

    this.healthValue = this.root.querySelector('.health-value')!;
    this.healthBar = this.root.querySelector('.health-bar')!;
    this.healthLag = this.root.querySelector('.health-lag')!;
    this.magBar = this.root.querySelector('.mag-bar')!;
    this.stats = this.root.querySelector('.stats')!;
    this.menu = new MainMenu(this.root);
    this.weaponName = this.root.querySelector('.weapon-name')!;
    this.ammoMag = this.root.querySelector('.ammo-mag')!;
    this.ammoReserve = this.root.querySelector('.ammo-reserve')!;
    this.weaponStatus = this.root.querySelector('.weapon-status')!;
    this.reloadPrompt = this.root.querySelector('.reload-prompt')!;
    this.reloadBar = this.root.querySelector('.reload-bar')!;
    this.hitMarker = this.root.querySelector('.hitmarker')!;
    this.vignette = this.root.querySelector('.damage-vignette')!;
    this.damageDir = this.root.querySelector('.damage-dir')!;
    this.vitals = this.root.querySelector('.vitals')!;
    this.combat = this.root.querySelector('.combat-stats')!;
    this.csKills = this.combat.querySelector('.cs-kills')!;
    this.csDeaths = this.combat.querySelector('.cs-deaths')!;
    this.csKd = this.combat.querySelector('.cs-kd')!;
    this.csHs = this.combat.querySelector('.cs-hs')!;
    this.csDmg = this.combat.querySelector('.cs-dmg')!;
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

  /** Scope view (SR-01): dark mask with a round field and fine cross-hairs; the normal crosshair hides. */
  setScoped(on: boolean): void {
    if (this.scoped === on) return;
    this.scoped = on;
    this.root.classList.toggle('scoped', on);
  }

  /** Armour points (ARMOR-01); hidden at 0. */
  setArmor(value: number): void {
    const ap = Math.max(0, Math.round(value));
    if (ap === this.lastArmor) return;
    this.lastArmor = ap;
    const box = this.root.querySelector<HTMLElement>('.armor')!;
    box.hidden = ap <= 0;
    box.querySelector('.armor-value')!.textContent = String(ap);
    box.querySelector<HTMLElement>('.armor-bar')!.style.transform = `scaleX(${Math.min(ap / ARMOR_CONFIG.max, 1)})`;
  }

  /** Flash blindness: white screen at `opacity` (0 = clear). */
  setFlash(opacity: number): void {
    const o = Math.round(Math.min(Math.max(opacity, 0), 1) * 100) / 100;
    if (o === this.lastFlash) return;
    this.lastFlash = o;
    const el = this.root.querySelector<HTMLElement>('.flash-white')!;
    el.style.opacity = String(o);
    this.root.classList.toggle('flashed', o > 0);
  }

  /** Inside a smoke cloud: grey veil at `density` (0..1). */
  setSmoke(density: number): void {
    const d = Math.round(Math.min(Math.max(density, 0), 1) * 100) / 100;
    if (d === this.lastSmoke) return;
    this.lastSmoke = d;
    this.root.querySelector<HTMLElement>('.smoke-veil')!.style.opacity = String(d);
  }

  /** Grenades carried (FLASH-01 / SMOKE-01) and the one in hand; hidden when there are none. */
  setUtility(flash: number, smoke: number, held: 'flash' | 'smoke' | null): void {
    const key = `${flash}|${smoke}|${held}`;
    if (key === this.lastUtility) return;
    this.lastUtility = key;
    const box = this.root.querySelector<HTMLElement>('.utility')!;
    box.hidden = flash + smoke === 0 && !held;
    const f = box.querySelector<HTMLElement>('.ut-flash')!;
    const sm = box.querySelector<HTMLElement>('.ut-smoke')!;
    f.textContent = `섬광 ×${flash}`;
    sm.textContent = `연막 ×${smoke}`;
    f.hidden = flash === 0 && held !== 'flash';
    sm.hidden = smoke === 0 && held !== 'smoke';
    f.classList.toggle('held', held === 'flash');
    sm.classList.toggle('held', held === 'smoke');
  }

  private scoped = false;
  private lastArmor = -1;
  private lastFlash = -1;
  private lastSmoke = -1;
  private lastUtility = '';

  /**
   * Team match: no respawn countdown; the panel shows `note` (who is being
   * spectated) at the bottom instead. null = the normal countdown panel.
   */
  setDeathNote(note: string | null): void {
    this.death.classList.toggle('spectate', note !== null);
    const el = this.death.querySelector<HTMLElement>('.death-note')!;
    if (el.textContent !== (note ?? '')) el.textContent = note ?? '';
  }

  /** Brief X around the crosshair when a shot hits a target: red for the head, bigger on a kill. */
  showHitMarker(head: boolean, kill: boolean): void {
    const m = this.hitMarker;
    m.classList.toggle('head', head);
    m.classList.toggle('kill', kill);
    this.hitMarkerAnim?.cancel();
    this.hitMarkerAnim = m.animate([{ opacity: 1 }, { opacity: 1, offset: 0.5 }, { opacity: 0 }], {
      duration: kill ? 420 : head ? 200 : 120,
      easing: 'linear',
    });
    // Head hits and kills: a thin ring opening out from the crosshair (a body hit stays a plain X).
    this.hitRingAnim?.cancel();
    if (head || kill) {
      const ring = m.querySelector<HTMLElement>('.hm-ring')!;
      this.hitRingAnim = ring.animate(
        [
          { transform: 'translate(-50%, -50%) scale(0.5)', opacity: 0.95 },
          { transform: `translate(-50%, -50%) scale(${kill ? 2.1 : 1.6})`, opacity: 0 },
        ],
        { duration: kill ? 380 : 220, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' },
      );
    }
  }

  /** A kill the match confirmed (with the kill confirm sound): a short "처치" under the crosshair. */
  showKillNotice(now = performance.now()): void {
    const n = this.root.querySelector<HTMLElement>('.kill-notice')!;
    // Kills in quick succession (each within 4 s of the last) count up on the one notice: "처치 ×2".
    // It is restarted, never stacked, so a burst of kills cannot pile notices on the crosshair.
    this.killStreak = now - this.lastKillAt <= KILL_STREAK_MS ? this.killStreak + 1 : 1;
    this.lastKillAt = now;
    n.querySelector('.kn-count')!.textContent = this.killStreak > 1 ? `×${this.killStreak}` : '';
    this.killNoticeAnim?.cancel();
    this.killNoticeAnim = n.animate(
      [
        { opacity: 0, transform: 'translate(-50%, 4px)' },
        { opacity: 1, transform: 'translate(-50%, 0)', offset: 0.12 },
        { opacity: 1, transform: 'translate(-50%, 0)', offset: 0.7 },
        { opacity: 0, transform: 'translate(-50%, -2px)' },
      ],
      { duration: 900, easing: 'ease-out' },
    );
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
    // Paused mid-game: the menu pages (계속하기 / 대결 포기); the lobby is one click away.
    if (paused) this.menu.showMenu();
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
    const lost = hp < this.lastHealth;
    this.lastHealth = hp;
    this.healthValue.textContent = String(hp);
    const k = `scaleX(${hp / PLAYER_CONFIG.maxHealth})`;
    this.healthBar.style.transform = k;
    // Damage: the lost part stays shown a moment, then drains; healing/respawn: at once.
    this.healthLag.style.transition = lost ? '' : 'none';
    this.healthLag.style.transform = k;
    if (lost) this.healthValue.animate([{ transform: 'translateY(-2px)', color: 'var(--hud-danger)' }, { transform: 'none' }], { duration: 260, easing: 'ease-out' });
    this.root.classList.toggle('low-health', hp <= 25);
  }

  /**
   * Slot strip above the ammo counter: "1 AR-01  2 SR-01  3 M9 BAYONET".
   * `keys`: the number key of each entry when it is not its position + 1
   * (team match: 1 primary, 2 secondary, 3 knife).
   */
  setLoadout(names: readonly string[], active: number, keys?: readonly number[]): void {
    this.menu.setSelectedWeapon(active);
    const strip = this.root.querySelector<HTMLDivElement>('.loadout')!;
    strip.replaceChildren(
      ...names.map((n, i) => {
        const span = document.createElement('span');
        span.className = i === active ? 'slot active' : 'slot';
        span.textContent = `${keys?.[i] ?? i + 1} ${n}`;
        // The weapon key's slot (0-based): tapping it on a touch screen picks that weapon, as the key does.
        span.dataset.slot = String((keys?.[i] ?? i + 1) - 1);
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
      if (name !== this.lastWeaponName) {
        // Weapon switched: the name and the slot strip light up briefly.
        if (this.lastWeaponName) this.weaponName.parentElement!.animate([{ borderRightColor: 'var(--c-accent)' }, { borderRightColor: 'var(--c-border-strong)' }], { duration: 700, easing: 'ease-out' });
        this.lastWeaponName = name;
      }
      this.magBar.style.transform = `scaleX(${magazine === null || magazineSize <= 0 ? 0 : Math.min(magazine / magazineSize, 1)})`;
      this.root.classList.toggle('no-ammo', magazine === null);
      if (magazine === null) {
        this.ammoMag.textContent = '—';
        this.ammoReserve.textContent = '';
        this.root.classList.remove('ammo-low', 'ammo-empty', 'reloading', 'reload-needed');
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
      // Magazine empty with rounds in reserve: a small prompt under the crosshair, where the eyes are.
      this.root.classList.toggle('reload-needed', empty && !reloading && reserve > 0);
      // A touch screen has a 장전 button, not an R key.
      const reloadHint = document.documentElement.classList.contains('touch') ? '장전 버튼' : 'R 재장전';
      this.reloadPrompt.textContent = reloadHint;
      this.weaponStatus.textContent = reloading
        ? '재장전 중'
        : empty
          ? reserve > 0
            ? reloadHint
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

  /**
   * The player's combat record for the match (or training) being played, or null to hide it. Called
   * every frame; only a changed number is written to the page (no animation, nothing allocated).
   */
  setCombatStats(s: CombatStats | null): void {
    const c = this.csShown;
    if (!s) {
      if (c.kills !== -1) {
        this.combat.hidden = true;
        c.kills = c.deaths = c.headshots = c.damage = -1;
      }
      return;
    }
    if (c.kills === -1) this.combat.hidden = false;
    if (s.kills !== c.kills || s.deaths !== c.deaths) {
      if (s.kills !== c.kills) this.csKills.textContent = String(s.kills);
      if (s.deaths !== c.deaths) this.csDeaths.textContent = String(s.deaths);
      this.csKd.textContent = formatKd(s.kills, s.deaths);
      c.kills = s.kills;
      c.deaths = s.deaths;
    }
    if (s.headshots !== c.headshots) this.csHs.textContent = String((c.headshots = s.headshots));
    if (s.damage !== c.damage) this.csDmg.textContent = String((c.damage = s.damage));
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
