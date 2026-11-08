// Tactical readability online (Phase 18): in a team match with two humans on
// opposite teams, each client draws the ally chevrons over its own teammates
// only (host from its bots, member from its puppets), never over an enemy, and
// both show the same round state.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { startEnv, openGame, ROOT } from './harness.mjs';
let vite, relay, env;
before(async () => {
  vite = await createServer({ root: ROOT, logLevel: 'error', server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom' });
  const { createMpServer } = await vite.ssrLoadModule('/server/mp/server.ts');
  relay = createMpServer({ staticDir: null, log: () => {} });
  await new Promise((r) => relay.http.listen(0, '127.0.0.1', r));
  process.env.GRID_MP_PROXY = `http://127.0.0.1:${relay.http.address().port}`;
  env = await startEnv();
  delete process.env.GRID_MP_PROXY;
});
after(async () => { await env?.close(); await relay?.close(); await vite?.close(); });
const lobby = async (page, name, mode) => { await page.click('#tab-multi'); await page.fill('.mp-name', name); if (mode) await page.selectOption('.mp-mode', mode); };
test('team match, two clients: markers over allies only on each side; round state and alive counts agree', async () => {
  const host = await openGame(env, { mode: 'team', objective: 'elimination', width: 480, height: 270, quality: 'low' });
  const guest = await openGame(env, { mode: 'team', objective: 'elimination', width: 480, height: 270, quality: 'low' });
  for (const p of [host, guest]) p.setDefaultTimeout(120000);
  await lobby(host, 'Host', 'team');
  await host.click('.mp-quick');
  await host.waitForSelector('.mp-room:not([hidden])');
  const code = (await host.textContent('.mp-room-code')).trim();
  await lobby(guest, 'Guest');
  await guest.fill('.mp-code', code.toLowerCase());
  await guest.click('.mp-join-btn');
  await host.waitForFunction(() => document.querySelectorAll('.mp-members li').length === 2);
  for (const p of [host, guest]) { await p.click('#tab-play'); await p.click('.play-button'); await p.waitForFunction(() => window.game.input.active); }
  await host.waitForTimeout(4000);
  const state = (p) => p.evaluate(() => {
    const g = window.game;
    const mine = g.localTeam;
    // Where each marker stands: over whom (by team), from this client's own view of everyone.
    const V = g.camera.position.constructor; const M = g.camera.matrix.constructor; const m = new M();
    const people = g.netClient ? [...g.netClient.puppets.all.values()].filter((x) => x.alive).map((x) => ({ team: x.team, pos: x.position })) : g.squad.bots.filter((b) => b.alive).map((b) => ({ team: b.team, pos: b.controller.position }));
    let overAlly = 0, overEnemy = 0;
    for (let i = 0; i < g.allyMarkers.count; i++) { g.allyMarkers.mesh.getMatrixAt(i, m); const p = new V().setFromMatrixPosition(m); const who = people.find((q) => Math.hypot(q.pos.x - p.x, q.pos.z - p.z) < 0.05); if (who?.team === mine) overAlly++; else overEnemy++; }
    const pips = (sel) => [...document.querySelectorAll(sel + ' i')].map((i) => (i.classList.contains('down') ? 0 : 1)).join('');
    return { team: mine, role: g.netClient ? 'member' : 'host', markers: g.allyMarkers.count, overAlly, overEnemy, pips: [pips('.ta-pips-blue'), pips('.ta-pips-red')], alive: [document.querySelector('.ta-blue').textContent, document.querySelector('.ta-red').textContent], wins: [document.querySelector('.tb-wins-blue').textContent, document.querySelector('.tb-wins-red').textContent], round: document.querySelector('.tb-round').textContent };
  });
  // Let the round play (bots fight) for a while, sampling both sides at the same moment.
  const samples = [];
  for (let k = 0; k < 2; k++) {
    await host.waitForTimeout(3000);
    const [h, g] = await Promise.all([state(host), state(guest)]);
    samples.push({ h, g });
  }
  for (const { h, g } of samples) {
    assert.notEqual(h.team, g.team, 'the two humans are on opposite teams');
    assert.ok(h.markers >= 1 && g.markers >= 1, 'both draw markers over their teammates');
    assert.equal(h.overAlly, h.markers, 'host: every marker over a teammate');
    assert.equal(g.overAlly, g.markers, 'member: every marker over a teammate');
    assert.equal(h.overEnemy, 0, 'host: no marker over an enemy');
    assert.equal(g.overEnemy, 0, 'member: no marker over an enemy');
    assert.deepEqual(h.wins, g.wins, 'round wins agree');
    assert.equal(h.round, g.round);
    assert.deepEqual(h.alive, g.alive, 'alive counts agree');
  }
  assert.deepEqual([...host.errors, ...guest.errors], []);
  await host.context().close();
  await guest.context().close();
});
