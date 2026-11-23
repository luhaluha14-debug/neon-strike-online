// Phase 31 — realism and animation. Presentation only: what these check is how things look and move, never
// what they do (damage, reach, rates, hit capsules, movement and the network are covered by their own suites,
// which run unchanged):
//   1. the player's lean eases in and out (same total time, Phase 30), the weapon trails and cants with it
//   2. third-person bodies: the shown lean eases toward the reported one (network steps), crouch bends the legs,
//      a landing dips the hips, and the walk follows the real displacement so a planted foot stays planted
//   3. the Blender characters (요원 모델): the file's upper body on walking legs up close, the whole figure far
//      away (cheaper), the switch distance set by the quality; still on the capsule
//   4. knives: the M9 slashes, the karambit hooks, the butterfly thrusts — first and third person on one timeline;
//      guns still kick
//   5. weapon motion: reload eased in / held / eased out per kind, variants differ, a draw swings past rest and
//      settles, bringing the sights up dips and rolls the weapon a touch, then it settles
//   6. weapon materials: the SR-01's stock is olive (it was exported white), dark metal still reflects, skins keep
//      their colours, first and third person alike
//   7. maps: wall-base grime measured from the map's ground level, stains on roads and slabs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, openGame, installFrameDriver, waitReady } from './harness.mjs';

let env;
let page;
before(async () => {
  env = await startEnv();
  page = await openGame(env, { width: 640, height: 360, quality: 'high', mode: 'deathmatch', seed: 5 });
  // Credits for the knife items (this browser's offline record), as a player who saved up.
  await page.waitForFunction(() => window.game.account);
  await page.evaluate(() => {
    const a = JSON.parse(localStorage.getItem('grid.account.v1'));
    a.credits = 5000;
    localStorage.setItem('grid.account.v1', JSON.stringify(a));
  });
  await page.reload();
  await waitReady(page);
  await page.waitForFunction(() => window.game.account?.credits === 5000);
  await page.click('.play-button');
  await page.waitForFunction(() => window.game.input.active && window.game.squad?.bots.length > 0);
  await installFrameDriver(page);
  await page.evaluate(() => {
    window.T.stopLoop();
    window.T.run(10);
    window.game.combat.protection = 1e9;
  });
});
after(async () => {
  await page?.context().close();
  await env?.close();
});

test('1. the lean eases in and out over the same 0.18 s; the weapon trails a moment and cants into it', async () => {
  const r = await page.evaluate(() => {
    const p = window.game.player;
    p.updateLean(0, 1);
    const inn = [];
    for (let i = 0; i < 12; i++) {
      p.updateLean(1, 1 / 60);
      inn.push(p['leanWant']);
    }
    const out = [];
    for (let i = 0; i < 12; i++) {
      p.updateLean(0, 1 / 60);
      out.push(p['leanWant']);
    }
    // The view model: a full lean held a while, then one frame after the eye jumps to a full lean.
    const vm = window.game.viewModel;
    const anim = { category: 'rifle', equip: 1, reload: null, sinceShot: Infinity, fireInterval: 0.1, inspect: null };
    const motion = (lean) => ({ lookYaw: 0, lookPitch: 0, speed01: 0, grounded: true, crouching: false, aim: 0, lean });
    for (let i = 0; i < 90; i++) vm.update(1 / 60, motion(0), anim);
    const rest = { x: vm['pivot'].position.x, rz: vm['pivot'].rotation.z };
    vm.update(1 / 60, motion(1), anim);
    const moving = { x: vm['pivot'].position.x, rz: vm['pivot'].rotation.z };
    for (let i = 0; i < 90; i++) vm.update(1 / 60, motion(1), anim);
    const held = { x: vm['pivot'].position.x, rz: vm['pivot'].rotation.z };
    for (let i = 0; i < 90; i++) vm.update(1 / 60, motion(0), anim);
    p.updateLean(0, 1);
    return { inn, out, rest, moving, held };
  });
  // Linear progress after 2 frames is 2/60/0.18 = 0.185; eased it is well below that (a gentle start).
  assert.ok(r.inn[1] < 0.185 * 0.7, `starts gently (${r.inn[1].toFixed(3)})`);
  // Halfway in time, halfway out (ease-in-out is symmetric), and full by 0.18 s (11 frames) as before.
  assert.ok(Math.abs(r.inn[4] - 0.5) < 0.12, `about half by 0.09 s (${r.inn[4].toFixed(3)})`);
  assert.equal(r.inn[11], 1, 'full lean by 0.2 s');
  for (let i = 1; i < 12; i++) assert.ok(r.inn[i] >= r.inn[i - 1], 'never backs off on the way in');
  assert.ok(r.out[1] > 1 - 0.185 * 0.7, `settles back gently too (${r.out[1].toFixed(3)})`);
  assert.equal(r.out[11], 0, 'upright by 0.2 s');
  // The weapon: trails toward where the eye came from (−x for a lean right), then cants into the lean.
  assert.ok(r.moving.x < r.rest.x - 0.005, `trails behind the eye (${(r.moving.x - r.rest.x).toFixed(4)} m)`);
  assert.ok(Math.abs(r.held.x - r.rest.x) < 0.006, 'caught up once the lean is held');
  assert.ok(r.held.rz < r.rest.rz - 0.04, `cants into the lean (${(r.held.rz - r.rest.rz).toFixed(3)} rad)`);
});

