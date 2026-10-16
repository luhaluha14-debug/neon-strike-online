// Training targets (src/combat/TrainingTarget.ts, TrainingRange.ts).
//
//   - placement: both maps get at least 3 dummies (incl. the moving one), each
//     checked here independently against the map's collision: on the floor,
//     free standing room, visible from the spawn. A slot that cannot be placed
//     fails the test with its reason; nothing is skipped silently.
//   - what is drawn is what is hit: three.js's own raycast against the
//     rendered mesh (scene matrices) and the target's hit test give the same
//     result ray by ray, while standing, swaying, falling, lying, rising and
//     moving; and the drawn vertices lie on the body-part shapes,
//   - damage goes through the game's own HitscanSystem and computeDamage,
//     shots-to-kill per weapon / zone, the fall / down / rise cycle,
//   - moving target determinism, reset on respawn, unregister + GPU disposal
//     on map switch,
//   - real mouse-button input: hit marker, body / head confirm sounds, no
//     bullet-hole decals on dummies, F3 last-hit line.
// Aim is set programmatically (view yaw / pitch); the trigger is the real mouse.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, openGame, installFrameDriver, LOAD_TIMEOUT } from './harness.mjs';

let env;
let page;
before(async () => {
  env = await startEnv();
  page = await openGame(env, { map: 'warehouse' });
});
after(async () => {
  await page?.context().close();
  await env?.close();
});

/** Independent placement checks (collision queries made here, not by TrainingRange). */
const placementReport = (p) =>
  p.evaluate(async () => {
    const g = window.game;
    const R = g.trainingRange;
    const V = g.player.position.constructor;
    const { TARGET_SLOTS, TrainingRange } = await import('/src/combat/TrainingRange.ts');
    const { PLAYER_CONFIG } = await import('/src/config.ts');
    const spawns = g.map.attackSpawns;
    const spawn = spawns[Math.floor(spawns.length / 2)];
    const eye = spawn.position.clone();
    eye.y += PLAYER_CONFIG.standHeight - PLAYER_CONFIG.eyeOffsetFromTop;
    const col = g.map.collision;
    const pb = g.map.playBounds;
    const Line3 = (await import('/node_modules/three/build/three.module.js')).Line3;
    const line = new Line3();
    const checks = R.targets.map((t) => {
      const out = { id: t.id, moving: t.motion.sweep > 0 };
      const offsets = out.moving ? [-t.motion.sweep, 0, t.motion.sweep] : [0];
      const right = new V(Math.cos(t.object.rotation.y), 0, -Math.sin(t.object.rotation.y));
      out.problems = [];
      for (const o of offsets) {
        const b = t.base.clone().addScaledVector(right, o);
        const down = col.raycast(new V(b.x, b.y + 0.5, b.z), new V(0, -1, 0), 1, undefined, true);
        if (down === null || Math.abs(down - 0.5) > 0.05) out.problems.push(`not on the floor at ${o} (${down})`);
        line.start.set(b.x, b.y + 0.45, b.z);
        line.end.set(b.x, b.y + 1.45, b.z);
        if (col.capsuleOverlaps(line, 0.3)) out.problems.push(`overlaps the map at ${o}`);
        if (b.x < pb.min.x || b.x > pb.max.x || b.z < pb.min.z || b.z > pb.max.z) out.problems.push('outside the play area');
        for (const h of [1.66, 1.2]) {
          const aim = new V(b.x, b.y + h, b.z);
          const d = aim.clone().sub(eye);
          const len = d.length();
          if (col.raycast(eye, d.normalize(), len - 0.3) !== null) out.problems.push(`not visible at height ${h} (${o})`);
        }
      }
      return out;
    });
    // Same inputs, same layout.
    const again = new TrainingRange(g.map, spawn, { register() {}, unregister() {} });
    const sameLayout = JSON.stringify(again.targets.map((t) => t.base.toArray())) === JSON.stringify(R.targets.map((t) => t.base.toArray()));
    again.dispose();
    return {
      slots: TARGET_SLOTS.length,
      placement: R.placement,
      checks,
      sameLayout,
      registered: [...g.hitscan.targets].filter((t) => t.team === 'training').length,
      ids: R.targets.map((t) => t.id),
    };
  });

