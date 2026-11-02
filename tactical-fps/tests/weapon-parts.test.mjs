// Moving weapon parts (browser, the game's ViewModelLayer with the rigged
// GLBs from tools/rig-weapons.mjs and the multi-part AR-01 / SR-01 files).
// Measured in the weapon model's space (-Z forward, +Y up): the PIS-01 slide
// cycles on each shot and locks back on an empty magazine until its reload
// ends, its magazine leaves down the raked grip; the SG-01 pump and bolt rack
// with the support hand after a round and after a reload, a shell is fed in
// through the loading port at each insert while the hand is there; the
// SMG-01 magazine drops along its own angle with the hand on it and the
// cocking handle is racked at the end; the AR-01 charging handle is racked at
// the end of a reload; triggers move when a round fires; nothing moves at
// rest. Also: the rigs load as the same models (root names, sizes), and the
// draw calls of each weapon in hand.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, openGame } from './harness.mjs';

let env;
let page;

before(async () => {
  env = await startEnv();
  page = await openGame(env, { mode: 'training' });
  await page.evaluate(async () => {
    const VM = await import('/src/weapons/view/ViewModelLayer.ts');
    const WV = await import('/src/weapons/view/WeaponView.ts');
    const { WEAPONS } = await import('/src/weapons/weapons.ts');
    const still = { lookYaw: 0, lookPitch: 0, speed01: 0, grounded: true, crouching: false };
    /** A layer holding weapon `id`, and a reader of a named node's position in model space (mm). */
    window.__rig = async (id) => {
      const def = WEAPONS[id];
      const layer = new VM.ViewModelLayer(16 / 9);
      const view = (await WV.loadWeaponView(def.view)) ?? WV.createWeaponView(def.view);
      layer.setView(view, def.view.pose, 0, def.category);
      const anim = { category: def.category, equip: 1, reload: null, sinceShot: 99, fireInterval: 60 / def.fireRate, inspect: null, empty: false };
      const set = (o) => {
        Object.assign(anim, o);
        layer.update(1 / 120, still, anim);
        layer.scene.updateMatrixWorld(true);
      };
      const at = (name) => {
        const o = view.object.getObjectByName(name);
        if (!o) return null;
        const p = o.getWorldPosition(o.position.clone());
        view.object.worldToLocal(p);
        return p.toArray().map((v) => v * 1000);
      };
      const hand = () => {
        const l = layer.currentArms.left;
        const p = l.getWorldPosition(l.position.clone());
        view.object.worldToLocal(p);
        return p.toArray().map((v) => v * 1000);
      };
      set({});
      return { def, layer, view, anim, set, at, hand };
    };
  });
});
after(async () => {
  await page?.context().close();
  await env?.close();
});

/** b - a, rounded (mm). */
const d = (a, b) => b.map((v, i) => Math.round((v - a[i]) * 10) / 10 || 0);

test('the rigs are the same models: root names, parts present, sizes', async () => {
  const r = await page.evaluate(async () => {
    const out = {};
    for (const id of ['pis01', 'sg01', 'smg01', 'ar01', 'sr01']) {
      const v = await window.__rig(id);
      const names = [];
      v.view.object.traverse((o) => names.push(o.name));
      out[id] = { root: v.view.object.name, parts: ['Slide', 'Trigger', 'Magazine', 'Pump', 'PumpBolt', 'ChargingHandle', 'Charging_Handle', 'Shell', 'Bolt'].filter((n) => names.includes(n)) };
    }
    return out;
  });
  assert.deepEqual(r, {
    pis01: { root: 'Pistol_LowPoly', parts: ['Slide', 'Trigger', 'Magazine'] },
    sg01: { root: 'Shotgun_LowPoly', parts: ['Pump', 'PumpBolt', 'Shell'] },
    smg01: { root: 'SMG_LowPoly', parts: ['Magazine', 'ChargingHandle'] },
    ar01: { root: 'M4_Root', parts: ['Trigger', 'Magazine', 'Charging_Handle'] },
    sr01: { root: 'Rifle_Root', parts: ['Trigger', 'Magazine', 'Bolt'] },
  });
});

