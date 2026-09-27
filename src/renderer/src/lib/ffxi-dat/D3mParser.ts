/**
 * D3M chunks (DAT block type 0x1F) — FFXI's effect meshes.
 *
 * Generators spawn these the same way they spawn MMB zone meshes. South
 * Gustaberg's sea foam is one: 34 generators under f_gu/effe/umaw and
 * f_gu/effe/uma2 place the D3M `umw1`, textured with the foam sheet `umw1`
 * that no zone mesh uses — which is why the foam never appeared.
 *
 * Layout, as documented by kuluu-ffxi (https://github.com/jondwillis/kuluu-ffxi,
 * GPL-3.0; independent implementation from that description, no code copied):
 *
 *   u16 @0x00   low nibble is the layout marker; 5 and 6 are vertex arrays
 *   u8  @0x04   material count          u8 @0x05  extra count
 *   u16 @0x06   triangle count — a plain triangle list, 3 vertices each
 *   @0x08       a u16 per material + extra, padded by rounding the ENTRY
 *               count down to a multiple of four and adding three (n = 1..3
 *               all put the material table at 0x0E)
 *   then        16 bytes per material: the qualified texture name
 *   then        vertices, 36 bytes each: position 3 x f32, normal 3 x f32,
 *               D3DCOLOR (ARGB, little-endian u32), uv 2 x f32
 *
 * Vertex colour is on FFXI's 0x80 = identity scale. It is returned here as
 * byte / 255, like MmbParser, so both reach the renderer on the same footing
 * and one conversion (x2, gamma-decoded) serves both.
 */

export interface ParsedD3m {
  textureName: string            // e.g. "effect  umw1" — matches ParsedZone.textureNames
  vertices: number[]             // xyz per vertex
  normals: number[]
  colors: number[]               // rgba per vertex, byte / 255
  uvs: number[]
  indices: number[]              // 0..n-1, it is a triangle list
}

const VERTEX_STRIDE = 36
const MATERIAL_LEN = 16
const COUNT_TABLE = 0x08

function materialTableOffset(matCount: number, extraCount: number): number {
  const n = matCount + extraCount
  const shorts = n % 4 === 0 ? n : n - (n % 4) + 3
  return COUNT_TABLE + 2 * shorts
}

export function parseD3m(body: Uint8Array): ParsedD3m | null {
  if (body.length < COUNT_TABLE) return null
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  const marker = view.getUint16(0, true) & 0xf
  if (marker !== 5 && marker !== 6) return null

  const matCount = body[0x04]
  const extraCount = body[0x05]
  const triCount = view.getUint16(0x06, true)
  const matAt = materialTableOffset(matCount, extraCount)
  const vertAt = matAt + MATERIAL_LEN * matCount
  const vCount = triCount * 3
  if (vCount === 0 || body.length < vertAt + vCount * VERTEX_STRIDE) return null

  let textureName = ''
  if (matCount > 0) {
    let end = matAt
    while (end < matAt + MATERIAL_LEN && body[end] !== 0) end++
    textureName = String.fromCharCode(...body.subarray(matAt, end)).trim()
  }

  const vertices: number[] = []
  const normals: number[] = []
  const colors: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  for (let i = 0; i < vCount; i++) {
    const o = vertAt + i * VERTEX_STRIDE
    vertices.push(view.getFloat32(o, true), view.getFloat32(o + 4, true), view.getFloat32(o + 8, true))
    normals.push(view.getFloat32(o + 12, true), view.getFloat32(o + 16, true), view.getFloat32(o + 20, true))
    const argb = view.getUint32(o + 24, true)
    colors.push(
      ((argb >>> 16) & 0xff) / 255,
      ((argb >>> 8) & 0xff) / 255,
      (argb & 0xff) / 255,
      ((argb >>> 24) & 0xff) / 255,
    )
    uvs.push(view.getFloat32(o + 28, true), view.getFloat32(o + 32, true))
    indices.push(i)
  }

  return { textureName, vertices, normals, colors, uvs, indices }
}
