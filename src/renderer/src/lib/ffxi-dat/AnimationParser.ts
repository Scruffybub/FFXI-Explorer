import { DatReader } from './DatReader'
import type { ParsedAnimation, AnimationBone } from './types'

/**
 * Parses animation blocks (type 0x2B) from an FFXI DAT.
 *
 * Ported from Vanalytics `lib/ffxi-dat/AnimationParser.ts`. NPC and monster
 * DATs carry their animations inline alongside the mesh and skeleton, typically
 * one to three blocks covering upper body, lower body and extras.
 *
 * ── Layout ──
 * Each block opens with a 10-byte header (ver, nazo, element, frameCount,
 * speed), followed by `element` bone descriptors of 84 bytes each. A descriptor
 * holds, for rotation, translation and scale: an int32 index into a shared pool
 * of floats, plus a default value used when that index is zero.
 *
 * The pool is not a separate section — indices count floats from the start of
 * the descriptor array, so keyframe data lives interleaved after it. Frame `f`
 * of a component reads `pool[idx + f]`.
 *
 * A descriptor whose `idx_qtx` has the high bit set is not animated at all.
 */

const BLOCK_ANIM = 0x2B
const DATHEAD_SIZE = 8
const BLOCK_PADDING = 8
const DAT2B_HEADER_SIZE = 10
const DAT2B_BONE_SIZE = 84

export function parseAnimationDat(buffer: ArrayBuffer): ParsedAnimation[] {
  const reader = new DatReader(buffer)
  const animations: ParsedAnimation[] = []

  let offset = 0
  while (offset < reader.length - DATHEAD_SIZE) {
    reader.seek(offset)
    reader.skip(4) // block name
    const packed = reader.readUint32()
    const type = packed & 0x7F
    const nextUnits = (packed >> 7) & 0x7FFFF
    const blockSize = nextUnits * 16

    if (type === BLOCK_ANIM) {
      try {
        const anim = parseAnimBlock(reader, offset + DATHEAD_SIZE + BLOCK_PADDING)
        if (anim) animations.push(anim)
      } catch { /* a bad block must not lose the rest */ }
    }

    if (nextUnits === 0) break
    offset += blockSize
    if (offset > reader.length) break
  }

  return animations
}

function parseAnimBlock(reader: DatReader, dataStart: number): ParsedAnimation | null {
  reader.seek(dataStart)
  reader.skip(2) // ver + nazo
  const element = reader.readUint16()
  const frameCount = reader.readUint16()
  const speed = reader.readFloat32()

  if (element === 0 || frameCount === 0 || element > 500) return null

  const poolBase = dataStart + DAT2B_HEADER_SIZE
  const bones: AnimationBone[] = []

  for (let i = 0; i < element; i++) {
    reader.seek(dataStart + DAT2B_HEADER_SIZE + i * DAT2B_BONE_SIZE)

    const boneIndex = reader.readInt32()

    const idxQx = reader.readInt32()
    const idxQy = reader.readInt32()
    const idxQz = reader.readInt32()
    const idxQw = reader.readInt32()
    const qx = reader.readFloat32()
    const qy = reader.readFloat32()
    const qz = reader.readFloat32()
    const qw = reader.readFloat32()

    const idxTx = reader.readInt32()
    const idxTy = reader.readInt32()
    const idxTz = reader.readInt32()
    const tx = reader.readFloat32()
    const ty = reader.readFloat32()
    const tz = reader.readFloat32()

    const idxSx = reader.readInt32()
    const idxSy = reader.readInt32()
    const idxSz = reader.readInt32()
    const sx = reader.readFloat32()
    const sy = reader.readFloat32()
    const sz = reader.readFloat32()

    // High bit on the first index marks a bone this animation does not drive.
    if (idxQx & 0x80000000) continue

    bones.push({
      boneIndex,
      rotationKeyframes: readKeyframes(reader, poolBase, frameCount,
        [idxQx, idxQy, idxQz, idxQw], [qx, qy, qz, qw]),
      rotationDefault: [qx, qy, qz, qw],
      translationKeyframes: readKeyframes(reader, poolBase, frameCount,
        [idxTx, idxTy, idxTz], [tx, ty, tz]),
      translationDefault: [tx, ty, tz],
      scaleKeyframes: readKeyframes(reader, poolBase, frameCount,
        [idxSx, idxSy, idxSz], [sx, sy, sz]),
      scaleDefault: [sx, sy, sz],
    })
  }

  return { frameCount, speed, bones }
}

/**
 * Read one component group's keyframes out of the float pool.
 *
 * An index of zero means that component is constant, and takes the descriptor's
 * stored default rather than a hardcoded 0 or 1 — the distinction matters,
 * since a constant quaternion component of 0 and of 1 are very different poses.
 * Returns null when no component of the group is animated.
 */
function readKeyframes(
  reader: DatReader,
  poolBase: number,
  frameCount: number,
  indices: number[],
  defaults: number[],
): Float32Array | null {
  if (indices.every(i => i === 0)) return null

  const stride = indices.length
  const out = new Float32Array(frameCount * stride)
  for (let f = 0; f < frameCount; f++) {
    for (let c = 0; c < stride; c++) {
      if (indices[c] > 0) {
        reader.seek(poolBase + (indices[c] + f) * 4)
        out[f * stride + c] = reader.readFloat32()
      } else {
        out[f * stride + c] = defaults[c]
      }
    }
  }
  return out
}
