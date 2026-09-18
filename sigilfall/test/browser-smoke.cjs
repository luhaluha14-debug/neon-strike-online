/* headless smoke test: boot the page, start a match, play a bit, report errors */
const { chromium } = require('playwright');

(async () => {
  const mobile = process.argv.includes('--mobile');
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage']
  });
  const ctx = await browser.newContext(mobile
    ? { viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2,
        userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36' }
    : { viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const errors = [], logs = [];
  page.on('console', (m) => {
    const t = `${m.type()}: ${m.text()}`;
    logs.push(t);
    if (m.type() === 'error') errors.push(t);
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + (e && e.message)));

  await page.goto('http://localhost:8080/', { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.SIGILFALL, null, { timeout: 15000 });
  console.log('booted; device =', await page.evaluate(() => JSON.stringify(window.SIGILFALL.engine ? SIGILFALL.game.input.lastDevice : '?')));

  // start an offline match straight through the app API
  await page.evaluate(() => {
    window.SIGILFALL.cfg.botCount = 5;
    window.SIGILFALL.cfg.botLevel = 'hard';
    window.SIGILFALL.startMatch({ mode: 'tdm', map: 'shrine', character: 'rift' });
  });
  await page.waitForTimeout(500);

  const results = {};
  for (const [charId, map] of [['rift', 'shrine'], ['brand', 'market'], ['warden', 'sunken'], ['vein', 'shrine']]) {
    await page.evaluate(([c, m]) => {
      const a = window.SIGILFALL;
      a.game.stop();
      a.startMatch({ mode: 'tdm', map: m, character: c, botCount: 5, botLevel: 'hard' });
    }, [charId, map]);
    await page.waitForTimeout(400);
    // simulate a player: look around, move, fire, use every ability
    await page.evaluate(() => {
      const a = window.SIGILFALL, i = a.input;
      a._sim = setInterval(() => {
        i.setMove(Math.sin(Date.now() / 700), Math.cos(Date.now() / 900), 'kbm');
        i.addLook(0.02 * Math.sin(Date.now() / 300), 0.005, 'kbm');
        i.setHold('fire', (Date.now() % 900) < 500);
        if (Math.random() < 0.05) i.press('jump');
        if (Math.random() < 0.03) i.press('dash');
        if (Math.random() < 0.03) i.press('ability1');
        if (Math.random() < 0.03) i.press('ability2');
        if (Math.random() < 0.02) i.press('refocus');
        if (Math.random() < 0.05) i.press('ultimate');
        if (a.game.player) a.game.player.ult = 100;   // force domains to fire often
      }, 40);
    });
    await page.waitForTimeout(4500);
    await page.evaluate(() => clearInterval(window.SIGILFALL._sim));
    results[charId] = await page.evaluate(() => {
      const g = window.SIGILFALL.game;
      return {
        fps: g.engine.fps, now: Math.round(g.now), alive: g.fighters.filter((f) => f.alive).length,
        fighters: g.fighters.length, kills: g.fighters.reduce((s, f) => s + f.stats.kills, 0),
        dmg: Math.round(g.fighters.reduce((s, f) => s + f.stats.damage, 0)),
        shots: g.fighters.reduce((s, f) => s + f.stats.shots, 0),
        hits: g.fighters.reduce((s, f) => s + f.stats.hits, 0),
        proj: g.projectiles.list.length, zones: g.zones.list.length,
        domains: g.domains.list.length, summons: g.summons.list.length,
        scores: g.scores, playerHp: Math.round(g.player.hp), state: g.state
      };
    });
    console.log(charId, JSON.stringify(results[charId]));
  }

  await page.screenshot({ path: '/tmp/claude-0/-home-user-neon-strike-online/399cf41f-064e-5ada-b5c7-71c29d4d0bcd/scratchpad/shot-' + (mobile ? 'mobile' : 'pc') + '.png' });
  console.log('--- errors:', errors.length);
  for (const e of errors.slice(0, 20)) console.log('  ', e);
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
