/* =============================================================================
   the local player: turns the device-agnostic input state into aim, movement,
   attacks and the camera.  everything it can do, a bot can also do through the
   same ability runtime.
   ========================================================================== */
import { RULES } from './rules.js';
import { stepFighter } from '../combat/physics.js';
import { settings } from '../core/settings.js';
import { clamp, damp, dirFromAngles, lerp } from '../core/math.js';
import { AimAssist } from '../input/aimAssist.js';
import { ViewModel } from '../combat/viewmodel.js';
import { audio } from '../audio/audio.js';

const HALF_PI = Math.PI / 2 - 0.02;

export class PlayerController {
  constructor(game, fighter) {
    this.game = game;
    this.f = fighter;
    this.input = game.input;
    this.assist = new AimAssist(game, fighter);
    this.view = new ViewModel(game, fighter);
    this.bob = 0;
    this.bobAmp = 0;
    this.camPos = { x: 0, y: 0, z: 0 };
    this.camRoll = 0;
    this.thirdPerson = 0;        // 0..1 blend used by domain casts
    this.thirdUntil = 0;
    this.deathCam = 0;
    this.lastSprintSound = 0;
  }

  dispose() { this.view.dispose(); }
  releaseLook() { this.input.clear(); }

  onDeath() {
    this.deathCam = 1;
    this.f.charging = false;
    this.f.ads = false;
    this.view.setVisible(false);
  }

  /* a short third person beat for domain expansions */
  cinematic(duration) {
    this.thirdUntil = this.game.now + duration;
  }

  update(dt, realDt) {
    const g = this.game, f = this.f, input = this.input, now = g.now;

    /* ---------------- look ---------------- */
    let dx = input.lookDX, dy = input.lookDY;
    const assistOn = settings.get('aimAssist') && input.lastDevice === 'touch';
    if (f.alive && assistOn) {
      const adj = this.assist.update(dt, dx, dy, input);
      dx += adj.dx; dy += adj.dy;
    } else {
      this.assist.clear();
    }
    if (f.alive) {
      f.yaw += dx;
      f.pitch = clamp(f.pitch + dy, -HALF_PI, HALF_PI);
      if (f.yaw > Math.PI) f.yaw -= Math.PI * 2;
      if (f.yaw < -Math.PI) f.yaw += Math.PI * 2;
    }
    dirFromAngles(f.yaw, f.pitch, f.aim);

    /* ---------------- movement ---------------- */
    if (f.alive) {
      const busy = now < f.castUntil;
      const mx = busy ? input.moveX * 0.4 : input.moveX;
      const mz = busy ? input.moveZ * 0.4 : input.moveZ;
      const sin = Math.sin(f.yaw), cos = Math.cos(f.yaw);
      const wish = {
        x: -mz * sin + mx * cos,
        z: -mz * cos - mx * sin,
        jump: input.isDown('jump') || input.consume('jump')
      };
      f.crouch = input.isDown('crouch') && f.onGround;
      const wantSprint = settings.get('autoSprint') && input.lastDevice === 'touch'
        ? mz > 0.75 : input.isDown('sprint');
      f.sprint = wantSprint && mz > 0.1 && !f.crouch && !f.ads;

      stepFighter(g.world, f, dt, wish, now, {
        onJump: () => { audio.jump(); this.bobAmp *= 0.4; },
        onLand: (_f, speed) => {
          if (speed > 6) {
            audio.land(clamp(speed / 18, 0, 1));
            g.feel.land(clamp(speed / 20, 0, 1));
          }
        }
      });

      const flat = Math.hypot(f.vel.x, f.vel.z);
      this.bobAmp = damp(this.bobAmp, f.onGround ? clamp(flat / 8, 0, 1) : 0, 8, dt);
      this.bob += dt * (6.5 + flat * 0.75);
      if (f.onGround && flat > 3.6 && now - this.lastSprintSound > (f.sprint ? 0.32 : 0.42)) {
        this.lastSprintSound = now;
        audio.footstep(f.sprint);
      }
    }

    /* ---------------- combat input ---------------- */
    if (f.alive && g.state === 'live') this.handleActions(dt);
    else {
      f.ads = false;
      if (f.charging) g.abilities.cancelCharge(f);
    }

    f.updateEnergy(dt, now, g.domains.energyLocked(f));

    /* ---------------- camera ---------------- */
    this.updateCamera(dt, realDt);
    this.view.update(dt, now);
    this.input.endFrame(realDt);
  }

