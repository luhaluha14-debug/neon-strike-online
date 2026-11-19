import type { Platform } from '../net/Protocol';

// Per-platform record of this browser's own finished matches (Phase 28): how this player does on PC
// controls and on touch, kept apart. It is the structure a fair comparison needs (matches, wins, kills,
// deaths, time, per platform and mode); it only ever counts what this browser played, so it says
// nothing about all players. Win rates over many players would need results collected by a server the
// game does not run yet (the account server is off) — nothing here pretends otherwise.

const KEY = 'grid.platform-stats.v1';

export interface PlatformRecord {
  matches: number;
  wins: number;
  kills: number;
  deaths: number;
  /** Seconds played in those matches. */
  seconds: number;
}

export type PlatformStats = Record<Platform, Record<'deathmatch' | 'team', PlatformRecord>>;

function empty(): PlatformRecord {
  return { matches: 0, wins: 0, kills: 0, deaths: 0, seconds: 0 };
}

export function emptyPlatformStats(): PlatformStats {
  return { pc: { deathmatch: empty(), team: empty() }, mobile: { deathmatch: empty(), team: empty() } };
}

/** A stored record as it may be read back: anything not a count falls back to 0. */
export function sanitizePlatformStats(raw: unknown): PlatformStats {
  const out = emptyPlatformStats();
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, Record<string, Record<string, unknown>>>;
  for (const p of ['pc', 'mobile'] as const)
    for (const m of ['deathmatch', 'team'] as const)
      for (const k of Object.keys(out[p][m]) as (keyof PlatformRecord)[]) {
        const v = r[p]?.[m]?.[k];
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[p][m][k] = Math.floor(v);
      }
  return out;
}

export function loadPlatformStats(): PlatformStats {
  try {
    return sanitizePlatformStats(JSON.parse(localStorage.getItem(KEY) ?? '{}'));
  } catch {
    return emptyPlatformStats();
  }
}

/** One finished match on `platform` (only completed matches count, as for GRID rewards). */
export function recordPlatformMatch(platform: Platform, mode: 'deathmatch' | 'team', r: { won: boolean; kills: number; deaths: number; seconds: number }): PlatformStats {
  const s = loadPlatformStats();
  const x = s[platform][mode];
  x.matches++;
  if (r.won) x.wins++;
  x.kills += Math.max(0, Math.floor(r.kills));
  x.deaths += Math.max(0, Math.floor(r.deaths));
  x.seconds += Math.max(0, Math.floor(r.seconds));
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Storage blocked: this match just isn't counted.
  }
  return s;
}

/** Plain text for the settings page (counts this browser recorded; no estimates). */
export function describePlatformStats(s: PlatformStats): string {
  const line = (p: Platform, label: string) => {
    const a = s[p].deathmatch;
    const b = s[p].team;
    const n = a.matches + b.matches;
    if (n === 0) return `${label}: 기록 없음`;
    const w = a.wins + b.wins;
    const k = a.kills + b.kills;
    const d = a.deaths + b.deaths;
    return `${label}: ${n}경기 · ${w}승 (${Math.round((w / n) * 100)}%) · ${k}킬 ${d}데스 (K/D ${(k / Math.max(1, d)).toFixed(2)})`;
  };
  return `${line('pc', 'PC')} / ${line('mobile', '모바일')} — 이 브라우저에서 끝까지 마친 경기만 셉니다.`;
}
