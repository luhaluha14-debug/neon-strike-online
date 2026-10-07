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
    kind: 'procedural',
    model: 'ar01',
    // Angled across the screen so the rifle's side and both gloved hands show.
    pose: { position: [0.125, -0.115, -0.42], rotation: [0.03, 0.27, -0.1], scale: 1 },
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
    kind: 'procedural',
    model: 'sr01',
    // Right of centre and angled so the scope, magazine and both gloved hands read.
    pose: { position: [0.17, -0.095, -0.46], rotation: [0.02, 0.36, -0.16], scale: 1 },
  },
};

/** Curved-blade knife. Melee = a weapon without ammo and a ~1.9 m reach. */
export const KARAMBIT: WeaponDefinition = {
  id: 'karambit',
  displayName: 'KARAMBIT',
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
    kind: 'procedural',
    model: 'karambit',
    // Fist on the right, ring on top, blade sweeping down-left across the view.
    pose: { position: [0.13, -0.05, -0.28], rotation: [0.35, 1.35, 0.1], scale: 1 },
  },
};

export const WEAPONS: Record<string, WeaponDefinition> = {
  [AR_01.id]: AR_01,
  [SR_01.id]: SR_01,
  [KARAMBIT.id]: KARAMBIT,
};

/** Default loadout; slot index = number key - 1. */
export const DEFAULT_LOADOUT: readonly WeaponDefinition[] = [AR_01, SR_01, KARAMBIT];
