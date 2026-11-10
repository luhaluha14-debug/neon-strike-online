import { creditedDamage } from './Match';

// The player's personal combat record for the match being played: kills,
// deaths, K/D, headshot kills and damage dealt. In a match (deathmatch, team
// rounds, single player or online) it is the player's own score line, which
// only the match authority writes (the host's Match / TeamMatch, as damage
// and deaths are applied there; a room member shows the host's numbers). In
// training it is a separate record of the dummies (never mixed with matches).

export interface CombatStats {
  kills: number;
  deaths: number;
  /** Kills whose final hit was to the head (the kill feed's HS). */
  headshots: number;
  /** Health actually taken from enemies (after armour, capped at what they had left). */
  damage: number;
}

/** Kills per death; with no deaths, the kills themselves (as tactical shooters show it). */
export function kdRatio(kills: number, deaths: number): number {
  return deaths > 0 ? kills / deaths : kills;
}

/** K/D with two decimals. */
export function formatKd(kills: number, deaths: number): string {
  return kdRatio(kills, deaths).toFixed(2);
}

/**
 * Training (dummies): its own record, started again whenever training starts. The player cannot die
 * there, so deaths stay 0. Fed by the dummies themselves as each hit is applied.
 */
export class TrainingStats implements CombatStats {
  kills = 0;
  deaths = 0;
  headshots = 0;
  damage = 0;

  /** A hit on a dummy by the player: `applied` health it took, `killed` when it took it down. */
  hit(applied: number, killed: boolean, head: boolean): void {
    this.damage += creditedDamage(applied);
    if (killed) {
      this.kills++;
      if (head) this.headshots++;
    }
  }

  reset(): void {
    this.kills = this.deaths = this.headshots = this.damage = 0;
  }
}
