// Round history (Phase 21) in the game: a team match played to its end
// through the real damage path; the results screen keeps everything it had
// (result, Phase 20 record, round chips, team tables, buttons) and adds
// 라운드 기록: one row per round (result for the player's team and the
// player's K / D / HS / DAMAGE in it); choosing a round shows how it ended,
// how long it took, the C4 and every player's numbers, BLUE and RED apart.
// No round records in deathmatch or training. Checked at 1920×1080,
// 1600×900, 1280×720 and phone sizes for overlap, cut-off and reach.

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

/** Two rounds won by BLUE through real hits (the player kills every enemy; the first of each round by the head): the match is over. */
async function playTwoRounds(page) {
  return page.evaluate(() => {
    const g = window.game;
    const tm = g.teamMatch;
    tm.config.roundsToWin = 2;
    const out = [];
    for (let r = 0; r < 2; r++) {
      let guard = 0;
      while (tm.phase !== 'live' && guard++ < 400) window.T.run(30);
      g.combat.protection = 1e9;
      const enemies = g.squad.bots.filter((b) => b.team !== g.localTeam && b.alive);
      enemies.forEach((b, i) => {
        b.combat.protection = 0;
        const hit = (amount, zone) =>
          b.combat.applyDamage({ amount, zone, sourceId: 'local', weaponId: 'ar01', point: b.position.clone(), direction: b.position.clone().set(1, 0, 0), distance: 12 });
        hit(60, 'body');
        hit(60, i === 0 ? 'head' : 'body');
      });
      window.T.run(5);
      out.push({ round: tm.round, phase: tm.phase, enemies: enemies.length });
    }
    window.T.run(5);
    return { out, over: tm.over, history: tm.history.length, stats: tm.roundStats.length };
  });
}

