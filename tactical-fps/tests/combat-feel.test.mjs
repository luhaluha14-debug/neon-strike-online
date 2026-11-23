// Phase 32 — combat feel and immersion. Presentation only (damage, rates and the judgement of hits are covered by
// their own suites and unchanged):
//   1. the eye takes each shot (roll and a small push), harder for heavy weapons, settling at once; the aim is
//      untouched; a hit flinches the eye away from its side
//   2. bullet impacts by material: holes in stone, dents in metal, cracks in glass (bounded pools); the impact
//      sound of what was struck; dust right in front of the eye kept small
//   3. footsteps by the ground under the feet
//   4. hit reactions: the body is pushed the way the round travelled, harder for more damage; the death fall
//      goes the same way, the knees giving first; remote players flinch from the snapshots alone
//   5. damage direction: up to three markers at once, a repeat from the same side renews its marker

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, openGame, installFrameDriver } from './harness.mjs';

let env;
let page;
before(async () => {
  env = await startEnv();
  page = await openGame(env, { width: 640, height: 360, quality: 'high', mode: 'deathmatch', seed: 9 });
  await page.click('.play-button');
  await page.waitForFunction(() => window.game.input.active && window.game.squad?.bots.length > 0);
  await installFrameDriver(page);
  await page.evaluate(() => {
    window.T.stopLoop();
    window.T.run(10);
    window.game.combat.protection = 1e9;
  });
});
after(async () => {
  await page?.context().close();
  await env?.close();
});

test('1. shot shake: each round rolls and pushes the eye, heavy weapons more, settled within 0.3 s; the aim is not moved; a hit flinches the eye away from it', async () => {
  const r = await page.evaluate(async () => {
    const { CameraMotion, SHOT_SHAKE } = await import('/src/player/CameraMotion.ts');
    const input = { speed: 0, runSpeed: 5, vy: 0, grounded: true, crouching: false, aim: 0 };
    // Against the same camera without the shot (standing still it breathes: that is not the shake).
    const peak = (k) => {
      const m = new CameraMotion();
      const still = new CameraMotion();
      m.update(1 / 60, input);
      still.update(1 / 60, input);
      m.shot(k, 1);
      let roll = 0;
      let lift = 0;
      for (let i = 0; i < 6; i++) {
        m.update(1 / 60, input);
        still.update(1 / 60, input);
        roll = Math.max(roll, Math.abs(m.roll - still.roll));
        lift = Math.max(lift, m.y - still.y);
      }
      for (let i = 0; i < 12; i++) {
        m.update(1 / 60, input);
        still.update(1 / 60, input);
      }
      return { roll, lift, after: [m.roll - still.roll, m.y - still.y] };
    };
    const kinds = {};
    for (const c of ['smg', 'rifle', 'dmr', 'sniper', 'shotgun']) kinds[c] = peak(SHOT_SHAKE[c]);
    // Hurt from the right (+π/2): the eye rolls away from that side.
    const m = new CameraMotion();
    m.update(1 / 60, input);
    m.hurt(Math.PI / 2, 40);
    for (let i = 0; i < 3; i++) m.update(1 / 60, input);
    const hurtRoll = m.roll;
    // In the game: a real AR-01 round moves the camera's roll, the aim only by the weapon's recoil.
    const g = window.game;
    const before = { pitch: g.player.pitch, yaw: g.player.yaw, shots: g.weapons.shotsFired };
    const kick = [];
    const add = g.player.addViewKick.bind(g.player);
    g.player.addViewKick = (p, y) => {
      kick.push([p, y]);
      add(p, y);
    };
    const poll = g.input.poll.bind(g.input);
    let f = 0;
    g.input.poll = (out) => {
      poll(out);
      out.fire = f++ === 0;
    };
    window.T.run(1);
    const rollShot = g.camera.rotation.z;
    window.T.run(30);
    g.input.poll = poll;
    g.player.addViewKick = add;
    const kickPitch = kick.reduce((a, k) => a + k[0], 0);
    return { kinds, hurtRoll, rollShot, pitchMoved: g.player.pitch - before.pitch, kickPitch, rounds: g.weapons.shotsFired - before.shots };
  });
  const { smg, rifle, dmr, sniper, shotgun } = r.kinds;
  assert.ok(smg.roll < rifle.roll && rifle.roll < dmr.roll && dmr.roll < sniper.roll, `heavier weapons shake more: ${JSON.stringify(r.kinds)}`);
  assert.ok(shotgun.roll > rifle.roll);
  assert.ok(sniper.roll < 0.02, `still small (${sniper.roll.toFixed(4)} rad)`);
  for (const k of Object.values(r.kinds)) assert.ok(Math.abs(k.after[0]) < 1e-6 && Math.abs(k.after[1]) < 1e-6, `settled within 0.3 s (${k.after})`);
  // (A lean right rolls the camera negative: a hit from the right tilts it the other way, positive.)
  assert.ok(r.hurtRoll > 0.001, `a hit from the right tilts the eye away from it, to the left (${r.hurtRoll.toFixed(4)})`);
  assert.equal(r.rounds, 1);
  // The aim's pitch moved only through the weapon's own recoil (its kick and recovery, addViewKick): the shake
  // never touches it.
  assert.ok(Math.abs(r.pitchMoved - r.kickPitch) < 1e-9, 'the aim moved by the recoil only');
});

