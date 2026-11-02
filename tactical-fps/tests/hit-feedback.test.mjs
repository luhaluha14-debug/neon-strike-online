// The shooter's hit confirm merged per round (Node, game/HitFeedback.ts):
// hits collected in one frame are one marker and one sound (head if any
// pellet hit the head, kill if any killed); the rest of a round arriving a
// frame later shows only what it adds; rounds a fire interval apart are each
// confirmed; nothing collected, nothing shown.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { ROOT } from './harness.mjs';

let vite;
let HitFeedback;
let WINDOW;

before(async () => {
  vite = await createServer({ root: ROOT, logLevel: 'error', server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom' });
  ({ HitFeedback, HIT_MERGE_WINDOW: WINDOW } = await vite.ssrLoadModule('/src/game/HitFeedback.ts'));
});
after(async () => {
  await vite?.close();
});

function make() {
  const shown = [];
  const f = new HitFeedback((head, kill, sound, delay) => shown.push({ head, kill, sound, delay }));
  return { f, shown };
}

test('a frame of hits (eight pellets) is one confirm: head if any, kill if any, the earliest sound time', () => {
  const { f, shown } = make();
  f.flush(1);
  assert.deepEqual(shown, [], 'nothing to show');
  for (let i = 0; i < 6; i++) f.add(false, false, 0.03);
  f.add(true, false, 0.02);
  f.add(false, true, 0.05);
  f.flush(1);
  assert.deepEqual(shown, [{ head: true, kill: true, sound: true, delay: 0.02 }]);
  f.flush(1.001);
  assert.equal(shown.length, 1, 'shown once');
});

test('the rest of a round a frame later: nothing more for more body hits; an added head hit shows (with its own sound), an added kill shows (marker only)', () => {
  const { f, shown } = make();
  f.add(false, false);
  f.flush(1);
  f.add(false, false);
  f.flush(1 + 0.016);
  assert.equal(shown.length, 1, 'more body hits of the same round: nothing more');
  f.add(true, false);
  f.flush(1 + 0.02);
  assert.deepEqual(shown[1], { head: true, kill: false, sound: true, delay: 0 });
  f.add(false, true);
  f.flush(1 + 0.03);
  assert.deepEqual(shown[2], { head: true, kill: true, sound: false, delay: 0 });
});

test('rounds a fire interval apart are each confirmed (fastest gun: 75 ms)', () => {
  const { f, shown } = make();
  for (let i = 0; i < 10; i++) {
    f.add(false, false);
    f.flush(i * 0.075);
  }
  assert.equal(shown.length, 10);
  assert.ok(WINDOW < 0.075, `merge window (${WINDOW} s) under the shortest shot interval`);
});