function assertPlacement(r, map) {
  const failed = r.placement.filter((s) => !s.placed).map((s) => `slot ${s.slot + 1}: ${s.reason}`);
  const placed = r.placement.filter((s) => s.placed).length;
  assert.ok(placed >= 3, `${map}: only ${placed} targets placed (${failed.join('; ')})`);
  assert.ok(r.checks.some((c) => c.moving), `${map}: the moving target was not placed (${failed.join('; ')})`);
  assert.equal(r.checks.length, placed);
  assert.equal(r.registered, placed, `${map}: every placed target is registered with the hitscan`);
  assert.equal(new Set(r.ids).size, r.ids.length);
  for (const c of r.checks) assert.deepEqual(c.problems, [], `${map}: ${c.id}`);
  assert.equal(r.sameLayout, true, `${map}: placement is deterministic`);
  // Report what was not placed even when 3+ were (visible in the test output).
  if (failed.length) console.log(`[${map}] not placed: ${failed.join('; ')}`);
}

test('warehouse: at least 3 targets (incl. the moving one) placed on the floor, free, visible from the spawn', async () => {
  assertPlacement(await placementReport(page), 'warehouse');
});

test('visible mesh and hit shapes agree while standing, swaying, falling, lying, rising and moving', async () => {
  const r = await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const { PARTS, buildDummyGeometry, partOfVertex } = await import('/src/combat/TrainingTarget.ts');
    const g = window.game;
    const ranges = buildDummyGeometry().ranges;
    const targets = g.trainingRange.targets;
    const still = targets.find((t) => t.motion.sweep === 0);
    const mover = targets.find((t) => t.motion.sweep > 0);
    const raycaster = new THREE.Raycaster();
    const results = {};

    /** Grid of parallel rays through the target's bounds from one direction; mesh vs hit shapes. */
    const compare = (t, dirLocal) => {
      t.object.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(t.mesh, true).expandByScalar(0.05);
      const center = box.getCenter(new THREE.Vector3());
      const radius = box.getSize(new THREE.Vector3()).length() / 2;
      const dir = new THREE.Vector3(...dirLocal).normalize().applyQuaternion(t.object.quaternion);
      const u = new THREE.Vector3().crossVectors(dir, Math.abs(dir.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)).normalize();
      const w = new THREE.Vector3().crossVectors(dir, u).normalize();
      const N = 64;
      // Grid spans the target's bounds as seen from this direction.
      const span = { u: [Infinity, -Infinity], w: [Infinity, -Infinity] };
      for (let k = 0; k < 8; k++) {
        const c = new THREE.Vector3(k & 1 ? box.max.x : box.min.x, k & 2 ? box.max.y : box.min.y, k & 4 ? box.max.z : box.min.z).sub(center);
        span.u = [Math.min(span.u[0], c.dot(u)), Math.max(span.u[1], c.dot(u))];
        span.w = [Math.min(span.w[0], c.dot(w)), Math.max(span.w[1], c.dot(w))];
      }
      let rays = 0, either = 0, mismatch = 0, zoneMismatch = 0;
      const depth = [];
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
          const o = center
            .clone()
            .addScaledVector(dir, -3 - radius)
            .addScaledVector(u, span.u[0] + ((i + 0.5) / N) * (span.u[1] - span.u[0]))
            .addScaledVector(w, span.w[0] + ((j + 0.5) / N) * (span.w[1] - span.w[0]));
          raycaster.set(o, dir);
          const m = raycaster.intersectObject(t.mesh, false)[0];
          const h = t.raycast(raycaster.ray, 100);
          rays++;
          if (!m && !h) continue;
          either++;
          if (!m || !h) {
            mismatch++;
            continue;
          }
          const dd = Math.abs(m.distance - h.distance);
          depth.push(dd);
          if (dd > 0.001) mismatch++;
          if (PARTS[partOfVertex(ranges, m.face.a)].zone !== h.zone) zoneMismatch++;
        }
      }
      depth.sort((a, b) => a - b);
      return { rays, either, mismatch, zoneMismatch, medianMm: depth[depth.length >> 1] * 1000, maxMm: depth[depth.length - 1] * 1000 };
    };
    /**
     * Every mesh vertex, placed by the renderer's own matrices (scene.updateMatrixWorld as
     * in render()), then mapped through the matrix the hit test uses: distance (mm) from
     * the hit shape of its part. 0 = the drawn surface is the hit surface.
     */
    const surfaceError = (t) => {
      g.scene.updateMatrixWorld();
      const pos = t.mesh.geometry.getAttribute('position');
      const p = new THREE.Vector3();
      const q = new THREE.Vector3();
      const seg = new THREE.Line3();
      let max = 0;
      ranges.forEach(([start, n], k) => {
        const sh = PARTS[k].shape;
        for (let i = start; i < start + n; i++) {
          p.fromBufferAttribute(pos, i).applyMatrix4(t.mesh.matrixWorld).applyMatrix4(t.inverse);
          let d;
          if (sh.kind === 'sphere') d = p.distanceTo(sh.center) - sh.radius;
          else if (sh.kind === 'capsule') {
            seg.set(sh.a, sh.b);
            d = p.distanceTo(seg.closestPointToPoint(p, true, q)) - sh.radius;
          } else {
            const c = sh.box.getCenter(new THREE.Vector3());
            const h = sh.box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
            const o = new THREE.Vector3(Math.abs(p.x - c.x) - h.x, Math.abs(p.y - c.y) - h.y, Math.abs(p.z - c.z) - h.z);
            d = new THREE.Vector3(Math.max(o.x, 0), Math.max(o.y, 0), Math.max(o.z, 0)).length() + Math.min(Math.max(o.x, o.y, o.z), 0);
          }
          max = Math.max(max, Math.abs(d));
        }
      });
      return max * 1000;
    };
    const run = (name, t) => {
      results[`${name}/surfaceErrorMm`] = surfaceError(t);
      for (const [dn, d] of [['front', [0, 0, 1]], ['side', [1, 0, 0]], ['above', [0.3, -0.8, 0.5]], ['back', [-0.2, 0.1, -1]]]) {
        // Rays travel towards the target: from +Z (front) means direction -Z.
        results[`${name}/${dn}`] = compare(t, d.map((x) => -x));
      }
    };
    const V = g.player.position.constructor;
    const hit = (t, amount) => {
      const p = t.base.clone();
      t.applyDamage({ amount, zone: 'body', sourceId: 't', weaponId: 't', point: p, direction: new V(0, 0, -1).applyQuaternion(t.object.quaternion), distance: 5 });
    };
    g.loop.stop();
    still.reset();
    run('standing', still);
    hit(still, 60);
    for (let i = 0; i < 6; i++) still.step(1 / 120);
    results.swayRad = still.pivot.rotation.x;
    run('swaying', still);
    hit(still, 100);
    for (let i = 0; i < 21; i++) still.step(1 / 120);
    results.fallState = [still.state, still.fallAngle];
    run('falling', still);
    for (let i = 0; i < 60; i++) still.step(1 / 120);
    results.downState = [still.state, still.fallAngle];
    run('down', still);
    // Down since tick 42 of the fall; 360 ticks down in total, then 30 into the rise.
    for (let i = 0; i < 360 - 39 + 30; i++) still.step(1 / 120);
    results.riseState = [still.state, still.fallAngle];
    run('rising', still);
    still.reset();
    mover.reset();
    for (let i = 0; i < 160; i++) mover.step(1 / 120);
    results.moverOffset = mover.trackOffset;
    run('moving', mover);
    mover.reset();
    return results;
  });
  assert.ok(Math.abs(r.swayRad) > 0.01, 'a hit visibly sways the dummy');
  assert.equal(r.fallState[0], 'falling');
  assert.ok(r.fallState[1] < -0.3 && r.fallState[1] > -1.4, `mid-fall angle ${r.fallState[1]}`);
  assert.deepEqual(r.downState, ['down', -Math.PI / 2]);
  assert.equal(r.riseState[0], 'rising');
  assert.ok(Math.abs(r.moverOffset) > 0.5, 'moving target has moved');
  for (const [k, s] of Object.entries(r)) {
    if (!s || typeof s.rays !== 'number') continue;
    assert.ok(s.either > 150, `${k}: target barely covered by the ray grid (${s.either})`);
    // Same triangles, same matrices: only floating-point ties exactly on a triangle edge may differ.
    assert.ok(s.mismatch / s.either <= 0.001, `${k}: ${s.mismatch}/${s.either} rays disagree (hit vs miss, or > 1 mm apart)`);
    assert.ok(s.zoneMismatch / s.either <= 0.001, `${k}: ${s.zoneMismatch}/${s.either} rays disagree on the zone`);
    assert.ok(s.medianMm <= 0.01, `${k}: median depth difference ${s.medianMm.toFixed(4)} mm`);
  }
  const surface = Object.entries(r).filter(([k]) => k.endsWith('/surfaceErrorMm'));
  assert.equal(surface.length, 6);
  for (const [k, mm] of surface) assert.ok(mm <= 0.1, `${k}: drawn surface ${mm.toFixed(3)} mm off the hit shape`);
  console.log('[mesh vs hit shapes]', JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, s]) => [k, typeof s === 'object' && s && 'rays' in s ? `${s.mismatch}/${s.either} disagree, zone ${s.zoneMismatch}, max ${s.maxMm.toFixed(4)} mm` : s]))));
});

