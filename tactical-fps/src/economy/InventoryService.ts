import type { AccountState, OwnedItem } from './types';

/** Skins the account owns (one instance per skin). Works on a draft account. */
export const InventoryService = {
  items(a: AccountState): readonly OwnedItem[] {
    return a.items;
  },

  find(a: AccountState, itemId: string): OwnedItem | undefined {
    return a.items.find((i) => i.itemId === itemId);
  },

  ownsSkin(a: AccountState, skinId: string): boolean {
    return a.items.some((i) => i.skinId === skinId);
  },

  /** Adds a new instance of `skinId`. Throws if the account already has one. */
  add(a: AccountState, skinId: string, source: OwnedItem['source'], at: string): OwnedItem {
    if (this.ownsSkin(a, skinId)) throw new Error(`already owned: ${skinId}`);
    a.seq++;
    const item: OwnedItem = { itemId: `${a.accountId}-item-${a.seq}`, skinId, acquiredAt: at, source };
    a.items.push(item);
    return item;
  },

  /** Removes an instance (a trade moving it away); its loadout slot falls back to the default. */
  remove(a: AccountState, itemId: string): OwnedItem | undefined {
    const i = a.items.findIndex((x) => x.itemId === itemId);
    if (i < 0) return undefined;
    const [item] = a.items.splice(i, 1);
    for (const [slot, id] of Object.entries(a.loadout)) if (id === itemId) delete a.loadout[slot];
    return item;
  },
};
