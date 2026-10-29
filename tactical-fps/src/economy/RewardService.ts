import { MATCH_LIMITS, MATCH_MEMORY, MATCH_REWARDS } from './EconomyRules';
import { WalletService } from './WalletService';
import type { AccountState, MatchResult } from './types';

/** Credits for one match (0 for training, forfeits, abandoned or too-short matches). */
export function matchReward(r: MatchResult): number {
  if (r.outcome !== 'completed' || r.mode === 'training') return 0;
  const rule = MATCH_REWARDS[r.mode];
  if (r.durationSeconds < rule.minDurationSeconds) return 0;
  const kills = Object.values(r.kills).reduce((s, n) => s + n, 0);
  return rule.completed + (r.won ? rule.win : 0) + Math.min(kills * rule.perKill, rule.maxKillBonus);
}

/** Rejects malformed reports (negative / fractional / absurd numbers, unknown modes). */
export function validMatchResult(r: unknown): r is MatchResult {
  if (!r || typeof r !== 'object') return false;
  const m = r as MatchResult;
  const int = (v: unknown, max: number) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max;
  if (typeof m.matchId !== 'string' || m.matchId.length < 4 || m.matchId.length > 80) return false;
  if (!['team', 'deathmatch', 'training'].includes(m.mode)) return false;
  if (!['completed', 'forfeit', 'abandoned'].includes(m.outcome)) return false;
  if (typeof m.won !== 'boolean' || !int(m.roundWins, MATCH_LIMITS.maxRoundWins)) return false;
  if (typeof m.durationSeconds !== 'number' || !Number.isFinite(m.durationSeconds) || m.durationSeconds < 0 || m.durationSeconds > MATCH_LIMITS.maxDurationSeconds) return false;
  if (!m.kills || typeof m.kills !== 'object') return false;
  const counts = Object.values(m.kills);
  if (!counts.every((n) => int(n, MATCH_LIMITS.maxKills))) return false;
  return counts.reduce((s, n) => s + n, 0) <= MATCH_LIMITS.maxKills;
}

/** Match results → credits, once per match id. */
export const RewardService = {
  settled(a: AccountState, matchId: string): boolean {
    return a.settledMatches.includes(matchId);
  },

  /** Marks the match settled and pays its reward. Returns the credits paid (0 if already settled or unpaid). */
  settle(a: AccountState, r: MatchResult, at: string): number {
    if (this.settled(a, r.matchId)) return 0;
    a.settledMatches.push(r.matchId);
    if (a.settledMatches.length > MATCH_MEMORY) a.settledMatches.shift();
    const credits = matchReward(r);
    if (credits > 0) WalletService.apply(a, credits, 'match_reward', r.matchId, at);
    return credits;
  },
};
