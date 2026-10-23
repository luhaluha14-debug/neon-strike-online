import * as THREE from 'three';
import type { BombObjective } from '../game/BombObjective';
import type { Team } from '../game/TeamMatch';
import type { Bot, BotOrder, BotRole } from './Bot';
import type { SiteInfo, TacticalMap } from './TacticalMap';

/** Seconds between plan updates (orders only change when the plan does). */
const UPDATE_INTERVAL = 0.5;
/** Attackers wait at their entrance until the main group is there, at most this long into the round. */
const MAX_STAGING = 30;
/** Main group "at the entrance": within this distance (m). */
const STAGED_RADIUS = 5;
/** An enemy seen this close (m) to a site puts the defence on alert there. */
const ALERT_RADIUS = 22;

/** What a team knows this tick: its bots, where it spawned, where the other side spawned. */
export interface DirectorContext {
  attackers: Team;
  bots: readonly Bot[];
  bomb: BombObjective;
  /** Seconds since the round went live. */
  liveTime: number;
  attackSpawn: THREE.Vector3;
  defenseSpawn: THREE.Vector3;
}

/**
 * Team tactics for the bomb objective, decided a couple of times a second
 * and handed to bots as orders (where to go, where to look, plant / defuse).
 * Bots still see, react and shoot on their own (Bot); the director only uses
 * what the team may know: its own positions, the bomb when it is theirs or
 * announced (planted), and enemies its bots actually saw (report()).
 *
 * Attack: one site per round (seeded random); the carrier goes with the
 * main group (entry, support) through the main entrance, one bot flanks
 * through another; they wait at the entrance for the group (or for
 * MAX_STAGING), then take the site and the carrier plants. After the plant
 * everyone holds covered spots around it. A dropped bomb is fetched by the
 * nearest attacker.
 * Defence: bots split between the sites on covered hold spots watching the
 * entrances, a fifth one in the middle; a sighting near a site pulls the
 * middle one and one from the other site there; once the bomb is planted
 * the nearest defender defuses while the others cover.
 */
export class TacticalDirector {
  /** Attack target this round. */
  target: SiteInfo | null = null;
  phase: 'approach' | 'execute' | 'postplant' = 'approach';
  /** Sites the defence was alerted to (by its own sightings). */
  readonly alerts = new Set<string>();
  /** Enemy sightings reported by bots this round (team -> positions). */
  readonly sightings: { team: Team; position: THREE.Vector3; time: number }[] = [];
  private timer = 0;
  private time = 0;

  constructor(
    readonly tmap: TacticalMap,
    private readonly rand: () => number,
  ) {}

  /** Round start: a new plan (target site chosen now). */
  newRound(): void {
    const sites = this.tmap.sites;
    this.target = sites.length ? sites[Math.floor(this.rand() * sites.length) % sites.length] : null;
    this.phase = 'approach';
    this.alerts.clear();
    this.sightings.length = 0;
    this.timer = 0;
    this.time = 0;
  }

  /** A bot of `team` saw an enemy at `position` (shared with its team, like a callout). */
  report(team: Team, position: THREE.Vector3): void {
    this.sightings.push({ team, position: position.clone(), time: this.time });
    if (this.sightings.length > 64) this.sightings.shift();
  }

  /** Per tick while the round is live; replans every UPDATE_INTERVAL. */
  update(dt: number, ctx: DirectorContext): void {
    this.time += dt;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = UPDATE_INTERVAL;
    this.planAttack(ctx);
    this.planDefense(ctx);
  }

  /** Clears every bot's order (round over, or not the bomb objective). */
  static clear(bots: readonly Bot[]): void {
    for (const b of bots) {
      b.order = null;
      b.useKey = false;
    }
  }

