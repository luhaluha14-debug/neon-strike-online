import { ARMOR_CONFIG, GRENADE_CONFIG } from '../config';
import { catalogBySlot, formatMoney, type BuyLoadout } from '../game/Economy';
import { itemStats, type CatalogItem, type ItemCategory } from '../weapons/catalog';
import './buy.css';

/** What the menu shows each frame (it only touches the DOM when something changed). */
export interface BuyMenuState {
  /** Seconds of buy time left. */
  timeLeft: number;
  money: number;
  loadout: BuyLoadout;
  /** Current armour points (ARMOR-01). */
  armor: number;
}

export interface BuyMenuHandlers {
  onBuy(id: string): void;
  /** "출격 확정". */
  onReady(): void;
  /** "닫기" (B / Esc). */
  onClose(): void;
}

const SECTIONS: readonly { key: keyof ReturnType<typeof catalogBySlot>; title: string }[] = [
  { key: 'primary', title: '주무기' },
  { key: 'secondary', title: '보조무기' },
  { key: 'melee', title: '근접' },
  { key: 'equipment', title: '전술 장비' },
];

const CATEGORY_LABEL: Record<ItemCategory, string> = {
  rifle: '소총',
  sniper: '저격',
  smg: '기관단총',
  shotgun: '산탄총',
  pistol: '권총',
  knife: '근접',
  armor: '방호',
  grenade: '투척',
};

/** Thin line icons (24×24) for cards without a rendered weapon image. */
const ICONS: Record<ItemCategory, string> = {
  rifle: 'M2 13h13l2-2h5v2h-3l-1 2h-3l-1 3h-2l1-3H8l-2 3H4l1-3H2z',
  sniper: 'M1 12h15l1-1h6v1.5h-5l-1 1.5h-3l-1 3h-2l1-3H7l-2 2H3l1-2H1zM9 9h5v2H9z',
  smg: 'M4 11h12l1-1h4v2h-4v2h-3l-1 4h-2l1-4H7l-1 2H4z',
  shotgun: 'M1 12h17l2-1h3v2h-4l-2 1H9l-2 3H5l1-3H1z',
  pistol: 'M5 9h13v3h-6l-1 1h-2l-1 5H5l1-6H5z',
  knife: 'M3 15l11-9c2-1 5-1 7 1l-12 8zM3 15l-1 3 3-1z',
  armor: 'M7 4h3l2 2 2-2h3l3 3-2 3v9H6v-9L4 7z',
  grenade: 'M9 6h6v2h-1v1a6 6 0 1 1-4 0V8H9zM14 4h3v2h-3z',
};

/**
 * "작전 준비" buy menu of the team match: money and the balance after a
 * purchase, the buy time left, items by category (primary / secondary /
 * melee / tactical equipment) with price, stats and state (보유 중, 자금
 * 부족, 준비 중, 기본 지급), the current loadout, purchase feedback and
 * "출격 확정". Mouse-driven; Game releases the pointer lock while it is open.
 */
export class BuyMenu {
  readonly root: HTMLDivElement;
  private readonly timer: HTMLElement;
  private readonly money: HTMLElement;
  private readonly after: HTMLElement;
  private readonly loadoutEl: HTMLElement;
  private readonly feedbackEl: HTMLElement;
  private readonly cards = new Map<string, { el: HTMLButtonElement; item: CatalogItem }>();
  private hovered: CatalogItem | null = null;
  private lastKey = '';
  private lastState: BuyMenuState | null = null;

