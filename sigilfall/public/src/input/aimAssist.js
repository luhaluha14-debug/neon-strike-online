/* =============================================================================
   mobile aim assist.

   it is a correction, never an autopilot.  the rules, in order:
     1. only enemies that are alive and attackable count
     2. they must be inside a cone around the crosshair (setting: aimAssistFov)
     3. they must be visible - nothing behind a wall is ever chosen
     4. among those, the one nearest the crosshair wins, with distance as a
        tie breaker, so the closest threat is favoured
     5. while the player is actively swiping, their aim wins and the assist
        backs off to a light friction
     6. the pull is capped per second, so it can follow a target but can never
        snap onto one
   the target is dropped the moment it dies, hides or leaves the cone, and the
   next one is picked on the following frame.
   ========================================================================== */
import { clamp, angleDelta } from '../core/math.js';
import { settings } from '../core/settings.js';

const MAX_RANGE = 62;

export class AimAssist {
  constructor(game, fighter) {
    this.game = game;
    this.f = fighter;
    this.target = null;
    this.holdUntil = 0;
    this.lockT = 0;
  }

  clear() { this.target = null; this.lockT = 0; }

  strength() { return clamp(settings.get('aimAssistStrength'), 0, 1); }

  /* is this fighter a legal target right now? */
  valid(o) {
    const g = this.game;
    if (!o || !o.alive || !g.isEnemy(this.f, o)) return false;
    if (g.now - o.spawnAt < 0.25) return false;                  // just spawned, still settling
    return g.canSee(this.f, o.pos.x, o.centerY, o.pos.z);
  }

  /* the angle between the crosshair and a point, in radians */
  offAngle(x, y, z) {
    const f = this.f;
    const dx = x - f.pos.x, dy = y - f.eyeY, dz = z - f.pos.z;
    const d = Math.hypot(dx, dy, dz) || 1;
    const dot = (dx * f.aim.x + dy * f.aim.y + dz * f.aim.z) / d;
    return Math.acos(clamp(dot, -1, 1));
  }

  pick(fovRad) {
    const g = this.game;
    let best = null, bestScore = -1e9;
    for (const o of g.fighters) {
      if (!this.valid(o)) continue;
      const dist = Math.hypot(o.pos.x - this.f.pos.x, o.pos.z - this.f.pos.z);
      if (dist > MAX_RANGE) continue;
      const off = this.offAngle(o.pos.x, o.centerY, o.pos.z);
      if (off > fovRad) continue;
      // nearest to the crosshair first, closer targets break ties
      let score = (1 - off / fovRad) * 100 + (1 - clamp(dist / MAX_RANGE, 0, 1)) * 34;
      if (g.now < o.markedUntil && o.markedBy === this.f.id) score += 14;
      if (o === this.target) score += 12;                        // stickiness
      if (score > bestScore) { bestScore = score; best = o; }
    }
    return best;
  }

  /* where to aim: the chest, led a little for slow projectiles */
  aimPoint(o) {
    const f = this.f;
    const spec = f.char.primary;
    const p = { x: o.pos.x, y: o.centerY, z: o.pos.z };
    if (spec.kind === 'projectile' && spec.speed > 0) {
      const d = Math.hypot(p.x - f.pos.x, p.y - f.eyeY, p.z - f.pos.z);
      const t = clamp(d / spec.speed, 0, 0.55) * 0.75;           // partial lead: still a skill game
      p.x += o.vel.x * t;
      p.z += o.vel.z * t;
      p.y += o.vel.y * t * 0.4;
    }
    return p;
  }

  update(dt, manualDX, manualDY, input) {
    const out = { dx: 0, dy: 0 };
    const f = this.f;
    if (!f.alive || this.game.state !== 'live') { this.clear(); return out; }

    const s = this.strength();
    if (s <= 0.001) { this.clear(); return out; }

    const fovRad = (settings.get('aimAssistFov') || 26) * Math.PI / 180;
    const keepRad = fovRad * (settings.get('aimAssistSticky') ? 1.45 : 1.05);

    if (this.target && !(this.valid(this.target) &&
      this.offAngle(this.target.pos.x, this.target.centerY, this.target.pos.z) < keepRad)) {
      this.target = null;
      this.lockT = 0;
    }
    const found = this.pick(this.target ? keepRad : fovRad);
    if (found !== this.target) { this.target = found; this.lockT = 0; }
    if (!this.target) return out;

    this.lockT += dt;
    const p = this.aimPoint(this.target);
    const dx = p.x - f.pos.x, dy = p.y - f.eyeY, dz = p.z - f.pos.z;
    const dist = Math.hypot(dx, dy, dz) || 1;
    const wantYaw = Math.atan2(-dx, -dz);
    const wantPitch = Math.asin(clamp(dy / dist, -1, 1));

    const yawErr = angleDelta(f.yaw, wantYaw);
    const pitchErr = wantPitch - f.pitch;
    const off = Math.hypot(yawErr, pitchErr);

    const firing = input.isDown('fire') || input.isDown('altFire');
    const manual = Math.hypot(manualDX, manualDY) > 0.0016;

    // pull: strongest right after acquiring and while attacking, always capped
    let rate = s * (firing ? 2.6 : 1.0);
    if (manual) rate *= 0.4;                                     // the player's own aim comes first
    rate *= clamp(1 - off / (fovRad * 1.2), 0.15, 1);            // no snapping from far off
    rate *= clamp(1 - clamp(dist / MAX_RANGE, 0, 1) * 0.45, 0.4, 1);
    const maxStep = rate * dt * 2.4;

    out.dx = clamp(yawErr, -maxStep, maxStep);
    out.dy = clamp(pitchErr, -maxStep, maxStep) * 0.85;

    // friction: crossing a target slows the swipe instead of dragging it along
    if (manual && off < fovRad * 0.55) {
      const fr = 1 - 0.32 * s;
      out.dx += manualDX * (fr - 1);
      out.dy += manualDY * (fr - 1);
    }
    return out;
  }
}
