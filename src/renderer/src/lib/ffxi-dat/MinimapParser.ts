import { DatReader } from './DatReader'
import type { ParsedTexture } from './types'
import {
  decompressDXT1, decompressDXT3, decodeB1Indexed,
  B1_PALETTE_OFFSET, B1_PALETTE_SIZE,
} from './TextureParser'

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
 *   +0x3D: 256-entry palette, B,G,R,A per entry (1024 bytes)
 *   +0x43D: 8-bit indexed pixel data (width * height bytes), bottom-up
 *
 * The palette offset and entry order live in `TextureParser`, which does the
 * decoding for both this and the zone/model textures. `B1_HEADER_SIZE` below is
 * only used by the DXT fallback, which measures back from the end of the block.
 */
const B1_HEADER_SIZE = 64


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

  const pixelOffset = dataOffset + B1_PALETTE_OFFSET + B1_PALETTE_SIZE
  const pixelCount = width * height

  // Verify we have enough data for palette + indexed pixels
  if (pixelOffset + pixelCount > dataOffset + dataLength) {
    // Not enough data for 8-bit indexed — fall back to DXT
    return parseB1AsDXT(reader, dataOffset, dataLength, width, height)
  }

  // The layout itself lives in TextureParser, shared with the zone and model
  // textures: this format took long enough to pin down that two copies of it
  // would only drift apart.
  return decodeB1Indexed(reader, dataOffset, width, height)
}

/**
 * Bring DXT-decoded alpha back onto FFXI's scale.
 *
 * FFXI treats **0x80 as fully opaque**, the same convention the palette uses.
 * DXT3 stores alpha in 4 bits, and 0x80 is 7.53 of 15 — not representable — so
 * the encoder dithered it between nibbles 7 and 8. Measured in North
 * Gustaberg's `m_106_00`: the alpha channel holds exactly two values, **119 and
 * 136, at 50% each**, and nothing else. That is not transparency, it is a
 * checkerboard standing in for a constant.
 *
 * Left alone, every DXT plate drew at about half opacity: over the viewer's
 * dark background that dimmed the parchment into something muddy and
 * over-saturated, with the 119/136 alternation showing through as a
 * checkerboard once zoomed.
 *
 * So anything at or above nibble 7 is read as the opaque it was meant to be,
 * and genuinely lower values still scale by two.
 */
function normaliseAlpha(rgba: Uint8Array): Uint8Array {
  for (let i = 3; i < rgba.length; i += 4) {
    const a = rgba[i]
    rgba[i] = a >= 112 ? 255 : Math.min(255, a * 2)
  }
  return rgba
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
    return { width, height, rgba: normaliseAlpha(decompressDXT3(pixelData, width, height)), format: 'dxt3-b1' }
  }

  if (dataLength >= expectedDXT1 + B1_HEADER_SIZE) {
    const pixelOffset = dataOffset + dataLength - expectedDXT1
    reader.seek(pixelOffset)
    const pixelData = reader.readBytes(expectedDXT1)
    return { width, height, rgba: normaliseAlpha(decompressDXT1(pixelData, width, height)), format: 'dxt1-b1' }
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
    rgba = normaliseAlpha(decompressDXT3(pixelData, width, height))
  } else if (ddsType === '1TXD') {
    rgba = normaliseAlpha(decompressDXT1(pixelData, width, height))
  } else {
    return null
  }

  return { width, height, rgba, format: ddsType === '3TXD' ? 'dxt3' : 'dxt1' }
}
