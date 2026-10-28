import type { BombObjective, BombState } from '../game/BombObjective';
import type { EconomyState } from '../game/Economy';
import { Match, type KillEvent, type MatchConfig } from '../game/Match';
import { TeamMatch, type RoundPhase, type RoundResult, type Team, type TeamMatchConfig } from '../game/TeamMatch';

// Match state as the host sends it to the other players, and how a client
// shows it: the client keeps real Match / TeamMatch / BombObjective objects
// (so the HUD, scoreboards and results work as in single player) and
// overwrites their state with the host's. Ids are renamed on the way in so
// that the client's own combatant is 'local' there, as the HUD expects.

const FEED_KEEP = 12;

export interface MatchState {
  kind: 'dm';
  config: MatchConfig;
  scores: [id: string, name: string, kills: number, deaths: number][];
  feed: KillEvent[];
  timeLeft: number;
  elapsed: number;
  over: boolean;
  endReason: Match['endReason'];
}

export interface TeamMatchState {
  kind: 'team';
  config: TeamMatchConfig;
  scores: [id: string, name: string, team: Team, kills: number, deaths: number][];
  feed: KillEvent[];
  history: RoundResult[];
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
    scores: [...m.scores.values()].map((s) => [rename(s.id), nameOf(s.id, s.name), s.kills, s.deaths]),
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
    scores: [...m.scores.values()].map((s) => [rename(s.id), nameOf(s.id, s.name), s.team, s.kills, s.deaths]),
    feed: m.feed.slice(-FEED_KEEP).map((k) => ({ ...k, killer: rename(k.killer), victim: rename(k.victim) })),
    history: m.history.map((h) => ({ ...h, alive: { ...h.alive } })),
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
  for (const [id, name, kills, deaths] of s.scores) {
    const line = m.scores.get(rename(id))!;
    line.name = name;
    line.kills = kills;
    line.deaths = deaths;
  }
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
  for (const [id, name, , kills, deaths] of s.scores) {
    const line = m.scores.get(rename(id))!;
    line.name = name;
    line.kills = kills;
    line.deaths = deaths;
  }
  replace(m.feed, s.feed.map((k) => ({ ...k, killer: rename(k.killer), victim: rename(k.victim) })));
  replace(m.history, s.history);
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
