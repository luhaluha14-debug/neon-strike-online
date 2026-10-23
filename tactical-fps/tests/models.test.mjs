// Weapon and character models: every GLB the game ships loads and is what
// it claims to be; the buy menu shows the real model pictures (also of the
// weapons that are still locked); the bots' "요원 모델" look uses the
// operator (BLUE) and terrorist (RED / free-for-all) files at the right
// size, facing and place, holding the rifle whose muzzle the tracers start
// from, falling on death and standing again on the next round / respawn;
// the default animated look is unchanged.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, openGame, installFrameDriver } from './harness.mjs';

let env;
let page;

async function waitLocked() {
  await page.waitForFunction(
    () => document.pointerLockElement === window.game.renderer.domElement && window.game.input.active && document.querySelector('.hud').classList.contains('playing'),
  );
}

before(async () => {
  env = await startEnv();
  page = await openGame(env, { map: 'warehouse', mode: 'team' });
});
after(async () => {
  await page?.context().close();
  await env?.close();
});

test('every shipped GLB loads: three weapons in use, three locked weapons, two characters (static meshes)', async () => {
  const r = await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const { GLTFLoader } = await import('/node_modules/three/examples/jsm/loaders/GLTFLoader.js');
    const loader = new GLTFLoader();
    const out = {};
    for (const url of ['/weapons/ar01.glb', '/weapons/sr01.glb', '/weapons/m9_bayonet.glb', '/weapons/smg01.glb', '/weapons/sg01.glb', '/weapons/pis01.glb', '/characters/operator.glb', '/characters/terrorist.glb']) {
      const res = await fetch(url);
      const gltf = await loader.loadAsync(url);
      let meshes = 0;
      let skinned = 0;
      const mats = new Set();
      gltf.scene.traverse((o) => {
        if (o.isMesh) meshes++;
        if (o.isSkinnedMesh) skinned++;
        if (o.material) mats.add(o.material.name);
      });
      const size = new THREE.Box3().setFromObject(gltf.scene).getSize(new THREE.Vector3());
      out[url] = { status: res.status, meshes, skinned, animations: gltf.animations.length, size: size.toArray().map((v) => +v.toFixed(2)), mats: [...mats].sort() };
    }
    return out;
  });
  for (const [url, x] of Object.entries(r)) {
    assert.equal(x.status, 200, url);
    assert.ok(x.meshes > 0, url);
  }
  // The new guns: the SMG / shotgun / pistol exports (lengths along X).
  assert.equal(r['/weapons/smg01.glb'].size[0], 0.68);
  assert.equal(r['/weapons/sg01.glb'].size[0], 1.01);
  assert.equal(r['/weapons/pis01.glb'].size[0], 0.19);
  // Characters: about 1.75 m tall, no skeleton and no animation (static pose).
  for (const url of ['/characters/operator.glb', '/characters/terrorist.glb']) {
    assert.ok(r[url].size[1] > 1.7 && r[url].size[1] < 1.8, `${url} height ${r[url].size[1]}`);
    assert.deepEqual([r[url].skinned, r[url].animations], [0, 0], `${url} is not rigged`);
  }
  assert.ok(r['/characters/operator.glb'].mats.includes('OP_Uniform'));
  assert.ok(r['/characters/terrorist.glb'].mats.includes('TR_Armband'));
});

test('buy menu: pictures rendered from the models, including the locked SMG-01 / SG-01 / PIS-01 (still not buyable)', async () => {
  await page.click('.play-button');
  await waitLocked();
  await page.keyboard.press('KeyB');
  await page.waitForFunction(() => window.game.buyMenuOpen && !document.querySelector('.buy-menu').hidden);
  // Rendering is slow on the headless software renderer: allow time.
  await page.waitForFunction(
    () => ['AR-01', 'SR-01', 'Knife', 'SMG-01', 'SG-01', 'PIS-01'].every((id) => document.querySelector(`.buy-card[data-id="${id}"] .buy-art.has-image`)),
    null,
    { timeout: 120000 },
  );
  const r = await page.evaluate(() => ({
    noImage: [...document.querySelectorAll('.buy-card')].filter((c) => !c.querySelector('.buy-art.has-image')).map((c) => c.dataset.id).sort(),
    states: Object.fromEntries(['SMG-01', 'SG-01', 'PIS-01'].map((id) => [id, document.querySelector(`.buy-card[data-id="${id}"]`).dataset.state])),
    buy: ['SMG-01', 'SG-01', 'PIS-01'].map((id) => window.game.buy(id).reason),
    weapons: window.game.weapons.loadout.map((w) => w.def.id),
  }));
  assert.deepEqual(r.noImage, ['ARMOR-01', 'FLASH-01', 'SMOKE-01'], 'equipment without a model keeps its icon');
  assert.deepEqual(r.states, { 'SMG-01': 'locked', 'SG-01': 'locked', 'PIS-01': 'locked' });
  assert.deepEqual(r.buy, ['locked', 'locked', 'locked'], 'a model alone does not make a weapon buyable');
  assert.deepEqual(r.weapons, ['karambit']);
  await page.click('.buy-close');
  await waitLocked();
});

