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
    base: 32,
    headMultiplier: 4,
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

export const WEAPONS: Record<string, WeaponDefinition> = {
  [AR_01.id]: AR_01,
  [SR_01.id]: SR_01,
  [KARAMBIT.id]: KARAMBIT,
};

/** Default loadout; slot index = number key - 1. */
export const DEFAULT_LOADOUT: readonly WeaponDefinition[] = [AR_01, SR_01, KARAMBIT];
