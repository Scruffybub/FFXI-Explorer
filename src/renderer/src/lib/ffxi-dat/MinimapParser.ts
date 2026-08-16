import { DatReader } from './DatReader'
import type { ParsedTexture } from './types'
import { decompressDXT1, decompressDXT3 } from './TextureParser'

const DATHEAD_SIZE = 8
const BLOCK_PADDING = 8

/**
 * Parse a minimap DAT file and extract the map texture.
 * Minimap DATs use 0xB1 flag IMGINFO headers ("menumap" format).
 */
/**
 * The id string the block carries, e.g. "menumap m_106_00" or
 * "ex4_datam_088_00": zone id and page number, which is how a zone tells its
 * own plates from its Wings of the Goddess counterpart.
 */
export interface ParsedMinimap {
  name: string
  texture: ParsedTexture
}

export function parseMinimapDat(buffer: ArrayBuffer): ParsedMinimap | null {
  const reader = new DatReader(buffer)
  let offset = 0

  while (offset < reader.length - DATHEAD_SIZE) {
    reader.seek(offset)
    reader.skip(4) // block name
    const packed = reader.readUint32()
    const type = packed & 0x7F
    const nextUnits = (packed >> 7) & 0x7FFFF
    const blockSize = nextUnits * 16
    if (nextUnits === 0) break

    if (type === 0x20) {
      const dataOffset = offset + DATHEAD_SIZE + BLOCK_PADDING
      const dataLength = blockSize - DATHEAD_SIZE - BLOCK_PADDING
      if (dataLength > 0) {
        const texture = parseMinimapTextureBlock(reader, dataOffset, dataLength)
        if (texture) {
          // The id sits at +0x01 of the block, 16 bytes, NUL padded.
          reader.seek(dataOffset + 1)
          const name = reader.readString(16).replace(/\0+$/, '').trim()
          return { name, texture }
        }
      }
    }

    offset += blockSize
  }

  return null
}

/**
 * 0xB1 "menumap" IMGINFO header layout (from hex dump analysis):
 *
 *   +0x00: flag (1 byte) = 0xB1
 *   +0x01: id string (16 bytes) e.g. "menumap m_102_00"
 *   +0x11: unknown (4 bytes)
 *   +0x15: width (4 bytes, uint32 LE)
 *   +0x19: height (4 bytes, uint32 LE)
 *   +0x1D..0x3F: unknown header fields + padding (35 bytes)
 *   +0x40: 256-entry RGBA palette (1024 bytes)
 *   +0x440: 8-bit indexed pixel data (width * height bytes)
 *
 * Total header + palette = 64 + 1024 = 1088 bytes before pixel data.
 * Each pixel byte is an index into the 256-color palette.
 */
const B1_HEADER_SIZE = 64
const B1_PALETTE_ENTRIES = 256
const B1_PALETTE_SIZE = B1_PALETTE_ENTRIES * 4 // 1024 bytes (RGBA per entry)