/** Shoots target `index` with the game's own hitscan from `range` m in front of it, at a part centre. */
const SHOOT = () => {
  window.shootTarget = async (t, weaponId, part, range) => {
    const g = window.game;
    const { PARTS } = await import('/src/combat/TrainingTarget.ts');
    const { computeDamage } = await import('/src/combat/HitscanSystem.ts');
    const V = g.player.position.constructor;
    const s = PARTS.find((p) => p.name === part).shape;
    const local = s.kind === 'sphere' ? s.center.clone() : s.kind === 'box' ? s.box.getCenter(new V()) : s.a.clone().add(s.b).multiplyScalar(0.5);
    const aim = new V(local.x, local.y, local.z).applyMatrix4(t.pivot.matrixWorld);
    const front = new V(0, 0, 1).applyQuaternion(t.object.quaternion);
    const origin = aim.clone().addScaledVector(front, range);
    const dir = aim.clone().sub(origin).normalize();
    const w = g.weapons.loadout.find((x) => x.def.id === weaponId).def;
    const before = t.health;
    const blocked = g.map.collision.raycast(origin, dir, range) !== null;
    const res = g.hitscan.fire({ origin, direction: dir, damage: w.damage, sourceId: 'local', weaponId });
    return {
      blocked,
      kind: res.kind,
      id: res.target?.id,
      zone: res.zone,
      damage: res.damage,
      expected: res.zone ? computeDamage(w.damage, res.zone, res.distance) : null,
      healthDrop: before - t.health,
      alive: t.alive,
    };
  };
};

