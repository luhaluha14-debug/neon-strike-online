// Team match round economy (GRID rules) and the player's buy loadout.
// Pure logic: no rendering, no weapon system. TeamMatch owns a TeamEconomy
// and calls it when a kill is credited and when a round is decided; Game
// applies a BuyLoadout to the player's WeaponSystem.

import type { GrenadeKind } from '../combat/Grenades';
import { ARMOR_CONFIG, GRENADE_CONFIG } from '../config';
import { CATALOG, DEFAULT_MELEE_ID, findItem, type CatalogItem, type ItemSlot } from '../weapons/catalog';

export interface EconomyConfig {
  /** Money everyone starts the match with. */
  startMoney: number;
  /** Nobody can hold more than this. */
  maxMoney: number;
  /** Every member of the team that won the round. */
  winReward: number;
  /**
   * Every member of the team that lost: lossBase for the first loss in a row,
   * + lossStep per further consecutive loss, never above lossMax.
   */
  lossBase: number;
  lossStep: number;
  lossMax: number;
  /** Both teams on a drawn round (the loss streaks stay as they are). */
  drawReward: number;
  /** Per enemy killed (teammates and suicides pay nothing). */
  killBonus: number;
  /** Seconds of the buy phase before every round. */
  buyTime: number;
}

export const ECONOMY: EconomyConfig = {
  startMoney: 3000,
  maxMoney: 16000,
  winReward: 3000,
  lossBase: 1900,
  lossStep: 500,
  lossMax: 3400,
  drawReward: 1900,
  killBonus: 200,
  buyTime: 15,
};

/** Loss reward after `streak` consecutive losses (1 = this is the first). */
export function lossReward(cfg: EconomyConfig, streak: number): number {
  return Math.min(cfg.lossBase + cfg.lossStep * Math.max(streak - 1, 0), cfg.lossMax);
}

export type PayoutReason = 'win' | 'loss' | 'draw';

export interface Payout {
  round: number;
  reason: PayoutReason;
  /** What the round result was worth (before the max-money cap). */
  amount: number;
  /** Loss streak used for a loss payout. */
  streak: number;
}

/** A decided round as TeamMatch reports it. */
export interface SettledRound {
  round: number;
  winner: string | null;
}

/**
 * Wallets of every combatant and the loss streak of every team. Round
 * results and kill bonuses are paid exactly once: a round number that was
 * already settled, or a victim already paid for in that round, is ignored.
 * Money is always kept within 0..maxMoney.
 */
export interface EconomyState {
  wallets: [string, number][];
  lossStreak: [string, number][];
  lastPayout: [string, Payout][];
}

export class TeamEconomy {
  private readonly wallets = new Map<string, number>();
  private readonly teamOf = new Map<string, string>();
  /** Consecutive round losses per team (0 after a win; unchanged by a draw). */
  readonly lossStreak = new Map<string, number>();
  private readonly settled = new Set<number>();
  private readonly paidKills = new Set<string>();
  /** Last round payout per combatant (HUD). */
  readonly lastPayout = new Map<string, Payout>();

  constructor(
    readonly config: EconomyConfig,
    members: readonly { id: string; team: string }[],
  ) {
    for (const m of members) {
      this.wallets.set(m.id, config.startMoney);
      this.teamOf.set(m.id, m.team);
      this.lossStreak.set(m.team, 0);
    }
  }

  money(id: string): number {
    return this.wallets.get(id) ?? 0;
  }

  /** Takes `amount` if the wallet holds it; false (and nothing changes) otherwise. */
  spend(id: string, amount: number): boolean {
    const have = this.wallets.get(id);
    if (have === undefined || amount < 0 || have < amount) return false;
    this.wallets.set(id, have - amount);
    return true;
  }

  /**
   * Applies a purchase net of a refund in one step (no intermediate cap):
   * fails, changing nothing, if the result would be below 0.
   */
  pay(id: string, price: number, refund: number): boolean {
    const have = this.wallets.get(id);
    if (have === undefined || price < 0 || refund < 0) return false;
    const next = have + refund - price;
    if (next < 0) return false;
    this.wallets.set(id, Math.min(next, this.config.maxMoney));
    return true;
  }

  /** Adds money (reward), capped at maxMoney. Returns what was actually added. */
  credit(id: string, amount: number): number {
    const have = this.wallets.get(id);
    if (have === undefined || amount <= 0) return 0;
    const next = Math.min(have + amount, this.config.maxMoney);
    this.wallets.set(id, next);
    return next - have;
  }

