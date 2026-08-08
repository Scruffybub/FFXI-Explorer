import type { ParsedAnimation, ParsedSkeleton } from './ffxi-dat'

/**
 * CPU skinning for FFXI character and monster models.
 *
 * Ported from Vanalytics `hooks/useAnimationPlayback.ts`, with the React and
 * three.js parts split off so the maths can be tested on its own.
 *
 * Skinning happens on the CPU rather than in a shader because `parseVertexBlock`
 * hands us vertices already transformed into world space by the bind pose, plus
 * per-vertex bone-local positions for the dual-bone case. That is the shape of
 * the original data; rebuilding it into a three.js SkinnedMesh would mean
 * inverting work the parser already did.
 *
 * All matrices are row-major 4x4 as flat arrays of 16, matching SkeletonParser.
 */

/** Quaternion + translation to a row-major 4x4. */
export function quatToMatrix(
  qi: number, qj: number, qk: number, qw: number,
  tx: number, ty: number, tz: number,
): number[] {
  const xx = qi * qi, yy = qj * qj, zz = qk * qk
  const xy = qi * qj, xz = qi * qk, yz = qj * qk
  const wx = qw * qi, wy = qw * qj, wz = qw * qk
  return [
    1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy), 0,
    2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx), 0,
    2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy), 0,
    tx, ty, tz, 1,
  ]
}

export function mat4Multiply(a: number[], b: number[]): number[] {
  const r = new Array(16).fill(0)
  for (let row = 0; row < 4; row++)
    for (let col = 0; col < 4; col++)
      for (let k = 0; k < 4; k++)
        r[row * 4 + col] += a[row * 4 + k] * b[k * 4 + col]
  return r
}

/**
 * Invert a rigid-body matrix (rotation + translation only).
 * Bone matrices never carry scale or skew, so the transpose-and-negate shortcut
 * is exact and far cheaper than a general inverse.
 */
export function invertRigidMatrix4(m: number[]): number[] {
  const r00 = m[0], r01 = m[4], r02 = m[8]
  const r10 = m[1], r11 = m[5], r12 = m[9]
  const r20 = m[2], r21 = m[6], r22 = m[10]
  const tx = m[12], ty = m[13], tz = m[14]
  return [
    r00, r01, r02, 0,
    r10, r11, r12, 0,
    r20, r21, r22, 0,
    -(tx * r00 + ty * r10 + tz * r20),
    -(tx * r01 + ty * r11 + tz * r21),
    -(tx * r02 + ty * r12 + tz * r22),
    1,
  ]
}

export function quatMultiply(
  ax: number, ay: number, az: number, aw: number,
  bx: number, by: number, bz: number, bw: number,
): [number, number, number, number] {
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ]
}

export function quatSlerp(
  ax: number, ay: number, az: number, aw: number,
  bx: number, by: number, bz: number, bw: number,
  t: number,
): [number, number, number, number] {
  let dot = ax * bx + ay * by + az * bz + aw * bw
  if (dot < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; dot = -dot }
  if (dot > 0.9995) {
    const x = ax + (bx - ax) * t, y = ay + (by - ay) * t
    const z = az + (bz - az) * t, w = aw + (bw - aw) * t
    const len = Math.hypot(x, y, z, w) || 1
    return [x / len, y / len, z / len, w / len]
  }
  const theta = Math.acos(dot)
  const sinT = Math.sin(theta)
  const wa = Math.sin((1 - t) * theta) / sinT
  const wb = Math.sin(t * theta) / sinT
  return [wa * ax + wb * bx, wa * ay + wb * by, wa * az + wb * bz, wa * aw + wb * bw]
}

/** A mesh prepared for per-frame skinning. */
export interface SkinTarget {
  /** The live position attribute array, rewritten each frame. */
  positions: Float32Array
  /** Bind-pose positions, kept intact as the source for single-bone skinning. */
  origPositions: Float32Array
  /** Four bone slots per vertex; slots 0 and 1 are used. */
  boneIndices: Uint8Array
  dualBone?: {
    localPos1: Float32Array
    localPos2: Float32Array
    weights: Float32Array
  }
}

export interface PoseResult {
  /** World-space bone matrices for this frame. */
  worldMats: number[][]
  /** inverseBind * world, for single-bone vertices. */
  deformMats: number[][]
}

/**
 * Build this frame's bone matrices.
 *
 * `time` is in seconds. Animation frames advance at 30 per second scaled by the
 * clip's own speed, matching the game's playback rate.
 */