test('damage goes through the existing hitscan and computeDamage, per weapon and zone', async () => {
  await page.evaluate(SHOOT);
  const r = await page.evaluate(async () => {
    const g = window.game;
    const t = g.trainingRange.targets.find((x) => x.motion.sweep === 0);
    const out = [];
    for (const [weaponId, range] of [['ar01', 8], ['sr01', 8], ['karambit', 1.5]]) {
      for (const [part, zone] of [['head', 'head'], ['torso', 'body'], ['pelvis', 'body'], ['thigh.l', 'limb'], ['upperArm.r', 'limb']]) {
        t.reset();
        out.push({ weaponId, part, want: zone, ...(await window.shootTarget(t, weaponId, part, range)), target: t.id });
      }
    }
    t.reset();
    return out;
  });
  for (const s of r) {
    const what = `${s.weaponId} → ${s.part}`;
    assert.equal(s.blocked, false, `${what}: line of fire blocked by the map`);
    assert.equal(s.kind, 'target', what);
    assert.equal(s.id, s.target, what);
    assert.equal(s.zone, s.want, what);
    assert.equal(s.damage, s.expected, what);
    assert.equal(s.healthDrop, Math.min(s.damage, 100), what);
  }
});

test('shots to take a dummy down match the weapon data (100 HP)', async () => {
  const r = await page.evaluate(async () => {
    const g = window.game;
    const t = g.trainingRange.targets.find((x) => x.motion.sweep === 0);
    const out = {};
    for (const [weaponId, range] of [['ar01', 8], ['sr01', 8], ['karambit', 1.5]]) {
      for (const part of ['head', 'torso', 'thigh.l']) {
        t.reset();
        let n = 0;
        while (t.alive && n < 20) {
          await window.shootTarget(t, weaponId, part, range);
          n++;
        }
        out[`${weaponId}/${part}`] = n;
      }
    }
    t.reset();
    return out;
  });
  assert.deepEqual(r, {
    'ar01/head': 1, // 128
    'ar01/torso': 4, // 32
    'ar01/thigh.l': 4, // 26
    'sr01/head': 1, // 460
    'sr01/torso': 1, // 115
    'sr01/thigh.l': 2, // 98
    'karambit/head': 2, // 60
    'karambit/torso': 3, // 40
    'karambit/thigh.l': 3, // 40
  });
});

