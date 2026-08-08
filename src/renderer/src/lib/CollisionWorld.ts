import * as THREE from 'three'
import { MeshBVH } from 'three-mesh-bvh'
import type { ParsedCollision } from './ffxi-dat'

/**
 * Queryable collision for a zone: the MZB collision mesh converted to world
 * space and wrapped in a BVH.
 *
 * ── Coordinate space ──
 * CollisionParser emits raw DAT space, matching the MMB prefab convention, and
 * the renderer puts that under `rotation={[Math.PI,0,0]}`. Rotating PI about X
 * maps (x, y, z) to (x, -y, -z). We bake that here once, so every query runs in
 * the same world space the camera lives in and no call site has to remember to
 * convert. The wireframe overlay reads this same geometry, so what you see is
 * literally what you collide with.
 *
 * ── Why a BVH ──
 * West Ronfaure's collision is ~429k triangles. A naive raycast tests all of
 * them; at three ground queries plus two sweeps per frame that is far past
 * budget. three-mesh-bvh builds the tree once per zone (a few hundred ms) and
 * makes each query a log-depth descent.
 */
export class CollisionWorld {
  /** World-space collision geometry. Shared with the debug overlay. */
  readonly geometry: THREE.BufferGeometry
  private readonly bvh: MeshBVH

  // Reused across queries — allocating a Ray per frame is how you get GC hitches.
  private readonly ray = new THREE.Ray()
  private readonly down = new THREE.Vector3(0, -1, 0)

  constructor(collision: ParsedCollision) {
    const src = collision.vertices
    const world = new Float32Array(src.length)
    for (let i = 0; i < src.length; i += 3) {
      world[i] = src[i]
      world[i + 1] = -src[i + 1]
      world[i + 2] = -src[i + 2]
    }

    // Negating two axes mirrors the mesh, which reverses triangle winding.
    // Front/back matters for one-sided raycasts, so flip it back here rather
    // than forcing every query to use DoubleSide.
    const srcIdx = collision.indices
    const idx = new Uint32Array(srcIdx.length)
    for (let i = 0; i < srcIdx.length; i += 3) {
      idx[i] = srcIdx[i]
      idx[i + 1] = srcIdx[i + 2]
      idx[i + 2] = srcIdx[i + 1]
    }

    this.geometry = new THREE.BufferGeometry()
    this.geometry.setAttribute('position', new THREE.BufferAttribute(world, 3))
    this.geometry.setIndex(new THREE.BufferAttribute(idx, 1))
    this.geometry.computeBoundingSphere()

    this.bvh = new MeshBVH(this.geometry)
  }

  /**
   * Nearest surface straight down from `from`, searching at most `maxDrop`.
   * Returns world height and surface normal, or null over a hole.
   *
   * DoubleSide throughout: FFXI's collision is not reliably wound outward, and
   * a one-sided test silently falls through floors that happen to face away.
   */
  groundBelow(
    from: THREE.Vector3,
    maxDrop: number,
  ): { y: number; normal: THREE.Vector3 } | null {
    this.ray.origin.copy(from)
    this.ray.direction.copy(this.down)
    const hit = this.bvh.raycastFirst(this.ray, THREE.DoubleSide, 0, maxDrop)
    if (!hit) return null

    const normal = hit.face
      ? hit.face.normal.clone()
      : new THREE.Vector3(0, 1, 0)
    // Normals point either way for the same reason; we only ever want the
    // upward-facing interpretation of a floor.
    if (normal.y < 0) normal.negate()
    return { y: hit.point.y, normal }
  }

  /**
   * First obstruction between `from` and `from + dir * distance`.
   * `dir` must be normalised.
   */
  castRay(
    from: THREE.Vector3,
    dir: THREE.Vector3,
    distance: number,
  ): { distance: number; normal: THREE.Vector3 } | null {
    this.ray.origin.copy(from)
    this.ray.direction.copy(dir)
    const hit = this.bvh.raycastFirst(this.ray, THREE.DoubleSide, 0, distance)
    if (!hit) return null
    return {
      distance: hit.distance,
      normal: hit.face ? hit.face.normal.clone() : new THREE.Vector3(0, 1, 0),
    }
  }

  dispose(): void {
    this.geometry.dispose()
  }
}
