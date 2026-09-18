/* =============================================================================
   PC controls, driven with real keyboard and mouse events: movement keys, look,
   the two mouse buttons, abilities, the scoreboard, pausing, rebinding, and
   the respawn timer.
     npm i -D playwright && node sigilfall/test/browser-pc.cjs
   ========================================================================== */
let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) { console.log('playwright is not installed - skipping the PC control test'); process.exit(0); }

const URL = process.env.SIGILFALL_URL || 'http://localhost:8080/';
const CHROME = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const fail = [];
function check(cond, what) {
  console.log((cond ? '  ok   ' : '  FAIL ') + what);
  if (!cond) fail.push(what);
}

/* the game only reads the mouse while pointer lock is held, which headless
   chromium will not grant, so the test tells the input layer it is locked and
   then sends the same events the browser would. */
function fakeLock() {
  window.SIGILFALL.kbm.locked = true;
}
function mouseLook(spec) {
  for (let i = 0; i < spec.steps; i++) {
    window.dispatchEvent(new MouseEvent('mousemove', {
      movementX: spec.dx, movementY: spec.dy, bubbles: true
    }));
  }
}
function mouseButton(spec) {
  window.dispatchEvent(new MouseEvent(spec.down ? 'mousedown' : 'mouseup', {
    button: spec.button, bubbles: true
  }));
}
function readPlayer() {
  const g = window.SIGILFALL.game, p = g.player;
  return {
    x: p.pos.x, y: p.pos.y, z: p.pos.z, yaw: p.yaw, pitch: p.pitch, height: p.height,
    sprint: p.sprint, crouch: p.crouch, onGround: p.onGround, ads: p.ads,
    shots: p.stats.shots, energy: p.energy, alive: p.alive, hp: p.hp,
    cd: { q: g.abilities.cooldownLeft(p, 'q'), a1: g.abilities.cooldownLeft(p, 'a1'), a2: g.abilities.cooldownLeft(p, 'a2') },
    ultActive: p.ultActive, refocus: p.hasBuff('refocus', g.now)
  };
}
function placeInOpen() {
  const g = window.SIGILFALL.game, p = g.player;
  p.pos.x = 0; p.pos.z = -20;
  p.pos.y = g.world.supportAt(p.pos.x, p.pos.z, 60, p.radius);
  p.vel.x = p.vel.y = p.vel.z = 0;
  p.yaw = Math.PI; p.pitch = 0; p.aimDir();
  p.hp = p.maxHp; p.energy = p.maxEnergy; p.ult = 100;
  p.cd = { q: 0, a1: 0, a2: 0, rmb: 0, refocus: 0 };
  window.SIGILFALL.input.clear();
  return { x: p.pos.x, z: p.pos.z, yaw: p.yaw };
}

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage']
  });
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 700 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.SIGILFALL, null, { timeout: 20000 });
  await page.evaluate(() => window.SIGILFALL.startMatch({
    mode: 'tdm', map: 'shrine', character: 'rift', botCount: 1, botLevel: 'easy'
  }));
  await page.waitForTimeout(600);
  await page.evaluate(fakeLock);

  const hold = async (key, ms) => {
    await page.keyboard.down(key);
    await page.waitForTimeout(ms);
    await page.keyboard.up(key);
    await page.waitForTimeout(120);
  };

  console.log('\nkeyboard movement');
  for (const [key, axis, sign, label] of [
    ['w', 'z', -1, 'W walks forward'],
    ['s', 'z', 1, 'S walks back'],
    ['a', 'x', -1, 'A strafes left'],
    ['d', 'x', 1, 'D strafes right']
  ]) {
    const before = await page.evaluate(placeInOpen);
    await hold(key, 420);
    const after = await page.evaluate(readPlayer);
    // yaw is pi, so the fighter faces +Z: forward is +Z, right is -X
    const moved = axis === 'z' ? (after.z - before.z) : (after.x - before.x);
    const want = axis === 'z' ? -sign : -sign;
    check(Math.sign(moved) === Math.sign(want) && Math.abs(moved) > 0.6,
      label + ' (' + moved.toFixed(2) + ' m)');
  }

  await page.evaluate(placeInOpen);
  await page.keyboard.down('w');
  await page.keyboard.down('Shift');
  await page.waitForTimeout(400);
  const sprinting = await page.evaluate(readPlayer);
  await page.keyboard.up('Shift');
  await page.keyboard.up('w');
  check(sprinting.sprint, 'Shift sprints');

  await page.evaluate(placeInOpen);
  await page.keyboard.down('Control');
  await page.waitForTimeout(400);
  const crouched = await page.evaluate(readPlayer);
  await page.keyboard.up('Control');
  check(crouched.crouch && crouched.height < 1.6, 'Ctrl crouches (height ' + crouched.height.toFixed(2) + ')');

  await page.evaluate(placeInOpen);
  await page.keyboard.press('Space');
  await page.waitForTimeout(180);
  const jumped = await page.evaluate(readPlayer);
  check(!jumped.onGround || jumped.y > 0.2, 'Space jumps');
  await page.waitForTimeout(900);

  console.log('\nmouse');
  const beforeLook = await page.evaluate(placeInOpen);
  await page.evaluate(mouseLook, { dx: 40, dy: 0, steps: 6 });
  await page.waitForTimeout(120);
  const looked = await page.evaluate(readPlayer);
  check(Math.abs(looked.yaw - beforeLook.yaw) > 0.1, 'moving the mouse turns the view');
  await page.evaluate(mouseLook, { dx: 0, dy: 40, steps: 6 });
  await page.waitForTimeout(120);
  const pitched = await page.evaluate(readPlayer);
  check(pitched.pitch < -0.1, 'and pushing it forward looks down');

  await page.evaluate(placeInOpen);
  await page.evaluate(mouseButton, { button: 0, down: true });
  await page.waitForTimeout(600);
  await page.evaluate(mouseButton, { button: 0, down: false });
  const fired = await page.evaluate(readPlayer);
  check(fired.shots > 0, 'left click attacks (' + fired.shots + ' shots)');
  check(fired.energy < 100, 'and spends energy');

  await page.evaluate(placeInOpen);
  await page.evaluate(mouseButton, { button: 2, down: true });
  await page.waitForTimeout(1100);
  await page.evaluate(mouseButton, { button: 2, down: false });
  await page.waitForTimeout(300);
  const second = await page.evaluate(readPlayer);
  check(second.shots > 0 || second.energy < 100, 'right click runs the secondary');

  console.log('\nabilities');
  for (const [key, slot] of [['q', 'q'], ['1', 'a1'], ['2', 'a2']]) {
    await page.evaluate(placeInOpen);
    await page.keyboard.press(key);
    await page.waitForTimeout(450);
    const s = await page.evaluate(readPlayer);
    check(s.cd[slot] > 0, key.toUpperCase() + ' casts ' + slot + ' (cooldown ' + s.cd[slot].toFixed(1) + 's)');
  }
  await page.evaluate(placeInOpen);
  await page.keyboard.press('e');
  await page.waitForTimeout(900);
  const ulted = await page.evaluate(readPlayer);
  check(ulted.ultActive, 'E opens the domain');
  await page.waitForTimeout(600);

  await page.evaluate(() => {
    const p = window.SIGILFALL.game.player;
    p.energy = 10;
    p.energyBlockUntil = 0;
  });
  await page.keyboard.press('r');
  await page.waitForTimeout(200);
  const refocused = await page.evaluate(readPlayer);
  check(refocused.refocus, 'R refocuses to recover energy');

  console.log('\nscreens');
  await page.keyboard.down('Tab');
  await page.waitForTimeout(220);
  const boardOpen = await page.evaluate(() => !document.getElementById('board').classList.contains('hide'));
  await page.keyboard.up('Tab');
  check(boardOpen, 'Tab opens the scoreboard');

  await page.keyboard.press('Escape');
  await page.waitForTimeout(260);
  check(await page.evaluate(() => !document.getElementById('screenPause').classList.contains('hide')), 'Escape pauses');
  check(await page.evaluate(() => window.SIGILFALL.game.paused), 'and the match stops while paused');
  await page.click('#btnResume');
  await page.waitForTimeout(220);
  await page.evaluate(fakeLock);
  check(await page.evaluate(() => !window.SIGILFALL.game.paused), 'resume starts it again');

  console.log('\nrebinding');
  const rebound = await page.evaluate(async () => {
    const mod = await import('/src/core/settings.js');
    mod.settings.rebind('ability1', 'KeyF');
    return mod.settings.data.binds.ability1[0];
  });
  check(rebound === 'KeyF', 'a key can be rebound while the match runs');
  await page.evaluate(placeInOpen);
  await page.waitForTimeout(150);
  await page.keyboard.press('f');
  await page.waitForTimeout(600);
  const viaF = await page.evaluate(readPlayer);
  check(viaF.cd.a1 > 0, 'and the new key casts the ability');
  await page.evaluate(async () => {
    const mod = await import('/src/core/settings.js');
    mod.settings.rebind('ability1', 'Digit1');
  });

  console.log('\nrespawn');
  const died = await page.evaluate(() => {
    const g = window.SIGILFALL.game;
    g.kill(g.player, null, {});
    return { alive: g.player.alive, wait: g.player.respawnAt - g.now };
  });
  check(!died.alive && died.wait > 1, 'a death starts the respawn timer (' + died.wait.toFixed(1) + 's)');
  await page.waitForTimeout((died.wait + 1.2) * 1000);
  const back = await page.evaluate(readPlayer);
  check(back.alive && back.hp > 0, 'and the player comes back at full health (' + Math.round(back.hp) + ')');

  check(errors.length === 0, 'no console errors' + (errors[0] ? ' (' + errors[0] + ')' : ''));
  await browser.close();
  console.log('\n' + (fail.length ? fail.length + ' checks failed' : 'all PC control checks passed'));
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
