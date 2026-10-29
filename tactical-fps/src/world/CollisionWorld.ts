import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { ExtendedTriangle } from 'three-mesh-bvh';

export interface CapsuleHit {
  /** Contact with a surface flat enough to stand on. */
  grounded: boolean;
  /** Normal of the flattest walkable surface touched (valid when grounded). */
  groundNormal: THREE.Vector3;
  /** Touched something above the capsule while moving up. */
  hitCeiling: boolean;
}

const _box = new THREE.Box3();
const _triPoint = new THREE.Vector3();
const _capPoint = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _ray = new THREE.Ray();

/**
 * Static world collision, baked in world space into BVHs:
 * - `solid`: map geometry; blocks players and bullets.
 * - `clip` (optional): invisible player-clip walls; blocks players only.
 */
export class CollisionWorld {
  readonly solid: MeshBVH;
  readonly clip: MeshBVH | null;
  readonly triangleCount: number;
  /** BVHs that block movement. */
  private readonly movementBvhs: MeshBVH[];

  constructor(solidGeometry: THREE.BufferGeometry, clipGeometry: THREE.BufferGeometry | null = null) {
    this.solid = new MeshBVH(solidGeometry, { targetLeafSize: 10 });
    this.clip = clipGeometry ? new MeshBVH(clipGeometry, { targetLeafSize: 10 }) : null;
    this.movementBvhs = this.clip ? [this.solid, this.clip] : [this.solid];
    const count = (g: THREE.BufferGeometry | null) =>
      g ? (g.getIndex()?.count ?? g.getAttribute('position').count) / 3 : 0;
    this.triangleCount = count(solidGeometry) + count(clipGeometry);
  }

  /**
   * Pushes a capsule (segment + radius) out of all overlapping triangles.
   * `segment` is modified in place. Walkable contacts are resolved straight
   * up so the player does not slide down ramps while standing still.
   */
  resolveCapsule(segment: THREE.Line3, radius: number, walkableNormalY: number, out: CapsuleHit): void {
    out.grounded = false;
    out.hitCeiling = false;
    out.groundNormal.set(0, 1, 0);
    let bestGroundY = -1;

    // A few passes settle corners where two surfaces push against each other.
    for (let pass = 0; pass < 3; pass++) {
      let moved = false;
      _box.makeEmpty();
      _box.expandByPoint(segment.start);
      _box.expandByPoint(segment.end);
      _box.min.addScalar(-radius);
      _box.max.addScalar(radius);

      for (const bvh of this.movementBvhs) {
        bvh.shapecast({
        intersectsBounds: (box) => box.intersectsBox(_box),
        intersectsTriangle: (tri: ExtendedTriangle) => {
          const dist = tri.closestPointToSegment(segment, _triPoint, _capPoint);
          if (dist >= radius) return false;

          if (dist > 1e-6) {
            _dir.subVectors(_capPoint, _triPoint).divideScalar(dist);
          } else {
            // Segment touches the triangle plane: use the face normal.
            tri.getNormal(_dir);
          }
          const depth = radius - dist;

          if (_dir.y >= walkableNormalY) {
            // Floor/ramp: lift vertically by the amount needed along the normal.
            const lift = depth / _dir.y;
            segment.start.y += lift;
            segment.end.y += lift;
            out.grounded = true;
            if (_dir.y > bestGroundY) {
              bestGroundY = _dir.y;
              out.groundNormal.copy(_dir);
            }
          } else {
            if (_dir.y < -0.3) out.hitCeiling = true;
            segment.start.addScaledVector(_dir, depth);
            segment.end.addScaledVector(_dir, depth);
          }
          moved = true;
          return false;
        },
      });
      }

      if (!moved) break;
    }
  }

  /** True if the capsule overlaps any solid geometry (used for stand-up checks). */
  capsuleOverlaps(segment: THREE.Line3, radius: number): boolean {
    _box.makeEmpty();
    _box.expandByPoint(segment.start);
    _box.expandByPoint(segment.end);
    _box.min.addScalar(-radius);
    _box.max.addScalar(radius);
    return this.movementBvhs.some((bvh) =>
      bvh.shapecast({
        intersectsBounds: (box) => box.intersectsBox(_box),
        intersectsTriangle: (tri: ExtendedTriangle) => tri.closestPointToSegment(segment, _triPoint, _capPoint) < radius,
      }),
    );
  }

  /**
   * Nearest hit distance along a normalized direction, or null.
   * Bullets use solid geometry only; movement queries pass `includeClip`.
   */
  raycast(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    far: number,
    outNormal?: THREE.Vector3,
    includeClip = false,
  ): number | null {
    _ray.origin.copy(origin);
    _ray.direction.copy(direction);
    let hit = this.solid.raycastFirst(_ray, THREE.DoubleSide, 0, far);
    if (includeClip && this.clip) {
      const clipHit = this.clip.raycastFirst(_ray, THREE.DoubleSide, 0, hit ? hit.distance : far);
      if (clipHit) hit = clipHit;
    }
    if (!hit) return null;
    if (outNormal && hit.face) outNormal.copy(hit.face.normal);
    return hit.distance;
  }
}
