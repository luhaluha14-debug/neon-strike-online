// Phase 27 third-person weapons: every character shows the weapon it really holds (the same GLB as the
// first-person model, baked into a light template), with its skin; the two knife items (카람빗, 버터플라이)
// are models of their own in first and third person; switching shows another set at once, with nothing built
// per frame and nothing left behind; in a room the others see the weapon and skin each player holds, through
// a rejoin and a host hand-over. Looks only: weapon data and damage are untouched.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'vite';
import { startEnv, openGame, waitReady, installFrameDriver, ROOT } from './harness.mjs';

let vite;
let relay;
let env;
let M;

before(async () => {
  vite = await createServer({ root: ROOT, logLevel: 'error', server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom' });
  const load = (p) => vite.ssrLoadModule(p);
  M = {
    ...(await load('/src/economy/SkinCatalog.ts')),
    ...(await load('/src/skins/SkinClaims.ts')),
    ...(await load('/src/weapons/knifeModels.ts')),
    ...(await load('/src/weapons/weapons.ts')),
  };
  const { createMpServer } = await load('/server/mp/server.ts');
  relay = createMpServer({ staticDir: null, log: () => {} });
  await new Promise((r) => relay.http.listen(0, '127.0.0.1', r));
  process.env.GRID_MP_PROXY = `http://127.0.0.1:${relay.http.address().port}`;
  env = await startEnv();
  delete process.env.GRID_MP_PROXY;
});
after(async () => {
  await env?.close();
  await relay?.close();
  await vite?.close();
});

/** Weapon id → the file a character holding it shows (the first-person model's own, or its lighter version). */
const FILES = {
  ar01: '/weapons/tp/ar01.glb',
  ar02: '/weapons/ar02.glb',
  smg01: '/weapons/smg01_rig.glb',
  smg02: '/weapons/smg02.glb',
  sg01: '/weapons/sg01_rig.glb',
  dmr01: '/weapons/dmr01_rig.glb',
  sr01: '/weapons/tp/sr01.glb',
  lmg01: '/weapons/lmg01_rig.glb',
  lmg02: '/weapons/tp/lmg02.glb',
  pis01: '/weapons/pis01_rig.glb',
  pis02: '/weapons/pis02_rig.glb',
  karambit: '/weapons/tp/m9_bayonet.glb',
};
/** The lighter third-person files (tools/third-person-lods.py) and the first-person files they stand for. */
const LIGHTER = { ar01: 'ar01', sr01: 'sr01', lmg02: 'lmg02', m9_bayonet: 'karambit' };

/** The JSON chunk of a .glb and its triangle count. */
function glb(name) {
  const b = readFileSync(join(ROOT, 'public/weapons', name));
  assert.equal(b.toString('ascii', 0, 4), 'glTF');
  const len = b.readUInt32LE(12);
  const j = JSON.parse(b.subarray(20, 20 + len).toString('utf8'));
  let tris = 0;
  for (const m of j.meshes) for (const p of m.primitives) tris += j.accessors[p.indices].count / 3;
  return { json: j, tris, bytes: b.length };
}

// --- mapping, catalog, files (Node) ---------------------------------------------------------------

test('1. weapon → model: every weapon family (AR, SMG, SG, DMR, SR, LMG, PIS, knife) has its real model; knife items pick theirs; anything else none', async () => {
  const { thirdPersonSpec } = await vite.ssrLoadModule('/src/weapons/view/ThirdPersonWeapons.ts');
  assert.deepEqual(Object.keys(FILES).sort(), Object.keys(M.WEAPONS).sort(), 'every weapon is mapped');
  for (const [id, url] of Object.entries(FILES)) {
    const spec = thirdPersonSpec(id, undefined);
    assert.equal(spec.kind, 'gltf', id);
    assert.equal(spec.url, url, id);
    // The first-person model's own spec, or (the heaviest files) the same spec with its lighter file.
    if (url.includes('/tp/')) assert.deepEqual({ ...spec, url: M.WEAPONS[id].view.url }, M.WEAPONS[id].view, id);
    else assert.equal(spec, M.WEAPONS[id].view, id);
  }
  const families = new Set(Object.values(M.WEAPONS).map((w) => w.category));
  assert.deepEqual([...families].sort(), ['dmr', 'lmg', 'melee', 'pistol', 'rifle', 'shotgun', 'smg', 'sniper']);
  // Knife items: their own models; a knife finish keeps the M9; a knife model never dresses a gun.
  assert.equal(thirdPersonSpec('karambit', 'model:karambit').url, '/weapons/karambit.glb');
  assert.equal(thirdPersonSpec('karambit', 'model:butterfly').url, '/weapons/butterfly.glb');
  assert.equal(thirdPersonSpec('karambit', 'finish:karambit.satin').url, '/weapons/tp/m9_bayonet.glb');
  assert.equal(thirdPersonSpec('ar01', 'model:karambit').url, '/weapons/tp/ar01.glb');
  assert.equal(thirdPersonSpec('nope', undefined), null);
  assert.equal(thirdPersonSpec(undefined, undefined), null);
  assert.equal(thirdPersonSpec('', 'model:karambit'), null);
});

test('2. knife items in the GRID store: 카람빗 1,500 CR and 버터플라이 1,800 CR (knife slot, sold, tradable); M9 stays the free default; claims check', () => {
  const k = M.findSkin('karambit.claw');
  const b = M.findSkin('karambit.butterfly');
  assert.deepEqual([k.name, k.price, k.category, k.targets, k.assetId, k.onSale, k.isDefault, k.rarity], ['카람빗', 1500, 'knife', ['karambit'], 'model:karambit', true, false, 'epic']);
  assert.deepEqual([b.name, b.price, b.category, b.targets, b.assetId, b.onSale, b.isDefault, b.rarity], ['버터플라이 나이프', 1800, 'knife', ['karambit'], 'model:butterfly', true, false, 'epic']);
  const def = M.SKIN_CATALOG.find((s) => s.category === 'knife' && s.isDefault);
  assert.deepEqual([def.price, def.onSale], [0, false]);
  assert.deepEqual(M.validateCatalog(M.SKIN_CATALOG), []);
  assert.equal(M.knifeViewSpec('model:karambit').url, '/weapons/karambit.glb');
  assert.equal(M.knifeViewSpec('finish:karambit.satin'), undefined);
  // In a room: a knife item claimed for the knife passes; for a gun it does not.
  assert.deepEqual(M.catalogClaimVerifier.verify({ karambit: 'karambit.butterfly', ar01: 'karambit.claw' }), { karambit: 'karambit.butterfly' });
  // What a character shows from a snapshot: only a skin of the weapon in hand.
  assert.equal(M.heldAsset('karambit.claw', 'karambit'), 'model:karambit');
  assert.equal(M.heldAsset('karambit.claw', 'ar01'), undefined);
  assert.equal(M.heldAsset('sr01.olive', 'ar01'), undefined, 'another weapon’s skin is not applied');
  assert.equal(M.heldAsset('ar01.fde', 'ar01'), 'finish:ar01.fde');
  assert.equal(M.heldAsset('nope', 'ar01'), undefined);
  assert.equal(M.heldAsset({ evil: 1 }, 'ar01'), undefined);
});

test('3. the knife models (made for GRID in Blender, tools/knife-models.py): parts, materials, polygon budget', () => {
  const k = glb('karambit.glb');
  assert.deepEqual(k.json.materials.map((m) => m.name), ['Blade_Steel', 'Blade_Edge', 'Handle_G10', 'Ring_Steel', 'Pin_Steel', 'Handle_Groove']);
  const b = glb('butterfly.glb');
  assert.deepEqual(b.json.nodes.map((n) => n.name), ['Blade', 'Handle_Safe', 'Handle_Bite']);
  assert.deepEqual(b.json.materials.map((m) => m.name), ['Blade_Steel', 'Blade_Edge', 'Handle_Anodized', 'Handle_Window', 'Pin_Brass', 'Latch_Steel']);
  // Each handle turns about its own pin (the node origin), on either side of the blade's tang.
  const [safe, bite] = [b.json.nodes[1].translation, b.json.nodes[2].translation];
  assert.ok(safe[0] > 0.004 && bite[0] < -0.004, 'pins either side of the tang');
  for (const f of [k, b]) {
    assert.ok(f.tris > 500 && f.tris < 3000, `${f.tris} triangles: a game-ready budget`);
    assert.ok(f.bytes < 80000, `${f.bytes} bytes`);
    assert.ok(f.json.materials.length <= 6, 'a few materials (≤ 6 draw calls)');
  }
  // The shipped M9 for scale: the new knives are far lighter.
  assert.ok(glb('m9_bayonet.glb').tris > 10 * k.tris);
});

test('3b. the lighter third-person files: same nodes, transforms and material names as the first-person files, a fraction of the triangles', () => {
  for (const name of Object.keys(LIGHTER)) {
    const full = glb(`${name}.glb`);
    const tp = glb(`tp/${name}.glb`);
    const names = (j) => j.nodes.map((n) => n.name).sort();
    assert.deepEqual(names(tp.json), names(full.json), `${name}: nodes`);
    assert.deepEqual(tp.json.materials.map((m) => m.name).sort(), full.json.materials.map((m) => m.name).sort(), `${name}: materials (skins)`);
    const byName = new Map(tp.json.nodes.map((n) => [n.name, n]));
    for (const n of full.json.nodes) {
      const t = byName.get(n.name);
      for (const [k, d] of [['translation', [0, 0, 0]], ['rotation', [0, 0, 0, 1]], ['scale', [1, 1, 1]]]) {
        const a = n[k] ?? d;
        const b = t[k] ?? d;
        assert.ok(a.every((v, i) => Math.abs(v - b[i]) < 1e-5), `${name}: ${n.name} ${k}`);
      }
    }
    assert.ok(tp.tris < full.tris * 0.45 && tp.tris <= 5500, `${name}: ${full.tris} → ${tp.tris} triangles`);
  }
});

// --- in the game (browser) ------------------------------------------------------------------------

/** Waits for the third-person template of every file (and the knife items) to load; returns their stats. */
const loadAll = (page) =>
  page.evaluate(async () => {
    const T = await import('/src/weapons/view/ThirdPersonWeapons.ts');
    const { WEAPONS } = await import('/src/weapons/weapons.ts');
    const items = [...Object.keys(WEAPONS).map((w) => [w, undefined]), ['karambit', 'model:karambit'], ['karambit', 'model:butterfly']];
    const out = {};
    for (const [w, a] of items) {
      const spec = T.thirdPersonSpec(w, a);
      let t = null;
      for (let i = 0; i < 600 && !(t = T.thirdPersonTemplate(spec)); i++) await new Promise((r) => setTimeout(r, 50));
      out[a ?? w] = t && { parts: t.parts.length, triangles: t.triangles, muzzle: !!t.muzzle };
    }
    return { out, count: T.thirdPersonTemplateCount() };
  });

test('4. templates: every weapon file and both knife items load once, merged per material (≤ 8 draw calls); guns have a muzzle', async () => {
  const page = await openGame(env, { mode: 'training', width: 480, height: 270 });
  try {
    const { out, count } = await loadAll(page);
    for (const [k, t] of Object.entries(out)) {
      assert.ok(t, `${k}: loaded`);
      assert.ok(t.parts >= 1 && t.parts <= 8, `${k}: ${t.parts} draw calls`);
      assert.ok(t.triangles > 300, `${k}: ${t.triangles} triangles`);
      if (!['karambit', 'model:karambit', 'model:butterfly'].includes(k)) assert.ok(t.muzzle, `${k}: muzzle`);
    }
    assert.equal(count, 14, 'one template per file (12 weapon files + 2 knives), never per character');
    // Asked again: the same template objects (nothing rebuilt).
    const same = await page.evaluate(async () => {
      const T = await import('/src/weapons/view/ThirdPersonWeapons.ts');
      const s = T.thirdPersonSpec('ar01');
      return T.thirdPersonTemplate(s) === T.thirdPersonTemplate(s) && T.thirdPersonTemplateCount();
    });
    assert.equal(same, 14);
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});

test('4b. a lighter file that cannot load: the first-person file is shown instead (never the stand-in for good)', async () => {
  // The lighter SR-01 file fails to download (from the first request on, the game's preload included).
  const init = () => {
    const real = window.fetch.bind(window);
    window.fetch = (u, o) => (String(u?.url ?? u).includes('/weapons/tp/sr01.glb') ? Promise.reject(new TypeError('blocked by the test')) : real(u, o));
  };
  const page = await openGame(env, { mode: 'training', width: 480, height: 270, init });
  try {
    const r = await page.evaluate(async () => {
      const T = await import('/src/weapons/view/ThirdPersonWeapons.ts');
      let t = null;
      let url = '';
      for (let i = 0; i < 600 && !t; i++) {
        const spec = T.thirdPersonSpec('sr01');
        url = spec.url;
        t = T.thirdPersonTemplate(spec);
        if (!t) await new Promise((r) => setTimeout(r, 50));
      }
      return { loaded: !!t, triangles: t?.triangles, url };
    });
    assert.equal(r.loaded, true);
    assert.equal(r.triangles, 21172, 'the full SR-01');
    assert.equal(r.url, '/weapons/sr01.glb');
  } finally {
    await page.context().close();
  }
});

test('5–6 / 9. a character: shows the weapon it holds, switching at once; skins per weapon, an unfit one never applied; no duplicate sets, nothing built per frame, nothing left after many switches', async () => {
  const page = await openGame(env, { mode: 'deathmatch', map: 'warehouse', width: 480, height: 270 });
  try {
    await installFrameDriver(page);
    await page.evaluate(() => {
      window.__render = window.game.renderer.render.bind(window.game.renderer);
      window.T.stopLoop();
      window.T.run(20);
    });
    await loadAll(page);
    const r = await page.evaluate(async () => {
      const THREE = await import('/node_modules/.vite/deps/three.js');
      const g = window.game;
      const m = g.squad['models'][0];
      const held = m.held;
      const visibleSets = () => [...held.sets.values()].filter((s) => s.visible).map((s) => s.name);
      const standIn = () => held.mount.children.filter((c) => !c.name.startsWith('held:')).some((c) => c.visible);
      const colour = (re) => {
        let c = null;
        for (const s of held.sets.values()) if (s.visible) s.traverse((o) => o.isMesh && re.test(o.material.name) && (c = o.material.color.getHexString()));
        return c;
      };
      const out = {};
      // Each weapon: its own set shows, only it, the stand-in hidden; the muzzle point moves with it.
      out.each = {};
      for (const w of ['ar01', 'smg01', 'sg01', 'dmr01', 'sr01', 'lmg02', 'pis02', 'karambit']) {
        m.setWeapon(w, undefined);
        out.each[w] = { real: held.real, sets: visibleSets(), standIn: standIn(), muzzleZ: +m.muzzle.position.z.toFixed(2) };
      }
      // The same call again (every frame does it): nothing happens.
      m.setWeapon('ar01', undefined);
      const set = [...held.sets.values()].find((s) => s.visible);
      for (let i = 0; i < 100; i++) m.setWeapon('ar01', undefined);
      out.sameSet = [...held.sets.values()].find((s) => s.visible) === set;
      // Skins: the AR-01's FDE on its polymer; SR-01 OD green; another weapon's skin is not applied.
      m.setWeapon('ar01', 'finish:ar01.fde');
      out.fde = colour(/^M4_Polymer@finish:ar01\.fde$/);
      m.setWeapon('sr01', 'finish:sr01.olive');
      out.olive = colour(/^Stock_Olive@finish:sr01\.olive$/);
      m.setWeapon('ar01', undefined);
      out.plain = colour(/@/);
      // Knife items: their own model in the hands; a knife finish on the M9.
      m.setWeapon('karambit', 'model:karambit');
      out.claw = visibleSets();
      m.setWeapon('karambit', 'model:butterfly');
      out.fly = visibleSets();
      // An unknown weapon (a newer client's, a bad snapshot): the stand-in rifle, nothing else.
      m.setWeapon('nope', undefined);
      out.unknown = { real: held.real, sets: visibleSets(), standIn: standIn() };
      m.setWeapon(undefined, undefined);
      out.none = { real: held.real, standIn: standIn() };

      // Many switches: at most a few sets per character, scene geometry and GPU geometry counts steady.
      const cam = new THREE.PerspectiveCamera();
      const cycle = ['ar01', 'ar02', 'smg01', 'smg02', 'sg01', 'dmr01', 'sr01', 'lmg01', 'lmg02', 'pis01', 'pis02', 'karambit'];
      const geos = () => {
        const s = new Set();
        g.scene.traverse((o) => o.geometry && s.add(o.geometry.uuid));
        return s.size;
      };
      const loop = () => {
        for (const w of cycle) {
          m.setWeapon(w, w === 'ar01' ? 'finish:ar01.fde' : undefined);
          window.__render(g.scene, cam);
        }
      };
      loop();
      const after1 = { sets: held.setCount, scene: geos(), gpu: g.renderer.info.memory.geometries, meshes: 0 };
      for (let i = 0; i < 5; i++) loop();
      const after6 = { sets: held.setCount, scene: geos(), gpu: g.renderer.info.memory.geometries, meshes: 0 };
      held.mount.traverse((o) => o.isMesh && after6.meshes++);
      out.loops = { after1, after6 };
      // Frames: the game sets every character's weapon each frame; it does not build anything.
      const T = await import('/src/weapons/view/ThirdPersonWeapons.ts');
      const templates = T.thirdPersonTemplateCount();
      const before = g.squad['models'].map((x) => x.held.setCount);
      window.T.run(120);
      out.frames = { templates: T.thirdPersonTemplateCount() === templates, sets: g.squad['models'].every((x, i) => x.held.setCount <= Math.max(before[i], 6)) };
      // The bots show what they hold (their own weapon).
      out.bots = g.squad.bots.every((b, i) => !g.squad['models'][i] || g.squad['models'][i].held.weaponId === b.weapons.weapon.def.id);
      return out;
    });
    for (const [w, v] of Object.entries(r.each)) {
      assert.equal(v.real, true, w);
      assert.deepEqual(v.sets, [`held:${w}|`], w);
      assert.equal(v.standIn, false, w);
    }
    assert.ok(r.each.sr01.muzzleZ < r.each.pis02.muzzleZ, 'the muzzle point follows the weapon (a rifle reaches further)');
    assert.equal(r.sameSet, true);
    assert.equal(r.fde, '8a7553');
    assert.equal(r.olive, '4b4f36');
    assert.equal(r.plain, null, 'the default look: no skinned material');
    assert.deepEqual(r.claw, ['held:karambit|model:karambit']);
    assert.deepEqual(r.fly, ['held:karambit|model:butterfly']);
    assert.deepEqual(r.unknown, { real: false, sets: [], standIn: true });
    assert.deepEqual(r.none, { real: false, standIn: true });
    assert.ok(r.loops.after6.sets <= 6, `sets kept: ${r.loops.after6.sets}`);
    assert.equal(r.loops.after6.scene, r.loops.after1.scene, 'scene geometries steady');
    assert.equal(r.loops.after6.gpu, r.loops.after1.gpu, 'GPU geometries steady');
    assert.ok(r.loops.after6.meshes <= 6 * 8 + 20, `${r.loops.after6.meshes} meshes on the mount`);
    assert.deepEqual(r.frames, { templates: true, sets: true });
    assert.equal(r.bots, true);
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});

test('2 / 7. a bought knife item in the hands: first person shows the 카람빗 / 버터플라이 model (handles fold open on the draw); unequipped, the M9 again', async () => {
  const page = await openGame(env, { mode: 'training', width: 480, height: 270 });
  try {
    await page.waitForFunction(() => window.game.account);
    await page.evaluate(() => {
      const a = JSON.parse(localStorage.getItem('grid.account.v1'));
      a.credits = 5000;
      localStorage.setItem('grid.account.v1', JSON.stringify(a));
    });
    await page.reload();
    await waitReady(page);
    await page.waitForFunction(() => window.game.account?.credits === 5000);
    const buy = await page.evaluate(async () => {
      const g = window.game;
      const out = [];
      for (const id of ['karambit.claw', 'karambit.butterfly']) {
        const r = await g.economy.purchase(id);
        out.push(r.ok);
      }
      return { ok: out, credits: g.account.credits };
    });
    assert.deepEqual(buy, { ok: [true, true], credits: 5000 - 1500 - 1800 });
    const holdKnife = (skinId) =>
      page.evaluate(async (skinId) => {
        const g = window.game;
        const item = skinId ? g.account.items.find((i) => i.skinId === skinId).itemId : null;
        const r = item ? await g.economy.equip('knife', 'karambit', item) : await g.economy.equip('knife', 'karambit', null);
        g.weapons.equipSlot(2);
        g.showWeaponModel(g.weapons.weapon.def);
        return r.ok;
      }, skinId);
    const firstPerson = () =>
      page.evaluate(() => {
        const v = window.game.viewModel.currentView;
        const mats = new Set();
        v.object.traverse((o) => o.isMesh && mats.add([o.material].flat()[0].name));
        return { url: window.game.shownSpec.url, mats: [...mats].sort() };
      });
    assert.equal(await holdKnife('karambit.claw'), true);
    await page.waitForFunction(() => window.game.viewModel.currentView?.object && [...(function* f(o) { yield o; for (const c of o.children) yield* f(c); })(window.game.viewModel.currentView.object)].some((o) => o.material?.name === 'Ring_Steel'));
    const claw = await firstPerson();
    assert.equal(claw.url, '/weapons/karambit.glb');
    assert.ok(claw.mats.includes('Ring_Steel') && claw.mats.includes('Blade_Edge'), claw.mats.join());

    assert.equal(await holdKnife('karambit.butterfly'), true);
    await page.waitForFunction(() => window.game.viewModel.currentView?.hinges?.length === 2);
    // The handles: closed over the blade as it is drawn, open in the hand; flipped shut and open again on inspect.
    const hinge = await page.evaluate(() => {
      const v = window.game.viewModel.currentView;
      const at = (equip, inspect) => {
        v.animate({ category: 'melee', equip, reload: null, sinceShot: 9, fireInterval: 0.5, inspect });
        return v.hinges.map((h) => +Math.abs(h.o.rotation.z - h.rest).toFixed(2));
      };
      return { drawing: at(0, null), open: at(1, null), flip: at(1, 0.5), done: at(1, 1) };
    });
    assert.deepEqual(hinge.drawing, [3.14, 3.14]);
    assert.deepEqual(hinge.open, [0, 0]);
    assert.deepEqual(hinge.flip, [3.14, 3.14]);
    assert.deepEqual(hinge.done, [0, 0]);
    assert.equal((await firstPerson()).url, '/weapons/butterfly.glb');

    // Unequipped: the free M9 again.
    assert.equal(await holdKnife(null), true);
    assert.equal((await firstPerson()).url, '/weapons/m9_bayonet.glb');
    // The knife's damage is the knife's: an item is a look.
    const dmg = await page.evaluate(async () => {
      const { WEAPONS } = await import('/src/weapons/weapons.ts');
      return [WEAPONS.karambit.damage.base, WEAPONS.karambit.fireRate];
    });
    assert.deepEqual(dmg, [M.WEAPONS.karambit.damage.base, M.WEAPONS.karambit.fireRate]);
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});

// --- a room ---------------------------------------------------------------------------------------

const enter = async (p, name, code) => {
  await p.click('#tab-multi');
  await p.fill('.mp-name', name);
  if (code) {
    await p.fill('.mp-code', code);
    await p.click('.mp-join-btn');
    await p.waitForFunction(() => window.game.netClient?.myId && window.game.match);
    return code;
  }
  await p.selectOption('.mp-mode', 'deathmatch');
  await p.click('.mp-create');
  await p.waitForFunction(() => window.game.netHost && window.game.match && window.game.squad);
  return (await p.textContent('.mp-room-code')).trim();
};
/** Puts `weaponId` in this page's hands (the loadout the room uses, then the slot). */
const hold = (p, weaponId) =>
  p.evaluate(async (w) => {
    const g = window.game;
    const { WEAPONS } = await import('/src/weapons/weapons.ts');
    const defs = [WEAPONS[w], WEAPONS.pis01, WEAPONS.karambit];
    if (w === 'karambit') g.weapons.equipSlot(2);
    else {
      g.weapons.setLoadout(defs, 0);
      g.showWeaponModel(g.weapons.weapon.def);
    }
    if (w === 'karambit') g.showWeaponModel(g.weapons.weapon.def);
    return g.netWeaponId;
  }, weaponId);
/** What the host shows on the character the member plays. */
const hostSees = (host) =>
  host.evaluate(() => {
    const g = window.game;
    const i = g.squad.bots.findIndex((b) => b.remote);
    const h = i >= 0 ? g.squad['models'][i]?.held : null;
    return h ? `${h.real ? h.weaponId : 'stand-in'}|${h.assetId ?? ''}` : null;
  });
/** What a member shows on another character (by wire id). */
const memberSees = (p, id) =>
  p.evaluate((id) => {
    const h = window.game.netClient?.puppets.all.get(id)?.model.held;
    return h ? `${h.real ? h.weaponId : 'stand-in'}|${h.assetId ?? ''}` : null;
  }, id);

test('7–8. a room (3 browsers): each sees the weapon the other holds and its skin, switching at once; the knife item; rejoin and host hand-over keep it; one set per weapon', async () => {
  const host = await openGame(env, { mode: 'deathmatch', width: 480, height: 270 });
  const member = await openGame(env, { mode: 'training', width: 480, height: 270 });
  const third = await openGame(env, { mode: 'training', width: 480, height: 270 });
  const all = [host, member, third];
  for (const p of all) p.setDefaultTimeout(60000);
  try {
    // The member owns and wears the 카람빗 and FDE on its AR-01.
    await member.waitForFunction(() => window.game.account);
    await member.evaluate(() => {
      const a = JSON.parse(localStorage.getItem('grid.account.v1'));
      a.credits = 5000;
      localStorage.setItem('grid.account.v1', JSON.stringify(a));
    });
    await member.reload();
    await waitReady(member);
    await member.waitForFunction(() => window.game.account?.credits === 5000);
    const worn = await member.evaluate(async () => {
      const g = window.game;
      const ok = [];
      for (const [id, cat, target] of [['karambit.claw', 'knife', 'karambit'], ['ar01.fde', 'weapon', 'ar01']]) {
        const b = await g.economy.purchase(id);
        ok.push((await g.economy.equip(cat, target, b.account.items.find((i) => i.skinId === id).itemId)).ok);
      }
      return ok;
    });
    assert.deepEqual(worn, [true, true]);
    const code = await enter(host, 'Alpha');
    await enter(member, 'Bravo', code);
    await host.waitForFunction(() => window.game.squad.bots.some((b) => b.remote));

    // The member holds its AR-01: the host shows the AR-01 model in FDE.
    await host.waitForFunction(() => {
      const g = window.game;
      const i = g.squad.bots.findIndex((b) => b.remote);
      return g.squad['models'][i]?.held.real;
    });
    assert.equal(await hostSees(host), 'ar01|finish:ar01.fde');
    // Switching: each weapon the member takes shows on the host, model and all.
    for (const w of ['smg02', 'sg01', 'dmr01', 'lmg01', 'pis02', 'sr01']) {
      assert.equal(await hold(member, w), w);
      await host.waitForFunction((w) => {
        const g = window.game;
        const i = g.squad.bots.findIndex((b) => b.remote);
        const h = g.squad['models'][i]?.held;
        return h?.real && h.weaponId === w;
      }, w);
      assert.equal(await hostSees(host), `${w}|`);
    }
    // The knife: the 카람빗 item's own model.
    await hold(member, 'karambit');
    await host.waitForFunction(() => {
      const g = window.game;
      const i = g.squad.bots.findIndex((b) => b.remote);
      return g.squad['models'][i]?.held.weaponId === 'karambit' && g.squad['models'][i].held.real;
    });
    assert.equal(await hostSees(host), 'karambit|model:karambit');

    // The member sees the host's weapon: AR-01 (default look), then its pistol.
    const hostId = await host.evaluate(() => window.game.net.id);
    await member.waitForFunction((id) => window.game.netClient.puppets.all.get(id)?.model.held.real, hostId);
    assert.equal(await memberSees(member, hostId), `${await host.evaluate(() => window.game.netWeaponId)}|`);
    await hold(host, 'pis01');
    await member.waitForFunction((id) => window.game.netClient.puppets.all.get(id)?.model.held.weaponId === 'pis01', hostId);
    assert.equal(await memberSees(member, hostId), 'pis01|');

    // Rejoin: the member leaves and comes back holding its AR-01 again; the host shows it in FDE.
    await hold(member, 'ar01');
    await member.click('.mp-leave');
    await host.waitForFunction(() => !window.game.squad.bots.some((b) => b.remote));
    await enter(member, 'Bravo', code);
    await host.waitForFunction(() => {
      const g = window.game;
      const i = g.squad.bots.findIndex((b) => b.remote);
      const h = i >= 0 ? g.squad['models'][i]?.held : null;
      return h?.real && h.weaponId === 'ar01' && h.assetId === 'finish:ar01.fde';
    });

    // A third player sees the member's weapon; the host leaves: the member hosts, and the third still sees it.
    await enter(third, 'Charlie', code);
    const seat = await host.evaluate(() => window.game.squad.bots.find((b) => b.remote).id);
    const memberId = await member.evaluate(() => window.game.net.id);
    await third.waitForFunction((id) => window.game.netClient.puppets.all.get(id)?.model.held.real, seat);
    assert.equal(await memberSees(third, seat), 'ar01|finish:ar01.fde');
    await hold(member, 'karambit');
    await third.waitForFunction((id) => window.game.netClient.puppets.all.get(id)?.model.held.assetId === 'model:karambit' && window.game.netClient.puppets.all.get(id).model.held.real, seat);
    assert.equal(await memberSees(third, seat), 'karambit|model:karambit');
    await host.click('.mp-leave');
    await member.waitForFunction(() => window.game.netHost && window.game.match && window.game.squad);
    await third.waitForFunction((id) => window.game.netClient?.myId && window.game.netClient.puppets.all.get(id)?.model.held.real, memberId);
    assert.equal(await memberSees(third, memberId), 'karambit|model:karambit');
    await hold(member, 'lmg02');
    await third.waitForFunction((id) => window.game.netClient.puppets.all.get(id)?.model.held.weaponId === 'lmg02', memberId);
    assert.equal(await memberSees(third, memberId), 'lmg02|');

    // One puppet per player, a few sets each at most (no duplicates through the switches and hand-over).
    const counts = await third.evaluate(() => [...window.game.netClient.puppets.all.values()].map((p) => p.model.held.setCount));
    assert.ok(counts.length >= 1 && counts.every((n) => n <= 6), counts.join());
    // Looks only: weapon data and a hit's damage are what they were.
    const combat = await member.evaluate(async () => {
      const { WEAPONS } = await import('/src/weapons/weapons.ts');
      const { computeDamage } = await import('/src/combat/HitscanSystem.ts');
      return { ar01: [WEAPONS.ar01.damage.base, WEAPONS.ar01.fireRate, WEAPONS.ar01.magazineSize], hit: computeDamage(WEAPONS.ar01.damage, 'body', 10) };
    });
    assert.deepEqual(combat, { ar01: [24, 600, 30], hit: 24 });
    for (const p of all) assert.deepEqual(p.errors, []);
  } finally {
    for (const p of all) await p.context().close();
  }
});

test('8. snapshots: an older host (no weapon field) shows the stand-in rifle in its skin; an unknown weapon, an unfit skin or junk fields never break a puppet', async () => {
  const page = await openGame(env, { mode: 'training', width: 480, height: 270 });
  try {
    await loadAll(page);
    const r = await page.evaluate(async () => {
      const { Puppets } = await import('/src/net/Puppets.ts');
      const pp = new Puppets('bots');
      let t = 0;
      // [id, x, y, z, yaw, pitch, height, vx, vz, flags, hp, armor, deadTime, team, skin?, weapon?]
      const shows = (...tail) => {
        t += 0.05;
        pp.push(t, [['p1', 0, 0, 0, 0, 0, 1.8, 0, 0, 1 | 2, 100, 0, 0, '', ...tail]], null);
        pp.update(1 / 60, t);
        const h = pp.all.get('p1').model.held;
        return `${h.real ? h.weaponId : 'stand-in'}|${h.assetId ?? ''}`;
      };
      const out = {
        old: shows(),
        oldSkin: shows('ar01.fde'),
        ar01: shows('', 'ar01'),
        fde: shows('ar01.fde', 'ar01'),
        unfit: shows('sr01.olive', 'ar01'),
        knifeOnGun: shows('karambit.claw', 'ar01'),
        claw: shows('karambit.claw', 'karambit'),
        unknown: shows('ar01.fde', 'nope'),
        back: shows('', 'sg01'),
        junk: shows({ x: 1 }, 42),
        long: shows('x'.repeat(5000), 'y'.repeat(5000)),
      };
      out.sets = pp.all.get('p1').model.held.setCount;
      out.puppets = pp.all.size;
      pp.dispose();
      return out;
    });
    assert.deepEqual(r, {
      old: 'stand-in|',
      oldSkin: 'stand-in|finish:ar01.fde',
      ar01: 'ar01|',
      fde: 'ar01|finish:ar01.fde',
      unfit: 'ar01|',
      knifeOnGun: 'ar01|',
      claw: 'karambit|model:karambit',
      unknown: 'stand-in|finish:ar01.fde',
      back: 'sg01|',
      junk: 'stand-in|',
      long: 'stand-in|',
      sets: 4,
      puppets: 1,
    });
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});
