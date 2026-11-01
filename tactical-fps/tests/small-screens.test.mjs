// Small and short screens (landscape phones, small windows): every main
// control can be reached and is the topmost thing where it is drawn (not
// hidden under another element). The lobby's items fit on one screen; the
// menu column scrolls with the Play button pinned at the bottom; the result
// screens keep their buttons in view however long the score tables are.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, openGame, installFrameDriver } from './harness.mjs';

let env;

before(async () => {
  env = await startEnv();
});
after(async () => {
  await env?.close();
});

/** For each selector: 'ok' when its element is inside the viewport and is what a click at its centre hits. */
const reach = (page, sels) =>
  page.evaluate(
    (sels) =>
      Object.fromEntries(
        sels.map((s) => {
          const e = [...document.querySelectorAll(s)].find((x) => x.getClientRects().length);
          if (!e) return [s, 'missing'];
          const b = e.getBoundingClientRect();
          const inView = b.top >= 0 && b.left >= 0 && b.bottom <= innerHeight + 0.5 && b.right <= innerWidth + 0.5;
          const top = inView ? document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) : null;
          return [s, !inView ? 'out of view' : top && (top === e || e.contains(top)) ? 'ok' : `covered by ${top?.className || top?.tagName}`];
        }),
      ),
    sels,
  );
const allOk = (r) => Object.fromEntries(Object.keys(r).map((k) => [k, 'ok']));

for (const [w, h] of [
  [480, 270],
  [640, 360],
]) {
  test(`${w}x${h}: lobby items on one screen; menu pages scroll with Play pinned; result buttons in view (team and deathmatch)`, async () => {
    const page = await openGame(env, { mode: null, lobby: true, width: w, height: h });
    try {
      const lobby = await reach(page, ['.lobby [data-lobby="play"]', '.lobby [data-lobby="multi"]', '.lobby [data-lobby="arsenal"]', '.lobby [data-lobby="training"]', '.lobby [data-lobby="settings"]']);
      assert.deepEqual(lobby, allOk(lobby));

      // Menu: the multiplayer page's buttons are reachable by scrolling, the Play button always in view.
      await page.click('.lobby [data-lobby="multi"]');
      assert.deepEqual(await reach(page, ['.play-button']), { '.play-button': 'ok' });
      await page.locator('.mp-join-btn').scrollIntoViewIfNeeded();
      const menu = await reach(page, ['.mp-quick', '.mp-create', '.mp-join-btn', '.play-button']);
      assert.deepEqual(menu, allOk(menu));
      await page.click('.menu-lobby');

      // Team match result (forfeit): the three buttons in view without scrolling.
      await page.click('.lobby [data-lobby="play"]');
      await page.click('.lobby [data-play-mode="team"]');
      await page.click('.play-button');
      await page.waitForFunction(() => window.game.input.active && window.game.teamMatch);
      await page.evaluate(() => document.exitPointerLock());
      await page.waitForFunction(() => !window.game.input.active);
      assert.equal(await page.evaluate(() => window.game.forfeitMatch()), true);
      await page.waitForFunction(() => !document.querySelector('.team-hud .results').hidden);
      const team = await reach(page, ['.team-hud .results-restart', '.team-hud .results-menu', '.team-hud .results-lobby']);
      assert.deepEqual(team, allOk(team));

      // Deathmatch result (clock): the same.
      await page.click('.team-hud .results-lobby');
      await page.click('.lobby [data-lobby="play"]');
      await page.click('.lobby [data-play-mode="deathmatch"]');
      await page.click('.play-button');
      await page.waitForFunction(() => window.game.input.active && window.game.match);
      await installFrameDriver(page);
      await page.evaluate(() => {
        window.T.stopLoop();
        window.game.match.timeLeft = 0.05;
        window.T.run(10);
      });
      await page.waitForFunction(() => !document.querySelector('.match-hud:not(.team-hud) .results').hidden);
      const dm = await reach(page, ['.match-hud:not(.team-hud) .results-restart', '.match-hud:not(.team-hud) .results-menu', '.match-hud:not(.team-hud) .results-lobby']);
      assert.deepEqual(dm, allOk(dm));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no sideways scroll');
      assert.deepEqual(page.errors, []);
    } finally {
      await page.context().close();
    }
  });
}
