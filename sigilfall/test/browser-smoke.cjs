/* =============================================================================
   browser smoke test.  boots the real page in headless chromium, plays a match
   with every character, then runs two clients through an online match.

     npm i -D playwright && node sigilfall/test/browser-smoke.cjs [--mobile]

   it skips itself when playwright is not installed, so `npm test` stays light.
   ========================================================================== */
const path = require('path');

let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) {
  console.log('playwright is not installed - skipping the browser smoke test');
  console.log('  npm i -D playwright   to run it');
  process.exit(0);
}

const MOBILE = process.argv.includes('--mobile');
const KEEP = process.argv.includes('--screenshots');
const URL = process.env.SIGILFALL_URL || 'http://localhost:8080/';
const OUT = process.env.SIGILFALL_SHOTS || path.join(__dirname, '..', '..', 'shots');
const CHROME = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const MOBILE_CTX = {
  viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2,
  userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36'
};

const fail = [];
function check(cond, what) {
  console.log((cond ? '  ok   ' : '  FAIL ') + what);
  if (!cond) fail.push(what);
}

async function newPage(browser, mobile) {
  const ctx = await browser.newContext(mobile ? MOBILE_CTX : { viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('console', (m) => { if (m.type() === 'error') page.errors.push(m.text()); });
  page.on('pageerror', (e) => page.errors.push('pageerror: ' + e.message));
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.SIGILFALL, null, { timeout: 20000 });
  return page;
}

/* drives the input manager the way a player would */
const DRIVE = `(() => {
  const a = window.SIGILFALL, i = a.input;
  clearInterval(a._sim);
  a._sim = setInterval(() => {
    i.setMove(Math.sin(Date.now() / 700), Math.cos(Date.now() / 900), 'kbm');
    i.addLook(0.02 * Math.sin(Date.now() / 300), 0.004, 'kbm');
    i.setHold('fire', (Date.now() % 900) < 520);
    const r = Math.random();
    if (r < 0.05) i.press('jump');
    else if (r < 0.09) i.press('dash');
    else if (r < 0.13) i.press('ability1');
    else if (r < 0.17) i.press('ability2');
    else if (r < 0.19) i.press('refocus');
    else if (r < 0.22) i.press('ultimate');
  }, 40);
})()`;

async function offline(browser) {
  console.log('\noffline match');
  const page = await newPage(browser, MOBILE);
  const plan = [['rift', 'shrine', 'tdm'], ['brand', 'market', 'ffa'], ['warden', 'sunken', 'tdm'], ['vein', 'shrine', 'duel']];
  for (const [character, map, mode] of plan) {
    await page.evaluate(([c, m, mo]) => {
      const a = window.SIGILFALL;
      a.game.stop();
      a.startMatch({ mode: mo, map: m, character: c, botCount: 5, botLevel: 'hard' });
      if (a.game.player) a.game.player.ult = 100;
    }, [character, map, mode]);
    await page.waitForTimeout(300);
    await page.evaluate(DRIVE);
    await page.waitForTimeout(4200);
    await page.evaluate(() => clearInterval(window.SIGILFALL._sim));
    const s = await page.evaluate(() => {
      const g = window.SIGILFALL.game;
      const sum = (f) => g.fighters.reduce((n, x) => n + f(x), 0);
      return {
        fps: g.engine.fps, secs: Math.round(g.now), fighters: g.fighters.length,
        shots: sum((f) => f.stats.shots), hits: sum((f) => f.stats.hits),
        dmg: Math.round(sum((f) => f.stats.damage)), kills: sum((f) => f.stats.kills),
        moved: g.fighters.filter((f) => f.isBot && (Math.abs(f.vel.x) + Math.abs(f.vel.z)) > 0.4).length,
        bots: g.fighters.filter((f) => f.isBot).length,
        grounded: g.fighters.every((f) => !f.alive || f.pos.y > -2 && f.pos.y < 24)
      };
    });
    console.log('  ' + character + '/' + map + '/' + mode + ' ' + JSON.stringify(s));
    check(s.shots > 0, character + ': shots were fired');
    if (mode !== 'duel') check(s.dmg > 0, character + ': damage was dealt');
    check(s.grounded, character + ': nobody fell out of the world');
    if (mode !== 'duel') check(s.moved > 0 || s.bots === 0, character + ': bots are moving');
    if (KEEP) await page.screenshot({ path: path.join(OUT, `match-${character}-${map}.png`) });
  }
  check(page.errors.length === 0, 'no console errors offline' + (page.errors[0] ? ' (' + page.errors[0] + ')' : ''));
  await page.context().close();
}

/* walks at the nearest enemy, circles out of cover, and opens fire once it can
   actually see them: a duel in fast forward */
const CONVERGE = `(() => {
  const a = window.SIGILFALL, i = a.input, g = a.game;
  clearInterval(a._sim);
  let side = Math.random() < 0.5 ? 1 : -1, flip = 0;
  a._sim = setInterval(() => {
    const p = g.player;
    if (!p || !p.alive) { i.setHold('fire', false); return; }
    const foe = g.fighters.find((f) => f !== p && f.alive && g.isEnemy(p, f));
    if (!foe) { i.setMove(0, 0, 'kbm'); i.setHold('fire', false); return; }
    const dx = foe.pos.x - p.pos.x, dz = foe.pos.z - p.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    p.yaw = Math.atan2(-dx, -dz);
    p.pitch = Math.atan2(foe.centerY - p.eyeY, d);
    const see = g.canSee(p, foe.pos.x, foe.centerY, foe.pos.z);
    if (Date.now() > flip) { flip = Date.now() + 1200; if (!see) side *= -1; }
    // walk in when far, and slide sideways while something is in the way
    i.setMove(see ? 0 : side, d > 3.5 ? 1 : 0, 'kbm');
    i.setHold('sprint', d > 12);
    i.setHold('fire', see && d < 46);
  }, 40);
})()`;

async function online(browser) {
  console.log('\nonline match');
  const host = await newPage(browser, false);
  const guest = await newPage(browser, false);

  const code = await host.evaluate(async () => {
    const a = window.SIGILFALL;
    a.cfg.playerName = 'HOST';
    await a.net.connect();
    a.net.create('tdm', 'shrine', 'rift');
    return new Promise((res) => a.net.on('room', (r) => res(r.code)));
  });
  check(!!code && code.length === 4, 'the host created a room (' + code + ')');

  const joined = await guest.evaluate(async (c) => {
    const a = window.SIGILFALL;
    a.cfg.playerName = 'GUEST';
    await a.net.connect();
    a.net.join(c, 'vein');
    return new Promise((res) => a.net.on('room', (r) => res(r.ps.length)));
  }, code);
  check(joined >= 2, 'the guest joined the same room (' + joined + ' players)');

  await host.evaluate(() => window.SIGILFALL.net.startMatch());
  await host.waitForFunction(() => window.SIGILFALL.game.active, null, { timeout: 8000 });
  await guest.waitForFunction(() => window.SIGILFALL.game.active, null, { timeout: 8000 });
  check(true, 'both clients entered the match');

  await host.evaluate(DRIVE);
  await guest.evaluate(DRIVE);
  await host.waitForTimeout(6000);
  await host.evaluate(() => clearInterval(window.SIGILFALL._sim));
  await guest.evaluate(() => clearInterval(window.SIGILFALL._sim));

  const read = (page) => page.evaluate(() => {
    const g = window.SIGILFALL.game, n = window.SIGILFALL.net;
    const others = g.fighters.filter((f) => f !== g.player);
    return {
      fighters: g.fighters.length,
      bots: others.length,
      ping: n.pingMs, healthy: n.healthy,
      me: { x: +g.player.pos.x.toFixed(2), z: +g.player.pos.z.toFixed(2), hp: Math.round(g.player.hp), id: g.player.id },
      others: others.map((f) => ({ id: f.id, name: f.name, x: +f.pos.x.toFixed(2), z: +f.pos.z.toFixed(2), hp: Math.round(f.hp) })),
      scores: g.scores,
      damage: Math.round(g.fighters.reduce((s, f) => s + f.stats.damage, 0))
    };
  });
  const h = await read(host), gu = await read(guest);
  console.log('  host  ' + JSON.stringify(h));
  console.log('  guest ' + JSON.stringify(gu));

  check(h.fighters >= 2 && gu.fighters >= 2, 'both clients see the whole roster');
  check(h.healthy && gu.healthy, 'snapshots keep arriving on both clients');

  const guestOnHost = h.others.find((o) => o.id === gu.me.id);
  check(!!guestOnHost, 'the host sees the guest');
  if (guestOnHost) {
    const off = Math.hypot(guestOnHost.x - gu.me.x, guestOnHost.z - gu.me.z);
    console.log('  position error host<->guest: ' + off.toFixed(2) + ' m');
    check(off < 6, 'the guest is drawn near where they actually are (' + off.toFixed(2) + ' m)');
  }
  const hostOnGuest = gu.others.find((o) => o.id === h.me.id);
  check(!!hostOnGuest, 'the guest sees the host');
  const guestHpBefore = gu.me.hp;

  // walk both of them to a spot where they can see each other, a few metres at
  // a time so the server's movement check accepts every step, then let them
  // shoot: this is the part that proves the server is judging real hits
  const walkTo = async (page, target) => {
    // stop the autopilot first: a stale movement axis would walk them back off
    await page.evaluate(() => {
      clearInterval(window.SIGILFALL._sim);
      window.SIGILFALL.input.clear();
    });
    for (let i = 0; i < 14; i++) {
      const done = await page.evaluate((t) => {
        const g = window.SIGILFALL.game, p = g.player;
        const dx = t[0] - p.pos.x, dz = t[1] - p.pos.z;
        const d = Math.hypot(dx, dz);
        const step = Math.min(d, 9);
        p.pos.x += (dx / (d || 1)) * step;
        p.pos.z += (dz / (d || 1)) * step;
        p.pos.y = g.world.supportAt(p.pos.x, p.pos.z, p.pos.y + 3, p.radius);
        p.vel.x = p.vel.y = p.vel.z = 0;
        return d < 0.5;
      }, target);
      if (done) break;
      await page.waitForTimeout(140);
    }
  };
  await host.evaluate(() => clearInterval(window.SIGILFALL._sim));
  await guest.evaluate(() => clearInterval(window.SIGILFALL._sim));
  await walkTo(host, [0, -22]);
  await walkTo(guest, [0, -12]);
  await host.waitForTimeout(400);

  await guest.evaluate(() => window.SIGILFALL.input.clear());
  const facing = await host.evaluate(() => {
    const g = window.SIGILFALL.game, p = g.player;
    window.SIGILFALL.input.clear();
    const foe = g.fighters.find((f) => f !== p && g.isEnemy(p, f));
    const dx = foe.pos.x - p.pos.x, dz = foe.pos.z - p.pos.z;
    p.yaw = Math.atan2(-dx, -dz);
    p.pitch = Math.atan2(foe.centerY - p.eyeY, Math.hypot(dx, dz));
    p.aimDir();
    return { dist: Math.hypot(dx, dz), see: g.canSee(p, foe.pos.x, foe.centerY, foe.pos.z) };
  });
  console.log('  firing line: ' + facing.dist.toFixed(1) + ' m, clear = ' + facing.see);
  check(facing.see, 'the two clients have a clear line between them');

  const rejected = await host.evaluate(async () => {
    const g = window.SIGILFALL.game, net = window.SIGILFALL.net;
    const foe = g.fighters.find((f) => f !== g.player && g.isEnemy(g.player, f));
    const before = foe.hp;
    // a claim for absurd damage, from a distance the shooter is nowhere near
    net.send({ t: 'hit', a: g.player.char.primary.id, h: [{ id: foe.id, n: 9999, d: 120 }] });
    await new Promise((r) => setTimeout(r, 600));
    return { before, after: foe.hp };
  });
  check(rejected.before > 0 && rejected.after === rejected.before,
    'an impossible claim is rejected by the server (' + rejected.before + ' -> ' + rejected.after + ')');

  await host.evaluate(() => window.SIGILFALL.input.setHold('fire', true));
  await host.waitForTimeout(2500);
  await host.evaluate(() => window.SIGILFALL.input.setHold('fire', false));
  await host.waitForTimeout(400);

  const h2 = await read(host), gu2 = await read(guest);
  const hurtBy = guestHpBefore - gu2.me.hp;
  console.log('  guest health ' + guestHpBefore + ' -> ' + gu2.me.hp);
  check(hurtBy > 0, 'the server accepted the host\'s hits and applied them (' + hurtBy + ')');
  const hostView = h2.others.find((o) => o.id === gu2.me.id);
  check(!!hostView && Math.abs(hostView.hp - gu2.me.hp) <= 35,
    'health agrees between the two clients (' + (hostView ? hostView.hp : '?') + ' vs ' + gu2.me.hp + ')');
  check(JSON.stringify(h2.scores) === JSON.stringify(gu2.scores), 'the score agrees on both clients');

  // somebody arriving mid match should drop straight into the fight
  const late = await newPage(browser, false);
  const lateIn = await late.evaluate(async (c) => {
    const a = window.SIGILFALL;
    a.cfg.playerName = 'LATE';
    await a.net.connect();
    a.net.join(c, 'warden');
    await new Promise((r) => setTimeout(r, 2500));
    const g = a.game;
    return {
      active: g.active,
      alive: g.player.alive,
      others: g.fighters.length - 1,
      mode: g.mode ? g.mode.id : null
    };
  }, code);
  console.log('  late joiner ' + JSON.stringify(lateIn));
  check(lateIn.active && lateIn.mode === 'tdm', 'a player joining mid match lands in the running match');
  check(lateIn.others >= 1, 'and sees the players already fighting');
  const seenByHost = await host.evaluate(() => window.SIGILFALL.game.fighters.some((f) => f.name === 'LATE'));
  check(seenByHost, 'and the people already there see them arrive');
  check(late.errors.length === 0, 'no console errors on the late joiner' + (late.errors[0] ? ' (' + late.errors[0] + ')' : ''));
  await late.context().close();

  check(host.errors.length === 0, 'no console errors on the host' + (host.errors[0] ? ' (' + host.errors[0] + ')' : ''));
  check(guest.errors.length === 0, 'no console errors on the guest' + (guest.errors[0] ? ' (' + guest.errors[0] + ')' : ''));
  if (KEEP) {
    await host.screenshot({ path: path.join(OUT, 'online-host.png') });
    await guest.screenshot({ path: path.join(OUT, 'online-guest.png') });
  }
  await host.context().close();
  await guest.context().close();
}

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage']
  });
  try {
    await offline(browser);
    await online(browser);
  } finally {
    await browser.close();
  }
  console.log('\n' + (fail.length ? fail.length + ' checks failed' : 'all browser checks passed'));
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