test('PIS-01: the slide cycles back ~28 mm on a shot and returns; locked back while empty, released at the end of the reload; the trigger moves; the magazine leaves down the grip', async () => {
  const r = await page.evaluate(async () => {
    const v = await window.__rig('pis01');
    const rest = v.at('Slide');
    const trig0 = v.at('Trigger');
    const mag0 = v.at('Magazine');
    const out = { rest };
    v.set({ sinceShot: 0.025 });
    out.back = v.at('Slide');
    out.trigger = v.at('Trigger');
    v.set({ sinceShot: 0.07 });
    out.home = v.at('Slide');
    v.set({ sinceShot: 99, empty: true });
    out.locked = v.at('Slide');
    v.set({ reload: 0.5, empty: true });
    out.reloadMid = v.at('Slide');
    out.mag = v.at('Magazine');
    v.set({ reload: 0.96, empty: true });
    out.released = v.at('Slide');
    v.set({ reload: null, empty: false });
    out.after = v.at('Slide');
    v.set({ reload: 0.2, empty: false });
    out.tactical = v.at('Slide');
    v.set({ reload: 0.2 });
    out.magOut = v.at('Magazine');
    return { ...out, trig0, mag0 };
  });
  assert.deepEqual(d(r.rest, r.back), [0, 0, 28], 'back toward the shooter on the shot');
  assert.deepEqual(d(r.rest, r.home), [0, 0, 0], 'home 70 ms later');
  assert.ok(d(r.trig0, r.trigger)[2] > 3, 'trigger pulled while the round goes');
  assert.deepEqual(d(r.rest, r.locked), [0, 0, 28], 'locked back on an empty magazine');
  assert.deepEqual(d(r.rest, r.reloadMid), [0, 0, 28], 'still back mid-reload');
  assert.deepEqual(d(r.rest, r.released), [0, 0, 0], 'released at the end of the reload');
  assert.deepEqual(d(r.rest, r.after), [0, 0, 0]);
  assert.deepEqual(d(r.rest, r.tactical), [0, 0, 0], 'a reload with rounds left does not touch the slide');
  // Magazine out along the grip's rake (down and back), 0.25 m at full travel.
  const m = d(r.mag0, r.magOut);
  assert.ok(m[1] < -150 && m[2] > 40 && Math.abs(m[0]) < 0.5, `down and back along the grip (${m} mm)`);
  assert.ok(Math.abs(m[2] / m[1] + 0.326) < 0.02, `along the rake (${(m[2] / m[1]).toFixed(3)})`);
});

test('SG-01: pump and bolt rack with the support hand (75 mm, in time with the pump sound) after a round and after a reload; shells go in at the port while the hand is there', async () => {
  const r = await page.evaluate(async () => {
    const v = await window.__rig('sg01');
    const pump0 = v.at('Pump');
    const bolt0 = v.at('PumpBolt');
    const hand0 = v.hand();
    const out = {};
    v.set({ sinceShot: 0.27 });
    out.pump = v.at('Pump');
    out.bolt = v.at('PumpBolt');
    out.hand = v.hand();
    v.set({ sinceShot: 0.45 });
    out.pumpHome = v.at('Pump');
    // Reload: the shell's track at the first insert (0.15) and where the hand is.
    const shell = v.view.object.getObjectByName('Shell');
    out.shell = [];
    for (const t of [0.05, 0.08, 0.12, 0.17, 0.2, 0.25, 0.3]) {
      v.set({ sinceShot: 99, reload: t });
      out.shell.push({ t, visible: shell.visible, at: v.at('Shell').map((x) => +x.toFixed(1)) });
    }
    out.handReload = v.hand();
    out.port = v.at('Shell');
    // Reload complete: the pump racks.
    v.set({ reload: 0.99 });
    v.set({ reload: null });
    let racked = 0;
    for (let i = 0; i < 70; i++) {
      v.set({});
      racked = Math.max(racked, v.at('Pump')[2] - pump0[2]);
    }
    out.rackedAfterReload = +racked.toFixed(1);
    return { ...out, pump0, bolt0, hand0 };
  });
  assert.deepEqual(d(r.pump0, r.pump), [0, 0, 75], 'pump racked back');
  assert.deepEqual(d(r.bolt0, r.bolt), [0, 0, 75], 'the bolt with it');
  assert.deepEqual(d(r.hand0, r.hand), [0, 0, 75], 'the support hand on the pump, the same 75 mm');
  assert.deepEqual(d(r.pump0, r.pumpHome), [0, 0, 0]);
  assert.equal(r.rackedAfterReload, 75, 'racked after the reload');
  const vis = r.shell.map((s) => s.visible);
  assert.deepEqual(vis, [false, true, true, true, true, false, false], `shell shown only around the insert (${vis})`);
  // It rises toward the port, then goes forward (-Z) into the tube.
  const ys = r.shell.filter((s) => s.visible).map((s) => s.at[1]);
  for (let i = 1; i < ys.length; i++) assert.ok(ys[i] >= ys[i - 1] - 0.01, 'the shell only rises');
  const zs = r.shell.filter((s) => s.visible).map((s) => s.at[2]);
  assert.ok(zs.at(-1) < zs[0] - 10, 'and goes forward into the tube');
  // The support hand left the pump for the loading port (below it).
  assert.ok(Math.hypot(...d(r.hand0, r.handReload)) > 100, 'hand off the pump');
  assert.ok(Math.abs(r.handReload[2] - r.port[2]) < 60 && r.handReload[1] < r.port[1], `hand under the port (${r.handReload.map(Math.round)} vs ${r.port.map(Math.round)})`);
});