test('2. third person: the shown lean eases toward the reported one, crouch bends the legs, a landing dips the hips, and a planted foot stays put however the speed is reported', async () => {
  const r = await page.evaluate(async () => {
    const { BotModel, BotKit } = await import('/src/ai/BotModel.ts');
    const V = window.game.player.position.constructor;
    const kit = new BotKit('red');
    const m = new BotModel(kit);
    const pose = () => ({ feet: new V(0, 0, 0), yaw: 0, pitch: 0, velocity: new V(), grounded: true, aiming: true, alive: true, deadTime: 0, lean: 0, crouch: 0 });
    const hip = () => {
      m.object.updateMatrixWorld(true);
      return m['lower'].pelvis.getWorldPosition(new V()).y;
    };
    const p = pose();
    for (let i = 0; i < 30; i++) m.update(1 / 60, p);
    const standHip = hip();
    // A network lean report arrives in one step.
    p.lean = 1;
    m.update(1 / 60, p);
    const leanOne = m.motion.lean;
    for (let i = 0; i < 30; i++) m.update(1 / 60, p);
    const leanLater = m.motion.lean;
    p.lean = 0;
    for (let i = 0; i < 30; i++) m.update(1 / 60, p);
    // Crouched.
    p.crouch = 1;
    for (let i = 0; i < 60; i++) m.update(1 / 60, p);
    const crouchHip = hip();
    p.crouch = 0;
    for (let i = 0; i < 60; i++) m.update(1 / 60, p);
    // A drop: airborne falling at 6 m/s, then touching down.
    p.grounded = false;
    p.velocity.set(0, -6, 0);
    for (let i = 0; i < 10; i++) m.update(1 / 60, p);
    p.grounded = true;
    p.velocity.set(0, 0, 0);
    let deepest = 0;
    for (let i = 0; i < 12; i++) {
      m.update(1 / 60, p);
      deepest = Math.min(deepest, m.motion.land);
    }
    for (let i = 0; i < 90; i++) m.update(1 / 60, p);
    const landAfter = m.motion.land;
    // Walking 2.4 m/s forward while the reported speed says twice that (a network sample / AI steering
    // mismatch): the gait follows the real displacement.
    m.reset();
    const slip = [];
    let last = null;
    for (let f = 0; f < 120; f++) {
      p.feet.z = -f * 0.04;
      p.velocity.set(0, 0, -4.8);
      m.update(1 / 60, p);
      m.object.updateMatrixWorld(true);
      const leg = m['lower'].legs[0];
      const foot = m.object.localToWorld(leg.foot.clone());
      const planted = leg.foot.y < 0.081;
      if (f > 40 && planted && last) slip.push(Math.hypot(foot.x - last.x, foot.z - last.z));
      last = planted ? foot : null;
    }
    m.dispose();
    kit.dispose();
    return { standHip, leanOne, leanLater, crouchHip, deepest, landAfter, maxSlip: Math.max(...slip), planted: slip.length };
  });
  assert.ok(r.leanOne > 0.1 && r.leanOne < 0.5, `one frame after a stepped report the body is on its way (${r.leanOne.toFixed(2)})`);
  assert.ok(r.leanLater > 0.95, `and there within half a second (${r.leanLater.toFixed(2)})`);
  assert.ok(r.standHip - r.crouchHip > 0.45, `crouched the hips drop with the capsule (${r.standHip.toFixed(2)} → ${r.crouchHip.toFixed(2)})`);
  assert.ok(r.deepest < -0.03, `the knees give on landing (${r.deepest.toFixed(3)} m)`);
  assert.ok(Math.abs(r.landAfter) < 0.005, 'and the body stands up again');
  assert.ok(r.planted > 10, `feet were planted on many frames (${r.planted})`);
  assert.ok(r.maxSlip < 0.012, `a planted foot does not slide (${(r.maxSlip * 1000).toFixed(1)} mm per frame at most)`);
});

