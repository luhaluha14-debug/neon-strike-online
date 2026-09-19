/* =============================================================================
   tablets.  iPadOS Safari reports a Macintosh user agent, so a tablet has to be
   recognised by its touch points; this checks the detection, the layout in both
   orientations, and that a tablet is not treated like a desktop.
     npm i -D playwright && node sigilfall/test/browser-tablet.cjs
   ========================================================================== */
let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) { console.log('playwright is not installed - skipping the tablet test'); process.exit(0); }

const URL = process.env.SIGILFALL_URL || 'http://localhost:8080/';
const CHROME = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/* the exact user agent iPadOS 17 Safari sends: it says Macintosh */
const IPAD_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const ANDROID_TAB_UA = 'Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const PROFILES = [
  { name: 'iPad 11 landscape', w: 1194, h: 834, ua: IPAD_UA },
  { name: 'iPad 11 portrait', w: 834, h: 1194, ua: IPAD_UA },
  { name: 'iPad mini landscape', w: 1024, h: 768, ua: IPAD_UA },
  { name: 'iPad Pro 13 landscape', w: 1366, h: 1024, ua: IPAD_UA },
  { name: 'Android tablet landscape', w: 1280, h: 800, ua: ANDROID_TAB_UA }
];

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

  for (const prof of PROFILES) {
    console.log('\n' + prof.name + '  ' + prof.w + 'x' + prof.h);
    const ctx = await browser.newContext({
      viewport: { width: prof.w, height: prof.h },
      userAgent: prof.ua, hasTouch: true, isMobile: false, deviceScaleFactor: 2
    });
    const page = await ctx.newPage();
    const errors = [];
    const noise = (t) => /favicon/i.test(t);   // the host supplies the tab icon
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const t = m.text();
      if (!noise(t) && !(m.location() && noise(m.location().url || ''))) errors.push(t);
    });
    page.on('response', (r) => {
      if (r.status() >= 400 && !noise(r.url())) errors.push(r.status() + ' ' + r.url());
    });
    await page.goto(URL, { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.SIGILFALL, null, { timeout: 20000 });

    const det = await page.evaluate(async () => {
      const mod = await import('/src/core/settings.js');
      return {
        device: mod.settings.device,
        assist: mod.settings.get('aimAssist'),
        quality: mod.settings.get('quality')
      };
    });
    check(det.device.isTablet && det.device.isMobile, 'detected as a tablet, not a desktop');
    check(!det.device.isPhone, 'and not as a phone');
    check(det.assist === true, 'aim assist is on by default for a touch device');
    check(det.quality === 'medium', 'graphics default to medium (' + det.quality + ')');

    await page.evaluate(() => window.SIGILFALL.startMatch({
      mode: 'tdm', map: 'shrine', character: 'rift', botCount: 3, botLevel: 'easy'
    }));
    await page.waitForTimeout(900);

    const ui = await page.evaluate(() => {
      const t = window.SIGILFALL.touch;
      return {
        touchOn: t.enabled,
        touchui: document.body.classList.contains('touchui'),
        rotate: getComputedStyle(document.getElementById('rotate')).display,
        abilityBarHidden: document.getElementById('abilities').offsetParent === null,
        locked: !!document.pointerLockElement,
        buttons: t.buttons.map((b) => {
          const r = b.el.getBoundingClientRect();
          return { id: b.def.id, x: r.left + r.width / 2, y: r.top + r.height / 2, r: r.width / 2,
            label: b.el.querySelector('.sub') ? b.el.querySelector('.sub').textContent : '' };
        }),
        w: innerWidth, h: innerHeight
      };
    });
    check(ui.touchOn && ui.touchui, 'touch controls come up');
    check(ui.abilityBarHidden, 'the desktop ability bar stays out of the way');
    check(ui.rotate === 'none', 'no "turn your device" overlay on a tablet');
    check(!ui.locked, 'pointer lock is not forced on a tablet');

    const off = ui.buttons.filter((b) => b.x - b.r < -4 || b.x + b.r > ui.w + 4 || b.y - b.r < -4 || b.y + b.r > ui.h + 4);
    check(off.length === 0, 'every button is on screen' + (off.length ? ' (' + off.map((b) => b.id).join(',') + ')' : ''));
    let overlap = null;
    for (let i = 0; i < ui.buttons.length && !overlap; i++) {
      for (let j = i + 1; j < ui.buttons.length; j++) {
        const a = ui.buttons[i], b = ui.buttons[j];
        if (Math.hypot(a.x - b.x, a.y - b.y) < (a.r + b.r) * 0.82) { overlap = a.id + '/' + b.id; break; }
      }
    }
    check(!overlap, 'no two buttons overlap' + (overlap ? ' (' + overlap + ')' : ''));
    check(ui.buttons.every((b) => !b.label || b.label.length <= 8), 'ability labels fit their buttons');

    // a real tap has to fire, at tablet scale
    const fire = ui.buttons.find((b) => b.id === 'fire');
    const shots = await page.evaluate(async (btn) => {
      const g = window.SIGILFALL.game;
      const before = g.player.stats.shots;
      const el = document.getElementById('touch');
      const ev = (type) => el.dispatchEvent(new PointerEvent(type, {
        pointerId: 21, pointerType: 'touch', clientX: btn.x, clientY: btn.y, bubbles: true
      }));
      ev('pointerdown');
      await new Promise((r) => setTimeout(r, 500));
      ev('pointerup');
      await new Promise((r) => setTimeout(r, 200));
      return g.player.stats.shots - before;
    }, fire);
    check(shots > 0, 'the attack button fires (' + shots + ' shots)');

    check(errors.length === 0, 'no console errors' + (errors[0] ? ' (' + errors[0] + ')' : ''));
    await ctx.close();
  }

  await browser.close();
  console.log('\n' + (fail.length ? fail.length + ' checks failed' : 'all tablet checks passed'));
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
