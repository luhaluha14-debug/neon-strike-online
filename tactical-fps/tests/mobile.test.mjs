// Mobile support (Phase 22), one phone in Playwright's mobile emulation
// (touch screen, coarse pointer, no mouse): the game picks the touch
// controls by itself; real multi-touch through Chrome's touch pipeline. The
// move stick, a look drag and the fire button at once; a finger sliding off a
// button; ADS / scope with its own look speed; reload, next weapon and a tap
// on the weapon strip; a cancelled touch, a turn to portrait and a lost focus
// clear every input; the phone HUD and the controls clear of each other at
// several phone sizes, the portrait notice in portrait; the render scale and
// the touch settings saved and kept after a reload; a long session leaves
// nothing behind. Headless Chromium with emulation, not a real phone.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, openGame, installFrameDriver } from './harness.mjs';
import { fingers, centre } from './mobile-touch.mjs';

let env;

before(async () => {
  env = await startEnv();
});
after(async () => {
  await env?.close();
});

async function phone(opts = {}) {
  const page = await openGame(env, { mode: 'training', quality: 'low', width: 740, height: 360, mobile: true, ...opts });
  await page.tap('.play-button');
  await page.waitForFunction(() => window.game.input.active);
  await installFrameDriver(page);
  await page.evaluate(() => {
    window.T.stopLoop();
    window.T.run(30);
  });
  return page;
}

const state = (page) =>
  page.evaluate(() => {
    const g = window.game;
    const s = g.inputState;
    const w = g.weapons.weapon;
    return {
      moveX: +s.moveX.toFixed(3),
      moveY: +s.moveY.toFixed(3),
      fire: s.fire,
      aim: s.aim,
      crouch: s.crouch,
      yaw: g.player.yaw,
      pitch: g.player.pitch,
      pos: [g.player.position.x, g.player.position.z],
      weapon: w.def.id,
      magazine: w.magazine,
      status: w.status,
      scoped: g.scoped,
      fingers: g.input.touch.fingerCount,
    };
  });
const run = (page, n = 1) => page.evaluate((n) => window.T.run(n), n);