test('default look unchanged: the built-in animated body', async () => {
  const r = await page.evaluate(() => ({
    look: window.game.matchSettings.botLook,
    kinds: [...new Set(window.game.squad.models.map((m) => m.constructor.name))],
  }));
  assert.equal(r.look, 'procedural');
  assert.deepEqual(r.kinds, ['BotModel']);
});

test('요원 모델 look: BLUE operator, RED terrorist; right height, on the feet, facing the aim, rifle in the hands', async () => {
  await page.evaluate(() => document.exitPointerLock());
  await page.waitForFunction(() => !document.pointerLockElement);
  await page.click('#tab-play');
  await page.selectOption('select[data-setting="bot-look"]', 'agents');
  await page.click('.play-button');
  await waitLocked();
  await installFrameDriver(page);
  const r = await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const g = window.game;
    window.T.stopLoop();
    g.restartMatch();
    window.T.run(30);
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    return g.squad.bots.map((b, i) => {
      const m = g.squad.models[i];
      m.object.updateMatrixWorld(true);
      box.setFromObject(m.object);
      const mats = new Set();
      m.object.traverse((o) => o.material && mats.add(o.material.name));
      const muzzle = m.muzzle.getWorldPosition(v.clone());
      const yaw = b.controller.yaw;
      const fwd = (muzzle.x - b.position.x) * -Math.sin(yaw) + (muzzle.z - b.position.z) * -Math.cos(yaw);
      return {
        team: b.team,
        kind: m.constructor.name,
        model: mats.has('OP_Uniform') ? 'operator' : mats.has('TR_Armband') ? 'terrorist' : 'other',
        top: +(box.max.y - b.position.y).toFixed(2),
        bottom: +(box.min.y - b.position.y).toFixed(2),
        centre: +Math.hypot((box.min.x + box.max.x) / 2 - b.position.x, (box.min.z + box.max.z) / 2 - b.position.z).toFixed(2),
        muzzleAhead: +fwd.toFixed(2),
        muzzleHeight: +(muzzle.y - b.position.y).toFixed(2),
        capsule: b.height,
      };
    });
  });
  for (const x of r) {
    assert.equal(x.kind, 'AgentModel');
    assert.equal(x.model, x.team === 'blue' ? 'operator' : 'terrorist', JSON.stringify(x));
    assert.ok(x.top > 1.7 && x.top < 1.85, `height on the capsule (${x.top})`);
    assert.ok(Math.abs(x.bottom) < 0.08, `feet on the ground (${x.bottom})`);
    assert.ok(x.centre < 0.7, `drawn where the bot is (${x.centre} m off incl. the rifle)`);
    assert.ok(x.muzzleAhead > 1, `rifle points along the aim (${x.muzzleAhead} m ahead)`);
    assert.ok(x.muzzleHeight > 1.1 && x.muzzleHeight < 1.5, `rifle at hand height (${x.muzzleHeight})`);
    assert.equal(x.capsule, 1.8, 'hit capsule unchanged');
  }
});

