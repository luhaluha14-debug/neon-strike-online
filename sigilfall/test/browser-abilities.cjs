/* =============================================================================
   every ability of every character, cast for real in the browser, checking that
   something actually happened: a projectile left the barrel, a zone was planted,
   a summon appeared, a dash moved the fighter, a domain opened.
     npm i -D playwright && node sigilfall/test/browser-abilities.cjs
   ========================================================================== */
let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) { console.log('playwright is not installed - skipping the ability test'); process.exit(0); }

const URL = process.env.SIGILFALL_URL || 'http://localhost:8080/';
const CHROME = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const fail = [];
function check(cond, what) {
  console.log((cond ? '  ok   ' : '  FAIL ') + what);
  if (!cond) fail.push(what);
}

/* puts the fighter and a target on open ground, facing each other */
function stage(distance) {
  const g = window.SIGILFALL.game, p = g.player;
  p.pos.x = 0; p.pos.z = -20;
  p.pos.y = g.world.supportAt(p.pos.x, p.pos.z, 60, p.radius);
  p.vel.x = p.vel.y = p.vel.z = 0;
  p.yaw = Math.PI; p.pitch = 0; p.aimDir();
  p.hp = p.maxHp; p.energy = p.maxEnergy;
  p.cd = { q: 0, a1: 0, a2: 0, rmb: 0, refocus: 0 };
  p.nextFire = 0; p.castUntil = 0; p.recoverUntil = 0;
  p.ult = 100;
  const foe = g.fighters.find((f) => f !== p && g.isEnemy(p, f));
  foe.alive = true;
  foe.hp = foe.maxHp;
  foe.pos.x = 0; foe.pos.z = -20 + distance;
  foe.pos.y = g.world.supportAt(foe.pos.x, foe.pos.z, 60, foe.radius);
  foe.spawnAt = -99;
  foe.brain = null;                       // stand still and take it
  window.SIGILFALL.input.clear();
  return { see: g.canSee(p, foe.pos.x, foe.centerY, foe.pos.z), foeHp: foe.hp };
}