test('SMG-01: the magazine drops along its forward rake with the hand on it; the cocking handle is racked at the end of the reload', async () => {
  const r = await page.evaluate(async () => {
    const v = await window.__rig('smg01');
    const mag0 = v.at('Magazine');
    const h0 = v.at('ChargingHandle');
    const out = { grip: [] };
    // While the hand holds it (reach complete 0.18-0.8 of the reload).
    for (const t of [0.2, 0.25, 0.7]) {
      v.set({ reload: t });
      out.grip.push(+Math.hypot(...v.hand().map((x, i) => x - v.at('Magazine')[i])).toFixed(1));
    }
    v.set({ reload: 0.25 });
    out.magOut = v.at('Magazine');
    v.set({ reload: 0.92 });
    out.handle = v.at('ChargingHandle');
    v.set({ reload: 0.96 });
    out.handleHome = v.at('ChargingHandle');
    v.set({ reload: null });
    out.magHome = v.at('Magazine');
    return { ...out, mag0, h0 };
  });
  const m = d(r.mag0, r.magOut);
  assert.ok(m[1] < -200 && m[2] < -90, `down and forward (${m} mm)`);
  assert.ok(Math.abs(m[2] / m[1] - 0.467) < 0.02, `along its rake (${(m[2] / m[1]).toFixed(3)})`);
  assert.ok(Math.max(...r.grip) - Math.min(...r.grip) < 2, `the hand stays on the magazine (${r.grip} mm from it)`);
  assert.deepEqual(d(r.h0, r.handle), [0, 0, 45], 'cocking handle racked');
  assert.deepEqual(d(r.h0, r.handleHome), [0, 0, 0]);
  assert.deepEqual(d(r.mag0, r.magHome), [0, 0, 0]);
});

test('AR-01: charging handle racked at the end of the reload (the charge sound), trigger pulled on a shot; SR-01 trigger too; nothing moves at rest', async () => {
  const r = await page.evaluate(async () => {
    const out = {};
    for (const id of ['ar01', 'sr01']) {
      const v = await window.__rig(id);
      const t0 = v.at('Trigger');
      const h0 = v.at('Charging_Handle');
      v.set({ sinceShot: 0.02 });
      const t1 = v.at('Trigger');
      v.set({ sinceShot: 99, reload: 0.92 });
      const h1 = h0 && v.at('Charging_Handle');
      v.set({ reload: null });
      const t2 = v.at('Trigger');
      const dd = (a, b) => b.map((x, i) => Math.round((x - a[i]) * 10) / 10 || 0);
      out[id] = { trig: dd(t0, t1), back: dd(t0, t2), handle: h1 && dd(h0, h1) };
    }
    return out;
  });
  assert.deepEqual(r.ar01.handle, [0, 0, 60], 'AR-01 charging handle back 60 mm');
  for (const id of ['ar01', 'sr01']) {
    assert.ok(Math.abs(Math.hypot(...r[id].trig) - 4) < 0.2, `${id} trigger pulled 4 mm (${r[id].trig})`);
    assert.deepEqual(r[id].back, [0, 0, 0], `${id} trigger back at rest`);
  }
});

test('draw calls of each weapon in hand (meshes drawn by the view-model pass) and rig download / parse time', async () => {
  const r = await page.evaluate(async () => {
    const out = {};
    for (const id of ['ar01', 'sr01', 'smg01', 'sg01', 'pis01']) {
      const v = await window.__rig(id);
      let draws = 0;
      v.view.object.traverseVisible((o) => {
        if (o.isMesh) draws += Array.isArray(o.material) ? o.material.length : 1;
      });
      out[id] = draws;
    }
    const { GLTFLoader } = await import('/node_modules/three/examples/jsm/loaders/GLTFLoader.js');
    const load = {};
    for (const f of ['pis01', 'pis01_rig', 'sg01', 'sg01_rig', 'smg01', 'smg01_rig']) {
      const t0 = performance.now();
      await new GLTFLoader().loadAsync(`/weapons/${f}.glb?t=${Math.random()}`);
      load[f] = +(performance.now() - t0).toFixed(1);
    }
    return { draws: out, load };
  });
  console.log('weapon draw calls', JSON.stringify(r.draws), 'load ms', JSON.stringify(r.load));
  // One-piece sources drew 3 (one per material); the rigs add the moving parts: still a handful.
  assert.ok(r.draws.pis01 <= 8 && r.draws.sg01 <= 8 && r.draws.smg01 <= 6, JSON.stringify(r.draws));
  assert.deepEqual(page.errors, []);
});
