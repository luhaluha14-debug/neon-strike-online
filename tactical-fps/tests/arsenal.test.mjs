// Phase 24 arsenal: AR-02 (HK416-type), SMG-02 (UMP45-type), DMR-01 (M110-type), PIS-02 (P220-family),
// LMG-01 (M249-type), LMG-02 (MG3-type, Phase 25: an MG42-family file, root K_MG42), each from its own
// Blender GLB, in the real game. What is checked:
//   1. every file loads as itself (its own root node and parts, no stand-in), parts gathered by name;
//      muzzle, grip, support hand and ejection port where the file's own geometry is
//   2. switching between them: one model in hand at a time, each file downloaded once
//   3. aim and fire with real mouse / keyboard input: the round leaves from the eye along the crosshair,
//      whatever the view model does; rate of fire and fire mode as defined
//   4. reload: time, refill, cues in order; the parts that move on a reload (magazine along its own
//      rake, charging handle, slide lock, the LMG's feed cover)
//   5. magazine / reserve on the HUD
//   6. a case per round from the ejection port
//   7. muzzle flash at the muzzle drawn on screen
//   8. each weapon's own sounds
//   9-10 (buy menu, online): arsenal-online.test.mjs; 12 (touch): arsenal-mobile.test.mjs
// Gloves vs weapon: the clipping check (window.vmCheck) with budgets measured when the weapons were
// fitted (rounded up by at most 0.5 mm / ~10 %), as viewmodel.test.mjs does for the first weapons.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { startEnv, openGame, installFrameDriver, ROOT } from './harness.mjs';

const NEW = ['ar02', 'smg02', 'dmr01', 'lmg01', 'lmg02', 'pis02'];
/** File root node and a few parts each file must bring (its own model, not a stand-in). */
const FILES = {
  ar02: { url: '/weapons/ar02.glb', root: 'R_HK416', parts: ['R_UpperReceiver', 'R_Handguard', 'R_Magazine', 'R_Stock', 'R_TopRail'] },
  smg02: { url: '/weapons/smg02.glb', root: 'U_UMP45', parts: ['U_Receiver', 'U_Stock', 'U_Magazine', 'U_PistolGrip'] },
  dmr01: { url: '/weapons/dmr01_rig.glb', root: 'M_M110', parts: ['M_UpperReceiver', 'M_ScopeTube', 'M_Handguard', 'M_Magazine', 'M_BipodLegs'] },
  pis02: { url: '/weapons/pis02_rig.glb', root: 'P_P220', parts: ['P_Frame', 'P_GripPanels', 'P_MagBase', 'P_MagBody'] },
  lmg01: { url: '/weapons/lmg01_rig.glb', root: 'G_M249', parts: ['G_Receiver', 'G_FeedCover', 'G_AmmoPouch', 'G_Belt', 'G_BipodLegs'] },
  lmg02: { url: '/weapons/lmg02.glb', root: 'K_MG42', parts: ['K_Receiver', 'K_BarrelJacket', 'K_FeedCover', 'K_BeltCases', 'K_BipodLegs'] },
};

let env;
let page;
const run = (n) => page.evaluate((n) => window.T.run(n), n);

before(async () => {
  env = await startEnv();
  page = await openGame(env, { map: 'warehouse', quality: 'medium', width: 1280, height: 720 });
  page.warnings = [];
  page.on('console', (m) => m.type() === 'warning' && page.warnings.push(m.text()));
  await page.click('.play-button');
  await page.waitForFunction(() => document.pointerLockElement !== null && window.game.input.active && window.game.audio.state === 'running', null, { timeout: 30000 });
  await page.evaluate(() => window.game.audio.ready);
  await installFrameDriver(page);
  await page.evaluate(async (ids) => {
    const g = window.game;
    const T = window.T;
    T.stopLoop();
    // Weapon handling, not hits: the training dummies out of the hitscan.
    for (const t of g.trainingRange.targets) g.hitscan.unregister(t);
    const { WEAPONS } = await import('/src/weapons/weapons.ts');
    T.WEAPONS = WEAPONS;
    // A team match loadout as the buy menu gives it: primary (1), PIS-02 (2), knife (3).
    T.loadout = (primary) => g.weapons.setLoadout([WEAPONS[primary], WEAPONS.pis02, WEAPONS.karambit]);
    T.loadout('ar02');
    T.log = [];
    T.shots = [];
    const play = g.audio.play.bind(g.audio);
    g.audio.play = (id, o = {}) => {
      const ok = play(id, o);
      T.log.push({ id, ok, t: T.frame ?? 0 });
      return ok;
    };
    const ev = g.weapons.events;
    const shot = ev.onShot;
    // Where each round leaves from and goes: the eye (the camera before its bob / breath, a mm or two) and the
    // player's aim at that moment, against the muzzle drawn on screen.
    ev.onShot = (r, origin, dir, weapon, pellet) => {
      g.camera.updateMatrixWorld();
      const cam = g.camera.getWorldPosition(origin.clone());
      const p = g.player;
      const aim = dir.clone().set(-Math.sin(p.yaw) * Math.cos(p.pitch), Math.sin(p.pitch), -Math.cos(p.yaw) * Math.cos(p.pitch));
      const muzzle = g.viewModel.muzzleInWorld(g.camera, origin.clone());
      T.shots.push({ id: weapon.def.id, from: origin.distanceTo(cam), muzzle: muzzle ? origin.distanceTo(muzzle) : null, angle: dir.angleTo(aim) });
      shot(r, origin, dir, weapon, pellet);
    };
  }, NEW);
  await run(90);
});
after(async () => {
  await page?.context().close();
  await env?.close();
});

