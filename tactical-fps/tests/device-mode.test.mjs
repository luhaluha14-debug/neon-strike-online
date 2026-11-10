// Phase 25: PC / phone / tablet told apart from several signals together (pointer, hover, touch points,
// screen and orientation, the input actually used), never the width alone; 조작 방식 auto / PC / 모바일,
// the player's choice over the detection, kept after a reload; switching lets go of everything held.

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

const sig = (o) => ({ coarse: false, anyFine: true, anyHover: true, touchPoints: 0, shortSide: 900, landscape: true, ...o });

test('classify: phone, tablet, tablet + keyboard / trackpad, touch laptop, desktop; a narrow desktop window stays a PC', async () => {
  const page = await openGame(env, { width: 640, height: 360 });
  try {
    const r = await page.evaluate(async (cases) => {
      const { classify, resolveTouch, touchFromInput } = await import('/src/input/DeviceMode.ts');
      const out = {};
      for (const [name, s] of Object.entries(cases)) out[name] = classify(s);
      out.choice = {
        autoPhone: resolveTouch('auto', out.phone, null),
        pcOnPhone: resolveTouch('pc', out.phone, null),
        mobileOnDesktop: resolveTouch('mobile', out.desktop, null),
        urlWins: resolveTouch('pc', out.phone, true),
      };
      const ev = (pointerType) => ({ pointerType });
      out.input = {
        mouseOnTouchTablet: touchFromInput(ev('mouse'), true, cases.tabletKeyboard),
        mouseOnPhoneEmulated: touchFromInput(ev('mouse'), true, cases.phone),
        fingerOnTouchLaptop: touchFromInput(ev('touch'), false, cases.touchLaptop),
        fingerOnDesktop: touchFromInput(ev('touch'), false, cases.desktop),
        penNoChange: touchFromInput(ev('pen'), true, cases.tabletKeyboard),
      };
      return out;
    }, {
      phone: sig({ coarse: true, anyFine: false, anyHover: false, touchPoints: 5, shortSide: 390 }),
      tablet: sig({ coarse: true, anyFine: false, anyHover: false, touchPoints: 5, shortSide: 820 }),
      tabletKeyboard: sig({ coarse: true, anyFine: true, anyHover: true, touchPoints: 5, shortSide: 820 }),
      touchLaptop: sig({ coarse: false, anyFine: true, anyHover: true, touchPoints: 10, shortSide: 900 }),
      desktop: sig({}),
      narrowDesktop: sig({ shortSide: 360 }),
    });
    assert.deepEqual([r.phone.kind, r.phone.touch], ['phone', true]);
    assert.deepEqual([r.tablet.kind, r.tablet.touch], ['tablet', true]);
    assert.deepEqual([r.tabletKeyboard.kind, r.tabletKeyboard.touch], ['tablet', false], 'a tablet with a keyboard / trackpad: PC controls');
    assert.deepEqual([r.touchLaptop.kind, r.touchLaptop.touch], ['desktop', false], 'a touch laptop with a mouse stays a PC');
    assert.deepEqual([r.desktop.kind, r.desktop.touch], ['desktop', false]);
    assert.deepEqual([r.narrowDesktop.kind, r.narrowDesktop.touch], ['desktop', false], 'not decided by the screen width');
    assert.deepEqual(r.choice, { autoPhone: true, pcOnPhone: false, mobileOnDesktop: true, urlWins: true }, "the player's choice over the detection; ?touch= over both");
    assert.deepEqual(r.input, { mouseOnTouchTablet: false, mouseOnPhoneEmulated: null, fingerOnTouchLaptop: true, fingerOnDesktop: null, penNoChange: null });
  } finally {
    await page.context().close();
  }
});

