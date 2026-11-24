// Phase 33 — the lean as a body moves: it speeds up from rest and brakes onto the side held (time based, the same
// at any frame rate); a switch to the other side turns over at speed through upright (no stop there); quick
// alternating input never tangles it; both keys / buttons held → the one pressed last; a wall cuts it at once and
// lets it out again smoothly; the weapon stays square to the sights when aimed and through a reload or a switch;
// in third person the hips shift that way and the drawn head lands over the hit capsule's leaned top. Presentation and input only: the eye offset, roll, wall margin, hit
// capsule and the network (combat-controls.test.mjs) are as before.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, openGame, installFrameDriver } from './harness.mjs';

let env;
let page;
before(async () => {
  env = await startEnv();
  page = await openGame(env, { width: 640, height: 360, quality: 'low', mode: 'deathmatch', seed: 4 });
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

/** Runs the player's lean toward `want` for `seconds` at `fps`, returns the lean before the wall limit per step. */
const leanRun = (page, steps) =>
  page.evaluate((steps) => {
    const p = window.game.player;
    p.updateLean(0, 10);
    const out = [];
    for (const [want, seconds, fps] of steps) {
      const n = Math.round(seconds * fps);
      for (let i = 0; i < n; i++) {
        p.updateLean(want, 1 / fps);
        out.push([+(i / fps + 1 / fps).toFixed(4), p['leanWant'], p['leanVel']]);
      }
    }
    p.updateLean(0, 10);
    return out;
  }, steps);

test('1. into a lean: speeds up from rest, brakes onto the side held, exactly there by 0.2 s; the same at 30, 60 and 144 frames a second', async () => {
  const at60 = await leanRun(page, [[1, 0.25, 60]]);
  const v = at60.map((s) => s[1]);
  const step = v.map((x, i) => x - (v[i - 1] ?? 0));
  assert.ok(step[1] > step[0] && step[2] > step[1], `speeds up (${step.slice(0, 4).map((x) => x.toFixed(3))})`);
  const full = v.findIndex((x) => x === 1);
  assert.ok(full > 0 && full <= 12, `there by 0.2 s (frame ${full + 1})`);
  assert.ok(step[full - 1] < step[Math.floor(full / 2)], 'brakes onto the side held');
  for (let i = 1; i < v.length; i++) assert.ok(v[i] >= v[i - 1] && v[i] <= 1, 'never past it, never back');
  // Frame-rate independence: the lean 1/6 s in (a whole number of frames at 30 / 60 / 144 fps).
  const at = async (fps) => (await leanRun(page, [[1, 1 / 6, fps]])).at(-1)[1];
  const [a30, a60, a144] = [await at(30), await at(60), await at(144)];
  assert.ok(Math.abs(a30 - a144) < 0.02 && Math.abs(a60 - a144) < 0.02, `same at any frame rate (${a30.toFixed(3)} / ${a60.toFixed(3)} / ${a144.toFixed(3)})`);
});

test('2. a switch from one side to the other turns over through upright at speed (no stop there) and settles on the other side; letting go returns upright the same way', async () => {
  const s = await leanRun(page, [[1, 0.3, 60], [-1, 0.45, 60], [0, 0.3, 60]]);
  const sw = s.slice(18, 18 + 27);
  // Where it crosses upright, it is moving fast (over half the top speed).
  const cross = sw.findIndex((x, i) => i > 0 && sw[i - 1][1] > 0 && x[1] <= 0);
  assert.ok(cross > 0, 'crosses upright');
  assert.ok(Math.abs(sw[cross][2]) > 0.5 * 9, `at speed through upright (${sw[cross][2].toFixed(2)} leans/s)`);
  // No frame without motion until it arrives.
  const arrive = sw.findIndex((x) => x[1] === -1);
  assert.ok(arrive > 0 && arrive <= 21, `on the other side within 0.35 s (frame ${arrive + 1})`);
  for (let i = 1; i < arrive; i++) assert.ok(sw[i][1] < sw[i - 1][1], `never stops on the way (frame ${i})`);
  const back = s.slice(45);
  assert.equal(back.at(-1)[1], 0, 'upright again when let go');
  for (let i = 1; i < back.length; i++) assert.ok(back[i][1] >= back[i - 1][1] && back[i][1] <= 0, 'straight back, never past upright');
});

test('3. quick alternating input (every 2 to 3 frames for 3 s, at 60 and 144 fps) never tangles the lean: always within ±1, finite, within its top speed; it settles when held', async () => {
  const r = await page.evaluate(() => {
    const p = window.game.player;
    const out = {};
    for (const fps of [60, 144]) {
      p.updateLean(0, 10);
      let worst = 0;
      let fast = 0;
      let bad = false;
      for (let i = 0; i < 3 * fps; i++) {
        const want = Math.floor(i / (fps === 60 ? 2 : 7)) % 3 === 0 ? -1 : Math.floor(i / 3) % 2 ? 1 : 0;
        p.updateLean(want, 1 / fps);
        const l = p['leanWant'];
        if (!Number.isFinite(l) || !Number.isFinite(p.lean)) bad = true;
        worst = Math.max(worst, Math.abs(l), Math.abs(p.lean));
        fast = Math.max(fast, Math.abs(p['leanVel']));
      }
      for (let i = 0; i < fps; i++) p.updateLean(1, 1 / fps);
      out[fps] = { worst, fast, bad, settled: [p['leanWant'], p['leanVel']] };
    }
    p.updateLean(0, 10);
    return out;
  });
  for (const fps of [60, 144]) {
    const x = r[fps];
    assert.equal(x.bad, false);
    assert.ok(x.worst <= 1, `${fps} fps: within ±1 (${x.worst})`);
    assert.ok(x.fast <= 9 + 1e-9, `${fps} fps: within its top speed (${x.fast})`);
    assert.deepEqual(x.settled, [1, 0], `${fps} fps: settles on the side held`);
  }
});

test('4. both lean keys (or both ◀ ▶ buttons) held: the one pressed last wins — no cancelled 0 that drops back upright — and letting it go returns to the other', async () => {
  // The keyboard, as the game polls it.
  const keys = [];
  const read = () => page.evaluate(() => {
    const out = {};
    window.game.input.poll(out);
    return out.lean;
  });
  await page.keyboard.down('KeyE');
  keys.push(await read());
  await page.keyboard.down('KeyQ');
  keys.push(await read());
  await page.keyboard.up('KeyQ');
  keys.push(await read());
  await page.keyboard.down('KeyQ');
  keys.push(await read());
  await page.keyboard.up('KeyE');
  keys.push(await read());
  await page.keyboard.up('KeyQ');
  keys.push(await read());
  assert.deepEqual(keys, [1, -1, 1, -1, -1, 0]);
  // The same rule for the touch buttons (TouchInput uses this same LeanIntent).
  const touch = await page.evaluate(async () => {
    const { LeanIntent } = await import('/src/input/LeanIntent.ts');
    const t = new LeanIntent();
    return [t.resolve(true, false), t.resolve(true, true), t.resolve(false, true), t.resolve(true, true), t.resolve(true, true), t.resolve(false, false), t.resolve(true, true)];
  });
  // left; right pressed → right; left let go → right; left pressed again → left; still both → left; none → 0;
  // both pressed on the same frame → right (a tie: the default side).
  assert.deepEqual(touch, [-1, 1, 1, -1, -1, 0, 1]);
});

test('5. a wall at that side cuts the lean at once (no peeking past it); stepping out from it, the lean grows back smoothly instead of jumping out', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const p = g.player;
    const V = p.position.constructor;
    const coll = g.map.collision;
    // A spot with a wall 0.45 m to the right of the eye and open space 1.5 m behind it along the wall.
    for (const sp of [...g.map.attackSpawns, ...g.map.defenseSpawns]) {
      for (let k = 0; k < 16; k++) {
        const yaw = (k / 16) * Math.PI * 2;
        const right = new V(Math.cos(yaw), 0, -Math.sin(yaw));
        const eye = new V(sp.position.x, sp.position.y + p.eyeHeight, sp.position.z);
        const wall = coll.raycast(eye, right, 3);
        if (wall === null || wall < 0.6 || wall > 2.5) continue;
        const at = eye.clone().addScaledVector(right, wall - 0.45);
        const back = new V(Math.sin(yaw), 0, Math.cos(yaw));
        if (coll.raycast(at, back, 1.6) !== null) continue;
        // Does the wall end within 1.5 m behind? (open to the right from there)
        let open = null;
        for (let d = 0.2; d <= 1.5; d += 0.1) {
          const q = at.clone().addScaledVector(back, d);
          if (coll.raycast(q, right, 1) === null) {
            open = d + 0.2;
            break;
          }
        }
        if (open === null) continue;
        p.teleport(new V(at.x, sp.position.y, at.z), yaw);
        p.updateLean(0, 10);
        const leans = [];
        for (let i = 0; i < 30; i++) {
          p.updateLean(1, 1 / 60);
          leans.push(p.lean);
        }
        const blocked = Math.max(...leans);
        // Step back past the wall's end and keep leaning: the room opens.
        p.position.addScaledVector(back, open);
        const after = [];
        for (let i = 0; i < 40; i++) {
          p.updateLean(1, 1 / 60);
          after.push(p.lean);
        }
        const steps = after.map((x, i) => x - (i ? after[i - 1] : leans.at(-1)));
        p.updateLean(0, 10);
        return { blocked, start: leans.at(-1), end: after.at(-1), biggest: Math.max(...steps), wall: wall - 0.45 };
      }
    }
    return { error: 'no wall found' };
  });
  assert.ok(!r.error, r.error);
  // The eye stands 0.45 m from the wall: the lean stops 0.25 m short of it (LEAN_CONFIG.wallMargin).
  const room = (r.wall - 0.25) / 0.38;
  assert.ok(r.blocked <= room + 0.01 && r.blocked < 0.9, `cut by the wall (${r.blocked.toFixed(3)} of a full lean, room for ${room.toFixed(3)})`);
  assert.equal(r.end, 1, 'out in the open: a full lean');
  assert.ok(r.biggest <= 6 / 60 + 1e-6, `no jump out from the wall (${r.biggest.toFixed(3)} per frame at most)`);
});