export function poseSkeleton(
  skeleton: ParsedSkeleton,
  animations: ParsedAnimation[],
  inverseBind: number[][],
  time: number,
): PoseResult {
  const boneCount = skeleton.bones.length

  // Start from the bind pose; animations overwrite only the bones they drive.
  const localMats: number[][] = new Array(boneCount)
  for (let i = 0; i < boneCount; i++) {
    const b = skeleton.bones[i]
    localMats[i] = quatToMatrix(
      b.rotation[0], b.rotation[1], b.rotation[2], b.rotation[3],
      b.position[0], b.position[1], b.position[2],
    )
  }

  for (const anim of animations) {
    let j = 0, n = 0, j1 = 0
    if (anim.frameCount > 1) {
      const total = anim.frameCount - 1
      const frame = ((time * anim.speed * 30) % total + total) % total
      j = Math.floor(frame)
      n = frame - j
      j1 = Math.min(j + 1, total)
    }

    for (const ab of anim.bones) {
      if (ab.boneIndex < 0 || ab.boneIndex >= boneCount) continue
      const bone = skeleton.bones[ab.boneIndex]

      let mqx: number, mqy: number, mqz: number, mqw: number
      if (ab.rotationKeyframes && anim.frameCount > 1) {
        const kf = ab.rotationKeyframes
        ;[mqx, mqy, mqz, mqw] = quatSlerp(
          kf[j * 4], kf[j * 4 + 1], kf[j * 4 + 2], kf[j * 4 + 3],
          kf[j1 * 4], kf[j1 * 4 + 1], kf[j1 * 4 + 2], kf[j1 * 4 + 3], n,
        )
      } else {
        [mqx, mqy, mqz, mqw] = ab.rotationDefault
      }

      let mtx: number, mty: number, mtz: number
      if (ab.translationKeyframes && anim.frameCount > 1) {
        const kf = ab.translationKeyframes
        mtx = kf[j * 3] + (kf[j1 * 3] - kf[j * 3]) * n
        mty = kf[j * 3 + 1] + (kf[j1 * 3 + 1] - kf[j * 3 + 1]) * n
        mtz = kf[j * 3 + 2] + (kf[j1 * 3 + 2] - kf[j * 3 + 2]) * n
      } else {
        [mtx, mty, mtz] = ab.translationDefault
      }

      // The animated local transform composes onto the bind pose:
      // rotation = animQ * bindQ, translation = bindT + animT. Note the
      // quaternion order — R(A)*R(B) is R(B*A), so the animation quaternion
      // comes first even though it is applied "after" the bind rotation.
      const [rx, ry, rz, rw] = quatMultiply(
        mqx, mqy, mqz, mqw,
        bone.rotation[0], bone.rotation[1], bone.rotation[2], bone.rotation[3],
      )
      localMats[ab.boneIndex] = quatToMatrix(
        rx, ry, rz, rw,
        bone.position[0] + mtx, bone.position[1] + mty, bone.position[2] + mtz,
      )
    }
  }

  // Cascade to world space. Bones are ordered parents-first, so a single
  // forward pass suffices.
  const worldMats: number[][] = new Array(boneCount)
  for (let i = 0; i < boneCount; i++) {
    const parent = skeleton.bones[i].parentIndex
    worldMats[i] = (parent < 0 || parent >= i)
      ? localMats[i]
      : mat4Multiply(localMats[i], worldMats[parent])
  }

  const deformMats: number[][] = new Array(boneCount)
  for (let i = 0; i < boneCount; i++) {
    deformMats[i] = mat4Multiply(inverseBind[i], worldMats[i])
  }

  return { worldMats, deformMats }
}

/** Write this frame's skinned vertex positions into each mesh. */
export function skinMeshes(targets: SkinTarget[], pose: PoseResult): void {
  const { worldMats, deformMats } = pose

  for (const t of targets) {
    const vertCount = t.origPositions.length / 3

    if (t.dualBone) {
      // Dual-bone vertices store a position in each bone's local space, and the
      // weight rides in the homogeneous coordinate rather than scaling the
      // result — so translation is weighted too. That is what the original
      // D3DXVec4Transform did, and halving it to a plain lerp pulls joints in.
      const { localPos1, localPos2, weights } = t.dualBone
      for (let v = 0; v < vertCount; v++) {
        const bi1 = t.boneIndices[v * 4]
        const bi2 = t.boneIndices[v * 4 + 1]
        const w1 = weights[v * 2], w2 = weights[v * 2 + 1]

        let px = 0, py = 0, pz = 0
        const m1 = bi1 < worldMats.length ? worldMats[bi1] : null
        if (m1) {
          const x = localPos1[v * 3], y = localPos1[v * 3 + 1], z = localPos1[v * 3 + 2]
          px += x * m1[0] + y * m1[4] + z * m1[8] + w1 * m1[12]
          py += x * m1[1] + y * m1[5] + z * m1[9] + w1 * m1[13]
          pz += x * m1[2] + y * m1[6] + z * m1[10] + w1 * m1[14]
        }
        const m2 = (bi2 < worldMats.length && w2 > 0) ? worldMats[bi2] : null
        if (m2) {
          const x = localPos2[v * 3], y = localPos2[v * 3 + 1], z = localPos2[v * 3 + 2]
          px += x * m2[0] + y * m2[4] + z * m2[8] + w2 * m2[12]
          py += x * m2[1] + y * m2[5] + z * m2[9] + w2 * m2[13]
          pz += x * m2[2] + y * m2[6] + z * m2[10] + w2 * m2[14]
        }

        t.positions[v * 3] = px
        t.positions[v * 3 + 1] = py
        t.positions[v * 3 + 2] = pz
      }
    } else {
      for (let v = 0; v < vertCount; v++) {
        const bi = t.boneIndices[v * 4]
        if (bi >= deformMats.length) continue
        const dm = deformMats[bi]
        const ox = t.origPositions[v * 3]
        const oy = t.origPositions[v * 3 + 1]
        const oz = t.origPositions[v * 3 + 2]
        t.positions[v * 3] = dm[0] * ox + dm[4] * oy + dm[8] * oz + dm[12]
        t.positions[v * 3 + 1] = dm[1] * ox + dm[5] * oy + dm[9] * oz + dm[13]
        t.positions[v * 3 + 2] = dm[2] * ox + dm[6] * oy + dm[10] * oz + dm[14]
      }
    }
  }
}
