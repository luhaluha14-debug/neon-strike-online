import * as THREE from 'three';
import { BOMB_CONFIG } from '../config';
import type { BombSite } from '../world/MapLoader';

// C4 bomb objective of the team match. Pure logic (no rendering, no input
// devices), stepped by Game at the fixed tick while a round is live:
// who carries the bomb, where a dropped one lies, plant / defuse progress
// with their cancel rules, and the bomb timer. Every rule value is in
// BOMB_CONFIG. Each state change is reported once as an event; after the
// bomb has exploded or been defused nothing more can happen until reset().

export type BombState = 'carried' | 'dropped' | 'planted' | 'defused' | 'exploded';
export type BombSide = 'attack' | 'defense';

/** One combatant as the objective sees it, every tick. */
export interface BombActor {
  readonly id: string;
  readonly side: BombSide;
  readonly alive: boolean;
  /** Feet position. */
  readonly position: THREE.Vector3;
  /** Horizontal speed (m/s). */
  readonly speed: number;
  /** Holding the use key (player) / wanting to plant or defuse (bot). */
  readonly use: boolean;
  /** Damage events taken so far (a change while planting / defusing cancels it). */
  readonly hits: number;
}

export type CancelReason = 'release' | 'move' | 'hurt' | 'dead' | 'zone';

export type BombEvent =
  | { type: 'pickup'; id: string }
  | { type: 'drop'; id: string; at: THREE.Vector3 }
  | { type: 'plant-start'; id: string; site: string }
  | { type: 'plant-cancel'; id: string; why: CancelReason }
  | { type: 'planted'; id: string; site: string }
  | { type: 'defuse-start'; id: string }
  | { type: 'defuse-cancel'; id: string; why: CancelReason }
  | { type: 'defused'; id: string }
  | { type: 'exploded'; at: THREE.Vector3 };

interface Progress {
  id: string;
  /** Seconds held so far. */
  time: number;
  /** The actor's `hits` when it started. */
  hits: number;
}

export class BombObjective {
  state: BombState = 'carried';
  /** Who holds it (state 'carried'). */
  carrier: string | null = null;
  /** Where it is: the carrier's feet, where it was dropped, or where it was planted. */
  readonly position = new THREE.Vector3();
  /** Site it was planted at. */
  site: string | null = null;
  /** Seconds to the explosion once planted. */
  timeLeft: number = BOMB_CONFIG.timer;
  planting: Progress | null = null;
  defusing: Progress | null = null;
  plantedBy: string | null = null;
  defusedBy: string | null = null;
  /** Actors whose plant / defuse was cancelled: they must let go of the use key before starting again. */
  private readonly mustRelease = new Set<string>();
  /** Site volumes, flat floor markers raised to BOMB_CONFIG.siteMinHeight. */
  readonly sites: readonly BombSite[];

  constructor(sites: readonly BombSite[]) {
    this.sites = sites.map((s) => {
      const box = s.box.clone();
      // Feet stand a little above a floor marker: start the volume slightly below it.
      box.min.y -= 0.3;
      box.max.y = Math.max(box.max.y, box.min.y + BOMB_CONFIG.siteMinHeight);
      return { name: s.name, box };
    });
  }

  /** New round: `carrier` has the bomb (null: it lies at `at`). */
  reset(carrier: string | null, at: THREE.Vector3): void {
    this.state = carrier ? 'carried' : 'dropped';
    this.carrier = carrier;
    this.position.copy(at);
    this.site = null;
    this.timeLeft = BOMB_CONFIG.timer;
    this.planting = null;
    this.defusing = null;
    this.plantedBy = null;
    this.defusedBy = null;
    this.mustRelease.clear();
  }

  /** Planted and ticking. */
  get armed(): boolean {
    return this.state === 'planted';
  }

  /** The bomb site containing feet position `p`, or null. */
  siteAt(p: THREE.Vector3): string | null {
    for (const s of this.sites) if (s.box.containsPoint(p)) return s.name;
    return null;
  }

  /** Centre of a site's floor (bots head there). */
  siteCenter(name: string, out = new THREE.Vector3()): THREE.Vector3 {
    const s = this.sites.find((x) => x.name === name);
    if (!s) return out.set(0, 0, 0);
    s.box.getCenter(out);
    out.y = s.box.min.y + 0.3;
    return out;
  }

  /** 0..1 of the current plant / defuse (null when none). */
  get plantProgress(): number | null {
    return this.planting ? Math.min(this.planting.time / BOMB_CONFIG.plantTime, 1) : null;
  }

  get defuseProgress(): number | null {
    return this.defusing ? Math.min(this.defusing.time / BOMB_CONFIG.defuseTime, 1) : null;
  }

