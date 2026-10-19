import * as THREE from 'three';
import type { HitscanSystem } from '../combat/HitscanSystem';
import { createInputState, type InputState } from '../input/InputState';
import { PlayerCombat } from '../player/PlayerCombat';
import { PlayerController } from '../player/PlayerController';
import type { WeaponDefinition } from '../weapons/WeaponDefinition';
import { WeaponSystem, type WeaponCommand } from '../weapons/WeaponSystem';
import type { CollisionWorld } from '../world/CollisionWorld';
import type { NavGrid } from './NavGrid';

/** Something a bot can see and shoot at (the player or another bot). */
export interface Combatant {
  readonly id: string;
  readonly alive: boolean;
  /** Feet position. */
  readonly position: THREE.Vector3;
  readonly height: number;
  /** Team (team match). Combatants on the bot's own team are never enemies. */
  readonly team?: string;
}

/** Skill knobs: how fast a bot reacts and how well it aims. */
export interface BotSkill {
  /** Seconds from first sight to the first shot. */
  reaction: number;
  /** Aim error (rad) when a target is acquired, shrinking toward `aimBest` while tracking it. */
  aimStart: number;
  aimBest: number;
  /** Max view turn speed (rad/s). */
  turnSpeed: number;
  /** Sight range (m). */
  sightRange: number;
}

export const DEFAULT_SKILL: BotSkill = { reaction: 0.6, aimStart: 0.16, aimBest: 0.075, turnSpeed: 5.5, sightRange: 70 };

type Mode = 'wander' | 'engage' | 'search';

const THINK_INTERVAL = 0.15;
/** Half-angle of the field of view (rad). */
const FOV_HALF = (130 / 2) * (Math.PI / 180);
const MEMORY = 4;
/** Horizontal speed (m/s) below which a bot will shoot: like CS, rounds are only accurate when (nearly) stopped. */
const FIRE_MAX_SPEED = 1.2;
/** Above this speed a stopping bot counter-strafes (presses the opposite way) instead of just letting go. */
const COUNTER_STRAFE_SPEED = 1.6;

const _eye = new THREE.Vector3();
const _to = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _aim = new THREE.Vector3();

/**
 * One AI opponent. It drives the same PlayerController (movement, collision)
 * and WeaponSystem (fire rate, recoil, spread, hitscan, damage) as the
 * player, through the same input / WeaponCommand structs, and takes damage
 * through a PlayerCombat registered with the hitscan. Only the decisions are
 * its own: wander the nav grid, spot enemies it can actually see, engage
 * them CS-style (stop, counter-strafe, short burst, then maybe a short peek
 * step before the next one), and search where it last saw them.
 */
export class Bot {
  readonly controller: PlayerController;
  readonly combat: PlayerCombat;
  readonly weapons: WeaponSystem;
  readonly input: InputState = createInputState();
  readonly command: WeaponCommand = { fire: false, reload: false };
  mode: Mode = 'wander';
  /** Current enemy (when engaging). */
  target: Combatant | null = null;
  readonly lastSeen = new THREE.Vector3();
  /**
   * Team match: while wandering with no enemy in sight, roam toward this
   * area (the enemy side) instead of anywhere on the map. null = anywhere.
   */
  roamTarget: THREE.Vector3 | null = null;
  private teamId: string | undefined = undefined;

  private path: THREE.Vector3[] = [];
  private pathIndex = 0;
  private thinkTimer: number;
  private seenFor = 0;
  private lostFor = 0;
  private aimError = new THREE.Vector2();
  private aimErrorSize = 0;
  private burstLeft = 0;
  private burstPause = 0;
  private strafeDir = 1;
  /** Remaining time of a short reposition step between bursts (0 = holding still to shoot). */
  private peekTimer = 0;
  private stuckTimer = 0;
  private readonly stuckFrom = new THREE.Vector3();
  private repathTimer = 0;

