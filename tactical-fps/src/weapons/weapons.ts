import type { WeaponDefinition } from './WeaponDefinition';

// Single source of truth for weapon balance and first-person placement.
// Add a new weapon by adding an entry and putting it in the loadout.

const deg = (d: number) => (d * Math.PI) / 180;

export const AR_01: WeaponDefinition = {
  id: 'ar01',
  displayName: 'AR-01',
  category: 'rifle',
  fireMode: 'auto',
  fireRate: 600,
  magazineSize: 30,
  reserveAmmo: 90,
  reloadTime: 2.2,
  equipTime: 0.6,
  damage: {
    // 5 body hits to kill (24 x 4 = 96), one headshot still kills (24 x 4.25 = 102) inside the falloff start.
    base: 24,
    headMultiplier: 4.25,
    limbMultiplier: 0.8,
    falloffStart: 30,
    falloffEnd: 80,
    falloffMinMultiplier: 0.8,
    maxRange: 250,
  },
  spread: {
    standing: 0,
    moving: deg(1.6),
    airborne: deg(6),
    crouchMultiplier: 0.7,
  },
  recoil: {
    pitchPerShot: deg(0.45),
    pitchGrowthPerShot: deg(0.04),
    growthShots: 8,
    maxPitch: deg(6),
    yawJitter: deg(0.18),
    yawDrift: deg(0.16),
    yawDriftAfterShots: 9,
    kickResponse: 28,
    recoveryDelay: 0.14,
    recoverySpeed: deg(22),
    sprayResetTime: 0.35,
  },
  view: {
    kind: 'gltf',
    url: '/weapons/ar01.glb',
    fallback: 'ar01',
    // Blender export: muzzle along +X, no anchor nodes. Values measured on the file.
    fit: {
      rotation: [0, Math.PI / 2, 0],
      // Pistol grip axis and centre from the file's vertices; the hand sits just below the handguard rails.
      grip: { position: [0, -0.1208, 0.0928], rotation: [-0.391, 0, 0] },
      support: { position: [0, -0.024, -0.24] },
      hand: { width: 0.034, depth: 0.045, index: 'trigger' },
      muzzle: [0, 0, -0.42],
      magazine: ['Magazine', 'Magazine_Base', 'Mag_Ribs_L', 'Mag_Ribs_R'],
    },
    // Low on the right, pointing nearly straight ahead (classic CS framing): side of the rifle and the hands show.
    pose: { position: [0.17, -0.13, -0.46], rotation: [0.02, 0.12, -0.04], scale: 1 },
  },
  sounds: {
    fire: 'ar01.shot',
    fireVolume: 0.85,
    dry: 'dryfire',
    equip: 'equip.gun',
    reload: [
      { at: 0.04, sound: 'mag.out' },
      { at: 0.81, sound: 'mag.in' },
    ],
    reloadEnd: 'ar01.charge',
  },
};