test('a downed dummy lets shots through, lies down 3 s, rises and takes hits again at full health', async () => {
  const r = await page.evaluate(async () => {
    const g = window.game;
    const t = g.trainingRange.targets.find((x) => x.motion.sweep === 0);
    t.reset();
    const kill = await window.shootTarget(t, 'sr01', 'torso', 8);
    const through = await window.shootTarget(t, 'sr01', 'torso', 8);
    const timeline = [];
    let last = t.state;
    for (let i = 1; i <= 120 * 5; i++) {
      t.step(1 / 120);
      if (t.state !== last) {
        timeline.push([t.state, +(i / 120).toFixed(3)]);
        last = t.state;
      }
    }
    const again = await window.shootTarget(t, 'ar01', 'torso', 8);
    const out = { kill, through, timeline, again, health: t.health, kills: t.kills };
    t.reset();
    return out;
  });
  assert.equal(r.kill.kind, 'target');
  assert.equal(r.kill.alive, false);
  assert.notEqual(r.through.kind, 'target', 'shots pass a downed dummy');
  assert.equal(r.through.healthDrop, 0);
  assert.deepEqual(r.timeline, [
    ['down', 0.35],
    ['rising', 3.35],
    ['standing', 3.85],
  ]);
  assert.equal(r.again.kind, 'target');
  assert.equal(r.again.healthDrop, 32);
  assert.equal(r.health, 68);
  assert.equal(r.kills, 1);
});

test('moving target: deterministic track within its sweep at <= 1.5 m/s; stops while down', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const m = g.trainingRange.targets.find((x) => x.motion.sweep > 0);
    const trace = () => {
      m.reset();
      const xs = [];
      for (let i = 0; i < 120 * 8; i++) {
        m.step(1 / 120);
        xs.push(m.object.position.clone());
      }
      return xs;
    };
    const a = trace();
    const b = trace();
    let maxSpeed = 0;
    let maxOffset = 0;
    for (let i = 1; i < a.length; i++) {
      maxSpeed = Math.max(maxSpeed, a[i].distanceTo(a[i - 1]) * 120);
      maxOffset = Math.max(maxOffset, Math.hypot(a[i].x - m.base.x, a[i].z - m.base.z));
    }
    const same = a.every((p, i) => p.equals(b[i]));
    // Taken down: the track pauses until it stands again.
    m.reset();
    for (let i = 0; i < 60; i++) m.step(1 / 120);
    m.applyDamage({ amount: 200, zone: 'body', sourceId: 't', weaponId: 't', point: m.base.clone(), direction: new m.base.constructor(0, 0, -1), distance: 5 });
    const atKill = m.trackOffset;
    for (let i = 0; i < 120 * 2; i++) m.step(1 / 120);
    const whileDown = m.trackOffset;
    m.reset();
    return { same, maxSpeed, maxOffset, sweep: m.motion.sweep, atKill, whileDown };
  });
  assert.equal(r.same, true);
  assert.ok(r.maxSpeed <= 1.5 + 1e-6 && r.maxSpeed > 1.3, `peak speed ${r.maxSpeed}`);
  assert.ok(r.maxOffset <= r.sweep + 1e-6 && r.maxOffset > r.sweep * 0.95, `travel ${r.maxOffset}`);
  assert.equal(r.whileDown, r.atKill);
});

