/* =========================================================================
   Procedural low-poly models: weapons, ground items, soldier characters.
   Every weapon/item is one merged geometry with vertex colours = 1 draw call.
   ========================================================================= */
import * as THREE from 'three';
import { BoxBatch } from './world-view.js';
import { ITEMS } from '../../shared/items.js';

const C = (h) => new THREE.Color(h);
const GUN = C(0x2b2f33), GUN2 = C(0x3d4348), WOOD = C(0x6b4a2c), TAN = C(0x8a7a5c), OLIVE = C(0x4f5a3c), STEEL = C(0x6d747a);

/* weapon geometry in weapon space: barrel toward -Z, grip at origin, units m */
const WEAPON_GEO = {};
export function weaponGeometry(model) {
  if (WEAPON_GEO[model]) return WEAPON_GEO[model];
  const b = new BoxBatch();
  const box = (x0, y0, z0, x1, y1, z1, c) => b.add(x0, y0, z0, x1, y1, z1, c, { ao: false });
  switch (model) {
    case 'rifle':
      box(-0.035, 0.0, -0.32, 0.035, 0.09, 0.18, GUN);          // receiver
      box(-0.02, 0.025, -0.72, 0.02, 0.065, -0.32, STEEL);       // barrel
      box(-0.04, -0.01, -0.58, 0.04, 0.085, -0.32, OLIVE);        // handguard
      box(-0.03, -0.17, -0.18, 0.03, 0.0, -0.08, GUN2);          // magazine
      box(-0.025, -0.13, 0.04, 0.025, 0.0, 0.11, GUN);           // grip
      box(-0.03, -0.02, 0.18, 0.03, 0.08, 0.44, OLIVE);          // stock
      box(-0.022, 0.09, -0.2, 0.022, 0.1, 0.0, GUN);             // top rail
      box(-0.024, 0.1, -0.12, -0.016, 0.15, -0.08, GUN);          // sight frame (open, eye looks through)
      box(0.016, 0.1, -0.12, 0.024, 0.15, -0.08, GUN);
      box(-0.024, 0.145, -0.12, 0.024, 0.153, -0.08, GUN);
      box(-0.005, 0.065, -0.72, 0.005, 0.112, -0.7, GUN);         // front post
      break;
    case 'smg':
      box(-0.035, 0.0, -0.22, 0.035, 0.085, 0.12, GUN2);
      box(-0.018, 0.028, -0.42, 0.018, 0.06, -0.22, STEEL);
      box(-0.025, -0.2, -0.12, 0.025, 0.0, -0.05, GUN);
      box(-0.025, -0.12, 0.03, 0.025, 0.0, 0.1, GUN);
      box(-0.015, 0.0, 0.12, 0.015, 0.05, 0.36, STEEL);
      box(-0.02, 0.085, -0.02, -0.01, 0.125, 0.0, GUN);          // rear sight ears
      box(0.01, 0.085, -0.02, 0.02, 0.125, 0.0, GUN);
      box(-0.004, 0.06, -0.41, 0.004, 0.105, -0.395, GUN);        // front post
      break;
    case 'shotgun':
      box(-0.035, 0.0, -0.2, 0.035, 0.09, 0.14, GUN);
      box(-0.025, 0.04, -0.78, 0.025, 0.09, -0.2, STEEL);
      box(-0.03, -0.02, -0.62, 0.03, 0.035, -0.36, WOOD);        // pump
      box(-0.025, -0.12, 0.04, 0.025, 0.0, 0.1, WOOD);
      box(-0.035, -0.03, 0.14, 0.035, 0.08, 0.46, WOOD);
      box(-0.006, 0.09, -0.77, 0.006, 0.102, -0.755, C(0xd0b060)); // bead
      break;
    case 'pistol':
      box(-0.02, 0.0, -0.17, 0.02, 0.05, 0.03, GUN2);
      box(-0.018, -0.12, -0.02, 0.018, 0.0, 0.04, GUN);
      box(-0.012, 0.05, 0.01, -0.004, 0.068, 0.025, GUN);          // rear notch
      box(0.004, 0.05, 0.01, 0.012, 0.068, 0.025, GUN);
      box(-0.003, 0.05, -0.165, 0.003, 0.064, -0.155, GUN);       // front post
      break;
    default:
      box(-0.01, -0.01, -0.01, 0.01, 0.01, 0.01, GUN);
  }
  const g = b.build();
  WEAPON_GEO[model] = g;
  return g;
}