  constructor(
    readonly id: string,
    readonly name: string,
    private readonly world: CollisionWorld,
    hitscan: HitscanSystem,
    loadout: readonly WeaponDefinition[],
    private readonly nav: NavGrid,
    readonly skill: BotSkill = DEFAULT_SKILL,
    private readonly rand: () => number = Math.random,
  ) {
    this.controller = new PlayerController(world);
    this.combat = new PlayerCombat(this.controller, id);
    this.weapons = new WeaponSystem(loadout, this.controller, hitscan, id);
    this.thinkTimer = rand() * THINK_INTERVAL;
  }

  get alive(): boolean {
    return this.combat.alive;
  }

  get position(): THREE.Vector3 {
    return this.controller.position;
  }

  get height(): number {
    return this.controller.height;
  }

  get team(): string | undefined {
    return this.teamId;
  }

  /** Joins a team: its rounds then skip teammates (with friendly fire off) and it never targets them. */
  setTeam(team: string | undefined): void {
    this.teamId = team;
    this.combat.team = team;
    this.weapons.team = team;
  }

  /** Is `c` someone this bot may fight? (Not itself, not a teammate.) */
  isEnemy(c: Combatant): boolean {
    return c.id !== this.id && (this.teamId === undefined || c.team !== this.teamId);
  }

  /**
   * A tick with no decisions (team match before / after a round): standing,
   * not shooting; timers, gravity and a death fall still run.
   */
  hold(dt: number): void {
    this.combat.step(dt);
    const input = this.input;
    input.moveX = input.moveY = 0;
    input.jump = input.crouch = input.walk = false;
    this.controller.step(input, dt);
    this.command.fire = false;
    this.command.reload = false;
    this.weapons.step(this.command, dt);
  }

  /** Puts the bot at a spawn, full health, fresh magazine, nothing in mind. */
  spawn(at: THREE.Vector3, yaw: number): void {
    this.controller.teleport(at.clone().setY(at.y + 0.1), yaw);
    this.combat.reset();
    this.weapons.resetForRespawn();
    this.mode = 'wander';
    this.target = null;
    this.path = [];
    this.seenFor = 0;
    this.burstLeft = 0;
    this.burstPause = 0;
    this.peekTimer = 0;
    this.stuckTimer = 0;
    this.stuckFrom.copy(this.controller.position);
  }

