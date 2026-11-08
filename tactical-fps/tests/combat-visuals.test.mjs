// Combat visuals (Phase 14), in the real game: per-weapon first-person muzzle
// flashes (at the muzzle, gone after a few hundredths of a second, no light
// left on), spent cases thrown from the weapon's ejection port (pump / bolt
// timing, gravity, resting on the floor, removal, a fixed pool, off at low
// quality, never sent over the network), surface impacts by material (sparks
// off metal, dust and chips off concrete; detail by quality; pooled), the kill
// notice joined to the kill confirm, and the weapon models' surface detail
// (cutter leftovers darkened, grain kept on skinned copies). None of it
// changes a weapon's damage, rate of fire, magazine or reload.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, startEnv, openGame, installFrameDriver } from './harness.mjs';

let env;
let page;

before(async () => {
  env = await startEnv();
  page = await openGame(env, { mode: 'training', quality: 'high' });
  await page.click('.play-button');
  await page.waitForFunction(() => window.game.input.active);
  await installFrameDriver(page);
  await page.evaluate(() => {
    const g = window.game;
    window.T.stopLoop();
    g.combat.protection = 1e9;
    window.T.equip = async (id) => {
      const { WEAPONS } = await import('/src/weapons/weapons.ts');
      g.weapons.setLoadout([WEAPONS[id], WEAPONS.karambit]);
      g.viewModel.resetMotion();
      await new Promise((r) => setTimeout(r, 200));
      window.T.run(100);
      g.casings.clear();
      g.impacts.clear();
    };
    /** Faces open ground or a wall, level. */
    window.T.face = (wall) => {
      const p = g.player;
      const V = p.position.constructor;
      for (let a = 0; a < 64; a++) {
        const yaw = (a / 64) * Math.PI * 2;
        const d = g.map.collision.raycast(new V(p.position.x, p.position.y + 1.4, p.position.z), new V(-Math.sin(yaw), 0, -Math.cos(yaw)), 40);
        if (wall ? d !== null && d > 3 && d < 12 : d === null) {
          p.yaw = yaw;
          p.pitch = wall ? -0.03 : 0;
          return d;
        }
      }
      return undefined;
    };
    window.T.fire = () => {
      g.input.mouseButtons |= 1;
      window.T.run(1);
      g.input.mouseButtons &= ~1;
    };
  });
});
after(async () => {
  await page?.context().close();
  await env?.close();
});

test('muzzle flash: its own size per weapon, at the muzzle, gone within a tenth of a second, light off after it', async () => {
  const r = await page.evaluate(async () => {
    const g = window.game;
    const { FLASH } = await import('/src/weapons/view/MuzzleFlash.ts');
    const out = { profiles: FLASH, shots: {} };
    for (const id of ['ar01', 'smg01', 'pis01', 'sg01', 'sr01']) {
      await window.T.equip(id);
      window.T.face(false);
      window.T.fire();
      const f = g.viewModel.flash;
      const at = f.showing;
      const parentIsMuzzle = f.object.parent === g.viewModel.inHand.muzzle;
      const light = g.muzzleLight.intensity;
      window.T.run(6); // 0.1 s
      out.shots[id] = { at, parentIsMuzzle, light, after: f.showing, lightAfter: g.muzzleLight.intensity, brightness: f.brightness };
      window.T.run(60);
    }
    return out;
  });
  const P = r.profiles;
  // Shotgun wide and heavy; sniper long with brake jets; AR > SMG; pistol the shortest flame.
  assert.ok(P.shotgun.core > P.rifle.core && P.shotgun.prongWidth > P.rifle.prongWidth);
  assert.ok(P.sniper.prongLength > P.rifle.prongLength && P.sniper.sideJets > 0);
  assert.ok(P.rifle.core > P.smg.core && P.smg.life < P.rifle.life);
  assert.ok(P.pistol.prongLength < P.smg.prongLength);
  for (const k of ['rifle', 'smg', 'pistol']) assert.equal(P[k].sideJets, 0, k);
  for (const [id, s] of Object.entries(r.shots)) {
    assert.equal(s.at.flash, true, `${id}: flash on the shot frame`);
    assert.equal(s.parentIsMuzzle, true, `${id}: flash attached to the muzzle`);
    assert.ok(s.light > 0, `${id}: short light on the shot (high quality)`);
    assert.equal(s.after.flash, false, `${id}: flash gone after 0.1 s`);
    assert.equal(s.lightAfter, 0, `${id}: no light left on`);
    assert.equal(s.brightness, 0);
  }
  assert.equal(r.shots.sr01.at.jets, true, 'sniper brake jets');
  assert.equal(r.shots.ar01.at.jets, false);
  assert.equal(r.shots.ar01.at.smoke, true, 'smoke wisp at high quality');
});

