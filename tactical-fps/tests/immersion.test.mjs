// Combat immersion (Phase 15). Rules in Node: the eye's motion (steps by gait,
// landing by impact speed, breathing, aim steadying, bunny hops), reverb send by
// distance, the sky-visibility bake. Then the real game: the camera moves only in
// position and roll (pitch / yaw stay the aim, rounds unchanged), footsteps /
// landing / spent-case sounds through the existing audio engine, indoor vs
// outdoor reverb, per-weapon weight of the view model, sky light under cover on
// the map only (players, bots and weapons keep full light), HUD readability.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { ROOT, startEnv, openGame, installFrameDriver } from './harness.mjs';

let vite;
let M;
let env;
let page;

before(async () => {
  vite = await createServer({ root: ROOT, logLevel: 'error', server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom' });
  M = {
    ...(await vite.ssrLoadModule('/src/player/CameraMotion.ts')),
    ...(await vite.ssrLoadModule('/src/world/SkyOcclusion.ts')),
    ...(await vite.ssrLoadModule('/src/audio/WeaponAudio.ts')),
    THREE: await vite.ssrLoadModule('three'),
  };
  env = await startEnv();
});
after(async () => {
  await page?.context().close();
  await env?.close();
  await vite?.close();
});

const RUN = 6.5;
/** Peak eye drop / side shift / roll over `seconds` at `speed` m/s (60 fps). */
function gait(speed, { crouching = false, aim = 0, seconds = 2 } = {}) {
  const m = new M.CameraMotion();
  let y = 0;
  let x = 0;
  let roll = 0;
  let steps = 0;
  const ev = { steps: 0, landing: 0 };
  for (let i = 0; i < seconds * 60; i++) {
    m.update(1 / 60, { speed, runSpeed: RUN, vy: 0, grounded: true, crouching, aim });
    if (i > 60) {
      y = Math.min(y, m.y);
      x = Math.max(x, Math.abs(m.x));
      roll = Math.max(roll, Math.abs(m.roll));
    }
    steps += m.takeEvents(ev).steps;
  }
  return { y: -y, x, roll, steps };
}

test('camera motion: run > walk > crouch; small; aiming steadies it; steps counted by distance', () => {
  const run = gait(RUN);
  const walk = gait(RUN * 0.5);
  const crouch = gait(RUN * 0.35, { crouching: true });
  const aimed = gait(RUN, { aim: 1 });
  assert.ok(run.y > walk.y && walk.y > crouch.y, `eye drop run ${run.y} > walk ${walk.y} > crouch ${crouch.y}`);
  assert.ok(run.y <= 0.012 && run.x <= 0.005 && run.roll <= 0.004, `small: ${JSON.stringify(run)}`);
  assert.ok(aimed.y < run.y * 0.35, `aimed ${aimed.y} vs ${run.y}`);
  // 2 s at a run (13 m) with steps of 0.78 m: ~16 steps; a walk (6.5 m, shorter steps) fewer.
  assert.ok(run.steps >= 14 && run.steps <= 19, `run steps ${run.steps}`);
  assert.ok(walk.steps < run.steps && walk.steps >= 8, `walk steps ${walk.steps}`);
});

test('camera motion: still = barely breathing; in the air nothing bobs', () => {
  const m = new M.CameraMotion();
  let peak = 0;
  for (let i = 0; i < 600; i++) {
    m.update(1 / 60, { speed: 0, runSpeed: RUN, vy: 0, grounded: true, crouching: false, aim: 0 });
    peak = Math.max(peak, Math.abs(m.y), Math.abs(m.x), Math.abs(m.roll));
  }
  assert.ok(peak > 0.0005 && peak <= 0.0017, `breathing ${peak}`);
  // Running, then airborne: the bob dies out (no stepping in mid-air).
  for (let i = 0; i < 60; i++) m.update(1 / 60, { speed: RUN, runSpeed: RUN, vy: 0, grounded: true, crouching: false, aim: 0 });
  const ev = { steps: 0, landing: 0 };
  m.takeEvents(ev);
  for (let i = 0; i < 40; i++) m.update(1 / 60, { speed: RUN, runSpeed: RUN, vy: 3 - i * 0.2, grounded: false, crouching: false, aim: 0 });
  assert.equal(m.takeEvents(ev).steps, 0, 'no footsteps in the air');
  assert.ok(Math.abs(m.x) < 0.0012, `side shift fades in the air (${m.x})`);
});

test('camera motion: landing dip by impact speed, capped; a bunny hop counts as a light landing', () => {
  const land = (vy) => {
    const m = new M.CameraMotion();
    const ev = { steps: 0, landing: 0 };
    m.update(1 / 60, { speed: 0, runSpeed: RUN, vy, grounded: false, crouching: false, aim: 0 });
    let low = 0;
    let back = 0;
    for (let i = 0; i < 60; i++) {
      m.update(1 / 60, { speed: 0, runSpeed: RUN, vy: 0, grounded: true, crouching: false, aim: 0 });
      low = Math.min(low, m.y);
      if (i === 40) back = m.y;
    }
    return { dip: -low, back: Math.abs(back), landing: m.takeEvents(ev).landing };
  };
  const hop = land(-4);
  const roof = land(-9);
  const huge = land(-30);
  const soft = land(-1);
  assert.ok(hop.dip > 0.005 && hop.dip < 0.03, `hop dip ${hop.dip}`);
  assert.ok(roof.dip > hop.dip * 1.8, `harder landing dips more (${roof.dip})`);
  assert.ok(huge.dip <= 0.08, `capped (${huge.dip})`);
  assert.equal(soft.dip < 0.002, true, 'a step down is no landing');
  assert.ok(roof.back < 0.006, `back up within ~0.7 s (${roof.back})`);
  assert.equal(hop.landing, 4);
  // Bunny hop: the controller never reports the ground, the fall turns into a climb.
  const m = new M.CameraMotion();
  const ev = { steps: 0, landing: 0 };
  m.update(1 / 60, { speed: RUN, runSpeed: RUN, vy: -4.5, grounded: false, crouching: false, aim: 0 });
  m.update(1 / 60, { speed: RUN, runSpeed: RUN, vy: 4.8, grounded: false, crouching: false, aim: 0 });
  assert.equal(m.takeEvents(ev).landing, 4.5);
});

test('reverb send grows with distance: a close shot is mostly dry', () => {
  const near = M.reverbSend(2);
  const mid = M.reverbSend(30);
  const far = M.reverbSend(150);
  assert.ok(near < mid && mid < far, `${near} < ${mid} < ${far}`);
  assert.ok(near <= 0.2 && far <= 0.7);
});

test('sky visibility bake: open ground sees the sky, under a roof it does not', () => {
  const { THREE } = M;
  // A 10 x 10 m roof 3 m up over the middle of a 40 x 40 m area.
  const ray = (o, d, max) => {
    if (d.y <= 0) return null;
    const t = (3 - o.y) / d.y;
    if (t < 0 || t > max) return null;
    const x = o.x + d.x * t;
    const z = o.z + d.z * t;
    return Math.abs(x) < 5 && Math.abs(z) < 5 ? t : null;
  };
  const grid = M.bakeSkyOcclusion(ray, new THREE.Box3(new THREE.Vector3(-20, 0, -20), new THREE.Vector3(20, 6, 20)), 2);
  assert.ok(M.skyVisibilityAt(grid, new THREE.Vector3(0, 1.5, 0)) < 0.2, 'under the roof');
  assert.equal(M.skyVisibilityAt(grid, new THREE.Vector3(15, 1.5, 15)), 1, 'in the open');
  assert.ok(M.skyVisibilityAt(grid, new THREE.Vector3(0, 5, 0)) === 1, 'on the roof');
  assert.ok(grid.cells <= 48000);
});

test('real game: camera moves in position and roll only; footsteps, landing, spent cases; aim untouched', async () => {
  page = await openGame(env, { mode: 'training', quality: 'medium' });
  await page.click('.play-button');
  await page.waitForFunction(() => window.game.input.active && window.game.audio.state === 'running', null, { timeout: 30000 });
  await page.evaluate(() => window.game.audio.ready);
  await installFrameDriver(page);
  await page.evaluate(() => {
    window.T.stopLoop();
    window.game.combat.protection = 1e9;
    window.T.run(30);
  });
  await page.mouse.move(0, 0);
  const sample = () =>
    page.evaluate(() => {
      const g = window.game;
      const c = g.camera;
      const p = g.player;
      return {
        rotErr: Math.abs(c.rotation.x - p.pitch) + Math.abs(c.rotation.y - p.yaw),
        roll: c.rotation.z,
        dy: c.position.y - (p.position.y + p.eyeHeight),
        steps: g.audio.playCount.step ?? 0,
        land: g.audio.playCount.land ?? 0,
        brass: g.audio.playCount['case.brass'] ?? 0,
      };
    });
  const before = await sample();
  await page.keyboard.down('KeyW');
  let maxRoll = 0;
  let maxDy = 0;
  let rotErr = 0;
  for (let i = 0; i < 12; i++) {
    await page.evaluate(() => window.T.run(10));
    const s = await sample();
    maxRoll = Math.max(maxRoll, Math.abs(s.roll));
    maxDy = Math.max(maxDy, Math.abs(s.dy));
    rotErr = Math.max(rotErr, s.rotErr);
  }
  await page.keyboard.press('Space');
  await page.evaluate(() => window.T.run(90));
  await page.keyboard.up('KeyW');
  await page.evaluate(() => window.T.run(30));
  const ran = await sample();
  assert.equal(rotErr, 0, 'camera pitch / yaw are exactly the aim');
  assert.ok(maxRoll > 0 && maxRoll < 0.005, `slight roll while running (${maxRoll})`);
  assert.ok(maxDy > 0.002 && maxDy < 0.04, `eye moves a little (${maxDy})`);
  assert.ok(ran.steps - before.steps >= 6, `footsteps (${ran.steps - before.steps})`);
  assert.ok(ran.land - before.land >= 1, 'landing sound');
  // The round goes where the player looks, motion or not.
  const shot = await page.evaluate(() => {
    const g = window.game;
    let dir = null;
    const ev = g.weapons.events;
    const prev = ev.onShot;
    ev.onShot = (res, origin, d, ...rest) => {
      dir = dir ?? d.clone();
      prev(res, origin, d, ...rest);
    };
    g.input.mouseButtons |= 1;
    window.T.run(1);
    g.input.mouseButtons &= ~1;
    ev.onShot = prev;
    const cases = g.casings.count;
    const look = new g.camera.position.constructor(0, 0, -1).applyEuler(new g.camera.rotation.constructor(g.player.pitch, g.player.yaw, 0, 'YXZ'));
    window.T.run(90);
    return { dot: dir.dot(look), brass: g.audio.playCount['case.brass'] ?? 0, cases };
  });
  assert.ok(shot.dot > 0.9999, `first round along the look direction (${shot.dot})`);
  assert.ok(shot.brass > ran.brass, `the spent case is heard on the floor ${JSON.stringify(shot)} ${ran.brass}`);
});

test('real game: reverb follows indoor / outdoor; hands dim a little indoors; map-only sky light', async () => {
  const r = await page.evaluate(async () => {
    const g = window.game;
    const { skyVisibilityAt } = await import('/src/world/SkyOcclusion.ts');
    const grid = g.skyGrid;
    const V = g.player.position.constructor;
    const col = g.map.collision;
    const b = g.map.playBounds;
    let indoor = null;
    let outdoor = null;
    for (let k = 0; k < 8000 && !(indoor && outdoor); k++) {
      const x = b.min.x + ((k * 0.6180339) % 1) * (b.max.x - b.min.x);
      const z = b.min.z + ((k * 0.7548776) % 1) * (b.max.z - b.min.z);
      const top = new V(x, b.max.y + 2, z);
      const d = col.raycast(top, new V(0, -1, 0), 200);
      if (d === null) continue;
      // Ground level spot under whatever is above.
      const floor = top.clone();
      floor.y -= d;
      let eye = floor.clone();
      eye.y += 1.6;
      if (!outdoor && col.raycast(eye, new V(0, 1, 0), 30) === null) outdoor = floor.clone();
      const below = floor.clone();
      below.y -= 0.2;
      const d2 = col.raycast(below, new V(0, -1, 0), 30);
      if (d2 !== null && !indoor) {
        const f2 = below.clone();
        f2.y -= d2;
        eye = f2.clone();
        eye.y += 1.6;
        const head = col.raycast(eye, new V(0, 1, 0), 30);
        // A room at ground level with headroom under a real ceiling (covering the spot all round:
        // not a pipe or a beam overhead, not a rack shelf).
        const ceiling = [[0.6, 0], [-0.6, 0], [0, 0.6], [0, -0.6]].every(([dx, dz]) => {
          const h = col.raycast(new V(eye.x + dx, eye.y, eye.z + dz), new V(0, 1, 0), 30);
          return h !== null && h < 6;
        });
        if (head !== null && head > 1.4 && head < 6 && ceiling && Math.abs(f2.y) < 0.3 && skyVisibilityAt(grid, eye) < 0.2) indoor = f2;
      }
    }
    const at = async (p) => {
      g.player.position.copy(p);
      g.player.position.y += 0.05;
      g.player.velocity.set(0, 0, 0);
      window.T.run(80);
      return { space: g.audio.space, fill: g.viewModel.fill.intensity };
    };
    const inside = indoor ? await at(indoor) : null;
    const outside = outdoor ? await at(outdoor) : null;
    // Map materials carry the sky term; bots / players / the view model do not.
    let mapPatched = 0;
    g.map.root.traverse((o) => {
      if (o.isMesh && o.material?.customProgramCacheKey?.().startsWith('surface-v4')) mapPatched++;
    });
    let vmPatched = 0;
    g.viewModel.scene.traverse((o) => {
      if (o.isMesh && String(o.material?.customProgramCacheKey?.()).startsWith('surface')) vmPatched++;
    });
    return { inside, outside, cells: grid.cells, ms: grid.ms, mapPatched, vmPatched, at: indoor?.toArray(), now: g.player.position.toArray() };
  });
  assert.ok(r.inside && r.outside, 'found an indoor and an outdoor spot');
  assert.ok(r.inside.space > 0.5, `indoors: room reverb (${r.inside.space}) at ${r.at}`);
  assert.ok(r.outside.space < 0.35, `outdoors: open reverb (${r.outside.space})`);
  assert.ok(r.inside.fill < r.outside.fill && r.inside.fill >= 1.6 * 0.75 - 1e-6, `hands dim a little indoors (${r.inside.fill} / ${r.outside.fill})`);
  assert.ok(r.mapPatched > 0 && r.vmPatched === 0);
  assert.ok(r.ms < 2000, `bake time ${r.ms} ms`);
});

test('real game: weapon weight — a sniper rifle lags behind the view more than a pistol', async () => {
  const r = await page.evaluate(async () => {
    const g = window.game;
    const { WEAPON_WEIGHT } = await import('/src/weapons/view/ViewModelLayer.ts');
    const vm = g.viewModel;
    const lag = (category) => {
      vm.shownCategory = category;
      vm.resetMotion();
      const anim = { category, equip: 1, reload: null, sinceShot: Infinity, fireInterval: 1, inspect: null };
      const m = { lookYaw: 0.02, lookPitch: 0, speed01: 0, grounded: true, crouching: false };
      vm.update(1 / 60, m, anim);
      return Math.abs(vm.pivot.position.x - vm.restPosition.x);
    };
    return { sniper: lag('sniper'), pistol: lag('pistol'), rifle: lag('rifle'), w: WEAPON_WEIGHT };
  });
  // One frame of the same turn: the light pistol is already following, the heavy rifle still catching up
  // (the pistol's target is smaller too, but it closes on it much faster).
  assert.ok(r.w.sniper.follow < r.w.rifle.follow && r.w.rifle.follow < r.w.pistol.follow);
  assert.ok(r.w.shotgun.land > r.w.rifle.land && r.w.smg.land < r.w.rifle.land);
  assert.ok(r.sniper > 0 && r.pistol > 0);
});

test('HUD: health loss trails then drains, healing at once; magazine bar', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const h = g.hud;
    h.setHealth(100);
    h.setHealth(60);
    const lag = h.root.querySelector('.health-lag');
    const bar = h.root.querySelector('.health-bar');
    const hurt = [bar.style.transform, lag.style.transform, getComputedStyle(lag).transitionDelay];
    h.setHealth(100);
    const healed = [lag.style.transform, lag.style.transition];
    h.setWeapon('AR-01', 15, 30, 60, null);
    const mag = h.root.querySelector('.mag-bar').style.transform;
    h.setWeapon('M9 BAYONET', null, 0, 0, null);
    const melee = h.root.querySelector('.mag-bar').style.transform;
    return { hurt, healed, mag, melee };
  });
  assert.deepEqual(r.hurt.slice(0, 2), ['scaleX(0.6)', 'scaleX(0.6)']);
  assert.equal(r.hurt[2], '0.35s', 'the lost part stays a moment before draining');
  assert.deepEqual(r.healed, ['scaleX(1)', 'none'], 'healing shows at once');
  assert.equal(r.mag, 'scaleX(0.5)');
  assert.equal(r.melee, 'scaleX(0)');
});
