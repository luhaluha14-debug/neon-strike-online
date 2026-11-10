// Phase 25: 버튼 배치 편집 (move / size / opacity per control, overlap warning, kept inside the safe area,
// save / cancel / default, kept after a reload and on another screen shape, bad data → default) and the
// touch conveniences (발사 버튼 고정, 단발 연속 발사 at the weapon's own rate, 조준 안정화 that adds nothing,
// bigger minimap, ammo emphasis, 프레임 안정 우선). Real touches through Chrome (CDP), phone 740×360.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, openGame, installFrameDriver, waitReady } from './harness.mjs';
import { fingers, centre } from './mobile-touch.mjs';

let env;
before(async () => {
  env = await startEnv();
});
after(async () => {
  await env?.close();
});

const rect = (page, sel) =>
  page.evaluate((sel) => {
    const b = document.querySelector(sel).getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height, left: b.left, top: b.top, right: b.right, bottom: b.bottom };
  }, sel);

async function openEditor(page) {
  await page.tap('#tab-controls');
  await page.tap('.touch-layout-edit');
  await page.waitForFunction(() => !document.querySelector('.tl-editor').hidden);
}

test('버튼 배치 편집: drag (one finger at a time), size, opacity, overlap warning, inside the safe area; nothing reaches the game; 저장 keeps it', async () => {
  const page = await openGame(env, { width: 740, height: 360, mobile: true });
  try {
    await installFrameDriver(page);
    await page.evaluate(() => window.T.stopLoop());
    await openEditor(page);
    // Where the default arrangement shows them (the editor shows the controls as in play).
    const before0 = { fire: await rect(page, '.tc-fire'), aim: await rect(page, '.tc-aim') };
    const shown = await page.evaluate(() => ({
      menuHidden: getComputedStyle(document.querySelector('.overlay')).visibility === 'hidden',
      editing: document.querySelector('.touch-ui').classList.contains('editing'),
      allButtons: [...document.querySelectorAll('.touch-ui .tc-btn')].every((b) => !b.hidden),
      hudPreview: document.querySelector('.hud').classList.contains('playing'),
      handles: [...document.querySelectorAll('.tl-handle')].filter((h) => !h.hidden).length,
    }));
    assert.deepEqual(shown, { menuHidden: true, editing: true, allButtons: true, hudPreview: true, handles: 12 });
    const f = await fingers(page);
    // Drag 발사 to the left middle; a second finger on 조준 meanwhile moves nothing.
    const fire = await centre(page, '.tl-handle[data-id="fire"]');
    const aim = await centre(page, '.tl-handle[data-id="aim"]');
    await f.start(1, fire.x, fire.y);
    await f.start(2, aim.x, aim.y);
    await f.move(2, aim.x - 60, aim.y - 60, 3);
    await f.move(1, 420, 200, 6);
    await f.end(2);
    await f.end(1);
    const moved = { fire: await rect(page, '.tc-fire'), aim: await rect(page, '.tc-aim') };
    assert.ok(Math.abs(moved.fire.x - 420) < 3 && Math.abs(moved.fire.y - 200) < 3, `발사 moved to the finger (${moved.fire.x.toFixed(0)}, ${moved.fire.y.toFixed(0)})`);
    assert.ok(Math.abs(moved.aim.x - before0.aim.x) < 1 && Math.abs(moved.aim.y - before0.aim.y) < 1, 'the second finger moved nothing');
    // Nothing reached the game while editing.
    const input = await page.evaluate(() => {
      const s = window.game.inputState;
      window.game.input.poll(s);
      return { fire: s.fire, moveX: s.moveX, moveY: s.moveY, active: window.game.input.active };
    });
    assert.deepEqual(input, { fire: false, moveX: 0, moveY: 0, active: false });
    // Size and opacity of the selected control (발사).
    await page.evaluate(() => {
      const set = (sel, v) => {
        const el = document.querySelector(sel);
        el.value = String(v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set('.tl-size', 1.4);
      set('.tl-opacity', 0.4);
    });
    const big = await rect(page, '.tc-fire');
    assert.ok(Math.abs(big.w / before0.fire.w - 1.4) < 0.03, `size ×1.4 (${(big.w / before0.fire.w).toFixed(2)})`);
    assert.equal(await page.evaluate(() => document.querySelector('.tc-fire').style.opacity), '0.4');
    // Drag 점프 onto 발사: the overlap is marked and named.
    const jump = await centre(page, '.tl-handle[data-id="jump"]');
    await f.start(3, jump.x, jump.y);
    await f.move(3, 420, 200, 4);
    await f.end(3);
    const warn = await page.evaluate(() => ({ text: document.querySelector('.tl-warn').textContent, marked: [...document.querySelectorAll('.tl-handle.warn')].map((h) => h.dataset.id).sort() }));
    assert.match(warn.text, /겹치는 버튼: .*발사/);
    assert.deepEqual(warn.marked, ['fire', 'jump']);
    // Off the edge: kept inside the screen.
    const jh = await centre(page, '.tl-handle[data-id="jump"]');
    await f.start(4, jh.x, jh.y);
    await f.move(4, 735, 358, 6);
    await f.end(4);
    const edge = await rect(page, '.tc-jump');
    assert.ok(edge.right <= 740 && edge.bottom <= 360 && edge.left >= 0 && edge.top >= 0, `inside the screen ${JSON.stringify(edge)}`);
    // 저장: kept (relative positions), the editor and the preview gone, the menu back.
    await page.tap('.tl-save');
    const saved = await page.evaluate(() => ({
      stored: JSON.parse(localStorage.getItem('tactical-fps.touch-layout.v1')),
      editor: document.querySelector('.tl-editor').hidden,
      editing: document.querySelector('.touch-ui').classList.contains('editing'),
      menu: getComputedStyle(document.querySelector('.overlay')).visibility,
      state: document.querySelector('.touch-layout-state').textContent,
    }));
    assert.equal(saved.stored.v, 1);
    assert.ok(saved.stored.controls.fire && saved.stored.controls.jump);
    assert.ok(saved.stored.controls.fire.x > 0 && saved.stored.controls.fire.x < 1 && saved.stored.controls.fire.size === 1.4 && saved.stored.controls.fire.opacity === 0.4);
    assert.deepEqual([saved.editor, saved.editing, saved.menu, saved.state], [true, false, 'visible', '(내 배치 사용 중)']);
    // In play: the moved 발사 fires.
    await page.tap('#tab-play');
    await page.tap('.play-button');
    await page.waitForFunction(() => window.game.input.active);
    const firePlay = await rect(page, '.tc-fire');
    await f.start(5, firePlay.x, firePlay.y);
    await page.evaluate(() => window.T.run(2));
    assert.equal(await page.evaluate(() => window.game.inputState.fire), true, 'the moved button fires');
    await f.end(5);
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});

test('the layout after a reload and on another screen shape; 취소 puts back, 기본 배치 returns the built-in arrangement; bad stored data → default', async () => {
  const page = await openGame(env, { width: 740, height: 360, mobile: true });
  try {
    const defaults = await page.evaluate(() =>
      Object.fromEntries([...document.querySelectorAll('.touch-ui .tc-btn')].map((b) => {
        const touch = document.querySelector('.touch-ui');
        const hid = touch.hidden;
        touch.hidden = false;
        const r = b.getBoundingClientRect();
        touch.hidden = hid;
        return [b.dataset.act, [Math.round(r.left), Math.round(r.top)]];
      })),
    );
    // A stored layout (as the editor saves it): 발사 at the centre of the safe area.
    await page.evaluate(() => localStorage.setItem('tactical-fps.touch-layout.v1', JSON.stringify({ v: 1, controls: { fire: { x: 0.5, y: 0.5, size: 1, opacity: 0.8 } } })));
    await page.reload();
    await waitReady(page);
    await page.evaluate(() => (document.querySelector('.touch-ui').hidden = false));
    const a = await rect(page, '.tc-fire');
    assert.ok(Math.abs(a.x - 370) < 2 && Math.abs(a.y - 180) < 2, `restored at the centre (${a.x}, ${a.y})`);
    // Another screen shape (a taller phone): still the centre, relatively.
    await page.setViewportSize({ width: 844, height: 390 });
    // Refitted on the next drawn frame (the layer's size observed): slow on the software renderer.
    await page.waitForFunction(() => Math.abs(document.querySelector('.tc-fire').getBoundingClientRect().left + document.querySelector('.tc-fire').getBoundingClientRect().width / 2 - innerWidth / 2) < 2, null, { timeout: 5000 }).catch(() => {});
    const b = await rect(page, '.tc-fire');
    assert.ok(Math.abs(b.x - 422) < 2 && Math.abs(b.y - 195) < 2, `relative on 844×390 (${b.x}, ${b.y})`);
    await page.setViewportSize({ width: 740, height: 360 });
    await page.waitForFunction(() => Math.abs(document.querySelector('.tc-fire').getBoundingClientRect().left + document.querySelector('.tc-fire').getBoundingClientRect().width / 2 - 370) < 2, null, { timeout: 5000 }).catch(() => {});
    await page.evaluate(() => (document.querySelector('.touch-ui').hidden = true));
    // 취소: a drag undone.
    await openEditor(page);
    const f = await fingers(page);
    const h = await centre(page, '.tl-handle[data-id="fire"]');
    await f.start(1, h.x, h.y);
    await f.move(1, 200, 120, 5);
    await f.end(1);
    await page.tap('.tl-cancel');
    await page.evaluate(() => (document.querySelector('.touch-ui').hidden = false));
    const c = await rect(page, '.tc-fire');
    assert.ok(Math.abs(c.x - 370) < 2 && Math.abs(c.y - 180) < 2, '취소: back where it was');
    assert.deepEqual(JSON.parse(await page.evaluate(() => localStorage.getItem('tactical-fps.touch-layout.v1'))).controls.fire.x, 0.5);
    await page.evaluate(() => (document.querySelector('.touch-ui').hidden = true));
    // 기본 배치 + 저장: the built-in arrangement, nothing stored.
    await openEditor(page);
    await page.tap('.tl-reset');
    await page.tap('.tl-save');
    const d = await page.evaluate(() => {
      const touch = document.querySelector('.touch-ui');
      touch.hidden = false;
      const out = Object.fromEntries([...document.querySelectorAll('.touch-ui .tc-btn')].map((b) => [b.dataset.act, [Math.round(b.getBoundingClientRect().left), Math.round(b.getBoundingClientRect().top)]]));
      touch.hidden = true;
      return { pos: out, stored: localStorage.getItem('tactical-fps.touch-layout.v1'), placed: document.querySelectorAll('.touch-ui .placed').length };
    });
    assert.equal(d.stored, null);
    assert.equal(d.placed, 0);
    for (const [act, p] of Object.entries(defaults)) if (!['use', 'utility', 'buy'].includes(act)) assert.deepEqual(d.pos[act], p, `${act}: the built-in place`);
    // Bad stored data (out of range / unknown control / not JSON): the built-in arrangement, no error.
    for (const bad of ['{"v":1,"controls":{"fire":{"x":3,"y":0.5,"size":1,"opacity":1}}}', '{"v":1,"controls":{"rocket":{"x":0.5,"y":0.5,"size":1,"opacity":1}}}', 'not json', '{"v":2,"controls":{}}']) {
      await page.evaluate((v) => localStorage.setItem('tactical-fps.touch-layout.v1', v), bad);
      await page.reload();
      await waitReady(page);
      assert.equal(await page.evaluate(() => document.querySelectorAll('.touch-ui .placed').length), 0, `default for ${bad}`);
    }
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});

async function phonePlaying(opts) {
  const page = await openGame(env, { width: 740, height: 360, mobile: true, ...opts });
  await page.evaluate(async () => {
    const { WEAPONS } = await import('/src/weapons/weapons.ts');
    window.__W = WEAPONS;
  });
  await page.tap('.play-button');
  await page.waitForFunction(() => window.game.input.active);
  await installFrameDriver(page);
  await page.evaluate(() => {
    window.T.stopLoop();
    for (const t of window.game.trainingRange.targets) window.game.hitscan.unregister(t);
    window.T.run(30);
  });
  return page;
}
const setTouch = (page, patch) =>
  page.evaluate((patch) => {
    const g = window.game;
    Object.assign(g.touchSettings, patch);
    g.input.touch.applySettings(g.touchSettings);
    g['applyTouchConveniences']();
  }, patch);

test('발사 버튼 고정 (tap on / tap off) and 단발 연속 발사 (each round when the weapon allows: its own rate)', async () => {
  const page = await phonePlaying();
  try {
    const f = await fingers(page);
    const fire = await centre(page, '.tc-fire');
    // Toggle: one tap fires on until the next tap.
    await setTouch(page, { fireToggle: 1 });
    await f.tap(fire.x, fire.y);
    const on = await page.evaluate(() => {
      window.T.run(20);
      return [window.game.inputState.fire, document.querySelector('.tc-fire').classList.contains('on')];
    });
    await f.tap(fire.x, fire.y);
    const off = await page.evaluate(() => {
      window.T.run(5);
      return window.game.inputState.fire;
    });
    assert.deepEqual([...on, off], [true, true, false]);
    await setTouch(page, { fireToggle: 0 });
    // A semi-automatic pistol held for 1 s: one round without the option; with it, one round each
    // time the pistol is ready (its 340 RPM: no faster).
    const held = (repeat) =>
      page.evaluate(async (repeat) => {
        const g = window.game;
        g.weapons.setLoadout([window.__W.pis02, window.__W.karambit]);
        while (g.weapons.weapon.status !== 'ready') window.T.run(1);
        Object.assign(g.touchSettings, { fireRepeat: repeat });
        const s0 = g.weapons.shotsFired;
        return s0;
      }, repeat);
    for (const [repeat, expect] of [
      [0, [1, 1]],
      [1, [5, 6]],
    ]) {
      const s0 = await held(repeat);
      await f.start(1, fire.x, fire.y);
      await page.evaluate(() => window.T.run(60));
      await f.end(1);
      const n = await page.evaluate((s0) => window.game.weapons.shotsFired - s0, s0);
      assert.ok(n >= expect[0] && n <= expect[1], `fireRepeat ${repeat}: ${n} rounds in 1 s (PIS-02 at 340 RPM allows at most 6)`);
      await page.evaluate(() => window.T.run(40));
    }
    // A full-auto weapon is unchanged by the option: its own rate.
    await page.evaluate(() => {
      const g = window.game;
      g.weapons.setLoadout([window.__W.ar01, window.__W.karambit]);
      while (g.weapons.weapon.status !== 'ready') window.T.run(1);
      window.__s0 = g.weapons.shotsFired;
    });
    await f.start(1, fire.x, fire.y);
    await page.evaluate(() => window.T.run(60));
    await f.end(1);
    const auto = await page.evaluate(() => window.game.weapons.shotsFired - window.__s0);
    assert.ok(auto >= 10 && auto <= 11, `AR-01 600 RPM: ${auto} rounds in 1 s`);
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});

test('조준 안정화: the drag turns the view by exactly as much as without it (eased over frames, nothing added); only while aiming', async () => {
  const page = await phonePlaying();
  try {
    const f = await fingers(page);
    const turn = async (smooth, aim) => {
      await setTouch(page, { aimSmoothing: smooth });
      await page.evaluate((aim) => {
        window.game.input.touch['aimOn'] = aim;
        window.T.run(5);
        window.__y0 = window.game.player.yaw;
      }, aim);
      await f.start(2, 450, 200);
      await f.move(2, 530, 200, 4);
      await f.end(2);
      const first = await page.evaluate(() => {
        window.T.run(1);
        return window.game.player.yaw - window.__y0;
      });
      const all = await page.evaluate(() => {
        window.T.run(60);
        return window.game.player.yaw - window.__y0;
      });
      return { first, all };
    };
    const hipPlain = await turn(0, false);
    const hipSmooth = await turn(0.6, false);
    const aimPlain = await turn(0, true);
    const aimSmooth = await turn(0.6, true);
    assert.ok(Math.abs(hipSmooth.first - hipPlain.first) < 1e-6, 'from the hip: no smoothing');
    assert.ok(Math.abs(aimSmooth.all - aimPlain.all) < Math.abs(aimPlain.all) * 0.01, `aimed: the same turn in the end (${aimSmooth.all.toFixed(4)} vs ${aimPlain.all.toFixed(4)})`);
    assert.ok(Math.abs(aimSmooth.first) < Math.abs(aimPlain.first) * 0.7, 'aimed: eased in over frames');
    assert.ok(Math.abs(aimPlain.all) < Math.abs(hipPlain.all), 'the ADS look speed applies while aiming (any gun, not only a scope)');
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});

test('미니맵 크게, 탄약 강조, 프레임 안정 우선: applied, clear of the controls; effects off but the HUD and the rounds unchanged', async () => {
  const page = await phonePlaying();
  try {
    const base = await rect(page, '.minimap');
    await setTouch(page, { minimapLarge: 1, ammoEmphasis: 1, perfPriority: 1 });
    await page.evaluate(() => window.T.run(2));
    const big = await rect(page, '.minimap');
    assert.ok(big.w > base.w, `minimap ${base.w} → ${big.w} px`);
    const clear = await page.evaluate(() => {
      const m = document.querySelector('.minimap').getBoundingClientRect();
      return [...document.querySelectorAll('.touch-ui .tc-btn')].filter((b) => !b.hidden).every((b) => {
        const r = b.getBoundingClientRect();
        return r.right <= m.left || r.left >= m.right || r.bottom <= m.top || r.top >= m.bottom;
      });
    });
    assert.ok(clear, 'the bigger minimap clear of every button');
    const ammo = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.ammo-mag')).fontSize));
    assert.equal(ammo, 26);
    const fx = await page.evaluate(() => {
      const g = window.game;
      g.input.mouseButtons = 0;
      window.T.run(2);
      return { casings: g.casings.enabled, flash: g.viewModel.flash.detail };
    });
    assert.deepEqual(fx, { casings: false, flash: 'low' });
    await setTouch(page, { perfPriority: 0 });
    const back = await page.evaluate(() => {
      window.T.run(2);
      const g = window.game;
      return { flash: g.viewModel.flash.detail, quality: g.quality, casings: g.casings.enabled };
    });
    // Back to what the graphics level gives (this page runs at low: its flash detail is 'low' anyway).
    assert.equal(back.flash, back.quality, 'effects back to the graphics level when the option is off');
    assert.equal(back.casings, back.quality !== 'low');
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});