/** Draws slot `i` (0 primary, 1 pistol, 2 knife) with its number key and waits until it is ready. */
async function key(i) {
  await page.keyboard.press(String(i + 1));
  await page.evaluate((i) => {
    const g = window.game;
    for (let k = 0; k < 300 && !(g.weapons.slot === i && g.weapons.weapon.status === 'ready' && g.viewModel.inHand && !g.viewModel['incoming']); k++) window.T.run(1);
  }, i);
  await run(5);
}
/** `id` in hand: as the primary of a team loadout (key 1), or PIS-02 as its secondary (key 2). */
async function use(id) {
  await page.evaluate((id) => window.T.loadout(id === 'pis02' ? 'ar02' : id), id);
  await run(2);
  await key(id === 'pis02' ? 1 : 0);
}
const take = () =>
  page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    const w = g.weapons.weapon;
    const sounds = {};
    for (const e of T.log) if (e.ok) sounds[e.id] = (sounds[e.id] ?? 0) + 1;
    const out = { weapon: w.def.id, mag: w.magazine, reserve: w.reserve, sounds, order: T.log.filter((e) => e.ok).map((e) => e.id), shots: T.shots.slice(), hud: [document.querySelector('.ammo-mag').textContent, document.querySelector('.ammo-reserve').textContent] };
    T.log = [];
    T.shots = [];
    return out;
  });

test('1. each new weapon loads its own Blender file (root node, parts), no stand-in; parts gathered by name; files and triangles', async () => {
  const r = await page.evaluate(async (files) => {
    const { WEAPONS } = await import('/src/weapons/weapons.ts');
    const { loadGltfWeaponView } = await import('/src/weapons/view/GltfWeaponView.ts');
    const out = {};
    for (const [id, f] of Object.entries(files)) {
      const def = WEAPONS[id];
      const v = await loadGltfWeaponView(def.view.url, def.view.fit);
      const names = new Set();
      let tris = 0;
      let meshes = 0;
      v.object.traverse((o) => {
        names.add(o.name);
        if (o.isMesh) {
          meshes++;
          tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;
        }
      });
      const groups = (def.view.fit.groups ?? []).map((g) => [g.name, v.object.getObjectByName(g.name)?.children.length ?? -1]);
      out[id] = { url: def.view.url, root: names.has(f.root), parts: f.parts.filter((p) => !names.has(p)), magazine: v.magazine?.children.length ?? 0, groups, meshes, tris, fallback: def.view.fallback };
      v.dispose();
    }
    return out;
  }, FILES);
  for (const [id, f] of Object.entries(FILES)) {
    const x = r[id];
    assert.equal(x.url, f.url, `${id}: its own file`);
    assert.ok(x.root, `${id}: the file's root node ${f.root}`);
    assert.deepEqual(x.parts, [], `${id}: the file's parts are there`);
    assert.ok(x.magazine >= 2, `${id}: magazine gathered from the file's nodes (${x.magazine})`);
    for (const [name, n] of x.groups) assert.ok(n >= 1, `${id}: ${name} gathered (${n} nodes)`);
    assert.ok(x.meshes >= 20, `${id}: the full model (${x.meshes} meshes)`);
    // Phase 24's five under 8,000; LMG-02's file models its belt round by round: no more than AR-01 (12,200).
    assert.ok(x.tris < (id === 'lmg02' ? 12200 : 8000), `${id}: low poly for first person (${x.tris} triangles)`);
    const bytes = statSync(join(ROOT, 'public', f.url)).size;
    // LMG-02's belt is modelled round by round: no larger than AR-01's file (299,632 B).
    assert.ok(bytes < (id === 'lmg02' ? 300_000 : 260_000), `${id}: ${bytes} bytes`);
    console.log(`[arsenal] ${id}: ${f.url} ${bytes} B, ${x.meshes} meshes, ${x.tris} triangles`);
  }
  assert.deepEqual(page.warnings.filter((w) => w.includes('[weapon]')), [], 'no part missing from a file');
});

