// 5v5 round-based team match rules: two teams, no respawns inside a round,
// a round ends on elimination or when its clock runs out, first team to
// `roundsToWin` round wins takes the match. Pure logic (no rendering, no
// scene), driven by Game one simulation tick at a time.

import { BOMB_CONFIG } from '../config';
import { ECONOMY, TeamEconomy, type EconomyConfig } from './Economy';
import { creditKill, creditedDamage, killEvent, reassignSeat, type KillEvent, type SeatRecord } from './Match';

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
  /** Team on attack in that round (bomb objective only; elimination rounds have no sides). */
  attackers?: Team;
}

/**
 * A decided round's record (라운드 기록), next to its RoundResult (same round number; written at the
 * same moment, once): how long it was live, the C4 in a bomb round, and every seat's numbers in it.
 */
export interface RoundStats {
  round: number;
  /** Seconds the round was live (from the end of prep to the decision). */
  duration: number;
  /** Bomb objective only: was the C4 planted, by whom, and who defused it. */
  bomb?: RoundBomb;
  /** Every seat's record for this round alone, by its controller at the end of the round (the match record's rules; see ScoreLine). */
  players: RoundPlayer[];
}

/** Bomb objective, one round: was the C4 planted, by whom (name then), and who defused it. */
export interface RoundBomb {
  planted: boolean;
  plantedBy?: string;
  defusedBy?: string;
}

/** One seat in one round: id, name then, team, controller generation, then kills, deaths, headshot kills, damage. */
export type RoundPlayer = [id: string, name: string, team: Team, gen: number, kills: number, deaths: number, headshots: number, damage: number];

/** A seat's numbers for the round being played (only the controller of generation `gen`). */
interface RoundTally {
  gen: number;
  kills: number;
  deaths: number;
  headshots: number;
  damage: number;
}

export interface TeamScoreLine {
  id: string;
  name: string;
  team: Team;
  kills: number;
  deaths: number;
  isPlayer: boolean;
  /** Controller generation of the seat (see ScoreLine in Match.ts). */
  gen: number;
  /** The current controller's credited kills per weapon id (see ScoreLine in Match.ts). */
  weaponKills: Record<string, number>;
  /** Headshot kills and damage dealt to the other team (see ScoreLine in Match.ts). */
  headshots: number;
  damage: number;
}

/** What `update` did this tick (Game reacts: reset everyone, show results). */
export type TeamMatchEvent = 'round-live' | 'round-end' | 'round-start' | 'match-over' | null;

export class TeamMatch {
  readonly scores = new Map<string, TeamScoreLine>();
  readonly feed: KillEvent[] = [];
  readonly history: RoundResult[] = [];
  /** 라운드 기록: one per entry of `history`, same order (a room member's from an older host: none). */
  readonly roundStats: RoundStats[] = [];
  readonly roundWins: Record<Team, number> = { blue: 0, red: 0 };
  /**
   * A room member's copy from an older host that does not send per-weapon
   * kills: results then count the kill feed, as before.
   */
  legacyStats = false;
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
  /** The team that gave up the match (대결 포기), null if it was played out. */
  forfeitedBy: Team | null = null;
  /** The round being played: seconds live so far, each seat's numbers, and the C4's planter / defuser. */
  private roundLive = 0;
  private readonly tally = new Map<string, RoundTally>();
  private plantedBy: string | null = null;
  private defusedBy: string | null = null;