test('cases: one per round from the port, to the port side; pump / bolt delay; fall, rest on the floor, fade out', async () => {
  const r = await page.evaluate(async () => {
    const g = window.game;
    const out = {};
    for (const id of ['ar01', 'pis01', 'sg01', 'sr01']) {
      await window.T.equip(id);
      window.T.face(false);
      window.T.fire();
      const first = g.casings.count;
      window.T.run(50); // 0.83 s: past the pump (0.22 s) and the bolt (0.62 s)
      const later = g.casings.count;
      let pos = null;
      for (let i = 0; i < 48 && !pos; i++) pos = g.casings.at(i)?.clone() ?? null;
      const right = pos ? pos.clone().sub(g.camera.position).dot(new pos.constructor(1, 0, 0).applyQuaternion(g.camera.quaternion)) : null;
      window.T.run(120); // 2 s more: on the floor
      let rest = null;
      for (let i = 0; i < 48 && !rest; i++) rest = g.casings.at(i)?.clone() ?? null;
      const floorY = g.player.position.y;
      window.T.run(240); // past the 5 s life
      out[id] = { first, later, right, restDy: rest ? rest.y - floorY : null, gone: g.casings.count };
    }
    return out;
  });
  assert.equal(r.ar01.first, 1, 'AR: case out on the shot frame');
  assert.equal(r.pis01.first, 1);
  assert.equal(r.sg01.first, 0, 'shotgun: the hull comes out with the pump');
  assert.equal(r.sr01.first, 0, 'sniper: the case comes out with the bolt');
  for (const [id, s] of Object.entries(r)) {
    assert.equal(s.later, 1, `${id}: exactly one case per round`);
    // The shotgun model's bolt window is on its left (fit.ejectPort): its hulls go left.
    if (id === 'sg01') assert.ok(s.right < 0, `${id}: thrown to the left of the view (${s.right})`);
    else assert.ok(s.right > 0, `${id}: thrown to the right of the view (${s.right})`);
    assert.ok(s.restDy !== null && Math.abs(s.restDy) < 0.05, `${id}: resting on the floor (dy ${s.restDy})`);
    assert.equal(s.gone, 0, `${id}: removed after its life`);
  }
});

test('cases: a fixed pool (48) under full-auto fire; none at low quality', async () => {
  const r = await page.evaluate(async () => {
    const g = window.game;
    const { MAX_CASES } = await import('/src/fx/ShellCasings.ts');
    await window.T.equip('smg01');
    window.T.face(false);
    const mesh = g.casings.mesh;
    let max = 0;
    // A long burst: real rounds first, then the pool driven directly far past its size.
    g.input.mouseButtons |= 1;
    for (let i = 0; i < 60; i++) window.T.run(1);
    g.input.mouseButtons &= ~1;
    const fromFire = g.casings.count;
    const V = g.player.position.constructor;
    for (let i = 0; i < 200; i++) {
      g.casings.eject('smg', g.camera.position.clone().add(new V(0.2, 0, -0.3)), new V(1.5, 1, 0));
      max = Math.max(max, g.casings.count);
    }
    window.T.run(30);
    max = Math.max(max, g.casings.count);
    const sameMesh = g.casings.mesh === mesh && mesh.count === MAX_CASES;
    g.casings.clear();
    g.qualityLevel = 'low';
    window.T.fire();
    window.T.run(30);
    const low = g.casings.count;
    const light = g.muzzleLight.visible;
    g.qualityLevel = 'high';
    window.T.run(60);
    return { max, fromFire, MAX_CASES, sameMesh, low, light };
  });
  assert.ok(r.fromFire >= 10, `full auto: a case per round (${r.fromFire})`);
  assert.equal(r.max, r.MAX_CASES, 'the pool fills and recycles, never more');
  assert.equal(r.sameMesh, true, 'one instanced mesh, never rebuilt');
  assert.equal(r.low, 0, 'low quality: no cases');
  assert.equal(r.light, false, 'low quality: no world muzzle light');
});

