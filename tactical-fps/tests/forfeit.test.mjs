// 대결 포기 (team match, pause menu): the button only in a running 5v5
// match, a confirmation that changes nothing when cancelled, a confirmed
// forfeit handled exactly once as the player's loss ("대결 포기 - 패배")
// with no round played or paid for it, live C4 / grenades / defuse
// progress dropped safely, input and the mouse released, and a clean new
// match afterwards. Deathmatch and training keep their menu as before.
// Frames are driven at a fixed 1/60 s with the real loop stopped.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, openGame, installFrameDriver } from './harness.mjs';

let env;
let page;

const locked = () => page.waitForFunction(() => document.pointerLockElement === window.game.renderer.domElement && window.game.input.active);
const unlock = async () => {
  await page.evaluate(() => document.exitPointerLock());
  await page.waitForFunction(() => !window.game.input.active && !document.querySelector('.overlay').classList.contains('hidden'));
  await page.evaluate(() => window.T.run(1));
};
const ui = () =>
  page.evaluate(() => ({
    button: !document.querySelector('.forfeit-button').hidden,
    dialog: !document.querySelector('.confirm').hidden,
    results: !document.querySelector('.team-hud .results')?.hidden,
  }));
/** Everything a forfeit (or a cancelled one) must not touch. */
const snapshot = () =>
  page.evaluate(() => {
    const g = window.game;
    const tm = g.teamMatch;
    return {
      phase: tm.phase,
      round: tm.round,
      wins: { ...tm.roundWins },
      history: tm.history.length,
      feed: tm.feed.length,
      money: Object.fromEntries([...tm.scores.keys()].map((id) => [id, tm.economy.money(id)])),
      streak: Object.fromEntries(tm.economy.lossStreak),
      settled: [1, 2, 3, 4, 5].map((r) => tm.economy.isSettled(r)),
    };
  });

before(async () => {
  env = await startEnv();
  page = await openGame(env, { map: 'warehouse', mode: 'training' });
  // Loaded: every later wait is short (a broken step fails fast instead of waiting minutes).
  page.setDefaultTimeout(60000);
});
after(async () => {
  await page?.context().close();
  await env?.close();
});

test('training and deathmatch: no 대결 포기 in the pause menu, and nothing to forfeit', async () => {
  await page.click('.play-button');
  await locked();
  await page.mouse.move(0, 0);
  await installFrameDriver(page);
  await page.evaluate(() => window.T.stopLoop());
  await unlock();
  const training = { ...(await ui()), call: await page.evaluate(() => window.game.forfeitMatch()) };
  await page.selectOption('select[data-setting="mode"]', 'deathmatch');
  await page.evaluate(() => window.T.run(2));
  const dm = { ...(await ui()), call: await page.evaluate(() => window.game.forfeitMatch()), mode: await page.evaluate(() => window.game.mode) };
  assert.deepEqual(training, { button: false, dialog: false, results: false, call: false });
  assert.deepEqual(dm, { button: false, dialog: false, results: false, call: false, mode: 'deathmatch' });
  // The deathmatch still plays on as before.
  await page.click('.play-button');
  await locked();
  const r = await page.evaluate(() => {
    window.T.run(120);
    return { over: window.game.match.over, bots: window.game.squad.bots.length };
  });
  assert.deepEqual(r, { over: false, bots: 5 });
  await unlock();
});

test('team match: the button shows in the pause menu; the dialog asks, and 계속 플레이 resumes with nothing changed', async () => {
  await page.selectOption('select[data-setting="mode"]', 'team');
  await page.click('.play-button');
  await locked();
  await page.evaluate(() => {
    const g = window.game;
    while (g.teamMatch.phase !== 'live') window.T.run(1);
    g.combat.protection = 1e9; // the player is the subject: kept alive while the bots fight
    window.T.run(30);
  });
  await unlock();
  const before = await snapshot();
  const shown = await ui();
  await page.click('.forfeit-button');
  const dialog = await page.evaluate(() => ({
    text: document.querySelector('.confirm-text').textContent,
    buttons: [...document.querySelectorAll('.confirm-actions button')].map((b) => b.textContent),
  }));
  const whileOpen = await snapshot();
  await page.click('.confirm-cancel');
  await locked();
  const after = await snapshot();
  const state = await page.evaluate(() => ({ over: window.game.teamMatch.over, forfeitedBy: window.game.teamMatch.forfeitedBy, dialog: !document.querySelector('.confirm').hidden }));
  // The match goes on.
  const t0 = await page.evaluate(() => window.game.teamMatch.roundTimeLeft);
  await page.evaluate(() => window.T.run(60));
  const t1 = await page.evaluate(() => window.game.teamMatch.roundTimeLeft);
  assert.deepEqual(shown, { button: true, dialog: false, results: false });
  assert.deepEqual(dialog, { text: '정말 대결을 포기하시겠습니까? 포기하면 현재 대결은 패배 처리됩니다.', buttons: ['대결 포기', '계속 플레이'] });
  assert.deepEqual(whileOpen, before, 'opening the dialog changes nothing');
  assert.deepEqual(after, before, 'cancelling changes nothing');
  assert.deepEqual(state, { over: false, forfeitedBy: null, dialog: false });
  assert.ok(t1 < t0, 'the round clock runs on');
});