test('3. 요원 모델: the file’s upper body on walking legs up close, the whole figure far away (fewer meshes), switched at the quality’s range; still on the capsule', async () => {
  const r = await page.evaluate(async () => {
    const { AgentModel } = await import('/src/ai/AgentModel.ts');
    const { BotKit } = await import('/src/ai/BotModel.ts');
    const { CHARACTER_VIEW, CHARACTER_NEAR_RANGE } = await import('/src/ai/CharacterMotion.ts');
    const { loadGltfScene } = await import('/src/weapons/view/GltfWeaponView.ts');
    const g = window.game;
    const V = g.player.position.constructor;
    await loadGltfScene('/characters/terrorist.glb');
    const kit = new BotKit();
    const a = AgentModel.create('red', kit);
    const visibleMeshes = () => {
      let n = 0;
      a.object.traverse((o) => {
        if (!o.isMesh) return;
        for (let q = o; q; q = q.parent) if (!q.visible) return;
        n++;
      });
      return n;
    };
    const box = () => {
      a.object.updateMatrixWorld(true);
      let top = -Infinity;
      let bottom = Infinity;
      a.object.traverse((o) => {
        if (!o.isMesh) return;
        for (let q = o; q; q = q.parent) if (!q.visible) return;
        o.geometry.computeBoundingBox();
        const b = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
        top = Math.max(top, b.max.y);
        bottom = Math.min(bottom, b.min.y);
      });
      return [+top.toFixed(2), +bottom.toFixed(2)];
    };
    const pose = { feet: new V(0, 0, 0), yaw: 0, pitch: 0, velocity: new V(), grounded: true, aiming: true, alive: true, deadTime: 0 };
    const saved = CHARACTER_VIEW.eye;
    CHARACTER_VIEW.eye = new V(0, 1.6, 5);
    for (let i = 0; i < 20; i++) a.update(1 / 60, pose);
    const near = { detailed: a.detailed, meshes: visibleMeshes(), box: box() };
    // The upper body has no leg triangles: the boots are gone from it, the trousers almost entirely.
    let bootTris = -1;
    let pantsTris = -1;
    a['upper'].traverse((o) => {
      if (!o.isMesh) return;
      if (o.material.name === 'TR_Boot') bootTris = o.geometry.index.count / 3;
      if (o.material.name === 'TR_Pants') pantsTris = o.geometry.index.count / 3;
    });
    CHARACTER_VIEW.eye = new V(0, 1.6, 200);
    for (let i = 0; i < 5; i++) a.update(1 / 60, pose);
    const far = { detailed: a.detailed, meshes: visibleMeshes(), box: box() };
    CHARACTER_VIEW.eye = saved;
    a.dispose();
    kit.dispose();
    return { near, far, bootTris, pantsTris, range: CHARACTER_VIEW.nearRange, expected: CHARACTER_NEAR_RANGE[g['qualityLevel']] };
  });
  assert.equal(r.near.detailed, true);
  assert.equal(r.far.detailed, false);
  assert.ok(r.far.meshes < r.near.meshes, `the far figure draws fewer meshes (${r.far.meshes} vs ${r.near.meshes})`);
  assert.equal(r.bootTris, 0, 'no boots in the upper body (the animated legs wear them)');
  assert.ok(r.pantsTris >= 0 && r.pantsTris < 300, `trousers cut at the hips (${r.pantsTris} triangles left at the waist)`);
  for (const b of [r.near.box, r.far.box]) {
    assert.ok(b[0] > 1.7 && b[0] < 1.85, `height on the capsule (${b[0]})`);
    assert.ok(Math.abs(b[1]) < 0.08, `feet on the ground (${b[1]})`);
  }
  assert.equal(r.range, r.expected, 'the switch distance follows the quality');
});