test('impacts: surface by material; sparks only off metal and glass; detail by quality; pooled', async () => {
  const r = await page.evaluate(async () => {
    const g = window.game;
    const { impactClassOf } = await import('/src/fx/ImpactEffects.ts');
    const V = g.player.position.constructor;
    const fx = g.impacts;
    fx.clear();
    const n = new V(0, 0, 1);
    const p = new V(0, 50, 0);
    const counts = {};
    for (const [label, kind, detail] of [
      ['metal-high', 'metal', 'high'],
      ['concrete-high', 'concrete', 'high'],
      ['metal-medium', 'metal', 'medium'],
      ['metal-low', 'metal', 'low'],
    ]) {
      fx.clear();
      fx.detail = detail;
      fx.spawn(p, n, kind, () => 0.5);
      counts[label] = fx.active;
    }
    fx.clear();
    fx.detail = 'high';
    for (let i = 0; i < 2000; i++) fx.spawn(p, n, 'metal');
    const flood = fx.active;
    fx.update(1, g.camera);
    const after = fx.active;
    fx.clear();
    // The map knows what its walls are made of.
    window.T.face(true);
    const o = new V(g.player.position.x, g.player.position.y + 1.4, g.player.position.z);
    const dir = new V(-Math.sin(g.player.yaw), 0, -Math.cos(g.player.yaw));
    const d = g.map.collision.raycast(o, dir, 40);
    const kind = g.map.collision.surfaceAt(o.clone().addScaledVector(dir, d), dir.clone().negate());
    return { counts, flood, after, kind, classes: [impactClassOf('paintedMetal'), impactClassOf('concrete'), impactClassOf(null)] };
  });
  // high: 2 puffs + 10 sparks; concrete: 2 puffs + 5 chips, no sparks; medium: 1 puff + 5 sparks; low: 1 puff only.
  assert.equal(r.counts['metal-high'], 12);
  assert.equal(r.counts['concrete-high'], 7);
  assert.equal(r.counts['metal-medium'], 6);
  assert.equal(r.counts['metal-low'], 1);
  assert.ok(r.flood <= 32 + 64 + 64, `bounded by the pools (${r.flood})`);
  assert.equal(r.after, 0, 'all gone after a second');
  assert.equal(typeof r.kind, 'string', `wall surface resolved (${r.kind})`);
  assert.deepEqual(r.classes, ['metal', 'concrete', 'concrete']);
});

test('a round into a wall leaves one impact with dust and sparks or chips in the air', async () => {
  const r = await page.evaluate(async () => {
    const g = window.game;
    await window.T.equip('ar01');
    const d = window.T.face(true);
    const before = { ...g.impacts.counts };
    window.T.fire();
    const total = (c) => Object.values(c).reduce((a, b) => a + b, 0);
    const wall = total(g.impacts.counts) - total(before);
    const active = g.impacts.active;
    window.T.run(60);
    return { d, wall, active };
  });
  assert.equal(r.wall, 1, 'one impact for the round');
  assert.ok(r.active >= 2, 'dust (and sparks / chips) in the air');
});

test('kill notice: shown with the kill confirm, once per kill; hit marker kinds kept', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const n = g.hud.root.querySelector('.kill-notice');
    const m = g.hud.root.querySelector('.hitmarker');
    let shown = 0;
    const show = g.hud.showKillNotice.bind(g.hud);
    g.hud.showKillNotice = () => {
      shown++;
      show();
    };
    const a = g.killConfirm.confirm('t:bot-9:1');
    const b = g.killConfirm.confirm('t:bot-9:1');
    const anims = n.getAnimations().length;
    g.hud.showHitMarker(true, false);
    const head = [m.classList.contains('head'), m.classList.contains('kill'), m.querySelector('.hm-ring').getAnimations().length];
    g.hud.showHitMarker(false, false);
    const body = [m.classList.contains('head'), m.classList.contains('kill'), m.querySelector('.hm-ring').getAnimations().length];
    g.hud.showHitMarker(false, true);
    const kill = [m.classList.contains('head'), m.classList.contains('kill'), m.querySelector('.hm-ring').getAnimations().length];
    return { a, b, shown, anims, text: n.textContent, head, body, kill };
  });
  assert.deepEqual([r.a, r.b, r.shown], [true, false, 1]);
  assert.equal(r.anims, 1);
  assert.equal(r.text, '처치');
  assert.deepEqual(r.head, [true, false, 1], 'head: red marker with a ring');
  assert.deepEqual(r.body, [false, false, 0], 'body: plain marker, no ring');
  assert.deepEqual(r.kill, [false, true, 1], 'kill: bigger marker with a ring');
});

