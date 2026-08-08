import { DatReader } from './DatReader'
import { parseTextureBlock } from './TextureParser'
import { decodeMzb, decodeMmb } from './ZoneDecrypt'
import { parseMzbBlock } from './MzbParser'
import { parseMzbCollision, type ParsedCollision } from './CollisionParser'
import { parseMmbBlock } from './MmbParser'
import type { ParsedZone, ParsedZoneMesh, ParsedTexture, ZoneMeshInstance } from './types'

const DATHEAD_SIZE = 8
const BLOCK_PADDING = 8
const BLOCK_LIMIT = 2000

const BLOCK_IMG = 0x20
const BLOCK_MZB = 0x1C
const BLOCK_MMB = 0x2E

interface DatBlock {
  name: string
  type: number
  nextUnits: number
  dataOffset: number
  dataLength: number
}

function parseBlockChain(reader: DatReader): DatBlock[] {
  const blocks: DatBlock[] = []
  let offset = 0
  while (offset < reader.length - DATHEAD_SIZE) {
    reader.seek(offset)
    const name = reader.readString(4)
    const packed = reader.readUint32()
    const type = packed & 0x7F
    const nextUnits = (packed >> 7) & 0x7FFFF
    const blockSize = nextUnits * 16
    blocks.push({
      name, type, nextUnits,
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
 * Read the SMMBHeader.imgID (16 chars at offset 16 after SMMBHEAD)
 * from decrypted MMB block data. This is the name used by MZB entries
 * to reference this MMB prefab.
 */
function readMmbName(decryptedData: Uint8Array): string {
  // SMMBHEAD is 16 bytes, then SMMBHeader starts with imgID[16]
  if (decryptedData.length < 32) return ''
  const bytes = decryptedData.slice(16, 32)
  let end = bytes.indexOf(0)
  if (end === -1) end = 16
  return new TextDecoder('utf-8').decode(bytes.subarray(0, end)).trim()
}

/**
 * Extract named textures from a DAT file (companion texture DATs).
 * Returns a map of texture name → ParsedTexture for merging into the zone's texture pool.
 */
export function parseTexturesFromDat(
  buffer: ArrayBuffer,
): Map<string, ParsedTexture> {
  const reader = new DatReader(buffer)
  const blocks = parseBlockChain(reader)
  const result = new Map<string, ParsedTexture>()
  const imgBlocks = blocks.filter(b => b.type === BLOCK_IMG)
  for (const block of imgBlocks) {
    try {
      const parsed = parseTextureBlock(reader, block.dataOffset + BLOCK_PADDING, block.dataLength - BLOCK_PADDING)
      if (parsed && !result.has(parsed.name)) {
        result.set(parsed.name, parsed.texture)
      }
    } catch { /* skip */ }
  }
  return result
}

export function parseZoneFile(
  buffer: ArrayBuffer,
  onProgress?: (message: string) => void,
  supplementalTextures?: Map<string, ParsedTexture>,
): ParsedZone {
  const reader = new DatReader(buffer)
  const blocks = parseBlockChain(reader)

  onProgress?.(`Block chain: ${blocks.length} blocks`)

  const textures: ParsedTexture[] = []
  const prefabs: ParsedZoneMesh[] = []
  const instances: ZoneMeshInstance[] = []

  // ── Pass 1: Textures (with name→index map) ──
  const imgBlocks = blocks.filter(b => b.type === BLOCK_IMG)
  onProgress?.(`Parsing ${imgBlocks.length} textures...`)
  const textureNameMap = new Map<string, number>()
  const duplicateNames: string[] = []
  for (const block of imgBlocks) {
    try {
      const result = parseTextureBlock(reader, block.dataOffset + BLOCK_PADDING, block.dataLength - BLOCK_PADDING)
      if (result) {
        if (textureNameMap.has(result.name)) {
          duplicateNames.push(`"${result.name}" (first=${textureNameMap.get(result.name)}, dup=${textures.length}, ${result.texture.width}×${result.texture.height})`)
          // Keep first occurrence — skip duplicate to avoid unreferenced entries in textures[]
        } else {
          textureNameMap.set(result.name, textures.length)
          textures.push(result.texture)
        }
      }
    } catch { /* skip */ }
  }
  onProgress?.(`Textures: ${textures.length} parsed (${textureNameMap.size} named)`)
  console.log('[ZoneFile] textureNameMap entries:', Array.from(textureNameMap.keys()).sort())
  if (duplicateNames.length > 0) {
    console.warn(`[ZoneFile] ${duplicateNames.length} duplicate texture names (last wins):`, duplicateNames)
  }
  // Log first 10 textures with dimensions and first pixel to verify data integrity
  console.log('[ZoneFile] First textures:', textures.slice(0, 10).map((t, i) => {
    const r = t.rgba[0], g = t.rgba[1], b = t.rgba[2], a = t.rgba[3]
    return `[${i}] ${t.width}×${t.height} px0=(${r},${g},${b},${a})`
  }))

  // Merge supplemental textures from companion DATs (only add names not already present)
  if (supplementalTextures) {
    let added = 0
    for (const [name, tex] of supplementalTextures) {
      if (!textureNameMap.has(name)) {
        textureNameMap.set(name, textures.length)
        textures.push(tex)
        added++
      }
    }
    if (added > 0) {
      onProgress?.(`Supplemental textures: ${added} added from companion DATs`)
      console.log(`[ZoneFile] ${added} supplemental textures merged, total now ${textures.length}`)
    }
  }

  // ── Pass 2: MMB prefabs (with name tracking) ──
  const mmbBlocks = blocks.filter(b => b.type === BLOCK_MMB)
  onProgress?.(`Parsing ${mmbBlocks.length} MMB blocks...`)

  // Map: MMB name → array of { startIdx, count } in the flat prefabs array.
  // Multiple MMB blocks can share a name (different pieces of the same area).
  const mmbNameMap = new Map<string, { startIdx: number; count: number }[]>()

  // MMB block names for sky objects rendered by our procedural sky instead
  const skyObjectNames = new Set(['sunsphere', 'moonsphere'])

  for (let i = 0; i < mmbBlocks.length; i++) {
    const block = mmbBlocks[i]
    const start = block.dataOffset + BLOCK_PADDING
    const len = block.dataLength - BLOCK_PADDING
    if (len <= 0) continue
    try {
      const blockData = new Uint8Array(buffer, start, len)
      const decryptedData = decodeMmb(blockData)
      const name = readMmbName(decryptedData)

      // Skip sky objects — rendered by our procedural sky instead
      if (skyObjectNames.has(name)) continue

      const meshes = parseMmbBlock(decryptedData)

      // Resolve texture names to material indices
      for (const mesh of meshes) {
        if (!mesh.textureName) {
          // Blank texture name — resolved after all MMB blocks are parsed
          mesh.materialIndex = -1
          continue
        }
        const texIdx = textureNameMap.get(mesh.textureName)
        if (texIdx !== undefined) {
          mesh.materialIndex = texIdx
        } else {
          mesh.materialIndex = -1
        }
      }

      if (meshes.length > 0) {
        const startIdx = prefabs.length
        prefabs.push(...meshes)
        // Accumulate ALL blocks per name — zones have multiple blocks with the same name
        let arr = mmbNameMap.get(name)
        if (!arr) {
          arr = []
          mmbNameMap.set(name, arr)
        }
        arr.push({ startIdx, count: meshes.length })
      }
    } catch { /* skip */ }
  }
  // Assign fallback texture to blank-name meshes using the zone's most-used texture.
  // These meshes have 16 ASCII spaces as their texture name (blank), meaning they
  // should use the zone's primary terrain texture. We find it by usage frequency.
  const texUsage = new Map<number, number>()
  for (const p of prefabs) {
    if (p.materialIndex >= 0) texUsage.set(p.materialIndex, (texUsage.get(p.materialIndex) || 0) + 1)
  }
  let fallbackTexIdx = -1
  let fallbackMax = 0
  for (const [idx, count] of texUsage) {
    if (count > fallbackMax) { fallbackMax = count; fallbackTexIdx = idx }
  }
  if (fallbackTexIdx >= 0) {
    let count = 0
    for (const p of prefabs) {
      if (p.materialIndex === -1) { p.materialIndex = fallbackTexIdx; count++ }
    }
    if (count > 0) console.log(`[ZoneFile] ${count} untextured meshes → fallback texture[${fallbackTexIdx}]`)
  }

  onProgress?.(`MMB: ${prefabs.length} meshes from ${mmbBlocks.length} blocks, ${mmbNameMap.size} unique names`)

  // ── Pass 3: MZB transforms (with name-based lookup) ──
  const mzbBlocks = blocks.filter(b => b.type === BLOCK_MZB)
  onProgress?.(`Parsing ${mzbBlocks.length} MZB blocks...`)

  let mzbTotal = 0
  let mzbMatched = 0
  const collisionParts: ParsedCollision[] = []

  for (const block of mzbBlocks) {
    const start = block.dataOffset + BLOCK_PADDING
    const len = block.dataLength - BLOCK_PADDING
    if (len <= 0) continue
    try {
      const blockData = new Uint8Array(buffer, start, len)
      const decryptedData = decodeMzb(blockData)
      const rawInstances = parseMzbBlock(decryptedData)
      mzbTotal += rawInstances.length

      // Collision geometry lives further into this same decrypted block.
      // Failure here must not cost us the zone, so it is isolated.
      try {
        const part = parseMzbCollision(decryptedData)
        if (part) collisionParts.push(part)
      } catch (err) {
        onProgress?.(`Warning: collision parse failed — ${err}`)
      }

      for (const inst of rawInstances) {
        const mappings = mmbNameMap.get(inst.name)
        if (!mappings) continue
        mzbMatched++

        // Create instances for ALL meshes across ALL MMB blocks with this name
        for (const mapping of mappings) {
          for (let m = 0; m < mapping.count; m++) {
            instances.push({
              meshIndex: mapping.startIdx + m,
              transform: inst.transform,
            })
          }
        }
      }
    } catch (err) {
      onProgress?.(`Warning: MZB parse failed — ${err}`)
    }
  }

  const unmatchedCount = { total: mzbTotal, matched: mzbMatched }
  const collision = mergeCollision(collisionParts)

  // Console, not just onProgress: onProgress only paints a transient loading
  // message, and collision counts are the thing to check when walking feels
  // wrong in a zone.
  if (collision) {
    // Bounds are the cheap check for the grid over-scan reading junk offsets:
    // stray geometry lands far outside the zone and blows the box up.
    const v = collision.vertices
    let minX = Infinity, minY = Infinity, minZ = Infinity
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
    for (let i = 0; i < v.length; i += 3) {
      if (v[i] < minX) minX = v[i]; if (v[i] > maxX) maxX = v[i]
      if (v[i + 1] < minY) minY = v[i + 1]; if (v[i + 1] > maxY) maxY = v[i + 1]
      if (v[i + 2] < minZ) minZ = v[i + 2]; if (v[i + 2] > maxZ) maxZ = v[i + 2]
    }
    const r = (n: number) => Math.round(n)
    console.log(
      `[Collision] ${collision.indices.length / 3} tris, ${v.length / 3} verts, ` +
      `from ${collisionParts.length} MZB block(s), ` +
      `bounds x[${r(minX)},${r(maxX)}] y[${r(minY)},${r(maxY)}] z[${r(minZ)},${r(maxZ)}]`,
    )
  } else {
    console.log(`[Collision] none parsed from ${mzbBlocks.length} MZB block(s)`)
  }

  onProgress?.(`Instances: ${instances.length} (${unmatchedCount.matched}/${unmatchedCount.total} MZB entries matched MMB names)`)
  onProgress?.(
    collision
      ? `Collision: ${collision.indices.length / 3} triangles, ${collision.vertices.length / 3} vertices`
      : `Collision: none found`,
  )
  onProgress?.(`Result: ${prefabs.length} prefabs, ${instances.length} instances, ${textures.length} textures`)

  return { prefabs, instances, textures, collision }
}

/** Concatenate collision from every MZB block in the file, rebasing indices. */
function mergeCollision(parts: ParsedCollision[]): ParsedCollision | null {
  if (parts.length === 0) return null
  if (parts.length === 1) return parts[0]

  const vertexCount = parts.reduce((n, p) => n + p.vertices.length, 0)
  const indexCount = parts.reduce((n, p) => n + p.indices.length, 0)
  const faceCount = parts.reduce((n, p) => n + p.faceFlags.length, 0)

  const vertices = new Float32Array(vertexCount)
  const indices = new Uint32Array(indexCount)
  const faceFlags = new Uint16Array(faceCount)
  const indexFlags = new Uint8Array(faceCount)

  let vOff = 0, iOff = 0, fOff = 0
  for (const part of parts) {
    vertices.set(part.vertices, vOff)
    for (let i = 0; i < part.indices.length; i++) {
      indices[iOff + i] = part.indices[i] + vOff / 3
    }
    faceFlags.set(part.faceFlags, fOff)
    indexFlags.set(part.indexFlags, fOff)
    vOff += part.vertices.length
    iOff += part.indices.length
    fOff += part.faceFlags.length
  }

  return { vertices, indices, faceFlags, indexFlags }
}
