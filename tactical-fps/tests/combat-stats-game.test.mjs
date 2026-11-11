// Personal combat statistics (Phase 20) in the game: the HUD block (KILLS,
// DEATHS, K/D, HEADSHOTS, DAMAGE) shows the player's own score line, fed by
// the real damage path (hitscan → target → match); a shotgun blast of pellets
// is one kill; training keeps its own record; the results screens carry the
// record inside the existing panel; a new match starts from zero; the block
// fits at 1920×1080, 1600×900, 1280×720 and a short phone screen without
// covering the crosshair, health, weapon panel, top bar or kill feed.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, openGame, installFrameDriver } from './harness.mjs';

let env;

before(async () => {
  env = await startEnv();
});
after(async () => {
  await env?.close();
});

async function play(opts) {
  const page = await openGame(env, opts);
  await page.click('.play-button');
  await page.waitForFunction(() => window.game.input.active);
  await installFrameDriver(page);
  await page.evaluate(() => {
    window.T.stopLoop();
    window.T.run(20);
  });
  return page;
}

/** The HUD block's numbers as shown. */
const shown = (page) =>
  page.evaluate(() => {
    const q = (s) => document.querySelector(`.combat-stats ${s}`)?.textContent;
    const el = document.querySelector('.combat-stats');
    return { visible: !!el && !el.hidden && el.getClientRects().length > 0, kills: q('.cs-kills'), deaths: q('.cs-deaths'), kd: q('.cs-kd'), hs: q('.cs-hs'), dmg: q('.cs-dmg') };
  });