test('2. impacts by material: hole / dent / crack in their own pools (bounded); the struck material’s sound; dust at the eye kept small', async () => {
  const r = await page.evaluate(async () => {
    const g = window.game;
    const V = g.player.position.constructor;
    const fx = g.impacts;
    fx.clear();
    const at = new V(0, 1, 0);
    const n = new V(0, 0, 1);
    for (let i = 0; i < 3; i++) fx.spawn(at, n, 'concrete');
    for (let i = 0; i < 2; i++) fx.spawn(at, n, 'metal');
    fx.spawn(at, n, 'glass');
    const counts = { ...fx.decalCounts };
    for (let i = 0; i < 300; i++) fx.spawn(at, n, i % 3 === 0 ? 'metal' : i % 3 === 1 ? 'glass' : 'concrete');
    const capped = { ...fx.decalCounts };
    // Dust right in front of the eye: drawn far smaller than the same puff 5 m away.
    fx.clear();
    const cam = g.camera;
    const fwd = new V(0, 0, -1).applyQuaternion(cam.quaternion);
    const size = (d) => {
      fx.clear();
      const p = cam.position.clone().addScaledVector(fwd, d);
      const slot = fx['puffCursor'];
      fx.spawn(p, fwd.clone().negate(), 'concrete', () => 0.5);
      fx.update(0.08, cam);
      const m = new (cam.matrix.constructor)();
      fx['puffs'].getMatrixAt(slot, m);
      return new V().setFromMatrixScale(m).x;
    };
    const near = size(0.3);
    const far = size(5);
    fx.clear();
    // Sounds: what each struck material plays.
    const wa = g.weaponAudio;
    const res = (kind) => ({ kind: 'world', point: new V(), normal: new V(0, 1, 0), distance: 5, _k: kind });
    const saved = wa.surfaceOf;
    const sounds = {};
    for (const k of ['concrete', 'brick', 'asphalt', 'metal', 'paintedMetal', 'glass', 'wood', 'dirt', 'grass', 'water']) {
      wa.surfaceOf = () => k;
      sounds[k] = wa.impactSound(res(k));
    }
    wa.surfaceOf = saved;
    const flesh = wa.impactSound({ kind: 'target', point: new V(), normal: new V(), distance: 1, zone: 'body', damage: 10, target: null });
    // The real map: a round into the floor where the player stands asks the map what it is made of.
    const floor = wa.surfaceOf(g.player.position, new V(0, 1, 0));
    return { counts, capped, near, far, sounds, flesh, floor, hasSurfaceOf: typeof saved === 'function' };
  });
  assert.deepEqual(r.counts, { hole: 3, metal: 2, glass: 1 });
  assert.ok(r.capped.hole <= 128 && r.capped.metal <= 40 && r.capped.glass <= 24, `bounded pools ${JSON.stringify(r.capped)}`);
  assert.ok(r.near < r.far * 0.4, `dust at the eye kept small (${r.near.toFixed(3)} vs ${r.far.toFixed(3)} at 5 m)`);
  assert.deepEqual(r.sounds, {
    concrete: 'impact', brick: 'impact', asphalt: 'impact', metal: 'impact.metal', paintedMetal: 'impact.metal',
    glass: 'impact.glass', wood: 'impact.wood', dirt: 'impact.soft', grass: 'impact.soft', water: 'impact.soft',
  });
  assert.equal(r.flesh, 'impact.flesh');
  assert.equal(r.hasSurfaceOf, true);
  assert.ok(typeof r.floor === 'string', `the map tells what the floor is (${r.floor})`);
});

