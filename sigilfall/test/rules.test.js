/* shared combat maths and mode definitions */
import { test, assert, equal, near } from './harness.js';
import { MODES, MODE_LIST, RULES, falloffMul, shapeDamage, fireInterval, getMode } from '../public/src/game/rules.js';
import { clamp, angleDelta, dirFromAngles, damp } from '../public/src/core/math.js';

test('the three modes are defined with sane targets', () => {
  assert(MODE_LIST.includes('tdm') && MODE_LIST.includes('ffa') && MODE_LIST.includes('duel'));
  for (const id of MODE_LIST) {
    const m = MODES[id];
    assert(m.target > 0 && m.target <= 40, id + ' target out of band');
    assert(m.respawn >= 2 && m.respawn <= 6, id + ' respawn out of band');
    assert(m.maxPlayers >= 2, id + ' needs room for players');
  }
  equal(MODES.duel.maxPlayers, 2, 'a duel is 1v1');
  assert(MODES.ffa.ffa, 'free for all must be flagged');
  equal(getMode('nonsense').id, 'tdm', 'unknown modes fall back to team deathmatch');
});

test('range falloff never drops below the floor and never exceeds one', () => {
  const spec = [40, 80, 0.7];
  equal(falloffMul(spec, 10), 1);
  equal(falloffMul(spec, 40), 1);
  near(falloffMul(spec, 60), 0.85, 0.001);
  near(falloffMul(spec, 80), 0.7, 0.001);
  near(falloffMul(spec, 500), 0.7, 0.001, 'past max range the floor holds');
  equal(falloffMul(null, 99), 1, 'no falloff spec means no reduction');
});

test('damage shaping applies headshots, falloff and multipliers together', () => {
  equal(shapeDamage(30, {}), 30);
  equal(shapeDamage(30, { head: true, headMul: 2 }), 60);
  equal(shapeDamage(30, { falloff: [10, 20, 0.5], dist: 20 }), 15);
  equal(shapeDamage(30, { attackerMul: 1.5, victimMul: 0.5 }), 23);
  equal(shapeDamage(-5, {}), 0, 'damage never goes negative');
});

test('fire interval follows rounds per minute', () => {
  near(fireInterval({ rpm: 60 }), 1, 1e-9);
  near(fireInterval({ rpm: 240 }), 0.25, 1e-9);
});

test('ultimate charge needs a real fight, not a few hits', () => {
  const u = RULES.ult;
  const dmgForFull = u.max / u.perDamage;
  assert(dmgForFull > 250, 'a domain should cost real damage, got ' + Math.round(dmgForFull));
  const idleSeconds = u.max / u.perSecond;
  assert(idleSeconds > 60, 'standing still should not charge a domain quickly');
});

test('maths helpers behave at the edges', () => {
  equal(clamp(5, 0, 1), 1);
  equal(clamp(-5, 0, 1), 0);
  near(angleDelta(3.1, -3.1), 0.0831853, 1e-4, 'angles wrap the short way');
  const d = dirFromAngles(0, 0);
  near(d.x, 0, 1e-9); near(d.z, -1, 1e-9, 'yaw 0 looks down -Z');
  const back = dirFromAngles(Math.PI, 0);
  near(back.z, 1, 1e-9, 'half a turn looks down +Z');
  const up = dirFromAngles(0, Math.PI / 2);
  near(up.y, 1, 1e-9, 'positive pitch looks up');
  near(damp(0, 10, 10, 0), 0, 1e-9, 'a zero length frame moves nothing');
});

test('crouching is slower than walking, sprinting is faster', () => {
  assert(RULES.crouchMul < 1 && RULES.sprintMul > 1);
  assert(RULES.crouchHeight < RULES.standHeight);
  assert(RULES.eyeDrop > 0 && RULES.eyeDrop < 0.5);
});