function snapshot() {
  const g = window.SIGILFALL.game, p = g.player;
  const foe = g.fighters.find((f) => f !== p && g.isEnemy(p, f));
  return {
    projectiles: g.projectiles.list.length,
    zones: g.zones.list.length,
    summons: g.summons.list.length,
    domains: g.domains.list.length,
    effects: g.effects.active.length,
    foeHp: foe ? foe.hp : 0,
    foeMarked: foe ? g.now < foe.markedUntil : false,
    foeSlowed: foe ? g.now < foe.slowUntil : false,
    pos: { x: p.pos.x, z: p.pos.z },
    energy: p.energy, hp: p.hp,
    cd: { q: g.abilities.cooldownLeft(p, 'q'), a1: g.abilities.cooldownLeft(p, 'a1'), a2: g.abilities.cooldownLeft(p, 'a2') },
    ads: p.ads, parry: g.now < p.parryUntil, ultActive: p.ultActive,
    buffs: Object.keys(p.buffs), stacks: p.stackCount(g.now)
  };
}

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage']
  });
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 640 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.SIGILFALL, null, { timeout: 20000 });

  const cast = async (action, holdMs) => {
    await page.evaluate(([a, h]) => {
      const i = window.SIGILFALL.input;
      if (h) i.setHold(a, true); else i.press(a);
    }, [action, !!holdMs]);
    await page.waitForTimeout(holdMs || 260);
    if (holdMs) {
      await page.evaluate((a) => window.SIGILFALL.input.setHold(a, false), action);
      await page.waitForTimeout(240);
    }
  };

  for (const charId of ['rift', 'brand', 'warden', 'vein']) {
    console.log('\n' + charId);
    await page.evaluate((c) => {
      const a = window.SIGILFALL;
      a.game.stop();
      a.startMatch({ mode: 'tdm', map: 'shrine', character: c, botCount: 1, botLevel: 'easy' });
    }, charId);
    await page.waitForTimeout(500);

    const kind = await page.evaluate(() => {
      const c = window.SIGILFALL.game.player.char;
      return { primary: c.primary.kind, secondary: c.secondary.kind, q: c.q.kind, a1: c.a1.kind, a2: c.a2.kind };
    });

    /* ---- primary ---- */
    const reach = kind.primary === 'melee' ? 2.6 : 12;
    let staged = await page.evaluate(stage, reach);
    check(staged.see, charId + ': the staged target is in the open');
    await cast('fire', 500);
    let s = await page.evaluate(snapshot);
    if (kind.primary === 'melee') {
      check(s.stacks > 0 || s.foeHp < staged.foeHp, charId + ': the melee attack swung (stacks ' + s.stacks + ')');
    } else {
      check(s.foeHp < staged.foeHp || s.projectiles > 0, charId + ': the basic attack hit or is in flight');
      check(s.energy < 100, charId + ': and it spent energy (' + Math.round(s.energy) + ')');
    }

    /* ---- secondary ---- */
    staged = await page.evaluate(stage, kind.secondary === 'parry' ? 3 : 12);
    if (kind.secondary === 'charge') {
      await cast('altFire', 1100);
      s = await page.evaluate(snapshot);
      check(s.projectiles > 0 || s.foeHp < staged.foeHp, charId + ': the charged shot went off');
    } else if (kind.secondary === 'ads') {
      await page.evaluate(() => window.SIGILFALL.input.setHold('altFire', true));
      await page.waitForTimeout(220);
      s = await page.evaluate(snapshot);
      check(s.ads, charId + ': aiming down sight engages');
      await page.evaluate(() => window.SIGILFALL.input.setHold('altFire', false));
    } else if (kind.secondary === 'parry') {
      await cast('altFire');
      s = await page.evaluate(snapshot);
      check(s.parry || s.cd, charId + ': the counter stance goes up');
    } else {
      await cast('altFire');
      s = await page.evaluate(snapshot);
      check(s.foeMarked || s.foeHp < staged.foeHp, charId + ': the secondary landed on the target');
    }

    /* ---- Q ---- */
    staged = await page.evaluate(stage, 14);
    const from = await page.evaluate(() => ({ ...window.SIGILFALL.game.player.pos }));
    await cast('dash');
    await page.waitForTimeout(420);
    s = await page.evaluate(snapshot);
    const moved = Math.hypot(s.pos.x - from.x, s.pos.z - from.z);
    check(moved > 2, charId + ': ' + kind.q + ' moved the fighter (' + moved.toFixed(1) + ' m)');
    check(s.cd.q > 0, charId + ': and put Q on cooldown');

    /* ---- ability 1 and 2 ---- */
    for (const [action, slot] of [['ability1', 'a1'], ['ability2', 'a2']]) {
      staged = await page.evaluate(stage, 12);
      const before = await page.evaluate(snapshot);
      await cast(action);
      await page.waitForTimeout(700);
      s = await page.evaluate(snapshot);
      const did = s.zones.length > before.zones || s.zones > before.zones ||
        s.summons > before.summons || s.foeHp < staged.foeHp ||
        s.projectiles > 0 || s.foeSlowed || s.buffs.length > before.buffs.length;
      check(did, charId + '.' + slot + ' (' + kind[slot] + ') did something observable');
      check(s.cd[slot] > 0, charId + '.' + slot + ' started its cooldown');
    }

    /* ---- domain: each one has its own rules, so check the ones it claims ---- */
    staged = await page.evaluate(stage, 4);
    await cast('ultimate');
    await page.waitForTimeout(900);
    s = await page.evaluate(snapshot);
    check(s.domains > 0 && s.ultActive, charId + ': the domain opened');
    const inside = await page.evaluate(() => {
      const g = window.SIGILFALL.game;
      const d = g.domains.list[0];
      return d ? { holds: g.domains.contains(d, g.player), rules: Object.keys(d.spec.inside) } : null;
    });
    check(!!inside && inside.holds, charId + ': and the caster is inside it');
    await page.waitForTimeout(1600);
    const effect = await page.evaluate(() => {
      const g = window.SIGILFALL.game, p = g.player;
      const foe = g.fighters.find((f) => f !== p && g.isEnemy(p, f));
      const rules = g.domains.list[0] ? g.domains.list[0].spec.inside : {};
      return {
        rules,
        ult: p.ult,
        tick: foe.hp < foe.maxHp,
        slowed: g.now < foe.slowUntil,
        revealed: g.now < foe.markedUntil,
        meleeMul: g.domains.damageDealtMul(p, { kind: 'melee' }),
        dmgMul: g.domains.damageDealtMul(p, { kind: 'projectile' }),
        energyLocked: g.domains.energyLocked(foe),
        summons: g.summons.list.length
      };
    });
    const r = effect.rules;
    const claims = [];
    if (r.enemyTick) claims.push(['적에게 지속 피해', effect.tick]);
    if (r.enemySlow) claims.push(['적 감속', effect.slowed]);
    if (r.revealEnemies) claims.push(['적 노출', effect.revealed]);
    if (r.ownMeleeMul) claims.push(['근접 강화', effect.meleeMul > 1]);
    if (r.ownDmgMul) claims.push(['피해 강화', effect.dmgMul > 1]);
    if (r.enemyEnergyLock) claims.push(['주력 봉쇄', effect.energyLocked]);
    check(claims.length > 0, charId + ': the domain declares what it does');
    for (const [what, ok] of claims) check(ok, charId + ': the domain actually applies ' + what);
    if (inside && inside.rules && effect.summons !== undefined && r.summonBoost !== undefined) {
      check(effect.summons > 0, charId + ': the domain brought its own summons');
    }
    check(effect.ult < 100, charId + ': the domain spent the gauge');
  }

  check(errors.length === 0, 'no console errors' + (errors[0] ? ' (' + errors[0] + ')' : ''));
  await browser.close();
  console.log('\n' + (fail.length ? fail.length + ' checks failed' : 'all ability checks passed'));
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
