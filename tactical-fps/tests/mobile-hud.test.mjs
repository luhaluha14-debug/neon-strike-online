// Phase 29 — the phone HUD: 미니멀 HUD (health, ammo, minimap, score / time only; nothing near the crosshair),
// the layout editor's new parts (− / + size, 숨기기 / 다시 보이기, the minimal preview), hidden buttons in play,
// pressed buttons fully visible, many screen sizes (phones, tablets) without overlaps or controls off the screen,
// a layout kept on another screen shape, stored data checked (Phase 25 layouts still apply, bad data →
// default), and the PC HUD unchanged. Phone emulation in headless Chromium with real touches (CDP).

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

/** Opens a phone page with these stored touch settings / layout, in play (frames driven by the test). */
async function phone({ width = 740, height = 360, mode = 'team', settings = null, layout = null } = {}) {
  const page = await openGame(env, { mode, width, height, mobile: true, quality: 'low' });
  if (settings || layout) {
    await page.evaluate(
      ({ settings, layout }) => {
        if (settings) localStorage.setItem('tactical-fps.touch.v1', JSON.stringify(settings));
        if (layout) localStorage.setItem('tactical-fps.touch-layout.v1', JSON.stringify(layout));
      },
      { settings, layout },
    );
    await page.reload();
    await waitReady(page);
  }
  await page.tap('.play-button');
  await page.waitForFunction(() => window.game.input.active);
  await installFrameDriver(page);
  await page.evaluate(() => {
    window.T.stopLoop();
    window.T.run(30);
  });
  return page;
}

/**
 * What is on the screen: each element (by selector) shown, its rectangle; the crosshair's clear zone (the
 * middle 30 % × 34 % of the screen); the touch buttons in play.
 */
const survey = (page) =>
  page.evaluate(() => {
    const shown = (el) => el && el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true }) && el.getBoundingClientRect().width > 0;
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height };
    };
    const W = innerWidth;
    const H = innerHeight;
    const zone = { left: W * 0.35, right: W * 0.65, top: H * 0.33, bottom: H * 0.67 };
    const hits = (b) => Math.min(b.right, zone.right) - Math.max(b.left, zone.left) > 0 && Math.min(b.bottom, zone.bottom) - Math.max(b.top, zone.top) > 0;
    const panels = {};
    for (const [k, sel] of Object.entries({
      vitals: '.vitals',
      ammo: '.weapon .ammo',
      minimap: '.minimap',
      bar: '.match-bar',
      stats: '.combat-stats',
      strip: '.weapon .loadout',
      money: '.ta.money',
      alive: '.team-alive',
      banner: '.round-banner',
      bomb: '.bomb-box',
      notice: '.hud-notice',
      net: '.net-status',
    })) {
      const el = [...document.querySelectorAll(sel)].find(shown);
      panels[k] = el ? box(el) : null;
    }
    const buttons = {};
    for (const el of document.querySelectorAll('.touch-ui .tc-btn, .touch-ui .tc-stick')) {
      if (!shown(el)) continue;
      buttons[el.dataset.act ?? 'stick'] = box(el);
    }
    const inZone = [
      ...Object.entries(panels)
        .filter(([, b]) => b && hits(b))
        .map(([k]) => k),
      ...Object.entries(buttons)
        .filter(([, b]) => hits(b))
        .map(([k]) => k),
    ];
    const off = Object.entries(buttons)
      .filter(([, b]) => b.left < -0.5 || b.top < -0.5 || b.right > W + 0.5 || b.bottom > H + 0.5)
      .map(([k]) => k);
    const ids = Object.keys(buttons);
    const overlaps = [];
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const a = buttons[ids[i]];
        const b = buttons[ids[j]];
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2) overlaps.push(`${ids[i]}+${ids[j]}`);
      }
    return { W, H, panels, buttons, inZone, off, overlaps, minimal: document.documentElement.classList.contains('tc-minimal') };
  });

