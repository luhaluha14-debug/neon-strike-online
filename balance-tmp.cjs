/* bot-only free-for-all, one of each character, to see whether any sorcerer
   dominates or is dead weight */
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
  const p = await (await b.newContext({viewport:{width:640,height:400}})).newPage();
  p.on('pageerror', e=>console.log('ERR', e.message));
  await p.goto('http://localhost:8080/'); await p.waitForFunction(()=>!!window.SIGILFALL);
  const totals = {};
  for (const map of ['shrine','market','sunken']) {
    await p.evaluate((m) => {
      const a = window.SIGILFALL;
      a.game.stop();
      a.startMatch({ mode:'ffa', map:m, character:'rift', botCount:7, botLevel:'hard' });
      const g = a.game;
      // one of each character among the bots, and keep the human out of it
      const chars = ['rift','brand','warden','vein','rift','brand','warden','vein'];
      g.fighters.filter(f=>f.isBot).forEach((f,i)=>{ f.setCharacter(chars[i % 4]); f.resetStats(); });
      g.player.alive = false; g.player.respawnAt = 1e9;
      g.player.pos.y = 60; g.player.pos.x = 0; g.player.pos.z = 0;
    }, map);
    await p.waitForTimeout(50000);
    const res = await p.evaluate(() => {
      const g = window.SIGILFALL.game, out = {};
      for (const f of g.fighters) {
        if (!f.isBot) continue;
        const o = out[f.charId] ||= { kills:0, deaths:0, dmg:0, shots:0, hits:0, n:0 };
        o.kills += f.stats.kills; o.deaths += f.stats.deaths; o.dmg += f.stats.damage;
        o.shots += f.stats.shots; o.hits += f.stats.hits; o.n++;
      }
      return { out, secs: Math.round(g.now) };
    });
    console.log(map, res.secs + 's', JSON.stringify(res.out));
    for (const [k,v] of Object.entries(res.out)) {
      const t = totals[k] ||= { kills:0, deaths:0, dmg:0, shots:0, hits:0, n:0 };
      for (const f of ['kills','deaths','dmg','shots','hits','n']) t[f] += v[f];
    }
  }
  console.log('\n=== totals ===');
  const rows = Object.entries(totals).map(([k,v]) => ({
    char:k, kills:v.kills, deaths:v.deaths,
    kd: +(v.kills/Math.max(1,v.deaths)).toFixed(2),
    dmgPerBot: Math.round(v.dmg/v.n),
    acc: v.shots ? Math.round(100*v.hits/v.shots)+'%' : '-'
  }));
  rows.sort((a,b)=>b.kills-a.kills);
  for (const r of rows) console.log(JSON.stringify(r));
  await b.close();
})();