/** Bolt-action sniper rifle (AWP-style). One heavy, precise shot per bolt cycle. */
export const SR_01: WeaponDefinition = {
  id: 'sr01',
  displayName: 'SR-01',
  // Right mouse: 4x scope, look slowed to 40 % while zoomed.
  scope: { zoom: 4, sensitivity: 0.4 },
  category: 'sniper',
  fireMode: 'semi',
  // ~1.45 s between shots: the bolt cycle.
  fireRate: 41,
  magazineSize: 5,
  reserveAmmo: 30,
  reloadTime: 3.6,
  equipTime: 1.0,
  damage: {
    base: 115,
    headMultiplier: 4,
    limbMultiplier: 0.85,
    falloffStart: 120,
    falloffEnd: 250,
    falloffMinMultiplier: 0.9,
    maxRange: 400,
  },
  spread: {
    standing: 0,
    moving: deg(6),
    airborne: deg(12),
    crouchMultiplier: 0.8,
  },
  recoil: {
    pitchPerShot: deg(2.4),
    pitchGrowthPerShot: 0,
    growthShots: 0,
    maxPitch: deg(4),
    yawJitter: deg(0.5),
    yawDrift: 0,
    yawDriftAfterShots: 99,
    kickResponse: 34,
    recoveryDelay: 0.25,
    recoverySpeed: deg(9),
    sprayResetTime: 1.2,
  },
  view: {
    kind: 'gltf',
    url: '/weapons/sr01.glb',
    fallback: 'sr01',
    // Blender export: muzzle along +X, no anchor nodes. Values measured on the file.
    fit: {
      rotation: [0, Math.PI / 2, 0],
      // Thumbhole grip of the slab stock (4.6 cm thick): hand low on the grip, thumb through the hole.
      grip: { position: [0, -0.115, 0.115], rotation: [-0.2, 0, 0] },
      support: { position: [0, -0.05, -0.26] },
      muzzle: [0, 0.028, -0.692],
      magazine: ['Magazine', 'Magazine_Base', 'Magazine_Ribs'],
      bolt: { nodes: ['Bolt_Cap', 'Bolt_Handle', 'Bolt_Knob', 'Bolt_Shroud'], pivot: [0, 0.028, 0.104] },
      hand: { width: 0.06, depth: 0.05, index: 'trigger', wristLift: 0 },
      // Forearm leaves the grip up and to the right, as on the placeholder sniper.
      armPose: { rightElbow: [0.26, -0.2, 0.4] },
    },
    // Right of centre and angled so the scope, magazine and both gloved hands read.
    // Low on the right with the scope in view, barrel toward the centre.
    pose: { position: [0.2, -0.13, -0.5], rotation: [0.02, 0.16, -0.05], scale: 1 },
  },
  sounds: {
    fire: 'sr01.shot',
    fireVolume: 1,
    cycle: 'sr01.bolt',
    dry: 'dryfire',
    equip: 'equip.gun',
    reload: [
      { at: 0.04, sound: 'mag.out' },
      { at: 0.81, sound: 'mag.in' },
    ],
    reloadEnd: 'sr01.chamber',
  },
};

/** Curved-blade knife. Melee = a weapon without ammo and a ~1.9 m reach. */
export const KARAMBIT: WeaponDefinition = {
  id: 'karambit',
  // Internal id stays 'karambit' (saved data, sounds and tests refer to it); the model is the M9.
  displayName: 'M9 BAYONET',
  category: 'melee',
  fireMode: 'auto',
  // One slash every 0.5 s while held.
  fireRate: 120,
  magazineSize: 0,
  reserveAmmo: 0,
  reloadTime: 0,
  equipTime: 0.35,
  damage: {
    base: 40,
    headMultiplier: 1.5,
    limbMultiplier: 1,
    falloffStart: 2,
    falloffEnd: 3,
    falloffMinMultiplier: 1,
    maxRange: 1.9,
  },
  spread: { standing: 0, moving: 0, airborne: 0, crouchMultiplier: 1 },
  recoil: {
    pitchPerShot: 0,
    pitchGrowthPerShot: 0,
    growthShots: 0,
    maxPitch: 0,
    yawJitter: 0,
    yawDrift: 0,
    yawDriftAfterShots: 99,
    kickResponse: 30,
    recoveryDelay: 0.1,
    recoverySpeed: 1,
    sprayResetTime: 0.5,
  },
  view: {
    kind: 'gltf',
    url: '/weapons/m9_bayonet.glb',
    fallback: 'karambit',
    // Blender export: blade along +Y, edge toward -X. Turned so the edge faces forward.
    fit: {
      rotation: [0, -Math.PI / 2, 0],
      grip: { position: [0, -0.065, 0] },
      hand: { width: 0.028, depth: 0.036, index: 'trigger' },
    },
    // Forward grip low on the right, blade angled up toward the centre showing its flat.
    pose: { position: [0.16, -0.115, -0.37], rotation: [-0.95, 1.1, 0.55], scale: 1 },
  },
  sounds: {
    fire: 'karambit.swing',
    fireVolume: 0.5,
    hit: 'karambit.hit',
    equip: 'equip.knife',
  },
};

