/* =============================================================================
   match rules and the damage maths every side agrees on.
   ========================================================================== */
import { clamp, lerp } from '../core/math.js';

export const MODES = {
  tdm: {
    id: 'tdm', name: '팀 데스매치', latin: 'TEAM DEATHMATCH', teams: true, ffa: false,
    target: 30, respawn: 4.0, maxPlayers: 10, teamSize: 5, botFill: 8,
    desc: '두 팀이 먼저 처치 수를 채우면 승리. 5대5까지.'
  },
  ffa: {
    id: 'ffa', name: '개인전', latin: 'FREE FOR ALL', teams: false, ffa: true,
    target: 16, respawn: 3.4, maxPlayers: 8, teamSize: 1, botFill: 6,
    desc: '전원이 적. 가장 먼저 목표 처치 수를 채운 사람이 승리.'
  },
  duel: {
    id: 'duel', name: '결투', latin: 'DUEL', teams: true, ffa: false,
    target: 8, respawn: 2.8, maxPlayers: 2, teamSize: 1, botFill: 2,
    desc: '1대1. 조준과 술식 운용만으로 승부한다.'
  }
};
export const MODE_LIST = Object.keys(MODES);
export function getMode(id) { return MODES[id] || MODES.tdm; }

/* ---- shared combat constants --------------------------------------------- */
export const RULES = {
  standHeight: 1.8,
  crouchHeight: 1.15,
  eyeDrop: 0.18,               // eye sits this far below the top of the capsule
  gravity: 21.5,
  maxFall: 42,
  sprintMul: 1.28,
  crouchMul: 0.5,
  airControl: 0.45,
  headTop: 0.34,               // head hitbox covers the top 0.34 m of the capsule
  ult: {
    max: 100,
    perDamage: 0.30,           // charge per point of damage dealt
    perDamageTaken: 0.14,
    perKill: 20,
    perAssist: 8,
    perSecond: 1.4
  },
  spawnProtect: 1.2,           // seconds of reduced damage right after respawning
  spawnProtectMul: 0.45,
  killStreakWindow: 4.5
};

/* range falloff: [start, end, floor] */
export function falloffMul(spec, dist) {
  if (!spec) return 1;
  const [a, b, floor] = spec;
  if (dist <= a) return 1;
  return lerp(1, floor, clamp((dist - a) / (b - a), 0, 1));
}

/* the one place damage is shaped, so client prediction and the server agree */
export function shapeDamage(base, opts = {}) {
  let d = base;
  if (opts.falloff) d *= falloffMul(opts.falloff, opts.dist || 0);
  if (opts.head) d *= opts.headMul || 1.5;
  if (opts.attackerMul) d *= opts.attackerMul;
  if (opts.victimMul) d *= opts.victimMul;
  return Math.max(0, Math.round(d));
}

export function fireInterval(weapon) { return 60 / (weapon.rpm || 120); }
