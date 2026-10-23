// 5v5 round-based team match rules: two teams, no respawns inside a round,
// a round ends on elimination or when its clock runs out, first team to
// `roundsToWin` round wins takes the match. Pure logic (no rendering, no
// scene), driven by Game one simulation tick at a time.

import { BOMB_CONFIG } from '../config';
import { ECONOMY, TeamEconomy, type EconomyConfig } from './Economy';
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
  /**
   * Seconds of the pre-round phase ("작전 준비"): everyone frozen at the
   * spawn; with an economy, this is the buy time. Separate from roundTime.
   */
  prepTime: number;
  /** Seconds the round result is shown before the next round. */
  resultTime: number;
  /** Round economy (money, rewards, buying in the prep phase); null = none. */
  economy: EconomyConfig | null;
  /**
   * 'bomb': attackers win by planting the C4 and letting it explode (or by
   * eliminating the defenders), defenders by defusing it, eliminating the
   * attackers before a plant, or running out the clock; sides swap at
   * half time. 'elimination': last team standing / most survivors at time.
   */
  objective: TeamObjective;
}

export type TeamObjective = 'bomb' | 'elimination';
export const OBJECTIVE_OPTIONS: readonly TeamObjective[] = ['bomb', 'elimination'];

export const DEFAULT_TEAM_MATCH: TeamMatchConfig = { teamSize: 5, roundsToWin: 5, roundTime: 120, prepTime: ECONOMY.buyTime, resultTime: 4, economy: ECONOMY, objective: 'bomb' };
export const ROUNDS_TO_WIN_OPTIONS = [3, 5, 7, 10] as const;
export const ROUND_TIME_OPTIONS = [60, 120, 180] as const;

/**
 * prep   : "작전 준비": everyone alive at the spawns, frozen (no moving /
 *          shooting); the buy phase when the match has an economy. Ends
 *          when its time runs out or when ready() is called.
 * live   : the round is played; deaths are final until the next round.
 * result : the round is decided; its result is shown, nothing counts any more.
 * over   : a team reached `roundsToWin`.
 */
export type RoundPhase = 'prep' | 'live' | 'result' | 'over';
export type RoundEnd = 'elimination' | 'time' | 'bomb' | 'defuse';

export interface RoundResult {
  round: number;
  /** null = draw. */
  winner: Team | null;
  reason: RoundEnd;
  /** Survivors when the round was decided. */
  alive: Record<Team, number>;
  /** Team on attack in that round (bomb objective). */
  attackers: Team;
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
  /** Money and rewards (null without an economy). Settled once per decided round, kill bonuses once per kill. */
  readonly economy: TeamEconomy | null;
  /** Bomb objective: the team on attack this round (BLUE first; they swap at half time). */
  attackers: Team = 'blue';
  /** Bomb objective: the C4 is planted this round (the round clock is stopped, the bomb timer decides). */
  planted = false;
  /** Round in which the sides swapped (0 = not yet). */
  swappedAtRound = 0;

  constructor(
    readonly config: TeamMatchConfig,
    players: readonly { id: string; name: string; team: Team; isPlayer: boolean }[],
  ) {
    for (const p of players) this.scores.set(p.id, { ...p, kills: 0, deaths: 0 });
    this.economy = config.economy ? new TeamEconomy(config.economy, players) : null;
    this.phaseLeft = config.prepTime;
    this.roundTimeLeft = config.roundTime;
  }

  get defenders(): Team {
    return otherTeam(this.attackers);
  }

  get bombMode(): boolean {
    return this.config.objective === 'bomb';
  }

  /** Rounds played before the sides swap (bomb objective): one less than the rounds needed to win. */
  get halftimeAfter(): number {
    return Math.max(this.config.roundsToWin - 1, 1);
  }

  /**
   * The C4 was planted by `id`. Only during a live round, once: stops the
   * round clock and pays the planter's bonus.
   */
  bombPlanted(id: string): boolean {
    if (this.phase !== 'live' || !this.bombMode || this.planted) return false;
    this.planted = true;
    if (this.teamOf(id) === this.attackers) this.economy?.credit(id, BOMB_CONFIG.plantBonus);
    return true;
  }

  /** The planted C4 exploded: attackers win (once, live rounds only). */
  bombExploded(alive: Record<Team, number>): TeamMatchEvent {
    if (this.phase !== 'live' || !this.planted) return null;
    return this.endRound(this.attackers, 'bomb', alive);
  }

  /** `id` defused the C4: defenders win, defuser's bonus (once, live rounds only). */
  bombDefused(id: string, alive: Record<Team, number>): TeamMatchEvent {
    if (this.phase !== 'live' || !this.planted) return null;
    if (this.teamOf(id) === this.defenders) this.economy?.credit(id, BOMB_CONFIG.defuseBonus);
    return this.endRound(this.defenders, 'defuse', alive);
  }

  get over(): boolean {
    return this.phase === 'over';
  }

  /** Buying is possible only in the prep phase of a match with an economy. */
  get buyOpen(): boolean {
    return this.phase === 'prep' && this.economy !== null;
  }

  /**
   * "출격 확정": end the prep phase now. Takes effect on the next update(),
   * i.e. at a tick boundary, when every combatant goes live together.
   */
  ready(): boolean {
    if (this.phase !== 'prep') return false;
    this.phaseLeft = 0;
    return true;
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
    if (credited) {
      k.kills++;
      this.economy?.onKill(this.round, killer, victim);
    }
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
        this.phaseLeft = Math.max(0, this.phaseLeft - dt);
        if (this.phaseLeft <= 0) {
          this.phase = 'live';
          this.phaseLeft = 0;
          return 'round-live';
        }
        return null;
      case 'live': {
        if (this.bombMode) return this.updateBomb(dt, alive);
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
          this.planted = false;
          // Half time (bomb objective): sides swap once; money and loss streaks start over.
          if (this.bombMode && this.swappedAtRound === 0 && this.round === this.halftimeAfter + 1) {
            this.attackers = otherTeam(this.attackers);
            this.swappedAtRound = this.round;
            this.economy?.resetMoney();
          }
          return 'round-start';
        }
        return null;
    }
  }

  /**
   * Bomb objective, live round. Before the plant: attackers wiped out →
   * defenders; defenders wiped out → attackers; both on the same tick →
   * draw; clock out → defenders. After the plant the clock stops: wiping out
   * the attackers does not end it (the bomb must still be defused);
   * defenders wiped out → attackers. Explosion / defuse: bombExploded / bombDefused.
   */
  private updateBomb(dt: number, alive: Record<Team, number>): TeamMatchEvent {
    const atk = this.attackers;
    const def = this.defenders;
    if (this.planted) {
      if (alive[def] === 0) return this.endRound(atk, 'elimination', alive);
      return null;
    }
    if (alive[atk] === 0 || alive[def] === 0) {
      const winner = alive[atk] === 0 && alive[def] === 0 ? null : alive[atk] === 0 ? def : atk;
      return this.endRound(winner, 'elimination', alive);
    }
    this.roundTimeLeft = Math.max(0, this.roundTimeLeft - dt);
    if (this.roundTimeLeft === 0) return this.endRound(def, 'time', alive);
    return null;
  }

  private endRound(winner: Team | null, reason: RoundEnd, alive: Record<Team, number>): TeamMatchEvent {
    this.history.push({ round: this.round, winner, reason, alive: { ...alive }, attackers: this.attackers });
    if (winner) this.roundWins[winner]++;
    // The one place a round is decided, so its payout happens exactly once.
    this.economy?.settle({ round: this.round, winner });
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
