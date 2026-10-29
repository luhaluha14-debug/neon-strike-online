// Asset-level checks that need no rendering:
//   - every material name in both map GLBs maps to the expected surface type
//     (tests/golden/surfaces.json); renaming materials in Blender or editing
//     the classification rules shows up here,
//   - map node rules still match the files (hidden helper meshes exist),
//   - every synthesised sound is finite, never clips and is deterministic.
// Game modules are imported in a browser page served by Vite (the game itself
// is not started), because they are TypeScript with bundler-style imports.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startEnv, golden, ROOT } from './harness.mjs';

let env;
let page;
before(async () => {
  env = await startEnv();
  const context = await env.browser.newContext();
  page = await context.newPage();
  // Any non-HTML URL of the dev server gives the page its origin without booting the game.
  await page.goto(env.url + '/src/config.ts');
});
after(async () => {
  await page?.context().close();
  await env?.close();
});

/** The JSON chunk of a .glb file. */
async function glbJson(file) {
  const b = await readFile(ROOT + 'public/maps/' + file);
  assert.equal(b.toString('ascii', 0, 4), 'glTF');
  const len = b.readUInt32LE(12);
  return JSON.parse(b.toString('utf8', 20, 20 + len));
}

test('map materials classify into the recorded surface types', async () => {
  const names = {};
  for (const [map, file] of [
    ['seoul', 'seoul.glb'],
    ['warehouse', 'Untitled.glb'],
  ]) {
    names[map] = (await glbJson(file)).materials.map((m) => m.name ?? '');
  }
  const kinds = await page.evaluate(async (names) => {
    const { classifySurface } = await import('/src/world/SurfaceMaterials.ts');
    const out = {};
    for (const [map, list] of Object.entries(names)) out[map] = Object.fromEntries(list.map((n) => [n, classifySurface(n)]));
    return out;
  }, names);
  assert.ok(Object.keys(kinds.seoul).length > 100);
  // A few anchors that must never drift.
  assert.equal(kinds.seoul.SMAT_Road_Asphalt, 'asphalt');
  assert.equal(kinds.seoul.SMAT_Bldg_Brick_Red, 'brick');
  assert.equal(kinds.seoul.SMAT_Bldg_Glass_Blue, 'glass');
  assert.equal(kinds.seoul.SMAT_Granite_Paver, 'paver');
  assert.equal(kinds.seoul.CG_Stream_Water, 'water');
  assert.equal(kinds.warehouse.MAT_Floor_Concrete, 'concrete');
  assert.deepEqual(kinds, await golden('surfaces', kinds));
});

test('map node rules still match the GLB files', async () => {
  const maps = await page.evaluate(async () => (await import('/src/maps.ts')).MAPS.map((m) => ({ id: m.id, url: m.url, hidden: m.hiddenPrefixes, spawnA: m.attackSpawnPrefix, spawnD: m.defenseSpawnPrefix })));
  for (const m of maps) {
    const nodes = (await glbJson(m.url.split('/').pop())).nodes.map((n) => n.name ?? '');
    assert.ok(nodes.some((n) => n.startsWith(m.spawnA)), `${m.id}: no attack spawns`);
    assert.ok(nodes.some((n) => n.startsWith(m.spawnD)), `${m.id}: no defense spawns`);
    if (m.id === 'warehouse') {
      // The particle emitter that z-fought with the floor must stay hidden.
      assert.ok(nodes.includes('Ground_Pebble_Emitter'));
      assert.ok(m.hidden.some((p) => 'Ground_Pebble_Emitter'.startsWith(p)));
    }
  }
});

test('every synthesised sound is finite, never clips and is deterministic', async () => {
  const r = await page.evaluate(async () => {
    const { renderSound, VARIANTS } = await import('/src/audio/weaponSounds.ts');
    const { SR_01 } = await import('/src/weapons/weapons.ts');
    const opts = { srFireInterval: 60 / SR_01.fireRate };
    const out = {};
    for (const id of Object.keys(VARIANTS)) {
      for (let v = 0; v < VARIANTS[id]; v++) {
        const a = renderSound(id, v, opts);
        const b = renderSound(id, v, opts);
        let peak = 0;
        let bad = 0;
        let same = a.length === b.length;
        for (let i = 0; i < a.length; i++) {
          if (!Number.isFinite(a[i])) bad++;
          peak = Math.max(peak, Math.abs(a[i]));
          if (a[i] !== b[i]) same = false;
        }
        out[`${id}#${v}`] = { samples: a.length, peak, bad, same };
      }
    }
    return out;
  });
  const entries = Object.entries(r);
  assert.ok(entries.length >= 13);
  for (const [name, s] of entries) {
    assert.ok(s.samples > 0, `${name}: empty`);
    assert.equal(s.bad, 0, `${name}: non-finite samples`);
    assert.ok(s.peak > 0.05 && s.peak <= 1, `${name}: peak ${s.peak}`);
    assert.equal(s.same, true, `${name}: not deterministic`);
  }
});

test('every weapon references sounds that exist', async () => {
  const missing = await page.evaluate(async () => {
    const { VARIANTS } = await import('/src/audio/weaponSounds.ts');
    const { AR_01, SR_01, KARAMBIT } = await import('/src/weapons/weapons.ts');
    const out = [];
    for (const w of [AR_01, SR_01, KARAMBIT]) {
      const s = w.sounds;
      for (const id of [s.fire, s.hit, s.cycle, s.dry, s.equip, s.reloadEnd, ...(s.reload ?? []).map((c) => c.sound)]) {
        if (id !== undefined && !(id in VARIANTS)) out.push(`${w.id}: ${id}`);
      }
    }
    return out;
  });
  assert.deepEqual(missing, []);
});
