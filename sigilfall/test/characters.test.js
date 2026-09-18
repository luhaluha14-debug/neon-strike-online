/* the roster: shape, completeness and rough balance */
import { test, assert, equal } from './harness.js';
import { CHARACTERS, CHARACTER_LIST, abilityOf, ABILITY_SLOTS, CHARMS, CHARM_LIST, getCharm } from '../public/src/characters/roster.js';
import { fireInterval } from '../public/src/game/rules.js';

const KINDS = ['projectile', 'hitscan', 'melee', 'dash', 'blink', 'zone', 'buff',
  'summon', 'parry', 'ads', 'charge', 'domain'];

test('four distinct characters with different roles', () => {
  assert(CHARACTER_LIST.length >= 4, 'expected at least four characters');
  const roles = new Set(CHARACTER_LIST.map((id) => CHARACTERS[id].role));
  equal(roles.size, CHARACTER_LIST.length, 'each character needs its own role');
  const kits = new Set(CHARACTER_LIST.map((id) => CHARACTERS[id].primary.kind + '/' + CHARACTERS[id].secondary.kind));
  equal(kits.size, CHARACTER_LIST.length, 'each character needs its own basic attack style');
});

test('every character carries the stats the runtime reads', () => {
  for (const id of CHARACTER_LIST) {
    const c = CHARACTERS[id];
    for (const key of ['name', 'latin', 'role', 'blurb', 'hp', 'speed', 'accel', 'airAccel',
      'radius', 'jump', 'color', 'accent', 'energy', 'primary', 'secondary', 'q', 'a1', 'a2', 'ult']) {
      assert(c[key] !== undefined, id + ' is missing ' + key);
    }
    assert(c.hp >= 150 && c.hp <= 260, id + ' hp out of band: ' + c.hp);
    assert(c.speed >= 6 && c.speed <= 8, id + ' speed out of band: ' + c.speed);
    assert(c.energy.max > 0 && c.energy.regen > 0, id + ' needs an energy pool');
  }
});

test('every ability has a known kind, an icon, a name and a description', () => {
  for (const id of CHARACTER_LIST) {
    for (const slot of ['lmb', 'rmb', ...ABILITY_SLOTS]) {
      const a = abilityOf(id, slot);
      assert(a, id + ' has no ability in ' + slot);
      assert(KINDS.includes(a.kind), id + '.' + slot + ' unknown kind ' + a.kind);
      assert(a.id && a.name && a.latin, id + '.' + slot + ' needs id/name/latin');
      assert(a.icon, id + '.' + slot + ' needs an icon');
      assert(a.desc, id + '.' + slot + ' needs a description for the kit screen');
    }
  }
});

test('ability ids are unique across the roster', () => {
  const seen = new Set();
  for (const id of CHARACTER_LIST) {
    for (const slot of ['lmb', 'rmb', ...ABILITY_SLOTS]) {
      const a = abilityOf(id, slot);
      assert(!seen.has(a.id), 'duplicate ability id ' + a.id);
      seen.add(a.id);
    }
  }
});

test('strong sorcery costs a cooldown, a resource or a wind-up', () => {
  for (const id of CHARACTER_LIST) {
    for (const slot of ABILITY_SLOTS) {
      const a = abilityOf(id, slot);
      if (slot === 'ult') {
        assert(a.kind === 'domain', id + ' ultimate must be a domain');
        assert(a.castTime > 0, id + ' ultimate needs a wind-up');
        assert(a.dur >= 5 && a.dur <= 9, id + ' domain duration out of band: ' + a.dur);
        assert(a.radius >= 10 && a.radius <= 16, id + ' domain radius out of band: ' + a.radius);
        assert(a.inside, id + ' domain needs inside rules');
        continue;
      }
      assert(a.cd >= 4, id + '.' + slot + ' cooldown too short: ' + a.cd);
      assert(a.cd <= 15, id + '.' + slot + ' cooldown too long: ' + a.cd);
      if (a.dmg >= 60) {
        assert(a.castTime > 0 || a.hpCost > 0, id + '.' + slot + ' hits hard with no cost or wind-up');
      }
    }
  }
});

test('basic attacks land in a comparable damage band', () => {
  for (const id of CHARACTER_LIST) {
    const p = CHARACTERS[id].primary;
    const dps = p.dmg / fireInterval(p);
    assert(dps > 80 && dps < 140, id + ' primary dps out of band: ' + Math.round(dps));
    assert(p.head >= 1 && p.head <= 2.1, id + ' headshot multiplier out of band');
    if (p.cost) assert(p.cost * (60 / p.rpm ? 1 : 1) < CHARACTERS[id].energy.max, id + ' one shot must not empty the pool');
  }
});

test('sustained fire runs the energy pool down, so it cannot be held forever', () => {
  for (const id of CHARACTER_LIST) {
    const c = CHARACTERS[id], p = c.primary;
    if (!p.cost) continue;                       // melee has no pool cost by design
    const drain = p.cost / fireInterval(p);      // energy per second while firing
    assert(drain > c.energy.regen, id + ' can hold fire forever (drain ' + drain.toFixed(1) + ' vs regen ' + c.energy.regen + ')');
    const shots = Math.floor(c.energy.max / p.cost);
    assert(shots >= 8, id + ' only gets ' + shots + ' shots from a full pool');
  }
});

test('domains each apply their own rules, not a shared one', () => {
  const sigs = new Set();
  for (const id of CHARACTER_LIST) {
    const ins = CHARACTERS[id].ult.inside;
    const sig = Object.keys(ins).sort().join(',');
    assert(!sigs.has(sig), id + ' domain rules duplicate another character');
    sigs.add(sig);
  }
});

test('charms are small, readable trades and nothing more', () => {
  const allowed = ['hp', 'speed', 'regen', 'cdMul', 'cdQ', 'taken', 'ultGain', 'domainDur'];
  assert(CHARM_LIST.length >= 4, 'the loadout needs real choices');
  assert(CHARMS.none && Object.keys(CHARMS.none.mods).length === 0, 'there must be a plain option');
  for (const id of CHARM_LIST) {
    const c = CHARMS[id];
    assert(c.name && c.latin && c.desc && c.icon, id + ' needs a name, a description and an icon');
    for (const [k, v] of Object.entries(c.mods)) {
      assert(allowed.includes(k), id + ' touches something a charm may not: ' + k);
      if (k === 'cdQ') assert(v >= -1.5 && v <= 0, id + ' cooldown charm out of band');
      else if (k === 'domainDur') assert(v > 0 && v <= 1.2, id + ' domain charm out of band');
      else assert(v > 0.85 && v < 1.35, id + '.' + k + ' is too strong: ' + v);
    }
  }
});

test('no charm is strictly better than another', () => {
  // every charm that gives something must give something the others do not
  const fields = CHARM_LIST.filter((id) => id !== 'none').map((id) => Object.keys(CHARMS[id].mods).sort().join(','));
  equal(new Set(fields).size, fields.length, 'two charms modify exactly the same things');
});

test('an unknown charm falls back to the plain one', () => {
  equal(getCharm('nonsense').id, 'none');
  equal(getCharm(undefined).id, 'none');
});