  handleActions(dt) {
    const g = this.game, f = this.f, input = this.input, A = g.abilities;
    const sec = f.char.secondary;

    // secondary behaves differently per character, but always sits on the same button
    if (sec.kind === 'ads') {
      f.ads = input.isDown('altFire');
    } else if (sec.kind === 'charge') {
      if (input.isDown('altFire')) A.startCharge(f);
      else if (f.charging) A.releaseCharge(f);
    } else if (input.consume('altFire') || (input.isDown('altFire') && A.canCast(f, 'rmb'))) {
      A.tryCast(f, 'rmb');
    }

    if (input.isDown('fire')) A.tryCast(f, 'lmb');
    if (input.consume('dash')) A.tryCast(f, 'q');
    if (input.consume('ability1')) A.tryCast(f, 'a1');
    if (input.consume('ability2')) A.tryCast(f, 'a2');
    if (input.consume('ultimate')) A.tryCast(f, 'ult');
    if (input.consume('refocus')) A.refocus(f);
    void dt;
  }

  /* ---------------------------------------------------------------- camera */
  updateCamera(dt, realDt) {
    const g = this.game, f = this.f, cam = g.engine.camera, now = g.now;

    let eyeX = f.pos.x, eyeY = f.eyeY, eyeZ = f.pos.z;

    if (!f.alive) {
      // rise a little and look at whoever did it
      this.deathCam = Math.min(1, this.deathCam + dt * 1.6);
      eyeY += this.deathCam * 1.5;
      const killer = g.byId.get(f.lastAttackerId);
      if (killer && killer.alive) {
        const wantYaw = Math.atan2(-(killer.pos.x - f.pos.x), -(killer.pos.z - f.pos.z));
        f.yaw = lerp(f.yaw, wantYaw, clamp(dt * 3, 0, 1));
        f.pitch = lerp(f.pitch, -0.15, clamp(dt * 3, 0, 1));
      }
    } else {
      this.deathCam = 0;
    }

    // walk bob and landing dip
    const bobX = Math.cos(this.bob) * 0.035 * this.bobAmp;
    const bobY = Math.abs(Math.sin(this.bob)) * 0.045 * this.bobAmp;
    const feel = g.feel;

    const want3rd = now < this.thirdUntil ? 1 : 0;
    this.thirdPerson = damp(this.thirdPerson, want3rd, want3rd ? 9 : 5, dt);

    const dir = dirFromAngles(f.yaw, f.pitch, { x: 0, y: 0, z: 0 });
    const back = this.thirdPerson * 4.2;
    let cx = eyeX - dir.x * back + bobX;
    let cy = eyeY - dir.y * back + bobY + this.thirdPerson * 0.6 - feel.dip;
    let cz = eyeZ - dir.z * back + bobX * 0.4;
    if (back > 0.05) {
      // never let the third person camera sink into a wall
      const d = g.world.raycast(eyeX, eyeY, eyeZ, -dir.x, -dir.y, -dir.z, back + 0.4);
      if (d < back + 0.4) {
        const safe = Math.max(0, d - 0.35);
        cx = eyeX - dir.x * safe; cy = eyeY - dir.y * safe + 0.2; cz = eyeZ - dir.z * safe;
      }
    }

    cam.position.set(cx + feel.shakeX, cy + feel.shakeY, cz + feel.shakeZ);
    cam.rotation.set(
      f.pitch + feel.kickPitch,
      f.yaw + feel.kickYaw,
      feel.roll + this.camRoll + Math.sin(this.bob * 0.5) * 0.008 * this.bobAmp
    );

    // field of view: sprint pushes out, aiming pulls in
    const base = settings.get('fov');
    const adsMul = f.ads && f.char.secondary.kind === 'ads' ? 1 / f.char.secondary.zoom : 1;
    const sprintAdd = f.sprint && f.onGround ? 4.5 : 0;
    const want = base * adsMul + sprintAdd + feel.fovPunch;
    cam.fov = damp(cam.fov, want, 11, realDt);
    cam.updateProjectionMatrix();

    this.camPos.x = cam.position.x; this.camPos.y = cam.position.y; this.camPos.z = cam.position.z;
    this.view.setVisible(f.alive && this.thirdPerson < 0.25);
  }
}

export { RULES };
