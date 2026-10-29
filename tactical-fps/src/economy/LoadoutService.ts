import { InventoryService } from './InventoryService';
import { defaultSkin, findSkin, slotKey } from './SkinCatalog';
import type { AccountState, EconomyError, SkinCategory, SkinDef } from './types';

/**
 * What is equipped per slot (`weapon:ar01`, `knife:karambit`,
 * `gloves:player`, `character:player`). Only owned items that fit the slot
 * can be equipped; an empty slot shows the default look.
 */
export const LoadoutService = {
  /** The skin shown in a slot: the equipped one, else the slot's default. */
  equipped(a: AccountState, category: SkinCategory, target: string, catalog?: readonly SkinDef[]): SkinDef | undefined {
    const itemId = a.loadout[slotKey(category, target)];
    const item = itemId ? InventoryService.find(a, itemId) : undefined;
    const skin = item ? findSkin(item.skinId) : undefined;
    return skin ?? defaultSkin(category, target, catalog);
  },

  /** Puts `itemId` in the slot (null = back to the default). Returns an error code, or null when done. */
  equip(a: AccountState, category: SkinCategory, target: string, itemId: string | null): EconomyError | null {
    const slot = slotKey(category, target);
    if (!defaultSkin(category, target)) return 'invalid_request';
    if (itemId === null) {
      delete a.loadout[slot];
      return null;
    }
    const item = InventoryService.find(a, itemId);
    if (!item) return 'not_owned';
    const skin = findSkin(item.skinId);
    if (!skin) return 'unknown_item';
    if (skin.category !== category || !skin.targets.includes(target)) return 'incompatible';
    a.loadout[slot] = itemId;
    return null;
  },
};
