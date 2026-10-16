import { BOT_COUNT_OPTIONS, DEFAULT_MATCH, KILL_TARGET_OPTIONS, TIME_LIMIT_OPTIONS, type GameMode, type MatchConfig } from './Match';

// Mode and match rules, stored apart from the settings record (whose format stays as is).

export interface MatchSettings extends MatchConfig {
  mode: GameMode;
}

const KEY = 'tactical-fps.match.v1';

export function parseMode(v: unknown): GameMode | null {
  return v === 'deathmatch' || v === 'training' ? v : null;
}

export function loadMatchSettings(): MatchSettings {
  const s: MatchSettings = { mode: 'deathmatch', ...DEFAULT_MATCH };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    s.mode = parseMode(raw.mode) ?? s.mode;
    if ((BOT_COUNT_OPTIONS as readonly unknown[]).includes(raw.bots)) s.bots = raw.bots as number;
    if ((TIME_LIMIT_OPTIONS as readonly unknown[]).includes(raw.timeLimit)) s.timeLimit = raw.timeLimit as number;
    if ((KILL_TARGET_OPTIONS as readonly unknown[]).includes(raw.killTarget)) s.killTarget = raw.killTarget as number;
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
