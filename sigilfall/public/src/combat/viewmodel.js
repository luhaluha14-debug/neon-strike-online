/* =============================================================================
   the first person view model: a pair of forearms and the character's sigil,
   built from boxes and driven by sway, bob, recoil and a per-attack animation.
   it hangs off the camera so it always reads at the same size.
   ========================================================================== */
import { clamp, damp, lerp } from '../core/math.js';
import { settings } from '../core/settings.js';

const THREE = window.THREE;

export class ViewModel {
  constructor(game, fighter) {
    this.game = game;
    this.f = fighter;
    this.root = new THREE.Group();
    this.root.frustumCulled = false;
    game.engine.camera.add(this.root);
    if (!game.engine.scene.children.includes(game.engine.camera)) game.engine.scene.add(game.engine.camera);
    this.build();
    this.sway = { x: 0, y: 0 };
    this.punch = 0;
    this.swing = 0;
    this.lastFireShot = 0;
    this.chargeMesh = null;
  }

  build() {
    const c = this.f.char;
    const skin = 0x6b5a4c;
    const mk = (w, h, d, color) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d),
      new THREE.MeshLambertMaterial({ color, emissive: new THREE.Color(color).multiplyScalar(0.22) }));

    this.armR = new THREE.Group();
    const foreR = mk(0.062, 0.062, 0.26, c.color);
    foreR.position.set(0, 0, -0.13);
    const handR = mk(0.072, 0.072, 0.09, skin);
    handR.position.set(0, 0, -0.3);
    this.armR.add(foreR, handR);
    this.armR.position.set(0.17, -0.3, -0.66);
    this.armR.rotation.set(0.12, -0.16, 0);

    this.armL = new THREE.Group();
    const foreL = mk(0.058, 0.058, 0.23, c.color);
    foreL.position.set(0, 0, -0.115);
    const handL = mk(0.068, 0.068, 0.085, skin);
    handL.position.set(0, 0, -0.26);
    this.armL.add(foreL, handL);
    this.armL.position.set(-0.19, -0.33, -0.6);
    this.armL.rotation.set(0.16, 0.2, 0);

    // the sigil floating over the leading hand, in the character's colour
    this.sigil = new THREE.Mesh(
      new THREE.TorusGeometry(0.075, 0.014, 6, 16),
      new THREE.MeshBasicMaterial({ color: c.accent, transparent: true, opacity: 0.9 })
    );
    this.sigil.position.set(0.14, -0.25, -1.02);
    this.core = new THREE.Mesh(
      new THREE.SphereGeometry(0.026, 8, 6),
      new THREE.MeshBasicMaterial({ color: c.accent })
    );
    this.core.position.copy(this.sigil.position);

    this.root.add(this.armR, this.armL, this.sigil, this.core);
    this.root.position.set(0, 0, 0);
  }

  setVisible(v) { this.root.visible = v && settings.get('quality') !== 'off'; }

  /* a short push whenever the character attacks */
  kick(amount = 1) { this.punch = Math.min(1.4, this.punch + amount); }
  swingMelee() { this.swing = 1; }

  update(dt, now) {
    const f = this.f, input = this.game.input;
    // sway lags the look, which reads as weight
    this.sway.x = damp(this.sway.x, clamp(-input.lookDX * 6, -0.1, 0.1), 9, dt);
    this.sway.y = damp(this.sway.y, clamp(-input.lookDY * 6, -0.08, 0.08), 9, dt);

    const ctrl = this.game.controller;
    const bob = ctrl ? ctrl.bobAmp : 0;
    const bx = Math.cos(ctrl ? ctrl.bob : 0) * 0.02 * bob;
    const by = Math.abs(Math.sin(ctrl ? ctrl.bob : 0)) * 0.022 * bob;

    this.punch = damp(this.punch, 0, 12, dt);
    this.swing = damp(this.swing, 0, 9, dt);

    const ads = f.ads && f.char.secondary.kind === 'ads';
    const adsBlend = damp(this.root.userData.ads || 0, ads ? 1 : 0, 12, dt);
    this.root.userData.ads = adsBlend;

    const baseX = lerp(0, -0.24, adsBlend);
    this.root.position.set(
      baseX + this.sway.x + bx,
      -0.02 + this.sway.y + by - this.punch * 0.03,
      lerp(0, 0.06, adsBlend) + this.punch * 0.09
    );
    this.root.rotation.set(
      this.punch * 0.12 + this.swing * -0.5,
      this.sway.x * 0.8 + this.swing * 0.6,
      this.swing * 0.35
    );

    // charging pulls the sigil in and brightens it
    const charge = f.charging ? f.charge : 0;
    const s = 1 + charge * 1.6;
    this.sigil.scale.setScalar(s);
    this.core.scale.setScalar(1 + charge * 2.4);
    this.sigil.rotation.z += dt * (1.2 + charge * 9);
    this.sigil.rotation.x = Math.sin(now * 1.6) * 0.2;
    this.core.material.opacity = 1;

    const energy = f.energy / f.maxEnergy;
    this.sigil.material.opacity = 0.35 + energy * 0.6;
  }

  dispose() {
    this.game.engine.camera.remove(this.root);
    this.root.traverse((o) => {
      o.geometry?.dispose?.();
      o.material?.dispose?.();
    });
  }
}
