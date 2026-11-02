// First-person gun feel (browser, the game's ViewModelLayer with each
// weapon's real GLB): each category reacts to a shot its own way (the pistol
// snaps up more than it pushes back, the shotgun and sniper shove hardest,
// the SMG least), every kick stays small (no view blocked) and settles back;
// a full-auto spray holds a steady push instead of running away; the
// shotgun's support hand racks the pump in time with the pump sound; a
// landing dips the weapon briefly; standing still the weapon only breathes.

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
    const deg = 180 / Math.PI;
    const still = { lookYaw: 0, lookPitch: 0, speed01: 0, grounded: true, crouching: false };
    /** A fresh layer holding weapon `id` (its GLB), ready. */
    window.__vm = async (id) => {
      const def = WEAPONS[id];
      const layer = new VM.ViewModelLayer(16 / 9);
      const view = (await WV.loadWeaponView(def.view)) ?? WV.createWeaponView(def.view);
      layer.setView(view, def.view.pose);
      const anim = { category: def.category, equip: 1, reload: null, sinceShot: 99, fireInterval: 60 / def.fireRate, inspect: null };
      const pose = () => {
        const p = layer.pivot;
        return {
          rise: (p.rotation.x - layer.restRotation.x) * deg,
          roll: (p.rotation.z - layer.restRotation.z) * deg,
          back: (p.position.z - layer.restPosition.z) * 1000,
          y: (p.position.y - layer.restPosition.y) * 1000,
        };
      };
      return { def, layer, view, anim, pose, still };
    };
  });
});
after(async () => {
  await page?.context().close();
  await env?.close();
});

test('one shot per gun: its own reaction, small (under 3° and 2 cm), settled back within half a second', async () => {
  const r = await page.evaluate(async () => {
    const out = {};
    for (const id of ['ar01', 'smg01', 'pis01', 'sg01', 'sr01']) {
      const v = await window.__vm(id);
      // Several shots apart, the largest of each (the twist is random).
      let rise = 0;
      let back = 0;
      let roll = 0;
      let rest = null;
      for (let s = 0; s < 4; s++) {
        v.layer.onShot(v.def.category);
        v.anim.sinceShot = 0;
        for (let i = 0; i < 30; i++) {
          v.layer.update(1 / 60, v.still, v.anim);
          v.anim.sinceShot += 1 / 60;
          const p = v.pose();
          rise = Math.max(rise, p.rise);
          back = Math.max(back, p.back);
          // The shot's twist (the shotgun's pump rock starts at 0.12 s and is checked on its own).
          if (v.anim.sinceShot < 0.12) roll = Math.max(roll, Math.abs(p.roll));
        }
        rest = v.pose();
      }
      out[id] = { rise: +rise.toFixed(2), back: +back.toFixed(1), roll: +roll.toFixed(2), rest };
    }
    return out;
  });
  for (const [id, x] of Object.entries(r)) {
    assert.ok(x.rise > 0.3 && x.rise < 3, `${id}: muzzle rise ${x.rise}°`);
    assert.ok(x.back > 1 && x.back < 20, `${id}: push back ${x.back} mm`);
    assert.ok(x.roll > 0.1 && x.roll < 1.5, `${id}: twist ${x.roll}°`);
    // Settled: within 0.1° / 1 mm of rest (the shotgun's pump rock is over by then too).
    assert.ok(Math.abs(x.rest.rise) < 0.1 && Math.abs(x.rest.roll) < 0.1 && Math.abs(x.rest.back) < 1, `${id}: back at rest ${JSON.stringify(x.rest)}`);
  }
  assert.ok(r.pis01.rise > r.ar01.rise * 1.5 && r.pis01.back < r.ar01.back, `pistol snaps up, little push (${JSON.stringify(r.pis01)} vs ${JSON.stringify(r.ar01)})`);
  assert.ok(r.sg01.back > r.ar01.back * 2 && r.sr01.back > r.ar01.back * 2, 'shotgun and sniper shove hardest');
  assert.ok(r.smg01.rise < r.ar01.rise && r.smg01.back < r.ar01.back, 'the SMG kicks least');
  assert.deepEqual(page.errors, []);
});

