/**
 * Generator chunks (DAT block type 0x05) — FFXI's effect emitters.
 *
 * This is where a zone's water, sky layers and lamp glows are actually placed.
 * A generator can spawn a whole MMB mesh ("model spawn") and give it a
 * position, rotation, scale, colour tint and a per-frame UV scroll. None of
 * that is in the MZB instance list, which is why the sea sheets, the clouds and
 * the sun sat unplaced at the origin for months: they are tiny tiles (the
 * Gustaberg sea is a few units across) that the generator scales up ~17x and
 * scrolls in opposing layers.
 *
 * Layout, as documented by kuluu-ffxi (https://github.com/jondwillis/kuluu-ffxi,
 * GPL-3.0; this file is an independent implementation from that description,
 * no code is copied) and verified here against retail DATs:
 *
 *   body[0x74]  u32  section-1 (creation) offset, counted from the 16-byte
 *                    chunk header — hence the -16 when used on the body
 *   body[0x78]  u32  section-3 (per-frame update) offset, same convention
 *
 * Each section is a stream of records: opcode byte, size in 32-bit words in the
 * low five bits of the next byte (0 or opcode 0x00 ends it), payload from +4.
 *
 *   section 1  0x01  setup: flags u32 at +0 (0x4 = follows the camera),
 *                    linked name 8 bytes at +8, position 3 x f32 at +16,
 *                    linked type at +29 (0x0B = a model)
 *              0x09  rotation 3 x f32 (radians)
 *              0x0F  scale 3 x f32
 *              0x16  tint RGBA bytes, 0x80 = identity — alpha below 0x80 is
 *                    translucent, the same 0x80 convention as everything else
 *   section 3  0x27  U scroll per frame      0x28  V scroll per frame
 *
 * Frames are retail effect frames, 30 per second.
 */

export interface RawModelSpawn {
  model: string
  position: [number, number, number]
  rotation: [number, number, number]
  scale: [number, number, number]
  tint: [number, number, number, number]
  uvScroll: [number, number]
  followCamera: boolean
}

const HEADER_LEN = 0x80
const OP_END = 0x00
const SIZE_WORDS_MASK = 0x1f
const LINKED_MODEL = 0x0b
const FLAG_FOLLOW_CAMERA = 0x4

function* records(view: DataView, body: Uint8Array, headerField: number) {
  const start = view.getUint32(headerField, true)
  if (start < 16 || start - 16 >= body.length) return
  let c = start - 16
  while (c + 4 <= body.length) {
    const op = body[c]
    if (op === OP_END) return
    const words = body[c + 1] & SIZE_WORDS_MASK
    if (words === 0) return
    const len = words * 4
    if (c + len > body.length) return
    yield { op, p: c + 4 }
    c += len
  }
}

/**
 * Parse one generator chunk body (the bytes after its 16-byte header). Returns
 * null for any generator that does not spawn a model — particle emitters,
 * sounds, lights.
 */
export function parseModelSpawn(body: Uint8Array): RawModelSpawn | null {
  if (body.length < HEADER_LEN) return null
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  const f3 = (p: number): [number, number, number] =>
    [view.getFloat32(p, true), view.getFloat32(p + 4, true), view.getFloat32(p + 8, true)]

  let model = ''
  let linked = -1
  let flags = 0
  let position: [number, number, number] = [0, 0, 0]
  let rotation: [number, number, number] = [0, 0, 0]
  let scale: [number, number, number] = [1, 1, 1]
  let tint: [number, number, number, number] = [0x80, 0x80, 0x80, 0x80]

  for (const { op, p } of records(view, body, 0x74)) {
    if (op === 0x01 && p + 30 <= body.length) {
      flags = view.getUint32(p, true)
      let end = p + 8
      while (end < p + 16 && body[end] !== 0) end++
      model = String.fromCharCode(...body.subarray(p + 8, end)).trim()
      position = f3(p + 16)
      linked = body[p + 29]
    } else if (op === 0x09 && p + 12 <= body.length) {
      rotation = f3(p)
    } else if (op === 0x0f && p + 12 <= body.length) {
      scale = f3(p)
    } else if (op === 0x16 && p + 4 <= body.length) {
      tint = [body[p], body[p + 1], body[p + 2], body[p + 3]]
    }
  }
  if (linked !== LINKED_MODEL || !model) return null

  const uvScroll: [number, number] = [0, 0]
  for (const { op, p } of records(view, body, 0x78)) {
    if (op === 0x27 && p + 4 <= body.length) uvScroll[0] = view.getFloat32(p, true)
    if (op === 0x28 && p + 4 <= body.length) uvScroll[1] = view.getFloat32(p, true)
  }

  return {
    model, position, rotation, scale, tint, uvScroll,
    followCamera: (flags & FLAG_FOLLOW_CAMERA) !== 0,
  }
}