  /** A credited kill (TeamMatch has already ruled out teammates and suicides). Paid once per victim per round. */
  onKill(round: number, killer: string, victim: string): boolean {
    const key = `${round}:${victim}`;
    if (this.paidKills.has(key)) return false;
    const kt = this.teamOf.get(killer);
    if (!kt || killer === victim || kt === this.teamOf.get(victim)) return false;
    this.paidKills.add(key);
    this.credit(killer, this.config.killBonus);
    return true;
  }

  /** Round result payout; a round is settled at most once. */
  settle(r: SettledRound): boolean {
    if (this.settled.has(r.round)) return false;
    this.settled.add(r.round);
    const cfg = this.config;
    // Streaks first, then pay every member of each team.
    const pay = new Map<string, Payout>();
    for (const team of this.lossStreak.keys()) {
      if (r.winner === null) {
        pay.set(team, { round: r.round, reason: 'draw', amount: cfg.drawReward, streak: this.lossStreak.get(team)! });
      } else if (team === r.winner) {
        this.lossStreak.set(team, 0);
        pay.set(team, { round: r.round, reason: 'win', amount: cfg.winReward, streak: 0 });
      } else {
        const streak = this.lossStreak.get(team)! + 1;
        this.lossStreak.set(team, streak);
        pay.set(team, { round: r.round, reason: 'loss', amount: lossReward(cfg, streak), streak });
      }
    }
    for (const [id, team] of this.teamOf) {
      const p = pay.get(team)!;
      this.credit(id, p.amount);
      this.lastPayout.set(id, p);
    }
    return true;
  }

  /** Half time: every wallet back to the starting money, loss streaks cleared (rounds already paid stay paid). */
  resetMoney(): void {
    for (const id of this.wallets.keys()) this.wallets.set(id, this.config.startMoney);
    for (const t of this.lossStreak.keys()) this.lossStreak.set(t, 0);
  }

  /** Wallets, loss streaks and last payouts (multiplayer: the host's economy shown on the other players' screens). */
  exportState(): EconomyState {
    return { wallets: [...this.wallets], lossStreak: [...this.lossStreak], lastPayout: [...this.lastPayout] };
  }

  /** Shows `s` (multiplayer client); `rename` maps the host's ids to this game's. */
  importState(s: EconomyState, rename: (id: string) => string = (id) => id): void {
    this.wallets.clear();
    for (const [id, v] of s.wallets) this.wallets.set(rename(id), v);
    for (const [t, v] of s.lossStreak) this.lossStreak.set(t, v);
    this.lastPayout.clear();
    for (const [id, p] of s.lastPayout) this.lastPayout.set(rename(id), p);
  }

  isSettled(round: number): boolean {
    return this.settled.has(round);
  }
}

export type BuyFailure = 'phase' | 'unknown' | 'locked' | 'owned' | 'funds';

export interface BuyResult {
  ok: boolean;
  item: CatalogItem | null;
  /** Failure code (ok = false). */
  reason?: BuyFailure;
  /** Korean message for the menu. */
  message: string;
  /** Money spent (net of a refunded replaced item). */
  spent: number;
  /** Item that was replaced (refunded if it was bought in this buy phase). */
  replaced?: CatalogItem;
  /** ARMOR-01 bought: the armour value to give the buyer. */
  armor?: number;
}

/** What the buyer has right now that the loadout does not track itself. */
export interface BuyContext {
  /** Current armour points. */
  armor: number;
}

/**
 * What happens to the player's gear between rounds (the one place these
 * rules live). Money always carries over (TeamEconomy); gear does only for
 * someone still alive when the round ends, and never across the side swap
 * or into a new match.
 */
export const LOADOUT_RULES = {
  /**
   * Gear a survivor keeps into the next round (weapons keep their magazine
   * and reserve as they are; the vest keeps the armour points it has left).
   */
  keepOnSurvive: { primary: true, secondary: true, armor: true, utility: true },
  /** Issued for free to everyone every round (a survivor already has it). */
  defaultIssue: [DEFAULT_MELEE_ID],
} as const;