test('1. anchors on the file\'s own geometry: muzzle at the barrel\'s end, grip and support hand on the grip / handguard, port on the port, bipod folded, added pieces inside', async () => {
  const r = await page.evaluate(async () => {
    const { WEAPONS } = await import('/src/weapons/weapons.ts');
    const { loadGltfWeaponView } = await import('/src/weapons/view/GltfWeaponView.ts');
    const out = {};
    for (const id of ['ar02', 'smg02', 'dmr01', 'lmg01', 'lmg02', 'pis02']) {
      const def = WEAPONS[id];
      const v = await loadGltfWeaponView(def.view.url, def.view.fit);
      v.object.updateMatrixWorld(true);
      const V = window.game.camera.position.constructor;
      // Bounding boxes in model space (the view's object is the model root, unposed).
      const bb = (name) => {
        const o = v.object.getObjectByName(name);
        let min = [Infinity, Infinity, Infinity];
        let max = [-Infinity, -Infinity, -Infinity];
        const p = new V();
        (o ?? v.object).traverse((m) => {
          if (!m.isMesh) return;
          const a = m.geometry.attributes.position;
          for (let i = 0; i < a.count; i++) {
            p.fromBufferAttribute(a, i).applyMatrix4(m.matrixWorld);
            min = min.map((x, k) => Math.min(x, p.getComponent(k)));
            max = max.map((x, k) => Math.max(x, p.getComponent(k)));
          }
        });
        return { min, max };
      };
      const all = bb(null);
      const pos = (o) => (o ? v.object.worldToLocal(o.getWorldPosition(new V())).toArray() : null);
      out[id] = { all, muzzle: pos(v.muzzle), grip: pos(v.gripAnchor), support: pos(v.supportAnchor), port: pos(v.ejectPort), boxes: {} };
      const names = {
        ar02: ['R_PistolGrip', 'R_Handguard', 'R_EjectionPortCover'],
        smg02: ['U_PistolGrip', 'U_BottomRail', 'U_EjectionPort'],
        dmr01: ['M_PistolGrip', 'M_Handguard', 'M_EjectionPort', 'Bipod', 'M_SideRails'],
        lmg01: ['G_PistolGrip', 'G_HandguardLower', 'G_Receiver', 'Bipod', 'G_FeedCover'],
        lmg02: ['K_PistolGrip', 'K_BarrelJacket', 'K_Receiver', 'Bipod'],
        pis02: ['P_GripPanels', 'P_Slide', 'P_MagBody', 'P_Frame'],
      }[id];
      for (const n of names) out[id].boxes[n] = bb(n);
      v.dispose();
    }
    return out;
  });
  const within = (p, b, tol) => p.every((x, k) => x >= b.min[k] - tol && x <= b.max[k] + tol);
  for (const [id, x] of Object.entries(r)) {
    // Muzzle: the forward-most point of the model (-Z), on the centre line.
    assert.ok(Math.abs(x.muzzle[2] - x.all.min[2]) < 0.006, `${id}: muzzle at the barrel's end (${x.muzzle[2].toFixed(3)} vs ${x.all.min[2].toFixed(3)})`);
    assert.ok(Math.abs(x.muzzle[0]) < 0.004, `${id}: muzzle on the centre line`);
    assert.ok(x.port[0] >= -0.001, `${id}: cases leave on the right (or straight down) — port x ${x.port[0].toFixed(3)}`);
  }
  const b = (id, n) => r[id].boxes[n];
  // Firing hand on the pistol grip (within 1.5 cm of its geometry), support hand at the handguard.
  for (const [id, grip] of [['ar02', 'R_PistolGrip'], ['smg02', 'U_PistolGrip'], ['dmr01', 'M_PistolGrip'], ['lmg01', 'G_PistolGrip'], ['lmg02', 'K_PistolGrip'], ['pis02', 'P_GripPanels']])
    assert.ok(within(r[id].grip, b(id, grip), 0.015), `${id}: right hand on the grip ${JSON.stringify(r[id].grip.map((v) => +v.toFixed(3)))}`);
  for (const [id, fore] of [['ar02', 'R_Handguard'], ['smg02', 'U_BottomRail'], ['dmr01', 'M_Handguard'], ['lmg01', 'G_HandguardLower'], ['lmg02', 'K_BarrelJacket']])
    assert.ok(within(r[id].support, b(id, fore), 0.03), `${id}: support hand at the handguard ${JSON.stringify(r[id].support.map((v) => +v.toFixed(3)))}`);
  assert.equal(r.pis02.support, null, 'PIS-02: one-handed');
  // Ports on the files' own port geometry (2 cm), the LMG's under the receiver, the pistol's on the slide.
  for (const [id, port] of [['ar02', 'R_EjectionPortCover'], ['smg02', 'U_EjectionPort'], ['dmr01', 'M_EjectionPort']]) assert.ok(within(r[id].port, b(id, port), 0.02), `${id}: ejection port`);
  assert.ok(r.lmg01.port[1] <= b('lmg01', 'G_Receiver').min[1] + 0.005, 'LMG-01: cases drop under the receiver');
  assert.ok(r.lmg02.port[1] <= b('lmg02', 'K_Receiver').min[1] + 0.005, 'LMG-02: cases drop under the receiver');
  // The MG3-type's bipod folded back under the jacket (the file stands it deployed down to y -0.32, feet ±134 mm).
  const mgb = b('lmg02', 'Bipod');
  assert.ok(mgb.min[1] > -0.1, `LMG-02: bipod folded (lowest y ${mgb.min[1].toFixed(3)})`);
  assert.ok(mgb.max[0] < 0.05 && mgb.min[0] > -0.05, `LMG-02: legs closed (${mgb.min[0].toFixed(3)}..${mgb.max[0].toFixed(3)})`);
  assert.ok(mgb.max[2] < r.lmg02.support[2], 'LMG-02: folded legs ahead of the support hand');
  assert.ok(within(r.pis02.port, b('pis02', 'P_Slide'), 0.006), 'PIS-02: port on the slide');
  // The M249's bipod folded under the barrel (the file stands it deployed, legs down to y -0.317).
  assert.ok(b('lmg01', 'Bipod').min[1] > -0.1, `LMG-01: bipod folded (lowest y ${b('lmg01', 'Bipod').min[1].toFixed(3)})`);
  assert.ok(b('lmg01', 'Bipod').min[2] < r.lmg01.support[2], 'LMG-01: folded forward, ahead of the support hand');
  // The M110's folded legs closed under the handguard: no wider than its rails (the file splays them ±64 mm).
  const legs = b('dmr01', 'Bipod');
  const rails = b('dmr01', 'M_SideRails');
  assert.ok(legs.min[0] >= rails.min[0] && legs.max[0] <= rails.max[0], `DMR-01: bipod legs within the rails (${legs.min[0].toFixed(3)}..${legs.max[0].toFixed(3)} vs ±${rails.max[0].toFixed(3)})`);
  assert.ok(legs.max[2] < r.dmr01.support[2], 'DMR-01: legs ahead of the support hand');
  // Added pieces: the P220 magazine body inside the grip (x/z within the panels), not showing outside.
  const mb = b('pis02', 'P_MagBody');
  const gp = b('pis02', 'P_GripPanels');
  assert.ok(mb.min[0] >= gp.min[0] && mb.max[0] <= gp.max[0], 'PIS-02: magazine body inside the grip width');
  assert.deepEqual(page.errors, []);
});

