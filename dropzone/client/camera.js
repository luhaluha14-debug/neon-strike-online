/* =========================================================================
   Camera rig: third person over-the-shoulder (default) and first person.
   Owns the view angles, weapon recoil (kick + recovery), ADS zoom,
   wall collision for the TPS boom, free-look, and camera shake.
   ========================================================================= */
import * as THREE from 'three';
import { clamp, lerp, wrapAngle, DEG } from '../shared/util.js';

export class CameraRig {
  constructor(camera, world) {
    this.cam = camera;
    this.world = world;
    this.mode = 'tps';
    this.yaw = 0; this.pitch = 0;
    this.freeYaw = 0; this.freePitch = 0; this.freeLook = false;
    this.pendP = 0; this.pendY = 0; this.accP = 0; this.accY = 0; this.lastShotT = -1; this.time = 0;
    this.boom = 2.8;
    this.eye = 1.62;
    this.adsT = 0;
    this.shake = 0; this.roll = 0;
    this.baseFov = 80;
    this.pivot = new THREE.Vector3();
    this.fwd = new THREE.Vector3();
    this.right = new THREE.Vector3();
    this.landDip = 0; this.landVel = 0;
    this.boomOverride = null;
  }

  /** mouse / touch look (radians) */
  look(dYaw, dPitch) {
    if (this.freeLook && this.mode === 'tps') {
      this.freeYaw = wrapAngle(this.freeYaw - dYaw);
      this.freePitch = clamp(this.freePitch - dPitch, -1.2, 1.0);
      return;
    }
    this.yaw = wrapAngle(this.yaw - dYaw);
    const np = clamp(this.pitch - dPitch, -1.45, 1.45);
    // pulling down against recoil reduces how much will be auto-recovered
    if (dPitch > 0 && this.accP > 0) this.accP = Math.max(0, this.accP - dPitch);
    this.pitch = np;
  }

  /** a shot by the local player: queue the recoil kick */
  kick(w, stance, adsT) {
    const R = w.recoil;
    const first = this.time - this.lastShotT > 0.28 ? R.first : 1;
    this.lastShotT = this.time;
    const mul = first * (1 + (R.ads - 1) * adsT) * (stance === 'crouch' ? 0.85 : stance === 'prone' ? 0.62 : 1);
    this.pendP += R.up * DEG * mul * (0.88 + Math.random() * 0.24);
    this.pendY += (R.bias + (Math.random() * 2 - 1) * R.side) * DEG * mul;
    this.shake = Math.min(1, this.shake + R.up * 0.08);
  }
  addShake(a) { this.shake = Math.min(1.2, this.shake + a); }
  land(v) { this.landVel -= Math.min(6, v * 0.25); }

  endFreeLook() { this.freeLook = false; }

  /**
   * @param dt
   * @param pos     interpolated feet position {x,y,z}
   * @param eyeH    target eye height for the stance
   * @param ads     0..1 aim blend
   * @param w       weapon definition (zoom, recoil)
   */
  update(dt, pos, eyeH, ads, w, fov) {
    this.time += dt;
    this.baseFov = fov;
    // ---- recoil application (fast) + recovery (slow) ----
    const k = Math.min(1, dt * 28);
    const ap = this.pendP * k, ay = this.pendY * k;
    this.pendP -= ap; this.pendY -= ay;
    this.pitch = clamp(this.pitch + ap, -1.45, 1.45); this.yaw = wrapAngle(this.yaw + ay);
    this.accP += ap; this.accY += ay;
    if (this.time - this.lastShotT > 0.12) {
      const r = Math.min(1, (w ? w.recoil.recover : 6) * dt);
      const rp = this.accP * r, ry = this.accY * r;
      this.pitch -= rp; this.yaw = wrapAngle(this.yaw - ry);
      this.accP -= rp; this.accY -= ry;
    }
    if (!this.freeLook) { this.freeYaw *= Math.exp(-dt * 10); this.freePitch *= Math.exp(-dt * 10); }

    // ---- eye height / landing dip spring ----
    this.eye = lerp(this.eye, eyeH, Math.min(1, dt * 11));
    this.landVel += (-this.landDip * 120 - this.landVel * 16) * dt;
    this.landDip += this.landVel * dt;
    this.adsT = ads;
    this.shake *= Math.exp(-dt * 9);

    const yaw = this.yaw + this.freeYaw, pitch = clamp(this.pitch + this.freePitch, -1.5, 1.5);
    const sy = Math.sin(yaw), cy = Math.cos(yaw), sp = Math.sin(pitch), cp = Math.cos(pitch);
    this.fwd.set(-sy * cp, sp, -cy * cp);
    this.right.set(cy, 0, -sy);
    this.pivot.set(pos.x, pos.y + this.eye + this.landDip * 0.08, pos.z);

    const zoom = w ? 1 + (w.zoom - 1) * ads : 1;
    let camPos;
    if (this.mode === 'fps') {
      camPos = this.pivot.clone();
      this.cam.fov = this.baseFov / zoom;
    } else {
      // over the right shoulder; tighter when aiming
      let side = lerp(0.62, 0.48, ads), up = lerp(0.28, 0.12, ads), back = lerp(2.7, 1.25, ads);
      if (this.boomOverride) ({ side, up, back } = this.boomOverride);   // plane / skydive framing
      const origin = new THREE.Vector3(pos.x, this.pivot.y + up, pos.z);
      const want = origin.clone().addScaledVector(this.right, side).addScaledVector(this.fwd, -back);
      // collide boom against the world
      const dir = want.clone().sub(origin);
      const L = dir.length();
      dir.divideScalar(L);
      const hit = this.world.raycast(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, L + 0.25);
      let dist = L;
      if (hit) dist = Math.max(0.15, hit.t - 0.25);
      this.boom = dist < this.boom ? dist : lerp(this.boom, dist, Math.min(1, dt * 5));
      camPos = origin.addScaledVector(dir, this.boom);
      // never below the terrain
      const g = this.world.groundAt(camPos.x, camPos.z) + 0.2;
      if (camPos.y < g) camPos.y = g;
      this.cam.fov = (this.baseFov * 0.95) / (1 + (zoom - 1) * 0.85);
    }
    // shake
    const s = this.shake * this.shake;
    const t = this.time * 43;
    this.cam.position.copy(camPos);
    this.cam.rotation.order = 'YXZ';
    this.cam.rotation.set(pitch + Math.sin(t) * s * 0.012, yaw + Math.sin(t * 1.3 + 1) * s * 0.012, Math.sin(t * 0.7) * s * 0.02 + this.roll);
    this.cam.updateProjectionMatrix();
    this.cam.updateMatrixWorld();
  }
}
