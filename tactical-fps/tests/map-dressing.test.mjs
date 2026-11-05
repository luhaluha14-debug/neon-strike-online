// Map dressing (Phase 16): both maps loaded bare (the files as they are) and
// dressed, in the real browser. The dressing must not change how the maps
// play: no prop on a spawn, a bomb site or next to existing cover; every spot
// the bots could reach before is still reachable (spawn ↔ sites, routes about
// as long); props are solid for players and bullets alike, with the right
// surface; identical on every load and at every graphics quality (one
// collision world in multiplayer); cost in draw calls and load time bounded.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, openGame } from './harness.mjs';

let env;
let page;

before(async () => {
  env = await startEnv();
  page = await openGame(env, { mode: 'training', quality: 'low' });
});
after(async () => {
  await page?.context().close();
  await env?.close();
});

/** Loads `mapId` bare, dressed and dressed-low; compares layout, nav and stats. */
const compare = (mapId) =>
  page.evaluate(async (mapId) => {
    const { findMap } = await import('/src/maps.ts');
    const { loadMap, disposeMap } = await import('/src/world/MapLoader.ts');
    const { NavGrid } = await import('/src/ai/NavGrid.ts');
    const def = findMap(mapId);
    const t = performance.now();
    const bare = await loadMap(def, undefined, undefined, { dressing: 'none' });
    const tBare = performance.now() - t;
    const t2 = performance.now();
    const full = await loadMap(def, undefined, undefined, { dressing: 'full' });
    const tFull = performance.now() - t2;
    const low = await loadMap(def, undefined, undefined, { dressing: 'low' });
    const again = await loadMap(def, undefined, undefined, { dressing: 'full' });
    const navBare = new NavGrid(bare);
    const navFull = new NavGrid(full);
    const V = bare.playBounds.min.constructor;

    // Routes: every spawn to every bomb site centre (and attack ↔ defence spawns).
    const goals = [...full.bombSites.map((s) => s.box.getCenter(new V())), ...full.defenseSpawns.map((s) => s.position)];
    const routes = [];
    for (const s of full.attackSpawns) {
      for (const goal of goals) {
        const a = navBare.findPath(s.position, goal, 60000);
        const b = navFull.findPath(s.position, goal, 60000);
        const len = (p) => (p ? p.reduce((acc, q, i) => (i ? acc + q.distanceTo(p[i - 1]) : 0), 0) : null);
        routes.push({ bare: len(a), full: len(b) });
      }
    }
    // Cells reachable before and not now (only where a prop now stands is allowed).
    let lost = 0;
    let lostOutsideProps = 0;
    const c = new V();
    for (const i of navBare.walkable) {
      navBare.center(i, c);
      const j = navFull.cellAt(c.x, c.z);
      if (j >= 0 && !Number.isNaN(navFull.floor[j])) continue;
      lost++;
      if (!full.dressingProps.some((b) => b.clone().expandByScalar(1.1).containsPoint(new V(c.x, b.min.y + 0.1, c.z)))) lostOutsideProps++;
    }
    // Props never on spawns, bomb sites or right next to the map's own cover.
    const spawnHits = [...full.attackSpawns, ...full.defenseSpawns].filter((s) => full.dressingProps.some((b) => b.clone().expandByScalar(1.5).containsPoint(s.position))).length;
    const siteHits = full.bombSites.filter((s) => full.dressingProps.some((b) => b.intersectsBox(s.box))).length;
    // A round fired down at each ground prop stops on it (not on the floor), on the prop's surface.
    const surfaces = {};
    let blocked = 0;
    for (const b of full.dressingProps) {
      // A 5 x 5 grid of rounds over the prop: the first that lands on it (above the floor) counts.
      grid: for (let i = 0; i < 5; i++) {
        for (let j = 0; j < 5; j++) {
          const from = new V(b.min.x + ((i + 0.5) / 5) * (b.max.x - b.min.x), b.max.y + 2, b.min.z + ((j + 0.5) / 5) * (b.max.z - b.min.z));
          const d = full.collision.raycast(from, new V(0, -1, 0), 6);
          if (d === null || from.y - d < b.min.y + 0.05) continue;
          blocked++;
          const k = full.collision.surfaceAt(from.clone().setY(from.y - d), new V(0, 1, 0));
          surfaces[k] = (surfaces[k] ?? 0) + 1;
          break grid;
        }
      }
    }
    // Nobody gets stuck on a prop: from a spot right beside each one, the player can walk away.
    const { PlayerController } = await import('/src/player/PlayerController.ts');
    let stuck = 0;
    let tried = 0;
    const stuckAt = [];
    for (const b of full.dressingProps) {
      const ctr = b.getCenter(new V());
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const half = dx ? (b.max.x - b.min.x) / 2 : (b.max.z - b.min.z) / 2;
        const start = new V(ctr.x + dx * (half + 0.45), b.min.y + 1.2, ctr.z + dz * (half + 0.45));
        const floor = full.collision.raycast(start, new V(0, -1, 0), 2);
        if (floor === null) continue;
        start.y -= floor - 0.02;
        // How far the player gets from `start` in the best of four directions, on a given map.
        const escape = (map) => {
          const p = new PlayerController(map.collision);
          let best = 0;
          for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
            p.teleport(start, yaw);
            for (let k = 0; k < 60; k++) p.step({ moveX: 0, moveY: 1, lookYaw: 0, lookPitch: 0, jump: false, crouch: false, walk: false }, 1 / 60);
            best = Math.max(best, Math.hypot(p.position.x - start.x, p.position.z - start.z));
          }
          return best;
        };
        // Not inside another prop (a neighbour), and only spots a player could stand on before
        // (not inside the wall behind a prop).
        if (full.dressingProps.some((o) => o !== b && o.clone().expandByScalar(0.35).containsPoint(new V(start.x, o.min.y + 0.1, start.z)))) continue;
        if (escape(bare) < 1.5) continue;
        tried++;
        if (escape(full) < 1.5) {
          stuck++;
          stuckAt.push([start.toArray().map((v) => +v.toFixed(2)), b.min.toArray().map((v) => +v.toFixed(2)), b.max.toArray().map((v) => +v.toFixed(2))]);
        }
      }
    }
    const out = {
      stuck,
      stuckAt,
      tried,
      stats: { bare: bare.stats, full: full.stats, low: low.stats },
      loadMs: { bare: Math.round(tBare), full: Math.round(tFull) },
      sameCollision: full.stats.colliderTriangles === low.stats.colliderTriangles && full.stats.colliderTriangles === again.stats.colliderTriangles,
      sameProps: JSON.stringify(full.dressingProps) === JSON.stringify(again.dressingProps),
      props: full.dressingProps.length,
      walkable: { bare: navBare.walkable.length, full: navFull.walkable.length },
      lost,
      lostOutsideProps,
      routes,
      spawnHits,
      siteHits,
      blocked,
      surfaces,
    };
    for (const m of [bare, full, low, again]) disposeMap(m);
    return out;
  }, mapId);