test('deathmatch: real hits through the hitscan feed the HUD; a shotgun blast of 8 pellets is one kill, 100 damage; HUD = board = kill feed', async () => {
  const page = await play({ mode: 'deathmatch', quality: 'low' });
  try {
    assert.deepEqual(await shown(page), { visible: true, kills: '0', deaths: '0', kd: '0.00', hs: '0', dmg: '0' });
    const r = await page.evaluate(async () => {
      const g = window.game;
      const { WEAPONS } = await import('/src/weapons/weapons.ts');
      g.squad.respawns = false;
      for (const b of g.squad.bots) b.combat.protection = 1e9;
      const V = g.camera.position.constructor;
      const target = g.squad.bots[0];
      target.combat.protection = 0;
      const chest = target.position.clone().add(new V(0, 1.2, 0));
      const head = target.position.clone().add(new V(0, 1.68, 0));
      // From 1.5 m away on a side with nothing in between (the bot's own facing is irrelevant to the hit).
      const clearSide = (b, y) => {
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * Math.PI * 2;
          const off = new V(Math.cos(a) * 1.5, 0, Math.sin(a) * 1.5);
          const o = b.position.clone().add(off).setY(b.position.y + y);
          const aim = b.position.clone().setY(b.position.y + y);
          const d = aim.clone().sub(o);
          if (g.map.collision.raycast(o, d.clone().normalize(), d.length() + 0.5) === null) return off;
        }
        throw new Error('no clear side');
      };
      const side = clearSide(target, 1.3);
      const from = (aim) => {
        const o = target.position.clone().add(side).setY(aim.y + 0.1);
        return { origin: o, direction: aim.clone().sub(o).normalize() };
      };
      const kinds = [];
      let notices = 0;
      const show = g.hud.showKillNotice.bind(g.hud);
      g.hud.showKillNotice = (t) => {
        notices++;
        show(t);
      };
      // SG-01: 8 pellets, all aimed at the chest (8 × 18 nominal = 144): 100 health taken, one kill.
      for (let p = 0; p < 8; p++) {
        const res = g.hitscan.fire({ ...from(chest), damage: WEAPONS.sg01.damage, sourceId: 'local', weaponId: 'sg01' });
        kinds.push(res.kind);
      }
      window.T.run(2);
      const afterSg = (({ kills, deaths, headshots, damage }) => ({ kills, deaths, headshots, damage }))(g.match.scores.get('local'));
      // Second bot: AR-01 headshot kill.
      const t2 = g.squad.bots[1];
      t2.combat.protection = 0;
      const h2 = t2.position.clone().add(new V(0, 1.68, 0));
      const side2 = clearSide(t2, 1.68);
      let n = 0;
      while (t2.alive && n++ < 10) {
        const o = t2.position.clone().add(side2).setY(h2.y);
        g.hitscan.fire({ origin: o, direction: h2.clone().sub(o).normalize(), damage: WEAPONS.ar01.damage, sourceId: 'local', weaponId: 'ar01' });
      }
      window.T.run(2);
      g.hud.showKillNotice = show;
      const line = g.match.scores.get('local');
      const feed = g.match.feed.filter((k) => k.killer === 'local');
      return {
        kinds,
        afterSg,
        line: { kills: line.kills, deaths: line.deaths, headshots: line.headshots, damage: line.damage },
        feed: { kills: feed.length, hs: feed.filter((k) => k.head).length },
        notices,
        head,
        pellet: WEAPONS.sg01.damage.base,
      };
    });
    // As many pellets as it takes for 100 health (6 × 18 since Phase 26-A, 7 × 15 before) hit; the rest pass
    // the body already going down (they hit nothing alive).
    const need = Math.ceil(100 / r.pellet);
    const hits = r.kinds.filter((k) => k === 'target').length;
    assert.equal(need, 6);
    assert.ok(hits >= need && r.kinds.slice(0, hits).every((k) => k === 'target'), `the pellets hit until the kill (${r.kinds})`);
    assert.deepEqual(r.afterSg, { kills: 1, deaths: 0, headshots: 0, damage: 100 });
    assert.equal(r.line.kills, 2);
    assert.equal(r.line.headshots, 1);
    assert.equal(r.line.damage, 200, 'each kill took exactly 100 health (armour-free bots), however many hits');
    assert.deepEqual(r.feed, { kills: 2, hs: 1 }, 'the kill feed says the same');
    assert.equal(r.notices, 2, 'one kill notice per kill (none per pellet)');
    assert.deepEqual(await shown(page), { visible: true, kills: '2', deaths: '0', kd: '2.00', hs: '1', dmg: '200' });

    // The player dies: a death, K/D follows.
    await page.evaluate(() => {
      const g = window.game;
      g.combat.protection = 0;
      g.combat.applyDamage({ amount: 999, zone: 'body', sourceId: g.squad.bots[2].id, weaponId: 'ar01', point: g.player.position.clone(), direction: g.player.position.clone().set(1, 0, 0), distance: 10 });
      window.T.run(2);
    });
    assert.deepEqual(await shown(page), { visible: true, kills: '2', deaths: '1', kd: '2.00', hs: '1', dmg: '200' });
    const botLine = await page.evaluate(() => (({ kills, damage }) => ({ kills, damage }))(window.game.match.scores.get(window.game.squad.bots[2].id)));
    assert.deepEqual(botLine, { kills: 1, damage: 100 }, 'the bot’s kill and the health it took, by the same rules');

    // 14: the end of the match: the record inside the existing results panel (title, board and buttons kept).
    await page.evaluate(() => {
      window.game.match.timeLeft = 0.01;
      window.T.run(3);
    });
    const res = await page.evaluate(() => {
      const r = document.querySelector('.match-hud:not(.team-hud) .results');
      const p = r.querySelector('.results-personal');
      const cell = (c) => p.querySelector(`.${c} .cr-v`)?.textContent;
      return {
        shown: !r.hidden,
        title: r.querySelector('.results-title').textContent,
        board: r.querySelectorAll('.results-table tbody tr').length,
        buttons: r.querySelectorAll('.results-actions button').length,
        personal: !p.hidden,
        mode: p.querySelector('.cr-mode').textContent,
        cells: ['cr-kills', 'cr-deaths', 'cr-kd', 'cr-hs', 'cr-dmg'].map(cell),
      };
    });
    assert.equal(res.shown, true);
    assert.match(res.title, /^(승리|패배)$/);
    assert.ok(res.board >= 2 && res.buttons === 3, 'the existing board and buttons are still there');
    assert.equal(res.personal, true);
    assert.match(res.mode, /데스매치/);
    assert.deepEqual(res.cells, ['2', '1', '2.00', '1', '200']);

    // 9: 다시 시작: a new match, every number back to zero.
    await page.evaluate(() => {
      window.game.restartMatch();
      window.T.run(5);
    });
    assert.deepEqual(await shown(page), { visible: true, kills: '0', deaths: '0', kd: '0.00', hs: '0', dmg: '0' });
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});