test('1. 미니멀 HUD: off by default; on (settings), the personal record, weapon strip, money / role line and hints go; health, ammo, minimap and the score bar stay; nothing over the crosshair; kept after a reload; off again restores', async () => {
  const page = await phone({ mode: 'team' });
  try {
    const before0 = await survey(page);
    assert.equal(before0.minimal, false, 'off by default');
    assert.ok(before0.panels.stats && before0.panels.strip, 'the full HUD as before');
    // On from the settings page (as a player would: the 조작 tab's toggle).
    await page.evaluate(() => {
      const el = document.querySelector('input[data-touch-toggle="minimalHud"]');
      el.checked = true;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      window.T.run(2);
    });
    const on = await survey(page);
    assert.equal(on.minimal, true);
    assert.deepEqual([on.panels.stats, on.panels.strip, on.panels.money], [null, null, null], 'the record, the strip and the money line go');
    for (const k of ['vitals', 'ammo', 'minimap', 'bar']) assert.ok(on.panels[k], `${k} stays`);
    assert.deepEqual(on.inZone, [], `nothing over the crosshair (${on.inZone})`);
    // The round banner (작전 준비) up under the score bar, off the crosshair.
    assert.ok(on.panels.banner && on.panels.banner.bottom < on.H * 0.33, JSON.stringify(on.panels.banner));
    // Kept after a reload.
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('tactical-fps.touch.v1')).minimalHud), 1);
    await page.reload();
    await waitReady(page);
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('tc-minimal')), true, 'kept after a reload');
    // Off again: the full HUD back.
    await page.evaluate(() => {
      const el = document.querySelector('input[data-touch-toggle="minimalHud"]');
      el.checked = false;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.tap('.play-button');
    await page.waitForFunction(() => window.game.input.active);
    const off = await survey(page);
    assert.equal(off.minimal, false);
    assert.ok(off.panels.stats && off.panels.strip, 'restored');
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});

test('2. phones and tablets in landscape (11 sizes), full and minimal HUD: no two controls overlap, none off the screen, none over the crosshair; tablets get bigger controls', async () => {
  const sizes = [
    [568, 320],
    [640, 360],
    [667, 375],
    [740, 360],
    [812, 375],
    [844, 390],
    [932, 430],
    [1024, 600],
    [1024, 768],
    [1180, 820],
    [1366, 1024],
  ];
  const fire = {};
  for (const minimal of [0, 1]) {
    for (const [w, h] of sizes) {
      const page = await phone({ width: w, height: h, mode: 'team', settings: { minimalHud: minimal } });
      try {
        const s = await survey(page);
        const tag = `${w}×${h} ${minimal ? 'minimal' : 'full'}`;
        assert.deepEqual(s.overlaps, [], `${tag}: overlaps`);
        assert.deepEqual(s.off, [], `${tag}: off the screen`);
        const zoneButtons = s.inZone.filter((k) => s.buttons[k]);
        assert.deepEqual(zoneButtons, [], `${tag}: controls over the crosshair`);
        if (minimal) assert.deepEqual(s.inZone, [], `${tag}: HUD over the crosshair`);
        for (const k of ['vitals', 'ammo', 'minimap']) assert.ok(s.panels[k], `${tag}: ${k} shown`);
        if (!minimal) fire[`${w}x${h}`] = s.buttons.fire.w;
        assert.deepEqual(page.errors, []);
      } finally {
        await page.context().close();
      }
    }
  }
  assert.ok(fire['1180x820'] > fire['932x430'] * 1.1, `tablet controls bigger (${fire['1180x820']} vs ${fire['932x430']})`);
});

async function openEditor(page) {
  await page.evaluate(() => window.game.input.release());
  await page.tap('#tab-controls');
  await page.tap('.touch-layout-edit');
  await page.waitForFunction(() => !document.querySelector('.tl-editor').hidden);
}
const select = async (page, id) => {
  const f = await fingers(page);
  const c = await centre(page, `.tl-handle[data-id="${id}"]`);
  await f.tap(c.x, c.y);
};