test('1. gloves vs weapon (clipping check): idle, just fired, mid reload, magazine going in — within the budgets', async () => {
  // name, slot, state, max mm, max vertices inside (measured when fitted; AR-01's own: 5 / 21 idle, 12 / 113 at 82 %).
  const cases = [
    ['AR-02 idle', 'ar02', {}, 0.5, 2],
    ['AR-02 fired', 'ar02', { sinceShot: 0.03 }, 0.5, 2],
    ['AR-02 reload 40 %', 'ar02', { reload: 0.4 }, 4.4, 29],
    ['AR-02 reload 88 %', 'ar02', { reload: 0.88 }, 11.4, 137],
    ['SMG-02 idle', 'smg02', {}, 5.0, 24],
    ['SMG-02 reload 40 %', 'smg02', { reload: 0.4 }, 5.0, 20],
    ['SMG-02 reload 88 %', 'smg02', { reload: 0.88 }, 12.5, 116],
    ['DMR-01 idle', 'dmr01', {}, 4.4, 42],
    ['DMR-01 reload 40 %', 'dmr01', { reload: 0.4 }, 6.0, 46],
    ['DMR-01 reload 88 %', 'dmr01', { reload: 0.88 }, 13.8, 68],
    ['LMG-01 idle', 'lmg01', {}, 6.5, 22],
    ['LMG-01 reload 40 %', 'lmg01', { reload: 0.4 }, 5.3, 10],
    ['LMG-01 reload 88 %', 'lmg01', { reload: 0.88 }, 14.9, 314],
    ['LMG-02 idle', 'lmg02', {}, 3.4, 5],
    ['LMG-02 reload 40 %', 'lmg02', { reload: 0.4 }, 5.3, 65],
    ['LMG-02 reload 88 %', 'lmg02', { reload: 0.88 }, 7.0, 88],
    ['PIS-02 idle', 'pis02', {}, 2.1, 2],
    ['PIS-02 fired', 'pis02', { sinceShot: 0.03 }, 2.5, 4],
  ];
  const fails = [];
  for (const [name, id, s, mm, verts] of cases) {
    await use(id);
    const c = await page.evaluate(
      ([id, s]) => {
        const g = window.game;
        const vm = g.viewModel;
        const w = g.weapons.weapon;
        w.status = 'ready';
        w.equipRemaining = 0;
        const anim = { category: w.def.category, equip: 1, reload: s.reload ?? null, sinceShot: s.sinceShot ?? Infinity, fireInterval: w.fireInterval, inspect: null };
        for (let k = 0; k < 40; k++) vm.update(1 / 60, { lookYaw: 0, lookPitch: 0, speed01: 0, grounded: true, crouching: false }, anim);
        const r = window.vmCheck();
        return { id: w.def.id, mm: r.maxPenetrationMm, inside: r.handVerticesInside, near: r.verticesTooCloseToCamera };
      },
      [id, s],
    );
    console.log(`[arsenal gloves] ${name}: ${c.mm.toFixed(1)} mm, ${c.inside} vertices`);
    if (c.mm > mm || c.inside > verts || c.near > 0) fails.push(`${name}: ${c.mm.toFixed(1)} mm (≤ ${mm}), ${c.inside} vertices (≤ ${verts}), ${c.near} too close to the eye`);
  }
  assert.deepEqual(fails, []);
  await page.evaluate(() => window.T.run(30));
});

