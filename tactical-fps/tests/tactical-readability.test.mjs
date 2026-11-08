// Tactical readability (Phase 18): friend and foe apart at a glance without
// giving anything away. Team uniforms differ in tone (dark navy vs light tan)
// with team marks (helmet band, armbands, vest ID panels); bodies have a small
// light floor; a chevron over teammates only, depth tested (walls hide it), in
// team matches only. HUD: alive pips, a reload prompt on an empty magazine, a
// kill streak count on the one kill notice. Weapon balance values are pinned
// to a recording (damage, rate, magazine, reload, recoil, spread).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, openGame, installFrameDriver, golden, asJson } from './harness.mjs';

let env;
let page;

before(async () => {
  env = await startEnv();
  page = await openGame(env, { mode: 'team', quality: 'medium' });
  await page.click('.play-button');
  await page.waitForFunction(() => window.game.input.active);
  await installFrameDriver(page);
  await page.evaluate(() => {
    window.T.stopLoop();
    window.game.combat.protection = 1e9;
    window.T.run(20);
  });
});
after(async () => {
  await page?.context().close();
  await env?.close();
});

test('team uniforms differ in tone; team marks on helmet, arms and vest; every body has a light floor', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    const look = (team) => {
      const i = g.squad.bots.findIndex((b) => b.team === team);
      const model = g.squad.models[i];
      let marker = 0;
      let unlit = 0;
      let fabric = null;
      let markerHex = null;
      model.object.traverse((o) => {
        if (!o.isMesh) return;
        const m = o.material;
        if (m.emissive && m.emissive.getHex() === 0) unlit++;
        if (/^#?2f7bff|d8392b/.test(m.color.getHexString())) {
          marker++;
          markerHex = m.color.getHexString();
        }
        if (m.map && fabric === null && m.color.getHexString() !== '67644f') fabric = lum(m.color);
      });
      return { marker, unlit, fabric, markerHex };
    };
    return { blue: look('blue'), red: look('red') };
  });
  assert.ok(r.blue.marker >= 2 && r.red.marker >= 2, `team marks present (${r.blue.marker}, ${r.red.marker} meshes)`);
  assert.equal(r.blue.markerHex, '2f7bff');
  assert.equal(r.red.markerHex, 'd8392b');
  assert.equal(r.blue.unlit, 0, 'every BLUE body material has the light floor');
  assert.equal(r.red.unlit, 0, 'every RED body material has the light floor');
  assert.ok(r.red.fabric > r.blue.fabric * 2.5, `RED uniform clearly lighter than BLUE (${r.red.fabric} vs ${r.blue.fabric})`);
});

test('RED wears darker coyote gear inside the light tan (a dark mass that parts from mid-tone walls); BLUE stays dark throughout', async () => {
  // Phase 19, measured on rendered frames: plain tan RED blended into mid-tone concrete and brick
  // (Weber contrast down to 0.12 in the open in Seoul); darker plate carrier and helmet raised it to 0.17+.
  const r = await page.evaluate(async () => {
    const { TEAM_KIT } = await import('/src/ai/BotModel.ts');
    const g = window.game;
    const lum = (hex) => {
      const c = new g.camera.position.constructor((hex >> 16) & 255, (hex >> 8) & 255, hex & 255);
      return 0.2126 * c.x + 0.7152 * c.y + 0.0722 * c.z;
    };
    const i = g.squad.bots.findIndex((b) => b.team === 'red');
    const colours = new Set();
    g.squad.models[i].object.traverse((o) => o.isMesh && colours.add(o.material.color.getHex()));
    const k = TEAM_KIT;
    return {
      redGear: lum(k.red.gear) / lum(k.red.fabric),
      redHelmet: lum(k.red.helmet) / lum(k.red.fabric),
      redOverBlueGear: lum(k.red.gear) / lum(k.blue.gear),
      redOverBlueFabric: lum(k.red.fabric) / lum(k.blue.fabric),
      gearWorn: colours.has(k.red.gear),
      helmetWorn: colours.has(k.red.helmet),
    };
  });
  assert.ok(r.redGear < 0.65, `RED gear clearly darker than RED fabric (${r.redGear.toFixed(2)})`);
  assert.ok(r.redHelmet < 0.75, `RED helmet darker than RED fabric (${r.redHelmet.toFixed(2)})`);
  assert.ok(r.redOverBlueGear > 1.5, `RED gear still lighter than BLUE gear: the tone split holds (${r.redOverBlueGear.toFixed(2)})`);
  assert.ok(r.redOverBlueFabric > 1.7, `RED uniform still far lighter than BLUE (${r.redOverBlueFabric.toFixed(2)})`);
  assert.equal(r.gearWorn, true, 'the RED body wears the gear colour');
  assert.equal(r.helmetWorn, true, 'the RED body wears the helmet colour');
});