test('respawn (F4) resets every dummy: full health, standing, moving one back at the start', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const ts = g.trainingRange.targets;
    const V = g.player.position.constructor;
    ts[0].applyDamage({ amount: 500, zone: 'body', sourceId: 't', weaponId: 't', point: ts[0].base.clone(), direction: new V(0, 0, -1), distance: 5 });
    ts[1].applyDamage({ amount: 30, zone: 'body', sourceId: 't', weaponId: 't', point: ts[1].base.clone(), direction: new V(0, 0, -1), distance: 5 });
    for (const t of ts) for (let i = 0; i < 100; i++) t.step(1 / 120);
    const before = ts.map((t) => [t.state, t.health]);
    g.respawn();
    return { before, after: ts.map((t) => [t.state, t.health, t.trackOffset, t.alive]) };
  });
  assert.equal(r.before[0][0], 'down');
  assert.equal(r.before[1][1], 70);
  for (const a of r.after) assert.deepEqual(a, ['standing', 100, 0, true]);
});

test('real input: hit markers, body / head confirm sounds, no decals on dummies, F3 last hit', async () => {
  await page.click('.play-button');
  await page.waitForFunction(() => document.pointerLockElement !== null && window.game.audio.state === 'running', null, { timeout: 30000 });
  await page.evaluate(() => window.game.audio.ready);
  await installFrameDriver(page);
  await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    T.stopLoop();
    g.respawn();
    T.log = [];
    T.markers = [];
    T.kinds = {};
    const play = g.audio.play.bind(g.audio);
    g.audio.play = (id, o = {}) => {
      const ok = play(id, o);
      T.log.push({ id, ok });
      return ok;
    };
    const show = g.hud.showHitMarker.bind(g.hud);
    g.hud.showHitMarker = (head, kill) => {
      T.markers.push([head, kill]);
      show(head, kill);
    };
    const ev = g.weapons.events;
    const shot = ev.onShot;
    ev.onShot = (res, ...rest) => {
      T.kinds[res.kind] = (T.kinds[res.kind] ?? 0) + 1;
      shot(res, ...rest);
    };
    /** Points the view at a part of a dummy (programmatic aim; the trigger is the real mouse). */
    T.aim = async (t, part) => {
      const { PARTS } = await import('/src/combat/TrainingTarget.ts');
      const V = g.player.position.constructor;
      const s = PARTS.find((p) => p.name === part).shape;
      const local = s.kind === 'sphere' ? s.center : s.box.getCenter(new V());
      const aim = new V(local.x, local.y, local.z).applyMatrix4(t.pivot.matrixWorld);
      const p = g.player;
      const eye = new V(p.position.x, p.position.y + p.eyeHeight, p.position.z);
      const d = aim.sub(eye).normalize();
      p.yaw = Math.atan2(-d.x, -d.z);
      p.pitch = Math.asin(d.y);
    };
    T.take = () => {
      const sounds = {};
      for (const e of T.log) if (e.ok) sounds[e.id] = (sounds[e.id] ?? 0) + 1;
      const out = { sounds, markers: T.markers, kinds: T.kinds, decals: g.impacts.decals.count };
      T.log = [];
      T.markers = [];
      T.kinds = {};
      return out;
    };
  });
  const run = (n) => page.evaluate((n) => window.T.run(n), n);
  const click = async () => {
    await page.mouse.down();
    await run(2);
    await page.mouse.up();
    await run(30);
  };
  // Under pointer lock, headless Chromium reports every press as a mouse movement equal to
  // the cursor's page position (a view jump that a real mouse never produces). Park the
  // cursor at (0, 0) so presses carry no movement; the move itself is consumed below.
  await page.mouse.move(0, 0);
  await run(40); // settle (consumes that move), AR in hand
  const still = 'window.game.trainingRange.targets.find((x) => x.motion.sweep === 0)';
  await page.evaluate(`window.T.take()`);

  // AR-01, one round at the chest: body hit, no kill.
  await page.evaluate(`window.T.aim(${still}, 'torso')`);
  const decals0 = await page.evaluate(() => window.game.impacts.decals.count);
  await click();
  const body = await page.evaluate(() => window.T.take());
  assert.deepEqual(body.kinds, { target: 1 });
  assert.deepEqual(body.markers, [[false, false]]);
  assert.equal(body.sounds['hit.body'], 1);
  assert.equal(body.sounds['hit.head'], undefined);
  // Body hits sound like a body (wet thud), not like concrete.
  assert.equal(body.sounds['impact.flesh'], 1, 'flesh impact sound at the hit point');
  assert.equal(body.sounds.impact, undefined, 'no concrete impact sound on a body');
  assert.equal(body.decals, decals0, 'no bullet hole decal on a dummy');
  const marker = await page.evaluate(() => {
    const m = document.querySelector('.hitmarker');
    return { head: m.classList.contains('head'), kill: m.classList.contains('kill') };
  });
  assert.deepEqual(marker, { head: false, kill: false });

  // One round at the head: 128 damage, kill + head marker, head sound.
  await page.evaluate(`window.T.aim(${still}, 'head')`);
  await click();
  const head = await page.evaluate(() => window.T.take());
  assert.deepEqual(head.kinds, { target: 1 });
  assert.deepEqual(head.markers, [[true, true]]);
  assert.equal(head.sounds['hit.head'], 1);
  assert.equal(head.sounds['hit.body'], undefined);
  const marker2 = await page.evaluate(() => {
    const m = document.querySelector('.hitmarker');
    return { head: m.classList.contains('head'), kill: m.classList.contains('kill') };
  });
  assert.equal(marker2.head, true);
  assert.equal(marker2.kill, true);

  // F3 overlay shows the last hit.
  await page.evaluate(() => window.game.setStatsShown(true));
  await run(40);
  const stats = await page.evaluate(() => document.querySelector('.stats').textContent);
  assert.match(stats, /last hit head 128 @ \d+\.\d m {2}KILL/);

  // The dummy is down: the next round goes past it into the map (world hit, decal).
  await click();
  const past = await page.evaluate(() => window.T.take());
  assert.equal(past.kinds.target, undefined);
  assert.deepEqual(past.markers, []);
  assert.equal(past.sounds['hit.body'] ?? 0, 0);

  // Volume 0: no confirm sounds, markers still shown.
  await page.evaluate(() => {
    window.game.respawn();
    window.game.audio.setVolume(0);
  });
  await run(40); // respawn drops the player onto the floor first
  await page.evaluate(`window.T.aim(${still}, 'torso')`);
  await click();
  const muted = await page.evaluate(() => window.T.take());
  assert.deepEqual(muted.kinds, { target: 1 });
  assert.deepEqual(muted.markers, [[false, false]]);
  assert.deepEqual(muted.sounds, {});
  await page.evaluate(() => {
    window.game.audio.setVolume(window.game.settings.volume);
    window.game.respawn();
    document.exitPointerLock();
  });
});