test('1: a phone gets the touch controls by itself; the PC parts are hidden; play starts with a tap (no pointer lock)', async () => {
  const page = await phone();
  try {
    const r = await page.evaluate(() => ({
      touch: document.documentElement.classList.contains('touch'),
      ui: !document.querySelector('.touch-ui').hidden,
      lock: !!document.pointerLockElement,
      buttons: [...document.querySelectorAll('.touch-ui .tc-btn')].filter((b) => b.getClientRects().length).map((b) => b.dataset.act),
      pcControls: getComputedStyle(document.querySelector('.pc-controls')).display,
      touchSettings: getComputedStyle(document.querySelector('.touch-settings')).display,
    }));
    assert.equal(r.touch, true);
    assert.equal(r.ui, true);
    assert.equal(r.lock, false, 'no pointer lock on a phone');
    assert.deepEqual(r.buttons.sort(), ['aim', 'board', 'crouch', 'fire', 'jump', 'pause', 'reload', 'weapon'].sort(), 'training: no use / grenade / buy button');
    assert.equal(r.pcControls, 'none');
    assert.notEqual(r.touchSettings, 'none');
    // Pause: the menu, the controls gone; 계속하기 back to play.
    const p = await centre(page, '.tc-pause');
    const f = await fingers(page);
    await f.tap(p.x, p.y);
    assert.equal(await page.evaluate(() => [window.game.input.active, document.querySelector('.touch-ui').hidden]).then((x) => x.join()), 'false,true');
    await page.tap('.play-button');
    assert.equal(await page.evaluate(() => window.game.input.active), true);
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});

test('2, 3, 4: stick, look drag and fire at once (three fingers); a finger sliding off fire keeps firing until it lifts', async () => {
  const page = await phone();
  try {
    const f = await fingers(page);
    const s0 = await state(page);
    const fire = await centre(page, '.tc-fire');
    // Finger 1: stick, pushed forward to the rim.
    await f.start(1, 120, 250);
    await f.move(1, 120, 170, 4);
    // Finger 2: look drag in the free right-middle area.
    await f.start(2, 450, 150);
    await f.move(2, 500, 150, 5);
    // Finger 3: fire.
    await f.start(3, fire.x, fire.y);
    await run(page, 30);
    const s1 = await state(page);
    assert.equal(s1.fingers, 3, 'three fingers tracked');
    assert.ok(s1.moveY > 0.95 && Math.abs(s1.moveX) < 0.05, `forward at full speed (${s1.moveX}, ${s1.moveY})`);
    assert.ok(s1.yaw < s0.yaw - 0.1, `the look drag to the right turned right (${s0.yaw} → ${s1.yaw})`);
    assert.equal(s1.fire, true);
    assert.ok(s1.magazine < s0.magazine, `rounds fired while moving and turning (${s0.magazine} → ${s1.magazine})`);
    assert.ok(Math.hypot(s1.pos[0] - s0.pos[0], s1.pos[1] - s0.pos[1]) > 0.5, 'moved');
    // The fire finger slides off onto the reload button and beyond: still firing, nothing else pressed.
    const reload = await centre(page, '.tc-reload');
    await f.move(3, reload.x, reload.y, 3);
    await run(page, 5);
    const s2 = await state(page);
    assert.equal(s2.fire, true, 'still firing after sliding off');
    assert.notEqual(s2.status, 'reloading', 'sliding over 장전 does not press it');
    // Lift fire: no more fire; the stick keeps moving.
    await f.end(3);
    await run(page, 2);
    const s3 = await state(page);
    assert.equal(s3.fire, false);
    assert.ok(s3.moveY > 0.95);
    // Lift the stick: stop.
    await f.end(1);
    await f.end(2);
    await run(page, 2);
    const s4 = await state(page);
    assert.deepEqual([s4.moveX, s4.moveY, s4.fingers], [0, 0, 0]);
    // Half-way stick: slower, never faster than the keyboard (full deflection = 1).
    await f.start(4, 120, 250);
    await f.move(4, 150, 250, 3);
    await run(page, 1);
    const s5 = await state(page);
    assert.ok(s5.moveX > 0.2 && s5.moveX < 0.6, `partial stick (${s5.moveX})`);
    await f.move(4, 400, 250, 3);
    await run(page, 1);
    assert.ok((await state(page)).moveX <= 1);
    await f.end(4);
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});

test('5, 6: ADS toggles the scope with its own look speed; reload; next weapon; a tap on the weapon strip', async () => {
  const page = await phone();
  try {
    const f = await fingers(page);
    const tapOn = async (sel) => {
      const c = await centre(page, sel);
      await f.tap(c.x, c.y);
      await run(page, 2);
    };
    // Fire a few, then 장전.
    const fire = await centre(page, '.tc-fire');
    await f.start(1, fire.x, fire.y);
    await run(page, 20);
    await f.end(1);
    const before = await state(page);
    assert.ok(before.magazine < 30);
    await tapOn('.tc-reload');
    assert.equal((await state(page)).status, 'reloading');
    await run(page, 400);
    assert.equal((await state(page)).magazine, 30, 'reloaded');
    // 무기: the next weapon (SR-01), then the strip's third entry (the knife).
    await tapOn('.tc-weapon');
    await run(page, 200);
    assert.equal((await state(page)).weapon, 'sr01');
    await tapOn('.hud .loadout .slot[data-slot="2"]');
    await run(page, 200);
    assert.equal((await state(page)).weapon, 'karambit');
    await tapOn('.hud .loadout .slot[data-slot="1"]');
    await run(page, 200);
    assert.equal((await state(page)).weapon, 'sr01');
    // 조준 with the SR-01: scoped; the same drag turns less (scope × ADS look speed).
    const drag = async () => {
      const a = (await state(page)).yaw;
      await f.start(2, 450, 180);
      await f.move(2, 520, 180, 5);
      await f.end(2);
      await run(page, 1);
      return (await state(page)).yaw - a;
    };
    const free = await drag();
    await tapOn('.tc-aim');
    await run(page, 60);
    const sc = await state(page);
    assert.equal(sc.aim, true);
    assert.equal(sc.scoped, true, 'scoped');
    const zoomed = await drag();
    const k = await page.evaluate(() => window.game.weapons.weapon.def.scope.sensitivity * 0.7);
    assert.ok(Math.abs(zoomed / free - k) < 0.05, `look speed while scoped: ${(zoomed / free).toFixed(3)} (expected ${k.toFixed(3)})`);
    // 조준 again: off.
    await tapOn('.tc-aim');
    await run(page, 10);
    assert.equal((await state(page)).scoped, false);
    // 앉기 toggles crouch.
    await tapOn('.tc-crouch');
    assert.equal((await state(page)).crouch, true);
    await tapOn('.tc-crouch');
    assert.equal((await state(page)).crouch, false);
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});

test('7: a cancelled touch, a turn to portrait and a lost focus each clear every input; portrait shows the notice', async () => {
  const page = await phone();
  try {
    const f = await fingers(page);
    const press = async () => {
      const fire = await centre(page, '.tc-fire');
      const aim = await centre(page, '.tc-aim');
      await f.tap(aim.x, aim.y, 50);
      await f.start(1, 120, 250);
      await f.move(1, 160, 200, 2);
      await f.start(3, fire.x, fire.y);
      await run(page, 2);
      const s = await state(page);
      assert.ok(s.fire && s.aim && s.moveY > 0 && s.fingers === 2, JSON.stringify(s));
    };
    const cleared = async (why) => {
      await run(page, 2);
      const s = await state(page);
      assert.deepEqual([s.fire, s.aim, s.moveX, s.moveY, s.fingers], [false, false, 0, 0, 0], `${why}: everything let go`);
    };
    await press();
    await f.cancel();
    await cleared('touch cancelled');
    await press();
    await page.setViewportSize({ width: 360, height: 740 });
    await page.waitForTimeout(100);
    await cleared('turned to portrait');
    const notice = await page.evaluate(() => {
      const n = document.querySelector('.tc-rotate');
      const b = n.getBoundingClientRect();
      return { display: getComputedStyle(n).display, covers: b.width >= innerWidth - 1 && b.height >= innerHeight - 1, text: n.textContent };
    });
    assert.equal(notice.display, 'flex');
    assert.equal(notice.covers, true);
    assert.match(notice.text, /가로 화면으로 돌려 주세요/);
    // A touch in portrait does nothing.
    await f.start(5, 100, 600);
    await f.move(5, 100, 500, 2);
    await run(page, 2);
    assert.deepEqual([(await state(page)).moveY, (await state(page)).fingers], [0, 0]);
    await f.end(5);
    await page.setViewportSize({ width: 740, height: 360 });
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.tc-rotate')).display), 'none');
    // Lost focus / the page put away.
    await f.cancel();
    await press();
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await cleared('focus lost');
    await f.cancel();
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});

for (const [w, h] of [
  [740, 360],
  [640, 360],
  [844, 390],
  [932, 430],
]) {
  test(`8: phone HUD at ${w}×${h} (landscape): controls clear of the HUD and of the crosshair; text readable; all on screen`, async () => {
    const page = await phone({ mode: 'team', width: w, height: h });
    try {
      await page.evaluate(() => {
        const l = window.game.teamMatch.scores.get('local');
        Object.assign(l, { kills: 128, deaths: 97, headshots: 64, damage: 18450 });
        const tm = window.game.teamMatch;
        for (let i = 0; i < 5; i++) tm.feed.push({ killer: 'bot-6', victim: 'bot-1', weaponId: 'ar01', head: true, at: tm.elapsed });
        window.T.run(2);
      });
      const r = await page.evaluate(() => {
        const box = (e) => e.getBoundingClientRect().toJSON();
        const vis = (s) => [...document.querySelectorAll(s)].filter((e) => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
        const hud = {
          vitals: vis('.hud .vitals')[0],
          stats: vis('.combat-stats')[0],
          weapon: vis('.hud .weapon')[0],
          bar: vis('.team-hud .team-bar')[0],
          feed: vis('.team-hud .killfeed')[0],
          crosshair: vis('.crosshair')[0],
        };
        const controls = vis('.touch-ui .tc-btn').map((b) => [b.dataset.act, box(b)]);
        controls.push(['stick', box(document.querySelector('.tc-stick'))]);
        const overlaps = [];
        const r0 = (b) => [b.left, b.top, b.right, b.bottom].map(Math.round).join(',');
        for (const [act, c] of controls)
          for (const [k, e] of Object.entries(hud)) {
            if (!e) continue;
            const b = box(e);
            if (c.left < b.right && b.left < c.right && c.top < b.bottom && b.top < c.bottom) overlaps.push(`${act}[${r0(c)}] × ${k}[${r0(b)}]`);
          }
        for (let i = 0; i < controls.length; i++)
          for (let j = i + 1; j < controls.length; j++) {
            const [a, b] = [controls[i][1], controls[j][1]];
            if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) overlaps.push(`${controls[i][0]} × ${controls[j][0]}`);
          }
        const off = [...controls, ...Object.entries(hud).filter(([, e]) => e).map(([k, e]) => [k, box(e)])].filter(([, b]) => b.left < -0.5 || b.top < -0.5 || b.right > innerWidth + 0.5 || b.bottom > innerHeight + 0.5).map(([k]) => k);
        const small = [...document.querySelectorAll('.tc-btn span, .cs-v, .health-value, .ammo-mag')].filter((e) => e.getClientRects().length && parseFloat(getComputedStyle(e).fontSize) < 10).map((e) => e.className);
        const fire = box(document.querySelector('.tc-fire'));
        return { overlaps, off, small, fireSize: fire.width, missing: Object.entries(hud).filter(([, e]) => !e).map(([k]) => k) };
      });
      assert.deepEqual(r.missing, [], 'every HUD part shown');
      assert.deepEqual(r.overlaps, [], 'no control over a HUD part or over another control');
      assert.deepEqual(r.off, [], 'everything on screen');
      assert.deepEqual(r.small, [], 'no text under 10 px');
      assert.ok(r.fireSize >= 64, `fire button large enough (${r.fireSize} px)`);
      assert.deepEqual(page.errors, []);
    } finally {
      await page.context().close();
    }
  });
}

for (const [w, h] of [
  [360, 640],
  [390, 844],
  [430, 932],
]) {
  test(`8: portrait ${w}×${h}: the "turn to landscape" notice covers the screen (menu and game)`, async () => {
    // lobby: true: the notice covers the lobby (a test cannot tap past it, nor can a player).
    const page = await openGame(env, { mode: 'training', quality: 'low', width: w, height: h, mobile: true, lobby: true });
    try {
      const r = await page.evaluate(() => {
        const n = document.querySelector('.tc-rotate');
        const b = n.getBoundingClientRect();
        const top = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
        return { display: getComputedStyle(n).display, covers: b.width >= innerWidth - 1 && b.height >= innerHeight - 1, onTop: n.contains(top) };
      });
      assert.deepEqual(r, { display: 'flex', covers: true, onTop: true });
    } finally {
      await page.context().close();
    }
  });
}

test('8: a PC (1280×720, 1920×1080) never shows touch controls or the portrait notice; its HUD is as before', async () => {
  for (const [w, h] of [
    [1280, 720],
    [1920, 1080],
  ]) {
    const page = await openGame(env, { mode: 'training', quality: 'low', width: w, height: h });
    try {
      const r = await page.evaluate(() => ({
        touch: document.documentElement.classList.contains('touch'),
        ui: !!document.querySelector('.touch-ui'),
        rotate: !!document.querySelector('.tc-rotate'),
        pc: getComputedStyle(document.querySelector('.pc-controls')).display,
        ts: getComputedStyle(document.querySelector('.touch-settings')).display,
        vitalsBottom: getComputedStyle(document.querySelector('.hud .vitals')).bottom,
      }));
      assert.deepEqual(r, { touch: false, ui: false, rotate: false, pc: 'block', ts: 'none', vitalsBottom: '24px' });
    } finally {
      await page.context().close();
    }
  }
});

test('9, 10: render scale and quality: applied at once and kept; a phone starts automatic quality at low; touch settings saved, kept after a reload, reset', async () => {
  // No ?quality: automatic, from the device (a phone: coarse pointer → low).
  const page = await openGame(env, { mode: 'training', quality: null, width: 740, height: 360, mobile: true });
  try {
    const q = await page.evaluate(() => ({ quality: window.game.quality, ratio: window.game.renderer.getPixelRatio() }));
    assert.equal(q.quality, 'low');
    assert.equal(q.ratio, 1, 'low: pixel ratio 1 on a 2× phone screen');
    // 해상도 배율 70%.
    await page.evaluate(() => {
      const s = document.querySelector('select[data-setting="render-scale"]');
      s.value = '0.7';
      s.dispatchEvent(new Event('change', { bubbles: true }));
    });
    assert.equal(await page.evaluate(() => window.game.renderer.getPixelRatio()), 0.7);
    // Touch settings through the page's sliders.
    const set = (k, v) =>
      page.evaluate(
        ([k, v]) => {
          const el = document.querySelector(`input[data-touch="${k}"]`);
          el.value = String(v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        },
        [k, v],
      );
    await set('buttonScale', 1.25);
    await set('opacity', 0.5);
    await set('lookSensitivity', 1.6);
    await set('adsSensitivity', 0.45);
    await set('stickX', 0.22);
    await set('buttonsY', 0.12);
    const pcBefore = await page.evaluate(() => localStorage.getItem('tactical-fps.controls.v1'));
    await page.reload();
    await page.waitForFunction(() => window.game?.player && !document.querySelector('.play-button').disabled);
    const r = await page.evaluate(() => {
      const ui = document.querySelector('.touch-ui');
      return {
        saved: JSON.parse(localStorage.getItem('tactical-fps.touch.v1')),
        css: ['--tc-scale', '--tc-opacity', '--tc-stick-x', '--tc-buttons-y'].map((v) => ui.style.getPropertyValue(v)),
        slider: document.querySelector('input[data-touch="lookSensitivity"]').value,
        ratio: window.game.renderer.getPixelRatio(),
        renderScale: Number(localStorage.getItem('tactical-fps.render.v1')),
        settingsKeys: Object.keys(JSON.parse(localStorage.getItem('tactical-fps.settings.v1') ?? '{}')).sort(),
        pc: localStorage.getItem('tactical-fps.controls.v1'),
      };
    });
    assert.deepEqual(
      { ...r.saved },
      // Phase 25 added the touch conveniences to the record: their defaults (all off) saved alongside.
      { stickX: 0.22, stickY: 0.3, buttonsX: 0.03, buttonsY: 0.12, buttonScale: 1.25, lookSensitivity: 1.6, adsSensitivity: 0.45, opacity: 0.5, aimSmoothing: 0, fireToggle: 0, fireRepeat: 0, minimapLarge: 0, ammoEmphasis: 0, perfPriority: 0 },
    );
    assert.deepEqual(r.css, ['1.25', '0.5', '22%', '12vh']);
    assert.equal(r.slider, '1.6');
    assert.equal(r.renderScale, 0.7);
    assert.ok(!r.settingsKeys.includes('renderScale'), 'the settings record keeps its format (the scale has its own key)');
    assert.equal(r.ratio, 0.7, 'render scale kept after the reload');
    assert.equal(r.pc, pcBefore, 'the PC controls record untouched');
    // 터치 조작 초기화.
    await page.evaluate(() => document.querySelector('.touch-reset').click());
    const reset = await page.evaluate(() => JSON.parse(localStorage.getItem('tactical-fps.touch.v1')));
    assert.deepEqual(reset, {
      stickX: 0.16,
      stickY: 0.3,
      buttonsX: 0.03,
      buttonsY: 0.06,
      buttonScale: 1,
      lookSensitivity: 1,
      adsSensitivity: 0.7,
      opacity: 0.7,
      // Phase 25 conveniences: off by default.
      aimSmoothing: 0,
      fireToggle: 0,
      fireRepeat: 0,
      minimapLarge: 0,
      ammoEmphasis: 0,
      perfPriority: 0,
    });
    // Garbage in storage: defaults within limits.
    await page.evaluate(() => localStorage.setItem('tactical-fps.touch.v1', JSON.stringify({ buttonScale: 99, opacity: 'x', lookSensitivity: -3 })));
    await page.reload();
    await page.waitForFunction(() => window.game?.player);
    const g = await page.evaluate(() => document.querySelector('.touch-ui').style.getPropertyValue('--tc-scale') + '|' + document.querySelector('.touch-ui').style.getPropertyValue('--tc-opacity'));
    assert.equal(g, '1.4|0.7');
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});

test('14: a long session (thousands of ticks, hundreds of touches): no finger left down, no growth in GPU objects, listeners or heap', async () => {
  const page = await phone({
    mode: 'deathmatch',
    init: {
      content: `(() => { let n = 0; const add = EventTarget.prototype.addEventListener; EventTarget.prototype.addEventListener = function (...a) { n++; return add.apply(this, a); }; window.__listeners = () => n; })();`,
    },
  });
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const heap = async () => {
      await cdp.send('HeapProfiler.collectGarbage');
      const m = await cdp.send('Performance.getMetrics');
      return m.metrics.find((x) => x.name === 'JSHeapUsedSize').value / 1048576;
    };
    const f = await fingers(page);
    const fire = await centre(page, '.tc-fire');
    const reload = await centre(page, '.tc-reload');
    const snap = () =>
      page.evaluate(() => {
        const m = window.game.renderer.info.memory;
        return { geometries: m.geometries, textures: m.textures, listeners: window.__listeners(), fingers: window.game.input.touch.fingerCount };
      });
    await page.evaluate(() => {
      for (const b of window.game.squad.bots) b.combat.protection = 1e9;
      window.game.combat.protection = 1e9;
    });
    // Warm-up round of the same actions, then measure.
    const cycle = async (i) => {
      await f.start(1, 120, 250);
      await f.move(1, 120 + (i % 3) * 20, 190, 2);
      await f.start(2, 460, 150);
      await f.move(2, 480 + (i % 5) * 10, 160, 2);
      await f.start(3, fire.x, fire.y);
      await run(page, 12);
      await f.end(3);
      await f.end(2);
      await f.end(1);
      if (i % 4 === 0) await f.tap(reload.x, reload.y);
      await run(page, 8);
    };
    for (let i = 0; i < 20; i++) await cycle(i);
    const a = await snap();
    const h0 = await heap();
    for (let i = 0; i < 150; i++) await cycle(i);
    await run(page, 600);
    const b = await snap();
    const h1 = await heap();
    assert.equal(b.fingers, 0, 'no finger left down');
    assert.deepEqual([b.geometries, b.textures], [a.geometries, a.textures], 'no GPU objects added');
    assert.ok(b.listeners - a.listeners <= 2, `listeners not piling up (${a.listeners} → ${b.listeners})`);
    assert.ok(h1 - h0 < 8, `heap steady (${h0.toFixed(1)} → ${h1.toFixed(1)} MB)`);
    console.log(`[mobile long run] ${JSON.stringify({ a, b, heap: [h0.toFixed(1), h1.toFixed(1)] })}`);
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});