test('2. switching with the number keys (1 primary, 2 PIS-02, 3 knife) and between primaries: one model in hand, each file downloaded once, no new geometry', async () => {
  const primaries = ['ar02', 'smg02', 'dmr01', 'lmg01'];
  for (let lap = 0; lap < 2; lap++)
    for (const id of primaries) {
      await use(id);
      for (const k of [1, 2, 0, 1, 0]) await key(k);
    }
  await key(1);
  const r = await page.evaluate(() => {
    const g = window.game;
    const vm = g.viewModel;
    const held = vm.scene.children.filter((c) => c.type === 'Group' && c.children.length).length;
    const urls = performance.getEntriesByType('resource').map((e) => new URL(e.name).pathname).filter((p) => /^\/weapons\/(ar02|smg02|dmr01|pis02|lmg01)/.test(p));
    const counts = {};
    for (const u of urls) counts[u] = (counts[u] ?? 0) + 1;
    return { weapon: g.weapons.weapon.def.id, counts, weaponObjects: vm.inHand ? 1 : 0, held };
  });
  assert.equal(r.weapon, 'pis02');
  for (const [u, n] of Object.entries(r.counts)) assert.equal(n, 1, `${u} downloaded once`);
  assert.equal(Object.keys(r.counts).length, 5, `all five files: ${Object.keys(r.counts)}`);
  // A weapon switch adds no GPU geometry beyond the models' first use.
  const geo = async () => page.evaluate(() => window.game.renderer.info.memory.geometries);
  const g0 = await geo();
  for (const id of primaries) {
    await use(id);
    await key(1);
  }
  await page.evaluate(() => window.game.frame((window.T.t = (window.T.t ?? performance.now()) + 16)));
  const g1 = await geo();
  assert.ok(g1 - g0 <= 0, `geometries ${g0} → ${g1} after another lap`);
});

