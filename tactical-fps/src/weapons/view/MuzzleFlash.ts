import * as THREE from 'three';
import type { WeaponCategory } from '../WeaponDefinition';

// First-person muzzle flash: a short burst at the muzzle made of a front
// star (the bright core seen down the barrel), flame prongs along the barrel
// (a rifle's flash hider splits its flame into tongues; the shotgun's is
// wide; the sniper rifle's brake also throws side jets) and, from medium
// detail up, a wisp of smoke that drifts off after the shot. Each weapon
// its own size and length, a little different every shot. One instance in
// the view-model scene, all of it reused shot after shot (no allocation).

export interface FlashProfile {
  /** Front star size (m). */
  core: number;
  /** Flame prongs along the barrel: length and width (m). */
  prongLength: number;
  prongWidth: number;
  /** Seconds the flash lasts. */
  life: number;
  /** Side jets from a muzzle brake (length, m; 0 = none). */
  sideJets: number;
  /** Smoke wisp size (m). */
  smoke: number;
}

/** Per kind of weapon: AR short and sharp, SMG small and quick, pistol a brief pop, shotgun wide and heavy, sniper big with brake jets. */
export const FLASH: Record<Exclude<WeaponCategory, 'melee'>, FlashProfile> = {
  rifle: { core: 0.17, prongLength: 0.15, prongWidth: 0.055, life: 0.045, sideJets: 0, smoke: 0.09 },
  smg: { core: 0.12, prongLength: 0.095, prongWidth: 0.04, life: 0.034, sideJets: 0, smoke: 0.06 },
  pistol: { core: 0.11, prongLength: 0.07, prongWidth: 0.04, life: 0.04, sideJets: 0, smoke: 0.06 },
  shotgun: { core: 0.27, prongLength: 0.2, prongWidth: 0.11, life: 0.06, sideJets: 0, smoke: 0.15 },
  sniper: { core: 0.26, prongLength: 0.24, prongWidth: 0.07, life: 0.06, sideJets: 0.12, smoke: 0.14 },
};

/** Effects detail: low = flash only (no smoke). */
export type FlashDetail = 'low' | 'medium' | 'high';

const SMOKE_LIFE = 0.45;

export class MuzzleFlash {
  readonly object = new THREE.Group();
  private readonly core: THREE.Mesh;
  private readonly prongs: THREE.Mesh[];
  private readonly jets: THREE.Mesh[];
  private readonly smoke: THREE.Mesh;
  private readonly flameMat: THREE.MeshBasicMaterial;
  private readonly coreMat: THREE.MeshBasicMaterial;
  private readonly smokeMat: THREE.MeshBasicMaterial;
  private age = Infinity;
  private life = 0.05;
  private smokeAge = Infinity;
  private smokeSize = 0.1;
  detail: FlashDetail = 'high';

