// Weapon handling in the real game (frames driven at 1/60 s): switching puts
// the weapon in hand away before the new one comes up, inside the new one's
// draw time (never later to fire), without a model popping in view or
// staying behind; every kind of weapon draws and reloads its own way, the
// reload jolts on its sounds, the SMG's hand goes to the magazine, the
// shotgun racks its pump after a reload and the SR-01's bolt is open while it
// reloads; reload edge cases (switching away, full magazine, firing the moment
// it completes, dying mid-reload) keep the ammo right; death and respawn reset
// the view model; the HUD follows the weapon through all of it, the buy menu
// and a round change included.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, openGame, installFrameDriver } from './harness.mjs';

let env;
let page;

before(async () => {
  env = await startEnv();
  page = await openGame(env, { mode: 'training' });
  await page.click('.play-button');
  await page.waitForFunction(() => window.game.input.active);
  await installFrameDriver(page);
  await page.evaluate(async () => {
    window.T.stopLoop();
    const g = window.game;
    const T = window.T;
    T.W = (await import('/src/weapons/weapons.ts')).WEAPONS;
    T.VM = await import('/src/weapons/view/ViewModelLayer.ts');
    T.WV = await import('/src/weapons/view/WeaponView.ts');
    /** The view model's offset from its rest pose: y (m), pitch / roll (rad). */
    T.pose = (layer = g.viewModel) => {
      const p = layer.pivot;
      return { y: p.position.y - layer.restPosition.y, x: p.position.x - layer.restPosition.x, z: p.position.z - layer.restPosition.z, rx: p.rotation.x - layer.restRotation.x, rz: p.rotation.z - layer.restRotation.z };
    };
    T.hud = () => ({
      name: document.querySelector('.weapon-name').textContent,
      mag: document.querySelector('.ammo-mag').textContent,
      reserve: document.querySelector('.ammo-reserve').textContent,
      status: document.querySelector('.weapon-status').textContent,
    });
    /** Holds the trigger for `frames` frames. */
    T.fire = (frames) => {
      g.input.mouseButtons = 1;
      T.run(frames);
      g.input.mouseButtons = 0;
      T.run(1);
    };
    /** A standalone view-model layer holding weapon `id` (its GLB). */
    T.layer = async (id) => {
      const def = T.W[id];
      const layer = new T.VM.ViewModelLayer(16 / 9);
      const view = (await T.WV.loadWeaponView(def.view)) ?? T.WV.createWeaponView(def.view);
      layer.setView(view, def.view.pose, 0, def.category);
      return { def, layer, view, anim: { category: def.category, equip: 1, reload: null, sinceShot: 99, fireInterval: 60 / def.fireRate, inspect: null } };
    };
    T.still = { lookYaw: 0, lookPitch: 0, speed01: 0, grounded: true, crouching: false };
    g.combat.protection = 1e9;
    T.run(60);
  });
});
after(async () => {
  await page?.context().close();
  await env?.close();
});