test('3. aim and fire (real mouse): every round leaves from the eye along the crosshair; rate and fire mode as defined; HUD counts down', async () => {
  const out = {};
  for (const id of NEW) {
    await use(id);
    await take();
    const def = await page.evaluate(() => {
      const d = window.game.weapons.weapon.def;
      return { id: d.id, mode: d.fireMode, rate: d.fireRate, mag: d.magazineSize, standing: d.spread.standing };
    });
    // Mid-fire the view model kicks and moves; the round must not care.
    if (def.mode === 'auto') {
      await page.mouse.down();
      await run(60);
      await page.mouse.up();
      await run(3);
    } else {
      for (let k = 0; k < 4; k++) {
        await page.mouse.down();
        await run(2);
        await page.mouse.up();
        await run(30);
      }
    }
    const t = await take();
    const rounds = t.shots.length;
    const expected = def.mode === 'auto' ? Math.floor((60 / 60) * (def.rate / 60)) : 4;
    out[def.id] = { rounds, expected };
    assert.ok(Math.abs(rounds - expected) <= 1, `${def.id}: ${rounds} rounds (expected ${expected})`);
    assert.ok(t.shots.every((s) => s.from < 0.01), `${def.id}: from the eye (max ${Math.max(...t.shots.map((s) => s.from)).toFixed(4)} m off)`);
    assert.ok(t.shots.every((s) => s.muzzle > 0.3), `${def.id}: not from the muzzle drawn on screen (min ${Math.min(...t.shots.map((s) => s.muzzle)).toFixed(2)} m)`);
    // Standing still: on the crosshair (LMG-01: its 0.35° cone).
    const cone = def.standing + 1e-4;
    assert.ok(t.shots.every((s) => s.angle <= cone), `${def.id}: along the crosshair (max ${Math.max(...t.shots.map((s) => s.angle)).toFixed(5)} rad, cone ${cone.toFixed(5)})`);
    assert.equal(t.mag, def.mag - rounds, `${def.id}: magazine`);
    assert.deepEqual(t.hud, [String(t.mag), String(t.reserve)], `${def.id}: HUD shows ${t.mag} / ${t.reserve}`);
    await run(40);
  }
  console.log(`[arsenal fire] ${JSON.stringify(out)}`);
});

test('3. the view model is presentation only: a shot fired with the model shoved out of place goes exactly where one fired normally does', async () => {
  await use('ar02');
  const dirs = await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    const vm = g.viewModel;
    const shoot = () => {
      T.shots = [];
      let d = null;
      const ev = g.weapons.events;
      const prev = ev.onShot;
      ev.onShot = (r, o, dir, w, p) => ((d = dir.toArray()), prev(r, o, dir, w, p));
      g.input.mouseButtons = 1;
      T.run(1);
      g.input.mouseButtons = 0;
      T.run(40);
      ev.onShot = prev;
      return d;
    };
    const a = shoot();
    const rest = vm.restPosition.clone();
    vm.restPosition.set(rest.x + 0.2, rest.y - 0.15, rest.z + 0.1);
    vm.restRotation.x += 0.4;
    const b = shoot();
    vm.restPosition.copy(rest);
    vm.restRotation.x -= 0.4;
    return { a, b };
  });
  assert.ok(dirs.a && dirs.b);
  dirs.a.forEach((v, k) => assert.ok(Math.abs(v - dirs.b[k]) < 1e-4, `the same direction (${dirs.a} vs ${dirs.b})`));
});

test('4, 8. reload with R: time, refill from the reserve, the cues in order (LMG-01: cover, box out, box in, belt, cover, charge)', async () => {
  const expectOrder = {
    ar02: ['mag.out', 'mag.in', 'ar01.charge'],
    smg02: ['mag.out', 'mag.in', 'smg02.charge'],
    dmr01: ['mag.out', 'mag.in', 'ar01.charge'],
    lmg01: ['lmg.cover', 'mag.out', 'mag.in', 'lmg.belt', 'lmg.cover', 'ar01.charge'],
    lmg02: ['lmg.cover', 'mag.out', 'mag.in', 'lmg.belt', 'lmg.cover', 'ar01.charge'],
    pis02: ['mag.out', 'mag.in', 'sr01.chamber'],
  };
  for (const id of NEW) {
    await use(id);
    const before = await page.evaluate(() => {
      const w = window.game.weapons.weapon;
      // Two rounds spent so the reload refills.
      w.magazine = Math.min(w.magazine, w.def.magazineSize - 2);
      return { id: w.def.id, reserve: w.reserve, have: w.magazine, mag: w.def.magazineSize, time: w.def.reloadTime };
    });
    await take();
    await page.keyboard.press('r');
    const frames = await page.evaluate(() => {
      const g = window.game;
      let n = 0;
      // The key is read on the next frame; then count the reload's frames.
      for (let k = 0; k < 5 && g.weapons.weapon.status !== 'reloading'; k++) window.T.run(1);
      while (g.weapons.weapon.status === 'reloading' && n < 1000) {
        window.T.run(1);
        n++;
      }
      return n;
    });
    const t = await take();
    assert.ok(Math.abs(frames / 60 - before.time) < 0.05, `${before.id}: reload ${(frames / 60).toFixed(2)} s (defined ${before.time} s)`);
    assert.equal(t.mag, before.mag, `${before.id}: full`);
    assert.equal(t.reserve, before.reserve - (before.mag - before.have), `${before.id}: from the reserve`);
    assert.deepEqual(t.order.filter((s) => s !== 'equip.gun'), expectOrder[before.id], `${before.id}: reload cues`);
    assert.deepEqual(t.hud, [String(t.mag), String(t.reserve)], `${before.id}: HUD after the reload`);
  }
});