test('3. footsteps by the ground: walking plays the step of the surface under the feet (concrete here), metal / boards / earth their own', async () => {
  const r = await page.evaluate(async () => {
    const { stepSound } = await import('/src/audio/WeaponAudio.ts');
    const g = window.game;
    const map = { concrete: stepSound('concrete'), metal: stepSound('metal'), grating: stepSound('paintedMetal'), wood: stepSound('wood'), dirt: stepSound('dirt'), grass: stepSound('grass'), none: stepSound(null) };
    // Real walking: what the game asks for.
    const heard = [];
    const play = g.audio.play.bind(g.audio);
    g.audio.play = (id, o) => {
      if (String(id).startsWith('step')) heard.push(id);
      return play(id, o);
    };
    const poll = g.input.poll.bind(g.input);
    g.input.poll = (out) => {
      poll(out);
      out.moveY = 1;
    };
    window.T.run(120);
    g.input.poll = poll;
    g.audio.play = play;
    const ground = g.map.collision.surfaceAt(g.player.position, new g.player.position.constructor(0, 1, 0));
    return { map, heard: [...new Set(heard)], steps: heard.length, ground, expect: stepSound(ground) };
  });
  assert.deepEqual(r.map, { concrete: 'step', metal: 'step.metal', grating: 'step.metal', wood: 'step.wood', dirt: 'step.soft', grass: 'step.soft', none: 'step' });
  assert.ok(r.steps > 0, 'steps were heard while walking');
  assert.ok(r.heard.includes(r.expect), `walking on ${r.ground} plays ${r.expect} (${r.heard})`);
});