test('ally chevrons: teammates only, depth tested, one instanced mesh', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    window.T.run(2);
    const allies = g.squad.bots.filter((b) => b.alive && b.team === g.localTeam).length;
    const enemies = g.squad.bots.filter((b) => b.alive && b.team !== g.localTeam).length;
    const mat = g.allyMarkers.mesh.material;
    // Every marker stands over an ally, none over an enemy.
    const V = g.camera.position.constructor;
    const m = new g.camera.matrix.constructor();
    const positions = [];
    for (let i = 0; i < g.allyMarkers.count; i++) {
      g.allyMarkers.mesh.getMatrixAt(i, m);
      positions.push(new V().setFromMatrixPosition(m));
    }
    const near = (team) =>
      positions.filter((p) => g.squad.bots.some((b) => b.alive && b.team === team && Math.hypot(b.controller.position.x - p.x, b.controller.position.z - p.z) < 0.05)).length;
    return {
      allies,
      enemies,
      count: g.allyMarkers.count,
      overAllies: near(g.localTeam),
      overEnemies: near(g.localTeam === 'blue' ? 'red' : 'blue'),
      depthTest: mat.depthTest,
      instanced: g.allyMarkers.mesh.isInstancedMesh,
    };
  });
  assert.ok(r.allies >= 1 && r.enemies >= 1);
  assert.equal(r.count, r.overAllies, 'every marker is over an ally');
  assert.equal(r.overEnemies, 0, 'never over an enemy');
  assert.ok(r.count <= r.allies);
  assert.equal(r.depthTest, true, 'walls hide the markers (no seeing allies, let alone enemies, through walls)');
  assert.equal(r.instanced, true);
});

test('HUD: alive pips follow the alive count; reload prompt only on an empty magazine with reserve', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const h = g.hud;
    g.teamHud.update(g.teamMatch, { blue: 3, red: 5 }, false);
    const pips = (sel) => [...document.querySelectorAll(sel + ' i')].map((i) => (i.classList.contains('down') ? 0 : 1)).join('');
    const out = { blue: pips('.ta-pips-blue'), red: pips('.ta-pips-red'), count: document.querySelector('.ta-blue').textContent };
    const has = () => h.root.classList.contains('reload-needed');
    h.setWeapon('AR-01', 0, 30, 60, null);
    out.empty = has();
    h.setWeapon('AR-01', 0, 30, 60, 0.3);
    out.reloading = has();
    h.setWeapon('AR-01', 0, 30, 0, null);
    out.noReserve = has();
    h.setWeapon('AR-01', 12, 30, 60, null);
    out.loaded = has();
    h.setWeapon('M9 BAYONET', null, 0, 0, null);
    out.melee = has();
    return out;
  });
  assert.deepEqual([r.blue, r.red, r.count], ['11100', '11111', '3']);
  assert.deepEqual([r.empty, r.reloading, r.noReserve, r.loaded, r.melee], [true, false, false, false, false]);
});

test('kill notice: one notice, restarted (never stacked); a streak within 4 s counts up, then starts over', async () => {
  const r = await page.evaluate(() => {
    const h = window.game.hud;
    const n = h.root.querySelector('.kill-notice');
    const text = () => n.querySelector('.kn-count').textContent;
    const t0 = 1e6;
    h.showKillNotice(t0);
    const a = [text(), n.getAnimations().length];
    h.showKillNotice(t0 + 1500);
    const b = [text(), n.getAnimations().length];
    h.showKillNotice(t0 + 3000);
    const c = text();
    h.showKillNotice(t0 + 9000);
    const d = text();
    return { a, b, c, d, notices: h.root.querySelectorAll('.kill-notice').length };
  });
  assert.deepEqual(r.a, ['', 1]);
  assert.deepEqual(r.b, ['×2', 1], 'second kill: count, still one animation');
  assert.equal(r.c, '×3');
  assert.equal(r.d, '', 'a kill long after: a new streak');
  assert.equal(r.notices, 1);
});

test('a kill is confirmed (and noticed) once per kill key', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    let shown = 0;
    const show = g.hud.showKillNotice.bind(g.hud);
    g.hud.showKillNotice = (t) => {
      shown++;
      show(t);
    };
    const key = g.killKey('bot-9');
    const first = g.killConfirm.confirm(key);
    const again = g.killConfirm.confirm(key);
    g.hud.showKillNotice = show;
    return { first, again, shown };
  });
  assert.deepEqual(r, { first: true, again: false, shown: 1 });
});

test('weapon balance is exactly as recorded (damage, rate of fire, magazine, reload, recoil, spread)', async () => {
  const r = await page.evaluate(async () => {
    const { WEAPONS } = await import('/src/weapons/weapons.ts');
    const out = {};
    for (const [id, d] of Object.entries(WEAPONS)) {
      out[id] = {
        damage: d.damage,
        fireRate: d.fireRate,
        fireMode: d.fireMode,
        magazineSize: d.magazineSize,
        reserveAmmo: d.reserveAmmo,
        reloadTime: d.reloadTime,
        equipTime: d.equipTime,
        pellets: d.pellets ?? 1,
        spread: d.spread,
        recoil: d.recoil,
      };
    }
    return out;
  });
  const expected = await golden('weapon-balance', r);
  assert.deepEqual(asJson(r), expected);
});