test('4. moving parts: magazine along its own rake, charging handle racked, pistol slide (cycle, lock, release), LMG feed cover up on its hinge and down', async () => {
  const r = {};
  for (const id of NEW) {
    await use(id);
    Object.assign(r, await page.evaluate(() => {
    const g = window.game;
    const vm = g.viewModel;
    const out = {};
    const V = g.camera.position.constructor;
    {
      const w = g.weapons.weapon;
      w.status = 'ready';
      w.equipRemaining = 0;
      const v = vm.inHand;
      const at = (reload, sinceShot = Infinity, empty = false) => {
        const anim = { category: w.def.category, equip: 1, reload, sinceShot, fireInterval: w.fireInterval, inspect: null, empty };
        for (let k = 0; k < 3; k++) vm.update(1 / 60, { lookYaw: 0, lookPitch: 0, speed01: 0, grounded: true, crouching: false }, anim);
      };
      const local = (name) => {
        const o = v.object.getObjectByName(name);
        return o ? v.object.worldToLocal(o.getWorldPosition(new V())) : null;
      };
      at(null);
      const mag0 = local('Magazine');
      const handle0 = local('ChargingHandle');
      const slide0 = local('Slide');
      const cover = v.object.getObjectByName('FeedCover');
      const cover0 = cover?.rotation.x ?? null;
      at(0.2);
      const mag1 = local('Magazine');
      const cover1 = cover?.rotation.x ?? null;
      at(0.92);
      const handle1 = local('ChargingHandle');
      at(0.97);
      const cover2 = cover?.rotation.x ?? null;
      at(null, 0.025);
      const slide1 = local('Slide');
      at(null, 0.2);
      const slide2 = local('Slide');
      at(0.5, Infinity, true);
      const slide3 = local('Slide');
      const drop = mag1.clone().sub(mag0);
      const rake = w.def.view.fit.magazineDrop;
      out[w.def.id] = {
        drop: +drop.length().toFixed(3),
        rakeDot: rake ? +drop.clone().normalize().dot(new V(...rake).normalize()).toFixed(3) : +drop.clone().normalize().dot(new V(0, -1, 0)).toFixed(3),
        handle: handle0 ? +(handle1.z - handle0.z).toFixed(3) : null,
        slide: slide0 ? [+(slide1.z - slide0.z).toFixed(4), +(slide2.z - slide0.z).toFixed(4), +(slide3.z - slide0.z).toFixed(4)] : null,
        cover: cover ? [cover0, +(cover1 - cover0).toFixed(3), +(cover2 - cover0).toFixed(3)] : null,
      };
    }
    return out;
  }));
  }
  for (const [id, x] of Object.entries(r)) {
    assert.ok(x.drop > 0.1, `${id}: magazine out on a reload (${x.drop} m)`);
    assert.ok(x.rakeDot > 0.99, `${id}: along its own rake (${x.rakeDot})`);
  }
  for (const id of ['ar02', 'dmr01', 'lmg01', 'lmg02']) assert.ok(Math.abs(r[id].handle - 0.06) < 0.004, `${id}: charging handle racked 6 cm (${r[id].handle})`);
  assert.ok(Math.abs(r.smg02.handle - 0.045) < 0.004, `SMG-02: cocking knob racked 4.5 cm (${r.smg02.handle})`);
  assert.ok(Math.abs(r.pis02.slide[0] - 0.028) < 0.003 && Math.abs(r.pis02.slide[1]) < 1e-4, `PIS-02: slide back 28 mm on a shot and home (${r.pis02.slide})`);
  assert.ok(Math.abs(r.pis02.slide[2] - 0.028) < 0.003, `PIS-02: locked back while empty (${r.pis02.slide[2]})`);
  assert.ok(r.lmg01.cover[1] < -1.1, `LMG-01: feed cover up ~70° mid reload (${r.lmg01.cover[1]} rad)`);
  assert.ok(Math.abs(r.lmg01.cover[2]) < 1e-6, 'LMG-01: shut again at the end');
  assert.ok(r.lmg02.cover[1] < -1.1 && Math.abs(r.lmg02.cover[2]) < 1e-6, `LMG-02: feed cover up and shut again (${r.lmg02.cover})`);
  assert.equal(r.ar02.cover, null);
  await page.evaluate(() => window.T.run(30));
});

