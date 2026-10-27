import { InventoryService } from './InventoryService';
import { findSkin, SKIN_CATALOG } from './SkinCatalog';
import { WalletService } from './WalletService';
import type { AccountState, EconomyError, OwnedItem, SkinDef } from './types';

/** Products on sale and the purchase itself. The price always comes from the catalog. */
export const ShopService = {
  listings(catalog: readonly SkinDef[] = SKIN_CATALOG): SkinDef[] {
    return catalog.filter((s) => s.onSale && !s.isDefault);
  },

  /** Why `skinId` cannot be bought right now (null = it can). */
  check(a: AccountState, skinId: string): EconomyError | null {
    const skin = typeof skinId === 'string' ? findSkin(skinId) : undefined;
    if (!skin) return 'unknown_item';
    if (!skin.onSale || skin.isDefault) return 'not_for_sale';
    if (!Number.isInteger(skin.price) || skin.price < 0) return 'invalid_request';
    if (InventoryService.ownsSkin(a, skin.skinId)) return 'owned';
    if (!WalletService.canAfford(a, skin.price)) return 'insufficient_funds';
    return null;
  },

  /** Charges the catalog price and adds the item, both on the same draft (committed together or not at all). */
  buy(a: AccountState, skinId: string, at: string, requestId: string): { error: EconomyError } | { item: OwnedItem } {
    const error = this.check(a, skinId);
    if (error) return { error };
    const skin = findSkin(skinId)!;
    WalletService.apply(a, -skin.price, 'purchase', skin.skinId, at, requestId);
    return { item: InventoryService.add(a, skin.skinId, 'purchase', at) };
  },
};
