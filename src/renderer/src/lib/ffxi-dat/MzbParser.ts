/**
 * Parses MZB blocks (type 0x1C) from FFXI zone DAT files.
 * Data must be decrypted via decodeMzb() before calling this.
 *
 * Ported from GalkaReeve mapViewer FFXILandscapeMesh.cpp + .h
 *
 * SMZBHeader (32 bytes):
 *   char id[4]
 *   uint totalRecord100:24, R100Flag:8
 *   uint offsetHeader2, d1:8, d2:8, d3:8, d4:8
 *   int  offsetlooseTree
 *   uint offsetEndRecord100, offsetEndlooseTree
 *
 * Followed by totalRecord100 × SMZBBlock100 entries (100 bytes each):
 *   char id[16]
 *   float fTransX,fTransY,fTransZ
 *   float fRotX,fRotY,fRotZ
 *   float fScaleX,fScaleY,fScaleZ
 *   float fa,fb,fc,fd
 *   long  fe,ff,fg,fh,fi,fj,fk,fl
 *
 * We build 4x4 transform matrices from scale × rotation × translation.
 * The `id[16]` field is a string name used to match against MMB prefab names.
 */

export interface MzbInstance {
  name: string          // id[16] — MMB prefab name for matching
  transform: number[]   // 4x4 matrix (16 floats, column-major for Three.js)
}

const SMZB_HEADER_SIZE = 32
const SMZB_BLOCK100_SIZE = 100

const textDecoder = new TextDecoder('utf-8')

export function parseMzbBlock(data: Uint8Array): MzbInstance[] {
  if (data.length < SMZB_HEADER_SIZE + SMZB_BLOCK100_SIZE) return []

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)

  // SMZBHeader: totalRecord100 at offset 4 (24 bits)
  const totalRecord100 = view.getUint32(4, true) & 0xFFFFFF
  if (totalRecord100 === 0 || totalRecord100 > 20000) {
    if (totalRecord100 > 20000) console.warn(`MZB: totalRecord100 ${totalRecord100} too large`)
    return []
  }

  const instances: MzbInstance[] = []
  const recordsStart = SMZB_HEADER_SIZE

  for (let i = 0; i < totalRecord100; i++) {
    const offset = recordsStart + i * SMZB_BLOCK100_SIZE
    if (offset + SMZB_BLOCK100_SIZE > data.length) break

    // id[16] — MMB prefab name (null-terminated, space-padded)
    const idBytes = data.subarray(offset, offset + 16)
    let end = idBytes.indexOf(0)
    if (end === -1) end = 16
    const name = textDecoder.decode(idBytes.subarray(0, end)).trim()

    // Read transform components
    const fTransX = view.getFloat32(offset + 16, true)
    const fTransY = view.getFloat32(offset + 20, true)
    const fTransZ = view.getFloat32(offset + 24, true)
    const fRotX = view.getFloat32(offset + 28, true)
    const fRotY = view.getFloat32(offset + 32, true)
    const fRotZ = view.getFloat32(offset + 36, true)
    const fScaleX = view.getFloat32(offset + 40, true)
    const fScaleY = view.getFloat32(offset + 44, true)
    const fScaleZ = view.getFloat32(offset + 48, true)

    // Build 4x4 transform matrix: Scale × RotZ × RotY × RotX × Translate
    const cx = Math.cos(fRotX), sx = Math.sin(fRotX)
    const cy = Math.cos(fRotY), sy = Math.sin(fRotY)
    const cz = Math.cos(fRotZ), sz = Math.sin(fRotZ)

    // Combined rotation: Rz * Ry * Rx
    const r00 = cz * cy, r01 = cz * sy * sx - sz * cx, r02 = cz * sy * cx + sz * sx
    const r10 = sz * cy, r11 = sz * sy * sx + cz * cx, r12 = sz * sy * cx - cz * sx
    const r20 = -sy,     r21 = cy * sx,                 r22 = cy * cx

    // Apply scale then put in column-major 4x4 for Three.js (fromArray expects column-major)
    const transform = [
      r00 * fScaleX, r10 * fScaleX, r20 * fScaleX, 0,
      r01 * fScaleY, r11 * fScaleY, r21 * fScaleY, 0,
      r02 * fScaleZ, r12 * fScaleZ, r22 * fScaleZ, 0,
      fTransX,       fTransY,       fTransZ,        1,
    ]

    instances.push({ name, transform })
  }

  return instances
}
