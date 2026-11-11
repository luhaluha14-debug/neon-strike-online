// Phase 26-A weapon rebalance: the roles the numbers are meant to give, worked out with the game's own code
// (computeDamage, armorSplit, RecoilController, the player's hit capsule, the spread cone as WeaponSystem
// draws it). The exact numbers of every weapon are in the weapon-balance golden; this file is about how the
// weapons stand to each other: AR-01 the reference (and the bots' weapon) untouched, no cheaper weapon
// better than it at every range, each weapon with a range or a job of its own.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, openGame } from './harness.mjs';

let env;
let page;
let r;

before(async () => {
  env = await startEnv();
  page = await openGame(env, {});
  r = await page.evaluate(async () => {
    const { WEAPONS } = await import('/src/weapons/weapons.ts');
    const { CATALOG } = await import('/src/weapons/catalog.ts');
    const { computeDamage } = await import('/src/combat/HitscanSystem.ts');
    const { armorSplit, PlayerCombat } = await import('/src/player/PlayerCombat.ts');
    const { RecoilController } = await import('/src/weapons/RecoilController.ts');
    const V = window.game.camera.position.constructor;
    const ray = new (await import('/node_modules/.vite/deps/three.js')).Ray();
    const deg = Math.PI / 180;
    const price = Object.fromEntries(CATALOG.filter((c) => c.weapon).map((c) => [c.weapon.id, c.price]));

    // Hits on one zone to bring 100 health to 0 at `d` metres, with or without a full vest.
    const hits = (w, zone, d, armor0) => {
      let hp = 100;
      let armor = armor0;
      let n = 0;
      while (hp > 0 && n < 500) {
        n++;
        const s = armorSplit(computeDamage(w.damage, zone, d), zone, armor);
        armor = Math.max(0, armor - s.absorbed);
        hp -= s.health;
      }
      return n;
    };
    const ttk = (w, d, armor = 0) => +((hits(w, 'body', d, armor) - 1) * (60 / w.fireRate)).toFixed(3);

    // Seeded, so every run draws the same shots.
    let seed = 20261;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const t1 = new V();
    const t2 = new V();
    const cone = (dir, half) => {
      const rr = Math.sqrt(rnd()) * Math.tan(half);
      const a = rnd() * Math.PI * 2;
      t1.set(dir.z, 0, -dir.x);
      if (t1.lengthSq() < 1e-8) t1.set(1, 0, 0);
      t1.normalize();
      t2.crossVectors(dir, t1);
      dir.addScaledVector(t1, Math.cos(a) * rr).addScaledVector(t2, Math.sin(a) * rr).normalize();
    };
    const body = new PlayerCombat({ position: new V(0, 0, 0), height: 1.8, health: 100 }, 'dummy');

    // One engagement, standing still, the crosshair on the chest when the trigger goes down and held (a
    // semi-auto: clicked at its full rate). `comp` of the recoil is taken out by the player (0 none, 1 all).
    // Seconds to the kill, or null when the magazine runs out first.
    const engage = (w, d, armor0, comp) => {
      const rc = new RecoilController(w.recoil, rnd);
      const o = { pitch: 0, yaw: 0 };
      const iv = 60 / w.fireRate;
      const dt = 1 / 240;
      const base = Math.atan2(1.3 - 1.62, d);
      let hp = 100;
      let armor = armor0;
      let t = 0;
      let next = 0;
      let shots = 0;
      let vp = 0;
      let vy = 0;
      while (shots < w.magazineSize) {
        if (t >= next - 1e-9) {
          const pitch = base + vp * (1 - comp);
          const yaw = vy * (1 - comp);
          const aim = new V(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
          if (w.spread.standing > 0) cone(aim, w.spread.standing);
          for (let p = 0; p < (w.pellets?.count ?? 1); p++) {
            const dir = aim.clone();
            if (w.pellets) cone(dir, w.pellets.spread);
            ray.origin.set(0, 1.62, -d);
            ray.direction.copy(dir);
            const h = body.raycast(ray, w.damage.maxRange);
            if (!h) continue;
            const s = armorSplit(computeDamage(w.damage, h.zone, h.distance), h.zone, armor);
            armor = Math.max(0, armor - s.absorbed);
            hp -= s.health;
          }
          rc.onShot();
          shots++;
          next += iv;
          if (hp <= 0) return t;
        }
        rc.update(dt, o);
        vp += o.pitch;
        vy += o.yaw;
        t += dt;
      }
      return null;
    };
    const run = (w, d, armor, comp, n = 300) => {
      let kills = 0;
      let first = 0;
      let sum = 0;
      for (let k = 0; k < n; k++) {
        const t = engage(w, d, armor, comp);
        if (t === null) continue;
        kills++;
        sum += t;
        if (t === 0) first++;
      }
      return { killPct: (kills / n) * 100, firstShotPct: (first / n) * 100, mean: kills ? sum / kills : null };
    };

    // The view's climb (degrees) when the n-th round leaves, nothing held down; rounds `gap` seconds apart.
    const climbAt = (w, n, gap = 60 / w.fireRate) => {
      const rc = new RecoilController(w.recoil, () => 0.5);
      const o = { pitch: 0, yaw: 0 };
      let v = 0;
      let t = 0;
      let next = 0;
      let shots = 0;
      for (;;) {
        if (t >= next - 1e-9) {
          if (++shots === n) return v / deg;
          rc.onShot();
          next += gap;
        }
        rc.update(1 / 240, o);
        v += o.pitch;
        t += 1 / 240;
      }
    };

    const W = WEAPONS;
    const out = { price, def: {}, ttk: {}, armor: {}, climb10: {}, climbPerSec: {}, dps: {}, magDamage: {}, sustained: {} };
    for (const [id, w] of Object.entries(W)) {
      if (w.category === 'melee') continue;
      const per = w.damage.base * (w.pellets?.count ?? 1);
      out.def[id] = { rpm: w.fireRate, base: w.damage.base, mag: w.magazineSize, reserve: w.reserveAmmo, reload: w.reloadTime, damage: w.damage, spreadDeg: Object.fromEntries(Object.entries(w.spread).map(([k, v]) => [k, k === 'crouchMultiplier' ? v : +(v / deg).toFixed(3)])) };
      out.dps[id] = (per * w.fireRate) / 60;
      out.magDamage[id] = per * w.magazineSize;
      out.sustained[id] = (per * w.magazineSize) / ((w.magazineSize * 60) / w.fireRate + w.reloadTime);
      if (w.pellets) continue;
      out.ttk[id] = Object.fromEntries([3, 5, 8, 10, 12, 15, 18, 20, 22, 25, 30, 40, 60].map((d) => [d, ttk(w, d)]));
      out.armor[id] = Object.fromEntries([5, 10, 20, 30, 60].map((d) => [d, ttk(w, d, 100)]));
      if (w.fireMode === 'auto') {
        out.climb10[id] = climbAt(w, 10);
        out.climbPerSec[id] = climbAt(w, 10) / ((9 * 60) / w.fireRate);
      }
    }
    const rec = (w) => Object.fromEntries(Object.entries(w.recoil).map(([k, v]) => [k, typeof v === 'number' && ['pitchPerShot', 'pitchGrowthPerShot', 'maxPitch', 'yawJitter', 'yawDrift', 'recoverySpeed'].includes(k) ? +(v / deg).toFixed(3) : v]));
    out.recoil = { lmg02: rec(W.lmg02), ar01: rec(W.ar01) };
    out.head = {
      ar01: { 30: computeDamage(W.ar01.damage, 'head', 30), 45: computeDamage(W.ar01.damage, 'head', 45) },
      ar02: { 30: computeDamage(W.ar02.damage, 'head', 30), 45: computeDamage(W.ar02.damage, 'head', 45), 60: computeDamage(W.ar02.damage, 'head', 60) },
      lmg02: computeDamage(W.lmg02.damage, 'head', 10),
    };
    out.sr = {
      bodyVest: [10, 50, 100].map((d) => hits(W.sr01, 'body', d, 100)),
      body: hits(W.sr01, 'body', 100, 0),
      limb: hits(W.sr01, 'limb', 10, 0),
      limbDamage: computeDamage(W.sr01.damage, 'limb', 10),
    };
    out.dmr = { body: hits(W.dmr01, 'body', 50, 0), bodyVest: hits(W.dmr01, 'body', 50, 100), head: hits(W.dmr01, 'head', 100, 0), flatOut: climbAt(W.dmr01, 2), paced: climbAt(W.dmr01, 2, 0.5) };
    // Shotgun: one round at a standing target, the pattern as the game draws it.
    out.sg = {};
    for (const d of [3, 6, 8, 10, 15, 20]) out.sg[d] = { bare: run(W.sg01, d, 0, 1).firstShotPct, vest: run(W.sg01, d, 100, 1).firstShotPct };
    {
      // Every pellet on the body at point blank, through a full vest.
      let hp = 100;
      let armor = 100;
      for (let p = 0; p < W.sg01.pellets.count; p++) {
        const s = armorSplit(computeDamage(W.sg01.damage, 'body', 3), 'body', armor);
        armor -= s.absorbed;
        hp -= s.health;
      }
      out.sg.fullPatternVestLeft = hp;
    }
    // LMG-02: the burst left alone, and held down.
    out.lmg02 = {};
    for (const d of [10, 20, 30, 40]) out.lmg02[d] = { alone: run(W.lmg02, d, 100, 0), held: run(W.lmg02, d, 100, 1) };
    out.ar01At30 = { alone: run(W.ar01, 30, 100, 0), held: run(W.ar01, 30, 100, 1) };
    return out;
  });
});
after(async () => {
  await page?.context().close();
  await env?.close();
});

test('AR-01 (the reference, the bots’ weapon) and the pistols: not a number changed', () => {
  assert.deepEqual(
    { rpm: r.def.ar01.rpm, mag: r.def.ar01.mag, reserve: r.def.ar01.reserve, reload: r.def.ar01.reload, damage: r.def.ar01.damage, spread: r.def.ar01.spreadDeg, price: r.price.ar01 },
    { rpm: 600, mag: 30, reserve: 90, reload: 2.2, damage: { base: 24, headMultiplier: 4.25, limbMultiplier: 0.8, falloffStart: 30, falloffEnd: 80, falloffMinMultiplier: 0.8, maxRange: 250 }, spread: { standing: 0, moving: 1.6, airborne: 6, crouchMultiplier: 0.7 }, price: 2700 },
  );
  assert.deepEqual(r.recoil.ar01, { pitchPerShot: 0.45, pitchGrowthPerShot: 0.04, growthShots: 8, maxPitch: 6, yawJitter: 0.09, yawDrift: 0.3, yawDriftAfterShots: 9, yawDriftSign: -1, yawSwayShots: 9, kickResponse: 28, recoveryDelay: 0.14, recoverySpeed: 22, yawRecovery: true, sprayResetTime: 0.35 });
  assert.equal(r.ttk.ar01[10], 0.4);
  assert.equal(r.armor.ar01[10], 0.5);
  assert.deepEqual([r.def.pis01.rpm, r.def.pis01.base, r.def.pis01.mag, r.price.pis01], [360, 26, 12, 500]);
  assert.deepEqual([r.def.pis02.rpm, r.def.pis02.base, r.def.pis02.mag, r.price.pis02], [340, 25, 15, 600]);
});

test('SMG-02: the strongest gun up close for its price, behind AR-01 from 20 m (it was ahead to 27 m)', () => {
  for (const d of [3, 5, 8, 10]) assert.equal(r.ttk.smg02[d], 0.277, `4 body hits at ${d} m`);
  for (const d of [12, 15, 18]) assert.ok(r.ttk.smg02[d] < r.ttk.ar01[d], `still ahead of AR-01 at ${d} m (${r.ttk.smg02[d]})`);
  for (const d of [20, 22, 25, 30, 40, 60]) assert.ok(r.ttk.smg02[d] > r.ttk.ar01[d], `behind AR-01 at ${d} m (${r.ttk.smg02[d]} vs ${r.ttk.ar01[d]})`);
  // Against a vest: ahead only close in.
  assert.ok(r.armor.smg02[5] < r.armor.ar01[5] && r.armor.smg02[20] > r.armor.ar01[20]);
  assert.equal(r.price.smg02, 1800);
});

test('SMG-01: cheap and easy; ahead of AR-01 only inside 15 m, the gentlest spray of the automatics, never ahead of SMG-02 up close', () => {
  for (const d of [3, 5, 10, 15]) assert.ok(r.ttk.smg01[d] < r.ttk.ar01[d], `ahead of AR-01 at ${d} m`);
  for (const d of [18, 20, 25, 30, 40]) assert.ok(r.ttk.smg01[d] > r.ttk.ar01[d], `behind AR-01 at ${d} m`);
  for (const d of [3, 5, 10]) assert.ok(r.ttk.smg02[d] < r.ttk.smg01[d], `SMG-02 hits harder at ${d} m`);
  assert.ok(r.price.smg01 < r.price.smg02 && r.def.smg01.mag > r.def.smg02.mag);
  const least = Math.min(...Object.values(r.climb10));
  assert.equal(r.climb10.smg01, least, 'the least climb over 10 rounds');
  assert.ok(r.def.smg01.spreadDeg.moving < r.def.smg02.spreadDeg.moving, 'steadier on the move');
});

test('AR-02: a precision rifle, not a better AR-01: slower on the body at every range, a head kill further out, less climb', () => {
  for (const d of Object.keys(r.ttk.ar01)) assert.ok(r.ttk.ar02[d] > r.ttk.ar01[d], `slower than AR-01 at ${d} m`);
  for (const d of Object.keys(r.armor.ar01)) if (+d <= 30) assert.ok(r.armor.ar02[d] > r.armor.ar01[d], `and through a vest at ${d} m`);
  assert.ok(r.head.ar01[30] >= 100 && r.head.ar01[45] < 100, 'AR-01: a head kill at 30 m, not at 45 m');
  assert.ok(r.head.ar02[45] >= 100 && r.head.ar02[60] < 100, 'AR-02: a head kill at 45 m too');
  assert.ok(r.climb10.ar02 < r.climb10.ar01 && r.climbPerSec.ar02 < r.climbPerSec.ar01, 'less climb, per round and per second');
  assert.ok(r.def.ar02.damage.falloffStart > r.def.ar01.damage.falloffStart && r.def.ar02.spreadDeg.moving < r.def.ar01.spreadDeg.moving);
  assert.ok(r.dps.ar02 < r.dps.ar01);
});

test('SG-01: one round kills up close, a vest or not; no use past 15 m', () => {
  assert.ok(r.sg.fullPatternVestLeft <= 0, `a full pattern through a full vest kills (health left ${r.sg.fullPatternVestLeft})`);
  assert.ok(r.sg[3].bare === 100 && r.sg[6].bare === 100 && r.sg[8].bare >= 90, `bare: ${JSON.stringify([r.sg[3].bare, r.sg[6].bare, r.sg[8].bare])}`);
  assert.ok(r.sg[3].vest === 100 && r.sg[6].vest >= 95, `vest: ${JSON.stringify([r.sg[3].vest, r.sg[6].vest])}`);
  assert.ok(r.sg[10].bare > 50 && r.sg[10].bare < 95, `10 m: sometimes (${r.sg[10].bare} %)`);
  assert.ok(r.sg[15].bare < 10 && r.sg[20].bare === 0, 'beyond: not in one round');
});

test('SR-01: a body hit kills through a vest (it took two before); a leg hit still does not', () => {
  assert.deepEqual(r.sr.bodyVest, [1, 1, 1], 'one round at 10 / 50 / 100 m, full vest');
  assert.equal(r.sr.body, 1);
  assert.equal(r.sr.limb, 2);
  assert.ok(r.sr.limbDamage < 100 && r.sr.limbDamage >= 90, `leg ${r.sr.limbDamage}`);
});

test('DMR-01: two body hits, a head hit anywhere; fired flat out the next round leaves high, paced it does not', () => {
  assert.deepEqual([r.dmr.body, r.dmr.bodyVest, r.dmr.head], [2, 3, 1]);
  assert.ok(r.dmr.flatOut > 0.3 && r.dmr.flatOut < 0.7, `flat out: the second round ${r.dmr.flatOut.toFixed(2)}° high`);
  assert.ok(Math.abs(r.dmr.paced) < 0.01, 'half a second apart: back on aim');
  // No longer faster than AR-01 through a vest, still faster bare for two clean hits.
  assert.ok(r.ttk.dmr01[30] < r.ttk.ar01[30] && r.armor.dmr01[30] > r.armor.ar01[30]);
});

test('LMG-01: the belt and the sustained fire; LMG-02: more of both for more money', () => {
  for (const id of ['ar01', 'ar02', 'smg01', 'smg02', 'dmr01', 'sr01', 'sg01']) {
    assert.ok(r.magDamage.lmg01 > r.magDamage[id] * 1.8, `LMG-01's belt against ${id}'s magazine`);
    assert.ok(r.sustained.lmg01 > r.sustained[id], `LMG-01 sustained fire against ${id}`);
  }
  assert.ok(r.ttk.lmg01[20] < r.ttk.ar01[20] && r.ttk.lmg01[20] > r.ttk.lmg02[20]);
  assert.ok(r.magDamage.lmg02 > r.magDamage.lmg01 && r.sustained.lmg02 > r.sustained.lmg01 && r.price.lmg02 > r.price.lmg01);
});

test('LMG-02: the recoil left exactly as it was; the damage a round down, so the recoil decides', () => {
  // Its recoil and spread: the same numbers as before the rebalance.
  assert.deepEqual(r.recoil.lmg02, { pitchPerShot: 0.42, pitchGrowthPerShot: 0.035, growthShots: 12, maxPitch: 5, yawJitter: 0.2, yawDrift: 0.38, yawDriftAfterShots: 8, yawDriftSign: -1, yawSwayShots: 10, kickResponse: 26, recoveryDelay: 0.16, recoverySpeed: 18, yawRecovery: true, sprayResetTime: 0.4 });
  assert.deepEqual(r.def.lmg02.spreadDeg, { standing: 0.45, moving: 3.8, airborne: 10, crouchMultiplier: 0.5 });
  assert.deepEqual([r.def.lmg02.rpm, r.def.lmg02.mag, r.def.lmg02.reserve, r.def.lmg02.reload], [1000, 120, 240, 6], 'the rate of fire and the belt kept');
  // The steepest climb per second of every automatic.
  for (const [id, v] of Object.entries(r.climbPerSec)) if (id !== 'lmg02') assert.ok(r.climbPerSec.lmg02 > v * 1.3, `climbs faster than ${id} (${r.climbPerSec.lmg02.toFixed(1)} vs ${v.toFixed(1)} °/s)`);
  // Firepower: still the most, no longer out of reach (it was 467 against 293 for the next).
  const next = Math.max(...Object.entries(r.dps).filter(([id]) => id !== 'lmg02').map(([, v]) => v));
  assert.equal(r.dps.lmg02, 350);
  assert.ok(r.dps.lmg02 > next && r.dps.lmg02 < next * 1.35, `DPS ${r.dps.lmg02} against ${next}`);
  assert.equal(r.ttk.lmg02[20], 0.24, '5 body hits');
  assert.equal(r.armor.lmg02[20], 0.36);
  assert.ok(r.head.lmg02 < 100, 'no one-shot head kill');
  // Held down: it kills every time, faster than AR-01. Left alone: at range the burst walks off the target.
  for (const d of [10, 20, 30]) assert.ok(r.lmg02[d].held.killPct === 100 && r.lmg02[d].held.mean < r.armor.ar01[d] - 0.05, `held down at ${d} m: ${JSON.stringify(r.lmg02[d].held)}`);
  assert.equal(r.lmg02[10].alone.killPct, 100, 'left alone at 10 m: still a kill');
  assert.ok(r.lmg02[20].alone.killPct < 85, `left alone at 20 m: ${r.lmg02[20].alone.killPct.toFixed(0)} % of belts kill`);
  assert.ok(r.lmg02[30].alone.killPct < 40 && r.lmg02[40].alone.killPct < 25, `left alone at 30 / 40 m: ${r.lmg02[30].alone.killPct.toFixed(0)} % / ${r.lmg02[40].alone.killPct.toFixed(0)} %`);
  // AR-01 left alone at 30 m kills every time (its first rounds are enough): the LMG-02's recoil costs more.
  assert.equal(r.ar01At30.alone.killPct, 100);
});

test('prices: nothing cheaper than AR-01 beats it at every range; price order within each kind', () => {
  for (const id of ['smg01', 'smg02']) {
    assert.ok(r.price[id] < r.price.ar01);
    assert.ok(Object.keys(r.ttk.ar01).some((d) => r.ttk[id][d] > r.ttk.ar01[d]), `${id} loses to AR-01 somewhere`);
  }
  assert.deepEqual([r.price.ar02, r.price.smg01, r.price.sg01, r.price.dmr01, r.price.sr01, r.price.lmg01, r.price.lmg02], [2900, 1500, 2000, 4000, 4750, 5200, 5700]);
});