/** muzzle offset in weapon space */
export const MUZZLE = { rifle: [0, 0.045, -0.74], smg: [0, 0.044, -0.44], shotgun: [0, 0.065, -0.8], pistol: [0, 0.03, -0.18], none: [0, 0, -0.3] };

/* ---------- ground items ---------- */
const ITEM_GEO = {};
export function itemGeometry(key) {
  if (ITEM_GEO[key]) return ITEM_GEO[key];
  const it = ITEMS[key];
  let g;
  if (it.kind === 'weapon') {
    const src = weaponGeometry({ kestrel: 'rifle', wasp: 'smg', breaker: 'shotgun', hornet: 'pistol' }[key] || 'rifle');
    g = src.clone();
    g.rotateZ(Math.PI / 2); g.translate(0, 0.04, 0);
  } else {
    const b = new BoxBatch();
    const col = new THREE.Color(it.color);
    if (it.kind === 'ammo') {
      b.add(-0.13, 0, -0.09, 0.13, 0.12, 0.09, C(0x4b5a3a), { ao: false });
      b.add(-0.1, 0.12, -0.06, 0.1, 0.14, 0.06, col, { ao: false });
    } else if (key === 'medkit') {
      b.add(-0.2, 0, -0.14, 0.2, 0.14, 0.14, C(0xd8d4cc), { ao: false });
      b.add(-0.04, 0.14, -0.1, 0.04, 0.15, 0.1, C(0xc83a32), { ao: false });
      b.add(-0.1, 0.14, -0.035, 0.1, 0.15, 0.035, C(0xc83a32), { ao: false });
    } else {
      b.add(-0.08, 0, -0.08, 0.08, 0.09, 0.08, col, { ao: false });
      b.add(-0.05, 0.09, -0.05, 0.05, 0.1, 0.05, C(0xb33), { ao: false });
    }
    g = b.build();
  }
  ITEM_GEO[key] = g;
  return g;
}

/* ---------- soldier ---------- */
/* one shared vertex-coloured material for every soldier / gun: parts are merged
   per limb, so a detailed soldier is 12 draw calls and a distant one is 1 */
export const SOLDIER_MAT = new THREE.MeshLambertMaterial({ vertexColors: true });
const partCache = new Map();
/** boxes: [w,h,d, cx,cy,cz, colourHex] -> merged geometry (cached per skin) */
function part(key, boxes) {
  if (partCache.has(key)) return partCache.get(key);
  const b = new BoxBatch();
  const col = new THREE.Color();
  for (const [w, h, d, x, y, z, c] of boxes) { col.setHex(c); b.add(x - w / 2, y - h / 2, z - d / 2, x + w / 2, y + h / 2, z + d / 2, col, { ao: false }); }
  const g = b.build();
  partCache.set(key, g);
  return g;
}
function palette(skin) {
  const c = new THREE.Color(skin);
  return {
    uni: skin, dark: c.clone().multiplyScalar(0.7).getHex(), vest: c.clone().multiplyScalar(0.82).offsetHSL(0, -0.05, 0).getHex(),
    skin: 0xc9a27e, boot: 0x2a2622, helm: 0x3b4133
  };
}
function soldierParts(skin) {
  const P = palette(skin), k = skin.toString(16);
  return {
    hips: part('hips' + k, [[0.34, 0.16, 0.2, 0, 0, 0, P.dark]]),
    torso: part('torso' + k, [[0.4, 0.5, 0.22, 0, 0.27, 0, P.uni], [0.44, 0.34, 0.27, 0, 0.3, 0, P.vest], [0.28, 0.2, 0.08, 0, 0.25, 0.16, P.dark]]),
    head: part('head' + k, [[0.07, 0.07, 0.07, 0, 0.03, 0, P.skin], [0.2, 0.22, 0.22, 0, 0.14, 0, P.skin], [0.25, 0.14, 0.26, 0, 0.24, 0, P.helm]]),
    upper: part('upper' + k, [[0.11, 0.3, 0.12, 0, -0.15, 0, P.uni]]),
    fore: part('fore' + k, [[0.1, 0.28, 0.1, 0, -0.14, 0, P.uni], [0.08, 0.09, 0.09, 0, -0.3, 0, P.skin]]),
    thigh: part('thigh' + k, [[0.15, 0.44, 0.17, 0, -0.22, 0, P.dark]]),
    shin: part('shin' + k, [[0.13, 0.42, 0.15, 0, -0.21, 0, P.dark], [0.14, 0.1, 0.24, 0, -0.43, -0.04, P.boot]]),
    // single-mesh standing silhouette for distant LOD (arms forward holding a gun)
    lod: part('lod' + k, [
      [0.15, 0.86, 0.17, 0.1, 0.45, 0, P.dark], [0.15, 0.86, 0.17, -0.1, 0.45, 0, P.dark], [0.34, 0.16, 0.2, 0, 0.92, 0, P.dark],
      [0.44, 0.56, 0.27, 0, 1.25, 0, P.vest], [0.2, 0.22, 0.22, 0, 1.68, 0, P.skin], [0.25, 0.14, 0.26, 0, 1.78, 0, P.helm],
      [0.1, 0.1, 0.5, 0.2, 1.35, -0.25, P.uni], [0.1, 0.1, 0.5, -0.12, 1.35, -0.3, P.uni], [0.06, 0.09, 0.7, 0.12, 1.37, -0.45, 0x2b2f33]
    ])
  };
}

