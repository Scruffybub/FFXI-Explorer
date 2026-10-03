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
 *              0x1E  blend byte (low nibble 8 = additive, 4 = alpha blend)
 *              0x60–0x63  time-of-day KeyFrame for R, G, B, alpha (id at +4),
 *                    sampled at the fraction of the day by section-3 updaters
 *                    0x3C–0x3F: colour is set from the curve, alpha multiplied
 *   section 3  0x27  U scroll per frame      0x28  V scroll per frame
 *
 *   body[0x00] u16 attach flags: low nibble 0xE = rides the sun's direction,
 *              0xF = the moon's; clouds and stars carry 0 and follow the camera
 *
 * Frames are FFXI effect frames, 60 per second (xim Fps.internalFps).
 */

export interface RawModelSpawn {
  model: string
  position: [number, number, number]
  rotation: [number, number, number]
  scale: [number, number, number]
  tint: [number, number, number, number]
  uvScroll: [number, number]
  followCamera: boolean
  /** Frames a particle lives; 0 means forever (the sea is one of these). */
  life: number
  /**
   * KeyFrame chunk names this generator samples over each particle's life, by
   * the channel they drive. See KEYFRAME_CHANNELS.
   */
  tracks: Partial<Record<KeyFrameChannel, string>>
  /** Attach type, the low nibble of body[0]: 0xE sun, 0xF moon, 0 none. */
  attach: number
  /** The 0x1E blend byte, or -1 when the generator carries none. */
  blend: number
  /** Time-of-day KeyFrame ids (0x60–0x63), sampled by the fraction of the day. */
  todTracks: Partial<Record<'r' | 'g' | 'b' | 'alpha', string>>
  /** 0x0B: rotation per frame, radians (West Ronfaure's cld1 turns 1.75e-4 about Y). */
  spin: [number, number, number]
  /** What the setup links: an MMB or D3M mesh (0x0B), or a 0x21 sprite (0x0E). */
  link: 'mesh' | 'sprite'
  /** Setup flags' billboard bits (0x1 faces the camera; 0x4 is followCamera). */
  billboard: number
  /**
   * Setup flags' high half, the render state (xim ParticleInitializers.kt
   * StandardParticleSetup): 0x0080 the particle stays where it was born
   * instead of riding the generator, 0x0200 no fog (Thunder's flashes), 0x0400
   * the base position is an offset from the camera (Jugner's rain mist).
   */
  renderState: number
  emission: Emission
  /** 0x06 / 0x07 / 0x1F: where around the generator each particle is born. */
  spread: Spread | null
  /** 0x02 velocity and 0x03 its variance (x rand -1..1), per frame. */
  velocity: [number, number, number]
  velocityVariance: [number, number, number]
  /** Section-3 0x03: added to the velocity each frame. */
  accel: [number, number, number]
  /** Section-3 0x02 present: the velocity actually moves the particle. */
  moves: boolean
  /** 0x0A, x rand -1..1, radians. */
  rotationVariance: [number, number, number]
  /** 0x10 per axis and 0x11 uniform, x rand 0..1, added to the scale. */
  scaleVariance: [number, number, number]
  /** 0x12, per frame, applied while section 3 carries 0x08. */
  scaleVelocity: [number, number, number]
}

/**
 * When a generator emits, from the header at body 0x64 (xim
 * ParticleGeneratorParser.kt, as a format reference): u16 variance, u16
 * frames-between minus one, u8 count, u8 flags (bit 0 is the count's ninth
 * bit, 0x04 continuous, 0x10 auto-run), u8, u8 (0x20 batched — weather).
 *
 * A generator emits on its first frame, then every `every` + 0..`variance`
 * frames. Thunder's flashes are why this matters: Lufaise's `lig1` emits a
 * 30-frame flash every 2041-2281 frames (34-38 s), `lig2` every 201-241, and
 * the bolt `thd1` every 400 — drawn back to back, they strobed.
 */
export interface Emission {
  every: number
  variance: number
  count: number
  continuous: boolean
  batched: boolean
}

/**
 * A spawn spread (xim ParticleGeneratorSettings.kt PositionVariance, as a
 * reference): a random azimuth, a tilt of `tilt` + `tiltVariance` x rand(-1..1)
 * from the horizontal, at `baseRadius` + `radiusVariance` x cbrt(rand 0..1),
 * then scaled per axis and turned by rotZ, rotY.
 */
export interface Spread {
  radiusVariance: number
  baseRadius: number
  axis: [number, number, number]
  rotZ: number
  rotY: number
  tilt: number
  tiltVariance: number
}