test('3. the editor: − / + size and opacity of the selected control; 숨기기 for 점수판 (not for 발사, 이동, 일시정지); hidden in play, takes no touch; faded in the editor and brought back; 저장 keeps it after a reload; 기본 배치 restores all', async () => {
  const page = await phone({ mode: 'deathmatch' });
  try {
    await openEditor(page);
    // − / +: 장전 one step bigger twice, one smaller.
    await select(page, 'reload');
    assert.equal(await page.textContent('.tl-name'), '장전');
    const w0 = (await page.evaluate(() => document.querySelector('.tc-reload').getBoundingClientRect().width));
    await page.tap('.tl-bigger');
    await page.tap('.tl-bigger');
    await page.tap('.tl-smaller');
    const sized = await page.evaluate(() => ({ out: document.querySelector('.tl-size-out').textContent, w: document.querySelector('.tc-reload').getBoundingClientRect().width, size: window.game.layoutEditor.current.controls.reload.size }));
    assert.equal(sized.out, '110%');
    assert.equal(sized.size, 1.1);
    assert.ok(Math.abs(sized.w / w0 - 1.1) < 0.02, `drawn 110 % (${(sized.w / w0).toFixed(3)})`);
    await page.evaluate(() => {
      const el = document.querySelector('.tl-opacity');
      el.value = '0.35';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Locked controls: no 숨기기.
    for (const id of ['fire', 'stick', 'pause']) {
      await select(page, id);
      assert.equal(await page.evaluate(() => document.querySelector('.tl-hide').disabled), true, `${id} cannot be hidden`);
    }
    // 점수판: hidden (faded here, named, not counted as overlapping).
    await select(page, 'board');
    await page.tap('.tl-hide');
    const ed = await page.evaluate(() => ({
      btn: document.querySelector('.tl-hide').textContent,
      note: document.querySelector('.tl-hidden-note').textContent,
      faded: document.querySelector('.tl-handle[data-id="board"]').classList.contains('is-hidden'),
      opacity: getComputedStyle(document.querySelector('.tc-board')).opacity,
    }));
    assert.deepEqual([ed.btn, ed.faded, +ed.opacity < 0.3], ['다시 보이기', true, true]);
    assert.match(ed.note, /숨긴 버튼 1개/);
    await page.tap('.tl-save');
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('tactical-fps.touch-layout.v1')));
    assert.equal(stored.controls.board.hidden, true);
    assert.equal(stored.controls.reload.size, 1.1);
    assert.equal(stored.controls.reload.opacity, 0.35);
    // In play: no 점수판 button, a tap where it was does nothing.
    await page.tap('#tab-play');
    await page.tap('.play-button');
    await page.waitForFunction(() => window.game.input.active);
    const inPlay = await page.evaluate(() => ({ shown: document.querySelector('.tc-board').checkVisibility(), hidden: window.game.input.touch.hiddenControls }));
    assert.deepEqual(inPlay, { shown: false, hidden: ['board'] });
    // After a reload: the same.
    await page.reload();
    await waitReady(page);
    await page.tap('.play-button');
    await page.waitForFunction(() => window.game.input.active);
    assert.deepEqual(await page.evaluate(() => window.game.input.touch.hiddenControls), ['board'], 'kept after a reload');
    // Brought back in the editor, then 기본 배치: everything as built in.
    await openEditor(page);
    await select(page, 'board');
    assert.equal(await page.textContent('.tl-hide'), '다시 보이기');
    await page.tap('.tl-hide');
    assert.equal(await page.evaluate(() => window.game.layoutEditor.current.controls.board.hidden), undefined);
    await page.tap('.tl-reset');
    await page.tap('.tl-save');
    assert.equal(await page.evaluate(() => localStorage.getItem('tactical-fps.touch-layout.v1')), null, 'the default arrangement (no stored layout)');
    assert.deepEqual(await page.evaluate(() => window.game.input.touch.hiddenControls), []);
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});

test('4. the editor previews the minimal HUD behind the controls: 저장 keeps it (a touch setting), 취소 puts back what was there', async () => {
  const page = await phone({ mode: 'team' });
  try {
    await openEditor(page);
    await page.tap('.tl-minimal-in');
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('tc-minimal')), true, 'previewed');
    await page.tap('.tl-cancel');
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('tc-minimal')), false, '취소: back to the full HUD');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('tactical-fps.touch.v1') ?? '{}').minimalHud ?? 0), 0);
    await page.tap('.touch-layout-edit');
    await page.waitForFunction(() => !document.querySelector('.tl-editor').hidden);
    await page.tap('.tl-minimal-in');
    await page.tap('.tl-save');
    const r = await page.evaluate(() => ({
      cls: document.documentElement.classList.contains('tc-minimal'),
      stored: JSON.parse(localStorage.getItem('tactical-fps.touch.v1')).minimalHud,
      box: document.querySelector('input[data-touch-toggle="minimalHud"]').checked,
    }));
    assert.deepEqual(r, { cls: true, stored: 1, box: true });
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});

