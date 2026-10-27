import { DAILY_MISSIONS, type MissionDef } from './EconomyRules';
import { WalletService } from './WalletService';
import type { AccountState, EconomyError, MatchResult, MissionProgress } from './types';

const SEEN_LIMIT = 200;

/**
 * Daily missions. Progress only moves on a counted event (a completed team
 * or deathmatch match), each event id at most once; completion and claiming
 * are separate, and a reward is paid once, on claim. A new day key starts
 * every mission over (unclaimed rewards of the old day lapse).
 */
export const MissionService = {
  defs(): readonly MissionDef[] {
    return DAILY_MISSIONS;
  },

  /** Brings the mission record to `day` (a new day = fresh missions). */
  roll(a: AccountState, day: string): void {
    if (a.missions.day === day && DAILY_MISSIONS.every((m) => a.missions.missions[m.missionId])) return;
    if (a.missions.day !== day) a.missions = { day, missions: {}, seenEvents: [] };
    for (const m of DAILY_MISSIONS) a.missions.missions[m.missionId] ??= { progress: 0, completed: false, claimed: false };
  },

  progress(a: AccountState, missionId: string): MissionProgress | undefined {
    return a.missions.missions[missionId];
  },

  /** Counts a completed match (`eventId` = match id). Returns false if it was already counted or does not count. */
  record(a: AccountState, day: string, eventId: string, r: MatchResult): boolean {
    this.roll(a, day);
    if (r.outcome !== 'completed' || r.mode === 'training') return false;
    if (a.missions.seenEvents.includes(eventId)) return false;
    a.missions.seenEvents.push(eventId);
    if (a.missions.seenEvents.length > SEEN_LIMIT) a.missions.seenEvents.shift();
    for (const m of DAILY_MISSIONS) {
      const p = a.missions.missions[m.missionId];
      const add = missionIncrement(m, r);
      if (add <= 0 || p.completed) continue;
      p.progress = Math.min(m.target, p.progress + add);
      p.completed = p.progress >= m.target;
    }
    return true;
  },

  /** Pays a completed, unclaimed mission of today once. */
  claim(a: AccountState, day: string, missionId: string, at: string, requestId: string): EconomyError | null {
    this.roll(a, day);
    const def = DAILY_MISSIONS.find((m) => m.missionId === missionId);
    const p = a.missions.missions[missionId];
    if (!def || !p) return 'unknown_item';
    if (p.claimed) return 'already_claimed';
    if (!p.completed) return 'not_completed';
    p.claimed = true;
    WalletService.apply(a, def.reward, 'mission_reward', missionId, at, requestId);
    return null;
  },
};

/** How much one counted match moves a mission (shared by the local authority and the account server). */
export function missionIncrement(m: MissionDef, r: MatchResult): number {
  if (r.outcome !== 'completed' || r.mode === 'training') return 0;
  switch (m.metric) {
    case 'matches_completed':
      return 1;
    case 'kills':
      return Object.values(r.kills).reduce((s, n) => s + n, 0);
    case 'round_wins':
      return r.roundWins;
    case 'weapon_kills':
      return r.kills[m.weaponId ?? ''] ?? 0;
  }
}