  constructor(parent: HTMLElement, handlers: BuyMenuHandlers) {
    this.root = document.createElement('div');
    this.root.className = 'buy-menu';
    this.root.hidden = true;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-labelledby', 'buy-title');
    this.root.innerHTML = `
      <div class="buy-panel">
        <header class="buy-head">
          <div class="buy-heading">
            <span class="eyebrow">작전 준비</span>
            <h2 class="buy-title" id="buy-title">장비 구매</h2>
          </div>
          <div class="buy-stat buy-time-box">
            <span class="buy-stat-label">구매 시간</span>
            <span class="buy-stat-value buy-time">0:15</span>
          </div>
          <div class="buy-stat">
            <span class="buy-stat-label">보유 자금</span>
            <span class="buy-stat-value buy-money">$0</span>
            <span class="buy-after"></span>
          </div>
        </header>
        <div class="buy-body"></div>
        <footer class="buy-foot">
          <div class="buy-loadout" aria-label="현재 장비"></div>
          <p class="buy-feedback" role="status" aria-live="polite"></p>
          <div class="buy-actions">
            <button type="button" class="btn buy-close">닫기 <span class="kbd">B</span></button>
            <button type="button" class="btn btn-primary buy-ready">출격 확정</button>
          </div>
        </footer>
      </div>`;
    parent.appendChild(this.root);
    const q = (s: string) => this.root.querySelector<HTMLElement>(s)!;
    this.timer = q('.buy-time');
    this.money = q('.buy-money');
    this.after = q('.buy-after');
    this.loadoutEl = q('.buy-loadout');
    this.feedbackEl = q('.buy-feedback');
    q('.buy-ready').addEventListener('click', () => handlers.onReady());
    q('.buy-close').addEventListener('click', () => handlers.onClose());

    const groups = catalogBySlot();
    const body = q('.buy-body');
    for (const sec of SECTIONS) {
      const section = document.createElement('section');
      section.className = 'buy-section';
      section.dataset.section = sec.key;
      section.innerHTML = `<h3 class="buy-section-title">${sec.title}</h3><div class="buy-grid"></div>`;
      const grid = section.querySelector('.buy-grid')!;
      for (const item of groups[sec.key]) {
        const el = this.card(item);
        el.addEventListener('click', () => handlers.onBuy(item.id));
        el.addEventListener('pointerenter', () => this.hover(item));
        el.addEventListener('focus', () => this.hover(item));
        el.addEventListener('pointerleave', () => this.hover(null));
        el.addEventListener('blur', () => this.hover(null));
        grid.appendChild(el);
        this.cards.set(item.id, { el, item });
      }
      body.appendChild(section);
    }
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  show(): void {
    this.root.hidden = false;
    this.lastKey = '';
  }

  hide(): void {
    this.root.hidden = true;
    this.hover(null);
  }

  /** A rendered weapon image (data URL) for the cards of that WeaponDefinition id or catalog id (preview models). */
  setThumbnail(id: string, url: string): void {
    for (const { el, item } of this.cards.values()) {
      if (item.weapon?.id !== id && item.id !== id) continue;
      const art = el.querySelector<HTMLElement>('.buy-art')!;
      art.style.backgroundImage = `url("${url}")`;
      art.classList.add('has-image');
    }
  }

  /** Result of the last purchase attempt. */
  feedback(text: string, ok: boolean): void {
    this.feedbackEl.textContent = text;
    this.feedbackEl.classList.toggle('error', !ok);
    this.feedbackEl.classList.toggle('ok', ok);
  }

  clearFeedback(): void {
    this.feedbackEl.textContent = '';
    this.feedbackEl.classList.remove('error', 'ok');
  }

  update(s: BuyMenuState): void {
    this.lastState = s;
    const t = Math.ceil(Math.max(s.timeLeft, 0));
    const lo = s.loadout;
    const key = `${t}|${s.money}|${lo.primary?.id}|${lo.secondary?.id}|${s.armor}|${this.hovered?.id}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.timer.textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    this.timer.classList.toggle('low', t <= 5);
    this.money.textContent = formatMoney(s.money);
    this.after.textContent = this.afterText(s);
    this.loadoutEl.innerHTML = [
      ['주무기', lo.primary?.id ?? '없음'],
      ['보조무기', lo.secondary?.id ?? '없음'],
      ['근접', lo.melee.id],
      [
        '전술 장비',
        [s.armor > 0 ? `ARMOR-01 ${Math.round(s.armor)}` : '', lo.grenades.flash ? `FLASH ×${lo.grenades.flash}` : '', lo.grenades.smoke ? `SMOKE ×${lo.grenades.smoke}` : '']
          .filter(Boolean)
          .join(' · ') || '없음',
      ],
    ]
      .map(([k, v]) => `<span class="bl-item"><span class="bl-k">${k}</span><span class="bl-v${v === '없음' ? ' none' : ''}">${v}</span></span>`)
      .join('');
    for (const { el, item } of this.cards.values()) {
      const armor = item.slot === 'armor';
      const owned = armor ? s.armor >= ARMOR_CONFIG.max : lo.owns(item.id);
      const free = item.price === 0;
      const short = item.available && !owned && !free && s.money + lo.refundFor(item) < item.price;
      const state = !item.available ? 'locked' : owned ? (free ? 'issued' : 'owned') : short ? 'short' : 'buyable';
      // Every card stays clickable: a refused one answers with the reason (자금 부족, 준비 중, ...).
      el.dataset.state = state;
      const tag = el.querySelector('.buy-tag')!;
      const g = item.grenade;
      tag.textContent = g
        ? state === 'locked' || state === 'short'
          ? { locked: '준비 중', short: '자금 부족' }[state]
          : `${owned ? '보유 중' : '구매'} (${lo.grenades[g]}/${GRENADE_CONFIG.maxCarry[g]})`
        : armor && state === 'buyable' && s.armor > 0
          ? `보충 (현재 ${Math.round(s.armor)})`
          : armor && owned
            ? `보유 중 (${Math.round(s.armor)})`
            : { locked: '준비 중', issued: '기본 지급', owned: '보유 중', short: '자금 부족', buyable: '구매' }[state];
    }
  }

  private hover(item: CatalogItem | null): void {
    this.hovered = item;
    if (this.lastState) this.update(this.lastState);
  }

  /** "구매 후 $300" for the hovered card, else nothing. */
  private afterText(s: BuyMenuState): string {
    const item = this.hovered;
    if (!item || !item.available || item.price === 0 || s.loadout.owns(item.id)) return '';
    if (item.slot === 'armor' && s.armor >= ARMOR_CONFIG.max) return '';
    const after = s.money + s.loadout.refundFor(item) - item.price;
    return after < 0 ? `${formatMoney(-after)} 부족` : `구매 후 ${formatMoney(after)}`;
  }

  private card(item: CatalogItem): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'buy-card';
    b.dataset.id = item.id;
    const stats = itemStats(item);
    const spec = stats
      ? [
          stats.magazineSize > 0 ? `${stats.magazineSize} / ${stats.reserveAmmo}발` : null,
          stats.fireMode === 'auto' && item.category !== 'knife' ? '자동' : item.category === 'knife' ? null : '반자동',
          stats.fireRate && item.category !== 'knife' ? `${stats.fireRate} RPM` : null,
          stats.damage ? `피해 ${stats.damage}` : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : '';
    b.innerHTML = `
      <span class="buy-art" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="${ICONS[item.category]}"/></svg></span>
      <span class="buy-code"></span>
      <span class="buy-name"></span>
      <span class="buy-spec"></span>
      <span class="buy-price"></span>
      <span class="buy-tag"></span>`;
    b.querySelector('.buy-code')!.textContent = item.id;
    const cat = CATEGORY_LABEL[item.category];
    b.querySelector('.buy-name')!.textContent = item.name.startsWith(cat) ? item.name : `${item.name} · ${cat}`;
    b.querySelector('.buy-spec')!.textContent = item.available ? spec : `${item.lockedReason ?? '준비 중'}${spec ? ` (예정: ${spec})` : ''}`;
    b.querySelector('.buy-price')!.textContent = item.price === 0 ? '무료' : formatMoney(item.price);
    return b;
  }
}
