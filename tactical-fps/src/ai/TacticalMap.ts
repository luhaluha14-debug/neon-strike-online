import * as THREE from 'three';
import type { BombSite, LoadedMap } from '../world/MapLoader';
import type { NavGrid } from './NavGrid';

/** A place to stand and where to look from it. */
export interface Spot {
  readonly position: THREE.Vector3;
  /** A point to watch from there (an approach into the site). */
  readonly look: THREE.Vector3;
}

/** Tactical data of one bomb site, derived from the map once. */
export interface SiteInfo {
  readonly name: string;
  readonly centre: THREE.Vector3;
  /** Walkable cells inside the site (where the C4 can be planted). */
  readonly plantSpots: THREE.Vector3[];
  /**
   * Ways in: walkable points on a ring around the site, one per direction
   * sector, ordered by angle. Different entrances lead attackers along
   * different corridors (split / flank).
   */
  readonly entrances: THREE.Vector3[];
  /** Covered spots in and around the site (a wall or object at the side), each watching an entrance. */
  readonly holds: Spot[];
}

const ENTRANCE_MIN = 9;
const ENTRANCE_MAX = 17;
const SECTORS = 8;
const HOLD_RADIUS = 9;
const _o = new THREE.Vector3();
const _d = new THREE.Vector3();

/**
 * Where bots go for the bomb objective, worked out from the nav grid and the
 * map collision when a match starts (no hand-placed waypoints): plant spots,
 * entrances around each site and covered hold spots. Nothing here knows
 * where any enemy is.
 */
export class TacticalMap {
  readonly sites: SiteInfo[];
  /** A walkable point between the sites (defensive rotation). */
  readonly mid: THREE.Vector3;
  readonly buildMs: number;

  constructor(
    private readonly map: LoadedMap,
    private readonly nav: NavGrid,
    sites: readonly BombSite[],
  ) {
    const t0 = performance.now();
    this.sites = sites.map((s) => this.analyseSite(s));
    const m = new THREE.Vector3();
    for (const s of this.sites) m.add(s.centre);
    m.multiplyScalar(1 / Math.max(this.sites.length, 1));
    const c = nav.nearestWalkable(m);
    this.mid = c >= 0 ? nav.center(c) : m;
    this.buildMs = performance.now() - t0;
  }

  site(name: string): SiteInfo | undefined {
    return this.sites.find((s) => s.name === name);
  }

  /**
   * Entrances of `site` ordered by how directly they face `from` (the side
   * a team comes from): the first is the main way in, the last the widest flank.
   */
  entrancesFrom(site: SiteInfo, from: THREE.Vector3): THREE.Vector3[] {
    const a0 = Math.atan2(from.z - site.centre.z, from.x - site.centre.x);
    const off = (p: THREE.Vector3) => Math.abs(wrap(Math.atan2(p.z - site.centre.z, p.x - site.centre.x) - a0));
    return [...site.entrances].filter((p) => off(p) < Math.PI * 0.7).sort((a, b) => off(a) - off(b));
  }

  private analyseSite(s: BombSite): SiteInfo {
    const nav = this.nav;
    const box = s.box.clone();
    box.min.y -= 0.4;
    box.max.y = Math.max(box.max.y, box.min.y + 3);
    const centre = box.getCenter(new THREE.Vector3());
    const plantSpots: THREE.Vector3[] = [];
    const sectorBest: (THREE.Vector3 | null)[] = new Array(SECTORS).fill(null);
    const sectorScore = new Array(SECTORS).fill(Infinity);
    const holdCandidates: { p: THREE.Vector3; cover: number }[] = [];
    const ringMid = (ENTRANCE_MIN + ENTRANCE_MAX) / 2;
    for (const cell of nav.walkable) {
      const p = nav.center(cell);
      const dx = p.x - centre.x;
      const dz = p.z - centre.z;
      const d = Math.hypot(dx, dz);
      if (Math.abs(p.y - box.min.y) > 4) continue;
      if (box.containsPoint(_o.set(p.x, p.y + 0.05, p.z))) plantSpots.push(p);
      if (d >= ENTRANCE_MIN && d <= ENTRANCE_MAX) {
        const k = Math.floor(((Math.atan2(dz, dx) + Math.PI) / (Math.PI * 2)) * SECTORS) % SECTORS;
        // Prefer the middle of the ring with a clear walk to the site.
        const score = Math.abs(d - ringMid);
        if (score < sectorScore[k]) {
          sectorScore[k] = score;
          sectorBest[k] = p;
        }
      }
      if (d <= HOLD_RADIUS) {
        const cover = this.coverAt(p);
        if (cover > 0) holdCandidates.push({ p, cover });
      }
    }
    // Entrances must really connect to the site.
    const entrances = sectorBest.filter((p): p is THREE.Vector3 => !!p && !!nav.findPath(p, centre, 4000));
    // Holds: best covered spots spread at least 3 m apart, each watching the entrance it sees best.
    holdCandidates.sort((a, b) => b.cover - a.cover || a.p.distanceToSquared(centre) - b.p.distanceToSquared(centre));
    const holds: Spot[] = [];
    for (const c of holdCandidates) {
      if (holds.length >= 8) break;
      if (holds.some((h) => h.position.distanceTo(c.p) < 3)) continue;
      const look = this.watchFrom(c.p, entrances);
      if (look) holds.push({ position: c.p, look });
    }
    if (holds.length === 0 && plantSpots.length) holds.push({ position: plantSpots[0], look: entrances[0] ?? centre });
    return { name: s.name, centre: plantSpots.length ? closest(plantSpots, centre) : centre, plantSpots, entrances, holds };
  }

  /** Number of horizontal directions (of 8) with something solid within 1.4 m at waist height. */
  private coverAt(p: THREE.Vector3): number {
    let n = 0;
    _o.set(p.x, p.y + 1, p.z);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      _d.set(Math.cos(a), 0, Math.sin(a));
      if (this.map.collision.raycast(_o, _d, 1.4) !== null) n++;
    }
    // Fully boxed in (a corner pocket) is not a useful hold.
    return n >= 6 ? 0 : n;
  }

  /** The entrance with a clear line of sight from eye height at `p` (nearest first), or null. */
  private watchFrom(p: THREE.Vector3, entrances: readonly THREE.Vector3[]): THREE.Vector3 | null {
    const eye = _o.set(p.x, p.y + 1.6, p.z);
    let best: THREE.Vector3 | null = null;
    let bestD = Infinity;
    for (const e of entrances) {
      _d.set(e.x - eye.x, e.y + 1.4 - eye.y, e.z - eye.z);
      const len = _d.length();
      if (len < 1 || len > 30) continue;
      if (this.map.collision.raycast(eye, _d.normalize(), len) !== null) continue;
      if (len < bestD) {
        bestD = len;
        best = e;
      }
    }
    return best;
  }
}

function closest(list: readonly THREE.Vector3[], to: THREE.Vector3): THREE.Vector3 {
  let best = list[0];
  for (const p of list) if (p.distanceToSquared(to) < best.distanceToSquared(to)) best = p;
  return best;
}

function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
