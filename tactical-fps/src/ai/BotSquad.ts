import * as THREE from 'three';
import type { HitscanResult, HitscanSystem } from '../combat/HitscanSystem';
import type { PlayerDamageEvent } from '../player/PlayerCombat';
import type { Weapon } from '../weapons/Weapon';
import type { WeaponDefinition } from '../weapons/WeaponDefinition';
import type { LoadedMap } from '../world/MapLoader';
import { Bot, type Combatant } from './Bot';
import { AgentModel } from './AgentModel';
import { BotKit, BotModel, type BotBody, type BotPose } from './BotModel';
import type { NavGrid } from './NavGrid';

const NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India'];

/**
 * How bots look: the built-in animated body, or the Blender character
 * models (static pose, no rig; falls back to the built-in body until the
 * file has loaded).
 */
export type BotLook = 'procedural' | 'agents';

/** One bot of a team match roster. */
export interface SquadMember {
  name: string;
  team: string;
}

export interface SquadEvents {
  /** `muzzle`: world position of the bot's rifle muzzle (flash / tracer start; the round itself starts at the eye, like the player's). */
  onShot?(bot: Bot, result: HitscanResult, origin: THREE.Vector3, dir: THREE.Vector3, weapon: Weapon, muzzle: THREE.Vector3): void;
  /** A bot took damage (`e.killed` when it died). */
  onDamage?(bot: Bot, e: PlayerDamageEvent): void;
}

const _muzzle = new THREE.Vector3();
const _pose: BotPose = {
  feet: new THREE.Vector3(),
  yaw: 0,
  pitch: 0,
  velocity: new THREE.Vector3(),
  grounded: true,
  aiming: false,
  alive: true,
  deadTime: 0,
};

/**
 * The AI opponents of one match on one map: creation, registration with the
 * map's hitscan, the per-tick update, respawning far from enemies, their
 * bodies (BotModel) in the scene, and cleanup.
 */
export class BotSquad {
  readonly bots: Bot[] = [];
  readonly models: BotBody[] = [];
  readonly group = new THREE.Group();
  events: SquadEvents = {};
  /**
   * Free-for-all: dead bots come back after the respawn delay. Team match
   * turns this off: deaths last until the round ends (spawnAt brings them back).
   */
  respawns = true;
  /** One kit per uniform: the default olive one, or one per team. */
  private readonly kits = new Map<string, BotKit>();
  private disposed = false;

  /** `members`: a bot count (free-for-all, no teams) or a team roster. */
  constructor(
    private readonly map: LoadedMap,
    private readonly nav: NavGrid,
    private readonly hitscan: HitscanSystem,
    members: number | readonly SquadMember[],
    loadout: readonly WeaponDefinition[],
    private readonly rand: () => number = Math.random,
    look: BotLook = 'procedural',
  ) {
    this.group.name = 'BotSquad';
    const roster: readonly (SquadMember | null)[] = typeof members === 'number' ? Array.from({ length: members }, () => null) : members;
    roster.forEach((m, i) => {
      const bot = new Bot(`bot-${i + 1}`, m?.name ?? `BOT ${NAMES[i % NAMES.length]}`, map.collision, hitscan, loadout, nav, undefined, rand);
      if (m) bot.setTeam(m.team);
      hitscan.register(bot.combat);
      const kitKey = m?.team ?? '';
      let kit = this.kits.get(kitKey);
      if (!kit) {
        kit = new BotKit(m?.team);
        this.kits.set(kitKey, kit);
      }
      const model: BotBody = (look === 'agents' && AgentModel.create(m?.team, kit)) || new BotModel(kit);
      model.object.name = bot.id;
      this.group.add(model.object);
      bot.combat.onDamage = (e) => {
        model.onHit(e.direction);
        this.events.onDamage?.(bot, e);
      };
      bot.weapons.events = {
        onShot: (result, origin, dir, weapon) => {
          model.onShot();
          model.object.updateMatrixWorld(true);
          model.muzzle.getWorldPosition(_muzzle);
          this.events.onShot?.(bot, result, origin, dir, weapon, _muzzle);
        },
      };
      this.bots.push(bot);
      this.models.push(model);
    });
  }

  /** Puts every bot at a spawn point, spread out and away from `avoid`. */
  spawnAll(avoid: readonly THREE.Vector3[]): void {
    const taken = [...avoid];
    for (const b of this.bots) {
      this.respawn(b, taken);
      taken.push(b.position);
    }
  }

  /** One simulation tick for every bot; dead bots come back after the respawn delay. */
  step(dt: number, player: Combatant): void {
    const everyone: Combatant[] = [player, ...this.bots];
    for (const b of this.bots) {
      b.step(dt, everyone, this.bots);
      if (this.respawns && b.combat.respawnDue) this.respawn(b, everyone.filter((c) => c !== b && c.alive).map((c) => c.position));
    }
  }

  /** A tick with every bot holding still (team match before / after a round). */
  hold(dt: number): void {
    for (const b of this.bots) b.hold(dt);
  }

  /** Puts a bot at a given spot (team match round start): full health, fresh magazine, nothing in mind. */
  spawnAt(b: Bot, at: THREE.Vector3, yaw: number): void {
    b.spawn(at, yaw);
    this.models[this.bots.indexOf(b)]?.reset();
  }

  /** Per frame: bodies walk / aim / fall from their bot's state. */
  updateVisuals(dt: number): void {
    this.bots.forEach((b, i) => {
      const c = b.controller;
      _pose.feet.copy(c.position);
      _pose.yaw = c.yaw;
      _pose.pitch = c.pitch;
      _pose.velocity.copy(c.velocity);
      _pose.grounded = c.grounded;
      _pose.aiming = (b.remote ? b.remote.aiming : b.mode === 'engage') && b.alive;
      _pose.alive = b.alive;
      _pose.deadTime = b.combat.deadTime;
      this.models[i].update(dt, _pose);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const b of this.bots) this.hitscan.unregister(b.combat);
    for (const m of this.models) m.dispose();
    for (const k of this.kits.values()) k.dispose();
    this.group.removeFromParent();
  }

  /** A walkable spot as far as possible from `avoid` (sampled), facing the map centre. */
  private respawn(b: Bot, avoid: readonly THREE.Vector3[]): void {
    let best = -1;
    let bestScore = -Infinity;
    for (let k = 0; k < 24; k++) {
      const c = this.nav.randomCell(this.rand);
      if (c < 0) break;
      const p = this.nav.center(c);
      let near = 60;
      for (const a of avoid) near = Math.min(near, Math.hypot(a.x - p.x, a.z - p.z));
      const score = near + this.rand() * 4;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    const at = best >= 0 ? this.nav.center(best) : this.map.defenseSpawns[0]?.position.clone() ?? new THREE.Vector3();
    const centre = this.map.playBounds.getCenter(new THREE.Vector3());
    b.spawn(at, Math.atan2(-(centre.x - at.x), -(centre.z - at.z)));
    this.models[this.bots.indexOf(b)]?.reset();
  }
}