// Team match buy-menu weapons. Blender exports with the muzzle along -X and no
// anchor nodes (fit values measured on the files' vertices). Not in the
// free-for-all / training loadout.

/** 9 mm SMG: fast, accurate on the move, weak at range. 6 body hits; a headshot does not kill. */
export const SMG_01: WeaponDefinition = {
  id: 'smg01',
  displayName: 'SMG-01',
  category: 'smg',
  fireMode: 'auto',
  fireRate: 800,
  magazineSize: 30,
  reserveAmmo: 120,
  reloadTime: 2.1,
  equipTime: 0.5,
  damage: {
    base: 19,
    headMultiplier: 3.5,
    limbMultiplier: 0.8,
    falloffStart: 12,
    falloffEnd: 40,
    falloffMinMultiplier: 0.65,
    maxRange: 150,
  },
  spread: {
    standing: 0,
    moving: deg(0.9),
    airborne: deg(4),
    crouchMultiplier: 0.75,
  },
  recoil: {
    pitchPerShot: deg(0.3),
    pitchGrowthPerShot: deg(0.025),
    growthShots: 8,
    maxPitch: deg(4.5),
    yawJitter: deg(0.15),
    yawDrift: deg(0.12),
    yawDriftAfterShots: 10,
    kickResponse: 30,
    recoveryDelay: 0.12,
    recoverySpeed: deg(24),
    sprayResetTime: 0.3,
  },
  view: {
    kind: 'gltf',
    url: '/weapons/smg01.glb',
    fallback: 'ar01',
    fit: {
      rotation: [0, -Math.PI / 2, 0],
      // Pistol grip behind the trigger (file x 0.10..0.19, down to y -0.087), raked back like the rifle's.
      grip: { position: [0, -0.04, 0.15], rotation: [-0.35, 0, 0] },
      // Under the handguard, ahead of the magazine.
      support: { position: [0, 0.05, -0.215] },
      hand: { width: 0.036, depth: 0.045, index: 'trigger' },
      muzzle: [0, 0.11, -0.335],
    },
    pose: { position: [0.17, -0.22, -0.52], rotation: [0.02, 0.12, -0.04], scale: 1 },
  },
  sounds: {
    fire: 'smg01.shot',
    fireVolume: 0.75,
    dry: 'dryfire',
    equip: 'equip.gun',
    reload: [
      { at: 0.05, sound: 'mag.out' },
      { at: 0.78, sound: 'mag.in' },
    ],
    reloadEnd: 'ar01.charge',
  },
};

/**
 * Pump shotgun: 8 pellets per round. Point blank a full pattern kills
 * (8 x 15); at range pellets spread out and lose damage fast.
 */
export const SG_01: WeaponDefinition = {
  id: 'sg01',
  displayName: 'SG-01',
  category: 'shotgun',
  fireMode: 'semi',
  // One pump cycle per round (~0.9 s).
  fireRate: 68,
  magazineSize: 8,
  reserveAmmo: 32,
  reloadTime: 3.2,
  equipTime: 0.7,
  damage: {
    base: 15,
    headMultiplier: 2,
    limbMultiplier: 0.75,
    falloffStart: 6,
    falloffEnd: 22,
    falloffMinMultiplier: 0.3,
    maxRange: 60,
  },
  pellets: { count: 8, spread: deg(3.2) },
  spread: {
    standing: 0,
    moving: deg(1.5),
    airborne: deg(5),
    crouchMultiplier: 0.85,
  },
  recoil: {
    pitchPerShot: deg(2.8),
    pitchGrowthPerShot: 0,
    growthShots: 0,
    maxPitch: deg(5),
    yawJitter: deg(0.6),
    yawDrift: 0,
    yawDriftAfterShots: 99,
    kickResponse: 32,
    recoveryDelay: 0.2,
    recoverySpeed: deg(12),
    sprayResetTime: 1,
  },
  view: {
    kind: 'gltf',
    url: '/weapons/sg01.glb',
    fallback: 'ar01',
    // The file's object sits 0.4 m below its origin; the pose lifts it back.
    fit: {
      rotation: [0, -Math.PI / 2, 0],
      // Pistol-grip wrist of the stock (file x ~0.27, bottom y -0.494).
      grip: { position: [0, -0.445, 0.27], rotation: [-0.45, 0, 0] },
      // On the pump fore-end (file x -0.18..-0.12).
      support: { position: [0, -0.405, -0.15] },
      hand: { width: 0.04, depth: 0.046, index: 'trigger' },
      muzzle: [0, -0.322, -0.42],
      // Elbows are in weapon space: 0.4 m lower than the default to follow the file's offset, the right one further back (long stock).
      armPose: { rightElbow: [0.17, -0.73, 0.6], leftElbow: [-0.3, -0.78, 0.05] },
    },
    pose: { position: [0.17, 0.21, -0.6], rotation: [0.02, 0.1, -0.04], scale: 1 },
  },
  sounds: {
    fire: 'sg01.shot',
    fireVolume: 1,
    cycle: 'sg01.pump',
    dry: 'dryfire',
    equip: 'equip.gun',
    // Shells pushed into the tube (the whole reload is one action).
    reload: [
      { at: 0.15, sound: 'mag.in' },
      { at: 0.4, sound: 'mag.in' },
      { at: 0.65, sound: 'mag.in' },
    ],
    reloadEnd: 'sg01.pump',
  },
};

