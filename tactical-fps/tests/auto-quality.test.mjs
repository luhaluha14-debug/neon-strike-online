// Automatic graphics quality (Node, core/AutoQuality.ts with simulated frame
// times; no GPU involved: the numbers below are frame times fed in, not
// measured on hardware). The starting level with and without GPU
// information, a measured level and the ceiling; lowering on sustained slow
// or uneven frames after the warm-up, not on a short drop, a hitch or a tab
// switch, not more often than the minimum gap; remembering a level with room
// to spare for the next load; no flapping over many sessions.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { ROOT } from './harness.mjs';

let vite;
let A;

before(async () => {
  vite = await createServer({ root: ROOT, logLevel: 'error', server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom' });
  A = await vite.ssrLoadModule('/src/core/AutoQuality.ts');
});
after(async () => {
  await vite?.close();
});

const device = (o = {}) => ({ cores: 8, coarsePointer: false, memoryGb: 8, gpu: { hardware: true, maxTextureSize: 16384 }, ...o });
const none = { level: null, ceiling: null };

/** Feeds `seconds` of frames at `fps` (or the frame times `pattern` repeats); returns the decisions with their time. */
function play(m, seconds, fps, { pattern = null, measuring = true, t0 = 0 } = {}) {
  const out = [];
  let t = 0;
  let i = 0;
  while (t < seconds) {
    const dt = pattern ? pattern[i++ % pattern.length] : 1 / fps;
    t += dt;
    const d = m.frame(dt, measuring);
    if (d) out.push({ t: +(t0 + t).toFixed(2), ...d });
  }
  return out;
}

test('starting level: without GPU information the old guess; software rendering, small limits or a weak device → low; a GPU → medium; never high unmeasured', () => {
  assert.equal(A.guessQuality(device({ gpu: null })), 'medium');
  assert.equal(A.guessQuality(device({ gpu: null, cores: 4 })), 'low');
  assert.equal(A.guessQuality(device({ gpu: null, coarsePointer: true })), 'low');
  assert.equal(A.guessQuality(device({ gpu: null, cores: null })), 'low', 'no core count: the old default of 4 → low');
  assert.equal(A.guessQuality(device({ gpu: { hardware: false, maxTextureSize: 16384 } })), 'low');
  assert.equal(A.guessQuality(device({ gpu: { hardware: true, maxTextureSize: 4096 } })), 'low');
  assert.equal(A.guessQuality(device({ memoryGb: 2 })), 'low');
  assert.equal(A.guessQuality(device()), 'medium');
  assert.equal(A.guessQuality(device({ cores: 32, memoryGb: 64, gpu: { hardware: true, maxTextureSize: 32768 } })), 'medium');
  // A level measured on this device wins over the guess; the ceiling caps both.
  assert.equal(A.initialQuality(device(), { level: 'high', ceiling: null }), 'high');
  assert.equal(A.initialQuality(device({ gpu: { hardware: false, maxTextureSize: 4096 } }), { level: 'medium', ceiling: null }), 'medium');
  assert.equal(A.initialQuality(device(), { level: 'high', ceiling: 'medium' }), 'medium');
  assert.equal(A.initialQuality(device(), { level: null, ceiling: 'low' }), 'low');
});

test('high frame rate: never lowered; room to spare is remembered once (next load one step higher)', () => {
  const m = new A.AutoQualityMonitor('medium', none);
  const d = play(m, 120, 144);
  assert.deepEqual(d.map((x) => x.kind), ['remember'], JSON.stringify(d));
  assert.deepEqual(d[0].state, { level: 'high', ceiling: null });
  // warm-up 5 s + 3 windows of 4 s
  assert.ok(d[0].t >= 17 && d[0].t < 18, `after the warm-up and three windows (${d[0].t} s)`);
  assert.equal(m.level, 'medium', 'nothing changes during play');
  // At 60 fps (a 60 Hz screen, or the 60 limit) too.
  assert.deepEqual(play(new A.AutoQualityMonitor('low', none), 60, 60).map((x) => [x.kind, x.state.level]), [['remember', 'medium']]);
  // Already at high: nothing to remember beyond it.
  assert.deepEqual(play(new A.AutoQualityMonitor('high', { level: 'high', ceiling: null }), 60, 144), []);
});

test('low frame rate: lowered after the warm-up and three slow windows, then not again before the minimum gap', () => {
  const m = new A.AutoQualityMonitor('high', { level: 'high', ceiling: null });
  const d = play(m, 120, 25);
  assert.equal(d[0].kind, 'lower');
  assert.equal(d[0].level, 'medium');
  assert.ok(d[0].t >= 17 && d[0].t < 18, `5 s warm-up + 3 × 4 s (${d[0].t} s)`);
  assert.equal(d[1].kind, 'lower');
  assert.equal(d[1].level, 'low');
  assert.ok(d[1].t - d[0].t >= 30, `the second change waits the minimum gap (${d[1].t - d[0].t} s)`);
  assert.equal(d.length, 2, 'nothing below low');
  assert.deepEqual(m.state, { level: 'low', ceiling: 'low' });
});

test('uneven frames (one in ten at 60 ms, average still ~50 fps) count as slow', () => {
  const pattern = [...Array(9).fill(1 / 70), 0.06];
  const fps = pattern.length / pattern.reduce((s, t) => s + t, 0);
  assert.ok(fps > 40, `average ${fps.toFixed(1)} fps`);
  const d = play(new A.AutoQualityMonitor('medium', none), 20, 0, { pattern });
  assert.deepEqual(d.map((x) => [x.kind, x.level]), [['lower', 'low']]);
});

test('a short drop (3.5 s at 15 fps every 20 s, wherever it falls in the windows) and single hitches do not lower', () => {
  const m = new A.AutoQualityMonitor('medium', { level: 'medium', ceiling: 'medium' });
  for (let shift = 0; shift < 4; shift += 0.25) {
    const smooth = Math.round((16.5 - shift) * 60);
    const pattern = [...Array(smooth).fill(1 / 60), ...Array(52).fill(1 / 15), ...Array(Math.round(shift * 60)).fill(1 / 60)];
    assert.deepEqual(play(m, 100, 0, { pattern }), [], `drop shifted ${shift} s`);
  }
  // A hitch (garbage collection / shader compile) every 3 s on otherwise smooth play.
  const hitches = [...Array(180).fill(1 / 60), 0.4];
  assert.deepEqual(play(new A.AutoQualityMonitor('medium', { level: 'medium', ceiling: 'medium' }), 300, 0, { pattern: hitches }), []);
  assert.equal(m.level, 'medium');
});

test('tab switch / menu: frames that do not count restart the warm-up; a long frame on return is not measured', () => {
  const m = new A.AutoQualityMonitor('medium', none);
  // 15 s slow (two slow windows in), then the tab is hidden (not measuring) and comes back with a 3 s frame.
  assert.deepEqual(play(m, 15, 25), []);
  assert.deepEqual(play(m, 3, 60, { measuring: false }), []);
  assert.equal(m.frame(3, true), null);
  // Slow again: a fresh warm-up + two windows before lowering (the window before the switch is gone).
  const d = play(m, 30, 25);
  assert.equal(d[0].kind, 'lower');
  assert.ok(d[0].t >= 17 && d[0].t < 18, `measured from the return (${d[0].t} s)`);
});

test('the frame times are real ones: a 60 fps limit on a fast machine is not slow', () => {
  assert.deepEqual(play(new A.AutoQualityMonitor('high', { level: 'high', ceiling: null }), 300, 60), []);
});

test('no flapping over many sessions: a level that was too slow is not chosen again, the rest stays put', () => {
  // A device that runs medium at 60 fps and high at 30 fps.
  const fpsAt = { low: 120, medium: 60, high: 30 };
  let state = none;
  const levels = [];
  let changesInPlay = 0;
  for (let session = 0; session < 10; session++) {
    const level = A.initialQuality(device(), state);
    levels.push(level);
    const m = new A.AutoQualityMonitor(level, state);
    let t = 0;
    while (t < 180) {
      const dt = 1 / fpsAt[m.level];
      t += dt;
      const d = m.frame(dt, true);
      if (d?.kind === 'lower') changesInPlay++;
      if (d) state = d.kind === 'remember' ? d.state : m.state;
    }
  }
  assert.deepEqual(levels, ['medium', 'high', 'medium', 'medium', 'medium', 'medium', 'medium', 'medium', 'medium', 'medium']);
  assert.equal(changesInPlay, 1, 'lowered once (in the one session that tried high)');
  assert.deepEqual(state, { level: 'medium', ceiling: 'medium' });
});
