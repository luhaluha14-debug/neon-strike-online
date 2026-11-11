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
    // Sideways: a small random wobble on a fixed S path (right, then left, then right; the
    // same every spray, so it can be learnt and pulled against).
    yawJitter: deg(0.09),
    yawDrift: deg(0.3),
    yawDriftAfterShots: 9,
    yawDriftSign: -1,
    yawSwayShots: 9,
    kickResponse: 28,
    recoveryDelay: 0.14,
    recoverySpeed: deg(22),
    yawRecovery: true,
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

/**
 * Bolt-action sniper rifle (AWP-style). One heavy, precise shot per bolt cycle. Phase 26-A: a body hit
 * kills through a vest too (145: the vest takes 44, 101 reaches the body); a leg hit does not (94).
 */
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
    base: 145,
    headMultiplier: 4,
    limbMultiplier: 0.65,
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
    // The scope settles back on the aim after the kick (sideways too) while the bolt cycles.
    yawRecovery: true,
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

/**
 * 9 mm SMG: cheap, fast, accurate on the move, weak at range. 6 body hits inside ~15 m (Phase 26-A:
 * the falloff starts at 8 m, was 12), more beyond; a headshot does not kill.
 */
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
    falloffStart: 8,
    falloffEnd: 30,
    falloffMinMultiplier: 0.6,
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
    // Lighter and quicker than the rifle: its S path starts to the left and turns sooner.
    yawJitter: deg(0.08),
    yawDrift: deg(0.22),
    yawDriftAfterShots: 10,
    yawDriftSign: 1,
    yawSwayShots: 7,
    kickResponse: 30,
    recoveryDelay: 0.12,
    recoverySpeed: deg(24),
    yawRecovery: true,
    sprayResetTime: 0.3,
  },
  view: {
    kind: 'gltf',
    // Rigged from smg01.glb by tools/rig-weapons.mjs: Magazine and ChargingHandle are their own parts.
    url: '/weapons/smg01_rig.glb',
    fallback: 'ar01',
    fit: {
      rotation: [0, -Math.PI / 2, 0],
      // Pistol grip behind the trigger (file x 0.10..0.19, down to y -0.087), raked back like the rifle's.
      grip: { position: [0, -0.04, 0.15], rotation: [-0.35, 0, 0] },
      // Under the handguard, ahead of the magazine.
      support: { position: [0, 0.05, -0.215] },
      hand: { width: 0.036, depth: 0.045, index: 'trigger' },
      muzzle: [0, 0.11, -0.335],
      // The curved magazine rakes forward: it drops out along its own angle.
      magazineDrop: [0, -0.906, -0.423],
      // Right side of the receiver tube, above the magazine well.
      ejectPort: [0.018, 0.12, 0.08],
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
 * Pump shotgun: 8 pellets per round. Up close a full pattern kills, a vest or not
 * (8 x 18; through a vest 8 x 13 = 104); at range pellets spread out and lose damage fast.
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
    base: 18,
    headMultiplier: 2,
    limbMultiplier: 0.75,
    falloffStart: 8,
    falloffEnd: 24,
    falloffMinMultiplier: 0.3,
    maxRange: 60,
  },
  pellets: { count: 8, spread: deg(2.7) },
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
    yawRecovery: true,
    sprayResetTime: 1,
  },
  view: {
    kind: 'gltf',
    // Rigged from sg01.glb by tools/rig-weapons.mjs: Pump, PumpBolt and a Shell for the loading port.
    url: '/weapons/sg01_rig.glb',
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
      // Reload: the support hand leaves the pump for the loading port under the receiver (shells go in there).
      magwell: [0, -0.4, 0.1],
      // The bolt window on the receiver's left (where PumpBolt shows): hulls leave to that side.
      ejectPort: [-0.02, -0.34, 0.13],
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
    yawJitter: deg(0.2),
    yawDrift: 0,
    yawDriftAfterShots: 99,
    kickResponse: 34,
    recoveryDelay: 0.12,
    recoverySpeed: deg(18),
    yawRecovery: true,
    sprayResetTime: 0.45,
  },
  view: {
    kind: 'gltf',
    // Rigged from pis01.glb by tools/rig-weapons.mjs: Slide, Trigger and Magazine are their own parts.
    url: '/weapons/pis01_rig.glb',
    fallback: 'ar01',
    fit: {
      rotation: [0, -Math.PI / 2, 0],
      // Grip frame (file x 0.03..0.09, bottom y -0.053). One-handed: no support hand.
      grip: { position: [0, -0.012, 0.06], rotation: [-0.3, 0, 0] },
      hand: { width: 0.03, depth: 0.04, index: 'trigger' },
      muzzle: [0, 0.055, -0.1],
      // The magazine leaves down the raked grip.
      magazineDrop: [0, -0.95, 0.31],
      // Top right of the slide.
      ejectPort: [0.012, 0.062, 0.01],
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

// ---- Phase 24 arsenal (team match buy menu) --------------------------------------------------------
// Blender files with every part its own node, the muzzle along +X, +Y up and the right side at +Z
// (fit.rotation turns that into the game's -Z forward). Model space below = file (z, y, -x). Anchors,
// muzzles and ports were measured on the files' vertices (grip rake from the grip's front / back edges).
// None of these is in the free-for-all / training loadout. (Phase 24 changed no existing weapon's numbers; the Phase 26-A
// rebalance did: tests/weapon-rebalance.test.mjs.)

/**
 * HK416-type 5.56 precision rifle (Phase 26-A): slower than AR-01 (560 RPM, 5 body hits in 0.43 s, AR-01
 * 0.40 s) and steadier; a head hit kills further out (24 x 4.4 = 106, to ~50 m; AR-01 ~36 m). Less climb,
 * a gentler S path, less falloff: the rifle for taps and bursts at range, not a faster AR-01.
 */
export const AR_02: WeaponDefinition = {
  id: 'ar02',
  displayName: 'AR-02',
  category: 'rifle',
  fireMode: 'auto',
  fireRate: 560,
  magazineSize: 30,
  reserveAmmo: 90,
  reloadTime: 2.4,
  equipTime: 0.6,
  damage: { base: 24, headMultiplier: 4.4, limbMultiplier: 0.8, falloffStart: 35, falloffEnd: 90, falloffMinMultiplier: 0.8, maxRange: 260 },
  spread: { standing: 0, moving: deg(1.5), airborne: deg(6), crouchMultiplier: 0.7 },
  recoil: {
    pitchPerShot: deg(0.4),
    pitchGrowthPerShot: deg(0.035),
    growthShots: 8,
    maxPitch: deg(5.5),
    // Its S path starts to the right (AR-01's to the left) and swings a little less.
    yawJitter: deg(0.08),
    yawDrift: deg(0.26),
    yawDriftAfterShots: 9,
    yawDriftSign: 1,
    yawSwayShots: 8,
    kickResponse: 28,
    recoveryDelay: 0.14,
    recoverySpeed: deg(23),
    yawRecovery: true,
    sprayResetTime: 0.33,
  },
  view: {
    kind: 'gltf',
    url: '/weapons/ar02.glb',
    fallback: 'ar01',
    fit: {
      rotation: [0, Math.PI / 2, 0],
      // Pistol grip (file x -0.108..-0.030, y -0.146..-0.040), raked ~17° (centre x -0.083 at the bottom, -0.051 at the top).
      // Glove fitted with the clipping check (window.vmCheck): 4 mm lower than the grip's centre line.
      grip: { position: [0, -0.097, 0.067], rotation: [-0.3, 0, 0] },
      // Under the free-float handguard (file x 0.135..0.375, bottom y 0.001).
      support: { position: [0, -0.004, -0.25] },
      hand: { width: 0.034, depth: 0.045, index: 'trigger' },
      // Flash hider face (file x 0.516, bore y 0.022..0.034).
      muzzle: [0, 0.028, -0.516],
      magazine: ['R_Magazine', 'R_MagFloorplate', 'R_MagRib'],
      magazinePivot: [0, -0.035, -0.068],
      // The curved magazine rakes forward (centre x 0.068 at the top, 0.094 at the bottom).
      magazineDrop: [0, -0.983, -0.181],
      // Middle of the dust cover, right side (file x 0..0.06, y 0.024..0.042, z 0.019).
      ejectPort: [0.019, 0.033, -0.03],
      groups: [
        { name: 'ChargingHandle', nodes: ['R_ChargingHandle'] },
        { name: 'Trigger', nodes: ['R_Trigger'] },
      ],
    },
    pose: { position: [0.17, -0.155, -0.47], rotation: [0.02, 0.12, -0.04], scale: 1 },
    // Its own feel: flatter than AR-01 (less muzzle rise, more straight push back).
    feel: { rise: 0.85, back: 1.15 },
  },
  sounds: {
    fire: 'ar02.shot',
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

/**
 * UMP45-type .45 SMG: slower and harder hitting than SMG-01 (4 body hits inside ~11 m, not 6), a smaller
 * magazine and a steep falloff (Phase 26-A: 25 a round, x0.55 by 30 m): it beats AR-01 inside ~20 m and
 * loses beyond. A headshot does not kill.
 */
export const SMG_02: WeaponDefinition = {
  id: 'smg02',
  displayName: 'SMG-02',
  category: 'smg',
  fireMode: 'auto',
  fireRate: 650,
  magazineSize: 25,
  reserveAmmo: 100,
  reloadTime: 2.3,
  equipTime: 0.5,
  damage: { base: 25, headMultiplier: 3.4, limbMultiplier: 0.8, falloffStart: 10, falloffEnd: 30, falloffMinMultiplier: 0.55, maxRange: 120 },
  spread: { standing: 0, moving: deg(1.0), airborne: deg(4.5), crouchMultiplier: 0.75 },
  recoil: {
    pitchPerShot: deg(0.38),
    pitchGrowthPerShot: deg(0.03),
    growthShots: 7,
    maxPitch: deg(4.8),
    yawJitter: deg(0.1),
    yawDrift: deg(0.25),
    yawDriftAfterShots: 8,
    yawDriftSign: -1,
    yawSwayShots: 6,
    kickResponse: 30,
    recoveryDelay: 0.12,
    recoverySpeed: deg(22),
    yawRecovery: true,
    sprayResetTime: 0.3,
  },
  view: {
    kind: 'gltf',
    url: '/weapons/smg02.glb',
    fallback: 'ar01',
    fit: {
      rotation: [0, Math.PI / 2, 0],
      // Steeply raked grip behind the trigger (centre x 0.041 at the bottom, 0.09 at the top, ~29°).
      // Fitted with the clipping check: the glove 8 mm down the grip, the support hand at the front of the rail.
      grip: { position: [0, -0.102, -0.064], rotation: [-0.5, 0, 0] },
      // Under the front of the receiver, on the bottom rail (file x 0.246..0.349, y -0.038).
      support: { position: [0, -0.028, -0.32] },
      hand: { width: 0.034, depth: 0.046, index: 'trigger' },
      muzzle: [0, 0, -0.393],
      magazine: ['U_Magazine', 'U_MagBase', 'U_MagWitnessHoles'],
      // Fitted with the clipping check over the reload: the hand takes the magazine low, by its back edge.
      magazinePivot: [0, -0.133, -0.165],
      // Straight magazine set at a forward angle (centre x 0.195 at the top, 0.232 at the bottom).
      magazineDrop: [0, -0.969, -0.247],
      // Port on the right of the receiver (file x 0.135..0.200, y -0.016..0.012, z 0.026).
      ejectPort: [0.026, -0.002, -0.168],
      groups: [
        // Cocking knob on the left front of the receiver: pulled back and let go at the end of the reload.
        { name: 'ChargingHandle', nodes: ['U_ChargingKnob'] },
        { name: 'Trigger', nodes: ['U_Trigger'] },
      ],
      // Left elbow further out, so the forearm passes outside the magazine.
      armPose: { leftElbow: [-0.5, -0.34, 0.12] },
    },
    pose: { position: [0.17, -0.165, -0.46], rotation: [0.02, 0.12, -0.04], scale: 1 },
    // .45: a heavier thump per round than SMG-01's buzz, less twist.
    feel: { kick: 1.12, roll: 0.85 },
  },
  sounds: {
    fire: 'smg02.shot',
    fireVolume: 0.78,
    dry: 'dryfire',
    equip: 'equip.gun',
    reload: [
      { at: 0.05, sound: 'mag.out' },
      { at: 0.78, sound: 'mag.in' },
    ],
    reloadEnd: 'smg02.charge',
  },
};

/**
 * M110-type 7.62 semi-auto designated marksman rifle: 2 body hits to kill out to ~60 m, a head hit kills
 * anywhere; 3x scope. Between AR and SR-01: faster than the bolt action (0.35 s a round), far weaker
 * per round, poor on the move. Phase 26-A: the view settles slower than the trigger (about 0.4 s for a
 * round; fired flat out the next one leaves ~0.45 deg high), so fast follow-ups at range must be held down
 * or paced.
 */
export const DMR_01: WeaponDefinition = {
  id: 'dmr01',
  displayName: 'DMR-01',
  scope: { zoom: 3, sensitivity: 0.5 },
  category: 'dmr',
  fireMode: 'semi',
  fireRate: 170,
  magazineSize: 20,
  reserveAmmo: 60,
  reloadTime: 3.1,
  equipTime: 0.9,
  damage: { base: 58, headMultiplier: 3.5, limbMultiplier: 0.8, falloffStart: 60, falloffEnd: 160, falloffMinMultiplier: 0.85, maxRange: 350 },
  spread: { standing: 0, moving: deg(4.5), airborne: deg(10), crouchMultiplier: 0.75 },
  recoil: {
    pitchPerShot: deg(1.5),
    pitchGrowthPerShot: deg(0.12),
    growthShots: 4,
    maxPitch: deg(5),
    yawJitter: deg(0.35),
    yawDrift: 0,
    yawDriftAfterShots: 99,
    kickResponse: 32,
    recoveryDelay: 0.22,
    recoverySpeed: deg(8),
    yawRecovery: true,
    sprayResetTime: 0.6,
  },
  view: {
    kind: 'gltf',
    // Rigged by tools/rig-weapons.mjs: the source as it is, its tan darkened to flat dark earth.
    url: '/weapons/dmr01_rig.glb',
    fallback: 'sr01',
    fit: {
      rotation: [0, Math.PI / 2, 0],
      // Grip (centre x -0.095 at the bottom, -0.059 at the top, ~24°).
      grip: { position: [0, -0.09, 0.076], rotation: [-0.47, 0, 0] },
      // Under the handguard, behind the folded bipod (handguard bottom y -0.033, bipod from x 0.289).
      support: { position: [0, -0.032, -0.23] },
      hand: { width: 0.034, depth: 0.046, index: 'trigger' },
      muzzle: [0, 0, -0.661],
      magazine: ['M_Magazine', 'M_MagBase', 'M_MagRibs'],
      // Fitted with the clipping check over the reload: the hand takes the magazine low, by its back edge.
      magazinePivot: [0, -0.115, -0.029],
      // Straight box magazine (centre x 0.059 top and bottom).
      ejectPort: [0.022, 0.009, -0.036],
      groups: [
        { name: 'ChargingHandle', nodes: ['M_ChargingHandle'] },
        { name: 'Trigger', nodes: ['M_Trigger'] },
        // The file's folded bipod legs stay splayed (±64 mm, wider than the ±40 mm rails): closed together
        // under the handguard as a folded bipod sits, about the centre line (the legs keep their length).
        { name: 'Bipod', nodes: ['M_BipodLegs', 'M_BipodFeet'], scale: [0.5, 1, 1] },
      ],
      armPose: { rightElbow: [0.24, -0.22, 0.38] },
    },
    pose: { position: [0.19, -0.15, -0.52], rotation: [0.02, 0.14, -0.05], scale: 1 },
  },
  sounds: {
    fire: 'dmr01.shot',
    fireVolume: 0.95,
    dry: 'dryfire',
    equip: 'equip.gun',
    reload: [
      { at: 0.04, sound: 'mag.out' },
      { at: 0.81, sound: 'mag.in' },
    ],
    reloadEnd: 'ar01.charge',
  },
};

/** P220-family 9 mm pistol (the delivered file's root is `P_P220`): 15 rounds (PIS-01: 12), a touch more kick. 4 body hits; a head hit kills up close (25 x 4 = 100). */
export const PIS_02: WeaponDefinition = {
  id: 'pis02',
  displayName: 'PIS-02',
  category: 'pistol',
  fireMode: 'semi',
  fireRate: 340,
  magazineSize: 15,
  reserveAmmo: 45,
  reloadTime: 2.0,
  equipTime: 0.4,
  damage: { base: 25, headMultiplier: 4, limbMultiplier: 0.8, falloffStart: 15, falloffEnd: 45, falloffMinMultiplier: 0.7, maxRange: 120 },
  spread: { standing: 0, moving: deg(1.35), airborne: deg(5), crouchMultiplier: 0.8 },
  recoil: {
    pitchPerShot: deg(1.05),
    pitchGrowthPerShot: deg(0.1),
    growthShots: 5,
    maxPitch: deg(5.2),
    yawJitter: deg(0.22),
    yawDrift: 0,
    yawDriftAfterShots: 99,
    kickResponse: 34,
    recoveryDelay: 0.12,
    recoverySpeed: deg(18),
    yawRecovery: true,
    sprayResetTime: 0.45,
  },
  view: {
    kind: 'gltf',
    // Rigged by tools/rig-weapons.mjs: the source's nodes plus the magazine body inside the grip (P_MagBody).
    url: '/weapons/pis02_rig.glb',
    fallback: 'ar01',
    fit: {
      rotation: [0, Math.PI / 2, 0],
      // Grip panels (centre x -0.085 at the bottom, -0.068 at the top, ~10°). One-handed: no support hand.
      grip: { position: [0, -0.024, 0.073], rotation: [-0.2, 0, 0] },
      hand: { width: 0.032, depth: 0.042, index: 'trigger' },
      muzzle: [0, 0.048, -0.094],
      magazine: ['P_MagBase', 'P_MagBody'],
      magazinePivot: [0, 0.022, 0.068],
      magazineDrop: [0, -0.985, 0.17],
      // Port on the right of the slide, ahead of the serrations.
      ejectPort: [0.014, 0.055, -0.012],
      groups: [
        // Slide with its sights and serrations (the barrel crown stays).
        { name: 'Slide', nodes: ['P_Slide', 'P_SlideSerrations', 'P_FrontSight', 'P_RearSight', 'P_RearNotch'] },
        { name: 'Trigger', nodes: ['P_Trigger'] },
      ],
    },
    pose: { position: [0.15, -0.165, -0.42], rotation: [0.02, 0.06, -0.02], scale: 1 },
    // Heavier slide: snaps up a little more than PIS-01.
    feel: { rise: 1.1 },
  },
  sounds: {
    fire: 'pis02.shot',
    fireVolume: 0.72,
    dry: 'dryfire',
    equip: 'equip.gun',
    reload: [
      { at: 0.08, sound: 'mag.out' },
      { at: 0.72, sound: 'mag.in' },
    ],
    reloadEnd: 'sr01.chamber',
  },
};

/**
 * M249-type 5.56 light machine gun: 100-round belt, 700 RPM, weak per round (5 body hits, no one-shot
 * head kill) and loose on the move or in the air, steadier crouched. A 5.4 s reload (cover up, box out,
 * new belt in, cover down, charge) and a slow draw: it holds an angle, it does not duel.
 */
export const LMG_01: WeaponDefinition = {
  id: 'lmg01',
  displayName: 'LMG-01',
  category: 'lmg',
  fireMode: 'auto',
  fireRate: 700,
  magazineSize: 100,
  reserveAmmo: 200,
  reloadTime: 5.4,
  equipTime: 1.2,
  damage: { base: 22, headMultiplier: 4, limbMultiplier: 0.8, falloffStart: 35, falloffEnd: 100, falloffMinMultiplier: 0.8, maxRange: 260 },
  spread: { standing: deg(0.35), moving: deg(3.2), airborne: deg(9), crouchMultiplier: 0.55 },
  recoil: {
    pitchPerShot: deg(0.32),
    pitchGrowthPerShot: deg(0.03),
    growthShots: 12,
    maxPitch: deg(4.2),
    // A long belt: the climb levels off, the sideways walk keeps going (an S path every 12 rounds).
    yawJitter: deg(0.14),
    yawDrift: deg(0.32),
    yawDriftAfterShots: 10,
    yawDriftSign: 1,
    yawSwayShots: 12,
    kickResponse: 26,
    recoveryDelay: 0.16,
    recoverySpeed: deg(20),
    yawRecovery: true,
    sprayResetTime: 0.4,
  },
  view: {
    kind: 'gltf',
    // Rigged by tools/rig-weapons.mjs: the source's nodes plus the belt from the pouch to the feed tray (G_Belt).
    url: '/weapons/lmg01_rig.glb',
    fallback: 'ar01',
    fit: {
      rotation: [0, Math.PI / 2, 0],
      // Grip (centre x -0.126 at the bottom, -0.105 at the top, ~14°).
      // Fitted with the clipping check: the glove 8 mm lower and further back on the grip.
      grip: { position: [0, -0.123, 0.123], rotation: [-0.2, 0, 0] },
      // Under the handguard (file x 0.099..0.247, bottom y -0.076).
      support: { position: [0, -0.07, -0.17] },
      hand: { width: 0.036, depth: 0.048, index: 'trigger' },
      muzzle: [0, 0, -0.485],
      // The soft ammo pouch (and its belt) is what comes off and goes on.
      magazine: ['G_AmmoPouch', 'G_PouchFlap', 'G_PouchStrap', 'G_PouchConnector', 'G_Belt'],
      // The support hand takes the pouch by its front face (from underneath it would pass through the pouch
      // on the way back to the handguard; fitted with the clipping check over the reload).
      magazinePivot: [0, -0.09, -0.16],
      // Cases and links leave under the receiver, behind the pouch, just right of the centre line (the M249's side).
      ejectPort: [0.004, -0.074, 0.03],
      groups: [
        // Feed cover hinged at its front (file x 0.072, top y 0.061): swung up on the reload.
        { name: 'FeedCover', nodes: ['G_FeedCover', 'G_CoverLatch'], pivot: [0, 0.061, -0.072] },
        { name: 'ChargingHandle', nodes: ['G_ChargingHandle'] },
        { name: 'Trigger', nodes: ['G_Trigger'] },
        // The file's bipod stands deployed (legs straight down to y -0.317): folded forward under the barrel
        // for carrying, turned 90° on its yoke (file x 0.327, y -0.046), its telescopic legs collapsed to
        // 55 % so the feet stop short of the flash hider (full length they would reach past the muzzle).
        { name: 'Bipod', nodes: ['G_BipodLegs', 'G_BipodFeet'], pivot: [0, -0.046, -0.327], rotation: [Math.PI / 2, 0, 0], scale: [1, 0.55, 1] },
      ],
      armPose: { rightElbow: [0.26, -0.24, 0.42], leftElbow: [-0.34, -0.36, -0.02] },
    },
    pose: { position: [0.18, -0.12, -0.5], rotation: [0.02, 0.12, -0.05], scale: 1 },
  },
  sounds: {
    fire: 'lmg01.shot',
    fireVolume: 0.9,
    dry: 'dryfire',
    equip: 'equip.gun',
    reload: [
      { at: 0.03, sound: 'lmg.cover' },
      { at: 0.12, sound: 'mag.out' },
      { at: 0.8, sound: 'mag.in' },
      { at: 0.83, sound: 'lmg.belt' },
      { at: 0.88, sound: 'lmg.cover' },
    ],
    reloadEnd: 'ar01.charge',
  },
};

/**
 * MG3-type 7.62 general-purpose machine gun (the delivered file is an MG42-family model, root `K_MG42`;
 * the MG3 is its post-war successor): 1,000 RPM on a 120-round belt, 5 body hits (Phase 26-A: 21 a round,
 * was 28), no one-shot head kill, heavier than LMG-01 to move and aim, the slowest reload and draw in the
 * game. Its recoil is the price of the rate of fire (the climb per second is the steepest of all) and was
 * left as it is: held down it kills faster than anything, left alone the burst walks off the target.
 */
export const LMG_02: WeaponDefinition = {
  id: 'lmg02',
  displayName: 'LMG-02',
  category: 'lmg',
  fireMode: 'auto',
  fireRate: 1000,
  magazineSize: 120,
  reserveAmmo: 240,
  reloadTime: 6.0,
  equipTime: 1.4,
  damage: { base: 21, headMultiplier: 3.2, limbMultiplier: 0.8, falloffStart: 45, falloffEnd: 130, falloffMinMultiplier: 0.8, maxRange: 300 },
  spread: { standing: deg(0.45), moving: deg(3.8), airborne: deg(10), crouchMultiplier: 0.5 },
  recoil: {
    pitchPerShot: deg(0.42),
    pitchGrowthPerShot: deg(0.035),
    growthShots: 12,
    maxPitch: deg(5),
    // Fast and heavy: a wider sideways walk than LMG-01, left first, swinging every 10 rounds.
    yawJitter: deg(0.2),
    yawDrift: deg(0.38),
    yawDriftAfterShots: 8,
    yawDriftSign: -1,
    yawSwayShots: 10,
    kickResponse: 26,
    recoveryDelay: 0.16,
    recoverySpeed: deg(18),
    yawRecovery: true,
    sprayResetTime: 0.4,
  },
  view: {
    kind: 'gltf',
    // The delivered file as it is (every part its own node, the belt modelled).
    url: '/weapons/lmg02.glb',
    fallback: 'ar01',
    fit: {
      rotation: [0, Math.PI / 2, 0],
      // Grip (centre x -0.175 at the bottom, -0.158 at the top, ~9°).
      // Fitted with the clipping check: 4 mm up and back on the grip.
      grip: { position: [0, -0.102, 0.17], rotation: [-0.15, 0, 0] },
      // Under the barrel jacket's rear (jacket x 0.02..0.535, bottom y -0.034).
      support: { position: [0, -0.034, -0.11] },
      hand: { width: 0.034, depth: 0.046, index: 'trigger' },
      muzzle: [0, 0, -0.612],
      // The belt hanging on the left is what is changed on a reload; the hand takes it by its middle.
      magazine: ['K_BeltBullets', 'K_BeltCases', 'K_BeltLinks'],
      magazinePivot: [-0.105, -0.06, 0.016],
      // Cases drop out under the receiver.
      ejectPort: [0.004, -0.04, 0.03],
      groups: [
        // Feed cover hinged at its front (file x 0.025, top y 0.072).
        { name: 'FeedCover', nodes: ['K_FeedCover', 'K_FeedCoverRib', 'K_CoverLatch'], pivot: [0, 0.072, -0.025] },
        { name: 'ChargingHandle', nodes: ['K_CockingHandle'] },
        { name: 'Trigger', nodes: ['K_Trigger'] },
        // The file's bipod stands deployed with its feet splayed ±134 mm: folded back under the jacket
        // (as the MG42 / MG3 bipod folds) on its hinge (file x 0.47, y -0.047), legs closed together (sideways
        // and fore-and-aft, where the deployed feet also spread) so they lie along the jacket.
        { name: 'Bipod', nodes: ['K_BipodLegs', 'K_BipodFeet', 'K_BipodSpikes'], pivot: [0, -0.047, -0.47], rotation: [-Math.PI / 2, 0, 0], scale: [0.25, 1, 0.4] },
      ],
      armPose: { rightElbow: [0.26, -0.24, 0.46], leftElbow: [-0.34, -0.36, 0.02] },
    },
    pose: { position: [0.18, -0.12, -0.54], rotation: [0.02, 0.12, -0.05], scale: 1 },
    // 7.62 at 1,000 RPM: each round shoves harder than LMG-01's.
    feel: { kick: 1.12, back: 1.1 },
  },
  sounds: {
    fire: 'lmg02.shot',
    fireVolume: 0.95,
    dry: 'dryfire',
    equip: 'equip.gun',
    reload: [
      { at: 0.03, sound: 'lmg.cover' },
      { at: 0.12, sound: 'mag.out' },
      { at: 0.8, sound: 'mag.in' },
      { at: 0.83, sound: 'lmg.belt' },
      { at: 0.88, sound: 'lmg.cover' },
    ],
    reloadEnd: 'ar01.charge',
  },
};

export const WEAPONS: Record<string, WeaponDefinition> = {
  [AR_01.id]: AR_01,
  [SR_01.id]: SR_01,
  [KARAMBIT.id]: KARAMBIT,
  [SMG_01.id]: SMG_01,
  [SG_01.id]: SG_01,
  [PIS_01.id]: PIS_01,
  [AR_02.id]: AR_02,
  [SMG_02.id]: SMG_02,
  [DMR_01.id]: DMR_01,
  [PIS_02.id]: PIS_02,
  [LMG_01.id]: LMG_01,
  [LMG_02.id]: LMG_02,
};

/** Default loadout; slot index = number key - 1. */
export const DEFAULT_LOADOUT: readonly WeaponDefinition[] = [AR_01, SR_01, KARAMBIT];