const TOD_CHANNELS = { 0x60: 'r', 0x61: 'g', 0x62: 'b', 0x63: 'alpha' } as const

/**
 * Section-2 opcodes 0x21-0x2F bind a KeyFrame chunk (4-char id at payload+4) to
 * a particle channel; the matching section-3 updater, 0x12 lower (0x0F-0x1D),
 * samples it by life progress each frame. Table from xim's
 * ParticleGeneratorParser.kt (github.com/Heyrio/FFXI-BROWSER-GAME, GPL-3.0; read
 * as a format reference only). Gustaberg's rolling surf is 0x2E, texture U:
 * the foam texture slides across each surf strip and back on a bell curve.
 */
export const KEYFRAME_CHANNELS = {
  0x21: 'posX', 0x22: 'posY', 0x23: 'posZ',
  0x24: 'rotX', 0x25: 'rotY', 0x26: 'rotZ',
  0x27: 'scaleX', 0x28: 'scaleY', 0x29: 'scaleZ',
  0x2a: 'r', 0x2b: 'g', 0x2c: 'b', 0x2d: 'alpha',
  0x2e: 'u', 0x2f: 'v',
} as const
export type KeyFrameChannel = (typeof KEYFRAME_CHANNELS)[keyof typeof KEYFRAME_CHANNELS]

const HEADER_LEN = 0x80
const OP_END = 0x00
const SIZE_WORDS_MASK = 0x1f
const LINKED_MODEL = 0x0b
const LINKED_SPRITE = 0x0e
const FLAG_FOLLOW_CAMERA = 0x4
const EMISSION_AT = 0x64

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
  const f = (p: number) => view.getFloat32(p, true)

  let model = ''
  let linked = -1
  let flags = 0
  let position: [number, number, number] = [0, 0, 0]
  let rotation: [number, number, number] = [0, 0, 0]
  let scale: [number, number, number] = [1, 1, 1]
  let tint: [number, number, number, number] = [0x80, 0x80, 0x80, 0x80]
  let life = 0
  const tracks: Partial<Record<KeyFrameChannel, string>> = {}
  const todTracks: RawModelSpawn['todTracks'] = {}
  let blend = -1
  let spin: [number, number, number] = [0, 0, 0]
  const flags1 = body[EMISSION_AT + 5]
  const emission: Emission = {
    every: view.getUint16(EMISSION_AT + 2, true) + 1,
    variance: view.getUint16(EMISSION_AT, true),
    count: body[EMISSION_AT + 4] | ((flags1 & 1) << 8),
    continuous: (flags1 & 0x04) !== 0,
    batched: (body[EMISSION_AT + 7] & 0x20) !== 0,
  }
  let spread: Spread | null = null
  let velocity: [number, number, number] = [0, 0, 0]
  let velocityVariance: [number, number, number] = [0, 0, 0]
  let rotationVariance: [number, number, number] = [0, 0, 0]
  const scaleVariance: [number, number, number] = [0, 0, 0]
  let scaleVelocity: [number, number, number] = [0, 0, 0]
  const readId = (p: number) => {
    let end = p + 4
    while (end < p + 8 && body[end] !== 0) end++
    return String.fromCharCode(...body.subarray(p + 4, end)).trim()
  }

  for (const { op, p } of records(view, body, 0x74)) {
    if (op === 0x01 && p + 30 <= body.length) {
      flags = view.getUint32(p, true)
      let end = p + 8
      while (end < p + 16 && body[end] !== 0) end++
      model = String.fromCharCode(...body.subarray(p + 8, end)).trim()
      position = f3(p + 16)
      linked = body[p + 29]
      // u16 max life in frames at +30 (0 = forever), u16 variance at +32.
      if (p + 32 <= body.length) life = view.getUint16(p + 30, true)
    } else if (op === 0x09 && p + 12 <= body.length) {
      rotation = f3(p)
    } else if (op === 0x0f && p + 12 <= body.length) {
      scale = f3(p)
    } else if (op === 0x16 && p + 4 <= body.length) {
      tint = [body[p], body[p + 1], body[p + 2], body[p + 3]]
    } else if (op === 0x0b && p + 12 <= body.length) {
      spin = f3(p)
    } else if (op === 0x02 && p + 12 <= body.length) {
      velocity = f3(p)
    } else if (op === 0x03 && p + 12 <= body.length) {
      velocityVariance = f3(p)
    } else if (op === 0x06 && p + 8 <= body.length) {
      spread = { radiusVariance: f(p), baseRadius: f(p + 4), axis: [1, 1, 1], rotZ: 0, rotY: 0, tilt: 0, tiltVariance: Math.PI }
    } else if (op === 0x07 && p + 28 <= body.length) {
      spread = {
        radiusVariance: f(p) * (emission.batched ? 2 : 1), baseRadius: f(p + 4), axis: f3(p + 8),
        rotZ: 0, rotY: f(p + 24), tilt: 0, tiltVariance: Math.PI,
      }
    } else if (op === 0x1f && p + 36 <= body.length) {
      spread = {
        radiusVariance: f(p), baseRadius: f(p + 4), axis: f3(p + 8),
        rotZ: f(p + 20), rotY: f(p + 24), tilt: f(p + 28), tiltVariance: f(p + 32),
      }
    } else if (op === 0x0a && p + 12 <= body.length) {
      rotationVariance = f3(p)
    } else if (op === 0x10 && p + 12 <= body.length) {
      const v = f3(p)
      for (let k = 0; k < 3; k++) scaleVariance[k] += v[k]
    } else if (op === 0x12 && p + 12 <= body.length) {
      scaleVelocity = f3(p)
    } else if (op === 0x1e && p + 1 <= body.length) {
      blend = body[p]
    } else if (op in TOD_CHANNELS && p + 8 <= body.length) {
      const id = readId(p)
      if (id) todTracks[TOD_CHANNELS[op as keyof typeof TOD_CHANNELS]] = id
    } else if (op in KEYFRAME_CHANNELS && p + 8 <= body.length) {
      let end = p + 4
      while (end < p + 8 && body[end] !== 0) end++
      const id = String.fromCharCode(...body.subarray(p + 4, end)).trim()
      if (id) tracks[KEYFRAME_CHANNELS[op as keyof typeof KEYFRAME_CHANNELS]] = id
    }
  }
  if ((linked !== LINKED_MODEL && linked !== LINKED_SPRITE) || !model) return null

  const uvScroll: [number, number] = [0, 0]
  let accel: [number, number, number] = [0, 0, 0]
  let moves = false
  let scales = false
  for (const { op, p } of records(view, body, 0x78)) {
    if (op === 0x27 && p + 4 <= body.length) uvScroll[0] = view.getFloat32(p, true)
    if (op === 0x28 && p + 4 <= body.length) uvScroll[1] = view.getFloat32(p, true)
    if (op === 0x02) moves = true
    if (op === 0x08) scales = true
    if (op === 0x03 && p + 12 <= body.length) accel = f3(p)
  }

  return {
    model, position, rotation, scale, tint, uvScroll, life, tracks, blend, todTracks, spin,
    attach: view.getUint16(0, true) & 0xf,
    followCamera: (flags & FLAG_FOLLOW_CAMERA) !== 0,
    link: linked === LINKED_SPRITE ? 'sprite' : 'mesh',
    billboard: flags & 0xffff & ~FLAG_FOLLOW_CAMERA,
    renderState: flags >>> 16,
    emission, spread, velocity, velocityVariance, accel, moves, rotationVariance, scaleVariance,
    scaleVelocity: scales ? scaleVelocity : [0, 0, 0],
  }
}

