/* =============================================================================
   fighter bodies seen in the world: blocky silhouettes that read instantly at a
   distance, a rotating sigil ring in the character colour, and a nameplate.
   ========================================================================== */
import { settings } from '../core/settings.js';
import { clamp, lerp } from '../core/math.js';

const THREE = window.THREE;
const TEAM_COLOR = { a: 0x4d86d8, b: 0xd86a3a };

function box(w, h, d, color, x, y, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color }));
  m.position.set(x, y, z);
  return m;
}

export function makeBody(fighter, enemy) {
  const c = fighter.char;
  const team = TEAM_COLOR[fighter.team] || 0x8a8a8a;
  const tint = enemy ? 0xd86a3a : 0x4d86d8;
  const g = new THREE.Group();
  const shadows = !!settings.get('shadows');

  const parts = {};
  parts.hips = box(0.52, 0.34, 0.36, c.trim, 0, 0.84, 0);
  parts.torso = box(0.62, 0.66, 0.4, c.color, 0, 1.33, 0);
  parts.chest = box(0.66, 0.16, 0.44, tint, 0, 1.56, 0);
  parts.head = box(0.32, 0.32, 0.32, c.accent, 0, 1.79, 0);
  parts.visor = box(0.24, 0.1, 0.06, 0x141821, 0, 1.79, -0.16);
  parts.legL = box(0.22, 0.78, 0.24, c.trim, -0.16, 0.39, 0);
  parts.legR = box(0.22, 0.78, 0.24, c.trim, 0.16, 0.39, 0);
  parts.armL = box(0.18, 0.62, 0.2, c.color, -0.42, 1.32, 0);
  parts.armR = box(0.18, 0.62, 0.2, c.color, 0.42, 1.32, 0);
  for (const k in parts) {
    parts[k].castShadow = shadows && k !== 'visor';
    g.add(parts[k]);
  }

  // the sigil ring: tells you at a glance which character you are looking at
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.42, 0.045, 6, 18),
    new THREE.MeshBasicMaterial({ color: c.accent, transparent: true, opacity: 0.75 })
  );
  ring.position.set(0, 1.35, 0.3);
  ring.rotation.x = Math.PI / 2;
  g.add(ring);

  const team3 = new THREE.Mesh(
    new THREE.ConeGeometry(0.16, 0.26, 4),
    new THREE.MeshBasicMaterial({ color: team, transparent: true, opacity: 0.9 })
  );
  team3.position.set(0, 2.24, 0);
  team3.rotation.x = Math.PI;
  g.add(team3);

  const plate = makeNameplate(fighter, enemy);
  plate.position.set(0, 2.5, 0);
  g.add(plate);

  g.userData = { parts, ring, marker: team3, plate, walk: 0, deathT: 0, deathVY: 0, flash: 0 };
  return g;
}

function makeNameplate(fighter, enemy) {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 64;
  const tex = new THREE.CanvasTexture(cv);
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(2.0, 0.5, 1);
  sp.userData = { cv, tex, hp: -1, name: '' };
  drawNameplate(sp, fighter, enemy);
  return sp;
}

export function drawNameplate(sprite, fighter, enemy) {
  const u = sprite.userData;
  const hpFrac = clamp(fighter.hp / fighter.maxHp, 0, 1);
  if (u.hp === hpFrac && u.name === fighter.name) return;
  u.hp = hpFrac; u.name = fighter.name;
  const ctx = u.cv.getContext('2d');
  ctx.clearRect(0, 0, 256, 64);
  ctx.font = 'bold 26px "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = 'center';
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(0,0,0,.75)';
  ctx.strokeText(fighter.name, 128, 28);
  ctx.fillStyle = enemy ? '#ffb99c' : '#bcd9ff';
  ctx.fillText(fighter.name, 128, 28);
  ctx.fillStyle = 'rgba(0,0,0,.6)';
  ctx.fillRect(48, 40, 160, 10);
  ctx.fillStyle = enemy ? '#e4633a' : '#4d86d8';
  ctx.fillRect(50, 42, 156 * hpFrac, 6);
  u.tex.needsUpdate = true;
}

/* per frame body update: walk cycle, aim pitch, death fall, damage flash */
export function updateBody(fighter, dt, now, camPos) {
  const g = fighter.mesh;
  if (!g) return;
  const u = g.userData;

  if (!fighter.alive) {
    if (u.deathT > 0) {
      u.deathT = Math.max(0, u.deathT - dt);
      const k = 1 - u.deathT / 1.0;
      g.visible = true;
      g.position.set(fighter.pos.x, fighter.pos.y, fighter.pos.z);
      g.rotation.y = fighter.yaw + Math.PI;
      g.rotation.z = lerp(0, Math.PI * 0.46, Math.min(1, k * 1.5));
      u.plate.visible = false;
      const fade = clamp(u.deathT / 0.4, 0, 1);
      u.ring.material.opacity = 0.75 * fade;
    } else {
      g.visible = false;
    }
    return;
  }

  g.visible = !fighter.isPlayer;
  g.rotation.z = 0;
  u.plate.visible = true;
  u.ring.material.opacity = 0.75;
  g.position.set(fighter.pos.x, fighter.pos.y, fighter.pos.z);
  g.rotation.y = fighter.yaw + Math.PI;

  const sp = Math.hypot(fighter.vel.x, fighter.vel.z);
  u.walk += dt * (2.2 + sp * 1.4);
  const swing = Math.sin(u.walk * 3.1) * clamp(sp / 7, 0, 1) * 0.55;
  u.parts.legL.rotation.x = swing;
  u.parts.legR.rotation.x = -swing;
  u.parts.armL.rotation.x = -swing * 0.7;
  u.parts.armR.rotation.x = swing * 0.7;
  const crouch = (1.8 - fighter.height) * 0.55;
  g.position.y -= crouch * 0.5;
  u.parts.head.position.y = 1.79 - crouch;
  u.parts.torso.position.y = 1.33 - crouch * 0.8;
  u.parts.visor.position.y = 1.79 - crouch;
  u.ring.rotation.z += dt * 1.6;
  u.ring.position.y = 1.35 - crouch * 0.8 + Math.sin(now * 2) * 0.03;

  if (u.flash > 0) {
    u.flash = Math.max(0, u.flash - dt * 5);
    const k = u.flash;
    u.parts.torso.material.emissive?.setRGB(k, k * 0.25, k * 0.18);
    u.parts.head.material.emissive?.setRGB(k, k * 0.25, k * 0.18);
  }

  if (camPos) {
    const d = Math.hypot(camPos.x - fighter.pos.x, camPos.z - fighter.pos.z);
    u.plate.visible = d < 46;
    u.plate.scale.set(clamp(2.0 * (d / 22), 1.4, 5.2), clamp(0.5 * (d / 22), 0.35, 1.3), 1);
  }
}

export function flashBody(fighter, amount = 1) {
  if (fighter.mesh) fighter.mesh.userData.flash = amount;
}
export function startDeathFall(fighter) {
  if (fighter.mesh) { fighter.mesh.userData.deathT = 1.0; fighter.mesh.userData.deathVY = 0; }
}
