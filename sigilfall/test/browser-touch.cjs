/* =============================================================================
   touch controls and mobile aim assist, driven with real pointer events on a
   phone sized landscape viewport.
     npm i -D playwright && node sigilfall/test/browser-touch.cjs
   ========================================================================== */
let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) { console.log('playwright is not installed - skipping the touch test'); process.exit(0); }

const URL = process.env.SIGILFALL_URL || 'http://localhost:8080/';
const CHROME = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const fail = [];
function check(cond, what) {
  console.log((cond ? '  ok   ' : '  FAIL ') + what);
  if (!cond) fail.push(what);
}

/* runs inside the page: a touch gesture on the control overlay */
function gesture(spec) {
  const el = document.getElementById('touch');
  const send = (type, x, y) => el.dispatchEvent(new PointerEvent(type, {
    pointerId: spec.id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, cancelable: true
  }));
  send('pointerdown', spec.from[0], spec.from[1]);
  const steps = spec.steps || 8;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    send('pointermove', spec.from[0] + (spec.to[0] - spec.from[0]) * t,
      spec.from[1] + (spec.to[1] - spec.from[1]) * t);
  }
  if (!spec.hold) send('pointerup', spec.to[0], spec.to[1]);
}

function release(spec) {
  document.getElementById('touch').dispatchEvent(new PointerEvent('pointerup', {
    pointerId: spec.id, pointerType: 'touch', clientX: spec.x, clientY: spec.y, bubbles: true
  }));
}

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage']
  });
  const ctx = await browser.newContext({
    viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2,
    userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36'
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.SIGILFALL, null, { timeout: 20000 });

  console.log('\nlayout');
  await page.evaluate(() => window.SIGILFALL.startMatch({
    mode: 'tdm', map: 'market', character: 'rift', botCount: 3, botLevel: 'easy'
  }));
  await page.waitForTimeout(700);
  check(await page.evaluate(() => window.SIGILFALL.touch.enabled), 'the touch pad turns on for a phone');
  check(await page.evaluate(() => document.body.classList.contains('touchui')), 'the HUD switches to the touch layout');
  check(await page.evaluate(() => document.getElementById('abilities').offsetParent === null),
    'the desktop ability bar is hidden so it cannot cover the buttons');

  const layout = await page.evaluate(() => window.SIGILFALL.touch.buttons.map((b) => {
    const r = b.el.getBoundingClientRect();
    return { id: b.def.id, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), r: Math.round(r.width / 2) };
  }));
  const vw = 844, vh = 390;
  check(layout.every((b) => b.x - b.r > -4 && b.x + b.r < vw + 4 && b.y - b.r > -4 && b.y + b.r < vh + 4),
    'every button sits inside the screen');
  let overlap = null;
  for (let i = 0; i < layout.length && !overlap; i++) {
    for (let j = i + 1; j < layout.length; j++) {
      const a = layout[i], b = layout[j];
      if (Math.hypot(a.x - b.x, a.y - b.y) < (a.r + b.r) * 0.82) { overlap = a.id + '/' + b.id; break; }
    }
  }
  check(!overlap, 'no two buttons overlap' + (overlap ? ' (' + overlap + ')' : ''));
  const btn = (id) => layout.find((b) => b.id === id);

  console.log('\nbuttons');
  const shotsBefore = await page.evaluate(() => window.SIGILFALL.game.player.stats.shots);
  await page.evaluate(gesture, { id: 11, from: [btn('fire').x, btn('fire').y], to: [btn('fire').x, btn('fire').y], steps: 1, hold: true });
  await page.waitForTimeout(700);
  const held = await page.evaluate(() => window.SIGILFALL.input.isDown('fire'));
  await page.evaluate(release, { id: 11, x: btn('fire').x, y: btn('fire').y });
  const shotsAfter = await page.evaluate(() => window.SIGILFALL.game.player.stats.shots);
  check(held, 'pressing the attack button holds fire');
  check(shotsAfter > shotsBefore, 'and shots come out (' + (shotsAfter - shotsBefore) + ')');
  check(!(await page.evaluate(() => window.SIGILFALL.input.isDown('fire'))), 'releasing it stops firing');

  for (const [id, slot] of [['dash', 'q'], ['ab1', 'a1'], ['ab2', 'a2']]) {
    const b = btn(id);
    await page.evaluate(gesture, { id: 12, from: [b.x, b.y], to: [b.x, b.y], steps: 1 });
    await page.waitForTimeout(300);
    const cd = await page.evaluate((s) => {
      const g = window.SIGILFALL.game;
      return g.abilities.cooldownLeft(g.player, s);
    }, slot);
    check(cd > 0, 'the ' + id + ' button casts ' + slot + ' (cooldown ' + cd.toFixed(1) + 's)');
  }
  const sweep = await page.evaluate(() => {
    const b = window.SIGILFALL.touch.buttons.find((x) => x.def.id === 'dash');
    return { cool: b.el.classList.contains('cool'), num: b.num.textContent };
  });
  check(sweep.cool && sweep.num !== '', 'a cooling ability shows its timer on the button');

  console.log('\nstick and look');
  const before = await page.evaluate(() => ({ ...window.SIGILFALL.game.player.pos }));
  await page.evaluate(gesture, { id: 13, from: [140, 300], to: [140, 200], steps: 6, hold: true });
  await page.waitForTimeout(900);
  const moving = await page.evaluate(() => {
    const p = window.SIGILFALL.game.player;
    return { speed: Math.hypot(p.vel.x, p.vel.z), axis: window.SIGILFALL.input.moveZ };
  });
  await page.evaluate(release, { id: 13, x: 140, y: 200 });
  check(moving.axis > 0.5, 'the stick pushes the movement axis (' + moving.axis.toFixed(2) + ')');
  check(moving.speed > 1.5, 'and the player walks (' + moving.speed.toFixed(1) + ' m/s)');
  const after = await page.evaluate(() => ({ ...window.SIGILFALL.game.player.pos }));
  check(Math.hypot(after.x - before.x, after.z - before.z) > 1, 'the player moved across the arena');
  check(await page.evaluate(() => window.SIGILFALL.input.moveZ === 0), 'letting go stops the player');

  // start the swipe above the button cluster, where a thumb actually looks around
  const yawBefore = await page.evaluate(() => window.SIGILFALL.game.player.yaw);
  await page.evaluate(gesture, { id: 14, from: [520, 110], to: [700, 110], steps: 10 });
  await page.waitForTimeout(200);
  const yawAfter = await page.evaluate(() => window.SIGILFALL.game.player.yaw);
  check(Math.abs(yawAfter - yawBefore) > 0.1, 'dragging the right side turns the view');

  const tapShots = await page.evaluate(async () => {
    const g = window.SIGILFALL.game;
    const before = g.player.stats.shots;
    const el = document.getElementById('touch');
    const ev = (type) => el.dispatchEvent(new PointerEvent(type, {
      pointerId: 15, pointerType: 'touch', clientX: 700, clientY: 160, bubbles: true
    }));
    ev('pointerdown');
    await new Promise((r) => setTimeout(r, 60));
    ev('pointerup');
    await new Promise((r) => setTimeout(r, 300));
    return g.player.stats.shots - before;
  });
  check(tapShots > 0, 'a quick tap on the look area shoots (' + tapShots + ')');

  console.log('\naim assist');
  const assist = await page.evaluate(() => {
    const a = window.SIGILFALL, g = a.game, p = g.player;
    const foe = g.fighters.find((f) => f !== p && g.isEnemy(p, f));
    if (!foe) return { ok: false };
    p.pos.x = 0; p.pos.z = 0;
    p.pos.y = g.world.supportAt(0, 0, 60, p.radius);
    p.yaw = 0; p.pitch = 0; p.aimDir();
    foe.alive = true;
    foe.pos.x = 3.2; foe.pos.z = -14;
    foe.pos.y = g.world.supportAt(foe.pos.x, foe.pos.z, 60, foe.radius);
    foe.spawnAt = -99;
    a.input.lastDevice = 'touch';
    const wanted = () => Math.abs(p.yaw - Math.atan2(-(foe.pos.x - p.pos.x), -(foe.pos.z - p.pos.z)));
    const before = wanted();
    for (let i = 0; i < 30; i++) {
      const adj = g.controller.assist.update(1 / 60, 0, 0, a.input);
      p.yaw += adj.dx; p.pitch += adj.dy; p.aimDir();
    }
    return { ok: true, before, after: wanted(), target: g.controller.assist.target ? g.controller.assist.target.name : null };
  });
  check(assist.ok && assist.target, 'the assist picked a visible enemy');
  check(assist.after < assist.before * 0.7,
    'and pulled the aim toward them (' + assist.before.toFixed(2) + ' -> ' + assist.after.toFixed(2) + ' rad)');

  const notAimbot = await page.evaluate(() => {
    const a = window.SIGILFALL, g = a.game, p = g.player;
    const foe = g.fighters.find((f) => f !== p && g.isEnemy(p, f));
    p.yaw = 0; p.pitch = 0; p.aimDir();
    foe.pos.x = 3.2; foe.pos.z = -14;
    g.controller.assist.clear();
    const adj = g.controller.assist.update(1 / 60, 0, 0, a.input);
    return Math.abs(adj.dx);
  });
  check(notAimbot > 0 && notAimbot < 0.08, 'one frame of assist is a nudge, not a snap (' + notAimbot.toFixed(4) + ' rad)');

  const blocked = await page.evaluate(() => {
    const a = window.SIGILFALL, g = a.game, p = g.player;
    const foe = g.fighters.find((f) => f !== p && g.isEnemy(p, f));
    foe.pos.x = -24.5; foe.pos.z = -14; foe.pos.y = 0;
    p.pos.x = 0; p.pos.z = -14; p.pos.y = g.world.supportAt(0, -14, 60, p.radius);
    p.yaw = Math.PI / 2; p.pitch = 0; p.aimDir();
    g.controller.assist.clear();
    g.controller.assist.update(1 / 60, 0, 0, a.input);
    return {
      wall: g.world.segBlocked(p.pos.x, p.eyeY, p.pos.z, foe.pos.x, foe.centerY, foe.pos.z),
      target: g.controller.assist.target
    };
  });
  check(blocked.wall, 'the test really did put a wall in the way');
  check(blocked.target === null, 'the assist never locks onto someone behind cover');

  const behind = await page.evaluate(() => {
    const a = window.SIGILFALL, g = a.game, p = g.player;
    const foe = g.fighters.find((f) => f !== p && g.isEnemy(p, f));
    foe.pos.x = 0; foe.pos.z = 12; foe.pos.y = g.world.supportAt(0, 12, 60, foe.radius);
    p.pos.x = 0; p.pos.z = 0; p.yaw = 0; p.pitch = 0; p.aimDir();
    g.controller.assist.clear();
    g.controller.assist.update(1 / 60, 0, 0, a.input);
    return g.controller.assist.target;
  });
  check(behind === null, 'and never onto someone behind the player');

  const dead = await page.evaluate(() => {
    const a = window.SIGILFALL, g = a.game, p = g.player;
    const foes = g.fighters.filter((f) => f !== p && g.isEnemy(p, f));
    p.pos.x = 0; p.pos.z = 0;
    p.pos.y = g.world.supportAt(0, 0, 60, p.radius);
    p.yaw = 0; p.pitch = 0; p.aimDir();
    // one enemy right in front, a second one a little further out to the side
    foes.forEach((f, i) => {
      f.alive = true;
      f.pos.x = i === 0 ? 2 : 6;
      f.pos.z = i === 0 ? -12 : -20;
      f.pos.y = g.world.supportAt(f.pos.x, f.pos.z, 60, f.radius);
      f.spawnAt = -99;
    });
    g.controller.assist.clear();
    g.controller.assist.update(1 / 60, 0, 0, a.input);
    const first = g.controller.assist.target;
    if (first) first.alive = false;
    g.controller.assist.update(1 / 60, 0, 0, a.input);
    const next = g.controller.assist.target;
    return {
      picked: !!first,
      droppedTheDead: next !== first,
      foundAnother: !!next && foes.length > 1
    };
  });
  check(dead.picked, 'the assist locks the nearest target');
  check(dead.droppedTheDead, 'a target that dies is dropped immediately');
  check(dead.foundAnother, 'and the next enemy is picked up on the following frame');

  const pcOff = await page.evaluate(() => {
    const a = window.SIGILFALL, g = a.game, p = g.player;
    const foe = g.fighters.find((f) => f !== p && g.isEnemy(p, f));
    foe.alive = true;
    foe.pos.x = 2; foe.pos.z = -12; foe.pos.y = g.world.supportAt(2, -12, 60, foe.radius);
    p.yaw = 0; p.pitch = 0; p.aimDir();
    a.input.lastDevice = 'kbm';          // a mouse is in charge now
    const yaw0 = p.yaw;
    g.controller.update(1 / 60, 1 / 60);
    return Math.abs(p.yaw - yaw0);
  });
  check(pcOff < 1e-6, 'with a mouse in hand the assist stays out of the way');

  check(errors.length === 0, 'no console errors' + (errors[0] ? ' (' + errors[0] + ')' : ''));
  await browser.close();
  console.log('\n' + (fail.length ? fail.length + ' checks failed' : 'all touch checks passed'));
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