test('요원 모델 in play: bots move and fire (tracers from the rifle muzzle), fall when killed, stand again next round', async () => {
  const r = await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const g = window.game;
    const T = window.T;
    const V = g.player.position.constructor;
    // Skip the buy time; play 25 s.
    g.teamMatch.ready();
    T.run(2);
    const starts = g.squad.bots.map((b) => b.position.clone());
    // Each tracer, checked when it is fired: it starts at some bot's rifle (muzzle height,
    // within the rifle's reach of that bot), not at a bot's feet or the map origin.
    let tracers = 0;
    let fromMuzzle = 0;
    const tracer = g.fx.tracer.bind(g.fx);
    g.fx.tracer = (from, to) => {
      tracers++;
      if (g.squad.bots.some((b) => Math.hypot(from.x - b.position.x, from.z - b.position.z) < 2 && from.y - b.position.y > 1 && from.y - b.position.y < 1.6)) fromMuzzle++;
      tracer(from, to);
    };
    const shots0 = g.squad.bots.reduce((s, b) => s + b.weapons.shotsFired, 0);
    g.combat.protection = 1e9; // the player stays out of it
    T.run(60 * 25);
    g.fx.tracer = tracer;
    const shots = g.squad.bots.reduce((s, b) => s + b.weapons.shotsFired, 0) - shots0;
    const moved = g.squad.bots.map((b, i) => Math.hypot(b.position.x - starts[i].x, b.position.z - starts[i].z));
    // (If a side was wiped out meanwhile, carry on into the next live round.)
    let w = 0;
    while (g.teamMatch.phase !== 'live' && w++ < 2400) T.run(1);
    /** Bounds of what is drawn (Box3.setFromObject also counts hidden parts, e.g. the dropped rifle). */
    const visibleBox = (root) => {
      const out = new THREE.Box3();
      root.updateMatrixWorld(true);
      root.traverseVisible((o) => {
        if (o.isMesh) out.union(new THREE.Box3().setFromObject(o));
      });
      return out;
    };
    // Kill a living bot: it falls.
    const victim = g.squad.bots.find((b) => b.alive);
    const vi = g.squad.bots.indexOf(victim);
    victim.combat.protection = 0;
    victim.combat.applyDamage({ amount: 999, zone: 'body', sourceId: 'test', weaponId: 'ar01', point: new V(), direction: new V(0, 0, 1), distance: 5 });
    T.run(60);
    const deadTop = visibleBox(g.squad.models[vi].object).max.y - victim.position.y;
    // Next round: everyone up again.
    for (const b of g.squad.bots) if (b.alive && b.team === 'red') b.combat.applyDamage({ amount: 999, zone: 'body', sourceId: 'test', weaponId: 'ar01', point: new V(), direction: new V(0, 0, 1), distance: 5 });
    let n = 0;
    while (g.teamMatch.phase !== 'prep' && n++ < 2000) T.run(1);
    T.run(10);
    const tops = g.squad.models.map((m, i) => +(visibleBox(m.object).max.y - g.squad.bots[i].position.y).toFixed(2));
    return { shots, moved: moved.filter((d) => d > 3).length, tracers, fromMuzzle, deadTop: +deadTop.toFixed(2), tops, phase: g.teamMatch.phase, alive: g.teamAlive(), errors: [] };
  });
  assert.ok(r.shots > 20, `bots fought (${r.shots} rounds)`);
  assert.ok(r.moved >= 5, `bots moved (${r.moved} of 9 more than 3 m)`);
  assert.ok(r.tracers > 20, `tracers drawn (${r.tracers})`);
  assert.equal(r.fromMuzzle, r.tracers, 'every tracer starts at a rifle muzzle');
  assert.ok(r.deadTop < 0.9, `a killed bot lies on the ground (top ${r.deadTop} m)`);
  assert.equal(r.phase, 'prep');
  assert.deepEqual(r.alive, { blue: 5, red: 5 });
  for (const t of r.tops) assert.ok(t > 1.7, `standing again (${t})`);
  assert.deepEqual(page.errors, []);
});

test('deathmatch with the character models: terrorist bodies, 3 s respawn standing; back to the default look', async () => {
  await page.evaluate(() => document.exitPointerLock());
  await page.waitForFunction(() => !document.pointerLockElement);
  await page.selectOption('select[data-setting="mode"]', 'deathmatch');
  const r = await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const g = window.game;
    const V = g.player.position.constructor;
    const ghost = { id: 'local', alive: false, position: new V(999, 0, 999), height: 1.8 };
    const kinds = g.squad.models.map((m) => {
      const mats = new Set();
      m.object.traverse((o) => o.material && mats.add(o.material.name));
      return mats.has('TR_Armband') ? 'terrorist' : m.constructor.name;
    });
    const b = g.squad.bots[0];
    b.combat.protection = 0;
    b.combat.applyDamage({ amount: 999, zone: 'body', sourceId: 'test', weaponId: 'ar01', point: new V(), direction: new V(0, 0, 1), distance: 5 });
    for (let i = 0; i < 120 * 3.2; i++) g.squad.step(1 / 120, ghost);
    g.squad.updateVisuals(1 / 60);
    const m = g.squad.models[0];
    m.object.updateMatrixWorld(true);
    const top = new THREE.Box3().setFromObject(m.object).max.y - b.position.y;
    return { kinds, alive: b.alive, top: +top.toFixed(2), stored: JSON.parse(localStorage.getItem('tactical-fps.match.v1')) };
  });
  assert.deepEqual([...new Set(r.kinds)], ['terrorist'], 'free-for-all bots wear the terrorist model');
  assert.equal(r.alive, true, 'respawned after 3 s');
  assert.ok(r.top > 1.7, `standing (${r.top})`);
  assert.equal(r.stored.botLook, 'agents');
  assert.deepEqual([r.stored.timeLimit, r.stored.killTarget, r.stored.roundTime, r.stored.roundsToWin], [600, 30, 120, 5], 'other options untouched');
  await page.selectOption('select[data-setting="bot-look"]', 'procedural');
  const back = await page.evaluate(() => [...new Set(window.game.squad.models.map((m) => m.constructor.name))]);
  assert.deepEqual(back, ['BotModel']);
  assert.deepEqual(page.errors, []);
});
