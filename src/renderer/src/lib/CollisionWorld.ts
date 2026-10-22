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
  /** Each triangle's ground type (ParsedCollision.terrain), by original triangle index. */
  readonly terrain: Uint8Array

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

    // Indirect: the BVH keeps its own triangle order and leaves the index
    // alone, so a hit's faceIndex still names the parser's triangle (terrain).
    this.bvh = new MeshBVH(this.geometry, { indirect: true })
    this.terrain = collision.terrain ?? new Uint8Array(idx.length / 3)
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
  ): { y: number; normal: THREE.Vector3; terrain: number } | null {
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
    return { y: hit.point.y, normal, terrain: hit.faceIndex != null ? this.terrain[hit.faceIndex] ?? 0 : 0 }
  }

  /**
   * Somewhere a walker can stand, as near `preferred` as possible: a floor no
   * steeper than `slopeCos`, with `headroom` clear above it and level ground
   * `footing` units out all round. Each column is
   * searched through every layer (a bridge over a river, a floor under a
   * roof), choosing the layer nearest `preferred`'s height; the columns are
   * `preferred` itself, then rings around it every `step` units out to
   * `maxRadius`. Returns the feet position, or null if nothing qualifies.
   *
   * Walk mode used to drop straight down from above the zone's bounding-box
   * centre and take the first surface: in open zones that centre can sit over
   * a gap between islands, and with no floor ever found the walker fell
   * forever (README "Walking mode", 2026-10-17).
   */
  findStandingSpot(
    preferred: THREE.Vector3,
    opts: { slopeCos: number; headroom: number; footing: number; stepHeight: number; step: number; maxRadius: number },
  ): THREE.Vector3 | null {
    const box = this.geometry.boundingBox ?? (this.geometry.computeBoundingBox(), this.geometry.boundingBox!)
    const top = box.max.y + 5, depth = box.max.y - box.min.y + 10
    const up = new THREE.Vector3(0, 1, 0)
    const from = new THREE.Vector3()
    const column = (x: number, z: number): THREE.Vector3 | null => {
      let best: THREE.Vector3 | null = null
      from.set(x, top, z)
      for (let layer = 0, left = depth; layer < 32 && left > 0; layer++) {
        const hit = this.groundBelow(from, left)
        if (!hit) break
        left -= from.y - hit.y + 0.05
        from.y = hit.y - 0.05
        if (hit.normal.y < opts.slopeCos) continue
        const feet = new THREE.Vector3(x, hit.y, z)
        if (this.castRay(feet.clone().setY(hit.y + 0.05), up, opts.headroom)) continue
        // Room to stand, not a post-top or a ledge's lip: ground within a step
        // all round, a body's width out. Bibiki Bay's first pick was a spot the
        // walker slid off at once and fell 490 units.
        let footing = true
        for (let k = 0; k < 8 && footing; k++) {
          const a = (k / 8) * Math.PI * 2
          const probe = new THREE.Vector3(x + Math.cos(a) * opts.footing, hit.y + opts.stepHeight, z + Math.sin(a) * opts.footing)
          const g = this.groundBelow(probe, opts.stepHeight * 2)
          if (!g || g.normal.y < opts.slopeCos) footing = false
        }
        if (!footing) continue
        if (!best || Math.abs(hit.y - preferred.y) < Math.abs(best.y - preferred.y)) best = feet
      }
      return best
    }
    const here = column(preferred.x, preferred.z)
    if (here) return here
    for (let r = opts.step; r <= opts.maxRadius; r += opts.step) {
      const n = Math.max(8, Math.round((2 * Math.PI * r) / opts.step))
      let best: THREE.Vector3 | null = null
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2
        const spot = column(preferred.x + Math.cos(a) * r, preferred.z + Math.sin(a) * r)
        if (spot && (!best || Math.abs(spot.y - preferred.y) < Math.abs(best.y - preferred.y))) best = spot
      }
      if (best) return best
    }
    return null
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

  /**
   * How far to push a sphere at `center` so it is no longer inside any wall.
   * Returns a horizontal correction, or null if it is already clear.
   *
   * Rays alone cannot do this. A ray is a zero-thickness line along the
   * direction of travel, so approaching a wall at an angle — where sliding
   * leaves you moving nearly parallel to it — the ray stops hitting the wall
   * while the body is still overlapping it, and you creep through sideways a
   * little each frame. Giving the body real volume is the only fix.
   *
   * Floor-like faces are ignored: standing on the ground would otherwise
   * register as penetration and shove you around.
   */
  depenetrate(
    center: THREE.Vector3,
    radius: number,
    slopeCos: number,
  ): THREE.Vector3 | null {
    const sphere = new THREE.Sphere(center, radius)
    const normal = new THREE.Vector3()
    const closest = new THREE.Vector3()
    const away = new THREE.Vector3()
    const push = new THREE.Vector3()
    let contacts = 0

    this.bvh.shapecast({
      intersectsBounds: (box) => box.intersectsSphere(sphere),
      intersectsTriangle: (tri) => {
        tri.getNormal(normal)
        if (Math.abs(normal.y) >= slopeCos) return false // floor, not a wall

        tri.closestPointToPoint(sphere.center, closest)
        const dist = closest.distanceTo(sphere.center)
        if (dist >= radius) return false

        away.subVectors(sphere.center, closest)
        away.y = 0
        if (away.lengthSq() < 1e-10) {
          // Dead centre on the face — back out along its own normal instead.
          away.set(normal.x, 0, normal.z)
          if (away.lengthSq() < 1e-10) return false
        }
        away.normalize()
        push.addScaledVector(away, radius - dist)
        contacts++
        return false
      },
    })

    if (contacts === 0) return null
    // Corners produce several contacts at once; summing handles them, but cap
    // the result so a pile-up cannot fling the body across the zone.
    if (push.length() > radius) push.setLength(radius)
    return push
  }

  dispose(): void {
    this.geometry.dispose()
  }
}