test('4. knives in third person: the M9 slashes across, the karambit hooks the other way, the butterfly thrusts; a gun still kicks', async () => {
  const r = await page.evaluate(async () => {
    const { BotModel, BotKit } = await import('/src/ai/BotModel.ts');
    const { SLASH_STRIKE } = await import('/src/weapons/meleeMotion.ts');
    const V = window.game.player.position.constructor;
    const kit = new BotKit('blue');
    const m = new BotModel(kit);
    const pose = { feet: new V(0, 0, 0), yaw: 0, pitch: 0, velocity: new V(), grounded: true, aiming: true, alive: true, deadTime: 0 };
    for (let i = 0; i < 20; i++) m.update(1 / 60, pose);
    const arms = m['arms'];
    const restY = arms.rotation.y;
    const restZ = arms.position.z;
    const out = {};
    for (const [key, asset] of [['m9', undefined], ['karambit', 'model:karambit'], ['butterfly', 'model:butterfly']]) {
      m.setWeapon('karambit', asset);
      m.onShot();
      m.update(SLASH_STRIKE, pose);
      out[key] = { style: m.motion.slashStyle, turn: +(arms.rotation.y - restY).toFixed(3), push: +(arms.position.z - restZ).toFixed(3) };
      for (let i = 0; i < 40; i++) m.update(1 / 60, pose);
    }
    m.setWeapon('ar01', undefined);
    m.onShot();
    out.gun = { kick: m['kick'], slashing: m.motion.sinceSlash < 0.32 };
    m.dispose();
    kit.dispose();
    return out;
  });
  assert.deepEqual([r.m9.style, r.karambit.style, r.butterfly.style], ['m9', 'karambit', 'butterfly']);
  assert.ok(r.m9.turn > 0.5, `M9: a wide slash across (${r.m9.turn})`);
  assert.ok(r.karambit.turn < -0.4, `karambit: hooks across the other way (${r.karambit.turn})`);
  assert.ok(r.butterfly.push < -0.15 && Math.abs(r.butterfly.turn) < 0.2, `butterfly: a straight thrust (${JSON.stringify(r.butterfly)})`);
  assert.deepEqual(r.gun, { kick: 1, slashing: false });
});

/** Knife in hand (slot 3): the M9, or a knife item bought with credits ('karambit.claw' / 'karambit.butterfly'). */
const holdKnife = (skinId) =>
  page.evaluate(async (skinId) => {
    const g = window.game;
    if (skinId) {
      if (!g.account.items.some((i) => i.skinId === skinId)) {
        const r = await g.economy.purchase(skinId);
        if (!r.ok) return `buy ${skinId}: ${r.message ?? r.error}`;
      }
      const item = g.account.items.find((i) => i.skinId === skinId).itemId;
      await g.economy.equip('knife', 'karambit', item);
    } else await g.economy.equip('knife', 'karambit', null);
    g.weapons.equipSlot(g.weapons.loadout.findIndex((w) => w.def.id === 'karambit'));
    g.showWeaponModel(g.weapons.weapon.def);
    // Until the model has loaded and the switch is over.
    for (let i = 0; i < 400 && (!g.viewModel.currentView || g.viewModel['incoming']); i++) {
      await new Promise((res) => setTimeout(res, 10));
      window.T.run(2);
    }
    window.T.run(40);
    return g.viewModel.currentView?.meleeStyle ?? 'm9';
  }, skinId);

