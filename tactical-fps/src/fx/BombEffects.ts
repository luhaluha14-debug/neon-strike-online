import * as THREE from 'three';
import { BOMB_CONFIG } from '../config';
import type { BombObjective } from '../game/BombObjective';

// Temporary procedural C4 visuals (no model file exists for it yet): a small
// charge (block, keypad, wires) on the ground when dropped or planted, with
// a red light that blinks faster as the timer runs out, and an explosion
// burst. Purely cosmetic.

const EXPLOSION_LIFE = 0.9;

export class BombEffects {
  readonly group = new THREE.Group();
  private readonly charge = new THREE.Group();
  private readonly led: THREE.Mesh;
  private readonly ledMaterial = new THREE.MeshBasicMaterial({ color: 0xff2a1a, toneMapped: false });
  private readonly burst: THREE.Sprite;
  private burstAge = Infinity;
  private blink = 0;

  constructor() {
    this.group.name = 'BombEffects';
    const block = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.1, 0.2), new THREE.MeshStandardMaterial({ color: 0x8a7f62, roughness: 0.8 }));
    block.position.y = 0.05;
    const pad = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.02, 0.09), new THREE.MeshStandardMaterial({ color: 0x22262a, roughness: 0.5 }));
    pad.position.set(-0.06, 0.11, 0);
    const wires = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.025, 0.03), new THREE.MeshStandardMaterial({ color: 0xb03020, roughness: 0.6 }));
    wires.position.set(0, 0.105, 0.07);
    this.led = new THREE.Mesh(new THREE.SphereGeometry(0.014, 8, 6), this.ledMaterial);
    this.led.position.set(0.08, 0.115, -0.03);
    this.charge.add(block, pad, wires, this.led);
    this.charge.visible = false;
    this.burst = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: burstTexture(), color: 0xffc27a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: false }),
    );
    this.burst.visible = false;
    this.burst.renderOrder = 5;
    this.group.add(this.charge, this.burst);
  }

  /** The bomb went off at `at`. */
  explode(at: THREE.Vector3): void {
    this.burst.position.copy(at).setY(at.y + 1);
    this.burstAge = 0;
  }

  /**
   * Per frame. Returns true when the planted bomb's light just blinked on
   * (the caller plays the beep).
   */
  update(dt: number, bomb: BombObjective | null): boolean {
    let beep = false;
    const shown = !!bomb && (bomb.state === 'dropped' || bomb.state === 'planted' || bomb.state === 'defused');
    this.charge.visible = shown;
    if (bomb && shown) {
      this.charge.position.copy(bomb.position);
      if (bomb.state === 'planted') {
        // One blink per interval, the interval shrinking from 1 s to 0.15 s as the timer runs out.
        const interval = 0.15 + 0.85 * (bomb.timeLeft / BOMB_CONFIG.timer);
        this.blink += dt;
        if (this.blink >= interval) {
          this.blink = 0;
          beep = true;
        }
        this.led.visible = this.blink < 0.08;
        this.ledMaterial.color.setHex(0xff2a1a);
      } else {
        this.blink = 0;
        this.led.visible = bomb.state === 'dropped';
        this.ledMaterial.color.setHex(bomb.state === 'defused' ? 0x30ff60 : 0xff9a1a);
        if (bomb.state === 'defused') this.led.visible = true;
      }
    }
    this.burstAge += dt;
    this.burst.visible = this.burstAge < EXPLOSION_LIFE;
    if (this.burst.visible) {
      const k = this.burstAge / EXPLOSION_LIFE;
      this.burst.scale.setScalar(4 + 22 * Math.sqrt(k));
      this.burst.material.opacity = (1 - k) ** 1.5;
    }
    return beep;
  }

  clear(): void {
    this.charge.visible = false;
    this.burstAge = Infinity;
    this.burst.visible = false;
    this.blink = 0;
  }
}

function burstTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,240,1)');
  g.addColorStop(0.25, 'rgba(255,210,140,0.9)');
  g.addColorStop(0.6, 'rgba(200,90,30,0.4)');
  g.addColorStop(1, 'rgba(60,30,10,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
