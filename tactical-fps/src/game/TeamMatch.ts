// 5v5 round-based team match rules: two teams, no respawns inside a round,
// a round ends on elimination or when its clock runs out, first team to
// `roundsToWin` round wins takes the match. Pure logic (no rendering, no
// scene), driven by Game one simulation tick at a time.

import type { KillEvent } from './Match';

export type Team = 'blue' | 'red';
export const TEAMS: readonly Team[] = ['blue', 'red'];
export const TEAM_NAME: Record<Team, string> = { blue: 'BLUE', red: 'RED' };

export function otherTeam(t: Team): Team {
  return t === 'blue' ? 'red' : 'blue';
}

export interface TeamMatchConfig {
  /** Combatants per team (the player counts for BLUE). */
  teamSize: number;
  /** First team to win this many rounds wins the match. */
  roundsToWin: number;
  /** Seconds of play per round. */
  roundTime: number;
  /** Seconds everyone stands frozen at the spawn before a round goes live. */
  prepTime: number;
  /** Seconds the round result is shown before the next round. */
  resultTime: number;
}

export const DEFAULT_TEAM_MATCH: TeamMatchConfig = { teamSize: 5, roundsToWin: 5, roundTime: 120, prepTime: 3, resultTime: 4 };
export const ROUNDS_TO_WIN_OPTIONS = [3, 5, 7, 10] as const;
export const ROUND_TIME_OPTIONS = [60, 120, 180] as const;

/**
 * prep   : everyone alive at the spawns, frozen (no moving / shooting).
 * live   : the round is played; deaths are final until the next round.
 * result : the round is decided; its result is shown, nothing counts any more.
 * over   : a team reached `roundsToWin`.
 */
export type RoundPhase = 'prep' | 'live' | 'result' | 'over';
export type RoundEnd = 'elimination' | 'time';

export interface RoundResult {
  round: number;
  /** null = draw. */
  winner: Team | null;
  reason: RoundEnd;
  /** Survivors when the round was decided. */
  alive: Record<Team, number>;
}

export interface TeamScoreLine {
  id: string;
  name: string;
  team: Team;
  kills: number;
  deaths: number;
  isPlayer: boolean;
}

/** What `update` did this tick (Game reacts: reset everyone, show results). */
export type TeamMatchEvent = 'round-live' | 'round-end' | 'round-start' | 'match-over' | null;

export class TeamMatch {
  readonly scores = new Map<string, TeamScoreLine>();
  readonly feed: KillEvent[] = [];
  readonly history: RoundResult[] = [];
  readonly roundWins: Record<Team, number> = { blue: 0, red: 0 };
  /** Current round, from 1. */
  round = 1;
  phase: RoundPhase = 'prep';
  /** Seconds left in the prep / result phase. */
  phaseLeft: number;
  /** Seconds left in the round clock (counts down only while live). */
  roundTimeLeft: number;
  /** Seconds since the match started (kill feed timing). */
  elapsed = 0;

  constructor(
    readonly config: TeamMatchConfig,
    players: readonly { id: string; name: string; team: Team; isPlayer: boolean }[],
  ) {
    for (const p of players) this.scores.set(p.id, { ...p, kills: 0, deaths: 0 });
    this.phaseLeft = config.prepTime;
    this.roundTimeLeft = config.roundTime;
  }

  get over(): boolean {
    return this.phase === 'over';
  }

  /** Match winner once over (null = not over, or impossible tie). */
  get winner(): Team | null {
    if (!this.over) return null;
    return this.roundWins.blue >= this.config.roundsToWin ? 'blue' : this.roundWins.red >= this.config.roundsToWin ? 'red' : null;
  }

  /** The last decided round. */
  get lastRound(): RoundResult | null {
    return this.history.at(-1) ?? null;
  }

  teamOf(id: string): Team | null {
    return this.scores.get(id)?.team ?? null;
  }

  name(id: string): string {
    return this.scores.get(id)?.name ?? id;
  }

  /** Lines of one team, most kills first, then fewest deaths, then the player first. */
  lines(team: Team): TeamScoreLine[] {
    return [...this.scores.values()]
      .filter((s) => s.team === team)
      .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || Number(b.isPlayer) - Number(a.isPlayer));
  }

  /**
   * A death. Only counts while the round is live (a stray round resolved
   * after the round was decided changes nothing). No kill is credited for a
   * suicide, an unknown shooter or a teammate (friendly fire is off, so the
   * last can only come from a bug; it must not inflate anyone's score).
   */
  recordKill(killer: string, victim: string, weaponId: string, head: boolean): void {
    if (this.phase !== 'live') return;
    const v = this.scores.get(victim);
    if (!v) return;
    v.deaths++;
    const k = this.scores.get(killer);
    const credited = !!k && killer !== victim && k.team !== v.team;
    if (credited) k.kills++;
    this.feed.push({ killer: credited ? killer : victim, victim, weaponId, head, at: this.elapsed });
  }

  /**
   * One tick. `alive` is the number of living combatants per team right now.
   * Returns what changed so Game can respawn everyone or show the results.
   */
  update(dt: number, alive: Record<Team, number>): TeamMatchEvent {
    if (this.phase === 'over') return null;
    this.elapsed += dt;
    switch (this.phase) {
      case 'prep':
        this.phaseLeft -= dt;
        if (this.phaseLeft <= 0) {
          this.phase = 'live';
          this.phaseLeft = 0;
          return 'round-live';
        }
        return null;
      case 'live': {
        // Elimination is checked before the clock: a team wiped out on the last tick still loses by elimination.
        if (alive.blue === 0 || alive.red === 0) {
          const winner = alive.blue === 0 && alive.red === 0 ? null : alive.blue === 0 ? 'red' : 'blue';
          return this.endRound(winner, 'elimination', alive);
        }
        this.roundTimeLeft = Math.max(0, this.roundTimeLeft - dt);
        if (this.roundTimeLeft === 0) {
          const winner = alive.blue === alive.red ? null : alive.blue > alive.red ? 'blue' : 'red';
          return this.endRound(winner, 'time', alive);
        }
        return null;
      }
      case 'result':
        this.phaseLeft -= dt;
        if (this.phaseLeft <= 0) {
          this.round++;
          this.phase = 'prep';
          this.phaseLeft = this.config.prepTime;
          this.roundTimeLeft = this.config.roundTime;
          return 'round-start';
        }
        return null;
    }
  }

  private endRound(winner: Team | null, reason: RoundEnd, alive: Record<Team, number>): TeamMatchEvent {
    this.history.push({ round: this.round, winner, reason, alive: { ...alive } });
    if (winner) this.roundWins[winner]++;
    if (winner && this.roundWins[winner] >= this.config.roundsToWin) {
      this.phase = 'over';
      this.phaseLeft = 0;
      return 'match-over';
    }
    this.phase = 'result';
    this.phaseLeft = this.config.resultTime;
    return 'round-end';
  }
}
