import { AccountView } from '../economy/EconomyAuthority';
import type { EconomyBackend } from '../economy/EconomyBackend';
import type { EconomyResult } from '../economy/EconomyAuthority';
import { DAILY_MISSIONS, MATCH_REWARDS } from '../economy/EconomyRules';
import { LoadoutService } from '../economy/LoadoutService';
import { ShopService } from '../economy/ShopService';
import { allSlots, defaultSkin, findSkin, SKIN_CATALOG, slotKey, TARGET_NAME } from '../economy/SkinCatalog';
import type { AccountState, EconomyError, SkinCategory, SkinDef } from '../economy/types';
import type { MainMenu } from './MainMenu';
import './grid.css';

const CATEGORY_LABEL: Record<SkinCategory, string> = { weapon: '총기', character: '캐릭터', knife: '칼', gloves: '장갑' };
const CATEGORY_ORDER: readonly SkinCategory[] = ['weapon', 'character', 'knife', 'gloves'];
const RARITY_LABEL: Record<SkinDef['rarity'], string> = { standard: '기본', common: '일반', uncommon: '고급', rare: '희귀', epic: '영웅' };
const TX_LABEL: Record<string, string> = { purchase: '구매', match_reward: '경기 보상', mission_reward: '미션 보상', grant: '지급' };

export interface GridStoreDeps {
  backend: EconomyBackend;
  /** Renders previews of these skins (async, in the background); calls back per image. */
  requestPreviews(skins: readonly SkinDef[], onPreview: (skinId: string, url: string) => void): void;
}

/** Korean message for an economy refusal. */
export function errorMessage(error: EconomyError, ctx: { price?: number; credits?: number } = {}): string {
  switch (error) {
    case 'unknown_item':
      return '존재하지 않는 상품입니다.';
    case 'not_for_sale':
      return '판매하지 않는 상품입니다.';
    case 'owned':
      return '이미 보유한 스킨입니다.';
    case 'insufficient_funds':
      return ctx.price !== undefined && ctx.credits !== undefined ? `크레딧이 부족합니다 (부족 ${formatCr(ctx.price - ctx.credits)}).` : '크레딧이 부족합니다.';
    case 'invalid_request':
      return '잘못된 요청입니다.';
    case 'not_owned':
      return '보유하지 않은 스킨입니다.';
    case 'incompatible':
      return '이 슬롯에 장착할 수 없는 스킨입니다.';
    case 'not_completed':
      return '아직 완료하지 않은 미션입니다.';
    case 'already_claimed':
      return '이미 받은 보상입니다.';
    case 'storage_error':
      return '저장하지 못했습니다. 아무것도 바뀌지 않았습니다. 잠시 후 다시 시도하세요.';
    case 'conflict':
      return '다른 창에서 계정이 바뀌었습니다. 아무것도 바뀌지 않았습니다. 새로고침 후 다시 시도하세요.';
    case 'unauthenticated':
      return '로그인이 필요합니다.';
    case 'network':
      return '서버에 연결하지 못했습니다. 아무것도 바뀌지 않았습니다.';
    case 'unverified':
      return '서버가 확인하지 않은 경기 결과는 반영되지 않습니다.';
    case 'suspended':
      return '정지된 계정입니다.';
  }
}

export function formatCr(n: number): string {
  return `${Math.round(n).toLocaleString('en-US')} CR`;
}

/**
 * GRID shop, inventory (보관함) and daily missions pages of the main menu.
 * Pure view over an EconomyBackend: it sends requests (skin id, slot,
 * mission id) and shows the account the backend answers with; it never
 * computes a balance or a price itself.
 */