test('a full-auto spray (30 rounds) holds a steady push instead of running away', async () => {
  const r = await page.evaluate(async () => {
    const out = {};
    for (const id of ['ar01', 'smg01']) {
      const v = await window.__vm(id);
      const interval = 60 / v.def.fireRate;
      let t = 0;
      let next = 0;
      let shots = 0;
      let max = 0;
      const late = [];
      while (shots < 30) {
        if (t >= next) {
          v.layer.onShot(v.def.category);
          shots++;
          next += interval;
        }
        v.layer.update(1 / 120, v.still, v.anim);
        t += 1 / 120;
        const p = v.pose();
        max = Math.max(max, p.rise);
        if (shots > 20) late.push(p.rise);
      }
      out[id] = { max: +max.toFixed(2), lateMin: +Math.min(...late).toFixed(2), lateMax: +Math.max(...late).toFixed(2) };
    }
    return out;
  });
  for (const [id, x] of Object.entries(r)) {
    assert.ok(x.max < 3, `${id}: never past 3° (${x.max})`);
    assert.ok(x.lateMin > 0.3, `${id}: a steady push while firing (${x.lateMin}..${x.lateMax}°)`);
  }
});

test('SG-01: the support hand racks the pump back and forward in time with the pump sound (back 0.12-0.24 s, forward 0.30-0.40 s)', async () => {
  const r = await page.evaluate(async () => {
    const v = await window.__vm('sg01');
    const hand = v.view.supportAnchor;
    const rest = hand.position.z;
    const at = {};
    v.layer.onShot('shotgun');
    for (const t of [0, 0.1, 0.18, 0.24, 0.27, 0.35, 0.4, 0.6]) {
      v.anim.sinceShot = t;
      v.layer.update(1 / 120, v.still, v.anim);
      at[t] = +((hand.position.z - rest) * 1000).toFixed(1);
    }
    return { at };
  });
  assert.equal(r.at[0], 0);
  assert.equal(r.at[0.1], 0, 'not before the sound starts');
  assert.ok(r.at[0.18] > 10 && r.at[0.18] < 75, `on its way back at 0.18 s (${r.at[0.18]} mm)`);
  assert.equal(r.at[0.24], 75, 'racked back at the click');
  assert.equal(r.at[0.27], 75);
  assert.ok(r.at[0.35] > 0 && r.at[0.35] < 75, `going forward at 0.35 s (${r.at[0.35]} mm)`);
  assert.equal(r.at[0.4], 0, 'forward at the second click');
  assert.equal(r.at[0.6], 0);
});

test('landing dips the weapon briefly; standing still it only breathes (under 2 mm / 0.2°)', async () => {
  const r = await page.evaluate(async () => {
    const v = await window.__vm('ar01');
    const air = { ...v.still, grounded: false };
    for (let i = 0; i < 30; i++) v.layer.update(1 / 60, air, v.anim);
    let dip = 0;
    for (let i = 0; i < 60; i++) {
      v.layer.update(1 / 60, v.still, v.anim);
      dip = Math.min(dip, v.pose().y);
    }
    const settled = v.pose().y;
    let breathe = 0;
    let tilt = 0;
    for (let i = 0; i < 600; i++) {
      v.layer.update(1 / 60, v.still, v.anim);
      breathe = Math.max(breathe, Math.abs(v.pose().y));
      tilt = Math.max(tilt, Math.abs(v.pose().rise));
    }
    return { dip: +dip.toFixed(1), settled: +settled.toFixed(2), breathe: +breathe.toFixed(2), tilt: +tilt.toFixed(3) };
  });
  assert.ok(r.dip < -3 && r.dip > -20, `dips on landing (${r.dip} mm)`);
  assert.ok(Math.abs(r.settled) < 2, `back up within a second (${r.settled} mm)`);
  assert.ok(r.breathe > 0.3 && r.breathe < 2, `breathing ${r.breathe} mm`);
  assert.ok(r.tilt < 0.2, `breathing tilt ${r.tilt}°`);
});