test('5. knives in first person: each its own stance and attack on the shared timeline (the hit is still judged at the slash)', async () => {
  const styles = {};
  const motions = {};
  for (const [key, skin] of [['m9', null], ['karambit', 'karambit.claw'], ['butterfly', 'karambit.butterfly']]) {
    styles[key] = await holdKnife(skin);
    motions[key] = await page.evaluate(async () => {
      const { SLASH_STRIKE } = await import('/src/weapons/meleeMotion.ts');
      const vm = window.game.viewModel;
      const pivot = vm['pivot'];
      const anim = (sinceShot) => ({ category: 'melee', equip: 1, reload: null, sinceShot, fireInterval: 0.5, inspect: null });
      const motion = { lookYaw: 0, lookPitch: 0, speed01: 0, grounded: true, crouching: false, aim: 0 };
      for (let i = 0; i < 30; i++) vm.update(1 / 60, motion, anim(Infinity));
      const rest = { x: pivot.position.x, z: pivot.position.z, ry: pivot.rotation.y, rz: pivot.rotation.z };
      vm.update(0, motion, anim(SLASH_STRIKE));
      const hit = { x: pivot.position.x - rest.x, z: pivot.position.z - rest.z, ry: pivot.rotation.y - rest.ry, rz: pivot.rotation.z - rest.rz };
      vm.update(0, motion, anim(Infinity));
      return { rest, hit };
    });
  }
  assert.deepEqual(styles, { m9: 'm9', karambit: 'karambit', butterfly: 'butterfly' });
  const { m9, karambit, butterfly } = motions;
  assert.ok(m9.hit.x < -0.08 && m9.hit.ry > 0.5, `M9: sweeps across from the right (${JSON.stringify(m9.hit)})`);
  assert.ok(karambit.hit.x > 0.06 && karambit.hit.ry < -0.4, `karambit: hooks the other way (${JSON.stringify(karambit.hit)})`);
  assert.ok(butterfly.hit.z < -0.14 && Math.abs(butterfly.hit.ry) < 0.1, `butterfly: thrusts straight in (${JSON.stringify(butterfly.hit)})`);
  // Their stances differ at rest too.
  assert.ok(Math.abs(karambit.rest.rz - m9.rest.rz) > 0.08, 'the karambit is held rolled in');
  // And the knife still kills in one hit, reach and rate unchanged: tests/melee.test.mjs (unchanged).
});

/** Equips a gun and returns its view-model pivot over a sequence of hand-made animation states. */
const gunMotion = (id, frames) =>
  page.evaluate(
    async ([id, frames]) => {
      const { WEAPONS } = await import('/src/weapons/weapons.ts');
      const g = window.game;
      g.weapons.setLoadout([WEAPONS[id], WEAPONS.pis02, WEAPONS.karambit], 0);
      g.showWeaponModel(g.weapons.weapon.def);
      for (let i = 0; i < 400 && (!g.viewModel.currentView || g.viewModel['incoming']); i++) {
        await new Promise((res) => setTimeout(res, 10));
        window.T.run(2);
      }
      window.T.run(90);
      const vm = g.viewModel;
      const pivot = vm['pivot'];
      const def = WEAPONS[id];
      const out = [];
      for (const f of frames) {
        const anim = { category: def.category, equip: f.equip ?? 1, reload: f.reload ?? null, sinceShot: Infinity, fireInterval: 0.1, inspect: null, motion: def.view.motion };
        const motion = { lookYaw: 0, lookPitch: 0, speed01: 0, grounded: true, crouching: false, aim: f.aim ?? 0 };
        for (let i = 0; i < (f.n ?? 1); i++) vm.update(f.dt ?? 1 / 60, motion, anim);
        out.push({ y: +pivot.position.y.toFixed(4), rx: +pivot.rotation.x.toFixed(4), rz: +pivot.rotation.z.toFixed(4) });
      }
      return out;
    },
    [id, frames],
  );

test('5b. weapon motion: reload brought in quickly, held while the hands work, eased back; variants differ; a draw swings past rest and settles; sights up dip and roll the weapon a touch', async () => {
  // Reload: rest, at the end of the way in (0.14), well inside the hold (0.3 / 0.7), on the way back (0.93), done.
  const reload = (id) => gunMotion(id, [{ n: 60 }, { reload: 0.05, dt: 0 }, { reload: 0.14, dt: 0 }, { reload: 0.3, dt: 0 }, { reload: 0.7, dt: 0 }, { reload: 0.93, dt: 0 }, { n: 1, dt: 0 }]);
  const ar = await reload('ar01');
  const rest = ar[0].rz;
  const at = (i) => ar[i].rz - rest;
  assert.ok(at(1) > 0.5 * at(3), `most of the way after a third of the way-in time (eased out: ${at(1).toFixed(3)} of ${at(3).toFixed(3)})`);
  assert.ok(Math.abs(at(2) - at(3)) < 0.06 && Math.abs(at(3) - at(4)) < 0.06, `held while the hands work (${at(2).toFixed(3)}, ${at(3).toFixed(3)}, ${at(4).toFixed(3)})`);
  assert.ok(at(5) > 0 && at(5) < 0.6 * at(3), `on the way back (${at(5).toFixed(3)})`);
  // AR-02 (the variant) turns over less for its magazine than AR-01.
  const ar2 = await reload('ar02');
  assert.ok(ar2[3].rz - ar2[0].rz < 0.85 * at(3), `AR-02 rolls less (${(ar2[3].rz - ar2[0].rz).toFixed(3)} vs ${at(3).toFixed(3)})`);
  // Draw: at 85 % the rifle has swung a little past its rest (muzzle up), at 100 % it is exactly at rest.
  const draw = await gunMotion('ar01', [{ n: 60 }, { equip: 0.85, dt: 0 }, { equip: 1, dt: 0 }]);
  assert.ok(draw[1].rx > draw[0].rx + 0.005, `swings past rest (${(draw[1].rx - draw[0].rx).toFixed(4)} rad)`);
  assert.ok(Math.abs(draw[2].rx - draw[0].rx) < 1e-3, 'settled at rest');
  // Sights up: a frame into the aim the weapon is rolled a touch; settled later.
  const aim = await gunMotion('ar01', [{ n: 60 }, { aim: 1, n: 3 }, { aim: 1, n: 90 }]);
  assert.ok(Math.abs(aim[1].rz - aim[0].rz) > 0.005, `rolls a touch coming up (${(aim[1].rz - aim[0].rz).toFixed(4)})`);
  assert.ok(Math.abs(aim[2].rz - aim[0].rz) < 0.002, 'and settles');
});

