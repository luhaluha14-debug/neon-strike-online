// Kill confirm sound: only for kills the match credits to the player, once
// each. Pure rules in Node (KillConfirm, Match / TeamMatch credit), then the
// real game: a kill plays it once, a hit that does not kill, a bot's kill,
// a teammate, a kill outside a live round, damage to the dead and the
// training dummies do not; the sound goes through the audio engine (volume).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { ROOT, startEnv, openGame, installFrameDriver } from './harness.mjs';

let vite;
let M;
let env;
let page;

before(async () => {
  vite = await createServer({ root: ROOT, logLevel: 'error', server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom' });
  M = {
    ...(await vite.ssrLoadModule('/src/game/KillConfirm.ts')),
    ...(await vite.ssrLoadModule('/src/game/Match.ts')),
    ...(await vite.ssrLoadModule('/src/game/TeamMatch.ts')),
    ...(await vite.ssrLoadModule('/src/audio/weaponSounds.ts')),
  };
  env = await startEnv();
});
after(async () => {
  await page?.context().close();
  await env?.close();
  await vite?.close();
});

test('rules: a key is confirmed once; matches report whether the kill was credited', () => {
  let played = 0;
  const kc = new M.KillConfirm(() => played++);
  assert.equal(kc.confirm('1:bot-2:1'), true);
  assert.equal(kc.confirm('1:bot-2:1'), false, 'the same kill again');
  assert.equal(kc.confirm('1:bot-2:2'), true, 'the same bot killed again later');
  assert.deepEqual([played, kc.count], [2, 2]);

  const dm = new M.Match({ bots: 2, timeLimit: 600, killTarget: 2 }, [{ id: 'local', name: 'YOU', isPlayer: true }, { id: 'bot-1', name: 'B1', isPlayer: false }, { id: 'bot-2', name: 'B2', isPlayer: false }]);
  assert.equal(dm.recordKill('local', 'bot-1', 'ar01', false), true);
  assert.equal(dm.recordKill('local', 'local', 'c4', false), false, 'a suicide');
  assert.equal(dm.recordKill('world', 'bot-2', 'fall', false), false, 'no killer in the match');
  assert.equal(dm.recordKill('local', 'bot-2', 'ar01', true), true, 'second kill ends the match');
  assert.equal(dm.over, true);
  assert.equal(dm.recordKill('local', 'bot-1', 'ar01', false), false, 'after the end');

  const roster = [{ id: 'local', name: 'YOU', team: 'blue', isPlayer: true }, { id: 'bot-1', name: 'B1', team: 'blue', isPlayer: false }, { id: 'bot-5', name: 'R5', team: 'red', isPlayer: false }];
  const tm = new M.TeamMatch(M.DEFAULT_TEAM_MATCH, roster);
  assert.equal(tm.recordKill('local', 'bot-5', 'ar01', false), false, 'prep: not live');
  tm.update(tm.config.prepTime + 0.01, { blue: 2, red: 1 });
  assert.equal(tm.phase, 'live');
  assert.equal(tm.recordKill('local', 'bot-1', 'ar01', false), false, 'a teammate');
  assert.equal(tm.recordKill('local', 'bot-5', 'ar01', true), true, 'an enemy in a live round');
  // The sound itself is synthesized like the others (no file).
  const pcm = M.renderSound('kill.confirm', 0, { srFireInterval: 1.2 });
  assert.ok(pcm.length > 1000 && pcm.some((v) => Math.abs(v) > 0.1));
  assert.equal(M.VARIANTS['kill.confirm'], 1);
});

/** Kill confirm plays (`ok`: what the audio engine answered) since the last call. */
const take = () =>
  page.evaluate(() => {
    const out = window.__kc;
    window.__kc = [];
    return out;
  });

/** Lethal (or `amount`) damage to `id` from `source` through the bot's own combat (the real damage → match path). */
const hurt = (id, source, amount = 999) =>
  page.evaluate(
    ([id, source, amount]) => {
      const g = window.game;
      const b = g.squad.bots.find((x) => x.id === id);
      b.combat.protection = 0;
      b.combat.applyDamage({ amount, zone: 'body', sourceId: source, weaponId: 'ar01', point: b.position.clone(), direction: b.position.clone().set(0, 0, 1), distance: 5 });
      window.T.run(2);
      return b.alive;
    },
    [id, source, amount],
  );

test('deathmatch: a kill by the player plays once; a hit, a bot’s kill and damage to the dead do not', async () => {
  page = await openGame(env, { mode: 'deathmatch' });
  await page.click('.play-button');
  await page.waitForFunction(() => window.game.input.active && window.game.audio.state === 'running', null, { timeout: 30000 });
  await installFrameDriver(page);
  await page.evaluate(() => {
    window.T.stopLoop();
    window.__kc = [];
    const g = window.game;
    const play = g.audio.play.bind(g.audio);
    g.audio.play = (id, o) => {
      const ok = play(id, o);
      if (id === 'kill.confirm') window.__kc.push(ok);
      return ok;
    };
  });
  assert.equal(await hurt('bot-1', 'local', 10), true, 'a hit that does not kill');
  assert.deepEqual(await take(), []);
  assert.equal(await hurt('bot-1', 'local'), false);
  assert.deepEqual(await take(), [true], 'one kill, one sound (played by the engine)');
  assert.equal(await page.evaluate(() => window.game.match.scores.get('local').kills), 1);
  await hurt('bot-1', 'local');
  assert.deepEqual(await take(), [], 'damage to the dead: no second death, no sound');
  await hurt('bot-2', 'bot-3');
  assert.deepEqual(await take(), [], 'a bot’s kill');
  // The same kill reported twice (key already confirmed).
  const again = await page.evaluate(() => {
    const g = window.game;
    return g.killConfirm.confirm(g.killKey('bot-1'));
  });
  assert.equal(again, false);
  assert.deepEqual(await take(), []);
  // Volume 0: the request still goes to the engine, which plays nothing (settings respected).
  await page.evaluate(() => window.game.audio.setVolume(0));
  await hurt('bot-3', 'local');
  assert.deepEqual(await take(), [false]);
  await page.evaluate(() => window.game.audio.setVolume(1));
  assert.deepEqual(page.errors, []);
});

test('team match: no sound before the round is live or for a teammate; an enemy kill in a live round plays once', async () => {
  await page.evaluate(() => document.exitPointerLock());
  await page.waitForFunction(() => !window.game.input.active);
  await page.selectOption('select[data-setting="mode"]', 'team');
  await page.click('.play-button');
  await page.waitForFunction(() => window.game.input.active && window.game.teamMatch);
  const ids = await page.evaluate(() => {
    const g = window.game;
    return { blue: g.squad.bots.find((b) => b.team === 'blue').id, red: g.squad.bots.filter((b) => b.team === 'red').map((b) => b.id) };
  });
  assert.equal(await page.evaluate(() => window.game.teamMatch.phase), 'prep');
  await hurt(ids.red[0], 'local');
  assert.deepEqual(await take(), [], 'prep phase: not credited');
  await page.evaluate(() => {
    window.game.teamMatch.ready();
    window.T.run(3);
  });
  assert.equal(await page.evaluate(() => window.game.teamMatch.phase), 'live');
  await hurt(ids.blue, 'local');
  assert.deepEqual(await take(), [], 'a teammate (friendly fire is off; even forced damage is not credited)');
  await hurt(ids.red[1], 'local');
  assert.deepEqual(await take(), [true]);
  assert.deepEqual(page.errors, []);
});

test('training: knocking down a dummy is not an enemy kill (no sound)', async () => {
  await page.evaluate(() => document.exitPointerLock());
  await page.waitForFunction(() => !window.game.input.active);
  await page.selectOption('select[data-setting="mode"]', 'training');
  const down = await page.evaluate(() => {
    const g = window.game;
    const t = g.trainingRange.targets[0];
    t.applyDamage({ amount: 999, zone: 'head', sourceId: 'local', weaponId: 'ar01', point: t.position?.clone?.() ?? g.player.position.clone(), direction: g.player.position.clone().set(0, 0, -1), distance: 5 });
    window.T.run(2);
    return !t.alive;
  });
  assert.equal(down, true);
  assert.deepEqual(await take(), []);
  assert.deepEqual(page.errors, []);
});
