// Asking for the mouse again right after letting it go: newer Chrome turns
// such requests away ("too many pointer lock requests"). A refusal must not
// surface as a page error, and the game must end up either playing (locked)
// or on the pause menu (unlocked), never in between.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, openGame } from './harness.mjs';

let env;
let page;

before(async () => {
  env = await startEnv();
  // Unpaced: this suite is about the browser refusing requests that come too fast.
  page = await openGame(env, { mode: 'training', pacedLock: false });
});
after(async () => {
  await page?.context().close();
  await env?.close();
});

test('rapid re-lock attempts: no page error; playing or paused, never half of each', async () => {
  await page.click('.play-button');
  await page.waitForFunction(() => window.game.input.active);
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => document.exitPointerLock());
    await page.waitForFunction(() => !window.game.input.active);
    // Straight back in (as a player clicking the game right after Esc).
    await page.evaluate(() => window.game.input.requestLock());
    await page.waitForTimeout(150);
    const s = await page.evaluate(() => ({ locked: window.game.input.active, menu: !document.querySelector('.overlay').classList.contains('hidden') }));
    assert.ok(s.locked !== s.menu, `consistent state after attempt ${i + 1}: ${JSON.stringify(s)}`);
  }
  assert.deepEqual(page.errors, []);
});