test('forfeit with the C4 planted, a defuse under way and grenades in the air: ends once as a loss, nothing paid, everything stopped', async () => {
  const setup = await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    const V = g.player.position.constructor;
    // The player plants at site A.
    const site = g.bomb.sites.find((s) => s.name === 'A');
    let spot = null;
    for (const cell of g.nav.walkable) {
      const p = g.nav.center(cell);
      if (site.box.containsPoint(p.clone().setY(p.y + 0.05)) && g.spawnFits(g.map, p)) {
        spot = p;
        break;
      }
    }
    g.director = null; // test-held positions below
    g.player.teleport(spot.clone().setY(spot.y + 0.1), 0);
    T.run(20);
    return { spot: spot.toArray(), carrier: g.bomb.carrier };
  });
  assert.equal(setup.carrier, 'local');
  await page.keyboard.down('KeyE');
  await page.evaluate(() => window.T.run(3.2 * 60 + 5));
  await page.keyboard.up('KeyE');
  const mid = await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    const V = g.player.position.constructor;
    // A RED bot defusing right now, a flash in the air, a smoke cloud.
    const red = g.squad.bots.find((b) => b.team === 'red' && b.alive);
    const goal = g.bomb.position.clone().add(new V(0.6, 0, 0));
    red.order = { role: 'defuser', goal, look: null, use: true, tag: 'test:defuse' };
    // Kept on the job: it neither sees (and stops to fight) nor gets shot.
    red.blindTime = 1e6;
    red.combat.protection = 1e9;
    for (let i = 0; i < 90 && !g.bomb.defusing; i++) {
      red.controller.teleport(goal.clone().setY(goal.y + 0.1), 0);
      T.run(1);
    }
    T.run(30);
    const eye = new V(g.player.position.x, g.player.position.y + 1.6, g.player.position.z);
    g.grenades.throw('flash', 'local', eye, new V(0, 0, -1));
    g.grenades.grenades.push({ id: 9700, kind: 'smoke', owner: 'test', position: g.player.position.clone(), velocity: new V(), age: 1.5, resting: true });
    T.run(1);
    return { bomb: g.bomb.state, defusing: !!g.bomb.defusing, progress: g.bomb.defuseProgress, flying: g.grenades.grenades.length, smokes: g.grenades.smokes.length, timeLeft: g.bomb.timeLeft };
  });
  assert.equal(mid.bomb, 'planted');
  assert.equal(mid.defusing, true, 'defuse under way');
  assert.ok(mid.flying >= 1 && mid.smokes === 1);
  await unlock();
  const before = await snapshot();
  await page.click('.forfeit-button');
  // Two confirmations in a row (double click): one forfeit.
  const calls = await page.evaluate(() => {
    const g = window.game;
    let done = 0;
    const real = g.forfeitMatch.bind(g);
    g.forfeitMatch = () => {
      const ok = real();
      if (ok) done++;
      return ok;
    };
    const yes = document.querySelector('.confirm-forfeit');
    yes.click();
    yes.click();
    const again = g.forfeitMatch();
    return { done, again };
  });
  await page.waitForFunction(() => !document.pointerLockElement);
  const after = await snapshot();
  const r = await page.evaluate(() => {
    const g = window.game;
    const tm = g.teamMatch;
    return {
      over: tm.over,
      forfeitedBy: tm.forfeitedBy,
      winner: tm.winner,
      title: document.querySelector('.team-hud .results-title').textContent,
      sub: document.querySelector('.team-hud .results-sub').textContent,
      bomb: g.bomb,
      charge: g.bombFx.group.children[0].visible,
      flying: g.grenades.grenades.length,
      smokes: g.grenades.smokes.length,
      blind: g.flashBlind,
      orders: g.squad.bots.filter((b) => b.order || b.useKey).length,
      input: { fire: g.inputState.fire, use: g.inputState.use, active: g.input.active },
      locked: !!document.pointerLockElement,
      update: tm.update(1, g.teamAlive()),
      planted: tm.bombPlanted('bot-1'),
      exploded: tm.bombExploded(g.teamAlive()),
      defused: tm.bombDefused('bot-6', g.teamAlive()),
    };
  });
  // Results stay put frame after frame: no loop of round ends, nothing paid.
  await page.evaluate(() => window.T.run(300));
  const later = await snapshot();
  const ui2 = await ui();
  assert.deepEqual(calls, { done: 1, again: false });
  assert.deepEqual([r.over, r.forfeitedBy, r.winner], [true, 'blue', 'red']);
  assert.equal(r.title, '대결 포기 - 패배');
  assert.match(r.sub, /^패배 · BLUE 0 : 0 RED · 0라운드 진행 후 포기$/);
  assert.deepEqual({ ...after, phase: 'live' }, before, 'no round result, kill bonus or refund: only the phase changed');
  assert.equal(after.phase, 'over');
  assert.deepEqual(later, after);
  assert.equal(r.bomb, null, 'the bomb is gone with its timer (no explosion, no defuse later)');
  assert.equal(r.charge, false);
  assert.deepEqual([r.flying, r.smokes, r.blind], [0, 0, 0]);
  assert.equal(r.orders, 0);
  assert.deepEqual(r.input, { fire: false, use: false, active: false });
  assert.equal(r.locked, false);
  assert.deepEqual([r.update, r.planted, r.exploded, r.defused], [null, false, null, null]);
  assert.deepEqual(ui2, { button: false, dialog: false, results: true }, 'no second forfeit from the results');
});