test('switching: the weapon in hand goes down out of view first, then the new one comes up; ready to fire exactly at its draw time; nothing pops in view', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    const vm = g.viewModel;
    const ws = g.weapons;
    const frames = [];
    ws.equipSlot(1); // AR-01 -> SR-01 (draw 1.0 s)
    let readyAt = null;
    for (let f = 1; f <= 80; f++) {
      T.run(1);
      const p = T.pose();
      frames.push({ f, holster: vm.holstering, model: vm.inHand.object.name, selected: vm.currentView.object.name, y: p.y, rx: p.rx });
      if (readyAt === null && ws.weapon.status === 'ready') readyAt = f / 60;
    }
    return { frames, readyAt, equipTime: ws.weapon.def.equipTime };
  });
  const holster = r.frames.filter((x) => x.holster);
  assert.ok(holster.length >= 8 && holster.length <= 10, `put away for ~0.15 s (${holster.length} frames)`);
  // Going down: monotonic, ending out of view (more than 18 cm down).
  for (let i = 1; i < holster.length; i++) assert.ok(holster[i].y <= holster[i - 1].y + 1e-9, 'the old weapon only goes down');
  assert.ok(holster.at(-1).y < -0.18, `out of view before the swap (${holster.at(-1).y.toFixed(3)} m)`);
  const after = r.frames.filter((x) => !x.holster);
  assert.notEqual(after[0].model, holster[0].model, 'the new model after the swap');
  assert.ok(r.frames.every((x) => x.selected === after[0].model), 'the selected weapon\'s model is reported from the start (currentView)');
  assert.ok(after[0].y < -0.18, `the new one starts out of view (${after[0].y.toFixed(3)} m)`);
  // Coming up: monotonic until in hand.
  for (let i = 1; i < after.length; i++) assert.ok(after[i].y >= after[i - 1].y - 1e-9, 'the new weapon only comes up');
  assert.ok(Math.abs(after.at(-1).y) < 0.002, 'in hand at the end');
  // Every frame-to-frame move while in view (above -12 cm) is small: no teleport.
  for (let i = 1; i < r.frames.length; i++) {
    const a = r.frames[i - 1];
    const b = r.frames[i];
    if (a.y > -0.12 && b.y > -0.12) assert.ok(Math.abs(b.y - a.y) < 0.05, `frame ${b.f}: ${(b.y - a.y).toFixed(3)} m in one frame`);
  }
  assert.ok(Math.abs(r.readyAt - r.equipTime) <= 1 / 60 + 1e-9, `ready at its draw time (${r.readyAt} s, draw ${r.equipTime} s): the holster adds nothing`);
});

test('each kind of weapon draws and reloads its own way', async () => {
  const r = await page.evaluate(async () => {
    const T = window.T;
    const draw = {};
    const reload = {};
    for (const id of ['ar01', 'smg01', 'pis01', 'sg01', 'sr01', 'karambit']) {
      const v = await T.layer(id);
      v.anim.equip = 0.35;
      for (let i = 0; i < 4; i++) v.layer.update(1 / 60, T.still, v.anim);
      const p = T.pose(v.layer);
      draw[id] = [p.x, p.y, p.rx, p.rz].map((n) => +n.toFixed(3));
      if (id === 'karambit') continue;
      v.anim.equip = 1;
      v.anim.reload = 0.5;
      for (let i = 0; i < 4; i++) v.layer.update(1 / 60, T.still, v.anim);
      const q = T.pose(v.layer);
      reload[id] = [q.x, q.y, q.rx, q.rz].map((n) => +n.toFixed(3));
    }
    return { draw, reload };
  });
  const distinct = (o) => new Set(Object.values(o).map((v) => v.join())).size === Object.keys(o).length;
  assert.ok(distinct(r.draw), `draws differ: ${JSON.stringify(r.draw)}`);
  assert.ok(distinct(r.reload), `reloads differ: ${JSON.stringify(r.reload)}`);
  assert.ok(r.reload.pis01[3] < 0 && r.reload.ar01[3] > 0, 'the pistol tips left, the rifle rolls right');
  assert.ok(r.reload.sg01[2] > 0.25 && r.reload.sg01[2] > r.reload.ar01[2], 'the shotgun comes up muzzle high, its loading port toward the eye');
});