test('team match: the record carries through the round change; the results panel shows it with the mode', async () => {
  const page = await play({ mode: 'team', quality: 'low' });
  try {
    const r = await page.evaluate(() => {
      const g = window.game;
      const tm = g.teamMatch;
      // Into the live round.
      while (tm.phase !== 'live') window.T.run(30);
      for (const b of g.squad.bots) b.combat.protection = 1e9;
      g.combat.protection = 1e9;
      const enemies = g.squad.bots.filter((b) => b.team !== g.localTeam);
      const kill = (b, head) => {
        b.combat.protection = 0;
        b.combat.applyDamage({ amount: 60, zone: 'body', sourceId: 'local', weaponId: 'ar01', point: b.position.clone(), direction: b.position.clone().set(1, 0, 0), distance: 10 });
        b.combat.applyDamage({ amount: 60, zone: head ? 'head' : 'body', sourceId: 'local', weaponId: 'ar01', point: b.position.clone(), direction: b.position.clone().set(1, 0, 0), distance: 10 });
      };
      kill(enemies[0], true);
      // A teammate shot by mistake (friendly fire is off in play; were it to happen, it credits nothing).
      const mate = g.squad.bots.find((b) => b.team === g.localTeam);
      mate.combat.protection = 0;
      mate.combat.applyDamage({ amount: 30, zone: 'body', sourceId: 'local', weaponId: 'ar01', point: mate.position.clone(), direction: mate.position.clone().set(1, 0, 0), distance: 10 });
      mate.combat.protection = 1e9;
      const round1 = tm.round;
      const r1 = (({ kills, deaths, headshots, damage }) => ({ kills, deaths, headshots, damage }))(tm.scores.get('local'));
      // End the round (the rest of the enemies down by someone else), on to the next live round.
      for (const b of enemies.slice(1)) {
        b.combat.protection = 0;
        b.combat.applyDamage({ amount: 999, zone: 'body', sourceId: mate.id, weaponId: 'ar01', point: b.position.clone(), direction: b.position.clone().set(1, 0, 0), distance: 10 });
      }
      let guard = 0;
      while ((tm.round === round1 || tm.phase !== 'live') && guard++ < 400) window.T.run(30);
      const r2 = (({ kills, deaths, headshots, damage }) => ({ kills, deaths, headshots, damage }))(tm.scores.get('local'));
      return { round1, round2: tm.round, r1, r2 };
    });
    assert.deepEqual(r.r1, { kills: 1, deaths: 0, headshots: 1, damage: 100 }, 'kill + head, 100 health taken; nothing for the teammate');
    assert.ok(r.round2 > r.round1, `a new round (${r.round1} → ${r.round2})`);
    assert.deepEqual(r.r2, r.r1, 'the round change keeps the match record');
    assert.deepEqual(await shown(page), { visible: true, kills: '1', deaths: '0', kd: '1.00', hs: '1', dmg: '100' });
    // The match ends (forfeit is the quickest end): the record in the team results panel.
    const res = await page.evaluate(() => {
      const g = window.game;
      g.hasStarted = true;
      g.forfeitMatch?.();
      if (!g.teamMatch.over) {
        g.teamMatch.forfeit('red');
      }
      window.T.run(3);
      const r = document.querySelector('.team-hud .results');
      const p = r.querySelector('.results-personal');
      return { shown: !r.hidden, personal: !p.hidden, mode: p.querySelector('.cr-mode')?.textContent, kills: p.querySelector('.cr-kills .cr-v')?.textContent, history: !!r.querySelector('.round-history'), teams: !!r.querySelector('.results-teams table') };
    });
    assert.equal(res.shown, true);
    assert.equal(res.personal, true);
    assert.match(res.mode, /팀전/);
    assert.equal(res.kills, '1');
    assert.ok(res.history && res.teams, 'the round history and team tables are still there');
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});

test('13: training keeps its own record from the dummies; the next match starts from its own zero', async () => {
  const page = await play({ mode: 'training', quality: 'low' });
  try {
    const r = await page.evaluate(async () => {
      const g = window.game;
      const { WEAPONS } = await import('/src/weapons/weapons.ts');
      const V = g.camera.position.constructor;
      const t = g.trainingRange.targets.find((x) => x.alive);
      // AR-01 to the chest until it drops, then the HUD.
      let n = 0;
      while (t.alive && n++ < 20) {
        const aim = t.object.getWorldPosition(new V()).add(new V(0, 1.25, 0));
        const o = aim.clone().add(new V(0, 0.1, 2));
        g.hitscan.fire({ origin: o, direction: aim.clone().sub(o).normalize(), damage: WEAPONS.ar01.damage, sourceId: 'local', weaponId: 'ar01' });
      }
      window.T.run(2);
      return { down: !t.alive, stats: { ...g.trainingStats }, match: !!g.match || !!g.teamMatch };
    });
    assert.equal(r.down, true);
    assert.equal(r.match, false);
    assert.deepEqual({ kills: r.stats.kills, deaths: r.stats.deaths, damage: r.stats.damage }, { kills: 1, deaths: 0, damage: 100 });
    assert.deepEqual((await shown(page)).kills, '1');
    assert.equal((await shown(page)).dmg, '100');
  } finally {
    await page.context().close();
  }
  // The same browser profile later in a deathmatch: nothing from training there.
  const dm = await play({ mode: 'deathmatch', quality: 'low' });
  try {
    assert.deepEqual(await shown(dm), { visible: true, kills: '0', deaths: '0', kd: '0.00', hs: '0', dmg: '0' });
    assert.equal(await dm.evaluate(() => window.game.trainingStats.kills), 0, 'training starts its own record again whenever training starts');
  } finally {
    await dm.context().close();
  }
});

for (const [w, h] of [
  [1920, 1080],
  [1600, 900],
  [1280, 720],
  [740, 360],
]) {
  test(`HUD block at ${w}×${h}: on screen, clear of the crosshair, health, weapon panel, top bar and kill feed; hidden in the menu`, async () => {
    const page = await play({ mode: 'team', quality: 'low', width: w, height: h });
    try {
      // Fill it with big numbers (the widest it gets in a long match).
      await page.evaluate(() => {
        const l = window.game.teamMatch.scores.get('local');
        Object.assign(l, { kills: 128, deaths: 97, headshots: 64, damage: 18450 });
        // Feed entries so the kill feed has its size.
        const tm = window.game.teamMatch;
        for (let i = 0; i < 5; i++) tm.feed.push({ killer: 'bot-6', victim: 'bot-1', weaponId: 'ar01', head: true, at: tm.elapsed });
        window.T.run(2);
      });
      const r = await page.evaluate(() => {
        const box = (s) => {
          const e = [...document.querySelectorAll(s)].find((x) => x.getClientRects().length);
          return e ? e.getBoundingClientRect().toJSON() : null;
        };
        return {
          vw: innerWidth,
          vh: innerHeight,
          stats: box('.combat-stats'),
          vitals: box('.vitals'),
          weapon: box('.hud .weapon'),
          crosshair: box('.crosshair'),
          bar: box('.team-hud .team-bar'),
          feed: box('.team-hud .killfeed li') ? box('.team-hud .killfeed') : null,
          text: document.querySelector('.combat-stats').innerText.replace(/\s+/g, ' '),
        };
      });
      const s = r.stats;
      assert.ok(s, 'shown');
      assert.ok(s.left >= 0 && s.top >= 0 && s.right <= r.vw && s.bottom <= r.vh, `inside the screen (${JSON.stringify(s)})`);
      const overlap = (a, b) => !!a && !!b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      for (const k of ['vitals', 'weapon', 'crosshair', 'bar', 'feed']) assert.equal(overlap(s, r[k]), false, `clear of ${k} (${JSON.stringify(r[k])})`);
      assert.ok(s.bottom <= r.vitals.top, 'just above the health panel');
      assert.match(r.text, /KILLS 128 DEATHS 97 K\/D 1\.32 HEADSHOTS 64 DAMAGE 18450/);
      // The menu open: not shown over it.
      const inMenu = await page.evaluate(() => {
        window.game.hud.setPlaying?.(false);
        document.querySelector('.hud').classList.remove('playing');
        return getComputedStyle(document.querySelector('.combat-stats')).visibility;
      });
      assert.equal(inMenu, 'hidden');
      assert.deepEqual(page.errors, []);
    } finally {
      await page.context().close();
    }
  });
}
