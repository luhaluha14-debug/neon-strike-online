// Frame statistics for the F3 overlay (Phase 19): so a player can measure the game on their own GPU.
// Average FPS, 1 % low (mean of the slowest 1 % of frames), p99 and worst frame time over the last
// 600 drawn frames, from the real frame time (a stall longer than the simulation's 100 ms clamp still
// shows in full); and the WebGL renderer name, flagged when it is a software renderer, not a GPU.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, openGame, installFrameDriver } from './harness.mjs';

let env;
let page;

before(async () => {
  env = await startEnv();
  page = await openGame(env, { quality: 'low' });
  await page.click('.play-button');
  await page.waitForFunction(() => window.game.input.active);
});
after(async () => {
  await page?.context().close();
  await env?.close();
});

test('summary: average, 1 % low, p99 and max from a known set of frame times; a fixed 600-frame window', async () => {
  const r = await page.evaluate(async () => {
    const { FrameStats, FRAME_WINDOW } = await import('/src/core/FrameStats.ts');
    const s = new FrameStats();
    const few = (() => {
      for (let i = 0; i < 9; i++) s.add(0.01);
      return s.summary();
    })();
    s.reset();
    // 990 frames of 10 ms and 10 of 50 ms: the window keeps the last 600 (590 × 10 ms, 10 × 50 ms).
    for (let i = 0; i < 990; i++) s.add(0.01);
    for (let i = 0; i < 10; i++) s.add(0.05);
    const a = s.summary();
    // Not frame times: a pause, a hidden tab, garbage.
    s.add(0);
    s.add(-1);
    s.add(5);
    s.add(NaN);
    const b = s.summary();
    return { window: FRAME_WINDOW, few, a, unchanged: JSON.stringify(a) === JSON.stringify(b) };
  });
  assert.equal(r.window, 600);
  assert.equal(r.few, null, 'fewer than 10 frames: no summary');
  const a = r.a;
  assert.equal(a.frames, 600);
  const avgMs = (590 * 10 + 10 * 50) / 600;
  assert.ok(Math.abs(a.avgMs - avgMs) < 1e-3, `avg ${a.avgMs}`);
  assert.ok(Math.abs(a.avgFps - 1000 / avgMs) < 0.01);
  // Slowest 1 % of 600 = 6 frames, all 50 ms: 20 fps.
  assert.ok(Math.abs(a.low1Fps - 20) < 0.01, `1% low ${a.low1Fps}`);
  assert.ok(Math.abs(a.p99Ms - 50) < 1e-3, `p99 ${a.p99Ms}`);
  assert.ok(Math.abs(a.maxMs - 50) < 1e-3);
  assert.equal(r.unchanged, true, 'zero, negative, > 1 s and NaN frame times are ignored');
});

test('software renderers are told apart from GPUs by name', async () => {
  const r = await page.evaluate(async () => {
    const { isSoftwareRenderer } = await import('/src/core/FrameStats.ts');
    return [
      'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
      'llvmpipe (LLVM 15.0.7, 256 bits)',
      'ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0)',
      'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002503) Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'Apple M2',
    ].map(isSoftwareRenderer);
  });
  assert.deepEqual(r, [true, true, true, false, false, false, false]);
});

test('the game feeds real frame times (a 300 ms stall reads 300 ms, not the 100 ms clamp); F3 shows them and the renderer', async () => {
  await installFrameDriver(page);
  const r = await page.evaluate(() => {
    const g = window.game;
    window.T.stopLoop();
    g.frameStats.reset();
    window.T.run(60, 1000 / 60);
    window.T.run(1, 300);
    window.T.run(60, 1000 / 60);
    const s = g.frameStats.summary();
    g.setStatsShown(true);
    window.T.run(40, 1000 / 60);
    const text = document.querySelector('.stats')?.textContent ?? g.hud.root.textContent;
    return { frames: s.frames, maxMs: s.maxMs, avgMs: s.avgMs, text };
  });
  assert.equal(r.frames, 121);
  assert.ok(Math.abs(r.maxMs - 300) < 0.5, `the stall in full (${r.maxMs} ms)`);
  assert.ok(r.avgMs > 16 && r.avgMs < 20);
  assert.match(r.text, /1% low \d+ fps/);
  assert.match(r.text, /frame [\d.]+ ms avg \/ [\d.]+ p99 \/ [\d.]+ max \(\d+ frames\)/);
  // This headless browser renders with SwiftShader: the overlay must say so plainly.
  assert.match(r.text, /GPU .*SwiftShader.*SOFTWARE — not a real GPU/);
});