test('5. a held button is fully visible whatever its resting transparency (and back after); the minimal HUD rests the buttons lighter', async () => {
  const page = await phone({ mode: 'deathmatch', settings: { opacity: 0.5 }, layout: { v: 1, controls: { jump: { x: 0.9, y: 0.88, size: 1, opacity: 0.3 } } } });
  try {
    const f = await fingers(page);
    const opacity = (sel) => page.evaluate((sel) => +getComputedStyle(document.querySelector(sel)).opacity, sel);
    assert.equal(await opacity('.tc-jump'), 0.3);
    const j = await centre(page, '.tc-jump');
    await f.start(1, j.x, j.y);
    assert.equal(await opacity('.tc-jump'), 1, 'held: fully visible');
    await f.end(1);
    assert.equal(await opacity('.tc-jump'), 0.3, 'let go: its own transparency');
    assert.equal(await opacity('.tc-reload'), 0.5);
    await page.evaluate(() => {
      const el = document.querySelector('input[data-touch-toggle="minimalHud"]');
      el.checked = true;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    assert.equal(await opacity('.tc-reload'), 0.375, 'minimal: the default buttons rest lighter (75 %)');
    assert.equal(await opacity('.tc-jump'), 0.3, "a player's own transparency is kept");
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});

test('6. stored data: a Phase 25 layout (no hidden flag) still applies; a layout made on a phone lands in the same relative place on a tablet; hiding a locked control is ignored; a bad flag → the default arrangement', async () => {
  const p25 = { v: 1, controls: { fire: { x: 0.5, y: 0.8, size: 1.2, opacity: 0.6 } } };
  const phonePage = await phone({ mode: 'deathmatch', layout: p25 });
  let rel;
  try {
    rel = await phonePage.evaluate(() => {
      const r = document.querySelector('.tc-fire').getBoundingClientRect();
      return { x: (r.left + r.width / 2) / innerWidth, y: (r.top + r.height / 2) / innerHeight, placed: document.querySelector('.tc-fire').classList.contains('placed') };
    });
    assert.equal(rel.placed, true);
  } finally {
    await phonePage.context().close();
  }
  const tablet = await phone({ mode: 'deathmatch', width: 1180, height: 820, layout: p25 });
  try {
    const t = await tablet.evaluate(() => {
      const r = document.querySelector('.tc-fire').getBoundingClientRect();
      return { x: (r.left + r.width / 2) / innerWidth, y: (r.top + r.height / 2) / innerHeight };
    });
    assert.ok(Math.abs(t.x - rel.x) < 0.01 && Math.abs(t.y - rel.y) < 0.01, `same relative place (${JSON.stringify(t)} vs ${JSON.stringify(rel)})`);
  } finally {
    await tablet.context().close();
  }
  const locked = await phone({ mode: 'deathmatch', layout: { v: 1, controls: { fire: { x: 0.9, y: 0.6, size: 1, opacity: 0.7, hidden: true }, board: { x: 0.2, y: 0.05, size: 1, opacity: 0.7, hidden: true } } } });
  try {
    assert.deepEqual(await locked.evaluate(() => [window.game.input.touch.hiddenControls, document.querySelector('.tc-fire').checkVisibility()]), [['board'], true], '발사 cannot be hidden, 점수판 can');
  } finally {
    await locked.context().close();
  }
  const bad = await phone({ mode: 'deathmatch', layout: { v: 1, controls: { board: { x: 0.2, y: 0.05, size: 1, opacity: 0.7, hidden: 'yes' } } } });
  try {
    assert.deepEqual(await bad.evaluate(() => [window.game.touchLayout, window.game.input.touch.hiddenControls]), [null, []], 'bad data: the default arrangement');
    assert.deepEqual(bad.errors, []);
  } finally {
    await bad.context().close();
  }
});

test('7. the PC HUD is unchanged by any of it (a stored minimal HUD / hidden buttons): full panels, no touch controls, keyboard play', async () => {
  for (const [w, h] of [
    [1920, 1080],
    [1280, 720],
  ]) {
    const page = await openGame(env, { mode: 'team', width: w, height: h });
    try {
      await page.evaluate(() => {
        localStorage.setItem('tactical-fps.touch.v1', JSON.stringify({ minimalHud: 1 }));
        localStorage.setItem('tactical-fps.touch-layout.v1', JSON.stringify({ v: 1, controls: { board: { x: 0.2, y: 0.05, size: 1, opacity: 0.7, hidden: true } } }));
      });
      await page.reload();
      await waitReady(page);
      await page.click('.play-button');
      await page.waitForFunction(() => window.game.input.active);
      await installFrameDriver(page);
      await page.evaluate(() => {
        window.T.stopLoop();
        window.T.run(10);
      });
      const r = await page.evaluate(() => {
        const shown = (sel) => !!document.querySelector(sel)?.checkVisibility();
        return { touch: document.documentElement.classList.contains('touch'), touchUi: shown('.touch-ui'), stats: shown('.combat-stats'), strip: shown('.weapon .loadout'), name: shown('.weapon-name'), money: shown('.ta.money') };
      });
      assert.deepEqual(r, { touch: false, touchUi: false, stats: true, strip: true, name: true, money: true }, `${w}×${h}`);
      // Keyboard: W walks, as before (once the round is live: the prep time holds everyone still).
      await page.evaluate(() => {
        window.game.teamMatch.phaseLeft = 0.01;
        window.T.run(3);
      });
      const p0 = await page.evaluate(() => window.game.player.position.clone());
      await page.keyboard.down('KeyW');
      await page.evaluate(() => window.T.run(40));
      await page.keyboard.up('KeyW');
      const moved = await page.evaluate((p0) => Math.hypot(window.game.player.position.x - p0.x, window.game.player.position.z - p0.z), p0);
      assert.ok(moved > 0.5, `W walks (${moved.toFixed(2)} m)`);
      assert.deepEqual(page.errors, []);
    } finally {
      await page.context().close();
    }
  }
});