  /**
   * One simulation tick. `enemies` are everyone else (alive or not);
   * `others` the other bots, to keep some distance from them.
   */
  step(dt: number, enemies: readonly Combatant[], others: readonly Bot[]): void {
    this.combat.step(dt);
    const c = this.controller;
    const input = this.input;
    if (!this.alive) {
      // Falls where it died; no input.
      input.moveX = input.moveY = 0;
      input.jump = input.crouch = false;
      c.step(input, dt);
      return;
    }

    this.thinkTimer -= dt;
    if (this.thinkTimer <= 0) {
      this.thinkTimer += THINK_INTERVAL;
      this.think(enemies);
    }

    // --- Where to look ---
    const t = this.target;
    let wantYaw = c.yaw;
    let wantPitch = 0;
    _eye.set(c.position.x, c.position.y + c.eyeHeight, c.position.z);
    if (this.mode === 'engage' && t && t.alive) {
      this.seenFor += dt;
      // Aim error shrinks while tracking (about 1 s from acquire to steady aim).
      this.aimErrorSize = Math.max(this.skill.aimBest, this.aimErrorSize - dt * (this.skill.aimStart - this.skill.aimBest));
      _aim.set(t.position.x, t.position.y + t.height * 0.72, t.position.z).sub(_eye);
      wantYaw = Math.atan2(-_aim.x, -_aim.z) + this.aimError.x * this.aimErrorSize;
      wantPitch = Math.atan2(_aim.y, Math.hypot(_aim.x, _aim.z)) + this.aimError.y * this.aimErrorSize;
    } else {
      const next = this.nextWaypoint();
      if (next) wantYaw = Math.atan2(-(next.x - c.position.x), -(next.z - c.position.z));
      if (this.mode === 'search') wantYaw = Math.atan2(-(this.lastSeen.x - c.position.x), -(this.lastSeen.z - c.position.z));
    }
    const maxTurn = this.skill.turnSpeed * dt;
    c.yaw += THREE.MathUtils.clamp(wrap(wantYaw - c.yaw), -maxTurn, maxTurn);
    c.pitch += THREE.MathUtils.clamp(wantPitch - c.pitch, -maxTurn, maxTurn);

    // --- Where to go ---
    _dir.set(0, 0, 0);
    const speed = Math.hypot(c.velocity.x, c.velocity.z);
    let counterStrafe = false;
    if (this.mode === 'engage' && t) {
      const fx = -Math.sin(c.yaw);
      const fz = -Math.cos(c.yaw);
      if (this.peekTimer > 0) {
        // Short step between bursts: sideways, closing in from far, backing off when very close.
        this.peekTimer -= dt;
        const dist = Math.hypot(t.position.x - c.position.x, t.position.z - c.position.z);
        _dir.set(-fz * this.strafeDir, 0, fx * this.strafeDir);
        if (dist > 28) _dir.add(_to.set(fx, 0, fz).multiplyScalar(1.2));
        else if (dist < 5) _dir.add(_to.set(-fx, 0, -fz).multiplyScalar(0.8));
      } else if (speed > COUNTER_STRAFE_SPEED) {
        // Holding still to shoot: brake by pressing against the current motion.
        _dir.set(-c.velocity.x, 0, -c.velocity.z);
        counterStrafe = true;
      }
    } else {
      const next = this.nextWaypoint();
      if (next) _dir.set(next.x - c.position.x, 0, next.z - c.position.z);
    }
    // Keep a little room from other bots (not while braking to shoot).
    for (const o of counterStrafe || (this.mode === 'engage' && this.peekTimer <= 0) ? [] : others) {
      if (o === this || !o.alive) continue;
      const dx = c.position.x - o.position.x;
      const dz = c.position.z - o.position.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < 1.6 * 1.6 && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        _dir.x += (dx / d) * (1.6 - d) * 2;
        _dir.z += (dz / d) * (1.6 - d) * 2;
      }
    }
    const len = Math.hypot(_dir.x, _dir.z);
    if (len > 1e-3) {
      _dir.multiplyScalar(1 / len);
      // World direction → the controller's local axes.
      const fx = -Math.sin(c.yaw);
      const fz = -Math.cos(c.yaw);
      input.moveY = _dir.x * fx + _dir.z * fz;
      input.moveX = _dir.x * -fz + _dir.z * fx;
    } else {
      input.moveX = input.moveY = 0;
    }
    input.walk = false;
    input.crouch = false;

    // --- Stuck? Jump, then pick a new route. ---
    input.jump = false;
    this.stuckTimer += dt;
    if (this.stuckTimer > 0.9) {
      const moved = Math.hypot(c.position.x - this.stuckFrom.x, c.position.z - this.stuckFrom.z);
      if (len > 1e-3 && moved < 0.35) {
        input.jump = true;
        if (this.mode !== 'engage') this.path = [];
      }
      this.stuckTimer = 0;
      this.stuckFrom.copy(c.position);
    }

    c.step(input, dt);