test('16: team match to its end: 라운드 기록 rows, a chosen round in detail (BLUE / RED, C4, time), the rest of the results screen kept', async () => {
  const page = await play({ mode: 'team', quality: 'low', width: 1600, height: 900 });
  try {
    const p = await playTwoRounds(page);
    assert.equal(p.over, true, JSON.stringify(p));
    assert.deepEqual([p.history, p.stats], [2, 2]);
    const enemies = p.out[0].enemies;
    const res = await page.evaluate(() => {
      const r = document.querySelector('.team-hud .results');
      const rows = [...r.querySelectorAll('.round-records tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent.trim()));
      return {
        shown: !r.hidden,
        title: r.querySelector('.results-title').textContent,
        personal: !r.querySelector('.results-personal').hidden,
        chips: r.querySelectorAll('.round-history li').length,
        teams: r.querySelectorAll('.results-teams table').length,
        buttons: r.querySelectorAll('.results-actions button').length,
        records: !r.querySelector('.round-records').hidden,
        head: [...r.querySelectorAll('.round-records thead th')].map((th) => th.textContent),
        rows,
        detailHidden: r.querySelector('.rr-detail').hidden,
      };
    });
    assert.equal(res.shown, true);
    assert.match(res.title, /BLUE 승리/);
    assert.ok(res.personal && res.chips === 2 && res.teams === 2 && res.buttons === 3, 'the existing parts are all still there');
    assert.equal(res.records, true);
    assert.deepEqual(res.head, ['라운드', '결과', 'K', 'D', 'HS', 'DAMAGE']);
    assert.deepEqual(res.rows, [
      ['1', '승리', String(enemies), '0', '1', String(enemies * 100)],
      ['2', '승리', String(p.out[1].enemies), '0', '1', String(p.out[1].enemies * 100)],
    ]);
    assert.equal(res.detailHidden, true, 'no detail until a round is chosen');
    // The round rows add up to the Phase 20 record on the same screen.
    const personal = await page.evaluate(() => ['cr-kills', 'cr-deaths', 'cr-hs', 'cr-dmg'].map((c) => Number(document.querySelector(`.team-hud .results-personal .${c} .cr-v`).textContent)));
    const sum = (i) => res.rows.reduce((a, r) => a + Number(r[i]), 0);
    assert.deepEqual(personal, [sum(2), sum(3), sum(4), sum(5)]);

    // Choose round 2 (a real click on its button).
    await page.click('.team-hud .round-records tbody tr[data-i="1"] .rr-pick');
    const d = await page.evaluate(() => {
      const el = document.querySelector('.team-hud .rr-detail');
      const team = (t) =>
        [...el.querySelectorAll(`.rr-team.${t} tbody tr`)].map((tr) => ({ me: tr.classList.contains('me'), cells: [...tr.children].map((td) => td.textContent) }));
      return {
        hidden: el.hidden,
        head: el.querySelector('.rr-head').textContent,
        lines: [...el.querySelectorAll('.rr-line')].map((x) => x.textContent),
        alive: el.querySelector('.rr-alive').textContent,
        blue: team('blue'),
        red: team('red'),
        blueHead: el.querySelector('.rr-team.blue thead th').textContent,
        selected: [...document.querySelectorAll('.team-hud .round-records tbody tr.sel')].map((tr) => tr.dataset.i),
        expanded: document.querySelector('.team-hud .round-records tr[data-i="1"] .rr-pick').getAttribute('aria-expanded'),
      };
    });
    assert.equal(d.hidden, false);
    assert.match(d.head, /^라운드 2 · BLUE 승리 · 전멸 · \d+:\d\d$/);
    assert.ok(d.lines.some((l) => /^공격 (BLUE|RED) · 방어 (BLUE|RED)$/.test(l)), `sides (${d.lines})`);
    assert.ok(d.lines.includes('C4 미설치'), `the C4 line (${d.lines})`);
    assert.match(d.alive, /^생존 BLUE \d+ : 0 RED$/);
    assert.equal(d.blue.length, 5);
    assert.equal(d.red.length, 5);
    assert.equal(d.blueHead, 'BLUE · 승리');
    const me = d.blue.filter((r) => r.me);
    assert.equal(me.length, 1, 'the player’s row is marked');
    assert.deepEqual(me[0].cells.slice(1), [String(p.out[1].enemies), '0', '1', String(p.out[1].enemies * 100)]);
    assert.ok(d.red.every((r) => r.cells[2] === '1'), 'every RED player died once in round 2');
    assert.deepEqual([d.selected, d.expanded], [['1'], 'true']);
    // Round 1, then round 1 again closes it.
    await page.click('.team-hud .round-records tbody tr[data-i="0"] .rr-pick');
    assert.match(await page.textContent('.team-hud .rr-head'), /^라운드 1 /);
    await page.click('.team-hud .round-records tbody tr[data-i="0"] .rr-pick');
    assert.equal(await page.evaluate(() => document.querySelector('.team-hud .rr-detail').hidden), true);

    // 9: 다시 시작: a new match, no round records until a round is decided.
    await page.evaluate(() => {
      window.game.restartMatch();
      window.T.run(5);
    });
    assert.deepEqual(await page.evaluate(() => [window.game.teamMatch.history.length, window.game.teamMatch.roundStats.length]), [0, 0]);
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});

test('11, 12: deathmatch results have no 라운드 기록; training has none either (its own record only)', async () => {
  const dm = await play({ mode: 'deathmatch', quality: 'low' });
  try {
    await dm.evaluate(() => {
      window.game.match.timeLeft = 0.01;
      window.T.run(3);
    });
    const r = await dm.evaluate(() => ({
      shown: !document.querySelector('.match-hud:not(.team-hud) .results').hidden,
      records: document.querySelector('.match-hud:not(.team-hud) .round-records'),
      visible: [...document.querySelectorAll('.round-records')].filter((e) => e.getClientRects().length).length,
    }));
    assert.deepEqual(r, { shown: true, records: null, visible: 0 });
  } finally {
    await dm.context().close();
  }
  const tr = await play({ mode: 'training', quality: 'low' });
  try {
    const r = await tr.evaluate(() => ({
      match: !!window.game.teamMatch || !!window.game.match,
      visible: [...document.querySelectorAll('.round-records')].filter((e) => e.getClientRects().length).length,
      training: !!window.game.trainingStats,
    }));
    assert.deepEqual(r, { match: false, visible: 0, training: true });
  } finally {
    await tr.context().close();
  }
});

for (const [w, h] of [
  [1920, 1080],
  [1600, 900],
  [1280, 720],
  [480, 270],
  [390, 844],
]) {
  test(`17: results with 라운드 기록 open at ${w}×${h}: no overlap, nothing cut off sideways, the buttons and round rows reachable`, async () => {
    const page = await play({ mode: 'team', quality: 'low', width: w, height: h });
    try {
      await playTwoRounds(page);
      await page.click('.team-hud .round-records tbody tr[data-i="1"] .rr-pick');
      const r = await page.evaluate(() => {
        const panel = document.querySelector('.team-hud .results-panel');
        const box = (e) => e.getBoundingClientRect().toJSON();
        const parts = ['.results-title', '.results-sub', '.results-personal', '.round-history', '.round-records', '.results-teams'].map((s) => [s, box(panel.querySelector(s))]);
        // Stacked parts of the panel must not overlap one another.
        const overlaps = [];
        for (let i = 0; i < parts.length; i++)
          for (let j = i + 1; j < parts.length; j++) {
            const [a, b] = [parts[i][1], parts[j][1]];
            if (a.height && b.height && a.left < b.right && b.left < a.right && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) overlaps.push(`${parts[i][0]} × ${parts[j][0]}`);
          }
        const wide = [...panel.querySelectorAll('.round-records, .rr-table, .rr-detail, .rr-teams table')].filter((e) => e.scrollWidth > e.clientWidth + 1 || box(e).right > box(panel).right + 1 || box(e).left < box(panel).left - 1).map((e) => e.className);
        // Reach: scroll each into view; the element at its centre must be it (or inside it).
        const reach = (el) => {
          el.scrollIntoView({ block: 'center' });
          const b = el.getBoundingClientRect();
          const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
          return !!hit && (hit === el || el.contains(hit));
        };
        return {
          vw: innerWidth,
          panelRight: box(panel).right,
          overlaps,
          wide,
          pick: reach(panel.querySelector('.round-records tr[data-i="0"] .rr-pick')),
          detail: reach(panel.querySelector('.rr-detail .rr-head')),
          buttons: [...panel.querySelectorAll('.results-actions button')].map(reach),
        };
      });
      assert.ok(r.panelRight <= r.vw + 0.5, `panel inside the screen (${r.panelRight} > ${r.vw})`);
      assert.deepEqual(r.overlaps, []);
      assert.deepEqual(r.wide, [], 'nothing wider than the panel (no sideways cut-off)');
      assert.equal(r.pick, true, 'round buttons reachable');
      assert.equal(r.detail, true, 'the detail reachable');
      assert.deepEqual(r.buttons, [true, true, true], '다시 시작 / 메뉴 / 로비 reachable');
      assert.deepEqual(page.errors, []);
    } finally {
      await page.context().close();
    }
  });
}
