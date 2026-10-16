import './menu.css';

import { ACTIONS, bindKey, defaultControls, keyLabel, RESERVED_KEYS, SENSITIVITY_MAX, SENSITIVITY_MIN, type ActionId, type ControlSettings } from '../input/Controls';

export type MenuPage = 'play' | 'loadout' | 'settings' | 'controls';

export interface MenuMap {
  id: string;
  name: string;
}

export interface MenuWeapon {
  slot: number;
  id: string;
  name: string;
  category: 'rifle' | 'sniper' | 'melee';
  /** Real values from the weapon definition, already formatted. */
  stats: readonly { label: string; value: string }[];
}

export interface MenuOption<T> {
  value: T;
  label: string;
}

const CATEGORY_LABEL: Record<MenuWeapon['category'], string> = {
  rifle: '돌격소총',
  sniper: '저격소총',
  melee: '근접 무기',
};

const PAGES: readonly { id: MenuPage; label: string }[] = [
  { id: 'play', label: '플레이' },
  { id: 'loadout', label: '무기' },
  { id: 'settings', label: '설정' },
  { id: 'controls', label: '조작' },
];

/**
 * Start / pause menu and loading screen. Pure view: it renders what the
 * game gives it and reports clicks through callbacks; every control maps
 * to an existing game action (start, map switch, equip slot, settings).
 */