  constructor() {
    this.object.name = 'MuzzleFlash';
    const additive = (map: THREE.Texture, color: number) =>
      new THREE.MeshBasicMaterial({ map, color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
    this.coreMat = additive(starTexture(), 0xffe2b0);
    this.flameMat = additive(prongTexture(), 0xffc27a);
    this.smokeMat = new THREE.MeshBasicMaterial({ map: smokeTexture(), color: 0x9d9a94, transparent: true, depthWrite: false, opacity: 0 });

    // Front star facing the eye (the view-model camera looks down -Z).
    this.core = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.coreMat);
    // Prongs: quads with their base at the muzzle reaching forward (-Z), crossed at 90°.
    const prong = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0).rotateX(-Math.PI / 2);
    this.prongs = [0, Math.PI / 2].map((roll) => {
      const m = new THREE.Mesh(prong, this.flameMat);
      m.rotation.z = roll;
      return m;
    });
    // Brake jets: out to both sides, slightly forward.
    const jet = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0).rotateZ(-Math.PI / 2);
    this.jets = [1, -1].map((side) => {
      const m = new THREE.Mesh(jet, this.flameMat);
      m.scale.x = side;
      m.rotation.y = side * 0.25;
      return m;
    });
    this.smoke = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.smokeMat);
    for (const m of [this.core, ...this.prongs, ...this.jets, this.smoke]) {
      m.visible = false;
      m.frustumCulled = false;
      m.renderOrder = 10;
      this.object.add(m);
    }
  }

  /** A round fired: 0..1 brightness right now (for the flash light). */
  get brightness(): number {
    return this.age < this.life ? 1 - this.age / this.life : 0;
  }

  /** Is anything of the flash showing (tests). */
  get showing(): { flash: boolean; smoke: boolean; jets: boolean } {
    return { flash: this.core.visible, smoke: this.smoke.visible, jets: this.jets[0].visible };
  }

  fire(p: FlashProfile, rand: () => number = Math.random): void {
    this.age = 0;
    this.life = p.life * (0.85 + rand() * 0.3);
    const k = 0.85 + rand() * 0.35;
    this.core.scale.set(p.core * k, p.core * k, 1);
    this.core.rotation.z = rand() * Math.PI;
    const len = p.prongLength * (0.8 + rand() * 0.45);
    const roll = rand() * Math.PI;
    for (const m of this.prongs) {
      m.scale.set(p.prongWidth * k, len, 1);
      m.rotation.y = 0;
    }
    this.prongs[0].rotation.z = roll;
    this.prongs[1].rotation.z = roll + Math.PI / 2;
    for (const m of this.jets) m.scale.set(p.sideJets * k * Math.sign(m.scale.x || 1), p.sideJets * 0.35 * k, 1);
    this.jets.forEach((m) => (m.userData.on = p.sideJets > 0));
    if (this.detail !== 'low' && p.smoke > 0) {
      this.smokeAge = 0;
      this.smokeSize = p.smoke * (0.8 + rand() * 0.4);
    }
  }

  update(dt: number): void {
    this.age += dt;
    const b = this.brightness;
    const on = b > 0;
    this.core.visible = on;
    for (const m of this.prongs) m.visible = on;
    for (const m of this.jets) m.visible = on && m.userData.on === true;
    // Bright at once, fading over its short life.
    this.coreMat.opacity = Math.min(1, b * 1.6);
    this.flameMat.opacity = Math.min(1, b * 1.4);

    this.smokeAge += dt;
    const s = this.smokeAge / SMOKE_LIFE;
    this.smoke.visible = s < 1 && this.detail !== 'low';
    if (this.smoke.visible) {
      // A thin grey wisp: grows and drifts up and forward, gone in under half a second.
      const grow = this.smokeSize * (1 + s * 2.2);
      this.smoke.scale.set(grow, grow, 1);
      this.smoke.position.set(0, s * 0.05, -0.03 - s * 0.06);
      this.smokeMat.opacity = 0.32 * Math.sin(Math.min(1, s * 1.15) * Math.PI) * (1 - s);
    }
  }

  reset(): void {
    this.age = this.smokeAge = Infinity;
    this.update(0);
  }
}

function tex(draw: (g: CanvasRenderingContext2D, w: number, h: number) => void, w: number, h: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** White-hot centre, short uneven spikes. */
function starTexture(): THREE.CanvasTexture {
  return tex((g, w) => {
    const c = w / 2;
    const glow = g.createRadialGradient(c, c, 0, c, c, c);
    glow.addColorStop(0, 'rgba(255,255,245,1)');
    glow.addColorStop(0.18, 'rgba(255,236,190,0.95)');
    glow.addColorStop(0.5, 'rgba(255,170,80,0.45)');
    glow.addColorStop(1, 'rgba(255,120,40,0)');
    g.fillStyle = glow;
    g.beginPath();
    const n = 14;
    for (let i = 0; i < n * 2; i++) {
      const r = i % 2 === 0 ? c * (0.55 + ((i * 37) % 11) / 22) : c * 0.2;
      const a = (i / (n * 2)) * Math.PI * 2;
      g.lineTo(c + Math.cos(a) * r, c + Math.sin(a) * r);
    }
    g.closePath();
    g.fill();
  }, 128, 128);
}

/** Three flame tongues (a flash hider splits the flame), hot at the base (bottom). */
function prongTexture(): THREE.CanvasTexture {
  return tex((g, w, h) => {
    const grad = g.createLinearGradient(0, h, 0, 0);
    grad.addColorStop(0, 'rgba(255,250,230,1)');
    grad.addColorStop(0.35, 'rgba(255,200,110,0.85)');
    grad.addColorStop(1, 'rgba(255,110,30,0)');
    g.fillStyle = grad;
    const tongue = (cx: number, top: number, half: number) => {
      g.beginPath();
      g.moveTo(cx - half, h);
      g.quadraticCurveTo(cx - half * 0.7, h * (0.25 + top), cx, h * top);
      g.quadraticCurveTo(cx + half * 0.7, h * (0.25 + top), cx + half, h);
      g.closePath();
      g.fill();
    };
    tongue(w * 0.5, 0, w * 0.26);
    tongue(w * 0.25, 0.3, w * 0.17);
    tongue(w * 0.75, 0.3, w * 0.17);
  }, 64, 128);
}

function smokeTexture(): THREE.CanvasTexture {
  return tex((g, w) => {
    const c = w / 2;
    for (let i = 0; i < 7; i++) {
      const x = c + Math.cos(i * 2.4) * c * 0.28;
      const y = c + Math.sin(i * 1.7) * c * 0.22;
      const r = c * (0.45 + (i % 3) * 0.12);
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, 'rgba(255,255,255,0.35)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, w, w);
    }
  }, 64, 64);
}
