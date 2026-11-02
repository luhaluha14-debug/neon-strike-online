// Combat feedback (real game, real Web Audio in the browser; no speakers):
// a shot, a hit (body / head) and a kill each have their own sound and none
// stands in for another; a shotgun round (and a member's round reported pellet
// by pellet by the host) is one hit marker and one hit sound; the kill confirm has its own voice pool, so a burst
// of impacts cannot cut it off; long full-auto fire (magazines and reloads)
// keeps the number of live voices bounded, releases them afterwards and adds
// no window / document / canvas listeners.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, openGame, installFrameDriver, countingInit } from './harness.mjs';

let env;
let page;

before(async () => {
  env = await startEnv();
  page = await openGame(env, { mode: 'deathmatch', init: countingInit });
  await page.click('.play-button');
  await page.waitForFunction(() => window.game.input.active && window.game.audio.state === 'running', null, { timeout: 30000 });
  await page.evaluate(() => window.game.audio.ready);
  await installFrameDriver(page);
  await page.evaluate(() => {
    window.T.stopLoop();
    const g = window.game;
    window.__played = [];
    const play = g.audio.play.bind(g.audio);
    g.audio.play = (id, o = {}) => {
      const ok = play(id, o);
      window.__played.push({ id, ok, group: o.group ?? 'foley' });
      return ok;
    };
    // Nobody but this test hurts anyone.
    g.squad.respawns = false;
    for (const b of g.squad.bots) b.combat.protection = 1e9;
    g.combat.protection = 1e9;
  });
});
after(async () => {
  await page?.context().close();
  await env?.close();
});

const played = () =>
  page.evaluate(() => {
    const out = window.__played;
    window.__played = [];
    return out;
  });
const ids = (list) => list.map((p) => p.id);

test('a shot, a hit, a head hit and a kill each sound different; a hit is not a kill and a kill is not just a hit', async () => {
  // A round that hits nothing: the gunshot only.
  const r = await page.evaluate(() => {
    const g = window.game;
    const w = g.weapons.weapon;
    const at = g.player.position.clone();
    const miss = { kind: 'miss', end: at };
    const body = { kind: 'target', zone: 'body', point: at, normal: at.clone().set(0, 1, 0), distance: 10, damage: 30, target: g.squad.bots[0].combat };
    g.weaponAudio.onShot(w, miss, 0, g.camera);
    const a = window.__played.splice(0);
    g.weaponAudio.onShot(w, body, 0, g.camera);
    const b = window.__played.splice(0);
    g.weaponAudio.onShot(w, { ...body, zone: 'head' }, 0, g.camera);
    const c = window.__played.splice(0);
    return { a: a.map((p) => p.id), b: b.map((p) => p.id), c: c.map((p) => p.id) };
  });
  assert.deepEqual(r.a, ['ar01.shot']);
  assert.deepEqual(r.b, ['ar01.shot', 'hit.body', 'impact.flesh']);
  assert.deepEqual(r.c, ['ar01.shot', 'hit.head', 'impact.flesh']);
  // A kill credited to the player: the kill confirm (its own pool), and nothing else from the kill itself.
  await played();
  await page.evaluate(() => {
    const b = window.game.squad.bots[0];
    b.combat.protection = 0;
    b.combat.applyDamage({ amount: 999, zone: 'body', sourceId: 'local', weaponId: 'ar01', point: b.position.clone(), direction: b.position.clone().set(0, 0, 1), distance: 5 });
  });
  const k = await played();
  assert.deepEqual(ids(k), ['kill.confirm']);
  assert.equal(k[0].group, 'confirm');
  assert.equal(k[0].ok, true, 'played by the engine');
  assert.deepEqual(page.errors, []);
});

test('one shotgun round: one hit marker and one hit sound however many pellets hit; a member hearing of each pellet from the host: the same', async () => {
  const r = await page.evaluate(async () => {
    const g = window.game;
    const T = window.T;
    const { SG_01 } = await import('/src/weapons/weapons.ts');
    const marks = [];
    const show = g.hud.showHitMarker.bind(g.hud);
    g.hud.showHitMarker = (head, kill) => (marks.push([head, kill]), show(head, kill));
    const hitSounds = () => window.__played.filter((p) => p.id === 'hit.body' || p.id === 'hit.head').map((p) => p.id);
    g.weapons.setLoadout([SG_01]);
    T.run(60);
    // A bot 3 m ahead, the player looking at its chest; one round.
    const p = g.player;
    const bot = g.squad.bots.find((b) => b.alive);
    const ahead = p.position.clone().add(p.position.clone().set(-Math.sin(p.yaw), 0, -Math.cos(p.yaw)).multiplyScalar(3));
    bot.controller.teleport(ahead, 0);
    bot.controller.position.y = p.position.y;
    p.pitch = -0.08;
    let pelletHits = 0;
    const onShot = g.weapons.events.onShot;
    g.weapons.events.onShot = (res, ...rest) => {
      if (res.kind === 'target') pelletHits++;
      onShot(res, ...rest);
    };
    window.__played = [];
    g.weapons.step({ fire: true, reload: false }, 1 / 120);
    g.weapons.step({ fire: false, reload: false }, 1 / 120);
    T.run(1);
    g.weapons.events.onShot = onShot;
    const local = { pelletHits, marks: marks.splice(0), sounds: hitSounds(), shots: window.__played.filter((x) => x.id === 'sg01.shot').length };
    // A room member's round: the host reports each pellet (seven body hits and a head hit) as its own message.
    T.run(10);
    window.__played = [];
    // Shown right after they arrive (a moment to gather the round), without waiting for a frame:
    // a member's frames may not be running.
    for (let i = 0; i < 7; i++) g.netHit({ k: 'hit', head: false, kill: false });
    g.netHit({ k: 'hit', head: true, kill: false });
    await new Promise((r) => setTimeout(r, 60));
    const net = { marks: marks.splice(0), sounds: hitSounds() };
    // Two rounds a fire interval apart (real time: reports are shown on arrival) are two confirms.
    T.run(10);
    window.__played = [];
    g.netHit({ k: 'hit', head: false, kill: false });
    await new Promise((r) => setTimeout(r, 100));
    g.netHit({ k: 'hit', head: false, kill: false });
    await new Promise((r) => setTimeout(r, 60));
    const two = { marks: marks.splice(0), sounds: hitSounds() };
    g.hud.showHitMarker = show;
    return { local, net, two };
  });
  assert.ok(r.local.pelletHits >= 2, `several pellets hit (${r.local.pelletHits})`);
  assert.equal(r.local.shots, 1, 'one gunshot');
  assert.equal(r.local.marks.length, 1, `one marker (${JSON.stringify(r.local.marks)})`);
  assert.equal(r.local.sounds.length, 1, `one hit sound (${r.local.sounds})`);
  assert.deepEqual(r.net, { marks: [[true, false]], sounds: ['hit.head'] });
  assert.deepEqual(r.two, { marks: [[false, false], [false, false]], sounds: ['hit.body', 'hit.body'] });
  assert.deepEqual(page.errors, []);
});

