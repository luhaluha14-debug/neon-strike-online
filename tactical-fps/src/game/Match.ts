// Free-for-all deathmatch rules: kills and deaths per combatant, a time
// limit and a kill target. Pure logic (no rendering), driven by Game.

/** 'deathmatch' free-for-all, 'team' 5v5 rounds (TeamMatch), 'training' dummies. */
export type GameMode = 'deathmatch' | 'team' | 'training';

export interface MatchConfig {
  /** Number of AI opponents. */
  bots: number;
  /** Seconds. */
  timeLimit: number;
  /** First to this many kills wins. */
  killTarget: number;
}

export const DEFAULT_MATCH: MatchConfig = { bots: 5, timeLimit: 600, killTarget: 30 };
export const BOT_COUNT_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
export const TIME_LIMIT_OPTIONS = [300, 600, 900] as const;
export const KILL_TARGET_OPTIONS = [10, 20, 30, 50] as const;

export interface ScoreLine {
  id: string;
  name: string;
  kills: number;
  deaths: number;
  isPlayer: boolean;
}

export interface KillEvent {
  killer: string;
  victim: string;
  weaponId: string;
  head: boolean;
  /** Match time (s since start) of the kill. */
  at: number;
}

export class Match {
  readonly scores = new Map<string, ScoreLine>();
  readonly feed: KillEvent[] = [];
  timeLeft: number;
  elapsed = 0;
  over = false;
  /** Why it ended. */
  endReason: 'time' | 'kills' | null = null;

  constructor(
    readonly config: MatchConfig,
    players: readonly { id: string; name: string; isPlayer: boolean }[],
  ) {
    this.timeLeft = config.timeLimit;
    for (const p of players) this.scores.set(p.id, { ...p, kills: 0, deaths: 0 });
  }

  /** A kill (killer may be the victim's own id or unknown for suicides: then no kill is credited). */
  recordKill(killer: string, victim: string, weaponId: string, head: boolean): void {
    if (this.over) return;
    const v = this.scores.get(victim);
    if (v) v.deaths++;
    const k = this.scores.get(killer);
    if (k && killer !== victim) k.kills++;
    this.feed.push({ killer, victim, weaponId, head, at: this.elapsed });
    if (k && k.kills >= this.config.killTarget) this.end('kills');
  }

  update(dt: number): void {
    if (this.over) return;
    this.elapsed += dt;
    this.timeLeft = Math.max(0, this.timeLeft - dt);
    if (this.timeLeft === 0) this.end('time');
  }

  /** Most kills first, then fewest deaths, then the player first. */
  get ranking(): ScoreLine[] {
    return [...this.scores.values()].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || Number(b.isPlayer) - Number(a.isPlayer));
  }

  /** The player wins with the most kills (ties go to the player only if nobody has more). */
  get playerWon(): boolean {
    const r = this.ranking;
    const me = r.find((s) => s.isPlayer);
    return !!me && r.every((s) => s === me || s.kills < me.kills);
  }

  name(id: string): string {
    return this.scores.get(id)?.name ?? id;
  }

  private end(reason: 'time' | 'kills'): void {
    this.over = true;
    this.endReason = reason;
  }
}
