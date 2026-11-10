// Tactical minimap (Phase 23): the map's own layout (walls / buildings dark,
// reachable floor light, roofed floor in between) lined up with the world;
// the player in the middle with its arrow pointing where it faces; teammates
// shown; an enemy only while the player itself sees it (in view, in range,
// no wall), then for a moment where it was last seen, never followed behind
// a wall; zoom (M on a PC, a tap on a phone); clear of the HUD and the touch
// controls at PC and phone sizes; cheap to draw.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, openGame, installFrameDriver } from './harness.mjs';
import { fingers } from './mobile-touch.mjs';

let env;

before(async () => {
  env = await startEnv();
});
after(async () => {
  await env?.close();
});

async function play(opts) {
  const page = await openGame(env, { quality: 'low', ...opts });
  if (opts.mobile) await page.tap('.play-button');
  else await page.click('.play-button');
  await page.waitForFunction(() => window.game.input.active);
  await installFrameDriver(page);
  await page.evaluate(() => {
    window.T.stopLoop();
    window.T.run(30);
  });
  return page;
}

for (const map of ['warehouse', 'seoul']) {
  test(`${map}: the layout matches the map (reachable floor light, solid buildings dark) and lines up with the world`, async () => {
    const page = await play({ map, mode: 'deathmatch' });
    try {
      const r = await page.evaluate(async () => {
        const g = window.game;
        const { buildMinimapLayout, layoutAt } = await import('/src/world/MinimapLayout.ts');
        const l = buildMinimapLayout(g.map, g.nav);
        // A fixed sample (the same points every run).
        let seed = 12345;
        const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
        const V = g.camera.position.constructor;
        const col = g.map.collision;
        let walkOk = 0;
        let walkN = 0;
        for (let k = 0; k < 400; k++) {
          const c = g.nav.walkable[Math.floor(rnd() * g.nav.walkable.length)];
          const p = g.nav.center(c);
          walkN++;
          const kind = layoutAt(l, p.x, p.z);
          if (kind === 1 || kind === 2) walkOk++;
        }
        // Solid ground-to-roof volumes: a ray from the sky stops more than 4 m up and nobody can walk there.
        let wallOk = 0;
        let wallN = 0;
        const b = g.map.playBounds;
        for (let k = 0; k < 4000 && wallN < 200; k++) {
          const x = b.min.x + rnd() * (b.max.x - b.min.x);
          const z = b.min.z + rnd() * (b.max.z - b.min.z);
          const d = col.raycast(new V(x, b.max.y + 2, z), new V(0, -1, 0), b.max.y + 10);
          const n = g.nav.cellAt(x, z);
          if (d === null || b.max.y + 2 - d < 4 || (n >= 0 && !Number.isNaN(g.nav.floor[n]))) continue;
          // Inside the building, not at its edge: a metre around (eight ways) is building too (high, not walkable).
          const inside = [-1, 0, 1].every((dx) =>
            [-1, 0, 1].every((dz) => {
              const n2 = g.nav.cellAt(x + dx, z + dz);
              const d2 = col.raycast(new V(x + dx, b.max.y + 2, z + dz), new V(0, -1, 0), b.max.y + 10);
              return d2 !== null && b.max.y + 2 - d2 >= 4 && (n2 < 0 || Number.isNaN(g.nav.floor[n2]));
            }),
          );
          if (!inside) continue;
          wallN++;
          if (layoutAt(l, x, z) === 4) wallOk++;
        }
        // On the drawn minimap: the pixel of a walkable spot is lighter than the pixel of a building
        // (the terrain alone: no enemy dot drawn over a sampled pixel).
        g.minimapSight = () => {};
        g.enemySeen.clear();
        window.T.run(10);
        const mm = g.minimap;
        const cv = mm.root.querySelector('canvas');
        const ctx = cv.getContext('2d');
        const lum = (x, z) => {
          const q = mm.worldToMap(x, z);
          if (q.x < 0 || q.y < 0 || q.x >= cv.width || q.y >= cv.height) return null;
          const d = ctx.getImageData(Math.round(q.x), Math.round(q.y), 1, 1).data;
          return 0.2126 * d[0] + 0.7152 * d[1] + 0.0722 * d[2];
        };
        const pp = g.player.position;
        let lighter = 0;
        let pairs = 0;
        // Cell centres whose neighbours are of the same kind (no edge between two kinds under the sample).
        const centreOf = (v, min) => min + Math.floor(v - min) + 0.5;
        const solid = (x, z, kind) => [-1, 0, 1].every((dx) => [-1, 0, 1].every((dz) => layoutAt(l, x + dx, z + dz) === kind));
        const sites = l.sites;
        const nearSite = (x, z) => sites.some((st) => Math.abs(x - st.x) < st.hx + 2 && Math.abs(z - st.z) < st.hz + 2);
        // Every cell in the drawn area, in a fixed order: the solid floor cells and the solid wall cells.
        const floors = [];
        const walls = [];
        for (let dz = -36; dz <= 36; dz += 2)
          for (let dx = -36; dx <= 36; dx += 2) {
            const x = centreOf(pp.x + dx, l.minX);
            const z = centreOf(pp.z + dz, l.minZ);
            if (nearSite(x, z) || Math.hypot(x - pp.x, z - pp.z) < 4) continue;
            if (solid(x, z, 1)) floors.push([x, z]);
            else if (solid(x, z, 4)) walls.push([x, z]);
          }
        const step = (a, n) => (a.length ? Array.from({ length: Math.min(n, a.length) }, (_, i) => a[Math.floor((i * a.length) / Math.min(n, a.length))]) : []);
        const fs = step(floors, 40);
        const ws = step(walls, 40);
        for (let k = 0; k < Math.min(fs.length, ws.length); k++) {
          const [x, z] = fs[k];
          const [x2, z2] = ws[k];
          if (Math.hypot(x - pp.x, z - pp.z) < 4 || Math.hypot(x2 - pp.x, z2 - pp.z) < 4) continue;
          const a = lum(x, z);
          const w = lum(x2, z2);
          if (a === null || w === null) continue;
          pairs++;
          if (a > w + 30) lighter++;
        }
        const centre = mm.worldToMap(pp.x, pp.z);
        return { walk: walkOk / walkN, wall: wallN ? wallOk / wallN : null, wallN, lighter, pairs, centre, size: cv.width, sites: l.sites.map((s) => s.name), ms: l.buildMs };
      });
      assert.ok(r.walk >= 0.99, `reachable cells drawn as floor: ${(r.walk * 100).toFixed(1)} %`);
      assert.ok(r.wallN >= 30 && r.wall >= 0.95, `solid buildings drawn as walls: ${(r.wall * 100).toFixed(1)} % of ${r.wallN}`);
      assert.ok(r.pairs >= 20 && r.lighter === r.pairs, `on the canvas, floor lighter than walls (${r.lighter}/${r.pairs})`);
      assert.deepEqual([Math.round(r.centre.x), Math.round(r.centre.y)], [r.size / 2, r.size / 2], 'the player in the middle');
      assert.ok(r.ms < 500, `layout built in ${r.ms.toFixed(0)} ms`);
      assert.deepEqual(page.errors, []);
    } finally {
      await page.context().close();
    }
  });
}