test('4. hit reactions: pushed the way the round travelled, harder for more damage; the death fall goes that way, the knees giving first; remote players flinch from snapshots', async () => {
  const r = await page.evaluate(async () => {
    const { BotModel, BotKit } = await import('/src/ai/BotModel.ts');
    const { hitStrength } = await import('/src/ai/CharacterMotion.ts');
    const V = window.game.player.position.constructor;
    const kit = new BotKit('red');
    const pose = () => ({ feet: new V(0, 0, 0), yaw: 0, pitch: 0, velocity: new V(), grounded: true, aiming: true, alive: true, deadTime: 0 });
    const chest = (dir, strength) => {
      const m = new BotModel(kit);
      const p = pose();
      for (let i = 0; i < 10; i++) m.update(1 / 60, p);
      const rest = m['spine'].rotation.x;
      m.onHit(dir, strength);
      m.update(1 / 60, p);
      const out = { pitch: m['spine'].rotation.x - rest, roll: m['spine'].rotation.z };
      m.dispose();
      return out;
    };
    // The body faces -Z: a round travelling +Z came from the front; -Z from behind; +X from its left side.
    const front = chest(new V(0, 0, 1), 1);
    const back = chest(new V(0, 0, -1), 1);
    const strong = chest(new V(0, 0, 1), 1.6);
    const fromLeft = chest(new V(1, 0, 0), 1);
    const fall = (dir) => {
      const m = new BotModel(kit);
      const p = pose();
      for (let i = 0; i < 10; i++) m.update(1 / 60, p);
      m.onHit(dir, 1);
      p.alive = false;
      m.update(1 / 60, { ...p, deadTime: 0.12 });
      const early = m.object.position.y;
      m.update(1 / 60, { ...p, deadTime: 1 });
      m.object.updateMatrixWorld(true);
      // Where the head went: the object's up axis.
      const up = new V(0, 1, 0).applyQuaternion(m.object.quaternion);
      m.dispose();
      return { early: +early.toFixed(3), up: [+up.x.toFixed(2), +up.y.toFixed(2), +up.z.toFixed(2)] };
    };
    const falls = { front: fall(new V(0, 0, 1)), back: fall(new V(0, 0, -1)), left: fall(new V(1, 0, 0)) };
    // A remote player: two snapshots, health 100 → 76: its body flinches.
    const { Puppets } = await import('/src/net/Puppets.ts');
    const pup = new Puppets('procedural');
    const e = (hp) => ['p1', 0, 0, 0, 0, 0, 1.8, 0, 0, 1 | 2, hp, 0, 0, '', '', 'ar01'];
    pup.push(1, [e(100)], null);
    pup.push(1.05, [e(76)], null);
    pup.update(1 / 60, 1.0);
    const model = pup.all.get('p1').model;
    const beforeHit = model.motion.flinch;
    pup.update(1 / 60, 1.06);
    const afterHit = model.motion.flinch;
    pup.clear?.();
    kit.dispose();
    return { front, back, strong, fromLeft, falls, beforeHit, afterHit, strength: [hitStrength(10, false), hitStrength(40, false), hitStrength(40, true), hitStrength(200, false)] };
  });
  assert.ok(r.front.pitch < -0.1, `a round from the front throws the chest back (${r.front.pitch.toFixed(3)})`);
  assert.ok(r.back.pitch > 0.1, `from behind pitches it forward (${r.back.pitch.toFixed(3)})`);
  assert.ok(Math.abs(r.strong.pitch) > Math.abs(r.front.pitch) * 1.3, 'a heavier hit shows more');
  assert.ok(r.fromLeft.roll < -0.05, `a round from its left pushes it to its right (${r.fromLeft.roll.toFixed(3)})`);
  assert.deepEqual(r.strength, [0.5, 1, 1.2, 1.6]);
  assert.ok(r.falls.front.early < -0.03, `the knees give first (${r.falls.front.early} m)`);
  // Facing -Z: falls back → head toward +Z; forward → -Z; pushed to its right (+X) → head toward +X.
  assert.ok(r.falls.front.up[2] > 0.9, `shot from the front: onto its back ${r.falls.front.up}`);
  assert.ok(r.falls.back.up[2] < -0.9, `shot from behind: onto its face ${r.falls.back.up}`);
  assert.ok(r.falls.left.up[0] > 0.9, `shot from its left: over to its right ${r.falls.left.up}`);
  assert.equal(r.beforeHit, 0, 'no reaction before the snapshot with the hit is shown');
  assert.ok(r.afterHit > 0.4, `a remote player flinches from the snapshots alone (${r.afterHit})`);
});

test('5. damage direction: hits from three sides show three markers at once; a repeat from the same side renews its marker', async () => {
  const r = await page.evaluate(() => {
    const hud = window.game.hud;
    const els = [...document.querySelectorAll('.damage-dir')];
    const running = () => els.filter((e) => e.getAnimations().some((a) => a.playState === 'running')).length;
    hud.showDamage(20, 0);
    hud.showDamage(20, Math.PI / 2);
    hud.showDamage(20, -Math.PI / 2);
    const three = running();
    const angles = els.map((e) => e.style.transform);
    hud.showDamage(30, 0.1);
    const again = running();
    const renewed = els.filter((e) => e.style.transform === 'rotate(0.1rad)').length;
    return { count: els.length, three, again, renewed, distinct: new Set(angles).size };
  });
  assert.equal(r.count, 3);
  assert.equal(r.three, 3, 'three markers at once');
  assert.equal(r.distinct, 3);
  assert.equal(r.again, 3, 'a repeat takes no fourth');
  assert.equal(r.renewed, 1, 'the marker for that side was renewed');
  assert.deepEqual(page.errors, []);
});
