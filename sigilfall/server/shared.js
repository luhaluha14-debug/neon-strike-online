/* =============================================================================
   the server loads the very same data and geometry modules the browser does,
   so a shot is judged against the arena the player is actually looking at.
   nothing here is duplicated from the client.
   ========================================================================== */
import { MAPS, MAP_LIST } from '../public/src/world/mapData.js';
import { World } from '../public/src/world/collision.js';
import { NavGrid } from '../public/src/world/nav.js';
import { CHARACTERS, CHARACTER_LIST, abilityOf, CHARMS, CHARM_LIST, getCharm } from '../public/src/characters/roster.js';
import { MODES, MODE_LIST, RULES, falloffMul, fireInterval } from '../public/src/game/rules.js';

const worlds = new Map();
const navs = new Map();

export function worldFor(mapId) {
  if (!worlds.has(mapId)) worlds.set(mapId, new World(MAPS[mapId]));
  return worlds.get(mapId);
}
export function navFor(mapId) {
  if (!navs.has(mapId)) navs.set(mapId, new NavGrid(worldFor(mapId)));
  return navs.get(mapId);
}

export { MAPS, MAP_LIST, CHARACTERS, CHARACTER_LIST, abilityOf, CHARMS, CHARM_LIST, getCharm, MODES, MODE_LIST, RULES, falloffMul, fireInterval };
