/**
 * Sprite-sheet chunks (DAT block type 0x21) — the flat quads FFXI's particle
 * generators draw when their setup links type 0x0E rather than a mesh (0x0B).
 * The rain is one: Jugner Forest's `~1ra` emits the sprite `rain`, a quad cut
 * from the top half of the `rain_b01` sheet; the ground splashes and the
 * ripples on water are two more quads from the same sheet.
 *
 * Layout, worked out against retail DATs (the chunk kind is named in
 * kuluu-ffxi; this reader is independent, from the bytes):
 *
 *   u16 @0x00   bit 0 set: frames carry no extra block (the weather sprites);
 *               clear: 16 more bytes follow each frame header (the lens-flare
 *               sheets lf01..)
 *   u16 @0x02   frame count
 *   @0x08       16 bytes, the qualified texture name ("rain    rain_b01")
 *   @0x18       frames: u16 u16 header, [16 bytes], then six vertices — two
 *               triangles — of position 3 x f32, colour RGBA bytes on the
 *               0x80 = identity scale, uv 2 x f32 (24 bytes each)
 *
 * Only the first frame is read: every weather sprite measured has one.
 */

export interface ParsedSprite {
  textureName: string
  vertices: number[]
  colors: number[]               // rgba per vertex, byte / 255, as MmbParser
  uvs: number[]
  indices: number[]
}

const NAME_AT = 0x08
const FRAMES_AT = 0x18
const VERTEX_STRIDE = 24
const VERTS_PER_FRAME = 6

export function parseSprite(body: Uint8Array): ParsedSprite | null {
  if (body.length < FRAMES_AT + 4) return null
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  const simple = (view.getUint16(0, true) & 1) !== 0
  const frames = view.getUint16(2, true)
  if (frames < 1) return null
  const vertAt = FRAMES_AT + 4 + (simple ? 0 : 16)
  if (body.length < vertAt + VERTS_PER_FRAME * VERTEX_STRIDE) return null

  let end = NAME_AT
  while (end < NAME_AT + 16 && body[end] !== 0) end++
  const textureName = String.fromCharCode(...body.subarray(NAME_AT, end)).trim()

  const vertices: number[] = []
  const colors: number[] = []
  const uvs: number[] = []
  for (let i = 0; i < VERTS_PER_FRAME; i++) {
    const o = vertAt + i * VERTEX_STRIDE
    const xyz = [view.getFloat32(o, true), view.getFloat32(o + 4, true), view.getFloat32(o + 8, true)]
    if (!xyz.every(v => Number.isFinite(v) && Math.abs(v) < 1e4)) return null
    vertices.push(...xyz)
    colors.push(body[o + 12] / 255, body[o + 13] / 255, body[o + 14] / 255, body[o + 15] / 255)
    uvs.push(view.getFloat32(o + 16, true), view.getFloat32(o + 20, true))
  }
  return { textureName, vertices, colors, uvs, indices: [0, 1, 2, 3, 4, 5] }
}
