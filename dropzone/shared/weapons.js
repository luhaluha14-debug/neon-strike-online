/* =========================================================================
   Weapon definitions (original designs, original numbers).
   All angles in degrees, speeds in m/s, times in seconds.

   spread  : cone half-angle for a single projectile
   recoil  : camera kick handled by the view controller (player camera / bot aim)
             up      – vertical kick per shot
             side    – max random horizontal kick per shot
             bias    – average horizontal drift per shot (+ = right)
             recover – how fast the unrecovered kick returns (1/s)
   falloff : [startMeters, endMeters, minMultiplier]
   ========================================================================= */

export const AMMO = {
  light: { name: 'L-탄 (경량)', short: 'L', color: '#e0b64a', weight: 0.4, stack: 30 },
  pistol: { name: 'P-탄 (권총)', short: 'P', color: '#8fb4e0', weight: 0.3, stack: 30 },
  shell: { name: '12S 산탄', short: 'S', color: '#e0664a', weight: 1.0, stack: 10 }
};

export const WEAPONS = {
  kestrel: {
    name: 'KESTREL AR', cat: 'ar', catName: '돌격소총', slot: 'primary',
    ammo: 'light', damage: 33, headMul: 2.1, limbMul: 0.8,
    rpm: 690, mode: 'auto', mag: 30, reload: 2.1, reloadEmpty: 2.7, reloadType: 'mag',
    bulletSpeed: 840, gravity: 1.0, pellets: 1,
    spread: { hip: 2.6, ads: 0.14, move: 2.4, air: 6, crouch: 0.8, prone: 0.6, bloom: 0.35, bloomMax: 2.2, bloomDecay: 5 },
    recoil: { up: 0.62, side: 0.32, bias: 0.06, recover: 5.5, first: 1.4, ads: 0.85 },
    falloff: [55, 240, 0.62], range: 600,
    moveMul: 0.96, zoom: 1.35, adsTime: 0.2, equip: 0.55,
    sound: 'rifle', model: 'rifle'
  },
  wasp: {
    name: 'WASP SMG', cat: 'smg', catName: '기관단총', slot: 'primary',
    ammo: 'pistol', damage: 22, headMul: 1.8, limbMul: 0.85,
    rpm: 880, mode: 'auto', mag: 32, reload: 1.8, reloadEmpty: 2.25, reloadType: 'mag',
    bulletSpeed: 410, gravity: 1.0, pellets: 1,
    spread: { hip: 1.7, ads: 0.35, move: 1.1, air: 4, crouch: 0.85, prone: 0.7, bloom: 0.18, bloomMax: 1.3, bloomDecay: 6 },
    recoil: { up: 0.34, side: 0.34, bias: -0.03, recover: 7, first: 1.2, ads: 0.8 },
    falloff: [22, 95, 0.45], range: 300,
    moveMul: 1.0, zoom: 1.2, adsTime: 0.14, equip: 0.4,
    sound: 'smg', model: 'smg'
  },
  breaker: {
    name: 'BREAKER 12', cat: 'shotgun', catName: '산탄총', slot: 'primary',
    ammo: 'shell', damage: 12, headMul: 1.5, limbMul: 0.9,
    rpm: 70, mode: 'semi', mag: 5, reload: 0.5, reloadEmpty: 0.5, reloadType: 'shell', reloadStart: 0.35,
    bulletSpeed: 380, gravity: 1.0, pellets: 9,
    spread: { hip: 4.2, ads: 3.2, move: 0.6, air: 1.5, crouch: 0.95, prone: 0.95, bloom: 0, bloomMax: 0, bloomDecay: 1, pellet: true },
    recoil: { up: 3.2, side: 0.9, bias: 0, recover: 4, first: 1, ads: 0.9 },
    falloff: [7, 38, 0.18], range: 120,
    moveMul: 0.97, zoom: 1.12, adsTime: 0.2, equip: 0.6,
    sound: 'shotgun', model: 'shotgun'
  },
  hornet: {
    name: 'HORNET P9', cat: 'pistol', catName: '권총', slot: 'side',
    ammo: 'pistol', damage: 25, headMul: 1.9, limbMul: 0.85,
    rpm: 420, mode: 'semi', mag: 15, reload: 1.5, reloadEmpty: 1.85, reloadType: 'mag',
    bulletSpeed: 360, gravity: 1.0, pellets: 1,
    spread: { hip: 1.3, ads: 0.35, move: 0.8, air: 3, crouch: 0.85, prone: 0.75, bloom: 0.25, bloomMax: 1.2, bloomDecay: 5 },
    recoil: { up: 1.05, side: 0.3, bias: 0.02, recover: 8, first: 1, ads: 0.85 },
    falloff: [20, 80, 0.5], range: 250,
    moveMul: 1.05, zoom: 1.15, adsTime: 0.12, equip: 0.3,
    sound: 'pistol', model: 'pistol'
  },
  fists: {
    name: 'FISTS', cat: 'melee', catName: '근접', slot: 'melee',
    ammo: null, damage: 18, headMul: 1.3, limbMul: 1,
    rpm: 110, mode: 'auto', mag: 0, reload: 0, reloadEmpty: 0, reloadType: 'none',
    bulletSpeed: 0, gravity: 0, pellets: 1, meleeRange: 1.7,
    spread: { hip: 0, ads: 0, move: 0, air: 0, crouch: 1, prone: 1, bloom: 0, bloomMax: 0, bloomDecay: 1 },
    recoil: { up: 0, side: 0, bias: 0, recover: 5, first: 1, ads: 1 },
    falloff: [99, 99, 1], range: 2,
    moveMul: 1.08, zoom: 1.0, adsTime: 0.1, equip: 0.2,
    sound: 'punch', model: 'none'
  }
};

/* pseudo weapon used while a throwable is in hand (slot 5) */
WEAPONS.throw = {
  name: 'THROWABLE', cat: 'throw', catName: '투척물', slot: 'throw',
  ammo: null, damage: 0, headMul: 1, limbMul: 1,
  rpm: 60, mode: 'semi', mag: 0, reload: 0, reloadEmpty: 0, reloadType: 'none',
  bulletSpeed: 0, gravity: 0, pellets: 0,
  spread: { hip: 0, ads: 0, move: 0, air: 0, crouch: 1, prone: 1, bloom: 0, bloomMax: 0, bloomDecay: 1 },
  recoil: { up: 0, side: 0, bias: 0, recover: 5, first: 1, ads: 1 },
  falloff: [99, 99, 1], range: 0,
  moveMul: 1.0, zoom: 1.0, adsTime: 0.12, equip: 0.35,
  sound: 'none', model: 'grenade'
};

export const SLOT_NAMES = ['주무기 1', '주무기 2', '보조무기', '근접'];

/** falloff multiplier by travel distance */
export function falloffMul(w, dist) {
  const [a, b, m] = w.falloff;
  if (dist <= a) return 1;
  if (dist >= b) return m;
  return 1 + (m - 1) * ((dist - a) / (b - a));
}
