import type { BombObjective, BombState } from '../game/BombObjective';
import type { EconomyState } from '../game/Economy';
import { Match, type KillEvent, type MatchConfig } from '../game/Match';
import { TeamMatch, type RoundPhase, type RoundPlayer, type RoundResult, type RoundStats, type Team, type TeamMatchConfig } from '../game/TeamMatch';

// Match state as the host sends it to the other players, and how a client
// shows it: the client keeps real Match / TeamMatch / BombObjective objects
// (so the HUD, scoreboards and results work as in single player) and
// overwrites their state with the host's. Ids are renamed on the way in so
// that the client's own combatant is 'local' there, as the HUD expects.

const FEED_KEEP = 12;

export interface MatchState {
  kind: 'dm';
  config: MatchConfig;
  /**
   * `gen`: the seat's controller generation (who the personal record belongs to; see ScoreLine).
   * `wk`: its confirmed kills per weapon (results / rewards). Both absent from an older host.
   * `hs`, `dmg`: its headshot kills and damage dealt, as the host credited them (absent from an older host).
   */
  scores: [id: string, name: string, kills: number, deaths: number, gen?: number, wk?: Record<string, number>, hs?: number, dmg?: number][];
  feed: KillEvent[];
  timeLeft: number;
  elapsed: number;
  over: boolean;
  endReason: Match['endReason'];
}

export interface TeamMatchState {
  kind: 'team';
  config: TeamMatchConfig;
  scores: [id: string, name: string, team: Team, kills: number, deaths: number, gen?: number, wk?: Record<string, number>, hs?: number, dmg?: number][];
  feed: KillEvent[];
  history: RoundResult[];
  /** 라운드 기록 for each entry of `history` (absent from an older host). */
  rounds?: RoundStats[];
  roundWins: Record<Team, number>;
  round: number;
  phase: RoundPhase;
  phaseLeft: number;
  roundTimeLeft: number;
  elapsed: number;
  attackers: Team;
  planted: boolean;
  swappedAtRound: number;
  forfeitedBy: Team | null;
  economy: EconomyState | null;
}

export interface BombStateMsg {
  state: BombState;
  carrier: string | null;
  p: [number, number, number];
  site: string | null;
  timeLeft: number;
  planting: { id: string; time: number } | null;
  defusing: { id: string; time: number } | null;
}

/** Host side: `rename` turns its ids into the wire ids (its own 'local' → its member id). */
export function matchState(m: Match, rename: (id: string) => string, nameOf: (id: string, name: string) => string): MatchState {
  return {
    kind: 'dm',
    config: { ...m.config },
    scores: [...m.scores.values()].map((s) => [rename(s.id), nameOf(s.id, s.name), s.kills, s.deaths, s.gen, s.weaponKills, s.headshots, s.damage]),
    feed: m.feed.slice(-FEED_KEEP).map((k) => ({ ...k, killer: rename(k.killer), victim: rename(k.victim) })),
    timeLeft: m.timeLeft,
    elapsed: m.elapsed,
    over: m.over,
    endReason: m.endReason,
  };
}

export function teamMatchState(m: TeamMatch, rename: (id: string) => string, nameOf: (id: string, name: string) => string): TeamMatchState {
  const eco = m.economy?.exportState() ?? null;
  return {
    kind: 'team',
    config: { ...m.config },
    scores: [...m.scores.values()].map((s) => [rename(s.id), nameOf(s.id, s.name), s.team, s.kills, s.deaths, s.gen, s.weaponKills, s.headshots, s.damage]),
    feed: m.feed.slice(-FEED_KEEP).map((k) => ({ ...k, killer: rename(k.killer), victim: rename(k.victim) })),
    history: m.history.map((h) => ({ ...h, alive: { ...h.alive } })),
    rounds: m.roundStats.map((r) => ({
      ...r,
      ...(r.bomb ? { bomb: { ...r.bomb } } : {}),
      players: r.players.map((p) => [rename(p[0]), nameOf(p[0], p[1]), ...p.slice(2)] as RoundPlayer),
    })),
    roundWins: { ...m.roundWins },
    round: m.round,
    phase: m.phase,
    phaseLeft: m.phaseLeft,
    roundTimeLeft: m.roundTimeLeft,
    elapsed: m.elapsed,
    attackers: m.attackers,
    planted: m.planted,
    swappedAtRound: m.swappedAtRound,
    forfeitedBy: m.forfeitedBy,
    economy: eco && {
      wallets: eco.wallets.map(([id, v]) => [rename(id), v]),
      lossStreak: eco.lossStreak,
      lastPayout: eco.lastPayout.map(([id, p]) => [rename(id), p]),
    },
  };
}

export function bombState(b: BombObjective, rename: (id: string) => string): BombStateMsg {
  const prog = (p: { id: string; time: number } | null) => (p ? { id: rename(p.id), time: p.time } : null);
  return {
    state: b.state,
    carrier: b.carrier === null ? null : rename(b.carrier),
    p: [b.position.x, b.position.y, b.position.z],
    site: b.site,
    timeLeft: b.timeLeft,
    planting: prog(b.planting),
    defusing: prog(b.defusing),
  };
}

/**
 * Client side: `m` updated to `s` (or a new Match when there is none or the
 * line-up changed). `rename` maps wire ids to this game's ('local' = me).
 */