/**
 * articulated soldier.  root at feet, faces -Z.
 * parts: hips (pivot at pelvis) -> torso (pivot waist) -> head, arms
 *        legs: thighs (pivot hip) -> shins (pivot knee)
 */
export class Soldier {
  constructor(skin, shadows) {
    const root = new THREE.Group();
    this.root = root;
    const G = soldierParts(skin);
    const mk = (geo, parent, x = 0, y = 0, z = 0) => {
      const o = new THREE.Mesh(geo, SOLDIER_MAT); o.position.set(x, y, z);
      o.castShadow = shadows; parent.add(o); return o;
    };
    this.body = new THREE.Group(); root.add(this.body);           // rotated for prone
    this.hips = new THREE.Group(); this.hips.position.y = 0.92; this.body.add(this.hips);
    mk(G.hips, this.hips);
    this.torso = new THREE.Group(); this.torso.position.y = 0.06; this.hips.add(this.torso);
    mk(G.torso, this.torso);
    this.head = new THREE.Group(); this.head.position.y = 0.58; this.torso.add(this.head);
    mk(G.head, this.head);
    const arm = (side) => {
      const sh = new THREE.Group(); sh.position.set(0.25 * side, 0.46, 0); this.torso.add(sh);
      mk(G.upper, sh);
      const el = new THREE.Group(); el.position.y = -0.3; sh.add(el);
      mk(G.fore, el);
      return { sh, el };
    };
    this.armR = arm(1); this.armL = arm(-1);
    const leg = (side) => {
      const th = new THREE.Group(); th.position.set(0.1 * side, -0.02, 0); this.hips.add(th);
      mk(G.thigh, th);
      const kn = new THREE.Group(); kn.position.y = -0.44; th.add(kn);
      mk(G.shin, kn);
      return { th, kn };
    };
    this.legR = leg(1); this.legL = leg(-1);
    // weapon holder in torso space
    this.gunPivot = new THREE.Group(); this.gunPivot.position.set(0.14, 0.34, -0.3); this.torso.add(this.gunPivot);
    this.gun = null; this.gunModel = null;
    this.gunMat = SOLDIER_MAT;
    // distant LOD
    this.lod = new THREE.Mesh(G.lod, SOLDIER_MAT);
    this.lod.visible = false;
    root.add(this.lod);
    this.lodOn = false;
    this.phase = 0;
    this.deadT = 0;
    this.pronePose = 0;
  }

  /** swap between the articulated rig and the 1-draw-call silhouette */
  setLod(on) {
    if (on === this.lodOn) return;
    this.lodOn = on;
    this.body.visible = !on;
    this.lod.visible = on;
  }

  setWeapon(model) {
    if (this.gunModel === model) return;
    this.gunModel = model;
    if (this.gun) { this.gunPivot.remove(this.gun); this.gun = null; }
    if (model && model !== 'none') {
      this.gun = new THREE.Mesh(weaponGeometry(model), this.gunMat);
      this.gun.castShadow = true;
      this.gunPivot.add(this.gun);
    }
  }

