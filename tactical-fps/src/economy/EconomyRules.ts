// GRID credit rules: match rewards and daily missions. Data only: change the
// numbers here to retune the economy (RewardService / MissionService read them).

export interface MatchRewardRule {
  /** For a match played to its end. */
  completed: number;
  /** Team: the player's team won. Deathmatch: the player finished first. */
  win: number;
  /** Per enemy killed, up to `maxKillBonus` per match (bots are easy to farm: kept small and capped). */
  perKill: number;
  maxKillBonus: number;
  /** A match shorter than this (s) pays nothing (no farming of instant matches). */
  minDurationSeconds: number;
}

export const MATCH_REWARDS: Record<'team' | 'deathmatch', MatchRewardRule> = {
  team: { completed: 100, win: 150, perKill: 10, maxKillBonus: 100, minDurationSeconds: 60 },
  deathmatch: { completed: 60, win: 80, perKill: 5, maxKillBonus: 50, minDurationSeconds: 60 },
};

/**
 * Explicit policy for the other endings (all pay 0 and move no mission):
 * - training: no match, nothing to win;
 * - forfeit (대결 포기): the match was given up, not completed;
 * - abandoned: left before the end (restart, mode / map change, reload).
 */
export const UNPAID_OUTCOMES = ['training', 'forfeit', 'abandoned'] as const;

/** Sanity limits on a reported match (anything beyond is rejected as invalid). */
export const MATCH_LIMITS = { maxKills: 300, maxRoundWins: 20, maxDurationSeconds: 4 * 3600 } as const;

/** What a mission counts (from completed team / deathmatch matches only). */
export type MissionMetric = 'matches_completed' | 'kills' | 'round_wins' | 'weapon_kills';

export interface MissionDef {
  readonly missionId: string;
  readonly title: string;
  readonly metric: MissionMetric;
  /** For weapon_kills: the weapon id. */
  readonly weaponId?: string;
  readonly target: number;
  readonly reward: number;
  /** When progress starts over: every day (local date offline; the server's date online). */
  readonly reset: 'daily';
}

export const DAILY_MISSIONS: readonly MissionDef[] = [
  { missionId: 'daily.match', title: '경기 1회 완료', metric: 'matches_completed', target: 1, reward: 100, reset: 'daily' },
  { missionId: 'daily.kills', title: '적 10명 처치', metric: 'kills', target: 10, reward: 150, reset: 'daily' },
  { missionId: 'daily.rounds', title: '라운드 3회 승리', metric: 'round_wins', target: 3, reward: 150, reset: 'daily' },
  { missionId: 'daily.sr01', title: 'SR-01로 3명 처치', metric: 'weapon_kills', weaponId: 'sr01', target: 3, reward: 200, reset: 'daily' },
];

/** Credits a new account starts with (enough for one common skin). */
export const STARTING_CREDITS = 500;
/** Ledger entries kept in the local record (oldest dropped first). */
export const LEDGER_LIMIT = 500;
/** Request outcomes remembered for resent requests. */
export const REQUEST_MEMORY = 200;
/** Settled match ids remembered. */
export const MATCH_MEMORY = 500;
