/* =============================================================================
   balance harness.  runs bot-only free-for-alls across every arena with one of
   each sorcerer and prints how they did.  it is a measuring tool, not a pass or
   fail test: bots use cover, timing and counters far worse than people do, so
   the numbers say "is somebody only half fighting", not "is this fair".

     npm i -D playwright
     node sigilfall/test/balance.cjs [--seconds 50] [--map shrine]
   ========================================================================== */
let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) { console.log('playwright is not installed - skipping the balance run'); process.exit(0); }

const URL = process.env.SIGILFALL_URL || 'http://localhost:8080/';
const CHROME = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const arg = (name, fallback) => {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const SECONDS = Number(arg('seconds', 50));
const MAPS = arg('map', '') ? [arg('map', '')] : ['shrine', 'market', 'sunken'];
const LEVEL = arg('level', 'hard');

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage']
  });
  const page = await (await browser.newContext({ viewport: { width: 640, height: 400 } })).newPage();
  page.on('pageerror', (e) => console.log('ERR', e.message));
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.SIGILFALL, null, { timeout: 20000 });

  const totals = {};
  for (const map of MAPS) {
    await page.evaluate(([m, level]) => {
      const a = window.SIGILFALL;
      a.game.stop();
      const roster = a.roster;            // whatever the roster holds today
      a.startMatch({ mode: 'ffa', map: m, character: roster[0], botCount: 7, botLevel: level });
      const g = a.game;
      // one of each sorcerer among the bots; the human sits this one out
      g.fighters.filter((f) => f.isBot).forEach((f, i) => {
        f.setCharacter(roster[i % roster.length]);
        f.resetStats();
      });
      g.player.alive = false;
      g.player.respawnAt = 1e9;
      g.player.pos.y = 60;
    }, [map, LEVEL]);

    await page.waitForTimeout(SECONDS * 1000);
    const res = await page.evaluate(() => {
      const g = window.SIGILFALL.game, out = {};
      for (const f of g.fighters) {
        if (!f.isBot) continue;
        const o = out[f.charId] || (out[f.charId] = { kills: 0, deaths: 0, dmg: 0, shots: 0, hits: 0, n: 0 });
        o.kills += f.stats.kills;
        o.deaths += f.stats.deaths;
        o.dmg += f.stats.damage;
        o.shots += f.stats.shots;
        o.hits += f.stats.hits;
        o.n++;
      }
      return out;
    });
    console.log(map.padEnd(8), JSON.stringify(res));
    for (const [k, v] of Object.entries(res)) {
      const t = totals[k] || (totals[k] = { kills: 0, deaths: 0, dmg: 0, shots: 0, hits: 0, n: 0 });
      for (const f of ['kills', 'deaths', 'dmg', 'shots', 'hits', 'n']) t[f] += v[f];
    }
  }

  console.log('\n' + 'sorcerer'.padEnd(10) + 'kills  deaths  K/D   damage/bot  accuracy');
  const rows = Object.entries(totals).map(([char, v]) => ({
    char,
    kills: v.kills,
    deaths: v.deaths,
    kd: v.kills / Math.max(1, v.deaths),
    dmg: Math.round(v.dmg / Math.max(1, v.n)),
    acc: v.shots ? Math.round((100 * v.hits) / v.shots) : 0
  })).sort((a, b) => b.kd - a.kd);
  for (const r of rows) {
    console.log(r.char.padEnd(10) +
      String(r.kills).padEnd(7) + String(r.deaths).padEnd(8) +
      r.kd.toFixed(2).padEnd(6) + String(r.dmg).padEnd(12) + r.acc + '%');
  }
  const kds = rows.map((r) => r.kd);
  const spread = Math.max(...kds) - Math.min(...kds);
  console.log('\nK/D spread ' + spread.toFixed(2) + (spread > 0.8 ? '  <- worth a look' : '  (tight enough)'));
  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