/** 9 mm pistol: secondary. 4 body hits; a headshot kills up close. */
export const PIS_01: WeaponDefinition = {
  id: 'pis01',
  displayName: 'PIS-01',
  category: 'pistol',
  fireMode: 'semi',
  fireRate: 360,
  magazineSize: 12,
  reserveAmmo: 36,
  reloadTime: 1.8,
  equipTime: 0.35,
  damage: {
    base: 26,
    headMultiplier: 3.9,
    limbMultiplier: 0.8,
    falloffStart: 15,
    falloffEnd: 45,
    falloffMinMultiplier: 0.7,
    maxRange: 120,
  },
  spread: {
    standing: 0,
    moving: deg(1.2),
    airborne: deg(5),
    crouchMultiplier: 0.8,
  },
  recoil: {
    pitchPerShot: deg(1.0),
    pitchGrowthPerShot: deg(0.1),
    growthShots: 5,
    maxPitch: deg(5),
    yawJitter: deg(0.3),
    yawDrift: 0,
    yawDriftAfterShots: 99,
    kickResponse: 34,
    recoveryDelay: 0.12,
    recoverySpeed: deg(18),
    sprayResetTime: 0.45,
  },
  view: {
    kind: 'gltf',
    url: '/weapons/pis01.glb',
    fallback: 'ar01',
    fit: {
      rotation: [0, -Math.PI / 2, 0],
      // Grip frame (file x 0.03..0.09, bottom y -0.053). One-handed: no support hand.
      grip: { position: [0, -0.012, 0.06], rotation: [-0.3, 0, 0] },
      hand: { width: 0.03, depth: 0.04, index: 'trigger' },
      muzzle: [0, 0.055, -0.1],
    },
    pose: { position: [0.15, -0.21, -0.44], rotation: [0.02, 0.06, -0.02], scale: 1 },
  },
  sounds: {
    fire: 'pis01.shot',
    fireVolume: 0.7,
    dry: 'dryfire',
    equip: 'equip.gun',
    reload: [
      { at: 0.08, sound: 'mag.out' },
      { at: 0.72, sound: 'mag.in' },
    ],
    reloadEnd: 'sr01.chamber',
  },
};

export const WEAPONS: Record<string, WeaponDefinition> = {
  [AR_01.id]: AR_01,
  [SR_01.id]: SR_01,
  [KARAMBIT.id]: KARAMBIT,
  [SMG_01.id]: SMG_01,
  [SG_01.id]: SG_01,
  [PIS_01.id]: PIS_01,
};

/** Default loadout; slot index = number key - 1. */
export const DEFAULT_LOADOUT: readonly WeaponDefinition[] = [AR_01, SR_01, KARAMBIT];
