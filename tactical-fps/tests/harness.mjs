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
export async function openGame(env, { map = 'warehouse', quality = 'low', width = 640, height = 360, mode = 'training', objective = null, seed = null, lobby = false, init = null, pacedLock = true, dressing = null, mobile = false, extra = '' } = {}) {
  // mobile: a phone as Playwright emulates one (touch screen, coarse pointer, no mouse, 2× pixels).
  const context = await env.browser.newContext(mobile ? { viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width, height } });
  // init: a script run in the page before the game (counters, stubs).
  if (init) await context.addInitScript(init);
  // Suites lock and free the mouse far faster than a player; newer Chrome refuses the 6th request
  // within ~5 s. pacedLock: requests wait their turn instead (see pacePointerLock). Off for the
  // suite that checks how the game takes a refusal.
  if (pacedLock) await context.addInitScript(pacePointerLock);
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
  // seed: bots' random choices from a fixed seed (reproducible runs).
  // objective: team match 'bomb' (the game's default) or 'elimination' (suites written for the elimination rules).
  // dressing: 'none' loads the map files as they are (no MapDressing), e.g. for recordings made before it.
  await page.goto(`${env.url}/?map=${map}` + (quality ? `&quality=${quality}` : '') + (mode ? `&mode=${mode}` : '') + (objective ? `&objective=${objective}` : '') + (seed !== null ? `&seed=${seed}` : '') + (dressing ? `&dressing=${dressing}` : '') + extra);
  await waitReady(page, { lobby });
  return page;
}

export async function waitReady(page, { lobby = false } = {}) {
  await page.waitForFunction(() => window.game && window.game.weapons && window.game.player && !document.querySelector('.play-button').disabled, null, {
    timeout: LOAD_TIMEOUT,
  });
  if (!lobby) await leaveLobby(page);
}

/**
 * The game opens on the GRID lobby. Suites written for the menu go through
 * it as a player would: PLAY → the current mode's card (or TRAINING), which
 * lands on the menu's Play page with the 플레이 button. `lobby: true` (in
 * openGame / waitReady) stays on the lobby.
 */
export async function leaveLobby(page) {
  const mode = await page.evaluate(() => (document.querySelector('.overlay.view-lobby:not(.hidden)') ? window.game.mode : null));
  if (!mode) return;
  if (mode === 'training') await page.click('.lobby [data-lobby="training"]');
  else {
    await page.click('.lobby [data-lobby="play"]');
    await page.click(`.lobby [data-play-mode="${mode}"]`);
  }
  await page.waitForSelector('.overlay:not(.view-lobby) .play-button:not([disabled])');
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

/**
 * Init script (openGame `init`): every Math.random draw in the page comes from a fixed sequence
 * (bullet spread, recoil, effects). With `seed` (the bots' own choices) a stretch of bot play is the
 * same on every run.
 */
export function seededRandomInit() {
  let a = 12345;
  Math.random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Page init script for leak checks: counts listeners added to window /
 * document / the canvas, WebSockets and AudioContexts created. Read with
 * `window.__counts()`;
 * `window.__framesWaiting()` samples the frame callbacks waiting (one game loop = 1).
 */
export function countingInit() {
  const listeners = {};
  const add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opt) {
    const who = this === window ? 'window' : this === document ? 'document' : this instanceof HTMLCanvasElement ? 'canvas' : null;
    if (who) listeners[`${who}:${type}`] = (listeners[`${who}:${type}`] ?? 0) + 1;
    return add.call(this, type, fn, opt);
  };
  let sockets = 0;
  const WS = window.WebSocket;
  window.WebSocket = class extends WS {
    constructor(...a) {
      super(...a);
      sockets++;
      (window.__sockets ??= []).push(this);
    }
  };
  let audio = 0;
  const AC = window.AudioContext;
  if (AC)
    window.AudioContext = class extends AC {
      constructor(...a) {
        super(...a);
        audio++;
      }
    };
  const pending = new Set();
  const raf = window.requestAnimationFrame.bind(window);
  const caf = window.cancelAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => {
    const h = raf((t) => {
      pending.delete(h);
      cb(t);
    });
    pending.add(h);
    return h;
  };
  window.cancelAnimationFrame = (h) => {
    pending.delete(h);
    caf(h);
  };
  // Frame callbacks waiting right now, sampled from timers (Playwright's waitForFunction polls by
  // animation frame too, so only samples taken outside it count): the most seen in `ms`.
  window.__framesWaiting = (ms = 500) =>
    new Promise((resolve) => {
      let most = 0;
      const t0 = performance.now();
      const sample = () => {
        most = Math.max(most, pending.size);
        if (performance.now() - t0 < ms) setTimeout(sample, 7);
        else resolve(most);
      };
      sample();
    });
  window.__counts = () => ({ listeners: { ...listeners }, sockets, audio });
}

/**
 * Page init script: paces mouse-lock requests like a player would. Newer
 * Chrome (measured on 153) refuses a pointer-lock request when five were
 * made in roughly the last five seconds; older ones had no such limit. A
 * request here waits until fewer than four were made in the last 5.5 s,
 * then goes to the browser unchanged (same element, options and result),
 * so the game still gets real locks, releases and refusals.
 */
export function pacePointerLock() {
  const WINDOW = 5500;
  const MAX = 4;
  const made = [];
  const request = Element.prototype.requestPointerLock;
  let chain = Promise.resolve();
  Element.prototype.requestPointerLock = function (...args) {
    const turn = chain.then(async () => {
      for (;;) {
        const now = performance.now();
        while (made.length && now - made[0] > WINDOW) made.shift();
        if (made.length < MAX) break;
        await new Promise((r) => setTimeout(r, WINDOW - (now - made[0]) + 20));
      }
      made.push(performance.now());
      return request.apply(this, args);
    });
    chain = turn.catch(() => {});
    return turn;
  };
}