test('map switch: old dummies unregistered and their GPU resources released; new map gets its own', async () => {
  const before = await page.evaluate(() => {
    const g = window.game;
    const R = g.trainingRange;
    window.__old = { range: R, hitscan: g.hitscan, disposed: { geometry: 0, material: 0 } };
    for (const t of R.targets) t.mesh.geometry.addEventListener('dispose', () => window.__old.disposed.geometry++);
    R.targets[0].mesh.material.addEventListener('dispose', () => window.__old.disposed.material++);
    return { count: R.targets.length };
  });
  await page.evaluate(() => window.game.switchMap('seoul'));
  await page.waitForFunction(() => window.game.mapDef.id === 'seoul' && window.game.trainingRange && !document.querySelector('.play-button').disabled, null, { timeout: LOAD_TIMEOUT });
  const r = await page.evaluate(() => {
    const g = window.game;
    const old = window.__old;
    let groups = 0;
    g.scene.traverse((o) => {
      if (o.name === 'TrainingRange') groups++;
    });
    return {
      oldInScene: old.range.group.parent !== null,
      oldTargets: old.range.targets.length,
      oldRegistered: [...old.hitscan.targets].length,
      disposed: old.disposed,
      groups,
      newRegistered: [...g.hitscan.targets].filter((t) => t.team === 'training').length,
      newCount: g.trainingRange.targets.length,
    };
  });
  assert.equal(r.oldInScene, false);
  assert.equal(r.oldTargets, 0);
  assert.equal(r.oldRegistered, 0, 'old hitscan has no targets left');
  assert.deepEqual(r.disposed, { geometry: before.count, material: 1 });
  assert.equal(r.groups, 1, 'exactly one set of dummies in the scene');
  assert.equal(r.newRegistered, r.newCount);
});

test('seoul: at least 3 targets (incl. the moving one) placed on the floor, free, visible from the spawn', async () => {
  assert.equal(await page.evaluate(() => window.game.mapDef.id), 'seoul');
  assertPlacement(await placementReport(page), 'seoul');
});

test('no page errors', () => {
  assert.deepEqual(page.errors, []);
});
