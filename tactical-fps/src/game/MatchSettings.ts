import { BOT_COUNT_OPTIONS, DEFAULT_MATCH, KILL_TARGET_OPTIONS, TIME_LIMIT_OPTIONS, type GameMode, type MatchConfig } from './Match';
import { DEFAULT_TEAM_MATCH, ROUND_TIME_OPTIONS, ROUNDS_TO_WIN_OPTIONS, type TeamObjective } from './TeamMatch';
import type { BotLook } from '../ai/BotSquad';

// Mode and match rules, stored apart from the settings record (whose format stays as is).
// Deathmatch (bots / timeLimit / killTarget) and team match (roundsToWin / roundTime)
// keep their own fields, so changing one mode's options never touches the other's.

export interface MatchSettings extends MatchConfig {
  mode: GameMode;
  /** Team match: round wins needed. */
  roundsToWin: number;
  /** Team match: seconds per round. */
  roundTime: number;
  /** Team match objective (C4 bomb or elimination). */
  objective: TeamObjective;
  /** Bot bodies in both bot modes: built-in animated body or the character models. */
  botLook: BotLook;
}

const KEY = 'tactical-fps.match.v1';

export function parseMode(v: unknown): GameMode | null {
  return v === 'deathmatch' || v === 'team' || v === 'training' ? v : null;
}

export function parseObjective(v: unknown): TeamObjective | null {
  return v === 'bomb' || v === 'elimination' ? v : null;
}

export function loadMatchSettings(): MatchSettings {
  const s: MatchSettings = {
    mode: 'deathmatch',
    ...DEFAULT_MATCH,
    roundsToWin: DEFAULT_TEAM_MATCH.roundsToWin,
    roundTime: DEFAULT_TEAM_MATCH.roundTime,
    objective: DEFAULT_TEAM_MATCH.objective,
    botLook: 'procedural',
  };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    s.mode = parseMode(raw.mode) ?? s.mode;
    if ((BOT_COUNT_OPTIONS as readonly unknown[]).includes(raw.bots)) s.bots = raw.bots as number;
    if ((TIME_LIMIT_OPTIONS as readonly unknown[]).includes(raw.timeLimit)) s.timeLimit = raw.timeLimit as number;
    if ((KILL_TARGET_OPTIONS as readonly unknown[]).includes(raw.killTarget)) s.killTarget = raw.killTarget as number;
    if ((ROUNDS_TO_WIN_OPTIONS as readonly unknown[]).includes(raw.roundsToWin)) s.roundsToWin = raw.roundsToWin as number;
    if ((ROUND_TIME_OPTIONS as readonly unknown[]).includes(raw.roundTime)) s.roundTime = raw.roundTime as number;
    s.objective = parseObjective(raw.objective) ?? s.objective;
    if (raw.botLook === 'procedural' || raw.botLook === 'agents') s.botLook = raw.botLook;
  } catch {
    // Defaults.
  }
  return s;
}

export function saveMatchSettings(s: MatchSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Storage blocked: applies for this session only.
  }
}