  private planAttack(ctx: DirectorContext): void {
    const team = ctx.attackers;
    const site = this.target;
    const bomb = ctx.bomb;
    const bots = ctx.bots.filter((b) => b.alive && b.team === team).sort(byId);
    if (!site || bots.length === 0) return;
    const entrances = this.tmap.entrancesFrom(site, ctx.attackSpawn);
    const main = entrances[0] ?? site.centre;
    const flank = entrances.length > 1 ? entrances[entrances.length - 1] : main;

    if (bomb.state === 'planted' || bomb.state === 'exploded' || bomb.state === 'defused') {
      this.phase = 'postplant';
      const at = this.tmap.site(bomb.site ?? site.name) ?? site;
      const watch = this.tmap.entrancesFrom(at, ctx.defenseSpawn)[0] ?? at.centre;
      bots.forEach((b, i) => {
        const h = at.holds[i % Math.max(at.holds.length, 1)];
        give(b, 'postplant', h?.position ?? at.centre, watch, false, `${at.name}:postplant:${i}`);
      });
      return;
    }

    // Who fetches a dropped bomb: the nearest attacker bot.
    let retriever: Bot | null = null;
    if (bomb.state === 'dropped') {
      let best = Infinity;
      for (const b of bots) {
        const d = b.position.distanceToSquared(bomb.position);
        if (d < best) {
          best = d;
          retriever = b;
        }
      }
    }
    const carrier = bomb.state === 'carried' ? bots.find((b) => b.id === bomb.carrier) ?? null : null;
    const others = bots.filter((b) => b !== carrier && b !== retriever);
    // Roles: the last of the others flanks when there are at least three of them.
    const roles = new Map<Bot, BotRole>();
    others.forEach((b, i) => roles.set(b, others.length >= 3 && i === others.length - 1 ? 'flank' : i === 0 ? 'entry' : 'support'));

    if (this.phase === 'approach') {
      const group = [...others.filter((b) => roles.get(b) !== 'flank'), ...(carrier ? [carrier] : [])];
      const staged = group.every((b) => Math.hypot(b.position.x - main.x, b.position.z - main.z) < STAGED_RADIUS);
      if ((group.length && staged) || ctx.liveTime > MAX_STAGING) this.phase = 'execute';
    }
    const execute = this.phase === 'execute';
    others.forEach((b, i) => {
      const role = roles.get(b)!;
      const way = role === 'flank' ? flank : main;
      if (!execute) give(b, role, way, site.centre, false, `${site.name}:${role}:${role === 'flank' ? 'flank' : 'main'}`);
      else {
        const h = site.holds[i % Math.max(site.holds.length, 1)];
        give(b, role, h?.position ?? site.centre, h?.look ?? way, false, `${site.name}:${role}:take`);
      }
    });
    if (carrier) {
      if (!execute) give(carrier, 'carrier', main, site.centre, false, `${site.name}:carrier:main`);
      else give(carrier, 'carrier', site.centre, null, true, `${site.name}:carrier:plant`);
    }
    if (retriever) give(retriever, 'retriever', bomb.position.clone(), null, false, 'retrieve');
  }

  private planDefense(ctx: DirectorContext): void {
    const team: Team = ctx.attackers === 'blue' ? 'red' : 'blue';
    const bots = ctx.bots.filter((b) => b.alive && b.team === team).sort(byId);
    const sites = this.tmap.sites;
    const bomb = ctx.bomb;
    if (bots.length === 0 || sites.length === 0) return;

    if (bomb.state === 'planted') {
      // Announced: everyone goes; the nearest defuses, the rest cover.
      const at = this.tmap.site(bomb.site ?? '') ?? sites[0];
      let defuser = bots[0];
      for (const b of bots) if (b.position.distanceToSquared(bomb.position) < defuser.position.distanceToSquared(bomb.position)) defuser = b;
      give(defuser, 'defuser', bomb.position.clone(), null, true, `${at.name}:defuse`);
      bots
        .filter((b) => b !== defuser)
        .forEach((b, i) => {
          const h = at.holds[i % Math.max(at.holds.length, 1)];
          give(b, 'cover', h?.position ?? at.centre, h?.look ?? at.centre, false, `${at.name}:cover:${i}`);
        });
      return;
    }

    // Sightings by this team near a site raise an alert there.
    for (const s of this.sightings) {
      if (s.team !== team) continue;
      for (const site of sites) if (Math.hypot(s.position.x - site.centre.x, s.position.z - site.centre.z) < ALERT_RADIUS) this.alerts.add(site.name);
    }
    const alerted = sites.find((s) => this.alerts.has(s.name)) ?? null;

    // Base split: A, B, A, B, then the middle.
    const perSite = new Map<string, number>();
    bots.forEach((b, i) => {
      const anchorSite = i < 4 || sites.length === 1 ? sites[i % sites.length] : null;
      let role: BotRole = anchorSite ? 'anchor' : 'rotator';
      let site = anchorSite;
      // On alert: the middle bot and the second bot of the other site rotate in.
      if (alerted && (!anchorSite || (anchorSite !== alerted && i >= sites.length))) {
        site = alerted;
        role = 'rotator';
      }
      if (!site) {
        give(b, 'rotator', this.tmap.mid, ctx.attackSpawn, false, 'mid');
        return;
      }
      const n = perSite.get(site.name) ?? 0;
      perSite.set(site.name, n + 1);
      const h = site.holds[n % Math.max(site.holds.length, 1)];
      give(b, role, h?.position ?? site.centre, h?.look ?? site.centre, false, `${site.name}:${role}:${n}`);
    });
  }
}

/** Sets an order on a bot, keeping the same object (no repath) when nothing changed. */
function give(b: Bot, role: BotRole, goal: THREE.Vector3, look: THREE.Vector3 | null, use: boolean, tag: string): void {
  const o = b.order;
  if (o && o.tag === tag && o.goal.distanceToSquared(goal) < 0.25 && o.use === use) return;
  const order: BotOrder = { role, goal: goal.clone(), look: look ? look.clone() : null, use, tag };
  b.order = order;
}

function byId(a: Bot, b: Bot): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
