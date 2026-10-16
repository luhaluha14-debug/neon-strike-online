// Shared test harness: starts the Vite dev server for this project and a
// headless Chromium, and opens the game with a given map / quality.
//
// The dev build exposes `window.game` and `window.vmCheck` (src/main.ts), which
// the tests use to drive the game deterministically. Nothing here changes the
// game code; test-only helpers are injected into the page by the tests.
//
// GPU: by default Chromium renders with SwiftShader (software). These tests
// check logic, wiring and DOM layout, never rendering speed or image quality.
// TEST_GL=native uses the machine's GPU instead.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GOLDEN_DIR = fileURLToPath(new URL('./golden/', import.meta.url));

const GL_ARGS = process.env.TEST_GL === 'native' ? [] : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

/** Map loading takes a while on a software renderer. */
export const LOAD_TIMEOUT = 300_000;

export async function startEnv() {
  const server = await createServer({
    root: ROOT,
    logLevel: 'error',
    clearScreen: false,
    // No HMR / file watching: an edit during a run must not reload the page under test.
    server: { port: 0, strictPort: false, host: '127.0.0.1', hmr: false, watch: null },
  });
  await server.listen();
  const url = server.resolvedUrls.local[0].replace(/\/$/, '');
  const browser = await chromium.launch({ args: GL_ARGS });
  return {
    url,
    browser,
    async close() {
      await browser.close();
      await server.close();
    },
  };
}

/**
 * Opens the game in a fresh browser context (empty localStorage) and waits
 * until the map is loaded and the Play button is enabled. `page.errors`
 * collects page exceptions and console errors.
 */
export async function openGame(env, { map = 'warehouse', quality = 'low', width = 640, height = 360, mode = 'training' } = {}) {
  const context = await env.browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  page.setDefaultTimeout(LOAD_TIMEOUT);
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') page.errors.push('console.error: ' + m.text());
  });
  // quality: null = no ?quality in the link (the game picks automatically / from saved settings).
  // mode: 'training' (dummies, the default here so earlier suites test what they were written for),
  // 'deathmatch' (bots), or null for the game's own default.
  await page.goto(`${env.url}/?map=${map}` + (quality ? `&quality=${quality}` : '') + (mode ? `&mode=${mode}` : ''));
  await waitReady(page);
  return page;
}

export async function waitReady(page) {
  await page.waitForFunction(() => window.game && window.game.weapons && window.game.player && !document.querySelector('.play-button').disabled, null, {
    timeout: LOAD_TIMEOUT,
  });
}

/**
 * Installs deterministic helpers in the page:
 *   T.stopLoop()            stop the real frame loop and rendering (logic only)
 *   T.run(n, dt)            drive Game.frame n times with fixed timestamps
 * Input comes from real Playwright mouse / keyboard events, as in play.
 */
export async function installFrameDriver(page) {
  await page.evaluate(() => {
    const g = window.game;
    const T = (window.T = window.T || {});
    T.stopLoop = () => {
      g.loop.stop();
      g.renderer.render = () => {};
      g.viewModel.render = () => {};
      T.t = performance.now();
    };
    T.run = (n, dt = 1000 / 60) => {
      for (let i = 0; i < n; i++) {
        T.t += dt;
        g.frame(T.t);
      }
    };
  });
}

/**
 * Returns the recorded tests/golden/<name>.json for comparison with `actual`
 * (UPDATE_GOLDEN=1 records `actual` instead). Compare against `asJson(actual)`:
 * JSON has no -0, so values are normalised the same way the file was written.
 */
export function asJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export async function golden(name, actual) {
  const file = GOLDEN_DIR + name + '.json';
  if (process.env.UPDATE_GOLDEN === '1') {
    await mkdir(GOLDEN_DIR, { recursive: true });
    await writeFile(file, JSON.stringify(actual, null, 2) + '\n');
    return actual;
  }
  return JSON.parse(await readFile(file, 'utf8'));
}
