import * as THREE from 'three';
import { GRENADE_CONFIG } from '../config';
import { GrenadeSystem, type GrenadeKind, type SmokeCloud } from '../combat/Grenades';

// Temporary procedural visuals for FLASH-01 / SMOKE-01 (no model or texture
// files exist for them yet): a small cylinder body per grenade, a white
// flash sprite when a flash goes off, and a cloud of soft grey sprites per
// smoke. Purely cosmetic; what blocks bot sight is GrenadeSystem.sightBlocked.

const FLASH_POP_LIFE = 0.18;

interface Cloud {
  readonly group: THREE.Group;
  readonly material: THREE.SpriteMaterial;
  readonly puffs: { sprite: THREE.Sprite; offset: THREE.Vector3; size: number }[];
}

/** Draws the grenades and clouds of a GrenadeSystem, frame by frame. */
export class GrenadeEffects {
  readonly group = new THREE.Group();
  private readonly bodies = new Map<number, THREE.Mesh>();
  private readonly clouds = new Map<number, Cloud>();
  private readonly geometry = new THREE.CylinderGeometry(0.035, 0.035, 0.11, 10).rotateX(Math.PI / 2);
  private readonly materials: Record<GrenadeKind, THREE.MeshStandardMaterial> = {
    flash: new THREE.MeshStandardMaterial({ color: 0x6f7780, roughness: 0.45, metalness: 0.5 }),
    smoke: new THREE.MeshStandardMaterial({ color: 0x55604d, roughness: 0.6, metalness: 0.3 }),
  };
  private readonly puffTexture = puffTexture();
  private readonly pop: THREE.Sprite;
  private popAge = Infinity;
  private seed = 1;

  constructor() {
    this.group.name = 'GrenadeEffects';
    this.pop = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.puffTexture, color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: false }),
    );
    this.pop.visible = false;
    this.pop.renderOrder = 5;
    this.group.add(this.pop);
  }

  /** A flash went off here (a brief bright burst in the world). */
  flash(at: THREE.Vector3): void {
    this.pop.position.copy(at);
    this.popAge = 0;
  }

  /** Per frame: follows the system's grenades and clouds. */
  update(dt: number, system: GrenadeSystem | null): void {
    const live = new Set<number>();
    for (const g of system?.grenades ?? []) {
      live.add(g.id);
      let m = this.bodies.get(g.id);
      if (!m) {
        m = new THREE.Mesh(this.geometry, this.materials[g.kind]);
        m.castShadow = false;
        this.bodies.set(g.id, m);
        this.group.add(m);
      }
      m.position.copy(g.position);
      // Tumbles while flying.
      if (!g.resting) m.rotation.set(g.age * 9, g.age * 5, 0);
    }
    for (const [id, m] of this.bodies) {
      if (live.has(id)) continue;
      m.removeFromParent();
      this.bodies.delete(id);
    }

    const clouds = new Set<number>();
    for (const s of system?.smokes ?? []) {
      clouds.add(s.id);
      const c = this.clouds.get(s.id) ?? this.addCloud(s);
      this.drawCloud(c, s);
    }
    for (const [id, c] of this.clouds) {
      if (clouds.has(id)) continue;
      this.removeCloud(c);
      this.clouds.delete(id);
    }

    this.popAge += dt;
    this.pop.visible = this.popAge < FLASH_POP_LIFE;
    if (this.pop.visible) {
      const k = this.popAge / FLASH_POP_LIFE;
      this.pop.scale.setScalar(2 + 6 * k);
      this.pop.material.opacity = 1 - k;
    }
  }

  /** Drops everything drawn (the system was cleared). */
  clear(): void {
    this.update(0, null);
    this.popAge = Infinity;
    this.pop.visible = false;
  }

  /** Smoke puffs drawn right now (diagnostics / tests). */
  get puffCount(): number {
    let n = 0;
    for (const c of this.clouds.values()) n += c.puffs.length;
    return n;
  }

  private addCloud(s: SmokeCloud): Cloud {
    const cfg = GRENADE_CONFIG.smoke;
    const rand = mulberry(this.seed++ * 7919 + s.id);
    const material = new THREE.SpriteMaterial({ map: this.puffTexture, color: 0xb4b8bc, transparent: true, depthWrite: false, opacity: 0.92 });
    const group = new THREE.Group();
    group.position.copy(s.center);
    const puffs: Cloud['puffs'] = [];
    for (let i = 0; i < cfg.puffs; i++) {
      // Spread through a squashed ball, denser near the middle; bottom puffs sit near the floor.
      const u = rand() * Math.PI * 2;
      const v = Math.acos(2 * rand() - 1);
      const r = Math.cbrt(rand()) * 0.72;
      const offset = new THREE.Vector3(Math.sin(v) * Math.cos(u) * r, Math.cos(v) * r * 0.55, Math.sin(v) * Math.sin(u) * r);
      const sprite = new THREE.Sprite(material);
      sprite.renderOrder = 3;
      group.add(sprite);
      puffs.push({ sprite, offset, size: 1.1 + rand() * 0.6 });
    }
    this.group.add(group);
    const c = { group, material, puffs };
    this.clouds.set(s.id, c);
    return c;
  }

  private drawCloud(c: Cloud, s: SmokeCloud): void {
    const cfg = GRENADE_CONFIG.smoke;
    const r = GrenadeSystem.radius(s);
    // Slow drift outward and a gentle rise so it does not look frozen.
    const drift = 1 + s.age * 0.012;
    for (const p of c.puffs) {
      p.sprite.position.copy(p.offset).multiplyScalar(r * drift);
      p.sprite.position.y += s.age * 0.02;
      p.sprite.scale.setScalar(Math.max(r * p.size, 0.01));
    }
    c.material.rotation = s.age * 0.05;
    c.material.opacity = 0.92 * (1 - THREE.MathUtils.smoothstep(s.age, cfg.duration - cfg.fadeOut, cfg.duration));
  }

  private removeCloud(c: Cloud): void {
    c.group.removeFromParent();
    c.material.dispose();
  }
}

/** Soft round puff: opaque middle fading to clear at the edge, a little uneven. */
function puffTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.8, 'rgba(255,255,255,0.25)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