test('weapon surfaces: cutter leftovers dark, grain on every other part, kept on skinned copies', async () => {
  const r = await page.evaluate(async () => {
    const g = window.game;
    const { WEAPONS } = await import('/src/weapons/weapons.ts');
    const { loadGltfWeaponView } = await import('/src/weapons/view/GltfWeaponView.ts');
    const out = {};
    for (const id of ['ar01', 'sr01', 'smg01', 'pis01', 'sg01']) {
      const v = await loadGltfWeaponView(WEAPONS[id].view.url);
      const cutters = [];
      let plain = 0;
      let grain = 0;
      v.object.traverse((o) => {
        if (!o.isMesh) return;
        if (/cutter|slot/i.test(o.name)) cutters.push(o.material.name + ':' + o.material.color.getHexString());
        else if (o.material.userData.grain) grain++;
        else if (o.material.roughness >= 0.1) plain++;
      });
      out[id] = { cutters, plain, grain };
    }
    const { SkinRenderer } = await import('/src/skins/SkinRenderer.ts');
    const v = await loadGltfWeaponView(WEAPONS.ar01.view.url);
    new SkinRenderer().dressWeapon(v, 'ar01', 'finish:ar01.fde');
    let skinned = 0;
    let skinnedGrain = 0;
    v.object.traverse((o) => {
      if (o.isMesh && o.material.name.includes('@')) {
        skinned++;
        if (o.material.userData.grain && o.material.customProgramCacheKey().startsWith('weapon-grain')) skinnedGrain++;
      }
    });
    return { out, skinned, skinnedGrain };
  });
  assert.equal(r.out.ar01.cutters.length, 6);
  assert.equal(r.out.sr01.cutters.length, 4);
  for (const [id, s] of Object.entries(r.out)) {
    for (const c of s.cutters) assert.equal(c, 'Cavity:0b0b0c', `${id}: cutter shown as a dark cavity`);
    assert.equal(s.plain, 0, `${id}: every part has surface grain`);
    assert.ok(s.grain > 0);
  }
  assert.ok(r.skinned > 0 && r.skinnedGrain === r.skinned, 'skinned copies keep the grain');
});

test('cases and impact effects never go over the network', () => {
  const files = [];
  const walk = (dir) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.ts$/.test(f)) files.push(p);
    }
  };
  walk(join(ROOT, 'src', 'net'));
  walk(join(ROOT, 'server'));
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    assert.ok(!/ShellCasings|ImpactEffects|MuzzleFlash|casings/.test(src), `${f} does not touch cosmetic effects`);
  }
});

test('cases and tracers start on the exact pixel of the port / muzzle drawn on screen (view-model and world FOV differ)', async () => {
  const r = await page.evaluate(async () => {
    const g = window.game;
    const V = g.camera.position.constructor;
    const out = {};
    for (const id of ['ar01', 'smg01', 'pis01', 'sg01', 'sr01']) {
      await window.T.equip(id);
      const vm = g.viewModel;
      vm.scene.updateMatrixWorld();
      const port = vm.inHand.ejectPort.getWorldPosition(new V()).project(vm.camera);
      const muzzle = vm.inHand.muzzle.getWorldPosition(new V()).project(vm.camera);
      const c = new V();
      const t = new V();
      vm.ejectInWorld(g.camera, c);
      vm.muzzleInWorld(g.camera, t);
      g.camera.updateMatrixWorld();
      c.project(g.camera);
      t.project(g.camera);
      out[id] = Math.max(Math.abs(c.x - port.x), Math.abs(c.y - port.y), Math.abs(t.x - muzzle.x), Math.abs(t.y - muzzle.y));
    }
    return { out, fovs: [g.camera.fov, g.viewModel.camera.fov] };
  });
  assert.notEqual(r.fovs[0], r.fovs[1], 'the two cameras really differ in field of view');
  for (const [id, err] of Object.entries(r.out)) assert.ok(err < 0.002, `${id}: off by ${err} (NDC)`);
});
