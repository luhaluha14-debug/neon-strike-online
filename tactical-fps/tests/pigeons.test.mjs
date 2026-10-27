// Ambient pigeons (public/props/pigeon.glb → src/world/Pigeons.ts) on every
// map: flocks circling above the roofs with the file's own wing beats, birds
// perched on surfaces, scenery only (no collision, no hits), a handful of
// meshes, gone with the map on a map change, and a missing file costs
// nothing but the pigeons.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, openGame, installFrameDriver } from './harness.mjs';

let env;

before(async () => {
  env = await startEnv();
});
after(async () => {
  await env?.close();
});

const inspect = (page) =>
  page.evaluate(() => {
    const g = window.game;
    const p = g.pigeons;
    const THREE = g.camera.position.constructor;
    const down = new THREE(0, -1, 0);
    const up = new THREE(0, 1, 0);
    window.T.stopLoop();
    const bird = p.flocks[0].birds[0].object;
    const start = bird.position.clone();
    const wingStart = bird.getObjectByName('Shoulder_L').quaternion.clone();
    window.T.run(60); // one second
    const flyers = p.flocks.flatMap((f) => f.birds.map((b) => b.object));
    let meshes = 0;
    p.object.traverse((o) => {
      if (o.isMesh) meshes++;
    });
    return {
      inScene: p.object.parent === g.map.root && g.map.root.parent === g.scene,
      flocks: p.flocks.length,
      flyers: flyers.length,
      moved: bird.position.distanceTo(start),
      wingBeat: bird.getObjectByName('Shoulder_L').quaternion.angleTo(wingStart),
      // Nothing solid above a flying bird, and it is well above whatever is below it.
      clear: flyers.every((o) => g.map.collision.raycast(o.position, up, 200) === null && (g.map.collision.raycast(o.position, down, 400) ?? 99) > 3),
      perched: p.perched.length,
      // Each perched bird stands on a surface (feet within a few cm of it).
      onSurface: p.perched.every((q) => {
        const d = g.map.collision.raycast(q.position.clone().add(new THREE(0, 0.5, 0)), down, 2);
        return d !== null && Math.abs(d - 0.5) < 0.05;
      }),
      // Scenery only: a ray straight down through a perched bird reaches the surface under it.
      passThrough: (() => {
        const q = p.perched[0].position;
        const d = g.map.collision.raycast(q.clone().add(new THREE(0, 0.2, 0)), down, 2);
        return d !== null && Math.abs(d - 0.2) < 0.05;
      })(),
      meshes,
      size: (() => {
        const box = new (g.map.playBounds.constructor)().setFromObject(bird);
        const s = box.getSize(new THREE());
        return Math.max(s.x, s.y, s.z);
      })(),
    };
  });

for (const map of ['warehouse', 'seoul']) {
  test(`${map}: two flocks circle above the roofs beating their wings; pigeons perched on surfaces; scenery only; few meshes`, async () => {
    const page = await openGame(env, { map, mode: 'training' });
    try {
      await page.waitForFunction(() => window.game.pigeons, null, { timeout: 120000 });
      await installFrameDriver(page);
      const r = await inspect(page);
      assert.equal(r.inScene, true);
      assert.deepEqual([r.flocks, r.flyers], [2, 6]);
      assert.ok(r.moved > 5, `flies (${r.moved.toFixed(1)} m in 1 s)`);
      assert.ok(r.wingBeat > 0.05, 'wings beat (file animation)');
      assert.equal(r.clear, true, 'above every roof');
      assert.ok(r.perched >= 4, `perched birds (${r.perched})`);
      assert.equal(r.onSurface, true);
      assert.equal(r.passThrough, true);
      assert.ok(r.meshes <= 40, `meshes ${r.meshes}`);
      assert.ok(r.size > 0.2 && r.size < 1.2, `pigeon size ${r.size.toFixed(2)} m`);
      assert.deepEqual(page.errors, []);
    } finally {
      await page.context().close();
    }
  });
}

test('a map change takes the old pigeons away and brings new ones; the game is unaffected without the file', async () => {
  const page = await openGame(env, { map: 'warehouse', mode: 'training' });
  try {
    await page.waitForFunction(() => window.game.pigeons);
    const old = await page.evaluateHandle(() => window.game.pigeons.object);
    await page.evaluate(() => window.game.switchMap('seoul'));
    await page.waitForFunction(() => window.game.pigeons && window.game.mapDef.id === 'seoul', null, { timeout: 300000 });
    const r = await page.evaluate((o) => ({ oldAttached: !!o.parent && o.parent.parent === window.game.scene, fresh: window.game.pigeons.object !== o }), old);
    assert.deepEqual(r, { oldAttached: false, fresh: true });
  } finally {
    await page.context().close();
  }
  // Without the file: no pigeons, no error, the game plays.
  const context = await env.browser.newContext({ viewport: { width: 640, height: 360 } });
  await context.route('**/props/pigeon.glb', (route) => route.abort());
  const p2 = await context.newPage();
  const errors = [];
  p2.on('pageerror', (e) => errors.push(e.message));
  await p2.goto(`${env.url}/?map=warehouse&quality=low&mode=training`);
  await p2.waitForFunction(() => window.game && window.game.player && !document.querySelector('.play-button').disabled, null, { timeout: 300000 });
  await p2.waitForTimeout(500);
  assert.equal(await p2.evaluate(() => window.game.pigeons), null);
  assert.deepEqual(errors, []);
  await context.close();
});
