// Phase 30 — combat controls: the new keys (Q / E lean; the C4 on F, inspect on V, the last weapon on X; an
// old saved record moved over), leaning (camera, shots, hit capsule, walls, the touch ◀ ▶ buttons, the
// network and the third-person body), 손잡이 (a mirrored first-person view, display only, kept) and moving
// fire (walking accuracy; rounds fired while moving judged by the host exactly as aimed, with delay).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { startEnv, openGame, installFrameDriver, waitReady, ROOT } from './harness.mjs';
import { fingers, centre } from './mobile-touch.mjs';

let vite;
let relay;
let env;
before(async () => {
  vite = await createServer({ root: ROOT, logLevel: 'error', server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom' });
  const { createMpServer } = await vite.ssrLoadModule('/server/mp/server.ts');
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

async function play(opts = {}) {
  const page = await openGame(env, { mode: 'deathmatch', width: 640, height: 360, quality: 'low', ...opts });
  if (opts.mobile) await page.tap('.play-button');
  else await page.click('.play-button');
  await page.waitForFunction(() => window.game.input.active);
  await installFrameDriver(page);
  await page.evaluate(() => {
    window.T.stopLoop();
    window.T.run(10);
    window.game.combat.protection = 1e9;
  });
  return page;
}

const view = (page) =>
  page.evaluate(() => {
    const g = window.game;
    const p = g.player;
    const c = g.camera;
    const right = { x: Math.cos(p.yaw), z: -Math.sin(p.yaw) };
    const dx = c.position.x - p.position.x;
    const dz = c.position.z - p.position.z;
    return { lean: +p.lean.toFixed(3), side: +(dx * right.x + dz * right.z).toFixed(3), roll: +c.rotation.z.toFixed(3) };
  });

test('1. keys: Q / E lean, F plants / defuses, V inspects, X the last weapon (the key page lists them); a record saved before keeps the player’s own keys and moves the old defaults; a key taken by another action leaves the lean without one (shown —)', async () => {
  const page = await openGame(env, { mode: 'training', width: 640, height: 360 });
  try {
    const r = await page.evaluate(async () => {
      const C = await import('/src/input/Controls.ts');
      const d = C.defaultControls().bindings;
      const migrate = (raw) => {
        localStorage.setItem('tactical-fps.controls.v1', JSON.stringify(raw));
        return C.loadControls().bindings;
      };
      // Saved before Phase 30: all defaults (Q last weapon, E use, F inspect).
      const old = migrate({ sensitivity: 1, bindings: { ...d, lastWeapon: 'KeyQ', use: 'KeyE', inspect: 'KeyF', leanLeft: undefined, leanRight: undefined } });
      // Saved before, with the player's own C4 key on G and reload on Q.
      const own = migrate({ sensitivity: 1.4, bindings: { forward: 'KeyW', use: 'KeyG', reload: 'KeyQ', lastWeapon: 'KeyZ' } });
      localStorage.removeItem('tactical-fps.controls.v1');
      return {
        d: [d.leanLeft, d.leanRight, d.use, d.inspect, d.lastWeapon],
        old: [old.leanLeft, old.leanRight, old.use, old.inspect, old.lastWeapon],
        own: [own.use, own.reload, own.lastWeapon, own.leanLeft, own.leanRight, C.keyLabel(own.leanLeft)],
        page: [...document.querySelectorAll('.bind-key')].map((b) => `${b.dataset.action}:${b.textContent}`),
      };
    });
    assert.deepEqual(r.d, ['KeyQ', 'KeyE', 'KeyF', 'KeyV', 'KeyX']);
    assert.deepEqual(r.old, ['KeyQ', 'KeyE', 'KeyF', 'KeyV', 'KeyX'], 'old defaults moved to the new ones');
    assert.deepEqual(r.own, ['KeyG', 'KeyQ', 'KeyZ', '', 'KeyE', '—'], "the player's own keys kept; Q is the reload's, so lean left has none");
    for (const want of ['leanLeft:Q', 'leanRight:E', 'use:F', 'inspect:V', 'lastWeapon:X']) assert.ok(r.page.includes(want), `${want} on the key page (${r.page})`);
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});

test('2. lean on a PC: E right / Q left (held) eases in within 0.2 s to 0.38 m and a 0.2 rad roll, back upright when let go; the round leaves from the leaned eye; aiming and firing work leaned', async () => {
  const page = await play();
  try {
    // Somewhere open on both sides (no wall within 1 m at eye height).
    await page.evaluate(() => {
      const g = window.game;
      const V = g.player.position.constructor;
      for (const sp of [...g.map.attackSpawns, ...g.map.defenseSpawns]) {
        const o = new V(sp.position.x, sp.position.y + 1.6, sp.position.z);
        for (let i = 0; i < 16; i++) {
          const yaw = (i / 16) * Math.PI * 2;
          const r = new V(Math.cos(yaw), 0, -Math.sin(yaw));
          if (g.map.collision.raycast(o, r, 2.5) === null && g.map.collision.raycast(o, r.clone().negate(), 2.5) === null) {
            g.player.teleport(sp.position, yaw);
            window.T.run(5);
            return;
          }
        }
      }
    });
    assert.deepEqual(await view(page), { lean: 0, side: 0, roll: 0 });
    await page.keyboard.down('KeyE');
    await page.evaluate(() => window.T.run(6)); // 0.1 s: on the way
    const half = await view(page);
    assert.ok(half.lean > 0.3 && half.lean < 1, JSON.stringify(half));
    await page.evaluate(() => window.T.run(8)); // 0.23 s: there
    const right = await view(page);
    assert.deepEqual(right, { lean: 1, side: 0.38, roll: -0.2 });
    // A round fired leaned: it leaves from the leaned eye, through the crosshair.
    const shot = await page.evaluate(() => {
      const g = window.game;
      let origin = null;
      const ev = g.weapons.events;
      const on = ev.onShot;
      ev.onShot = (res, o, ...rest) => {
        origin = o.clone();
        return on?.(res, o, ...rest);
      };
      g.weapons.weapon.magazine = 30;
      const poll = g.input.poll.bind(g.input);
      g.input.poll = (out) => {
        poll(out);
        out.fire = true;
      };
      window.T.run(1);
      g.input.poll = poll;
      ev.onShot = on;
      const eye = g.player.eyePosition(new g.player.position.constructor());
      return origin ? +origin.distanceTo(eye).toFixed(4) : null;
    });
    assert.ok(shot !== null && shot < 0.01, `fired from the leaned eye (${shot} m: the tick's own step)`);
    await page.keyboard.up('KeyE');
    await page.keyboard.down('KeyQ');
    // From a full right lean to a full left one: twice the way (0.36 s).
    await page.evaluate(() => window.T.run(26));
    assert.deepEqual(await view(page), { lean: -1, side: -0.38, roll: 0.2 });
    await page.keyboard.up('KeyQ');
    await page.evaluate(() => window.T.run(20));
    assert.deepEqual(await view(page), { lean: 0, side: 0, roll: 0 }, 'upright again when let go');
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});

test('3. a wall at the side stops the lean short of it (the eye and the camera stay 0.25 m off the wall: no seeing or shooting through); in the open it is the full 0.38 m', async () => {
  const page = await play();
  try {
    const r = await page.evaluate(() => {
      const g = window.game;
      const V = g.player.position.constructor;
      const coll = g.map.collision;
      // A spot with a wall 0.3–0.5 m to the right at eye height.
      for (const sp of [...g.map.attackSpawns, ...g.map.defenseSpawns]) {
        const base = sp.position;
        for (let i = 0; i < 32; i++) {
          const yaw = (i / 32) * Math.PI * 2;
          const right = new V(Math.cos(yaw), 0, -Math.sin(yaw));
          const o = new V(base.x, base.y + 1.6, base.z);
          const h = coll.raycast(o, right, 8);
          if (h === null || h < 1.5) continue;
          // Walk to 0.4 m from that wall.
          const at = base.clone().addScaledVector(right, h - 0.4);
          g.player.teleport(at, yaw);
          window.T.run(2);
          const eye = new V(g.player.position.x, g.player.position.y + g.player.eyeHeight, g.player.position.z);
          const wall = coll.raycast(eye, right, 2);
          if (wall === null || wall > 0.6) continue;
          const poll = g.input.poll.bind(g.input);
          g.input.poll = (out) => {
            poll(out);
            out.lean = 1;
          };
          window.T.run(20);
          g.input.poll = poll;
          const cam = g.camera.position;
          const gap = coll.raycast(cam, right, 2);
          return { wall: +wall.toFixed(2), lean: +g.player.lean.toFixed(2), gap: gap === null ? null : +gap.toFixed(3) };
        }
      }
      return { error: 'no wall' };
    });
    assert.ok(!r.error, r.error);
    assert.ok(r.lean < 1, `cut short by the wall (${JSON.stringify(r)})`);
    assert.ok(r.gap !== null && r.gap >= 0.24, `the camera stays off the wall (${JSON.stringify(r)})`);
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});

test('4. the hit capsule leans with the body: a round 0.33 m to the right of an upright bot’s head misses; the same round hits once it leans right (as a member’s or a bot’s lean would show); the third-person body tilts its head that way', async () => {
  const page = await play();
  try {
    const r = await page.evaluate(async () => {
      const g = window.game;
      const { WEAPONS } = await import('/src/weapons/weapons.ts');
      const V = g.player.position.constructor;
      const bot = g.squad.bots.find((b) => b.alive && !b.remote);
      const c = bot.controller;
      bot.combat.protection = 1e9; // judged, not hurt
      c.position.set(c.position.x + 300, c.position.y + 200, c.position.z);
      c.yaw = 0; // facing -Z: its right is +X
      const head = c.position.y + c.eyeHeight;
      const fire = () => {
        const origin = new V(c.position.x + 0.33, head - 0.05, c.position.z + 10);
        const dir = new V(0, 0, -1);
        return g.hitscan.fire({ origin, direction: dir, damage: WEAPONS.ar01.damage, sourceId: 'tester', weaponId: 'ar01' }).kind;
      };
      c.lean = 0;
      const upright = fire();
      c.lean = 1;
      const leaned = fire();
      // The model: its top moves toward its right as it leans.
      const model = g.squad['models'][g.squad.bots.indexOf(bot)];
      const top = () => {
        // Phase 31: the body shows the lean eased (~0.15 s, a network update arrives in steps): a few frames.
        for (let f = 0; f < 30; f++) g.squad.updateVisuals(0.016);
        model.object.updateMatrixWorld(true);
        let best = null;
        model.object.traverse((o) => {
          if (!o.isMesh) return;
          o.geometry.computeBoundingBox();
          const p = o.geometry.boundingBox.getCenter(new V());
          o.localToWorld(p);
          if (!best || p.y > best.y) best = p;
        });
        return best;
      };
      c.lean = 0;
      const a = top();
      c.lean = 1;
      const b = top();
      c.lean = 0;
      c.position.set(c.position.x - 300, c.position.y - 200, c.position.z);
      return { upright, leaned, headMove: +(b.x - a.x).toFixed(2) };
    });
    assert.deepEqual([r.upright, r.leaned], ['miss', 'target']);
    assert.ok(r.headMove > 0.25, `the drawn head moves right with the lean (${r.headMove} m)`);
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});

test('5. a phone: the ◀ ▶ buttons (held) lean like Q / E; they sit above the stick, are placeable / resizable / hideable in the layout editor, and kept in the saved layout', async () => {
  const page = await play({ mobile: true, width: 740, height: 360 });
  try {
    const f = await fingers(page);
    const r = await centre(page, '.tc-leanR');
    await f.start(1, r.x, r.y);
    await page.evaluate(() => window.T.run(20));
    assert.equal((await view(page)).lean > 0.5, true, 'held ▶: leaning right');
    await f.end(1);
    const l = await centre(page, '.tc-leanL');
    await f.start(2, l.x, l.y);
    await page.evaluate(() => window.T.run(20));
    assert.equal((await view(page)).lean < -0.5, true, 'held ◀: leaning left');
    await f.end(2);
    await page.evaluate(() => window.T.run(20));
    assert.equal((await view(page)).lean, 0);
    const where = await page.evaluate(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      return { l: r('.tc-leanL').left, stickRight: r('.tc-stick').right };
    });
    assert.ok(where.l >= where.stickRight, 'at the stick’s lower right');
    const ids = await page.evaluate(async () => (await import('/src/input/TouchLayout.ts')).LAYOUT_IDS.filter((x) => x.startsWith('lean')));
    assert.deepEqual(ids, ['leanL', 'leanR'], 'in the layout registry (editor, hiding, saving)');
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});

test('6. a room: the member’s lean reaches the host (its character, the wall check there too) and the others’ screens (the puppet leans), only while leaning (nothing extra upright)', async () => {
  const host = await openGame(env, { mode: 'deathmatch', width: 480, height: 270 });
  const member = await openGame(env, { mode: 'training', width: 480, height: 270 });
  for (const p of [host, member]) p.setDefaultTimeout(60000);
  try {
    await host.click('#tab-multi');
    await host.fill('.mp-name', 'Host');
    await host.selectOption('.mp-mode', 'deathmatch');
    await host.click('.mp-create');
    await host.waitForFunction(() => window.game.netHost && window.game.squad);
    const code = (await host.textContent('.mp-room-code')).trim();
    await member.click('#tab-multi');
    await member.fill('.mp-name', 'Member');
    await member.fill('.mp-code', code);
    await member.click('.mp-join-btn');
    await member.waitForFunction(() => window.game.netClient?.myId && window.game.match);
    for (const p of [host, member]) {
      await p.click('#tab-play');
      await p.click('.play-button');
      await p.waitForFunction(() => window.game.input.active);
    }
    // Upright: the host's snapshot entities carry no lean field.
    const upright = await host.evaluate(() => window.game.netHost['entities']?.().map((e) => e.length) ?? null);
    // The member leans right (E held).
    await member.keyboard.down('KeyE');
    await host.waitForFunction(() => {
      const b = window.game.squad.bots.find((x) => x.remote);
      return b && b.controller.lean > 0.5;
    });
    const hostSide = await host.evaluate(() => {
      const b = window.game.squad.bots.find((x) => x.remote);
      return { lean: +b.controller.lean.toFixed(2), id: window.game.netHost.wire(b.id) };
    });
    // The host leans left: the member sees the host's puppet lean.
    await host.keyboard.down('KeyQ');
    const hostWire = await host.evaluate(() => window.game.netHost.wire('local'));
    await member.waitForFunction((id) => (window.game.netClient.puppets.all.get(id)?.lean ?? 0) < -0.5, hostWire);
    await member.keyboard.up('KeyE');
    await host.keyboard.up('KeyQ');
    await host.waitForFunction(() => window.game.squad.bots.find((x) => x.remote)?.controller.lean === 0);
    await member.waitForFunction((id) => window.game.netClient.puppets.all.get(id)?.lean === 0, hostWire);
    assert.ok(hostSide.lean > 0.5 && hostSide.lean <= 1);
    if (upright) assert.ok(upright.every((n) => n <= 16), `no lean field while upright (${upright})`);
    assert.deepEqual([host.errors, member.errors], [[], []]);
  } finally {
    await host.context().close();
    await member.context().close();
  }
});

test('7. 손잡이: 왼손잡이 mirrors the first-person view for every weapon (the muzzle on the left of the screen, knife included), fire / reload / scope still work, shots go through the crosshair as before; kept after a reload; 오른손잡이 is as before', async () => {
  const page = await play();
  try {
    const muzzleSide = () =>
      page.evaluate(async () => {
        const g = window.game;
        const { WEAPONS } = await import('/src/weapons/weapons.ts');
        const out = {};
        for (const w of Object.values(WEAPONS)) {
          g.weapons.setLoadout([w, WEAPONS.karambit], 0);
          window.T.run(Math.ceil(w.equipTime * 60) + 12);
          g.showWeaponModel(w);
          await new Promise((r) => setTimeout(r, 0));
          window.T.run(2);
          const vm = g.viewModel;
          vm.scene.updateMatrixWorld(true);
          const obj = vm.currentView?.object;
          if (!obj) continue;
          // The model's centre in the view camera's screen space: x < 0 is left of the centre.
          const box = new (g.player.position.constructor)();
          let sum = 0;
          let n = 0;
          obj.traverse((o) => {
            if (!o.isMesh) return;
            o.geometry.computeBoundingBox();
            const c = o.geometry.boundingBox.getCenter(box.clone());
            o.localToWorld(c);
            c.project(vm.camera);
            sum += c.x;
            n++;
          });
          out[w.id] = n ? +(sum / n).toFixed(2) : null;
        }
        return out;
      });
    const right = await muzzleSide();
    await page.evaluate(() => {
      const s = document.querySelector('select[data-setting="handedness"]');
      s.value = 'left';
      s.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const left = await muzzleSide();
    for (const [id, x] of Object.entries(right)) {
      assert.ok(x > 0, `${id}: right-handed, on the right (${x})`);
      assert.ok(left[id] < 0 && Math.abs(left[id] + x) < 0.05, `${id}: left-handed, mirrored to the left (${left[id]} vs ${x})`);
    }
    // Fire, reload and the AWM's scope left-handed; the round still goes through the crosshair.
    const act = await page.evaluate(async () => {
      const g = window.game;
      const { WEAPONS } = await import('/src/weapons/weapons.ts');
      g.weapons.setLoadout([WEAPONS.ar01, WEAPONS.sr01, WEAPONS.karambit], 0);
      window.T.run(80);
      let dir = null;
      const ev = g.weapons.events;
      const on = ev.onShot;
      ev.onShot = (res, o, d, ...rest) => {
        dir = d.clone();
        return on?.(res, o, d, ...rest);
      };
      g.player.velocity.set(0, 0, 0);
      g.weapons.step({ fire: true, reload: false }, 1 / 120);
      ev.onShot = on;
      const fwd = new (g.player.position.constructor)(-Math.sin(g.player.yaw) * Math.cos(g.player.pitch), Math.sin(g.player.pitch), -Math.cos(g.player.yaw) * Math.cos(g.player.pitch));
      const reload = g.weapons.weapon.startReload();
      window.T.run(200);
      g.weapons.equipSlot(1);
      window.T.run(80);
      const poll = g.input.poll.bind(g.input);
      g.input.poll = (out) => {
        poll(out);
        out.aim = true;
      };
      window.T.run(10);
      const scoped = g.scoped;
      g.input.poll = poll;
      window.T.run(5);
      return { aim: dir ? +dir.angleTo(fwd).toFixed(4) : null, reload, mag: g.weapons.loadout[0].magazine, scoped, left: g.viewModel.leftHanded };
    });
    assert.ok(act.aim !== null && act.aim < 0.03, `through the crosshair (${act.aim} rad, the weapon's own small kick)`);
    assert.deepEqual([act.reload, act.mag, act.scoped, act.left], [true, 30, true, true]);
    // Kept after a reload; display only (nothing about it is sent in a room's report).
    assert.equal(await page.evaluate(() => localStorage.getItem('tactical-fps.hand.v1')), 'left');
    await page.reload();
    await waitReady(page);
    assert.equal(await page.evaluate(() => [window.game.viewModel.leftHanded, document.querySelector('select[data-setting="handedness"]').value].join()), 'true,left');
    await page.evaluate(() => {
      const s = document.querySelector('select[data-setting="handedness"]');
      s.value = 'right';
      s.dispatchEvent(new Event('change', { bubbles: true }));
    });
    assert.deepEqual(await page.evaluate(() => [window.game.viewModel.leftHanded, localStorage.getItem('tactical-fps.hand.v1')]), [false, null]);
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});

test('8. moving fire: walking (Shift) keeps a quarter of a weapon’s moving inaccuracy (was half); a full run and a jump exactly as before, for every weapon', async () => {
  const page = await openGame(env, { mode: 'training', width: 480, height: 270 });
  try {
    const r = await page.evaluate(async () => {
      const { movePenalty, WALK_SPREAD } = await import('/src/weapons/WeaponSystem.ts');
      const { PLAYER_CONFIG } = await import('/src/config.ts');
      const walk = PLAYER_CONFIG.walkSpeed / PLAYER_CONFIG.runSpeed;
      return { still: movePenalty(0), walk: +movePenalty(walk).toFixed(3), mid: +movePenalty((1 + walk) / 2).toFixed(3), run: movePenalty(1), over: movePenalty(1.5), quarter: WALK_SPREAD };
    });
    assert.deepEqual(r, { still: 0, walk: 0.25, mid: 0.625, run: 1, over: 1, quarter: 0.25 });
    // In play: the cone at a full run and in the air as before (every weapon's own numbers), at a walk a quarter.
    const cones = await page.evaluate(async () => {
      const g = window.game;
      const { WEAPONS } = await import('/src/weapons/weapons.ts');
      const { PLAYER_CONFIG } = await import('/src/config.ts');
      const p = g.player;
      const out = {};
      for (const w of Object.values(WEAPONS).filter((x) => x.category !== 'melee')) {
        g.weapons.setLoadout([w, WEAPONS.karambit], 0);
        const s = w.spread;
        p.grounded = true;
        p.crouching = false;
        p.velocity.set(PLAYER_CONFIG.runSpeed, 0, 0);
        const run = g.weapons.currentSpread();
        p.velocity.set(PLAYER_CONFIG.walkSpeed, 0, 0);
        const walk = g.weapons.currentSpread();
        p.grounded = false;
        p.velocity.set(PLAYER_CONFIG.runSpeed, 0, 0);
        const air = g.weapons.currentSpread();
        p.grounded = true;
        p.velocity.set(0, 0, 0);
        out[w.id] = [Math.abs(run - (s.standing + s.moving)) < 1e-9, Math.abs(walk - (s.standing + s.moving * 0.25)) < 1e-9, Math.abs(air - (s.standing + s.moving + s.airborne)) < 1e-9];
      }
      return out;
    });
    for (const [id, ok] of Object.entries(cones)) assert.deepEqual(ok, [true, true, true], id);
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});

test('9. a room, moving and delayed: the member strafes (run and walk) and fires at the standing host with 80 ± 40 ms network delay each way; the host judges every round as aimed (hit), none refused', async () => {
  const host = await openGame(env, { mode: 'deathmatch', width: 480, height: 270 });
  const member = await openGame(env, { mode: 'training', width: 480, height: 270 });
  for (const p of [host, member]) p.setDefaultTimeout(60000);
  try {
    await host.click('#tab-multi');
    await host.fill('.mp-name', 'Host');
    await host.selectOption('.mp-mode', 'deathmatch');
    await host.click('.mp-create');
    await host.waitForFunction(() => window.game.netHost && window.game.squad);
    const code = (await host.textContent('.mp-room-code')).trim();
    await member.click('#tab-multi');
    await member.fill('.mp-name', 'M');
    await member.fill('.mp-code', code);
    await member.click('.mp-join-btn');
    await member.waitForFunction(() => window.game.netClient?.myId && window.game.match);
    for (const p of [host, member]) {
      await p.click('#tab-play');
      await p.click('.play-button');
      await p.waitForFunction(() => window.game.input.active);
    }
    await host.waitForFunction(() => window.game.squad.bots.some((b) => b.remote));
    await member.waitForFunction(() => window.game.input.active && window.game.combat?.alive);
    // The member picks, from where it really stands, a direction open 9 m ahead over a 2 m wide strip; the host
    // stands 8 m along it (the host may place itself), the bots are taken out of the way.
    const spot = await member.evaluate(() => {
      const g = window.game;
      const V = g.player.position.constructor;
      const p = g.player.position;
      const o = new V(p.x, p.y + 1.1, p.z);
      for (let i = 0; i < 64; i++) {
        const a = (i / 64) * Math.PI * 2;
        const d = new V(-Math.sin(a), 0, -Math.cos(a));
        const side = new V(d.z, 0, -d.x);
        let ok = true;
        for (const s of [-1, 0, 1]) if (g.map.collision.raycast(o.clone().addScaledVector(side, s), d, 9) !== null) ok = false;
        if (ok) return [p.x + d.x * 8, p.y, p.z + d.z * 8];
      }
      return null;
    });
    const target = spot
      ? await host.evaluate((at) => {
          const g = window.game;
          g.combat.protection = 1e9;
          g.player.position.set(at[0], at[1], at[2]);
          g.player.velocity.set(0, 0, 0);
          for (const b of g.squad.bots) if (!b.remote) b.controller.position.set(at[0] + 500, at[1] - 300, at[2]);
          return g.netHost.wire('local');
        }, spot)
      : null;
    // The host's character where it was put, on the member's screen too.
    if (target) await member.waitForFunction(([id, at]) => {
      const q = window.game.netClient.puppets.all.get(id);
      return q && Math.hypot(q.position.x - at[0], q.position.z - at[2]) < 0.5;
    }, [target, spot]);
    assert.ok(target, 'an open place');
    const s0 = await host.evaluate(() => ({ ...window.game.netHost.shotStats }));
    const fired = await member.evaluate(async (tid) => {
      const g = window.game;
      const nc = g.netClient;
      g.combat.protection = 1e9;
      const { WEAPONS } = await import('/src/weapons/weapons.ts');
      // Exact aim (no cone) so a miss could only be the network's or the judging's.
      const sp = WEAPONS.ar01.spread;
      const saved = { ...sp };
      sp.moving = sp.standing = sp.airborne = 0;
      // 80 ± 40 ms each way, order kept.
      let outAt = 0;
      let inAt = 0;
      const send = nc.send.bind(nc);
      const recv = nc.receive.bind(nc);
      const delay = () => 80 + (Math.random() * 2 - 1) * 40;
      nc.send = (m) => {
        const t = Math.max(outAt, performance.now() + delay());
        outAt = t;
        setTimeout(() => send(m), t - performance.now());
      };
      nc.receive = (d) => {
        const t = Math.max(inAt, performance.now() + delay());
        inAt = t;
        setTimeout(() => recv(d), t - performance.now());
      };
      const n0 = g.weapons.shotsFired;
      const poll = g.input.poll.bind(g.input);
      let t = 0;
      let fire = false;
      g.input.poll = (out) => {
        poll(out);
        // Short strafes left and right (about ±1 m): running for 4 s, then walking (Shift) for 4 s.
        out.moveX = Math.floor(t / 0.3) % 2 ? 1 : -1;
        out.walk = t > 5;
        out.fire = fire;
      };
      const start = performance.now();
      await new Promise((resolve) => {
        const id = setInterval(() => {
          t = (performance.now() - start) / 1000;
          const q = nc.puppets.all.get(tid);
          if (q) {
            const p = g.player;
            const e = p.eyePosition(new p.position.constructor());
            const dx = q.position.x - e.x;
            const dz = q.position.z - e.z;
            p.yaw = Math.atan2(-dx, -dz);
            p.pitch = Math.atan2(q.position.y + 1.1 - e.y, Math.hypot(dx, dz));
          }
          g.weapons.weapon.magazine = 30;
          fire = !fire && t > 1;
          if (t > 9) {
            clearInterval(id);
            resolve();
          }
        }, 50);
      });
      g.input.poll = poll;
      Object.assign(sp, saved);
      return g.weapons.shotsFired - n0;
    }, target);
    await host.waitForTimeout(1200);
    const s1 = await host.evaluate(() => ({ ...window.game.netHost.shotStats }));
    const d = {};
    for (const k of new Set([...Object.keys(s0), ...Object.keys(s1)])) d[k] = (s1[k] ?? 0) - (s0[k] ?? 0);
    assert.ok(fired >= 10, `rounds fired moving (${fired})`);
    assert.deepEqual(d, { target: fired }, `every round judged a hit on the host (${JSON.stringify(d)})`);
    assert.deepEqual([host.errors, member.errors], [[], []]);
  } finally {
    await host.context().close();
    await member.context().close();
  }
});