test('PC (auto): keyboard + mouse; 모바일 chosen: touch controls at once and after a reload; PC again: gone; nothing held carries over', async () => {
  const page = await openGame(env, { width: 1280, height: 720 });
  try {
    const state = () =>
      page.evaluate(() => ({
        touch: document.documentElement.classList.contains('touch'),
        controls: !!document.querySelector('.touch-ui'),
        rotate: !!document.querySelector('.tc-rotate'),
        setting: document.querySelector('select[data-setting="input-mode"]').value,
        info: document.querySelector('.input-mode-detected').textContent,
        touchPage: getComputedStyle(document.querySelector('.touch-settings')).display !== 'none',
        stored: localStorage.getItem('tactical-fps.input-mode.v1'),
      }));
    const a = await state();
    assert.deepEqual([a.touch, a.controls, a.setting], [false, false, 'auto']);
    assert.match(a.info, /감지: PC/);
    // Hold W, then switch: no key carries over into the touch controls.
    await page.click('#tab-controls');
    await page.keyboard.down('KeyW');
    await page.selectOption('select[data-setting="input-mode"]', 'mobile');
    const b = await state();
    assert.deepEqual([b.touch, b.controls, b.rotate, b.setting, b.stored, b.touchPage], [true, true, true, 'mobile', 'mobile', true]);
    assert.match(b.info, /직접 선택 → 터치 조작/);
    const held = await page.evaluate(() => {
      const s = window.game.inputState;
      window.game.input.poll(s);
      return { moveY: s.moveY, fire: s.fire };
    });
    await page.keyboard.up('KeyW');
    assert.deepEqual(held, { moveY: 0, fire: false }, 'the held key let go by the switch');
    // Kept after a reload.
    await page.reload();
    await page.waitForFunction(() => window.game && window.game.weapons && !document.querySelector('.play-button').disabled);
    const c = await state();
    assert.deepEqual([c.touch, c.controls, c.setting], [true, true, 'mobile'], 'the choice kept after a reload');
    // Back to PC: the touch controls and the portrait notice removed.
    await page.evaluate(() => {
      const s = document.querySelector('select[data-setting="input-mode"]');
      s.value = 'pc';
      s.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const d = await state();
    assert.deepEqual([d.touch, d.controls, d.rotate, d.setting, d.stored], [false, false, false, 'pc', 'pc']);
    // Auto again: the detection decides (a PC here).
    await page.evaluate(() => {
      const s = document.querySelector('select[data-setting="input-mode"]');
      s.value = 'auto';
      s.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const e = await state();
    assert.deepEqual([e.touch, e.setting, e.stored], [false, 'auto', 'auto']);
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});

test('phone (auto): touch controls; PC chosen on the phone: the PC HUD; 모바일 again: the touch controls with no finger or toggle left over', async () => {
  const page = await openGame(env, { width: 740, height: 360, mobile: true });
  try {
    const touch = () => page.evaluate(() => [document.documentElement.classList.contains('touch'), !!document.querySelector('.touch-ui'), document.querySelector('.input-mode-detected').textContent]);
    const a = await touch();
    assert.deepEqual(a.slice(0, 2), [true, true]);
    assert.match(a[2], /감지: 휴대폰/);
    // Play, crouch on (a toggle), hold fire; then pause and switch.
    await page.tap('.play-button');
    await page.waitForFunction(() => window.game.input.active);
    await installFrameDriver(page);
    await page.evaluate(() => window.T.stopLoop());
    const f = await fingers(page);
    const crouch = await centre(page, '.tc-crouch');
    await f.tap(crouch.x, crouch.y);
    const fire = await centre(page, '.tc-fire');
    await f.start(1, fire.x, fire.y);
    await page.evaluate(() => window.T.run(3));
    assert.equal(await page.evaluate(() => window.game.inputState.crouch && window.game.inputState.fire), true);
    await page.evaluate(() => window.game.input.release());
    await f.cancel();
    await page.evaluate(() => {
      const s = document.querySelector('select[data-setting="input-mode"]');
      s.value = 'pc';
      s.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const b = await touch();
    assert.deepEqual(b.slice(0, 2), [false, false], 'PC controls on the phone');
    await page.evaluate(() => {
      const s = document.querySelector('select[data-setting="input-mode"]');
      s.value = 'mobile';
      s.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const c = await page.evaluate(() => {
      const g = window.game;
      const s = g.inputState;
      g.input.poll(s);
      return { touch: document.documentElement.classList.contains('touch'), fingers: g.input.touch.fingerCount, crouch: s.crouch, fire: s.fire };
    });
    assert.deepEqual(c, { touch: true, fingers: 0, crouch: false, fire: false });
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});