  constructor(
    readonly config: TeamMatchConfig,
    players: readonly { id: string; name: string; team: Team; isPlayer: boolean }[],
  ) {
    for (const p of players) this.scores.set(p.id, { ...p, kills: 0, deaths: 0, gen: 0, weaponKills: {}, headshots: 0, damage: 0 });
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
    this.plantedBy = this.name(id);
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
    this.defusedBy = this.name(id);
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

  /**
   * `team` gives up (대결 포기): the match ends now as that team's loss.
   * Nothing is played or paid for it: no round is added to the history, no
   * round result or kill bonus is settled, rounds already settled stay as
   * they are. Only possible once, while the match is not over.
   */
  forfeit(team: Team): boolean {
    if (this.phase === 'over') return false;
    this.forfeitedBy = team;
    this.phase = 'over';
    this.phaseLeft = 0;
    this.planted = false;
    return true;
  }

  /** Match winner once over (null = not over, or impossible tie). A forfeit goes to the other team. */
  get winner(): Team | null {
    if (!this.over) return null;
    if (this.forfeitedBy) return otherTeam(this.forfeitedBy);
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

  /**
   * Someone else controls seat `id` from now on: a fresh personal record
   * (see reassignSeat). The team's rounds, history and money are the team's
   * and the seat's, so they do not change.
   */
  reassign(id: string, name: string, restore?: SeatRecord): SeatRecord | null {
    const line = this.scores.get(id);
    return line ? reassignSeat(line, name, restore) : null;
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
   * Returns true when `killer` was credited.
   */
  recordKill(killer: string, victim: string, weaponId: string, head: boolean): boolean {
    if (this.phase !== 'live') return false;
    const v = this.scores.get(victim);
    if (!v) return false;
    v.deaths++;
    this.tallyOf(victim, v.gen).deaths++;
    const k = this.scores.get(killer);
    const credited = !!k && killer !== victim && k.team !== v.team;
    if (credited) {
      creditKill(k, weaponId, head);
      const t = this.tallyOf(killer, k.gen);
      t.kills++;
      if (head) t.headshots++;
      this.economy?.onKill(this.round, killer, victim);
    }
    this.feed.push(killEvent(this.scores, { killer: credited ? killer : victim, victim, weaponId, head, at: this.elapsed }));
    return credited;
  }

  /**
   * Health a hit by `attacker` just took from `victim` (as applied). Credited like kills: only while
   * the round is live, never for self-damage, a teammate or an unknown shooter. Returns the points credited.
   */
  recordDamage(attacker: string, victim: string, amount: number): number {
    if (this.phase !== 'live' || attacker === victim) return 0;
    const v = this.scores.get(victim);
    const a = this.scores.get(attacker);
    if (!v || !a || a.team === v.team) return 0;
    const n = creditedDamage(amount);
    a.damage += n;
    this.tallyOf(attacker, a.gen).damage += n;
    return n;
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
          this.startTally();
          return 'round-live';
        }
        return null;
      case 'live': {
        this.roundLive += dt;
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

  /** A live round starts: nothing counted for it yet. */
  private startTally(): void {
    this.roundLive = 0;
    this.tally.clear();
    this.plantedBy = null;
    this.defusedBy = null;
  }

  /** The round tally of seat `id` for its controller `gen` (a seat that changed hands mid-round starts again, as its match record does). */
  private tallyOf(id: string, gen: number): RoundTally {
    let t = this.tally.get(id);
    if (!t || t.gen !== gen) {
      t = { gen, kills: 0, deaths: 0, headshots: 0, damage: 0 };
      this.tally.set(id, t);
    }
    return t;
  }

  /** Every seat's numbers for the round just decided (zeros for a seat that did nothing). */
  private roundPlayers(): RoundPlayer[] {
    return [...this.scores.values()].map((s) => {
      const t = this.tally.get(s.id);
      const mine = t && t.gen === s.gen ? t : null;
      return [s.id, s.name, s.team, s.gen, mine?.kills ?? 0, mine?.deaths ?? 0, mine?.headshots ?? 0, mine?.damage ?? 0];
    });
  }

  /** The only place a round is decided (live phase only, then the phase moves on): its record is written once. */
  private endRound(winner: Team | null, reason: RoundEnd, alive: Record<Team, number>): TeamMatchEvent {
    this.history.push({ round: this.round, winner, reason, alive: { ...alive }, ...(this.bombMode ? { attackers: this.attackers } : {}) });
    this.roundStats.push({
      round: this.round,
      // Ended by the clock: exactly the round clock (the clock only runs while live and unplanted).
      duration: Math.round((reason === 'time' ? Math.min(this.roundLive, this.config.roundTime) : this.roundLive) * 10) / 10,
      ...(this.bombMode
        ? { bomb: { planted: this.planted, ...(this.plantedBy ? { plantedBy: this.plantedBy } : {}), ...(this.defusedBy ? { defusedBy: this.defusedBy } : {}) } }
        : {}),
      players: this.roundPlayers(),
    });
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
