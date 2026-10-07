import { PLAYER_CONFIG } from '../config';
import './hud.css';

/**
 * Minimal DOM HUD. Values are only written to the DOM when they change so the
 * HUD costs nothing per frame.
 */
export class Hud {
  readonly root: HTMLDivElement;
  private readonly healthValue: HTMLSpanElement;
  private readonly healthBar: HTMLDivElement;
  private readonly stats: HTMLDivElement;
  private readonly overlay: HTMLDivElement;
  private readonly overlayStatus: HTMLParagraphElement;
  private readonly overlayButton: HTMLButtonElement;
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
        <div class="weapon-name">AR-01</div>
        <div class="ammo"><span class="ammo-mag">30</span><span class="ammo-sep">/</span><span class="ammo-reserve">90</span></div>
        <div class="weapon-status"></div>
        <div class="reload-track"><div class="reload-bar"></div></div>
      </div>
      <div class="stats"></div>
      <div class="overlay">
        <div class="panel">
          <h1>TACTICAL FPS <span>PROTOTYPE</span></h1>
          <label class="map-select map-choice">
            <span>맵</span>
            <select></select>
          </label>
          <label class="map-select fps-select">
            <span>프레임 제한</span>
            <select></select>
          </label>
          <label class="map-select quality-select">
            <span>화질</span>
            <select></select>
          </label>
          <p class="status">맵 불러오는 중…</p>
          <button type="button" disabled>클릭하여 시작</button>
          <dl class="controls">
            <dt>W A S D</dt><dd>이동</dd>
            <dt>마우스</dt><dd>시점</dd>
            <dt>Space</dt><dd>점프</dd>
            <dt>Shift</dt><dd>걷기 (조용히)</dd>
            <dt>C / Ctrl</dt><dd>앉기</dd>
            <dt>좌클릭</dt><dd>사격 (자동)</dd>
            <dt>R</dt><dd>재장전</dd>
            <dt>F4</dt><dd>스폰으로 복귀</dd>
            <dt>F3</dt><dd>성능 정보</dd>
            <dt>Esc</dt><dd>일시정지</dd>
          </dl>
        </div>
      </div>`;
    parent.appendChild(this.root);

    this.healthValue = this.root.querySelector('.health-value')!;
    this.healthBar = this.root.querySelector('.health-bar')!;
    this.stats = this.root.querySelector('.stats')!;
    this.overlay = this.root.querySelector('.overlay')!;
    this.overlayStatus = this.root.querySelector('.status')!;
    this.overlayButton = this.root.querySelector('button')!;
    this.weaponName = this.root.querySelector('.weapon-name')!;
    this.ammoMag = this.root.querySelector('.ammo-mag')!;
    this.ammoReserve = this.root.querySelector('.ammo-reserve')!;
    this.weaponStatus = this.root.querySelector('.weapon-status')!;
    this.reloadBar = this.root.querySelector('.reload-bar')!;
  }

  setMapOptions(maps: readonly { id: string; name: string }[], currentId: string, onChange: (id: string) => void): void {
    const select = this.mapSelect;
    fillSelect(select, maps.map((m) => ({ value: m.id, label: m.name })), currentId);
    select.addEventListener('change', () => onChange(select.value));
  }

  setMapSelectEnabled(enabled: boolean): void {
    this.mapSelect.disabled = !enabled;
  }

  setFrameLimitOptions<T extends string | number>(
    options: readonly { value: T; label: string }[],
    current: T,
    onChange: (value: T) => void,
  ): void {
    this.bindSelect('.fps-select select', options, current, onChange);
  }

  setQualityOptions<T extends string>(options: readonly { value: T; label: string }[], current: T, onChange: (value: T) => void): void {
    this.bindSelect('.quality-select select', options, current, onChange);
  }

  private bindSelect<T extends string | number>(
    selector: string,
    options: readonly { value: T; label: string }[],
    current: T,
    onChange: (value: T) => void,
  ): void {
    const select = this.root.querySelector<HTMLSelectElement>(selector)!;
    fillSelect(select, options.map((o) => ({ value: String(o.value), label: o.label })), String(current));
    select.addEventListener('change', () => {
      const picked = options.find((o) => String(o.value) === select.value);
      if (picked) onChange(picked.value);
    });
  }

  private get mapSelect(): HTMLSelectElement {
    return this.root.querySelector<HTMLSelectElement>('.map-choice select')!;
  }

  onStart(handler: () => void): void {
    this.overlayButton.addEventListener('click', handler);
  }

  setLoading(text: string): void {
    this.overlayStatus.textContent = text;
    this.overlayButton.disabled = true;
  }

  setReady(text = '준비 완료'): void {
    this.overlayStatus.textContent = text;
    this.overlayButton.disabled = false;
  }

  setError(text: string): void {
    this.overlayStatus.textContent = text;
    this.overlayStatus.classList.add('error');
    this.overlayButton.disabled = true;
  }

  setPaused(paused: boolean): void {
    this.overlay.classList.toggle('hidden', !paused);
    this.root.classList.toggle('playing', !paused);
  }

  setHealth(value: number): void {
    const hp = Math.max(0, Math.round(value));
    if (hp === this.lastHealth) return;
    this.lastHealth = hp;
    this.healthValue.textContent = String(hp);
    this.healthBar.style.transform = `scaleX(${hp / PLAYER_CONFIG.maxHealth})`;
    this.root.classList.toggle('low-health', hp <= 25);
  }

  /** `reloadProgress` is 0..1 while reloading, null otherwise. */
  setWeapon(name: string, magazine: number, magazineSize: number, reserve: number, reloadProgress: number | null): void {
    const key = `${name}|${magazine}|${reserve}|${reloadProgress === null ? 0 : 1}`;
    if (key !== this.lastAmmoKey) {
      this.lastAmmoKey = key;
      this.weaponName.textContent = name;
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
  }

  get statsVisible(): boolean {
    return this.stats.classList.contains('visible');
  }

  setStats(text: string): void {
    this.stats.textContent = text;
  }
}

function fillSelect(select: HTMLSelectElement, options: { value: string; label: string }[], current: string): void {
  select.innerHTML = '';
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    opt.selected = o.value === current;
    select.appendChild(opt);
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  return e;
}