test('6. the weapon: the lean cant fades out as the sights come up (square to the sights); a reload and a switch while leaning keep the lean; the pose comes back to rest', async () => {
  const r = await page.evaluate(async () => {
    const { WEAPONS } = await import('/src/weapons/weapons.ts');
    const g = window.game;
    g.weapons.setLoadout([WEAPONS.ar01, WEAPONS.pis02, WEAPONS.karambit], 0);
    g.showWeaponModel(g.weapons.weapon.def);
    for (let i = 0; i < 400 && (!g.viewModel.currentView || g.viewModel['incoming']); i++) {
      await new Promise((res) => setTimeout(res, 10));
      window.T.run(2);
    }
    window.T.run(60);
    const vm = g.viewModel;
    const pivot = vm['pivot'];
    const anim = (o = {}) => ({ category: 'rifle', equip: 1, reload: null, sinceShot: Infinity, fireInterval: 0.1, inspect: null, ...o });
    const m = (lean, aim) => ({ lookYaw: 0, lookPitch: 0, speed01: 0, grounded: true, crouching: false, aim, lean });
    const settle = (lean, aim, o, n = 90) => {
      for (let i = 0; i < n; i++) vm.update(1 / 60, m(lean, aim), anim(o));
      return pivot.rotation.z;
    };
    const rest = settle(0, 0);
    const hip = settle(1, 0) - rest;
    const aimed = settle(1, 1) - settle(0, 1);
    // A reload half way while leaning: finite, and the lean still shows (cant on top of the reload roll).
    const reloadLean = settle(1, 0, { reload: 0.5 }, 1);
    const reloadUpright = settle(0, 0, { reload: 0.5 }, 90);
    settle(1, 0, { reload: 0.5 }, 90);
    const reloadLeaning = pivot.rotation.z;
    // A draw while leaning.
    const draw = settle(1, 0, { equip: 0.5 }, 1);
    const back = settle(0, 0, {}, 120);
    return { hip, aimed, reloadDiff: reloadLeaning - reloadUpright, finite: [reloadLean, draw].every(Number.isFinite), back: back - rest };
  });
  assert.ok(r.hip < -0.04, `from the hip the weapon cants into the lean (${r.hip.toFixed(3)} rad)`);
  assert.ok(Math.abs(r.aimed) < Math.abs(r.hip) * 0.3, `aimed it stays square to the sights (${r.aimed.toFixed(4)} rad)`);
  assert.ok(r.reloadDiff < -0.04, `the lean still shows through a reload (${r.reloadDiff.toFixed(3)})`);
  assert.equal(r.finite, true);
  assert.ok(Math.abs(r.back) < 1e-3, 'back to rest after');
});

