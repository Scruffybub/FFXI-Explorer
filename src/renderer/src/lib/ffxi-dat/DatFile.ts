import { DatReader } from './DatReader'
import { parseTextureBlock } from './TextureParser'
import { parseVertexBlock } from './MeshParser'
import { parseSkeleton } from './SkeletonParser'
import type { ParsedDatFile, ParsedMesh, ParsedTexture, ParsedSkeleton } from './types'

/**
 * Loads an FFXI DAT file containing a 3D model — NPCs, monsters, equipment,
 * faces and hair.
 *
 * Ported from Vanalytics `lib/ffxi-dat/DatFile.ts`, the loader that was left
 * behind when the zone renderer was extracted. Everything it calls
 * (`parseVertexBlock`, `parseSkeleton`, `parseTextureBlock`) already came
 * across with that port and has been sitting unused.
 *
 * Animation blocks (0x2B) are recognised but not yet decoded — `AnimationParser`
 * is the other file still to port. `animations` is always empty for now, which
 * is why models load in their bind pose.
 */

const BLOCK_IMG = 0x20
const BLOCK_BONE = 0x29
const BLOCK_VERTEX = 0x2A
export const BLOCK_ANIM = 0x2B

const DATHEAD_SIZE = 8
const BLOCK_PADDING = 8
/** NPC and monster DATs routinely carry 100+ blocks. */
const BLOCK_LIMIT = 500

interface DatBlock {
  type: number
  dataOffset: number
  dataLength: number
}

function parseBlockChain(reader: DatReader): DatBlock[] {
  const blocks: DatBlock[] = []
  let offset = 0

  while (offset < reader.length - DATHEAD_SIZE) {
    reader.seek(offset)
    reader.skip(4) // block name
    const packed = reader.readUint32()
    const type = packed & 0x7F
    const nextUnits = (packed >> 7) & 0x7FFFF
    const blockSize = nextUnits * 16

    blocks.push({
      type,
      dataOffset: offset + DATHEAD_SIZE,
      dataLength: Math.max(0, blockSize - DATHEAD_SIZE),
    })

    if (nextUnits === 0) break
    offset += blockSize
    if (blocks.length > BLOCK_LIMIT) break
  }

  return blocks
}

/**
 * @param skelMatrices Bone matrices from an external skeleton DAT, for models
 *   that attach to a character (equipment, faces, hair). NPCs and monsters carry
 *   their own skeleton, which is detected and preferred when present.
 */
export function parseDatFile(
  buffer: ArrayBuffer,
  skelMatrices?: number[][] | null,
): ParsedDatFile {
  const reader = new DatReader(buffer)
  const blocks = parseBlockChain(reader)

  const textures: ParsedTexture[] = []
  const meshes: ParsedMesh[] = []
  const textureMap = new Map<string, number>()
  let embeddedSkeleton: ParsedSkeleton | null = null

  // Textures and skeleton first: the mesh pass needs both.
  for (const block of blocks) {
    if (block.type === BLOCK_IMG) {
      try {
        const result = parseTextureBlock(
          reader,
          block.dataOffset + BLOCK_PADDING,
          block.dataLength - BLOCK_PADDING,
        )
        if (result) {
          textureMap.set(result.name, textures.length)
          textures.push(result.texture)
        }
      } catch { /* a bad texture must not lose the model */ }
    }

    if (block.type === BLOCK_BONE && !embeddedSkeleton) {
      try {
        embeddedSkeleton = parseSkeleton(reader)
      } catch { /* skip */ }
    }
  }

  // Embedded skeleton wins: a monster DAT is self-contained. Otherwise use the
  // caller's character skeleton. Weapons have neither and stay untransformed.
  const matrices = embeddedSkeleton?.matrices ?? skelMatrices ?? null

  for (const block of blocks) {
    if (block.type === BLOCK_VERTEX) {
      try {
        meshes.push(
          ...parseVertexBlock(
            reader,
            block.dataOffset + BLOCK_PADDING,
            block.dataLength - BLOCK_PADDING,
            textureMap,
            matrices,
          ),
        )
      } catch { /* skip */ }
    }
  }

  return { meshes, textures, skeleton: embeddedSkeleton, animations: [] }
}

/** True if this DAT carries animation blocks, even though we cannot decode them yet. */
export function hasAnimations(buffer: ArrayBuffer): boolean {
  return parseBlockChain(new DatReader(buffer)).some(b => b.type === BLOCK_ANIM)
}

/** Parse a standalone skeleton DAT (the per-race files in SKELETON_PATHS). */
export function parseSkeletonDat(buffer: ArrayBuffer): ParsedSkeleton | null {
  return parseSkeleton(new DatReader(buffer))
}