test('6. weapon materials: the SR-01 stock is olive (it was white in the file), dark metal still reflects, skins keep their colours — first and third person', async () => {
  const r = await page.evaluate(async () => {
    const { loadGltfScene } = await import('/src/weapons/view/GltfWeaponView.ts');
    const { SkinRenderer } = await import('/src/skins/SkinRenderer.ts');
    const out = { stock: {}, darkMetal: [], skin: null };
    for (const url of ['/weapons/sr01.glb', '/weapons/tp/sr01.glb']) {
      const scene = await loadGltfScene(url);
      scene.traverse((o) => {
        if (o.isMesh && o.material.name === 'Stock_Olive') out.stock[url] = o.material.color.getHexString();
      });
    }
    for (const url of ['/weapons/ar01.glb', '/weapons/ar02.glb', '/weapons/smg02.glb', '/weapons/lmg02.glb', '/weapons/tp/ar01.glb']) {
      const scene = await loadGltfScene(url);
      scene.traverse((o) => {
        const m = o.material;
        if (!o.isMesh || !m || m.metalness < 0.55 || /glass|lens|bore/i.test(m.name)) return;
        const lum = 0.2126 * m.color.r + 0.7152 * m.color.g + 0.0722 * m.color.b;
        if (lum < 0.06) out.darkMetal.push(`${url}:${m.name}:${lum.toFixed(3)}`);
      });
    }
    const scene = await loadGltfScene('/weapons/sr01.glb');
    const copy = scene.clone(true);
    new SkinRenderer().dressWeapon({ object: copy }, 'sr01', 'finish:sr01.olive');
    copy.traverse((o) => {
      if (o.isMesh && o.material.name.startsWith('Stock_Olive@')) out.skin = o.material.color.getHexString();
    });
    return out;
  });
  for (const url of ['/weapons/sr01.glb', '/weapons/tp/sr01.glb']) {
    const hex = r.stock[url];
    assert.ok(hex && hex !== 'ffffff', `${url}: stock not white (${hex})`);
    const [cr, cg, cb] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    assert.ok(cg > cr && cg > cb, `${url}: an olive green (${hex})`);
  }
  assert.deepEqual(r.darkMetal, [], 'no metal finish so dark it reads as a hole');
  assert.equal(r.skin, '4b4f36', 'the olive skin keeps its own colour');
});

test('7. maps: the wall-base grime is measured from the map’s ground (the spawns’ level); roads and slabs carry stains', async () => {
  const r = await page.evaluate(async () => {
    const { surfaceGround, SURFACE_PRESETS } = await import('/src/world/SurfaceMaterials.ts');
    const g = window.game;
    const ys = [...g.map.attackSpawns, ...g.map.defenseSpawns].map((s) => s.position.y).sort((a, b) => a - b);
    return {
      ground: surfaceGround(),
      median: ys[ys.length >> 1],
      grime: ['concrete', 'brick', 'paintedMetal', 'stone'].map((k) => SURFACE_PRESETS[k].baseGrime),
      oil: ['asphalt', 'concrete'].map((k) => SURFACE_PRESETS[k].oil),
      errors: [],
    };
  });
  assert.equal(r.ground, r.median);
  for (const v of [...r.grime, ...r.oil]) assert.ok(v > 0);
  assert.deepEqual(page.errors, []);
});