test('player arrow points where the player faces; teammates shown; zoom with M', async () => {
  const page = await play({ map: 'warehouse', mode: 'team' });
  try {
    const arrow = await page.evaluate(() => {
      const g = window.game;
      const out = [];
      for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        g.player.yaw = yaw;
        window.T.run(5);
        const cv = g.minimap.root.querySelector('canvas');
        const ctx = cv.getContext('2d');
        const W = cv.width;
        const L = W / 14;
        const at = (dx, dy) => {
          const d = ctx.getImageData(Math.round(W / 2 + dx), Math.round(W / 2 + dy), 1, 1).data;
          return d[0] > 220 && d[1] > 220 && d[2] > 220;
        };
        const fx = -Math.sin(yaw);
        const fz = -Math.cos(yaw);
        // Inside the arrow on its centre line ahead of the middle; behind it, in the arrow's notch, nothing.
        out.push({ yaw, tip: at(fx * L * 0.45, fz * L * 0.45), back: at(-fx * L * 0.45, -fz * L * 0.45) });
      }
      return { out, allies: g.minimap.drawn.allies, alive: g.squad.bots.filter((b) => b.alive && b.team === g.localTeam).length };
    });
    for (const a of arrow.out) assert.deepEqual([a.tip, a.back], [true, false], `arrow forward at yaw ${a.yaw.toFixed(2)}`);
    assert.equal(arrow.allies, arrow.alive, 'every living teammate on the map (they spawn together)');
    const half = () => page.evaluate(() => window.game.minimap.half);
    assert.equal(await half(), 40);
    await page.keyboard.press('KeyM');
    assert.equal(await half(), 24);
    await page.keyboard.press('KeyM');
    assert.equal(await half(), 70);
    await page.keyboard.press('KeyM');
    assert.equal(await half(), 40);
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});