export function applyMatch(prev: Match | null, s: MatchState, rename: (id: string) => string): Match {
  const ids = s.scores.map((x) => rename(x[0]));
  const m =
    prev && prev.scores.size === ids.length && ids.every((id) => prev.scores.has(id))
      ? prev
      : new Match(s.config, s.scores.map(([id, name]) => ({ id: rename(id), name, isPlayer: rename(id) === 'local' })));
  for (const [id, name, kills, deaths, gen, wk, hs, dmg] of s.scores) {
    const line = m.scores.get(rename(id))!;
    line.name = name;
    line.kills = kills;
    line.deaths = deaths;
    line.gen = gen ?? 0;
    line.weaponKills = weaponKills(wk);
    line.headshots = count(hs, kills);
    line.damage = count(dmg, MAX_DAMAGE);
  }
  m.legacyStats = s.scores.some((x) => x[5] === undefined);
  replace(m.feed, s.feed.map((k) => ({ ...k, killer: rename(k.killer), victim: rename(k.victim) })));
  m.timeLeft = s.timeLeft;
  m.elapsed = s.elapsed;
  m.over = s.over;
  m.endReason = s.endReason;
  return m;
}

export function applyTeamMatch(prev: TeamMatch | null, s: TeamMatchState, rename: (id: string) => string): TeamMatch {
  const keep =
    !!prev &&
    prev.config.objective === s.config.objective &&
    prev.config.roundsToWin === s.config.roundsToWin &&
    !!prev.economy === !!s.config.economy &&
    prev.scores.size === s.scores.length &&
    s.scores.every(([id, , team]) => prev.scores.get(rename(id))?.team === team);
  const m = keep
    ? prev!
    : new TeamMatch(
        s.config,
        s.scores.map(([id, name, team]) => ({ id: rename(id), name, team, isPlayer: rename(id) === 'local' })),
      );
  for (const [id, name, , kills, deaths, gen, wk, hs, dmg] of s.scores) {
    const line = m.scores.get(rename(id))!;
    line.name = name;
    line.kills = kills;
    line.deaths = deaths;
    line.gen = gen ?? 0;
    line.weaponKills = weaponKills(wk);
    line.headshots = count(hs, kills);
    line.damage = count(dmg, MAX_DAMAGE);
  }
  m.legacyStats = s.scores.some((x) => x[6] === undefined);
  replace(m.feed, s.feed.map((k) => ({ ...k, killer: rename(k.killer), victim: rename(k.victim) })));
  replace(m.history, s.history);
  // The host's round records, as they are (the whole list each time: a repeat changes nothing; none from an older host).
  replace(m.roundStats, Array.isArray(s.rounds) ? s.rounds.map((r) => roundRecord(r, rename)) : []);
  m.roundWins.blue = s.roundWins.blue;
  m.roundWins.red = s.roundWins.red;
  m.round = s.round;
  m.phase = s.phase;
  m.phaseLeft = s.phaseLeft;
  m.roundTimeLeft = s.roundTimeLeft;
  m.elapsed = s.elapsed;
  m.attackers = s.attackers;
  m.planted = s.planted;
  m.swappedAtRound = s.swappedAtRound;
  m.forfeitedBy = s.forfeitedBy;
  if (m.economy && s.economy) m.economy.importState(s.economy, rename);
  return m;
}

export function applyBomb(b: BombObjective, s: BombStateMsg, rename: (id: string) => string): void {
  b.state = s.state;
  b.carrier = s.carrier === null ? null : rename(s.carrier);
  b.position.set(s.p[0], s.p[1], s.p[2]);
  b.site = s.site;
  b.timeLeft = s.timeLeft;
  b.planting = s.planting ? { id: rename(s.planting.id), time: s.planting.time, hits: 0 } : null;
  b.defusing = s.defusing ? { id: rename(s.defusing.id), time: s.defusing.time, hits: 0 } : null;
}

function replace<T>(target: T[], items: readonly T[]): void {
  target.length = 0;
  target.push(...items);
}

/** A received round record with its seats renamed to this game's ids; numbers checked like the score lines. */
function roundRecord(h: RoundStats, rename: (id: string) => string): RoundStats {
  const out: RoundStats = {
    round: count(h.round, 10_000),
    duration: Number.isFinite(h.duration) && h.duration >= 0 ? Math.min(h.duration, 36_000) : 0,
    players: [],
  };
  if (h.bomb) out.bomb = { planted: h.bomb.planted === true, ...(typeof h.bomb.plantedBy === 'string' ? { plantedBy: h.bomb.plantedBy } : {}), ...(typeof h.bomb.defusedBy === 'string' ? { defusedBy: h.bomb.defusedBy } : {}) };
  if (Array.isArray(h.players))
    out.players = h.players
      .filter((p) => Array.isArray(p) && typeof p[0] === 'string' && (p[2] === 'blue' || p[2] === 'red'))
      .map((p) => {
        const kills = count(p[4], 999);
        return [rename(p[0]), String(p[1] ?? ''), p[2], count(p[3], 1e6), kills, count(p[5], 999), count(p[6], kills), count(p[7], MAX_DAMAGE)];
      });
  return out;
}

/** Ceiling for a received damage total (far above any real match; a garbage value cannot show). */
const MAX_DAMAGE = 10_000_000;

/** A received count as shown: a whole number 0…max (headshot kills never above the kills), else 0 (older host: none sent). */
function count(n: unknown, max: number): number {
  return Number.isInteger(n) && (n as number) >= 0 ? Math.min(n as number, max) : 0;
}

/** The host's per-weapon counts, as received (only whole non-negative numbers; anything else is dropped). */
function weaponKills(wk: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (wk && typeof wk === 'object')
    for (const [w, n] of Object.entries(wk)) if (Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 10_000) out[w] = n as number;
  return out;
}
