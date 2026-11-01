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

/**
 * One seat on the scoreboard. Kills and deaths are the personal record of
 * whoever controls the seat now: when control changes hands (a room member
 * takes over a bot, or the bot gets it back), `gen` goes up and the record
 * starts again (`reassignSeat`). Team results (round wins) never come from
 * these lines.
 */
export interface ScoreLine {
  id: string;
  name: string;
  kills: number;
  deaths: number;
  isPlayer: boolean;
  /** Controller generation of the seat (0 = the one it started with). */
  gen: number;
  /**
   * The current controller's credited kills per weapon id: the confirmed
   * record results and GRID rewards are paid from (the kill feed is a
   * display history and is cut short on its way to room members).
   */
  weaponKills: Record<string, number>;
}

export interface KillEvent {
  killer: string;
  victim: string;
  weaponId: string;
  head: boolean;
  /** Match time (s since start) of the kill. */
  at: number;
  /** Controller generations of the killer's and victim's seats at the kill, and their names then. */
  kg?: number;
  vg?: number;
  kn?: string;
  vn?: string;
}

/** A seat's personal record (kept for the AI while a room member plays its seat). */
export interface SeatRecord {
  kills: number;
  deaths: number;
  weaponKills?: Record<string, number>;
}

/**
 * A new controller takes over `line`'s seat: its personal record starts at
 * 0 (or `restore`, the record the returning controller had), under its new
 * name. Returns the record the previous controller leaves behind.
 */
export function reassignSeat(line: ScoreLine, name: string, restore?: SeatRecord): SeatRecord {
  const left = { kills: line.kills, deaths: line.deaths, weaponKills: { ...line.weaponKills } };
  line.gen++;
  line.name = name;
  line.kills = restore?.kills ?? 0;
  line.deaths = restore?.deaths ?? 0;
  line.weaponKills = { ...restore?.weaponKills };
  return left;
}

/** Counts a credited kill on the killer's line (total and per weapon). */
export function creditKill(line: ScoreLine, weaponId: string): void {
  line.kills++;
  line.weaponKills[weaponId] = (line.weaponKills[weaponId] ?? 0) + 1;
}

/** True when `k` is a kill made by the current controller of `line` (not by whoever held the seat before). */
export function killBy(line: ScoreLine, k: KillEvent): boolean {
  return k.killer === line.id && k.victim !== line.id && (k.kg ?? 0) === line.gen;
}

/** The feed entry with the seats' generations and names at the time of the kill. */
export function killEvent(scores: ReadonlyMap<string, ScoreLine>, e: Omit<KillEvent, 'kg' | 'vg' | 'kn' | 'vn'>): KillEvent {
  const k = scores.get(e.killer);
  const v = scores.get(e.victim);
  return { ...e, kg: k?.gen ?? 0, vg: v?.gen ?? 0, kn: k?.name, vn: v?.name };
}

/** Name for a feed entry's seat: the current one if the same controller still holds it, else the name it had then. */
export function feedName(scores: ReadonlyMap<string, ScoreLine>, id: string, gen: number | undefined, then: string | undefined): string {
  const s = scores.get(id);
  return s && (gen ?? 0) === s.gen ? s.name : (then ?? s?.name ?? id);
}

export class Match {
  readonly scores = new Map<string, ScoreLine>();
  readonly feed: KillEvent[] = [];
  timeLeft: number;
  elapsed = 0;
  over = false;
  /**
   * A room member's copy from an older host that does not send per-weapon
   * kills: results then count the kill feed, as before.
   */
  legacyStats = false;
  /** Why it ended. */
  endReason: 'time' | 'kills' | null = null;

  constructor(
    readonly config: MatchConfig,
    players: readonly { id: string; name: string; isPlayer: boolean }[],
  ) {
    this.timeLeft = config.timeLimit;
    for (const p of players) this.scores.set(p.id, { ...p, kills: 0, deaths: 0, gen: 0, weaponKills: {} });
  }

  /** Someone else controls seat `id` from now on (see reassignSeat); null if there is no such seat. */
  reassign(id: string, name: string, restore?: SeatRecord): SeatRecord | null {
    const line = this.scores.get(id);
    return line ? reassignSeat(line, name, restore) : null;
  }

  /** Records a death; true when `killer` was credited with the kill (not a suicide, not after the end). */
  recordKill(killer: string, victim: string, weaponId: string, head: boolean): boolean {
    if (this.over) return false;
    const v = this.scores.get(victim);
    if (v) v.deaths++;
    const k = this.scores.get(killer);
    const credited = !!k && killer !== victim;
    if (credited) creditKill(k, weaponId);
    this.feed.push(killEvent(this.scores, { killer, victim, weaponId, head, at: this.elapsed }));
    if (k && k.kills >= this.config.killTarget) this.end('kills');
    return credited;
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
