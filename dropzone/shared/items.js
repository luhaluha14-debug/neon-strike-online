/* =========================================================================
   Item catalogue + loot tables + inventory rules.
   Inventory model (prototype):
     - 4 weapon slots: [primary, primary, sidearm, melee]
     - a backpack of stackable items limited by total weight (capacity)
   ========================================================================= */
import { AMMO, WEAPONS } from './weapons.js';

export const BASE_CAPACITY = 100;

export const ITEMS = {};
for (const k in AMMO) ITEMS['ammo_' + k] = { kind: 'ammo', ammo: k, name: AMMO[k].name, weight: AMMO[k].weight, stack: AMMO[k].stack, color: AMMO[k].color };
for (const k in WEAPONS) if (k !== 'fists') ITEMS[k] = { kind: 'weapon', weapon: k, name: WEAPONS[k].name, weight: 0, color: '#d0d6dc' };
Object.assign(ITEMS, {
  bandage: { kind: 'heal', name: '압박붕대', weight: 2, stack: 3, useTime: 3.5, heal: 15, maxTo: 75, color: '#e8e2d2' },
  medkit: { kind: 'heal', name: '구급 키트', weight: 10, stack: 1, useTime: 7, heal: 100, maxTo: 100, color: '#e05656' }
});

/* loot tables: weighted entries, each yields a list of [itemKey, count] */
const T = (w, drops) => ({ w, drops });
export const LOOT_TABLES = {
  0: [T(30, [['ammo_light', 30]]), T(25, [['ammo_pistol', 30]]), T(20, [['bandage', 3]]), T(12, [['hornet', 1], ['ammo_pistol', 20]]), T(8, [['ammo_shell', 10]]), T(5, [['wasp', 1], ['ammo_pistol', 30]])],
  1: [
    T(16, [['kestrel', 1], ['ammo_light', 30], ['ammo_light', 30]]),
    T(14, [['wasp', 1], ['ammo_pistol', 30], ['ammo_pistol', 30]]),
    T(12, [['breaker', 1], ['ammo_shell', 10]]),
    T(12, [['hornet', 1], ['ammo_pistol', 20]]),
    T(18, [['ammo_light', 30]]), T(12, [['ammo_pistol', 30]]), T(6, [['ammo_shell', 10]]),
    T(16, [['bandage', 3]]), T(5, [['medkit', 1]])
  ],
  2: [
    T(26, [['kestrel', 1], ['ammo_light', 30], ['ammo_light', 30]]),
    T(14, [['wasp', 1], ['ammo_pistol', 30], ['ammo_pistol', 30]]),
    T(10, [['breaker', 1], ['ammo_shell', 10]]),
    T(16, [['ammo_light', 30]]), T(14, [['bandage', 3]]), T(10, [['medkit', 1]])
  ],
  3: [T(30, [['kestrel', 1], ['ammo_light', 30], ['ammo_light', 30]]), T(20, [['medkit', 1]]), T(20, [['ammo_light', 30], ['bandage', 3]])]
};

export function rollLoot(rng, tier) {
  const table = LOOT_TABLES[Math.max(0, Math.min(3, tier))];
  let total = 0;
  for (const e of table) total += e.w;
  let r = rng.next() * total;
  for (const e of table) { r -= e.w; if (r <= 0) return e.drops; }
  return table[0].drops;
}

/* ---------------- inventory helpers (operate on a player-like object) ---------------- */
export function newInventory() {
  return { items: {}, capacity: BASE_CAPACITY };
}
export function invWeight(inv) {
  let w = 0;
  for (const k in inv.items) w += (ITEMS[k] ? ITEMS[k].weight : 0) * inv.items[k];
  return w;
}
/** how many of `key` still fit */
export function invRoomFor(inv, key) {
  const it = ITEMS[key];
  if (!it || it.weight <= 0) return Infinity;
  return Math.max(0, Math.floor((inv.capacity - invWeight(inv)) / it.weight + 1e-6));
}
/** add up to count, returns amount actually added */
export function invAdd(inv, key, count) {
  const n = Math.min(count, invRoomFor(inv, key));
  if (n > 0) inv.items[key] = (inv.items[key] || 0) + n;
  return n;
}
export function invTake(inv, key, count) {
  const have = inv.items[key] || 0;
  const n = Math.min(have, count);
  if (n <= 0) return 0;
  if (have - n <= 0) delete inv.items[key]; else inv.items[key] = have - n;
  return n;
}
export function invCount(inv, key) { return inv.items[key] || 0; }
