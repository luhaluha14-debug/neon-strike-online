// GRID economy data model: skins, owned items, loadout, credits, ledger,
// missions. Plain data (JSON-safe), no rendering and no storage access, so
// the same types serve the local build and a future account server.

/** What a skin dresses. */
export type SkinCategory = 'weapon' | 'character' | 'knife' | 'gloves';
export const SKIN_CATEGORIES: readonly SkinCategory[] = ['weapon', 'character', 'knife', 'gloves'];

/** Display and pricing tier only: never affects combat. */
export type Rarity = 'standard' | 'common' | 'uncommon' | 'rare' | 'epic';
export const RARITIES: readonly Rarity[] = ['standard', 'common', 'uncommon', 'rare', 'epic'];

/** One catalog product. */
export interface SkinDef {
  readonly skinId: string;
  readonly name: string;
  readonly description: string;
  readonly category: SkinCategory;
  /**
   * What it fits: weapon ids (`ar01`, …) for weapon skins, `karambit` for
   * knives, `player` for gloves and characters.
   */
  readonly targets: readonly string[];
  /** GRID credits (whole, ≥ 0). */
  readonly price: number;
  readonly rarity: Rarity;
  /** Look asset (skins/SkinLooks.ts). Unknown or failed assets fall back to the default look. */
  readonly assetId: string;
  /** Colours for menu swatches (sRGB hex), main first. */
  readonly preview: readonly number[];
  /** Can be bought in the shop now. */
  readonly onSale: boolean;
  /** The original look of its target: always available, never sold. */
  readonly isDefault: boolean;
  /** May later be traded between players (server-side only). */
  readonly tradable: boolean;
}

/** A skin the account owns: one instance with its own id (trades move instances). */
export interface OwnedItem {
  readonly itemId: string;
  readonly skinId: string;
  /** ISO time. */
  readonly acquiredAt: string;
  readonly source: 'purchase' | 'grant' | 'trade';
}

/**
 * Equipped skins by slot: `weapon:ar01`, `knife:karambit`, `gloves:player`,
 * `character:player` → owned itemId. A missing slot shows the default look.
 */
export type Loadout = Record<string, string>;

export type TransactionKind = 'purchase' | 'match_reward' | 'mission_reward' | 'grant';

/** One credit movement (append-only). */
export interface Transaction {
  readonly txId: string;
  readonly at: string;
  readonly kind: TransactionKind;
  /** Signed whole credits (purchase < 0). */
  readonly amount: number;
  readonly balanceAfter: number;
  /** What it was for: skinId, matchId, missionId. */
  readonly ref: string;
  readonly requestId?: string;
}

export interface MissionProgress {
  progress: number;
  completed: boolean;
  claimed: boolean;
}

/** Daily missions of one day (the day key decides when they start over). */
export interface MissionState {
  day: string;
  missions: Record<string, MissionProgress>;
  /** Events already counted today (match ids): the same event never counts twice. */
  seenEvents: string[];
}

/** Everything an account holds. Saved as one record with a revision number. */
export interface AccountState {
  readonly schema: 1;
  accountId: string;
  /** Increases on every saved change (sync conflicts are detected with it). */
  revision: number;
  credits: number;
  items: OwnedItem[];
  loadout: Loadout;
  ledger: Transaction[];
  missions: MissionState;
  /** Match ids whose result was already handled (paid or not): never paid twice. */
  settledMatches: string[];
  /** Recent request ids with their outcome (a resent request gets the same answer). */
  requests: Record<string, RequestOutcome>;
  /** Id counter for transactions and items. */
  seq: number;
}

/** Stored outcome of a handled request. */
export interface RequestOutcome {
  ok: boolean;
  error?: EconomyError;
  /** What the request returned (small JSON), so a resent request gets the same answer. */
  value?: unknown;
}

export type EconomyError =
  | 'unknown_item'
  | 'not_for_sale'
  | 'owned'
  | 'insufficient_funds'
  | 'invalid_request'
  | 'not_owned'
  | 'incompatible'
  | 'not_completed'
  | 'already_claimed'
  | 'storage_error'
  | 'conflict'
  /** Online: no valid sign-in for the request. */
  | 'unauthenticated'
  /** Online: the server could not be reached (nothing changed). */
  | 'network'
  /** Online: the server only accepts match results it verified itself. */
  | 'unverified';

/** A finished match as reported to the economy (locally by the game; online, verified by the server). */
export interface MatchResult {
  /** Unique per match instance. */
  matchId: string;
  mode: 'team' | 'deathmatch' | 'training';
  /** completed = played to its end; forfeit = 대결 포기; abandoned = left before the end. */
  outcome: 'completed' | 'forfeit' | 'abandoned';
  /** Team match: the player's team won. Deathmatch: the player finished first. */
  won: boolean;
  /** Enemies killed by the player, per weapon id. */
  kills: Record<string, number>;
  /** Team match rounds won by the player's team. */
  roundWins: number;
  /** Seconds the match lasted. */
  durationSeconds: number;
}