test('reload details: jolts on the reload sounds; the SMG hand goes to its magazine; the shotgun racks its pump after reloading; the SR-01 bolt is open while it reloads', async () => {
  const r = await page.evaluate(async () => {
    const T = window.T;
    const out = {};
    // Shotgun: a push for every shell (0.15, 0.4, 0.65): the weapon moves forward at those moments only.
    const sg = await T.layer('sg01');
    const zAt = (t) => {
      sg.anim.reload = t;
      sg.layer.update(1 / 120, T.still, sg.anim);
      return T.pose(sg.layer).z;
    };
    out.sgShell = [0.19, 0.44, 0.69].map((t) => +(zAt(t) * 1000).toFixed(1));
    out.sgBetween = [0.3, 0.55].map((t) => +(zAt(t) * 1000).toFixed(1));
    // Reload done: the pump is racked (support hand back) 0.27 s later.
    const hand = sg.view.supportAnchor;
    const rest = hand.position.z;
    sg.anim.reload = 0.99;
    sg.layer.update(1 / 120, T.still, sg.anim);
    sg.anim.reload = null;
    sg.anim.sinceShot = 30;
    let t = 0;
    let racked = 0;
    while (t < 0.6) {
      sg.layer.update(1 / 120, T.still, sg.anim);
      t += 1 / 120;
      racked = Math.max(racked, hand.position.z - rest);
    }
    out.sgPump = +(racked * 1000).toFixed(1);
    out.sgPumpEnd = +((hand.position.z - rest) * 1000).toFixed(1);
    // SMG: the support hand leaves the handguard for the magazine and comes back.
    const smg = await T.layer('smg01');
    const left = () => smg.layer.currentArms.left.position.clone();
    smg.layer.update(1 / 60, T.still, smg.anim);
    const idle = left();
    smg.anim.reload = 0.5;
    smg.layer.update(1 / 60, T.still, smg.anim);
    out.smgReach = +(left().distanceTo(idle) * 100).toFixed(1);
    smg.anim.reload = null;
    smg.layer.update(1 / 60, T.still, smg.anim);
    out.smgBack = +(left().distanceTo(idle) * 100).toFixed(2);
    // SR-01: bolt open mid-reload, closed at the end (and at rest without a reload).
    const sr = await T.layer('sr01');
    const bolt = sr.view.bolt;
    const boltRest = bolt.position.z;
    const boltAt = (reload) => {
      sr.anim.reload = reload;
      sr.layer.update(1 / 60, T.still, sr.anim);
      return { back: +((bolt.position.z - boltRest) * 1000).toFixed(1), lift: +bolt.rotation.z.toFixed(2) };
    };
    out.sr = { mid: boltAt(0.5), end: boltAt(0.995), none: boltAt(null) };
    return out;
  });
  assert.ok(r.sgShell.every((z) => z < -3), `a push at each shell (${r.sgShell} mm)`);
  assert.ok(r.sgBetween.every((z) => Math.abs(z) < 0.5), `still between shells (${r.sgBetween} mm)`);
  assert.equal(r.sgPump, 75, 'pump racked after the reload');
  assert.equal(r.sgPumpEnd, 0, 'and pushed home');
  assert.ok(r.smgReach > 5, `SMG hand reaches for the magazine (${r.smgReach} cm)`);
  assert.ok(r.smgBack < 0.1, `and is back on the handguard after (${r.smgBack} cm)`);
  assert.ok(r.sr.mid.back > 80 && r.sr.mid.lift > 1, `SR-01 bolt open mid-reload (${JSON.stringify(r.sr.mid)})`);
  assert.deepEqual(r.sr.end, { back: 0, lift: 0 }, 'closed at the end');
  assert.deepEqual(r.sr.none, { back: 0, lift: 0 });
});