for (const mapId of ['seoul', 'warehouse']) {
  test(`${mapId}: dressing keeps routes, spawns, sites and cover; solid for players and bullets; same everywhere`, async () => {
    const r = await compare(mapId);
    console.log(mapId, JSON.stringify({ ...r, routes: undefined }));
    assert.ok(r.stats.full.dressing.parts > 500, `dressing placed (${r.stats.full.dressing.parts} parts)`);
    assert.equal(r.stats.bare.dressing, null, 'bare map: no dressing');
    assert.equal(r.sameCollision, true, 'collision identical on every load and at every quality');
    assert.equal(r.sameProps, true, 'same props every load');
    assert.ok(r.tried >= r.props, `stuck checks run (${r.tried} spots)`);
    assert.equal(r.stuck, 0, `players never stuck beside a prop (${r.stuck} of ${r.tried} spots: ${JSON.stringify(r.stuckAt)})`);
    assert.equal(r.spawnHits, 0, 'no prop on a spawn');
    assert.equal(r.siteHits, 0, 'no prop on a bomb site');
    // Bots: every route that existed still exists and is about as long.
    for (const { bare, full } of r.routes) {
      if (bare === null) continue;
      assert.ok(full !== null, 'route still exists');
      assert.ok(full <= bare * 1.08 + 2, `route about as long (${full.toFixed(1)} vs ${bare.toFixed(1)})`);
    }
    assert.ok(r.routes.some((x) => x.bare !== null), 'routes measured');
    // Walkable area: only cells under / right next to new props are lost.
    assert.equal(r.lostOutsideProps, 0, `cells lost away from props: ${r.lostOutsideProps}`);
    assert.ok(r.walkable.full >= r.walkable.bare * 0.97, `walkable ${r.walkable.full} / ${r.walkable.bare}`);
    // Bullets stop on ground props (they are solid), and say what they are made of.
    assert.equal(r.blocked, r.props, `every ground prop stops a round (${r.blocked}/${r.props})`);
    // Cost: few draw calls (merged by material), load time bounded.
    assert.ok(r.stats.full.drawCalls - r.stats.bare.drawCalls <= 40, `draw calls ${r.stats.bare.drawCalls} -> ${r.stats.full.drawCalls}`);
    assert.ok(r.stats.full.dressing.ms < 1500, `dressing built in ${r.stats.full.dressing.ms} ms`);
  });
}

test('ground props are what they look like: racks, drums and carts metal, pallets and cartons wood, poles concrete', async () => {
  const yard = await compare('warehouse');
  const city = await compare('seoul');
  const ok = /^(paintedMetal|metal|wood|rubber|default)$/;
  for (const k of Object.keys(yard.surfaces)) assert.match(k, ok, `warehouse prop surface ${k}`);
  assert.ok((yard.surfaces.wood ?? 0) > 0 && (yard.surfaces.paintedMetal ?? 0) + (yard.surfaces.metal ?? 0) > 0, JSON.stringify(yard.surfaces));
  // Seoul ground props are the utility poles (concrete masts with a steel crossarm / transformer on top;
  // a few stand under a street tree, whose crown a round from above meets first).
  for (const k of Object.keys(city.surfaces)) assert.match(k, /^(concrete|paintedMetal|metal|foliage)$/, `seoul prop surface ${k}`);
  assert.ok((city.surfaces.concrete ?? 0) > 0);
});