test('after a forfeit 다시 시작 starts a clean match (forfeit state, results and match data reset); it can be forfeited again', async () => {
  await page.click('.team-hud .results-restart');
  await locked();
  const r = await page.evaluate(() => {
    const g = window.game;
    const tm = g.teamMatch;
    return {
      over: tm.over,
      forfeitedBy: tm.forfeitedBy,
      phase: tm.phase,
      round: tm.round,
      history: tm.history.length,
      feed: tm.feed.length,
      money: [...tm.scores.keys()].every((id) => tm.economy.money(id) === 3000),
      bomb: g.bomb?.state,
      carrier: g.bomb?.carrier,
      results: !document.querySelector('.team-hud .results').hidden,
    };
  });
  assert.deepEqual(r, { over: false, forfeitedBy: null, phase: 'prep', round: 1, history: 0, feed: 0, money: true, bomb: 'carried', carrier: 'local', results: false });
  await unlock();
  assert.deepEqual(await ui(), { button: true, dialog: false, results: false });
});

test('forfeit between rounds (result shown, round already paid): no second payout, no extra round', async () => {
  await page.click('.play-button');
  await locked();
  await page.evaluate(() => {
    const g = window.game;
    const T = window.T;
    const V = g.player.position.constructor;
    while (g.teamMatch.phase !== 'live') T.run(1);
    g.combat.protection = 1e9;
    for (const b of g.squad.bots) {
      if (b.team !== 'red') continue;
      b.combat.protection = 0;
      b.combat.applyDamage({ amount: 999, zone: 'head', sourceId: 'local', weaponId: 'ar01', point: new V(), direction: new V(0, 0, 1), distance: 5 });
    }
    T.run(2);
  });
  const paid = await snapshot();
  assert.equal(paid.phase, 'result');
  assert.equal(paid.history, 1);
  await unlock();
  await page.click('.forfeit-button');
  await page.click('.confirm-forfeit');
  const after = await snapshot();
  const title = await page.evaluate(() => document.querySelector('.team-hud .results-title').textContent);
  assert.deepEqual({ ...after, phase: 'result' }, paid, 'the round paid before stays paid once; nothing added');
  assert.equal(after.phase, 'over');
  assert.equal(title, '대결 포기 - 패배');
  // Back to the menu: a new match.
  await page.click('.team-hud .results-menu');
  await page.evaluate(() => window.T.run(1));
  const fresh = await page.evaluate(() => ({ over: window.game.teamMatch.over, round: window.game.teamMatch.round, results: !document.querySelector('.team-hud .results').hidden }));
  assert.deepEqual(fresh, { over: false, round: 1, results: false });
  assert.deepEqual(page.errors, []);
});