test('7. third person: the upper body leans each way, symmetric; the hips shift that way a little (weight onto that leg); the drawn head ends up over the hit capsule\'s leaned top', async () => {
  const r = await page.evaluate(async () => {
    const { BotModel, BotKit, LEAN_HIP_SHIFT } = await import('/src/ai/BotModel.ts');
    const { LEAN_CONFIG } = await import('/src/config.ts');
    const V = window.game.player.position.constructor;
    const kit = new BotKit('blue');
    const m = new BotModel(kit);
    const pose = (lean) => ({ feet: new V(0, 0, 0), yaw: 0, pitch: 0, velocity: new V(), grounded: true, aiming: true, alive: true, deadTime: 0, lean });
    const at = (lean) => {
      for (let i = 0; i < 60; i++) m.update(1 / 60, pose(lean));
      m.object.updateMatrixWorld(true);
      const hips = m['lower'].pelvis.getWorldPosition(new V()).x;
      // The head: the highest mesh of the upper body.
      let top = null;
      m['spine'].traverse((o) => {
        if (!o.isMesh) return;
        o.geometry.computeBoundingBox();
        const c = o.geometry.boundingBox.getCenter(new V());
        o.localToWorld(c);
        if (!top || c.y > top.y) top = c;
      });
      return { hips, head: top.x };
    };
    const up = at(0);
    const right = at(1);
    const left = at(-1);
    m.dispose();
    kit.dispose();
    return { up, right, left, shift: LEAN_HIP_SHIFT, offset: LEAN_CONFIG.offset };
  });
  assert.ok(r.right.head - r.up.head > 0.25 && r.up.head - r.left.head > 0.25, `the head goes each way (${(r.right.head - r.up.head).toFixed(2)} / ${(r.up.head - r.left.head).toFixed(2)} m)`);
  assert.ok(Math.abs(r.right.head - r.up.head - (r.up.head - r.left.head)) < 0.01, 'symmetric');
  assert.ok(Math.abs(r.right.hips - r.up.hips - r.shift) < 0.005 && Math.abs(r.left.hips - r.up.hips + r.shift) < 0.005, `the hips shift that way (${(r.right.hips - r.up.hips).toFixed(3)})`);
  assert.ok(Math.abs(r.right.head - r.up.head - r.offset) < 0.06, `the head lands near the hit capsule's leaned top (${(r.right.head - r.up.head).toFixed(2)} vs ${r.offset} m)`);
  assert.deepEqual(page.errors, []);
});
