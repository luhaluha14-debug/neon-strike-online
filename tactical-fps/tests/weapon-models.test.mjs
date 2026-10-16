// The Blender GLB weapon models (public/weapons/*.glb) as used in first person:
// the right file per weapon, oriented with the muzzle / blade forward, the
// reload and bolt motion moving the file's own parts, one download per file,
// no leftover or duplicate models after weapon and map switches, and the
// models still shown on the second map. Hand clipping per pose is covered by
// viewmodel.test.mjs (unchanged budgets).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, openGame, LOAD_TIMEOUT } from './harness.mjs';

let env;
let page;
before(async () => {
  env = await startEnv();
  page = await openGame(env, { map: 'warehouse', width: 1280, height: 720 });
  await page.evaluate(() => window.game.loop.stop());
});
after(async () => {
  await page?.context().close();
  await env?.close();
});

/** Equips `slot`, holds an animation state, returns facts about the shown model (camera space of the view-model layer). */
const inspect = (slot, s = {}) =>
  page.evaluate(
    ([slot, s]) => {
      const g = window.game;
      const vm = g.viewModel;
      g.weapons.equipSlot(slot);
      const w = g.weapons.weapon;
      w.status = 'ready';
      w.equipRemaining = 0;
      const anim = { category: w.def.category, equip: 1, reload: s.reload ?? null, sinceShot: s.sinceShot ?? Infinity, fireInterval: w.fireInterval, inspect: null };
      for (let i = 0; i < 40; i++) vm.update(1 / 60, { lookYaw: 0, lookPitch: 0, speed01: 0, grounded: true, crouching: false }, anim);
      const view = vm.currentView;
      vm.scene.updateMatrixWorld(true);
      const V = g.player.position.constructor;
      const toCam = (o) => o.getWorldPosition(new V()).applyMatrix4(vm.camera.matrixWorldInverse);
      const names = [];
      // Node names of the file (a node with several primitives loads as a group, so not only meshes).
      view.object.traverse((o) => names.push(o.name));
      let meshes = 0;
      let disposedGeometry = 0;
      view.object.traverse((o) => {
        if (!o.isMesh) return;
        meshes++;
        if (!o.geometry.getAttribute('position')) disposedGeometry++;
      });
      const tip = view.object.getObjectByName('Blade');
      return {
        name: view.object.name,
        displayName: w.def.displayName,
        meshes,
        disposedGeometry,
        meshNames: names,
        grip: toCam(view.gripAnchor).toArray(),
        muzzle: view.muzzle ? toCam(view.muzzle).toArray() : null,
        support: view.supportAnchor ? toCam(view.supportAnchor).toArray() : null,
        magazine: view.magazine ? { y: view.magazine.position.y, visible: view.magazine.visible, children: view.magazine.children.map((c) => c.name) } : null,
        bolt: (() => {
          const b = view.object.getObjectByName('Bolt');
          return b ? { z: b.position.z, rz: b.rotation.z, children: b.children.map((c) => c.name) } : null;
        })(),
        // Blade tip in the file: local y = 0.185 m (the Blade node has several primitives, so it is a group).
        bladeTip: tip ? new V(0, 0.185, 0).applyMatrix4(tip.matrixWorld).applyMatrix4(vm.camera.matrixWorldInverse).toArray() : null,
        hud: document.querySelector('.loadout .active')?.textContent,
      };
    },
    [slot, s],
  );

test('each weapon shows its own GLB: AR-01 = M4 file, SR-01 = bolt-action file, slot 3 = M9 bayonet', async () => {
  const ar = await inspect(0);
  const sr = await inspect(1);
  const m9 = await inspect(2);
  assert.equal(ar.name, 'M4_Root');
  assert.ok(ar.meshNames.includes('Flash_Hider') && ar.meshNames.includes('Pistol_Grip'));
  assert.equal(sr.name, 'Rifle_Root');
  assert.ok(sr.meshNames.includes('Scope_Body') && sr.meshNames.includes('Bolt_Handle'));
  assert.ok(m9.meshNames.includes('Sawback') && m9.meshNames.includes('MuzzleRing'), 'M9 bayonet parts');
  assert.ok(!m9.meshNames.some((n) => /karambit/i.test(n)));
  assert.equal(m9.displayName, 'M9 BAYONET');
  assert.match(m9.hud, /M9 BAYONET/);
  for (const v of [ar, sr, m9]) assert.equal(v.disposedGeometry, 0);
});