  /**
   * @param s  {speed, fwdSpeed, sideSpeed, stance, pitch, onGround, alive, dt, ads, reloading, firingKick, crouchT}
   */
  animate(s) {
    const dt = s.dt;
    if (this.lodOn) {
      const down = !s.alive || s.stance === 'prone';
      this.lod.rotation.x = down ? -Math.PI / 2 + 0.08 : 0;
      this.lod.position.set(0, down ? 0.2 : 0, down ? 0.75 : 0);
      this.lod.scale.y = !down && s.stance === 'crouch' ? 0.68 : 1;
      return;
    }
    const lerp = (a, b, t) => a + (b - a) * Math.min(1, t);
    // stance blend
    const tProne = s.stance === 'prone' ? 1 : 0, tCrouch = s.stance === 'crouch' ? 1 : 0;
    this.pronePose = lerp(this.pronePose, tProne, dt * 6);
    this.crouchPose = lerp(this.crouchPose || 0, tCrouch, dt * 10);
    if (!s.alive) {
      this.deadT += dt;
      const t = Math.min(1, this.deadT * 2.4);
      this.body.rotation.x = lerp(0, -Math.PI / 2, t * t);
      this.body.position.y = 0.12 * t;
      this.body.position.z = 0.9 * t * t;
      this.armR.sh.rotation.x = 0.4; this.armL.sh.rotation.x = 0.3;
      return;
    }
    this.deadT = 0;
    const moving = s.speed > 0.3;
    const stride = s.stance === 'prone' ? 5 : s.speed > 6 ? 9.5 : 7.8;
    this.phase += dt * (moving ? stride * Math.min(1.6, s.speed / 4.5 + 0.3) : 0);
    const sw = moving ? Math.sin(this.phase) : 0, amp = Math.min(1, s.speed / 5) * (s.stance === 'crouch' ? 0.55 : 0.8);
    // prone: rotate whole body flat, hips at ~0.2
    const P = this.pronePose, K = this.crouchPose;
    this.body.rotation.x = -P * (Math.PI / 2 - 0.08);
    this.body.position.y = P * 0.2;
    this.body.position.z = P * 0.72;
    this.hips.position.y = 0.92 - K * 0.38 - P * 0.72 + (moving && !P ? Math.abs(sw) * 0.03 : 0);
    // legs
    const crouchKnee = K * -1.6, crouchThigh = K * 1.0;
    this.legR.th.rotation.x = crouchThigh + sw * amp * 0.8;
    this.legL.th.rotation.x = crouchThigh - sw * amp * 0.8;
    this.legR.kn.rotation.x = crouchKnee - Math.max(0, -sw) * amp * 1.1 - P * 0.1;
    this.legL.kn.rotation.x = crouchKnee - Math.max(0, sw) * amp * 1.1 - P * 0.1;
    if (P > 0.5) { this.legR.th.rotation.x = sw * 0.25; this.legL.th.rotation.x = -sw * 0.25; this.legR.th.rotation.z = -0.12; this.legL.th.rotation.z = 0.12; }
    else { this.legR.th.rotation.z = 0; this.legL.th.rotation.z = 0; }
    if (!s.onGround && !P) { this.legR.th.rotation.x = 0.6; this.legL.th.rotation.x = -0.2; this.legR.kn.rotation.x = -0.9; this.legL.kn.rotation.x = -0.5; }
    // upper body aims with pitch (split between torso and arms)
    const pitch = s.pitch * (1 - P * 0.6);
    this.torso.rotation.x = pitch * 0.45 + K * 0.12 + (s.sprint ? -0.18 : 0) + P * (Math.PI / 2 - 0.2) * 0;
    if (P) this.torso.rotation.x += P * 0.1;
    this.head.rotation.x = pitch * 0.35 - P * 1.1;
    // arms hold the weapon forward.  +X rotation swings a hanging limb forward,
    // -Z swings the right arm inward, +Z the left arm inward (Euler XYZ)
    const lower = s.sprint ? 0.75 : 0;
    const kick = s.kick || 0;
    this.armR.sh.rotation.set(1.3 + pitch * 0.55 - lower - kick * 0.25, 0, -0.28);
    this.armR.el.rotation.set(0.25 + lower * 0.4, 0, 0);
    this.armL.sh.rotation.set(1.42 + pitch * 0.55 - lower - kick * 0.25, 0, 0.62);
    this.armL.el.rotation.set(0.1, 0, 0);
    if (s.reloading) { this.armL.sh.rotation.x -= 0.5 + Math.sin(performance.now() * 0.012) * 0.12; this.armL.el.rotation.x += 0.7; }
    if (!this.gun) { // fists: boxing guard, punches extend the right arm
      this.armR.sh.rotation.set(0.9 + kick * 0.7, 0, -0.15); this.armL.sh.rotation.set(0.9, 0, 0.15);
      this.armR.el.rotation.x = 1.5 - kick * 1.3; this.armL.el.rotation.x = 1.6;
    }
    this.gunPivot.rotation.x = pitch * 0.55 - lower * 0.8 + kick * 0.15;
    this.gunPivot.position.z = -0.3 + kick * 0.05;
  }
}