export class GridStore {
  private account: AccountState | null = null;
  private shopCategory: SkinCategory = 'weapon';
  private invCategory: SkinCategory = 'weapon';
  private search = '';
  private readonly previews = new Map<string, string>();
  private previewsRequested = false;
  private busy = false;
  private readonly shop: HTMLElement;
  private readonly inventory: HTMLElement;
  private readonly missions: HTMLElement;
  private readonly dialog: HTMLElement;
  private dialogSkin: SkinDef | null = null;
  /**
   * Buttons of a result step (done / failed) ignore clicks until this time:
   * the second click of a double click on "구매 확인" must not land on
   * whatever button the result put in its place.
   */
  private armedAt = 0;

  constructor(
    private readonly menu: MainMenu,
    private readonly deps: GridStoreDeps,
  ) {
    this.shop = menu.pageElement('shop');
    this.inventory = menu.pageElement('inventory');
    this.missions = menu.pageElement('missions');
    this.shop.innerHTML = `
      <div class="grid-head">
        <div class="grid-credits">GRID 크레딧 <b class="grid-balance">—</b></div>
        <div class="grid-chips" role="group" aria-label="상점 카테고리">${chips('shop')}</div>
        <input class="grid-search" type="search" placeholder="스킨 이름 검색" aria-label="스킨 이름 검색" />
      </div>
      <div class="grid-cards shop-cards" role="list"></div>
      <p class="grid-note shop-note" aria-live="polite"></p>`;
    this.inventory.innerHTML = `
      <div class="grid-head">
        <div class="grid-credits">GRID 크레딧 <b class="grid-balance">—</b></div>
        <div class="grid-chips" role="group" aria-label="보관함 카테고리">${chips('inv')}</div>
      </div>
      <div class="grid-slots"></div>
      <p class="grid-note inv-note" aria-live="polite"></p>`;
    this.missions.innerHTML = `
      <div class="grid-head">
        <div class="grid-credits">GRID 크레딧 <b class="grid-balance">—</b></div>
      </div>
      <h2 class="section-title">일일 미션 <span class="grid-day muted"></span></h2>
      <ol class="grid-missions"></ol>
      <p class="grid-note mission-note" aria-live="polite"></p>
      <p class="field-hint">${rewardPolicy()}</p>
      <h2 class="section-title">최근 크레딧 내역</h2>
      <table class="grid-ledger"><thead><tr><th>내역</th><th>대상</th><th>변동</th><th>잔액</th></tr></thead><tbody></tbody></table>`;
    this.dialog = document.createElement('div');
    this.dialog.className = 'grid-dialog';
    this.dialog.hidden = true;
    this.dialog.setAttribute('role', 'dialog');
    this.dialog.setAttribute('aria-modal', 'true');
    menu.root.appendChild(this.dialog);

    this.shop.querySelector('.grid-chips')!.addEventListener('click', (e) => {
      const c = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-cat]');
      if (!c) return;
      this.shopCategory = c.dataset.cat as SkinCategory;
      this.renderShop();
    });
    this.inventory.querySelector('.grid-chips')!.addEventListener('click', (e) => {
      const c = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-cat]');
      if (!c) return;
      this.invCategory = c.dataset.cat as SkinCategory;
      this.renderInventory();
    });
    this.shop.querySelector<HTMLInputElement>('.grid-search')!.addEventListener('input', (e) => {
      this.search = (e.target as HTMLInputElement).value.trim().toLowerCase();
      this.renderShop();
    });
    this.shop.querySelector('.shop-cards')!.addEventListener('click', (e) => {
      const card = (e.target as HTMLElement).closest<HTMLElement>('[data-skin]');
      if (card) this.openDialog(card.dataset.skin!);
    });
    this.inventory.querySelector('.grid-slots')!.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
      if (btn && !btn.disabled) void this.equip(btn.dataset.cat as SkinCategory, btn.dataset.target!, btn.dataset.item || null);
    });
    this.missions.querySelector('.grid-missions')!.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-mission]');
      if (btn && !btn.disabled) void this.claim(btn.dataset.mission!, btn);
    });
    this.dialog.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') {
        e.stopPropagation();
        this.closeDialog();
      }
    });
    menu.onPageShown((page) => {
      if (page === 'shop' || page === 'inventory' || page === 'missions') {
        void this.deps.backend
          .getAccount()
          .then((a) => this.update(a))
          .catch(() => undefined); // server unreachable: the last shown account stays, requests report the error
        this.ensurePreviews();
      }
    });
  }

  /** Shows `account` everywhere (after any change, from the backend). */
  update(account: AccountState): void {
    this.account = account;
    for (const b of this.menu.root.querySelectorAll('.grid-balance')) b.textContent = formatCr(account.credits);
    this.renderShop();
    this.renderInventory();
    this.renderMissions();
    if (this.dialogSkin && !this.busy) this.renderDialog(this.dialogSkin, 'view');
  }

  /** Previews are rendered once, when a GRID page is first opened (never during play). */
  private ensurePreviews(): void {
    if (this.previewsRequested) return;
    this.previewsRequested = true;
    this.deps.requestPreviews(SKIN_CATALOG, (skinId, url) => {
      this.previews.set(skinId, url);
      for (const img of this.menu.root.querySelectorAll<HTMLElement>(`[data-art="${CSS.escape(skinId)}"]`)) setArt(img, url);
    });
  }

  // --- Shop ----------------------------------------------------------------------

  private renderShop(): void {
    const a = this.account;
    const list = this.shop.querySelector('.shop-cards')!;
    for (const c of this.shop.querySelectorAll<HTMLButtonElement>('[data-cat]')) c.setAttribute('aria-pressed', String(c.dataset.cat === this.shopCategory));
    if (!a) return;
    const items = ShopService.listings().filter(
      (s) => s.category === this.shopCategory && (!this.search || `${s.name} ${TARGET_NAME[s.targets[0]] ?? ''}`.toLowerCase().includes(this.search)),
    );
    list.innerHTML = items.length
      ? items
          .map((s) => {
            const owned = AccountView.owns(a, s.skinId);
            const short = !owned && a.credits < s.price;
            return `<button type="button" class="grid-card ${owned ? 'owned' : short ? 'short' : ''}" role="listitem" data-skin="${s.skinId}">
              ${art(s, this.previews.get(s.skinId))}
              <span class="gc-name">${s.name}</span>
              <span class="gc-target">${TARGET_NAME[s.targets[0]] ?? ''}</span>
              <span class="gc-row"><span class="gc-rarity r-${s.rarity}">${RARITY_LABEL[s.rarity]}</span><span class="gc-price">${owned ? '보유 중' : formatCr(s.price)}</span></span>
            </button>`;
          })
          .join('')
      : '<p class="muted">조건에 맞는 상품이 없습니다.</p>';
  }

  private openDialog(skinId: string): void {
    const s = findSkin(skinId);
    if (!s) return;
    this.dialogSkin = s;
    this.dialog.hidden = false;
    this.renderDialog(s, 'view');
    this.dialog.querySelector<HTMLButtonElement>('.gd-primary, .gd-close')?.focus();
  }

  private closeDialog(): void {
    if (this.busy) return;
    this.dialog.hidden = true;
    this.dialogSkin = null;
  }

  /** view → confirm → pending → done / failed. */
  private renderDialog(s: SkinDef, step: 'view' | 'confirm' | 'pending' | 'done' | 'failed', message = ''): void {
    const a = this.account;
    if (!a) return;
    const owned = AccountView.owns(a, s.skinId);
    const after = a.credits - s.price;
    const head = `
      <div class="gd-panel">
        <div class="gd-art">${art(s, this.previews.get(s.skinId), true)}</div>
        <div class="gd-info">
          <div class="eyebrow">${CATEGORY_LABEL[s.category]} · ${TARGET_NAME[s.targets[0]] ?? ''}</div>
          <h3 class="gd-name">${s.name}</h3>
          <p class="gd-desc">${s.description}</p>
          <div class="gd-rarity gc-rarity r-${s.rarity}">${RARITY_LABEL[s.rarity]}</div>
          <dl class="gd-numbers">
            <div><dt>가격</dt><dd class="gd-price">${formatCr(s.price)}</dd></div>
            <div><dt>보유 크레딧</dt><dd class="gd-balance">${formatCr(a.credits)}</dd></div>
            ${owned ? '' : `<div><dt>구매 후</dt><dd class="gd-after ${after < 0 ? 'neg' : ''}">${after < 0 ? `${formatCr(-after)} 부족` : formatCr(after)}</dd></div>`}
          </dl>`;
    let actions = '';
    let note = message;
    if (step === 'view') {
      if (owned) {
        note ||= '이미 보유한 스킨입니다. 보관함에서 장착할 수 있습니다.';
        actions = `<button type="button" class="btn gd-close">닫기</button><button type="button" class="btn btn-primary gd-go-inv">보관함에서 장착</button>`;
      } else {
        if (after < 0) note ||= errorMessage('insufficient_funds', { price: s.price, credits: a.credits });
        actions = `<button type="button" class="btn gd-close">닫기</button><button type="button" class="btn btn-primary gd-primary" ${after < 0 ? 'disabled' : ''}>구매</button>`;
      }
    } else if (step === 'confirm') {
      note = `${formatCr(s.price)}를 사용해 「${s.name}」을(를) 구매합니다.`;
      actions = `<button type="button" class="btn gd-back">취소</button><button type="button" class="btn btn-primary gd-confirm">구매 확인</button>`;
    } else if (step === 'pending') {
      note = '처리 중…';
      actions = `<button type="button" class="btn" disabled>취소</button><button type="button" class="btn btn-primary" disabled>처리 중…</button>`;
    } else if (step === 'done') {
      actions = `<button type="button" class="btn gd-close">닫기</button><button type="button" class="btn btn-primary gd-go-inv">보관함에서 장착</button>`;
    } else {
      actions = `<button type="button" class="btn gd-close">닫기</button>`;
    }
    this.dialog.className = `grid-dialog step-${step}`;
    this.armedAt = step === 'done' || step === 'failed' ? performance.now() + 350 : 0;
    this.dialog.innerHTML = `${head}
          <p class="gd-note ${step === 'failed' ? 'error' : step === 'done' ? 'ok' : ''}" aria-live="polite">${note}</p>
          <div class="gd-actions">${actions}</div>
        </div>
      </div>`;
    const on = (sel: string, fn: () => void) =>
      this.dialog.querySelector(sel)?.addEventListener('click', () => {
        if (performance.now() >= this.armedAt) fn();
      });
    on('.gd-close', () => this.closeDialog());
    on('.gd-primary', () => this.renderDialog(s, 'confirm'));
    on('.gd-back', () => this.renderDialog(s, 'view'));
    on('.gd-confirm', () => void this.buy(s));
    on('.gd-go-inv', () => {
      this.closeDialog();
      this.invCategory = s.category;
      this.renderInventory();
      this.menu.showPage('inventory');
    });
  }

  private async buy(s: SkinDef): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.renderDialog(s, 'pending');
    let r: EconomyResult;
    try {
      r = await this.deps.backend.purchase(s.skinId);
    } catch {
      r = { ok: false, error: 'storage_error', account: this.account! };
    }
    this.busy = false;
    if (r.ok) {
      this.update(r.account);
      this.renderDialog(s, 'done', `구매 완료 — 보관함에 추가되었습니다. 남은 크레딧 ${formatCr(r.account.credits)}.`);
    } else {
      if (r.account) this.update(r.account);
      this.renderDialog(s, 'failed', errorMessage(r.error, { price: s.price, credits: r.account?.credits ?? this.account?.credits }));
    }
    this.dialog.querySelector<HTMLButtonElement>('.gd-actions .btn:not([disabled])')?.focus();
  }

  // --- Inventory ---------------------------------------------------------------

  private renderInventory(): void {
    const a = this.account;
    for (const c of this.inventory.querySelectorAll<HTMLButtonElement>('[data-cat]')) c.setAttribute('aria-pressed', String(c.dataset.cat === this.invCategory));
    if (!a) return;
    const slots = allSlots().filter((k) => k.startsWith(this.invCategory + ':'));
    this.inventory.querySelector('.grid-slots')!.innerHTML = slots
      .map((key) => {
        const [cat, target] = key.split(':') as [SkinCategory, string];
        const equipped = LoadoutService.equipped(a, cat, target);
        const def = defaultSkin(cat, target)!;
        const owned = a.items.filter((i) => findSkin(i.skinId)?.category === cat && findSkin(i.skinId)?.targets.includes(target));
        const cards = [{ skin: def, itemId: '' }, ...owned.map((i) => ({ skin: findSkin(i.skinId)!, itemId: i.itemId }))]
          .map(({ skin, itemId }) => {
            const on = equipped?.skinId === skin.skinId;
            return `<div class="grid-card inv-card ${on ? 'equipped' : ''}" data-slot="${key}" data-skin="${skin.skinId}">
              ${art(skin, this.previews.get(skin.skinId))}
              <span class="gc-name">${skin.name}</span>
              <span class="gc-row"><span class="gc-rarity r-${skin.rarity}">${RARITY_LABEL[skin.rarity]}</span><span class="gc-state">${on ? '장착 중' : ''}</span></span>
              <button type="button" class="btn gc-equip" data-act="equip" data-cat="${cat}" data-target="${target}" data-item="${itemId}" ${on ? 'disabled' : ''}>${on ? '장착 중' : itemId ? '장착' : '기본으로 복원'}</button>
            </div>`;
          })
          .join('');
        return `<section class="grid-slot" data-slot="${key}">
          <h3 class="grid-slot-title">${TARGET_NAME[target] ?? target} <span class="muted">· ${equipped?.isDefault ? '기본 외형' : equipped?.name ?? ''}</span></h3>
          <div class="grid-cards">${cards}</div>
        </section>`;
      })
      .join('');
    const count = a.items.length;
    this.inventory.querySelector('.inv-note')!.textContent = count ? `보유 스킨 ${count}개 · 장착은 바로 저장되어 다음 접속에도 유지됩니다.` : '아직 보유한 스킨이 없습니다. 상점에서 구매하거나 경기·미션으로 크레딧을 모으세요.';
  }

  private async equip(category: SkinCategory, target: string, itemId: string | null): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    for (const b of this.inventory.querySelectorAll<HTMLButtonElement>('.gc-equip')) b.disabled = true;
    const r = await this.deps.backend.equip(category, target, itemId);
    this.busy = false;
    this.update(r.account);
    const note = this.inventory.querySelector('.inv-note')!;
    note.textContent = r.ok ? `${TARGET_NAME[target] ?? target}: ${LoadoutService.equipped(r.account, category, target)?.name ?? ''} 장착` : errorMessage(r.error);
    note.classList.toggle('error', !r.ok);
  }

  // --- Missions ----------------------------------------------------------------

  private renderMissions(): void {
    const a = this.account;
    if (!a) return;
    this.missions.querySelector('.grid-day')!.textContent = `${a.missions.day} (${this.deps.backend.kind === 'remote' ? '서버 날짜 기준' : '기기 날짜 기준'})`;
    this.missions.querySelector('.grid-missions')!.innerHTML = DAILY_MISSIONS.map((m) => {
      const p = a.missions.missions[m.missionId] ?? { progress: 0, completed: false, claimed: false };
      const state = p.claimed ? '수령함' : p.completed ? '완료' : '진행 중';
      return `<li class="grid-mission ${p.claimed ? 'claimed' : p.completed ? 'done' : ''}" data-mission-row="${m.missionId}">
        <div class="gm-top"><span class="gm-title">${m.title}</span><span class="gm-reward">${formatCr(m.reward)}</span></div>
        <div class="gm-track" role="progressbar" aria-valuemin="0" aria-valuemax="${m.target}" aria-valuenow="${p.progress}"><div class="gm-bar" style="transform:scaleX(${Math.min(p.progress / m.target, 1)})"></div></div>
        <div class="gm-bottom"><span class="gm-progress">${p.progress} / ${m.target}</span><span class="gm-state">${state}</span>
          <button type="button" class="btn gm-claim" data-mission="${m.missionId}" ${p.completed && !p.claimed ? '' : 'disabled'}>${p.claimed ? '수령 완료' : '보상 받기'}</button></div>
      </li>`;
    }).join('');
    const rows = [...a.ledger].reverse().slice(0, 8);
    this.missions.querySelector('.grid-ledger tbody')!.innerHTML = rows
      .map((t) => `<tr><td>${TX_LABEL[t.kind] ?? t.kind}</td><td>${refName(t.ref)}</td><td class="${t.amount < 0 ? 'neg' : 'pos'}">${t.amount > 0 ? '+' : ''}${t.amount.toLocaleString('en-US')}</td><td>${t.balanceAfter.toLocaleString('en-US')}</td></tr>`)
      .join('');
  }

  private async claim(missionId: string, btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    const r = await this.deps.backend.claimMission(missionId);
    this.update(r.account);
    const note = this.missions.querySelector('.mission-note')!;
    const def = DAILY_MISSIONS.find((m) => m.missionId === missionId);
    note.textContent = r.ok ? `보상 지급: ${formatCr(def?.reward ?? 0)}` : errorMessage(r.error);
    note.classList.toggle('error', !r.ok);
  }
}