test('enemies: only while the player sees them (not behind a wall, not behind the player), then briefly where last seen, never followed', async () => {
  const page = await play({ map: 'warehouse', mode: 'deathmatch' });
  try {
    const r = await page.evaluate(() => {
      const g = window.game;
      const V = g.camera.position.constructor;
      const col = g.map.collision;
      for (const b of g.squad.bots) {
        b.combat.protection = 1e9;
        b.spawn(new V(1e4, 0, 1e4), 0); // out of the way
        b.order = null;
      }
      g.squad.step = () => {};
      g.squad.hold = () => {};
      const bot = g.squad.bots[0];
      // The player alive (the bots may have got it before the test took over): a dead player sees nothing.
      if (!g.combat.alive) g.combat.reset();
      g.combat.protection = 1e9;
      g.enemySeen.clear();
      // A spot in the open with a wall within 3–10 m in front: the player faces along +x of the wall's line.
      let setup = null;
      for (let k = 0; k < 6000 && !setup; k++) {
        const c = g.nav.walkable[Math.floor(Math.random() * g.nav.walkable.length)];
        const p = g.nav.center(c);
        const a = Math.random() * Math.PI * 2;
        const dir = new V(-Math.sin(a), 0, -Math.cos(a));
        const eye = new V(p.x, p.y + 1.62, p.z);
        const hit = col.raycast(eye, dir, 12);
        if (hit === null || hit < 3 || hit > 9) continue;
        // Behind the wall: a walkable cell straight on, 2–5 m past it.
        let behind = null;
        for (let e = hit + 1.5; e < hit + 5; e += 0.5) {
          const q = p.clone().addScaledVector(dir, e);
          const n = g.nav.cellAt(q.x, q.z);
          if (n >= 0 && !Number.isNaN(g.nav.floor[n])) {
            behind = g.nav.center(n);
            break;
          }
        }
        // In the open: 6 m in front... on a clear line.
        const open = p.clone().addScaledVector(dir, Math.min(hit - 1, 2.5));
        if (!behind) continue;
        const toBehind = behind.clone().setY(behind.y + 1.4).sub(eye);
        if (col.raycast(eye, toBehind.clone().normalize(), toBehind.length()) === null) continue;
        setup = { p, yaw: a, behind, open, back: p.clone().addScaledVector(dir, -4) };
      }
      if (!setup) return { none: true };
      const seen = () => {
        window.T.run(8);
        const v = g.enemySeen.get(bot.id);
        return { n: g.minimap.drawn.enemies, at: v ? [[v.x, v.z]] : [] };
      };
      g.player.teleport(setup.p.clone(), setup.yaw);
      g.player.pitch = 0;
      const place = (q) => {
        bot.spawn(q.clone(), 0);
        g.squad.updateVisuals?.(0);
      };
      place(setup.behind);
      const behindWall = seen();
      // Behind the player (out of view), in the open.
      place(setup.back);
      const behindMe = seen();
      // In view: shown at its position.
      place(setup.open);
      const inView = seen();
      // It steps behind the wall: stays where last seen (not followed) and fades out.
      place(setup.behind);
      const justHidden = seen();
      window.T.run(120);
      const later = seen();
      return {
        behindWall,
        behindMe,
        inView,
        justHidden,
        later,
        open: [setup.open.x, setup.open.z],
        behind: [setup.behind.x, setup.behind.z],
      };
    });
    assert.notEqual(r.none, true, 'found a wall to hide behind');
    assert.equal(r.behindWall.n, 0, 'behind a wall: not on the minimap');
    assert.equal(r.behindMe.n, 0, 'behind the player: not on the minimap');
    assert.equal(r.inView.n, 1, 'in view: on the minimap');
    assert.ok(Math.hypot(r.inView.at[0][0] - r.open[0], r.inView.at[0][1] - r.open[1]) < 0.2, 'at its position');
    assert.equal(r.justHidden.n, 1, 'just hidden: still shown, where it was last seen');
    assert.ok(Math.hypot(r.justHidden.at[0][0] - r.open[0], r.justHidden.at[0][1] - r.open[1]) < 0.2, 'not followed behind the wall');
    assert.equal(r.later.n, 0, 'gone after a moment');
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});

for (const [w, h, mobile] of [
  [1920, 1080, false],
  [1600, 900, false],
  [1280, 720, false],
  [740, 360, true],
  [844, 390, true],
]) {
  test(`${mobile ? 'phone' : 'PC'} ${w}×${h}: the minimap is on screen and clear of the HUD${mobile ? ' and the touch controls; a tap zooms' : ''}; hidden in the menu`, async () => {
    const page = await play({ map: 'warehouse', mode: 'team', width: w, height: h, mobile });
    try {
      await page.evaluate(() => {
        const tm = window.game.teamMatch;
        for (let i = 0; i < 5; i++) tm.feed.push({ killer: 'bot-6', victim: 'bot-1', weaponId: 'ar01', head: true, at: tm.elapsed });
        window.T.run(3);
      });
      const r = await page.evaluate(() => {
        const box = (e) => e.getBoundingClientRect().toJSON();
        const vis = (s) => [...document.querySelectorAll(s)].filter((e) => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
        const mm = box(document.querySelector('.minimap'));
        const others = [
          ['vitals', vis('.hud .vitals')[0]],
          ['stats', vis('.combat-stats')[0]],
          ['weapon', vis('.hud .weapon')[0]],
          ['bar', vis('.team-hud .team-bar')[0]],
          ['feed', vis('.team-hud .killfeed li')[0] && vis('.team-hud .killfeed')[0]],
          ['crosshair', vis('.crosshair')[0]],
          ...vis('.touch-ui .tc-btn').map((b) => [b.dataset.act, b]),
          ...(document.querySelector('.tc-stick') && vis('.touch-ui').length ? [['stick', document.querySelector('.tc-stick')]] : []),
        ].filter(([, e]) => e);
        const overlaps = others.filter(([, e]) => {
          const b = box(e);
          return mm.left < b.right && b.left < mm.right && mm.top < b.bottom && b.top < mm.bottom;
        }).map(([k]) => k);
        return { mm, vw: innerWidth, vh: innerHeight, overlaps };
      });
      assert.ok(r.mm.left >= 0 && r.mm.top >= 0 && r.mm.right <= r.vw && r.mm.bottom <= r.vh, 'on screen');
      assert.ok(r.mm.width >= 80 && r.mm.width <= Math.max(180, r.vw * 0.12), `a size that leaves the view free (${r.mm.width} px)`);
      assert.deepEqual(r.overlaps, []);
      if (mobile) {
        const f = await fingers(page);
        const before = await page.evaluate(() => window.game.minimap.half);
        await f.tap(r.mm.left + r.mm.width / 2, r.mm.top + r.mm.height / 2);
        assert.notEqual(await page.evaluate(() => window.game.minimap.half), before, 'a tap on the minimap zooms');
        assert.equal(await page.evaluate(() => window.game.input.touch.fingerCount), 0);
      }
      // The menu open: not shown.
      await page.evaluate(() => window.game.input.release?.() ?? document.exitPointerLock());
      await page.waitForTimeout(200);
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.minimap')).visibility), 'hidden');
      assert.deepEqual(page.errors, []);
    } finally {
      await page.context().close();
    }
  });
}

test('cost: drawing and sight checks stay small; nothing piles up over a long run', async () => {
  const page = await play({ map: 'seoul', mode: 'team' });
  try {
    const r = await page.evaluate(() => {
      const g = window.game;
      const m0 = { ...g.renderer.info.memory };
      const t0 = performance.now();
      window.T.run(1200);
      const withMap = performance.now() - t0;
      const update = g.updateMinimap.bind(g);
      g.updateMinimap = () => {};
      const t1 = performance.now();
      window.T.run(1200);
      const without = performance.now() - t1;
      g.updateMinimap = update;
      // The minimap alone: 1200 frames of 1/60 s.
      const t2 = performance.now();
      for (let i = 0; i < 1200; i++) update(1 / 60);
      const alone = performance.now() - t2;
      return { perFrame: alone / 1200, withMap, without, m0, m1: { ...g.renderer.info.memory }, seen: g.enemySeen.size };
    });
    console.log(`[minimap cost] ${JSON.stringify(r)}`);
    assert.ok(r.perFrame < 0.5, `minimap per frame ${r.perFrame.toFixed(3)} ms (headless, software rendering)`);
    assert.deepEqual([r.m1.geometries, r.m1.textures], [r.m0.geometries, r.m0.textures], 'no GPU objects added');
    assert.ok(r.seen <= 16);
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});