test('reload edge cases: switching away cancels it (ammo kept); full magazine: no reload; a held trigger fires the moment it completes; HUD follows', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    const ws = g.weapons;
    const ar = ws.loadout[0];
    ws.equipSlot(0);
    T.run(60);
    const out = {};
    // Full magazine: R does nothing.
    T.fire(0);
    window.T.run(1);
    g.input.latchedKeys.add(g.input.bindings?.reload ?? 'KeyR');
    T.run(2);
    out.full = { status: ar.status, hud: T.hud() };
    // Ten rounds, then reload, switch away half-way through.
    T.fire(60);
    out.afterFire = { mag: ar.magazine, reserve: ar.reserve };
    ar.magazine = 20;
    T.run(1);
    g.input.latchedKeys.add(g.input.bindings?.reload ?? 'KeyR');
    T.run(2);
    out.reloading = { status: ar.status, hud: T.hud() };
    T.run(60);
    ws.equipSlot(1);
    T.run(70);
    out.away = { arStatus: ar.status, mag: ar.magazine, reserve: ar.reserve, hud: T.hud() };
    ws.equipSlot(0);
    T.run(40);
    out.back = { status: ar.status, mag: ar.magazine, reserve: ar.reserve, hud: T.hud() };
    // Reload with the trigger held: the first round goes the tick the reload completes.
    g.input.latchedKeys.add(g.input.bindings?.reload ?? 'KeyR');
    T.run(1);
    const shots0 = ws.shotsFired;
    g.input.mouseButtons = 1;
    let doneAt = null;
    let firedAt = null;
    for (let f = 0; f < 200 && firedAt === null; f++) {
      T.run(1);
      if (doneAt === null && ar.status === 'ready') doneAt = f;
      if (ws.shotsFired > shots0) firedAt = f;
    }
    g.input.mouseButtons = 0;
    T.run(1);
    out.fireAfter = { doneAt, firedAt, mag: ar.magazine };
    return out;
  });
  assert.equal(r.full.status, 'ready', 'no reload on a full magazine');
  assert.equal(r.full.hud.status, '');
  assert.equal(r.reloading.status, 'reloading');
  assert.equal(r.reloading.hud.status, '재장전 중');
  assert.equal(r.away.mag, 20, 'switching away: magazine unchanged');
  assert.equal(r.away.hud.name, 'SR-01', 'the HUD shows the weapon in hand');
  assert.deepEqual([r.back.status, r.back.mag, r.back.hud.name, r.back.hud.mag, r.back.hud.status], ['ready', 20, 'AR-01', '20', ''], 'back: no reload carried over');
  assert.equal(r.fireAfter.firedAt, r.fireAfter.doneAt, `fires the frame the reload completes (${JSON.stringify(r.fireAfter)})`);
  assert.equal(r.fireAfter.mag, 29);
});

test('death mid-reload and mid-switch: respawn with full ammo, ready, the right model in hand, no motion carried over', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    const ws = g.weapons;
    ws.equipSlot(0);
    T.run(60);
    const ar = ws.loadout[0];
    ar.magazine = 5;
    g.input.latchedKeys.add(g.input.bindings?.reload ?? 'KeyR');
    T.run(30);
    const midReload = ar.status;
    g.viewModel.onShot('rifle');
    ws.equipSlot(1);
    T.run(2);
    const switching = g.viewModel.holstering;
    g.combat.protection = 0;
    g.combat.applyDamage({ amount: 999, zone: 'body', sourceId: 'test', weaponId: 'ar01', point: g.player.position.clone(), direction: g.player.position.clone().set(0, 0, 1), distance: 1 });
    T.run(10);
    const dead = !g.combat.alive;
    g.respawn();
    g.combat.protection = 1e9;
    T.run(1);
    const vm = g.viewModel;
    const out = {
      midReload,
      switching,
      dead,
      holstering: vm.holstering,
      kick: vm.kick,
      model: vm.currentView.object.name,
      weapon: ws.weapon.def.id,
      ammo: ws.loadout.map((w) => [w.def.id, w.magazine, w.reserve, w.status]),
      hud: T.hud(),
    };
    T.run(70);
    out.ready = ws.weapon.status;
    return out;
  });
  assert.equal(r.midReload, 'reloading');
  assert.equal(r.switching, true);
  assert.equal(r.dead, true);
  assert.equal(r.holstering, false, 'no switch in progress after the respawn');
  assert.equal(r.kick, 0, 'no kick carried over');
  assert.equal(r.weapon, 'sr01');
  assert.match(r.model, /Rifle_Root|sr01|SR/i, `the weapon in hand is the one selected (${r.model})`);
  assert.deepEqual(r.ammo, [['ar01', 30, 90, 'ready'], ['sr01', 5, 30, 'ready'], ['karambit', 0, 0, 'ready']]);
  assert.deepEqual([r.hud.name, r.hud.mag, r.hud.reserve, r.hud.status], ['SR-01', '5', '30', '']);
  assert.equal(r.ready, 'ready');
  assert.deepEqual(page.errors, []);
});