  /** One tick of a live round. Returns what changed. */
  step(dt: number, actors: readonly BombActor[]): BombEvent[] {
    const events: BombEvent[] = [];
    for (const a of actors) if (!a.use) this.mustRelease.delete(a.id);
    switch (this.state) {
      case 'carried':
        this.stepCarried(dt, actors, events);
        break;
      case 'dropped':
        this.stepDropped(actors, events);
        break;
      case 'planted':
        this.stepPlanted(dt, actors, events);
        break;
      default:
        break;
    }
    return events;
  }

  private stepCarried(dt: number, actors: readonly BombActor[], events: BombEvent[]): void {
    const c = actors.find((a) => a.id === this.carrier);
    if (!c || !c.alive) {
      // The carrier died (or left): the bomb falls where it was.
      if (this.planting) events.push({ type: 'plant-cancel', id: this.planting.id, why: 'dead' });
      this.planting = null;
      if (c) this.position.copy(c.position);
      const id = this.carrier ?? '';
      this.state = 'dropped';
      this.carrier = null;
      events.push({ type: 'drop', id, at: this.position.clone() });
      return;
    }
    this.position.copy(c.position);
    const site = this.siteAt(c.position);
    const p = this.planting;
    if (p) {
      const why: CancelReason | null = !c.use ? 'release' : !site ? 'zone' : c.hits !== p.hits ? 'hurt' : c.speed > BOMB_CONFIG.maxUseSpeed ? 'move' : null;
      if (why) {
        this.planting = null;
        if (why !== 'release') this.mustRelease.add(c.id);
        events.push({ type: 'plant-cancel', id: c.id, why });
        return;
      }
      p.time += dt;
      if (p.time >= BOMB_CONFIG.plantTime) {
        this.planting = null;
        this.state = 'planted';
        this.carrier = null;
        this.site = site;
        this.plantedBy = c.id;
        this.timeLeft = BOMB_CONFIG.timer;
        events.push({ type: 'planted', id: c.id, site: site! });
      }
      return;
    }
    if (c.use && site && c.speed <= BOMB_CONFIG.maxUseSpeed && !this.mustRelease.has(c.id)) {
      this.planting = { id: c.id, time: 0, hits: c.hits };
      events.push({ type: 'plant-start', id: c.id, site });
    }
  }

  private stepDropped(actors: readonly BombActor[], events: BombEvent[]): void {
    let best: BombActor | null = null;
    let bestD: number = BOMB_CONFIG.pickupRange;
    for (const a of actors) {
      if (!a.alive || a.side !== 'attack') continue;
      if (Math.abs(a.position.y - this.position.y) > 1.5) continue;
      const d = Math.hypot(a.position.x - this.position.x, a.position.z - this.position.z);
      if (d <= bestD) {
        best = a;
        bestD = d;
      }
    }
    if (!best) return;
    this.state = 'carried';
    this.carrier = best.id;
    events.push({ type: 'pickup', id: best.id });
  }

  private stepPlanted(dt: number, actors: readonly BombActor[], events: BombEvent[]): void {
    const near = (a: BombActor) =>
      a.alive && a.side === 'defense' && Math.abs(a.position.y - this.position.y) < 1.5 && Math.hypot(a.position.x - this.position.x, a.position.z - this.position.z) <= BOMB_CONFIG.defuseRange;
    const d = this.defusing;
    if (d) {
      const a = actors.find((x) => x.id === d.id);
      const why: CancelReason | null = !a || !a.alive ? 'dead' : !a.use ? 'release' : !near(a) ? 'zone' : a.hits !== d.hits ? 'hurt' : a.speed > BOMB_CONFIG.maxUseSpeed ? 'move' : null;
      if (why) {
        this.defusing = null;
        if (why !== 'release') this.mustRelease.add(d.id);
        events.push({ type: 'defuse-cancel', id: d.id, why });
      } else {
        d.time += dt;
        // A defuse finishing on the same tick as the timer runs out counts (it was done in time).
        if (d.time >= BOMB_CONFIG.defuseTime) {
          this.defusing = null;
          this.state = 'defused';
          this.defusedBy = d.id;
          events.push({ type: 'defused', id: d.id });
          return;
        }
      }
    } else {
      const a = actors.find((x) => near(x) && x.use && x.speed <= BOMB_CONFIG.maxUseSpeed && !this.mustRelease.has(x.id));
      if (a) {
        this.defusing = { id: a.id, time: 0, hits: a.hits };
        events.push({ type: 'defuse-start', id: a.id });
      }
    }
    this.timeLeft = Math.max(0, this.timeLeft - dt);
    if (this.timeLeft <= 0) {
      if (this.defusing) events.push({ type: 'defuse-cancel', id: this.defusing.id, why: 'dead' });
      this.defusing = null;
      this.state = 'exploded';
      events.push({ type: 'exploded', at: this.position.clone() });
    }
  }
}