    // --- Shooting ---
    const w = this.weapons.weapon;
    this.command.reload = false;
    this.command.fire = false;
    if (this.mode === 'engage' && t && t.alive && this.seenFor >= this.skill.reaction && w.status === 'ready' && w.magazine > 0) {
      const err = Math.abs(wrap(wantYaw - c.yaw)) + Math.abs(wantPitch - c.pitch);
      const steady = this.peekTimer <= 0 && c.grounded && Math.hypot(c.velocity.x, c.velocity.z) < FIRE_MAX_SPEED;
      if (this.burstPause > 0) this.burstPause -= dt;
      else if (err < 0.06 && steady) {
        this.command.fire = true;
        this.burstLeft -= dt;
        if (this.burstLeft <= 0) {
          // Short bursts with pauses (recoil grows over a long spray).
          this.burstLeft = 0.2 + this.rand() * 0.3;
          this.burstPause = 0.18 + this.rand() * 0.35;
          this.rollAimError();
          // Sometimes take a quick step before the next burst (then stop again to shoot).
          if (this.rand() < 0.35) {
            this.peekTimer = 0.2 + this.rand() * 0.25;
            this.strafeDir = this.rand() < 0.5 ? -1 : 1;
          }
        }
      }
    }
    if (w.magazine === 0 || (this.mode !== 'engage' && w.magazine < w.def.magazineSize * 0.4)) this.command.reload = true;
    const fired = this.weapons.shotsFired;
    this.weapons.step(this.command, dt);
    // A fresh aim error for every round, so a burst scatters around the target instead of stacking on one spot.
    if (this.weapons.shotsFired !== fired) this.rollAimError();
  }

  /** Perception + decisions, a few times a second. */
  private think(enemies: readonly Combatant[]): void {
    const c = this.controller;
    _eye.set(c.position.x, c.position.y + c.eyeHeight, c.position.z);
    let best: Combatant | null = null;
    let bestD = Infinity;
    for (const e of enemies) {
      if (!e.alive || !this.isEnemy(e)) continue;
      const d = this.canSee(e);
      if (d !== null && d < bestD) {
        best = e;
        bestD = d;
      }
    }
    if (best) {
      if (best !== this.target || this.mode !== 'engage') {
        this.seenFor = 0;
        this.aimErrorSize = this.skill.aimStart;
        this.rollAimError();
      }
      this.target = best;
      this.mode = 'engage';
      this.lostFor = 0;
      this.lastSeen.copy(best.position);
      return;
    }
    if (this.mode === 'engage') {
      // Lost sight: go to where it was last seen.
      this.mode = 'search';
      this.path = this.nav.findPath(c.position, this.lastSeen) ?? [];
      this.pathIndex = 0;
      this.lostFor = 0;
      return;
    }
    if (this.mode === 'search') {
      this.lostFor += THINK_INTERVAL;
      if (this.lostFor > MEMORY || !this.nextWaypoint()) {
        this.mode = 'wander';
        this.target = null;
        this.path = [];
      }
      return;
    }
    // Wander: walk to random reachable places.
    this.repathTimer -= THINK_INTERVAL;
    if (!this.nextWaypoint() || this.repathTimer <= 0) {
      const goal = this.roamGoal();
      if (goal >= 0) this.path = this.nav.findPath(c.position, this.nav.center(goal)) ?? [];
      this.pathIndex = 0;
      this.repathTimer = 12;
    }
  }

  /** A random walkable cell; with a roam target, one within ~14 m of it when such a cell turns up. */
  private roamGoal(): number {
    const t = this.roamTarget;
    if (!t) return this.nav.randomCell(this.rand);
    let fallback = -1;
    for (let k = 0; k < 24; k++) {
      const cell = this.nav.randomCell(this.rand);
      if (cell < 0) break;
      if (fallback < 0) fallback = cell;
      const p = this.nav.center(cell);
      if (Math.hypot(p.x - t.x, p.z - t.z) < 14) return cell;
    }
    return fallback;
  }

  /** Distance to `e` if it is within range, inside the field of view and not behind a wall. */
  private canSee(e: Combatant): number | null {
    const c = this.controller;
    _to.set(e.position.x, e.position.y + e.height * 0.8, e.position.z).sub(_eye);
    const dist = _to.length();
    if (dist > this.skill.sightRange) return null;
    // Someone very close is noticed even from behind (footsteps, shots).
    if (dist > 4) {
      const ang = Math.abs(wrap(Math.atan2(-_to.x, -_to.z) - c.yaw));
      if (ang > FOV_HALF) return null;
    }
    _to.normalize();
    if (this.world.raycast(_eye, _to, dist) !== null) return null;
    return dist;
  }

  /** Next path point not yet reached (advances past reached ones), or null. */
  private nextWaypoint(): THREE.Vector3 | null {
    const p = this.controller.position;
    while (this.pathIndex < this.path.length) {
      const w = this.path[this.pathIndex];
      if (Math.hypot(w.x - p.x, w.z - p.z) > 0.6) return w;
      this.pathIndex++;
    }
    return null;
  }

  private rollAimError(): void {
    // Roughly normal, mostly in yaw (people miss sideways more than up/down).
    const g = () => (this.rand() + this.rand() + this.rand() - 1.5) / 1.5;
    this.aimError.set(g(), g() * 0.6);
  }
}

function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