export class MainMenu {
  readonly root: HTMLDivElement;
  private readonly menu: HTMLElement;
  private readonly loading: HTMLElement;
  private readonly playButton: HTMLButtonElement;
  private readonly status: HTMLParagraphElement;
  private readonly mapList: HTMLDivElement;
  private readonly weaponGroups: HTMLDivElement;
  private readonly loadingMap: HTMLElement;
  private readonly loadingText: HTMLElement;
  private readonly loadingPercent: HTMLElement;
  private readonly loadingProgress: HTMLElement;
  private readonly loadingBar: HTMLElement;
  private mapButtons: HTMLButtonElement[] = [];
  private weaponButtons: HTMLButtonElement[] = [];
  private paused = false;
  private pageListeners: ((page: MenuPage) => void)[] = [];
  private ready = false;
  private weaponsEnabled = false;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'overlay';
    this.root.innerHTML = `
      <div class="menu-scrim" aria-hidden="true"></div>
      <aside class="menu" aria-label="메인 메뉴">
        <header class="brand">
          <span class="brand-mark" aria-hidden="true"></span>
          <div>
            <h1 class="brand-title">TACTICAL FPS</h1>
            <div class="brand-sub eyebrow">Prototype · 솔로 연습</div>
          </div>
        </header>
        <nav class="tabs" role="tablist" aria-label="메뉴">
          ${PAGES.map(
            (p, i) =>
              `<button type="button" class="tab" role="tab" id="tab-${p.id}" data-page="${p.id}" aria-controls="page-${p.id}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${p.label}</button>`,
          ).join('')}
        </nav>
        <div class="pages">
          <section class="page" id="page-play" data-page="play" role="tabpanel" aria-labelledby="tab-play">
            <h2 class="section-title">게임</h2>
            <label class="field">
              <span class="field-label">모드</span>
              <select class="select" data-setting="mode"></select>
            </label>
            <div class="match-options">
              <label class="field">
                <span class="field-label">봇 수</span>
                <select class="select" data-setting="bots"></select>
              </label>
              <label class="field">
                <span class="field-label">제한 시간</span>
                <select class="select" data-setting="time-limit"></select>
              </label>
              <label class="field">
                <span class="field-label">목표 킬</span>
                <select class="select" data-setting="kill-target"></select>
                <span class="field-hint">바꾸면 경기가 처음부터 다시 시작됩니다.</span>
              </label>
            </div>
            <h2 class="section-title">맵</h2>
            <div class="map-list" role="radiogroup" aria-label="맵 선택"></div>
            <p class="menu-status" aria-live="polite"></p>
          </section>
          <section class="page" id="page-loadout" data-page="loadout" role="tabpanel" aria-labelledby="tab-loadout" hidden>
            <p class="page-note muted">선택한 무기를 들고 시작합니다. 게임 중에는 <span class="kbd">1</span> <span class="kbd">2</span> <span class="kbd">3</span> 또는 마우스 휠로 바꿉니다.</p>
            <div class="weapon-groups"></div>
          </section>
          <section class="page" id="page-settings" data-page="settings" role="tabpanel" aria-labelledby="tab-settings" hidden>
            <h2 class="section-title">그래픽</h2>
            <label class="field">
              <span class="field-label">화질</span>
              <select class="select" data-setting="quality"></select>
              <span class="field-hint">변경하면 페이지를 다시 불러와 적용합니다.</span>
            </label>
            <label class="field">
              <span class="field-label">프레임 제한</span>
              <select class="select" data-setting="frame-limit"></select>
              <span class="field-hint">"최대"는 모니터 주사율까지 그립니다.</span>
            </label>
            <h2 class="section-title">사운드</h2>
            <label class="field">
              <span class="field-label">효과음 볼륨</span>
              <select class="select" data-setting="volume"></select>
            </label>
            <h2 class="section-title">인터페이스</h2>
            <label class="field">
              <span class="field-label">성능 정보 표시 <span class="kbd">F3</span></span>
              <span class="toggle"><input type="checkbox" data-setting="stats" /><span class="track"></span></span>
            </label>
          </section>
          <section class="page" id="page-controls" data-page="controls" role="tabpanel" aria-labelledby="tab-controls" hidden>
            ${controlsHtml()}
          </section>
        </div>
        <footer class="menu-footer">
          <button type="button" class="btn btn-primary btn-block play-button" disabled>플레이</button>
        </footer>
      </aside>
      <div class="loading" hidden aria-live="polite">
        <div class="loading-inner">
          <div class="brand brand-compact">
            <span class="brand-mark" aria-hidden="true"></span>
            <span class="brand-title">TACTICAL FPS</span>
          </div>
          <div class="loading-info">
            <div class="eyebrow">맵 불러오는 중</div>
            <div class="loading-map"></div>
            <div class="progress loading-progress" role="progressbar" aria-label="불러오기 진행률"><div class="progress-bar"></div></div>
            <div class="loading-row">
              <span class="loading-text muted"></span>
              <span class="loading-percent"></span>
            </div>
          </div>
        </div>
      </div>`;
    parent.appendChild(this.root);

    const q = <T extends Element>(s: string) => this.root.querySelector<T>(s)!;
    this.menu = q('.menu');
    this.loading = q('.loading');
    this.playButton = q('.play-button');
    this.status = q('.menu-status');
    this.mapList = q('.map-list');
    this.weaponGroups = q('.weapon-groups');
    this.loadingMap = q('.loading-map');
    this.loadingText = q('.loading-text');
    this.loadingPercent = q('.loading-percent');
    this.loadingProgress = q('.loading-progress');
    this.loadingBar = q('.loading-progress .progress-bar');

    this.bindTabs();
  }

  /** Match options only matter in deathmatch. */
  setMatchOptionsVisible(on: boolean): void {
    this.root.querySelector<HTMLElement>('.match-options')!.hidden = !on;
  }

  // --- Controls page -----------------------------------------------------------

  private controls: ControlSettings | null = null;
  private onControlsChange: ((c: ControlSettings) => void) | null = null;
  private capturing: ActionId | null = null;

  /** Mouse sensitivity and key bindings; `onChange` gets the whole record after every edit. */
  setControls(c: ControlSettings, onChange: (c: ControlSettings) => void): void {
    this.controls = c;
    this.onControlsChange = onChange;
    const range = this.root.querySelector<HTMLInputElement>('input[data-setting="sensitivity"]')!;
    range.value = String(c.sensitivity);
    range.oninput = () => {
      c.sensitivity = Math.min(SENSITIVITY_MAX, Math.max(SENSITIVITY_MIN, Number(range.value)));
      this.renderControls();
      onChange(c);
    };
    this.root.querySelector<HTMLButtonElement>('.controls-reset')!.onclick = () => {
      const d = defaultControls();
      c.sensitivity = d.sensitivity;
      c.bindings = d.bindings;
      range.value = String(c.sensitivity);
      this.capturing = null;
      this.renderControls();
      onChange(c);
    };
    for (const btn of this.root.querySelectorAll<HTMLButtonElement>('.bind-key')) {
      btn.onclick = () => {
        this.capturing = this.capturing === btn.dataset.action ? null : (btn.dataset.action as ActionId);
        this.renderControls();
      };
      btn.onblur = () => {
        if (this.capturing === btn.dataset.action) {
          this.capturing = null;
          this.renderControls();
        }
      };
    }
    window.addEventListener('keydown', this.handleBindKey, true);
    this.renderControls();
  }

  /** While a key button waits for input, the next key press becomes that action's key (Esc cancels). */
  private handleBindKey = (e: KeyboardEvent): void => {
    const c = this.controls;
    if (!this.capturing || !c) return;
    e.preventDefault();
    e.stopPropagation();
    const action = this.capturing;
    this.capturing = null;
    if (e.code !== 'Escape' && !RESERVED_KEYS.includes(e.code) && bindKey(c, action, e.code)) this.onControlsChange?.(c);
    this.renderControls();
  };

  private renderControls(): void {
    const c = this.controls;
    if (!c) return;
    this.root.querySelector('.range-value')!.textContent = c.sensitivity.toFixed(2);
    for (const btn of this.root.querySelectorAll<HTMLButtonElement>('.bind-key')) {
      const a = btn.dataset.action as ActionId;
      const waiting = this.capturing === a;
      btn.classList.toggle('waiting', waiting);
      btn.textContent = waiting ? '키를 누르세요…' : keyLabel(c.bindings[a]);
      btn.setAttribute('aria-pressed', String(waiting));
    }
  }

  // --- Navigation -------------------------------------------------------------

  showPage(page: MenuPage): void {
    for (const tab of this.root.querySelectorAll<HTMLButtonElement>('.tab')) {
      const on = tab.dataset.page === page;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
    }
    for (const p of this.root.querySelectorAll<HTMLElement>('.page')) p.hidden = p.dataset.page !== page;
    for (const l of this.pageListeners) l(page);
  }

  onPageShown(listener: (page: MenuPage) => void): void {
    this.pageListeners.push(listener);
  }

  private bindTabs(): void {
    const tabs = [...this.root.querySelectorAll<HTMLButtonElement>('.tab')];
    tabs.forEach((tab, i) => {
      tab.addEventListener('click', () => this.showPage(tab.dataset.page as MenuPage));
      // Arrow keys move between tabs (standard tablist behaviour).
      tab.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        e.preventDefault();
        const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        this.showPage(next.dataset.page as MenuPage);
        next.focus();
      });
    });
  }

  // --- Play -------------------------------------------------------------------

  onPlay(handler: () => void): void {
    this.playButton.addEventListener('click', handler);
  }

  setMaps(maps: readonly MenuMap[], currentId: string, onChange: (id: string) => void): void {
    this.mapButtons = maps.map((m) => {
      const [code, title] = splitMapName(m.name);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'map-card';
      b.dataset.id = m.id;
      b.setAttribute('role', 'radio');
      b.innerHTML = `<span class="map-code eyebrow"></span><span class="map-name"></span>`;
      b.querySelector('.map-code')!.textContent = code;
      b.querySelector('.map-name')!.textContent = title;
      b.addEventListener('click', () => {
        if (b.getAttribute('aria-checked') === 'true') return;
        this.selectMap(m.id);
        onChange(m.id);
      });
      return b;
    });
    this.mapList.replaceChildren(...this.mapButtons);
    this.selectMap(currentId);
  }

  private selectMap(id: string): void {
    for (const b of this.mapButtons) b.setAttribute('aria-checked', String(b.dataset.id === id));
  }

  setMapsEnabled(enabled: boolean): void {
    for (const b of this.mapButtons) b.disabled = !enabled;
  }

  // --- Loadout ----------------------------------------------------------------

  setWeapons(weapons: readonly MenuWeapon[], onSelect: (slot: number) => void): void {
    const order: MenuWeapon['category'][] = ['rifle', 'sniper', 'melee'];
    const groups = order
      .map((cat) => ({ cat, items: weapons.filter((w) => w.category === cat) }))
      .filter((g) => g.items.length > 0);
    this.weaponButtons = [];
    this.weaponGroups.replaceChildren(
      ...groups.map(({ cat, items }) => {
        const group = document.createElement('div');
        group.className = 'weapon-group';
        const title = document.createElement('h2');
        title.className = 'section-title';
        title.textContent = CATEGORY_LABEL[cat];
        group.appendChild(title);
        for (const w of items) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'weapon-card';
          b.dataset.slot = String(w.slot);
          b.dataset.id = w.id;
          b.setAttribute('aria-pressed', 'false');
          b.innerHTML = `
            <span class="weapon-thumb" aria-hidden="true"></span>
            <span class="weapon-body">
              <span class="weapon-head"><span class="kbd"></span><span class="weapon-title"></span><span class="weapon-equipped">장착 중</span></span>
              <span class="weapon-stats"></span>
            </span>`;
          b.querySelector('.kbd')!.textContent = String(w.slot + 1);
          b.querySelector('.weapon-title')!.textContent = w.name;
          b.querySelector('.weapon-stats')!.replaceChildren(
            ...w.stats.map((s) => {
              const span = document.createElement('span');
              span.className = 'weapon-stat';
              span.innerHTML = '<span class="muted"></span><b></b>';
              span.children[0].textContent = s.label;
              span.children[1].textContent = s.value;
              return span;
            }),
          );
          b.addEventListener('click', () => onSelect(w.slot));
          this.weaponButtons.push(b);
          group.appendChild(b);
        }
        return group;
      }),
    );
    this.setWeaponsEnabled(this.weaponsEnabled);
  }

  setSelectedWeapon(slot: number): void {
    for (const b of this.weaponButtons) b.setAttribute('aria-pressed', String(Number(b.dataset.slot) === slot));
  }

  setWeaponsEnabled(enabled: boolean): void {
    this.weaponsEnabled = enabled;
    for (const b of this.weaponButtons) b.disabled = !enabled;
  }

  setWeaponThumbnail(id: string, url: string): void {
    for (const b of this.weaponButtons) {
      if (b.dataset.id !== id) continue;
      const thumb = b.querySelector<HTMLElement>('.weapon-thumb')!;
      thumb.style.backgroundImage = `url("${url}")`;
      thumb.classList.add('has-image');
    }
  }

  // --- Settings ---------------------------------------------------------------

  bindSelect<T extends string | number>(setting: 'quality' | 'frame-limit' | 'volume' | 'mode' | 'bots' | 'time-limit' | 'kill-target', options: readonly MenuOption<T>[], current: T, onChange: (value: T) => void): void {
    const select = this.root.querySelector<HTMLSelectElement>(`select[data-setting="${setting}"]`)!;
    select.replaceChildren(
      ...options.map((o) => {
        const opt = document.createElement('option');
        opt.value = String(o.value);
        opt.textContent = o.label;
        opt.selected = String(o.value) === String(current);
        return opt;
      }),
    );
    select.addEventListener('change', () => {
      const picked = options.find((o) => String(o.value) === select.value);
      if (picked) onChange(picked.value);
    });
  }

  bindToggle(setting: 'stats', initial: boolean, onChange: (on: boolean) => void): void {
    const input = this.root.querySelector<HTMLInputElement>(`input[data-setting="${setting}"]`)!;
    input.checked = initial;
    input.addEventListener('change', () => onChange(input.checked));
  }

  setToggle(setting: 'stats', on: boolean): void {
    this.root.querySelector<HTMLInputElement>(`input[data-setting="${setting}"]`)!.checked = on;
  }

  // --- States -----------------------------------------------------------------

  /** Loading screen. `progress` 0..1 when the size is known, null = indeterminate. */
  showLoading(mapName: string, progress: number | null, text: string): void {
    this.ready = false;
    this.playButton.disabled = true;
    this.loading.hidden = false;
    this.menu.hidden = true;
    this.root.classList.add('is-loading');
    this.loadingMap.textContent = splitMapName(mapName).join(' · ');
    this.loadingText.textContent = text;
    this.loadingProgress.classList.toggle('indeterminate', progress === null);
    if (progress === null) {
      this.loadingBar.style.transform = '';
      this.loadingPercent.textContent = '';
      this.loadingProgress.removeAttribute('aria-valuenow');
    } else {
      const pct = Math.round(Math.min(Math.max(progress, 0), 1) * 100);
      this.loadingBar.style.transform = `scaleX(${pct / 100})`;
      this.loadingPercent.textContent = `${pct}%`;
      this.loadingProgress.setAttribute('aria-valuenow', String(pct));
    }
  }

  /** Back to the menu with the Play/Resume button enabled. */
  setReady(text: string): void {
    this.ready = true;
    this.hideLoading();
    this.status.textContent = text;
    this.status.classList.remove('error');
    this.playButton.disabled = false;
  }

  setError(text: string): void {
    this.ready = false;
    this.hideLoading();
    this.status.textContent = text;
    this.status.classList.add('error');
    this.playButton.disabled = true;
  }

  /** Simple status line without changing the ready state. */
  setStatus(text: string): void {
    this.status.textContent = text;
  }

  get isReady(): boolean {
    return this.ready;
  }

  /** Shown before the first start ("플레이") and when paused ("계속하기"). */
  setVisible(visible: boolean): void {
    this.root.classList.toggle('hidden', !visible);
  }

  setPausedMode(paused: boolean): void {
    this.paused = paused;
    this.playButton.textContent = paused ? '계속하기' : '플레이';
    this.root.classList.toggle('is-paused', paused);
  }

  get isPaused(): boolean {
    return this.paused;
  }

  private hideLoading(): void {
    this.loading.hidden = true;
    this.menu.hidden = false;
    this.root.classList.remove('is-loading');
  }
}

/** "MAP 02 · 서울" → ["MAP 02", "서울"]. */
function splitMapName(name: string): [string, string] {
  const i = name.indexOf('·');
  return i < 0 ? ['', name.trim()] : [name.slice(0, i).trim(), name.slice(i + 1).trim()];
}

function controlsHtml(): string {
  const bindRows = (group: string) =>
    ACTIONS.filter((a) => a.group === group)
      .map(
        (a) => `
        <div class="bind-row">
          <span class="field-label">${a.label}${a.alt ? ` <span class="muted">(+ ${keyLabel(a.alt)})</span>` : ''}</span>
          <button type="button" class="btn bind-key" data-action="${a.id}" aria-pressed="false">${keyLabel(a.key)}</button>
        </div>`,
      )
      .join('');
  const fixed: [string, string][] = [
    ['좌클릭', '사격 / 베기'],
    ['마우스 휠', '다음 무기'],
    ['Esc', '일시정지 · 메뉴'],
    ['F4', '스폰으로 복귀'],
    ['F3', '성능 정보'],
  ];
  return `
      <h2 class="section-title">마우스</h2>
      <label class="field">
        <span class="field-label">감도</span>
        <span class="range-row">
          <input class="range" type="range" data-setting="sensitivity" min="${SENSITIVITY_MIN}" max="${SENSITIVITY_MAX}" step="0.05" value="1" />
          <output class="range-value">1.00</output>
        </span>
        <span class="field-hint">1.00이 기본값입니다. 바로 적용되고 저장됩니다.</span>
      </label>
      <h2 class="section-title">이동</h2>
      ${bindRows('이동')}
      <h2 class="section-title">전투</h2>
      ${bindRows('전투')}
      <p class="field-hint bind-hint">키 버튼을 누른 뒤 원하는 키를 누르세요. 이미 쓰는 키면 두 동작의 키가 서로 바뀝니다. Esc는 취소.</p>
      <button type="button" class="btn controls-reset">기본값으로</button>
      <h2 class="section-title">고정 키</h2>
      <dl class="keys">
        ${fixed.map(([k, v]) => `<dt><span class="kbd">${k}</span></dt><dd>${v}</dd>`).join('')}
      </dl>`;
}