test(`another shooter's gunshot: farther = quieter, later and duller (low-pass); up close, full range`, async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const shots = [];
    const play = g.audio.play;
    g.audio.play = (id, o = {}) => (id.endsWith('.shot') && shots.push({ id, gain: o.gain, delay: o.delay, lowpass: o.lowpass ?? null }), play(id, o));
    const w = g.weapons.loadout[0];
    for (const d of [3, 50, 120]) {
      const origin = g.camera.position.clone().add(g.camera.position.clone().set(d, 0, 0));
      g.weaponAudio.onRemoteShot(w, origin, { kind: 'miss', end: origin }, g.camera);
    }
    g.audio.play = play;
    return shots;
  });
  assert.equal(r.length, 3);
  const [near, mid, far] = r;
  assert.equal(near.lowpass, null, 'up close: full range');
  assert.ok(mid.lowpass > 5000 && mid.lowpass < 9000, `50 m: ${mid.lowpass} Hz`);
  assert.ok(far.lowpass < mid.lowpass && far.lowpass >= 1200, `120 m: ${far.lowpass} Hz`);
  assert.ok(near.gain > mid.gain && mid.gain > far.gain, 'quieter with distance');
  assert.ok(near.delay < mid.delay && mid.delay < far.delay, 'later with distance');
});

test('the kill confirm is not cut off by a burst of impacts (its own voice pool)', async () => {
  const r = await page.evaluate(() => {
    const g = window.game;
    const e = g.audio;
    const b = g.squad.bots[1];
    b.combat.protection = 0;
    b.combat.applyDamage({ amount: 999, zone: 'head', sourceId: 'local', weaponId: 'ar01', point: b.position.clone(), direction: b.position.clone().set(0, 0, 1), distance: 5 });
    const confirm = e.voices.at(-1);
    // A full-auto burst into a wall right after: far more impacts than the impact pool holds.
    for (let i = 0; i < 20; i++) e.play('impact', { group: 'impact' });
    for (let i = 0; i < 8; i++) e.play('hit.body', { group: 'impact' });
    const live = (grp) => e.voices.filter((v) => v.group === grp && !v.ended).length;
    return { group: confirm.group, ended: confirm.ended, impact: live('impact') };
  });
  assert.deepEqual(r, { group: 'confirm', ended: false, impact: 6 });
});

test('long full-auto fire (several magazines and reloads): voices stay bounded and are released; no listeners pile up', async () => {
  await page.waitForTimeout(1200); // let earlier voices end
  const before = await page.evaluate(() => ({ counts: window.__counts(), voices: window.game.audio.voices.length }));
  let most = 0;
  for (let mag = 0; mag < 3; mag++) {
    await page.mouse.down();
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.T.run(60)); // 1 s of fire: 10 rounds at 600 RPM
      most = Math.max(most, await page.evaluate(() => window.game.audio.voices.filter((v) => !v.ended).length));
    }
    await page.mouse.up();
    await page.keyboard.press('KeyR');
    await page.evaluate(() => window.T.run(200)); // reload
  }
  const fired = await page.evaluate(() => window.__played.filter((p) => p.id === 'ar01.shot').length);
  assert.ok(fired >= 75, `rounds fired with sound (${fired})`);
  assert.ok(most <= 10 + 6 + 6 + 2, `live voices never exceed the pools (${most})`);
  await page.waitForTimeout(2500); // real time: the last sounds finish
  const after = await page.evaluate(() => ({ counts: window.__counts(), voices: window.game.audio.voices.length }));
  assert.ok(after.voices <= before.voices + 1, `voices released (${before.voices} → ${after.voices})`);
  assert.deepEqual(after.counts.listeners, before.counts.listeners, 'no listeners added by firing');
  assert.equal(after.counts.audio, before.counts.audio, 'one audio context');
  assert.deepEqual(page.errors, []);
});
