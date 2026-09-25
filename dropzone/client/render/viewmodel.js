/* =========================================================================
   First-person view model (arms + weapon), drawn in its own pass so it never
   clips into walls.  Adds bob, sway, recoil kick, ADS alignment, reload and
   weapon-switch motion — the "feel" layer of shooting.
   ========================================================================= */
import * as THREE from 'three';
import { weaponGeometry, MUZZLE } from './models.js';

const ADS_POS = {
  // camera sits on the sight line: rifle frame centre y=0.125, smg ears 0.108, shotgun bead 0.1, pistol notch 0.062
  rifle: [0, -0.125, -0.26], smg: [0, -0.108, -0.2], shotgun: [0, -0.1, -0.24], pistol: [0, -0.062, -0.3], none: [0, -0.2, -0.3]
};
const HIP_POS = [0.16, -0.19, -0.36];

export class ViewModel {
  constructor(aspect) {
    this.scene = new THREE.Scene();
    this.cam = new THREE.PerspectiveCamera(62, aspect, 0.01, 10);
    this.scene.add(new THREE.HemisphereLight(0xdfe8f0, 0x4a4436, 2.2));
    const d = new THREE.DirectionalLight(0xfff1dc, 1.4); d.position.set(0.5, 1, 0.3); this.scene.add(d);
    this.root = new THREE.Group(); this.scene.add(this.root);
    this.gunMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.gun = new THREE.Mesh(new THREE.BufferGeometry(), this.gunMat);
    this.root.add(this.gun);
    const sleeve = new THREE.MeshLambertMaterial({ color: 0x4f5a3c }), glove = new THREE.MeshLambertMaterial({ color: 0x2c2a26 });
    this.armR = new THREE.Group(); this.armL = new THREE.Group();
    const fore = new THREE.BoxGeometry(0.075, 0.075, 0.34).translate(0, 0, 0.17);
    const hand = new THREE.BoxGeometry(0.07, 0.08, 0.09);
    for (const a of [this.armR, this.armL]) {
      a.add(new THREE.Mesh(fore, sleeve));
      const h = new THREE.Mesh(hand, glove); h.position.z = -0.02; a.add(h);
      this.root.add(a);
    }
    this.model = null;
    this.bobT = 0; this.swayX = 0; this.swayY = 0; this.kickZ = 0; this.kickR = 0; this.switchT = 0; this.reloadK = 0;
    this.muzzle = new THREE.Vector3();
    this.flash = null;
  }

  setWeapon(model) {
    if (model === this.model) return;
    this.model = model;
    this.gun.geometry = model && model !== 'none' ? weaponGeometry(model) : new THREE.BufferGeometry();
    this.switchT = 1;
  }
  shot(w) { this.kickZ += w.cat === 'shotgun' ? 0.09 : w.cat === 'pistol' ? 0.035 : 0.028; this.kickR += w.recoil.up * 0.04; }
  sway(dx, dy) { this.swayX = Math.max(-0.05, Math.min(0.05, this.swayX - dx * 0.0006)); this.swayY = Math.max(-0.05, Math.min(0.05, this.swayY + dy * 0.0006)); }

  update(dt, s) {
    // s: {ads, speed, onGround, reloading, sprint, aspect}
    this.cam.aspect = s.aspect; this.cam.updateProjectionMatrix();
    this.bobT += dt * (s.speed > 0.3 && s.onGround ? 4 + s.speed * 1.1 : 0);
    const bobA = Math.min(1, s.speed / 6) * (1 - s.ads * 0.85);
    this.swayX *= Math.exp(-dt * 8); this.swayY *= Math.exp(-dt * 8);
    this.kickZ *= Math.exp(-dt * 16); this.kickR *= Math.exp(-dt * 12);
    this.switchT = Math.max(0, this.switchT - dt * 3.2);
    this.reloadK += ((s.reloading ? 1 : 0) - this.reloadK) * Math.min(1, dt * 10);
    const m = this.model || 'none';
    const nade = m.startsWith('g_');
    const A = nade ? [0.16, -0.14, -0.3] : (ADS_POS[m] || ADS_POS.rifle);
    // throwables: wind back while the throw is held
    const t = nade ? 0 : s.ads;
    const x = HIP_POS[0] + (A[0] - HIP_POS[0]) * t, y = HIP_POS[1] + (A[1] - HIP_POS[1]) * t, z = HIP_POS[2] + (A[2] - HIP_POS[2]) * t;
    const sprint = s.sprint ? 1 : 0;
    this.root.position.set(
      x + Math.sin(this.bobT) * 0.012 * bobA + this.swayX,
      y + Math.abs(Math.cos(this.bobT)) * -0.012 * bobA + this.swayY - this.switchT * 0.25 - this.reloadK * 0.07 - sprint * 0.03,
      z + this.kickZ
    );
    this.root.rotation.set(this.kickR + this.reloadK * -0.5 + sprint * -0.35, sprint * 0.5 + this.swayX * 2, this.reloadK * 0.4 + sprint * 0.2);
    this.gun.visible = m !== 'none';
    if (nade) {
      const wind = s.windUp ? 1 : 0;
      this.windK = (this.windK || 0) + (wind - (this.windK || 0)) * Math.min(1, dt * 12);
      this.root.position.set(0.17 + this.windK * 0.08, -0.16 + this.windK * 0.1, -0.33 + this.windK * 0.18 + this.kickZ * 3);
      this.root.rotation.set(0.2 - this.windK * 0.6, 0, 0);
      this.armR.position.set(0.0, -0.06, 0.08); this.armR.rotation.set(0.5, 0, 0);
      this.armL.position.set(-0.32, -0.05, 0.1); this.armL.rotation.set(0.3, 0, 0);
      return;
    }
    // hands on the gun
    if (m === 'none') {
      this.armR.position.set(0.12, -0.02 - this.kickZ * 2, 0.1 - this.kickZ * 4); this.armR.rotation.set(0.2, 0, 0);
      this.armL.position.set(-0.3, 0.0, 0.14); this.armL.rotation.set(0.2, 0, 0);
    } else {
      this.armR.position.set(0.0, -0.1, 0.07); this.armR.rotation.set(0.35, -0.12, 0);
      if (m === 'pistol') {        // two-handed grip: support hand wraps the firing hand
        this.armL.position.set(-0.035, -0.12 - this.reloadK * 0.1, 0.09); this.armL.rotation.set(0.4, 0.2, 0);
      } else {
        const fz = m === 'smg' ? -0.2 : -0.4;
        this.armL.position.set(-0.05 + this.reloadK * -0.05, -0.03 - this.reloadK * 0.1, fz + this.reloadK * 0.25); this.armL.rotation.set(0.25, 0.35, 0);
      }
    }
  }

  /** muzzle world position given the main camera (for tracers & flashes) */
  muzzleWorld(mainCam, out) {
    const mz = MUZZLE[this.model || 'none'];
    this.root.updateMatrixWorld();
    out.set(mz[0], mz[1], mz[2]).applyMatrix4(this.root.matrixWorld);
    // view-model space -> main camera space -> world
    out.applyMatrix4(mainCam.matrixWorld);
    return out;
  }
}
