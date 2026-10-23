import type { FireMode, WeaponDefinition, WeaponViewSpec } from './WeaponDefinition';
import { AR_01, KARAMBIT, PIS_01, SG_01, SMG_01, SR_01 } from './weapons';

// Single catalog of everything the team match buy menu can show: weapons
// (implemented or planned) and tactical equipment. Prices live here and
// nowhere else. Weapon stats of implemented items are read from their
// WeaponDefinition (weapons.ts), so the card always matches what is issued.
//
// An item can only be bought when it is `available`: a weapon needs a real
// WeaponDefinition (firing logic, model, sounds); equipment needs the game
// system it relies on. Everything else is listed as locked ("준비 중") so the
// menu, the IDs and the prices are in place for when it lands.

/** Where an item goes in the loadout (one of each, the knife is always there). */
export type ItemSlot = 'primary' | 'secondary' | 'melee' | 'armor' | 'utility';
export type ItemCategory = 'rifle' | 'sniper' | 'smg' | 'shotgun' | 'pistol' | 'knife' | 'armor' | 'grenade';

export interface CatalogItem {
  /** Catalog / shop id ('AR-01', 'Knife', 'ARMOR-01', ...). */
  id: string;
  /** Short description shown under the code. */
  name: string;
  slot: ItemSlot;
  category: ItemCategory;
  /** Dollars; 0 = issued for free. */
  price: number;
  /** The weapon the player is given (null for equipment and unimplemented weapons). */
  weapon: WeaponDefinition | null;
  /** Can be bought now. */
  available: boolean;
  /** Why it cannot be bought yet (locked items). */
  lockedReason?: string;
  /** Planned stats of a weapon that is not implemented yet (shown as "예정"). */
  planned?: { fireMode: FireMode; magazineSize: number; reserveAmmo: number };
  /**
   * Model of a weapon that is not implemented yet, used only for its buy
   * menu picture (not issued, no first-person pose tuned).
   */
  preview?: WeaponViewSpec;
}

export const CATALOG: readonly CatalogItem[] = [
  { id: 'AR-01', name: '돌격소총', slot: 'primary', category: 'rifle', price: 2700, weapon: AR_01, available: true },
  // Price is GRID's proposal for the existing bolt-action rifle (one-shot body, slow).
  { id: 'SR-01', name: '저격소총', slot: 'primary', category: 'sniper', price: 4750, weapon: SR_01, available: true },
  { id: 'SMG-01', name: '기관단총', slot: 'primary', category: 'smg', price: 1500, weapon: SMG_01, available: true },
  { id: 'SG-01', name: '산탄총 (8펠릿)', slot: 'primary', category: 'shotgun', price: 2000, weapon: SG_01, available: true },
  { id: 'PIS-01', name: '권총', slot: 'secondary', category: 'pistol', price: 500, weapon: PIS_01, available: true },
  { id: 'Knife', name: '근접 무기 (M9 총검)', slot: 'melee', category: 'knife', price: 0, weapon: KARAMBIT, available: true },
  // Armour points and absorption: ARMOR_CONFIG (config.ts). Body only (there is no helmet).
  { id: 'ARMOR-01', name: '방탄 조끼 (몸통)', slot: 'armor', category: 'armor', price: 650, weapon: null, available: true },
  { id: 'FLASH-01', name: '섬광탄', slot: 'utility', category: 'grenade', price: 300, weapon: null, available: false, lockedReason: '준비 중: 투척·섬광 효과 미구현' },
  { id: 'SMOKE-01', name: '연막탄', slot: 'utility', category: 'grenade', price: 400, weapon: null, available: false, lockedReason: '준비 중: 투척·연막 시야 차단 미구현' },
];

/** The free melee item every loadout starts with. */
export const DEFAULT_MELEE_ID = 'Knife';

export function findItem(id: string): CatalogItem | undefined {
  return CATALOG.find((i) => i.id === id);
}

/** Magazine / reserve / fire mode of an item: the real weapon's when implemented, the planned ones otherwise. */
export function itemStats(item: CatalogItem): { fireMode: FireMode; magazineSize: number; reserveAmmo: number; fireRate?: number; damage?: number } | null {
  if (item.weapon) {
    const w = item.weapon;
    return { fireMode: w.fireMode, magazineSize: w.magazineSize, reserveAmmo: w.reserveAmmo, fireRate: w.fireRate, damage: w.damage.base };
  }
  return item.planned ?? null;
}
