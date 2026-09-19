/* =============================================================================
   interface walk-through.  clicks the real buttons the way a player would and
   checks each screen actually appears and works.
     npm i -D playwright && node sigilfall/test/browser-ui.cjs
   ========================================================================== */
let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) { console.log('playwright is not installed - skipping the interface test'); process.exit(0); }

const URL = process.env.SIGILFALL_URL || 'http://localhost:8080/';
const CHROME = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const MOBILE = process.argv.includes('--mobile');

const fail = [];
function check(cond, what) {
  console.log((cond ? '  ok   ' : '  FAIL ') + what);
  if (!cond) fail.push(what);
}

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage']
  });
  const ctx = await browser.newContext(MOBILE
    ? { viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2,
        userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) Mobile Safari/537.36' }
    : { viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.SIGILFALL, null, { timeout: 20000 });

  const visible = (id) => page.evaluate((i) => {
    const el = document.getElementById(i);
    return !!el && !el.classList.contains('hide');
  }, id);
  const click = async (id) => { await page.click('#' + id); await page.waitForTimeout(160); };
  const count = (sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel);

  console.log('\nmenus');
  check(await visible('screenMenu'), 'the main menu is up after booting');

  await click('btnChars');
  check(await visible('screenChars'), 'characters screen opens');
  const cards = await count('#roster .card');
  check(cards >= 4, 'the roster shows every character (' + cards + ')');
  for (let i = 0; i < cards; i++) {
    await page.evaluate((n) => document.querySelectorAll('#roster .card')[n].click(), i);
    await page.waitForTimeout(90);
    const rows = await count('#kit .k');
    if (rows < 6) { check(false, 'character ' + i + ' lists its whole kit'); break; }
    if (i === cards - 1) check(true, 'every character lists all six abilities');
  }
  await click('btnPickChar');
  check(await visible('screenMenu'), 'picking a character returns to the menu');

  await click('btnLoadout');
  check(await visible('screenLoadout'), 'loadout opens');
  const charmCards = await count('#charms .card');
  check(charmCards >= 4, 'the loadout offers charms (' + charmCards + ')');
  const charmApplied = await page.evaluate(async () => {
    const cards = document.querySelectorAll('#charms .card');
    cards[1].click();
    await new Promise((r) => setTimeout(r, 120));
    const saved = JSON.parse(localStorage.getItem('sigilfall.settings.v1') || '{}');
    return { charm: window.SIGILFALL.cfg.charm, saved: saved.charms };
  });
  check(charmApplied.charm && charmApplied.charm !== 'none', 'picking a charm updates the loadout (' + charmApplied.charm + ')');
  check(!!charmApplied.saved, 'and it is saved per character');
  check((await count('#loadoutSummary .opt')) >= 4, 'the loadout shows what it changes');
  await click('btnLoadoutBack');
  check(await visible('screenMenu'), 'loadout returns to the menu');

  await click('btnSettings');
  check(await visible('screenSettings'), 'settings open');
  const tabs = await count('#setTabs button');
  check(tabs >= 4, 'settings has its tabs (' + tabs + ')');
  for (let i = 0; i < tabs; i++) {
    await page.evaluate((n) => document.querySelectorAll('#setTabs button')[n].click(), i);
    await page.waitForTimeout(90);
    const rows = await count('#setList .opt');
    if (rows < 1) { check(false, 'settings tab ' + i + ' has content'); break; }
    if (i === tabs - 1) check(true, 'every settings tab renders options');
  }
  // move a slider and make sure it is remembered
  await page.evaluate(() => {
    document.querySelectorAll('#setTabs button')[0].click();
  });
  await page.waitForTimeout(120);
  const changed = await page.evaluate(() => {
    const r = document.querySelector('#setList input[type=range]');
    r.value = String(Number(r.max) * 0.6);
    r.dispatchEvent(new Event('input', { bubbles: true }));
    return JSON.parse(localStorage.getItem('sigilfall.settings.v1') || '{}').sensitivity;
  });
  check(typeof changed === 'number', 'a settings change is saved to storage');
  await click('btnSetBack');

  await click('btnHow');
  check(await visible('screenHow'), 'how to play opens');
  check((await count('#howList .opt')) >= 5, 'it lists the controls');
  await click('btnHowBack');

  console.log('\nmatch flow');
  await click('btnPlay');
  check(await visible('screenPlay'), 'match setup opens');
  check((await count('#setupList .opt')) >= 5, 'setup offers mode, map, bots, difficulty, character');
  // pick free-for-all through the interface
  await page.evaluate(() => {
    const rows = document.querySelectorAll('#setupList .opt');
    rows[0].querySelectorAll('.seg button')[1].click();
  });
  await page.waitForTimeout(140);
  await click('btnStartMatch');
  await page.waitForTimeout(700);
  const inMatch = await page.evaluate(() => window.SIGILFALL.game.active);
  check(inMatch, 'the match starts from the menu');
  const charmLive = await page.evaluate(() => {
    const p = window.SIGILFALL.game.player;
    return { charm: p.charm.id, want: window.SIGILFALL.cfg.charm, hp: p.maxHp, base: p.char.hp };
  });
  check(!!charmLive.charm, 'the chosen charm is carried into the match (' + charmLive.charm + ')');
  check(charmLive.charm === charmLive.want, 'the match runs the charm the loadout chose');
  check(await page.evaluate(() => document.getElementById('hud').classList.contains('on')), 'the HUD is up');
  check(await page.evaluate(() => window.SIGILFALL.game.mode.id === 'ffa'), 'it started the mode we chose');
  check((await count('#abilities .ab')) === 4 || MOBILE, 'the ability bar has four slots');

  await page.keyboard.press('Escape');
  await page.waitForTimeout(220);
  check(await visible('screenPause'), 'escape pauses');
  await click('btnPauseSettings');
  check(await visible('screenSettings'), 'settings open from the pause menu');
  await click('btnSetBack');
  check(await visible('screenPause'), 'and come back to it');
  await click('btnResume');
  check(!(await visible('screenPause')) && await page.evaluate(() => !window.SIGILFALL.paused), 'resume returns to the fight');

  // end the match through the real code path
  await page.evaluate(() => {
    const g = window.SIGILFALL.game;
    g.scores[g.player.team] = g.mode.target;
    g.endMatch(g.player.team, 'score');
  });
  await page.waitForTimeout(1400);
  check(await visible('screenEnd'), 'the end screen appears');
  check((await count('#endBoard tr')) >= 2, 'the end screen shows the scoreboard');
  await click('btnEndMenu');
  check(await visible('screenMenu'), 'and returns to the menu');

  console.log('\nonline lobby');
  const onlineOffered = await page.evaluate(() =>
    !document.getElementById('btnOnline').classList.contains('hide'));
  if (!onlineOffered) {
    check(true, 'a build with no server hides online play instead of offering it');
    check(errors.length === 0, 'no console errors' + (errors[0] ? ' (' + errors[0] + ')' : ''));
    await browser.close();
    console.log('\n' + (fail.length ? fail.length + ' checks failed' : 'all interface checks passed'));
    process.exit(fail.length ? 1 : 0);
  }
  await click('btnOnline');
  await page.waitForTimeout(900);
  check(await visible('screenLobby'), 'the online lobby opens');
  await page.fill('#inName', '테스트');
  await click('btnCreate');
  await page.waitForTimeout(700);
  check(await visible('screenRoom'), 'creating a room opens the room screen');
  const code = await page.textContent('#roomCode');
  check(!!code && code.trim().length === 4, 'the room shows a join code (' + code + ')');
  check((await count('#roomPlayers .prow')) >= 1, 'the room lists its players');
  await click('btnRoomLeave');
  await page.waitForTimeout(400);
  check(await visible('screenLobby'), 'leaving returns to the lobby');
  await click('btnLobbyBack');
  check(await visible('screenMenu'), 'and back to the menu');

  check(errors.length === 0, 'no console errors' + (errors[0] ? ' (' + errors[0] + ')' : ''));
  await browser.close();
  console.log('\n' + (fail.length ? fail.length + ' checks failed' : 'all interface checks passed'));
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
