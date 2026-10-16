import * as THREE from 'three';
import type { HitscanResult, HitscanSystem } from '../combat/HitscanSystem';
import { buildDummyGeometry } from '../combat/TrainingTarget';
import type { PlayerDamageEvent } from '../player/PlayerCombat';
import type { Weapon } from '../weapons/Weapon';
import type { WeaponDefinition } from '../weapons/WeaponDefinition';
import type { LoadedMap } from '../world/MapLoader';
import { Bot, type Combatant } from './Bot';
import type { NavGrid } from './NavGrid';

const NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India'];
const DEATH_FALL = 0.45;
const FLASH_TIME = 0.05;

export interface SquadEvents {
  onShot?(bot: Bot, result: HitscanResult, origin: THREE.Vector3, dir: THREE.Vector3, weapon: Weapon): void;
  /** A bot took damage (`e.killed` when it died). */
  onDamage?(bot: Bot, e: PlayerDamageEvent): void;
}

interface Visual {
  root: THREE.Group;
  body: THREE.Group;
  flash: THREE.Mesh;
  flashTime: number;
}

/**
 * The AI opponents of one match on one map: creation, registration with the
 * map's hitscan, the per-tick update, respawning far from enemies, their
 * bodies in the scene, and cleanup.
 */
export class BotSquad {
  readonly bots: Bot[] = [];
  readonly group = new THREE.Group();
  events: SquadEvents = {};
  private readonly visuals: Visual[] = [];
  private readonly geometry = buildDummyGeometry();
  private readonly bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, color: 0x9aa7b8, roughness: 0.8 });
  private readonly gunMat = new THREE.MeshStandardMaterial({ color: 0x1c1d1f, roughness: 0.55, metalness: 0.5 });
  private readonly gunGeo = new THREE.BoxGeometry(0.06, 0.09, 0.72);
  private readonly flashMat = new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending });
  private readonly flashGeo = new THREE.PlaneGeometry(0.28, 0.28);
  private disposed = false;

  constructor(
    private readonly map: LoadedMap,
    private readonly nav: NavGrid,
    private readonly hitscan: HitscanSystem,
    count: number,
    loadout: readonly WeaponDefinition[],
    private readonly rand: () => number = Math.random,
  ) {
    this.group.name = 'BotSquad';
    for (let i = 0; i < count; i++) {
      const bot = new Bot(`bot-${i + 1}`, `BOT ${NAMES[i % NAMES.length]}`, map.collision, hitscan, loadout, nav, undefined, rand);
      hitscan.register(bot.combat);
      bot.combat.onDamage = (e) => this.events.onDamage?.(bot, e);
      bot.weapons.events = {
        onShot: (result, origin, dir, weapon) => {
          this.visuals[i].flashTime = FLASH_TIME;
          this.events.onShot?.(bot, result, origin, dir, weapon);
        },
      };
      this.bots.push(bot);
      this.visuals.push(this.makeVisual(bot));
    }
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
      if (b.combat.respawnDue) this.respawn(b, everyone.filter((c) => c !== b && c.alive).map((c) => c.position));
    }
  }

  /** Per frame: bodies follow their controllers, fall when dead, flash when firing. */
  updateVisuals(dt: number, camera: THREE.Camera): void {
    this.bots.forEach((b, i) => {
      const v = this.visuals[i];
      v.root.position.copy(b.position);
      v.root.rotation.y = b.controller.yaw;
      const fall = b.alive ? 0 : Math.min(b.combat.deadTime / DEATH_FALL, 1);
      // Falls onto its back (+Z is behind a bot).
      v.body.rotation.x = (Math.PI / 2) * fall * fall;
      v.flashTime = Math.max(0, v.flashTime - dt);
      v.flash.visible = v.flashTime > 0 && b.alive;
      if (v.flash.visible) v.flash.quaternion.copy(camera.quaternion).premultiply(v.root.quaternion.clone().invert());
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const b of this.bots) this.hitscan.unregister(b.combat);
    this.group.removeFromParent();
    this.geometry.geometry.dispose();
    for (const d of [this.bodyMat, this.gunMat, this.flashMat, this.gunGeo, this.flashGeo]) d.dispose();
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
  }

  private makeVisual(bot: Bot): Visual {
    const root = new THREE.Group();
    root.name = bot.id;
    // The dummy mesh faces +Z and pivots 0.14 m behind its heels; bots face -Z.
    const body = new THREE.Group();
    body.rotation.order = 'YXZ';
    const mesh = new THREE.Mesh(this.geometry.geometry, this.bodyMat);
    mesh.rotation.y = Math.PI;
    mesh.position.z = 0.14;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    const gun = new THREE.Mesh(this.gunGeo, this.gunMat);
    gun.position.set(0.12, 1.32, -0.3);
    const flash = new THREE.Mesh(this.flashGeo, this.flashMat);
    flash.position.set(0.12, 1.34, -0.7);
    flash.visible = false;
    body.add(mesh, gun, flash);
    root.add(body);
    root.traverse((o) => {
      o.frustumCulled = true;
    });
    this.group.add(root);
    return { root, body, flash, flashTime: 0 };
  }
}
