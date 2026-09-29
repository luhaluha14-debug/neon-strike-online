import type { WeaponDefinition } from './WeaponDefinition';

// Single source of truth for weapon balance. Add a new gun by adding an entry.

const deg = (d: number) => (d * Math.PI) / 180;

export const AR_01: WeaponDefinition = {
  id: 'ar01',
  displayName: 'AR-01',
  fireMode: 'auto',
  fireRate: 600,
  magazineSize: 30,
  reserveAmmo: 90,
  reloadTime: 2.2,
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
  view: { kind: 'procedural', style: 'rifle' },
};

export const WEAPONS: Record<string, WeaponDefinition> = {
  [AR_01.id]: AR_01,
};