test('6, 7. a case per round from the port on screen; the muzzle flash at the muzzle in front of the eye, low right', async () => {
  const r = {};
  for (const id of NEW) {
    await use(id);
    r[id] = await page.evaluate(() => {
      const g = window.game;
      const T = window.T;
      const V = g.camera.position.constructor;
      const port = new V();
      const side = g.viewModel.ejectInWorld(g.camera, port);
      const portView = port.clone().project(g.camera);
      const muzzle = g.viewModel.muzzleInWorld(g.camera, new V());
      const m = muzzle.clone().project(g.camera);
      // Each case as it leaves: where from, against the port on screen at that moment.
      const starts = [];
      const eject = g.casings.eject.bind(g.casings);
      g.casings.eject = (kind, at, vel, rand) => {
        const now = new V();
        g.viewModel.ejectInWorld(g.camera, now);
        starts.push(+at.distanceTo(now).toFixed(4));
        return eject(kind, at, vel, rand);
      };
      g.input.mouseButtons = 1;
      T.run(2);
      g.input.mouseButtons = 0;
      T.run(10);
      g.casings.eject = eject;
      T.run(30);
      return { id: g.weapons.weapon.def.id, side, port: [+portView.x.toFixed(2), +portView.y.toFixed(2)], muzzle: [+m.x.toFixed(2), +m.y.toFixed(2), +m.z.toFixed(3)], cases: starts.length, caseFromPort: starts.length ? Math.max(...starts) : null };
    });
  }
  for (const x of Object.values(r)) {
    assert.ok(x.cases >= 1, `${x.id}: a case for the round (${x.cases})`);
    assert.ok(x.caseFromPort !== null && x.caseFromPort < 0.001, `${x.id}: the case starts at the port (${x.caseFromPort} m)`);
    assert.ok(Math.abs(x.port[0]) < 1 && Math.abs(x.port[1]) < 1, `${x.id}: port on screen ${x.port}`);
    // Muzzle: in front (NDC z < 1), right of centre and below the crosshair, on screen.
    assert.ok(x.muzzle[2] < 1 && x.muzzle[0] > 0 && x.muzzle[0] < 1 && x.muzzle[1] < 0.05 && x.muzzle[1] > -1, `${x.id}: muzzle on screen low right ${x.muzzle}`);
  }
  assert.equal(r.lmg01.side, 1);
  assert.equal(r.lmg02.side, 1);
});

test('8. each new weapon has its own gunshot (rendered, distinct from the others), the LMG its cover and belt, the UMP its slap', async () => {
  const r = await page.evaluate(async () => {
    const { renderSound } = await import('/src/audio/weaponSounds.ts');
    const ids = ['ar01.shot', 'ar02.shot', 'smg01.shot', 'smg02.shot', 'sr01.shot', 'dmr01.shot', 'pis01.shot', 'pis02.shot', 'lmg01.shot', 'lmg02.shot', 'lmg.cover', 'lmg.belt', 'smg02.charge'];
    const out = {};
    for (const id of ids) {
      const s = renderSound(id, 0, { srFireInterval: 1.4 });
      let peak = 0;
      let energy = 0;
      for (const v of s) {
        peak = Math.max(peak, Math.abs(v));
        energy += v * v;
      }
      out[id] = { len: +(s.length / 48000).toFixed(2), peak: +peak.toFixed(2), rms: +Math.sqrt(energy / s.length).toFixed(4), finite: s.every(Number.isFinite), head: Array.from(s.subarray(0, 4800)) };
    }
    // How different two sounds are: RMS of their difference over the first 0.1 s, against their own level.
    const diff = (a, b) => {
      let d = 0;
      let e = 0;
      for (let i = 0; i < 4800; i++) {
        d += (out[a].head[i] - out[b].head[i]) ** 2;
        e += out[a].head[i] ** 2;
      }
      return +Math.sqrt(d / e).toFixed(2);
    };
    const pairs = [['ar01.shot', 'ar02.shot'], ['smg01.shot', 'smg02.shot'], ['sr01.shot', 'dmr01.shot'], ['pis01.shot', 'pis02.shot'], ['ar01.shot', 'lmg01.shot'], ['lmg01.shot', 'lmg02.shot']].map(([a, b]) => [a, b, diff(a, b)]);
    for (const k of Object.keys(out)) delete out[k].head;
    out.pairs = pairs;
    return out;
  });
  const { pairs, ...sounds } = r;
  for (const [id, x] of Object.entries(sounds)) assert.ok(x.finite && x.peak > 0.2 && x.peak <= 1, `${id}: a real sound (${JSON.stringify(x)})`);
  // Distinct: not the same recipe under another name (the waveforms differ by at least half their level).
  for (const [a, b, d] of pairs) assert.ok(d > 0.5, `${a} ≠ ${b} (difference ${d})`);
  console.log(`[arsenal sounds] ${JSON.stringify(pairs)}`);
  assert.deepEqual(page.errors, []);
});
