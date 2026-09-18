/* arenas: geometry, spawns and whether a bot could actually walk the map */
import { test, assert, equal, near } from './harness.js';
import { MAPS, MAP_LIST } from '../public/src/world/mapData.js';
import { World } from '../public/src/world/collision.js';
import { NavGrid } from '../public/src/world/nav.js';
import { RULES } from '../public/src/game/rules.js';

test('three arenas exist and carry the fields the game reads', () => {
  assert(MAP_LIST.length >= 3, 'expected at least three maps');
  for (const id of MAP_LIST) {
    const m = MAPS[id];
    for (const key of ['name', 'sx', 'sz', 'theme', 'mats', 'boxes', 'spawnsA', 'spawnsB', 'ffaSpots']) {
      assert(m[key] !== undefined, id + ' is missing ' + key);
    }
    assert(m.spawnsA.length >= 5 && m.spawnsB.length >= 5, id + ' needs 5 spawns per side');
    assert(m.ffaSpots.length >= 6, id + ' needs free-for-all spots');
  }
});

test('every box is well formed', () => {
  for (const id of MAP_LIST) {
    for (const b of MAPS[id].boxes) {
      assert(b.length >= 7, id + ' box too short: ' + b);
      assert(b.every((v, i) => i >= 5 || Number.isFinite(v)), id + ' box has a bad number: ' + b);
      assert(b[2] > 0 && b[3] > 0 && b[4] > 0, id + ' box has no volume: ' + b);
      assert('sfcn'.includes(b[5]), id + ' unknown box kind ' + b[5]);
      assert(MAPS[id].mats[b[6]] !== undefined, id + ' box uses unknown material ' + b[6]);
    }
  }
});

test('spawn points are clear of geometry and inside the arena', () => {
  for (const id of MAP_LIST) {
    const m = MAPS[id], w = new World(m);
    const all = m.spawnsA.concat(m.spawnsB, m.ffaSpots);
    for (const [x, z] of all) {
      assert(Math.abs(x) < m.sx && Math.abs(z) < m.sz, id + ' spawn outside arena: ' + x + ',' + z);
      const y = w.supportAt(x, z, 1e4, 0.42);
      assert(w.blockedAt(x, z, 0.42, y, y + RULES.standHeight) < 0, id + ' spawn inside a wall: ' + x + ',' + z);
      assert(y < 2.1, id + ' spawn sits on top of geometry (' + x + ',' + z + ' at y=' + y + ')');
    }
  }
});

test('each side spawns on its own half, mirrored', () => {
  for (const id of MAP_LIST) {
    const m = MAPS[id];
    assert(m.spawnsA.every((s) => s[1] < 0), id + ' team A must spawn at -Z');
    assert(m.spawnsB.every((s) => s[1] > 0), id + ' team B must spawn at +Z');
    equal(m.spawnsA.length, m.spawnsB.length, id + ' spawn counts differ');
  }
});

test('every spawn can walk to every other spawn', () => {
  for (const id of MAP_LIST) {
    const m = MAPS[id], w = new World(m), nav = new NavGrid(w);
    const pts = m.spawnsA.concat(m.spawnsB, m.ffaSpots);
    const from = pts[0];
    for (const to of pts.slice(1)) {
      const p = nav.path(from[0], from[1], to[0], to[1], 6000);
      assert(p && p.length, id + ' no path from ' + from + ' to ' + to);
    }
  }
});

test('the arena floor is reachable and walls block sight', () => {
  const w = new World(MAPS.shrine);
  near(w.supportAt(2.5, 2.5, 1e4, 0.4), 1.4, 0.01, 'the altar terrace should be 1.4 high');
  assert(w.segBlocked(0, 1.5, 0, 0, 1.5, 40), 'the shell wall should block a ray leaving the arena');
  assert(!w.segBlocked(-20, 1.5, -6, -20, 1.5, -2), 'open ground should not block sight');
});

test('movement steps up stairs but not up walls', () => {
  const w = new World(MAPS.shrine);
  const ent = { pos: { x: 0, y: 0, z: 11.5 }, radius: 0.42, height: 1.8, onGround: true };
  for (let i = 0; i < 40; i++) w.moveXZ(ent, 0, -0.25);
  assert(ent.pos.y > 1.0, 'walking into the terrace stairs should climb them, got y=' + ent.pos.y);

  const wall = { pos: { x: 0, y: 0, z: -29 }, radius: 0.42, height: 1.8, onGround: true };
  for (let i = 0; i < 20; i++) w.moveXZ(wall, 0, -0.25);
  assert(wall.pos.y < 0.6, 'the arena shell must not be climbable');
  assert(wall.pos.z > -MAPS.shrine.sz, 'the shell must hold the player inside');
});

test('raycast reports a hit distance and a normal', () => {
  const w = new World(MAPS.shrine);
  const d = w.raycast(0, 2.4, 10, 0, 0, -1, 40);
  assert(d < 40, 'the altar core should stop this ray');
  assert(Math.abs(w.hitNormal.z) === 1, 'expected a Z facing normal, got ' + JSON.stringify(w.hitNormal));
});

test('navigation marks cover next to tall geometry', () => {
  const w = new World(MAPS.market), nav = new NavGrid(w);
  let cover = 0, walk = 0;
  for (let i = 0; i < nav.walk.length; i++) { if (nav.walk[i]) walk++; if (nav.cover[i]) cover++; }
  assert(walk > 400, 'market should have plenty of walkable cells, got ' + walk);
  assert(cover > 20, 'market should offer cover cells, got ' + cover);
});