/**
 * The player's equipment. The knife is always issued for free; one primary
 * and one secondary at most.
 *
 * Rules:
 * - Buying an item you already hold is refused (it is still yours, ammo and
 *   all; buying it again would only charge twice).
 * - Buying another item for an occupied slot replaces it. If the replaced
 *   item was bought in this same buy phase (never used) its price is
 *   refunded first, so only the difference is needed; gear carried over
 *   from an earlier round is simply discarded, no refund.
 * - Not enough money (after that refund): refused, nothing changes.
 * - Locked catalog items cannot be bought.
 * - Between rounds: carryOver() per LOADOUT_RULES (survivor keeps, otherwise
 *   back to the default issue); reset() for a new match / side swap.
 */
export class BuyLoadout {
  primary: CatalogItem | null = null;
  secondary: CatalogItem | null = null;
  readonly melee: CatalogItem;
  /** Grenades carried (thrown ones are taken off with useGrenade). */
  readonly grenades: Record<GrenadeKind, number> = { flash: 0, smoke: 0 };
  /** Items bought in the current buy phase (refundable when replaced). */
  private readonly boughtThisRound = new Set<string>();

  constructor() {
    this.melee = findItem(DEFAULT_MELEE_ID)!;
  }

  /** Back to the default issue (knife only). */
  reset(): void {
    this.primary = null;
    this.secondary = null;
    this.grenades.flash = 0;
    this.grenades.smoke = 0;
    this.boughtThisRound.clear();
  }

  /**
   * Multiplayer client: the gear the host holds for this player (catalog
   * ids of its weapons, grenade counts). Buying itself happens on the host.
   */
  restore(ids: readonly string[], grenades: Record<GrenadeKind, number> | null): void {
    const items = ids.map((id) => findItem(id)).filter((i): i is CatalogItem => !!i);
    this.primary = items.find((i) => i.slot === 'primary') ?? null;
    this.secondary = items.find((i) => i.slot === 'secondary') ?? null;
    if (grenades) {
      this.grenades.flash = Math.max(0, grenades.flash | 0);
      this.grenades.smoke = Math.max(0, grenades.smoke | 0);
    }
  }

  /** Takes one grenade of `kind` off the belt (thrown). False if none is left. */
  useGrenade(kind: GrenadeKind): boolean {
    if (this.grenades[kind] <= 0) return false;
    this.grenades[kind]--;
    return true;
  }

  /**
   * Round over: a survivor keeps what LOADOUT_RULES says; anyone else starts
   * from the default issue. Nothing is charged or refunded here. Returns
   * whether gear was kept.
   */
  carryOver(survived: boolean): boolean {
    this.boughtThisRound.clear();
    if (!survived) {
      this.reset();
      return false;
    }
    if (!LOADOUT_RULES.keepOnSurvive.primary) this.primary = null;
    if (!LOADOUT_RULES.keepOnSurvive.secondary) this.secondary = null;
    if (!LOADOUT_RULES.keepOnSurvive.utility) this.grenades.flash = this.grenades.smoke = 0;
    return true;
  }

  /** Was `id` bought in the current buy phase? */
  boughtNow(id: string): boolean {
    return this.boughtThisRound.has(id);
  }

  /** What buying `item` would refund: the price of the weapon it replaces, if that was bought in this buy phase. */
  refundFor(item: CatalogItem): number {
    if (item.slot !== 'primary' && item.slot !== 'secondary') return 0;
    const replaced = this.held(item.slot);
    return replaced && replaced.id !== item.id && this.boughtThisRound.has(replaced.id) ? replaced.price : 0;
  }

  held(slot: ItemSlot): CatalogItem | null {
    return slot === 'primary' ? this.primary : slot === 'secondary' ? this.secondary : slot === 'melee' ? this.melee : null;
  }

  owns(id: string): boolean {
    const g = findItem(id)?.grenade;
    if (g) return this.grenades[g] >= GRENADE_CONFIG.maxCarry[g];
    return this.primary?.id === id || this.secondary?.id === id || this.melee.id === id;
  }