test('orientation: muzzles and the blade point away from the camera, past the hand', async () => {
  for (const slot of [0, 1]) {
    const v = await inspect(slot);
    // Camera space: -Z is forward.
    assert.ok(v.muzzle[2] < v.grip[2] - 0.3, `${v.name}: muzzle ${v.muzzle} ahead of the grip ${v.grip}`);
    assert.ok(v.support[2] < v.grip[2], `${v.name}: support hand ahead of the firing hand`);
    assert.ok(v.muzzle[2] < -0.5, `${v.name}: muzzle well in front of the camera`);
  }
  const m9 = await inspect(2);
  assert.ok(m9.bladeTip[2] < m9.grip[2] - 0.08, `blade tip ${m9.bladeTip} ahead of the hand ${m9.grip}`);
  assert.ok(m9.bladeTip[1] > m9.grip[1], 'blade points up from the fist');
});

test('reload drops the file\'s magazine parts; the bolt-action cycles the file\'s bolt parts', async () => {
  const arRest = await inspect(0);
  const arReload = await inspect(0, { reload: 0.4 });
  assert.deepEqual(arRest.magazine.children.sort(), ['Mag_Ribs_L', 'Mag_Ribs_R', 'Magazine', 'Magazine_Base']);
  assert.ok(arReload.magazine.y < arRest.magazine.y - 0.1 || !arReload.magazine.visible, 'AR magazine out during reload');
  const srRest = await inspect(1);
  const srCycle = await inspect(1, { sinceShot: 0.6 });
  assert.deepEqual(srRest.bolt.children.sort(), ['Bolt_Cap', 'Bolt_Handle', 'Bolt_Knob', 'Bolt_Shroud']);
  assert.ok(srCycle.bolt.z > srRest.bolt.z + 0.03 || Math.abs(srCycle.bolt.rz) > 0.5, `bolt moved: ${JSON.stringify(srCycle.bolt)}`);
  const srReload = await inspect(1, { reload: 0.4 });
  assert.ok(srReload.magazine.y < srRest.magazine.y - 0.1 || !srReload.magazine.visible, 'SR magazine out during reload');
});

test('weapon switch spam: one model at a time, shared geometry intact, each file downloaded once', async () => {
  for (let i = 0; i < 30; i++) await inspect(i % 3);
  const r = await page.evaluate(() => {
    const vm = window.game.viewModel;
    // One marker part per model file.
    let weapons = 0;
    vm.scene.traverse((o) => {
      if (['Flash_Hider', 'Scope_Body', 'Sawback'].includes(o.name)) weapons++;
    });
    return { weapons, current: vm.currentView.object.name };
  });
  assert.equal(r.weapons, 1, 'exactly one weapon model in the view-model scene');
  const ar = await inspect(0);
  assert.equal(ar.disposedGeometry, 0, 'shared GLB geometry still usable after switching');
  // Every resource the page fetched since it opened (Resource Timing).
  const counts = await page.evaluate(() =>
    performance.getEntriesByType('resource').reduce((m, e) => {
      const p = new URL(e.name).pathname;
      if (p.startsWith('/weapons/')) m[p] = (m[p] ?? 0) + 1;
      return m;
    }, {}),
  );
  assert.deepEqual(counts, { '/weapons/ar01.glb': 1, '/weapons/sr01.glb': 1, '/weapons/m9_bayonet.glb': 1 });
});

test('after switching to Seoul: same GLB models, no leftovers from the first map', async () => {
  await page.evaluate(() => window.game.switchMap('seoul'));
  await page.waitForFunction(() => window.game.mapDef.id === 'seoul' && window.game.weapons && !document.querySelector('.play-button').disabled, null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => window.game.loop.stop());
  const names = [];
  for (const slot of [0, 1, 2]) {
    const v = await inspect(slot);
    names.push(v.meshNames.includes('Sawback') ? 'M9' : v.name);
  }
  assert.deepEqual(names, ['M4_Root', 'Rifle_Root', 'M9']);
  const weapons = await page.evaluate(() => {
    let n = 0;
    window.game.viewModel.scene.traverse((o) => {
      if (['Flash_Hider', 'Scope_Body', 'Sawback'].includes(o.name)) n++;
    });
    return n;
  });
  assert.equal(weapons, 1);
});

test('no page errors', () => {
  assert.deepEqual(page.errors, []);
});