/**
 * A KeyFrame chunk (DAT block type 0x19): (time, value) pairs of f32, time
 * running 0 to 1 across a particle's life, ending at time 1; anything after is
 * padding. Gustaberg's surf curve `ngpu` rises 0 -> 0.36 at t = 0.5 and back.
 * Returned flat as [t0, v0, t1, v1, ...].
 */
export function parseKeyFrames(body: Uint8Array): number[] | null {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  const out: number[] = []
  let last = -1
  for (let o = 0; o + 8 <= body.length; o += 8) {
    const t = view.getFloat32(o, true)
    const v = view.getFloat32(o + 4, true)
    if (!(t >= last) || t > 1.0001) break   // times rise monotonically to 1
    out.push(t, v)
    last = t
    if (t >= 0.9999) break
  }
  return out.length >= 4 ? out : null
}

/** Linear interpolation into a curve from parseKeyFrames. */
export function sampleKeyFrames(curve: number[], t: number): number {
  if (t <= curve[0]) return curve[1]
  for (let i = 2; i < curve.length; i += 2) {
    if (t <= curve[i]) {
      const t0 = curve[i - 2], v0 = curve[i - 1], t1 = curve[i], v1 = curve[i + 1]
      return t1 > t0 ? v0 + ((t - t0) / (t1 - t0)) * (v1 - v0) : v1
    }
  }
  return curve[curve.length - 1]
}
