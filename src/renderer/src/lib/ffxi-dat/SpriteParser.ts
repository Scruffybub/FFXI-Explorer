/**
 * Sprite-sheet chunks (DAT block type 0x21) — the flat quads FFXI's particle
 * generators draw when their setup links type 0x0E (a sprite) or 0x39 (a lens
 * flare) rather than a mesh (0x0B).
 *
 *   rain    Jugner Forest's `~1ra` emits the sprite `rain`, a quad cut from the
 *           top half of `rain_b01`; the splashes and pond ripples are two more
 *   flare   West Ronfaure's `lf01`: seventeen meshes laid along the line from
 *           the sun through the screen centre — the sun's own disc and
 *           starburst first, then the rings and ghosts
 *
 * Layout (xim SpriteSheetSection.kt, github.com/Heyrio/FFXI-BROWSER-GAME,
 * GPL-3.0, read as a format reference; this reader is independent):
 *
 *   u16 @0x00   flag        u16 @0x02  mesh count
 *   u8  @0x04   1 = lens flare: each mesh carries its place along the line
 *   u8  @0x07   0 with flag 1: texture coordinates are in 1/256ths
 *   @0x08       16 bytes, the qualified texture name ("lf01    lf01    ")
 *   @0x18       meshes: u16 1, u8 quad count, u8; for a lens flare an f32
 *               offset (0 = at the sun, 1 = mirrored through the centre) and
 *               three more floats; then six vertices a quad of position
 *               3 x f32, colour RGBA bytes on the 0x80 = identity scale, uv
 *               2 x f32 (24 bytes each)
 *
 * A lens flare's positions are in 32nds of the screen (xim ZoneDrawer.kt
 * drawLensFlare scales by width/32, height/32), y down. Many shipped flare
 * meshes have no extent — padding — and draw nothing.
 */

export interface SpriteMesh {
  /** Place along the flare line; 0 for plain sprites. */
  offset: number
  vertices: number[]
  colors: number[]               // rgba per vertex, byte / 255, as MmbParser
  uvs: number[]
}

export interface ParsedSprite {
  textureName: string
  lensFlare: boolean
  meshes: SpriteMesh[]
}

const NAME_AT = 0x08
const MESHES_AT = 0x18
const VERTEX_STRIDE = 24

export function parseSprite(body: Uint8Array): ParsedSprite | null {
  if (body.length < MESHES_AT + 4) return null
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  const flag = view.getUint16(0, true)
  const count = view.getUint16(2, true)
  const lensFlare = body[4] === 1
  const uvScale = flag === 1 && body[7] === 0 ? 1 / 256 : 1
  if (count < 1) return null

  let end = NAME_AT
  while (end < NAME_AT + 16 && body[end] !== 0) end++
  const textureName = String.fromCharCode(...body.subarray(NAME_AT, end)).trim()

  const meshes: SpriteMesh[] = []
  let c = MESHES_AT
  for (let m = 0; m < count; m++) {
    if (c + 4 > body.length) return null
    const quads = body[c + 2]
    c += 4
    let offset = 0
    if (lensFlare) {
      if (c + 16 > body.length) return null
      offset = view.getFloat32(c, true)
      c += 16
    }
    const n = quads * 6
    if (c + n * VERTEX_STRIDE > body.length) return null
    const mesh: SpriteMesh = { offset, vertices: [], colors: [], uvs: [] }
    for (let i = 0; i < n; i++) {
      const o = c + i * VERTEX_STRIDE
      const xyz = [view.getFloat32(o, true), view.getFloat32(o + 4, true), view.getFloat32(o + 8, true)]
      if (!xyz.every(v => Number.isFinite(v) && Math.abs(v) < 1e4)) return null
      mesh.vertices.push(...xyz)
      mesh.colors.push(body[o + 12] / 255, body[o + 13] / 255, body[o + 14] / 255, body[o + 15] / 255)
      mesh.uvs.push(view.getFloat32(o + 16, true) * uvScale, view.getFloat32(o + 20, true) * uvScale)
    }
    c += n * VERTEX_STRIDE
    meshes.push(mesh)
  }
  return { textureName, lensFlare, meshes }
}
