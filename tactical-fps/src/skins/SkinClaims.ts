import { findSkin, KNIFE_TARGET, SKIN_WEAPON_TARGETS } from '../economy/SkinCatalog';
import type { AccountState, SkinDef } from '../economy/types';
import { LoadoutService } from '../economy/LoadoutService';

// What a player says it has equipped on its weapons, as it travels in a multiplayer room (Phase 26-C).
//
// Ownership lives in each player's own browser record (grid.account.v1): the account server is off and
// not deployed, so nobody in a room can prove what another player owns. A claim is therefore checked for
// what can be checked — the skin is a registered one, a weapon (or knife) skin, and fits the weapon it is
// claimed for — and anything else shows the weapon's default look. A passed claim is a cosmetic only: it
// never says the skin is owned, and it never touches damage, rate of fire, recoil or hits.
//
// The check is one function behind an interface, so an account server (once there is one) can be put in
// its place to verify ownership as well (a server-signed list of the equipped skins, say).

/** Weapon id → skin id, for the weapons that wear a non-default skin. */
export type SkinClaims = Record<string, string>;

/** Weapons a claim may name: the skinnable guns and the knife. */
export const CLAIM_TARGETS: readonly string[] = [...SKIN_WEAPON_TARGETS, KNIFE_TARGET];
/** More entries than weapons there are is not a real claim. */
export const MAX_CLAIMS = CLAIM_TARGETS.length;

export interface SkinClaimVerifier {
  /** What the claim may show (never more than it says; unknown / misfit / malformed entries dropped). */
  verify(raw: unknown): SkinClaims;
}

/** Does `skin` dress `weaponId`? (A registered weapon / knife skin of that weapon; defaults need no claim.) */
export function skinFits(skin: SkinDef | undefined, weaponId: string): skin is SkinDef {
  if (!skin || skin.isDefault || !skin.targets.includes(weaponId)) return false;
  return weaponId === KNIFE_TARGET ? skin.category === 'knife' : skin.category === 'weapon';
}

/**
 * The check that can be made without an account server: registered skins on the weapons they fit.
 * Ownership is NOT verified here (see above).
 */
export const catalogClaimVerifier: SkinClaimVerifier = {
  verify(raw: unknown): SkinClaims {
    const out: SkinClaims = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    let n = 0;
    for (const [weaponId, skinId] of Object.entries(raw as Record<string, unknown>)) {
      if (++n > MAX_CLAIMS) break;
      if (typeof skinId !== 'string' || skinId.length > 64 || !CLAIM_TARGETS.includes(weaponId)) continue;
      if (skinFits(findSkin(skinId), weaponId)) out[weaponId] = skinId;
    }
    return out;
  },
};

/** This player's own claim: the non-default skins its record has equipped (owned ones only: LoadoutService). */
export function ownClaims(a: AccountState | null): SkinClaims {
  const out: SkinClaims = {};
  if (!a) return out;
  for (const w of CLAIM_TARGETS) {
    const s = LoadoutService.equipped(a, w === KNIFE_TARGET ? 'knife' : 'weapon', w);
    if (s && !s.isDefault) out[w] = s.skinId;
  }
  return out;
}

/**
 * The look a character holding `weaponId` shows for a snapshot's skin id (Phase 27): only a registered skin of
 * that very weapon (a knife skin or knife item on the knife); anything else — unknown, another weapon's — is
 * the default look.
 */
export function heldAsset(skinId: unknown, weaponId: string): string | undefined {
  const s = typeof skinId === 'string' && skinId ? findSkin(skinId) : undefined;
  return skinFits(s, weaponId) ? s.assetId : undefined;
}

/** A skin id as shown on a character in a snapshot (the host already checked it): its look, or the default. */
export function shownAsset(skinId: unknown): string | undefined {
  const s = typeof skinId === 'string' && skinId ? findSkin(skinId) : undefined;
  return s && !s.isDefault && (s.category === 'weapon' || s.category === 'knife') ? s.assetId : undefined;
}