  /** Buys `id` for `buyer` from `economy`. Atomic: on failure neither money nor gear changes. */
  buy(id: string, economy: TeamEconomy, buyer: string, ctx: BuyContext = { armor: 0 }): BuyResult {
    const item = findItem(id) ?? null;
    const fail = (reason: BuyFailure, message: string): BuyResult => ({ ok: false, item, reason, message, spent: 0 });
    if (!item) return fail('unknown', '알 수 없는 장비입니다');
    if (!item.available) return fail('locked', `${item.id}: ${item.lockedReason ?? '준비 중'}`);
    // ARMOR-01: a full vest is "owned"; a worn one can be topped up to full for the full price.
    if (item.slot === 'armor') {
      if (ctx.armor >= ARMOR_CONFIG.max) return fail('owned', `${item.id}: 이미 방어구가 가득합니다 (${ARMOR_CONFIG.max})`);
      if (economy.money(buyer) < item.price) {
        return fail('funds', `자금 부족: ${item.id} ${formatMoney(item.price)} (부족 ${formatMoney(item.price - economy.money(buyer))})`);
      }
      if (!economy.pay(buyer, item.price, 0)) return fail('funds', `자금 부족: ${item.id} ${formatMoney(item.price)}`);
      return {
        ok: true,
        item,
        spent: item.price,
        armor: ARMOR_CONFIG.max,
        message: ctx.armor > 0 ? `${item.id} 보충 ${ctx.armor} → ${ARMOR_CONFIG.max} (-${formatMoney(item.price)})` : `${item.id} 구매 완료 (-${formatMoney(item.price)})`,
      };
    }
    // Grenades: one more each time, up to the carry limit.
    if (item.grenade) {
      const kind = item.grenade;
      const max = GRENADE_CONFIG.maxCarry[kind];
      if (this.grenades[kind] >= max) return fail('owned', `${item.id}: 최대 ${max}개까지 보유할 수 있습니다`);
      if (economy.money(buyer) < item.price) {
        return fail('funds', `자금 부족: ${item.id} ${formatMoney(item.price)} (부족 ${formatMoney(item.price - economy.money(buyer))})`);
      }
      if (!economy.pay(buyer, item.price, 0)) return fail('funds', `자금 부족: ${item.id} ${formatMoney(item.price)}`);
      this.grenades[kind]++;
      return { ok: true, item, spent: item.price, message: `${item.id} 구매 완료 (${this.grenades[kind]}/${max}, -${formatMoney(item.price)})` };
    }
    if (this.owns(item.id)) return fail('owned', `${item.id}: 이미 보유한 장비입니다`);
    if (item.slot !== 'primary' && item.slot !== 'secondary') return fail('locked', `${item.id}: 구매할 수 없는 장비입니다`);
    const replaced = this.held(item.slot);
    const refund = this.refundFor(item);
    const money = economy.money(buyer);
    if (money + refund < item.price) {
      return fail('funds', `자금 부족: ${item.id} ${formatMoney(item.price)} (부족 ${formatMoney(item.price - money - refund)})`);
    }
    // Refund and charge as one change (the check above guarantees it succeeds).
    if (!economy.pay(buyer, item.price, refund)) return fail('funds', `자금 부족: ${item.id} ${formatMoney(item.price)}`);
    if (item.slot === 'primary') this.primary = item;
    else this.secondary = item;
    if (replaced) this.boughtThisRound.delete(replaced.id);
    this.boughtThisRound.add(item.id);
    const spent = item.price - refund;
    return {
      ok: true,
      item,
      replaced: replaced ?? undefined,
      spent,
      message: !replaced
        ? `${item.id} 구매 완료 (${formatSigned(-spent)})`
        : refund > 0
          ? `${item.id} 구매 (${replaced.id} 환불, ${formatSigned(-spent)})`
          : `${item.id} 구매 (${replaced.id} 교체, ${formatSigned(-spent)})`,
    };
  }

  /** Weapons to issue, in key order: primary (1), secondary (2), knife (3). */
  weapons(): { slotKey: number; item: CatalogItem }[] {
    const out: { slotKey: number; item: CatalogItem }[] = [];
    if (this.primary?.weapon) out.push({ slotKey: 0, item: this.primary });
    if (this.secondary?.weapon) out.push({ slotKey: 1, item: this.secondary });
    out.push({ slotKey: 2, item: this.melee });
    return out;
  }
}

export function formatMoney(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function formatSigned(n: number): string {
  return `${n < 0 ? '-' : '+'}${formatMoney(Math.abs(n))}`;
}

/** Items of the catalog grouped for the buy menu. */
export function catalogBySlot(): Record<'primary' | 'secondary' | 'melee' | 'equipment', CatalogItem[]> {
  return {
    primary: CATALOG.filter((i) => i.slot === 'primary'),
    secondary: CATALOG.filter((i) => i.slot === 'secondary'),
    melee: CATALOG.filter((i) => i.slot === 'melee'),
    equipment: CATALOG.filter((i) => i.slot === 'armor' || i.slot === 'utility'),
  };
}