function parseMinimapTextureBlock(
  reader: DatReader, dataOffset: number, dataLength: number
): ParsedTexture | null {
  reader.seek(dataOffset)
  const flg = reader.readUint8()

  // Handle standard 0xA1/0x81 IMGINFO (some minimap DATs may use these)
  if (flg === 0xA1 || flg === 0x81) {
    return parseA1Style(reader, dataOffset)
  }

  if (flg !== 0xB1) return null

  // Read dimensions
  reader.seek(dataOffset + 0x15)
  const width = reader.readInt32()
  const height = reader.readInt32()

  if (width <= 0 || width > 2048 || height <= 0 || height > 2048) return null

  const paletteOffset = dataOffset + B1_HEADER_SIZE
  const pixelOffset = paletteOffset + B1_PALETTE_SIZE
  const pixelCount = width * height

  // Verify we have enough data for palette + indexed pixels
  if (pixelOffset + pixelCount > dataOffset + dataLength) {
    // Not enough data for 8-bit indexed — fall back to DXT
    return parseB1AsDXT(reader, dataOffset, dataLength, width, height)
  }

  /**
   * The palette is **ARGB**, one little-endian word per entry: alpha, then
   * blue, green, red.
   *
   * It was read as BGRA, which put the *constant* alpha byte into blue and the
   * real red into alpha. Every map came out pink — blue pinned at 128 — with a
   * red "Valkurm Dunes" label rendering purple, and the torn edges' opacity
   * tracking their redness.
   *
   * Measured rather than guessed, in Selbina's `m_248_00`: byte 0 holds 0x80 in
   * **all 256 entries**, which is FFXI's fully-opaque alpha and cannot be a
   * colour channel; and the parchment entry `80 9e ca d6` read as A,B,G,R gives
   * (214, 202, 158) — the warm tan the game shows.
   */
  reader.seek(paletteOffset)
  const palette = reader.readBytes(B1_PALETTE_SIZE)

  // Read indexed pixel data
  reader.seek(pixelOffset)
  const indices = reader.readBytes(pixelCount)

  // Convert indexed pixels to RGBA, flipping vertically only
  // (FFXI stores minimap pixels bottom-up)
  // Palette format is BGRA; alpha 0x80 means fully opaque in FFXI's palette convention
  const rgba = new Uint8Array(pixelCount * 4)
  for (let y = 0; y < height; y++) {
    const srcRow = y * width
    const dstRow = (height - 1 - y) * width
    for (let x = 0; x < width; x++) {
      const idx = indices[srcRow + x]
      const pOff = idx * 4
      const d = (dstRow + x) * 4
      rgba[d + 0] = palette[pOff + 3] // R
      rgba[d + 1] = palette[pOff + 2] // G
      rgba[d + 2] = palette[pOff + 1] // B
      // 0x80 is fully opaque in FFXI's convention, so the value doubles rather
      // than being read as a yes/no.
      rgba[d + 3] = Math.min(255, palette[pOff + 0] * 2)
    }
  }

  return { width, height, rgba, format: 'indexed' }
}

/** Fallback: try DXT decoding for 0xB1 blocks that don't fit the indexed format. */
function parseB1AsDXT(
  reader: DatReader, dataOffset: number, dataLength: number,
  width: number, height: number
): ParsedTexture | null {
  const blocksX = Math.max(1, Math.ceil(width / 4))
  const blocksY = Math.max(1, Math.ceil(height / 4))
  const expectedDXT3 = blocksX * blocksY * 16
  const expectedDXT1 = blocksX * blocksY * 8

  if (dataLength >= expectedDXT3 + B1_HEADER_SIZE) {
    const pixelOffset = dataOffset + dataLength - expectedDXT3
    reader.seek(pixelOffset)
    const pixelData = reader.readBytes(expectedDXT3)
    return { width, height, rgba: decompressDXT3(pixelData, width, height), format: 'dxt3-b1' }
  }

  if (dataLength >= expectedDXT1 + B1_HEADER_SIZE) {
    const pixelOffset = dataOffset + dataLength - expectedDXT1
    reader.seek(pixelOffset)
    const pixelData = reader.readBytes(expectedDXT1)
    return { width, height, rgba: decompressDXT1(pixelData, width, height), format: 'dxt1-b1' }
  }

  return null
}

/** Parse standard 0xA1/0x81 IMGINFO header (same as TextureParser). */
function parseA1Style(reader: DatReader, dataOffset: number): ParsedTexture | null {
  reader.seek(dataOffset + 1) // skip flag byte
  reader.skip(16) // id
  reader.skip(4)  // dwnazo1
  const width = reader.readInt32()
  const height = reader.readInt32()
  reader.skip(24) // dwnazo2[6]
  reader.skip(4)  // widthbyte

  if (width <= 0 || width > 2048 || height <= 0 || height > 2048) return null

  const ddsType = reader.readString(4) // "3TXD" or "1TXD"
  const ddsSize = reader.readUint32()
  reader.skip(4) // noBlock

  if (ddsSize === 0) return null
  const pixelData = reader.readBytes(ddsSize)

  let rgba: Uint8Array
  if (ddsType === '3TXD') {
    rgba = decompressDXT3(pixelData, width, height)
  } else if (ddsType === '1TXD') {
    rgba = decompressDXT1(pixelData, width, height)
  } else {
    return null
  }

  return { width, height, rgba, format: ddsType === '3TXD' ? 'dxt3' : 'dxt1' }
}