test('switch spam: one model in the hands at a time, the last pick drawn, nothing left behind', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    const ws = g.weapons;
    const pivot = g.viewModel.pivot;
    const counts = [];
    for (const slot of [1, 2, 0, 2, 1, 0, 1]) {
      ws.equipSlot(slot);
      T.run(3);
      counts.push(pivot.children.length);
    }
    T.run(90);
    counts.push(pivot.children.length);
    return { counts, weapon: ws.weapon.def.id, model: g.viewModel.inHand.object.name, selected: g.viewModel.currentView.object.name, holstering: g.viewModel.holstering };
  });
  assert.ok(r.counts.every((c) => c === 2), `weapon + arms only (${r.counts})`);
  assert.equal(r.weapon, 'sr01');
  assert.equal(r.holstering, false);
  assert.equal(r.model, r.selected, 'the model in hand is the selected one');
});

test('team match: the HUD and the weapon agree through the buy menu, a round change and a reload cut by the round end', async () => {
  const p2 = await openGame(env, { mode: 'team', objective: 'elimination' });
  try {
    await p2.click('.play-button');
    await p2.waitForFunction(() => window.game.input.active && window.game.teamMatch);
    await installFrameDriver(p2);
    const r = await p2.evaluate(async () => {
      const g = window.game;
      const T = window.T;
      T.stopLoop();
      const { WEAPONS } = await import('/src/weapons/weapons.ts');
      const hud = () => ({ name: document.querySelector('.weapon-name').textContent, mag: document.querySelector('.ammo-mag').textContent, status: document.querySelector('.weapon-status').textContent });
      for (const b of g.squad.bots) b.combat.protection = 1e9;
      g.combat.protection = 1e9;
      // Buy time: a pistol and an SMG, then the menu closes; the HUD shows what is in hand.
      g.openBuyMenu();
      const menu = g.buyMenuOpen;
      const shots0 = g.weapons.shotsFired;
      g.input.mouseButtons = 1;
      T.run(20);
      g.input.mouseButtons = 0;
      const firedInMenu = g.weapons.shotsFired - shots0;
      g.closeBuyMenu(true);
      g.weapons.setLoadout([WEAPONS.smg01, WEAPONS.pis01, WEAPONS.karambit], 0);
      T.run(40);
      const bought = hud();
      // Live: the other team wiped out; in the last second of the result screen the player starts a
      // reload (2.1 s) that the next round's start cuts short.
      while (g.teamMatch.phase !== 'live') T.run(1);
      const smg = g.weapons.weapon;
      smg.magazine = 3;
      for (const b of g.squad.bots) if (b.team !== g.localTeam) {
        b.combat.protection = 0;
        b.combat.applyDamage({ amount: 999, zone: 'body', sourceId: 'local', weaponId: 'smg01', point: b.position.clone(), direction: b.position.clone().set(0, 0, 1), distance: 5 });
      }
      while (g.teamMatch.phase !== 'result') T.run(1);
      while (g.teamMatch.phaseLeft > 1) T.run(1);
      g.input.latchedKeys.add(g.input.bindings?.reload ?? 'KeyR');
      T.run(5);
      const reloading = { status: smg.status, hud: hud() };
      while (g.teamMatch.phase !== 'prep') T.run(1);
      T.run(2);
      const w = g.weapons.weapon;
      return { menu, firedInMenu, bought, reloading, next: { id: w.def.id, status: w.status, mag: w.magazine, hud: hud(), holstering: g.viewModel.holstering } };
    });
    assert.equal(r.menu, true);
    assert.equal(r.firedInMenu, 0, 'no shooting through the buy menu');
    assert.deepEqual(r.bought, { name: 'SMG-01', mag: '30', status: '' });
    assert.equal(r.reloading.status, 'reloading');
    assert.equal(r.reloading.hud.status, '재장전 중');
    // The survivor keeps the SMG with its 3 rounds; the reload cut by the round end is gone (no half reload).
    assert.equal(r.next.id, 'smg01');
    assert.equal(r.next.status, 'ready');
    assert.equal(r.next.mag, 3);
    assert.deepEqual(r.next.hud, { name: 'SMG-01', mag: '3', status: '' });
    assert.equal(r.next.holstering, false);
    assert.deepEqual(p2.errors, []);
  } finally {
    await p2.context().close();
  }
});