function chips(prefix: string): string {
  return CATEGORY_ORDER.map((c) => `<button type="button" class="grid-chip" data-cat="${c}" id="${prefix}-cat-${c}" aria-pressed="false">${CATEGORY_LABEL[c]}</button>`).join('');
}

/** Card art: the rendered preview when there is one, colour swatches until then. */
function art(s: SkinDef, url: string | undefined, large = false): string {
  const swatches = s.preview.map((c) => `<i style="background:#${c.toString(16).padStart(6, '0')}"></i>`).join('');
  return `<span class="gc-art ${large ? 'large' : ''} ${url ? 'has-image' : ''}" data-art="${s.skinId}" ${url ? `style="background-image:url(${url})"` : ''}><span class="gc-swatches">${swatches}</span></span>`;
}

function setArt(el: HTMLElement, url: string): void {
  el.style.backgroundImage = `url(${url})`;
  el.classList.add('has-image');
}

function refName(ref: string): string {
  return findSkin(ref)?.name ?? DAILY_MISSIONS.find((m) => m.missionId === ref)?.title ?? (ref === 'starting_credits' ? '시작 크레딧' : ref.split('-')[0] === 'team' ? '팀전' : ref.split('-')[0] === 'deathmatch' ? '데스매치' : ref);
}

function rewardPolicy(): string {
  const t = MATCH_REWARDS.team;
  const d = MATCH_REWARDS.deathmatch;
  return (
    `경기 보상: 팀전 완료 ${t.completed} CR(승리 +${t.win}, 처치당 +${t.perKill}, 최대 +${t.maxKillBonus}), ` +
    `데스매치 완료 ${d.completed} CR(1위 +${d.win}, 처치당 +${d.perKill}, 최대 +${d.maxKillBonus}). ` +
    `훈련장·대결 포기·중도 이탈과 ${t.minDurationSeconds}초 미만 경기는 보상과 미션 진행이 없습니다. 미션은 매일 기기 날짜 기준으로 초기화됩니다.`
  );
}

export { slotKey };
