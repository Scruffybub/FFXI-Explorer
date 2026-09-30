import type { ZoneEnvLight, ZoneEnvRecord } from './types'

/**
 * FFXI's per-zone environment records: DAT block 0x2F.
 *
 * One record per weather state and time of day. The chunk name is the time as
 * HHMM ("0600", "1200") and the record sits in <zone>/weat/<state>/, where the
 * state is fine, clod (clouds), mist, suny and so on. Each record carries the
 * sky gradient, the terrain and model lighting, fog, and the clear colour — the
 * game interpolates between the records either side of the current hour.
 *
 * Layout, 176 bytes, from xim's EnvironmentSection.kt (Heyrio/FFXI-BROWSER-GAME)
 * and kuluu-ffxi's ffxi-dat/src/weather.rs, both GPL and read as format
 * references only; this is an independent implementation:
 *
 *   0    u32  indoor flag (1 = indoors)
 *   12   model light:   sun, moon, ambient, fog (RGBA bytes each), fog end f32,
 *                       fog start f32, diffuse multiplier f32
 *   44   terrain light: same layout
 *   76   clear colour RGBA
 *   88   far clip f32
 *   108  sky gradient: 8 RGBA, horizon to zenith
 *   140  their 8 altitudes f32, each a fraction of the way from the horizon (0)
 *        to the zenith (1) — retail builds the dome as a lathe at
 *        angle = altitude × π/2
 *
 * Colours are stored R, G, B, A. They are returned here as raw byte / 255; how
 * the game scales ambient and diffuse for lighting is left to the consumer.
 */
export const ENV_RECORD_SIZE = 176

function rgb(view: DataView, off: number): [number, number, number] {
  return [view.getUint8(off) / 255, view.getUint8(off + 1) / 255, view.getUint8(off + 2) / 255]
}

function light(view: DataView, off: number): ZoneEnvLight {
  return {
    sun: rgb(view, off),
    moon: rgb(view, off + 4),
    ambient: rgb(view, off + 8),
    fog: rgb(view, off + 12),
    fogEnd: view.getFloat32(off + 16, true),
    fogStart: view.getFloat32(off + 20, true),
    diffuse: view.getFloat32(off + 24, true),
  }
}

/** Minutes past midnight from an HHMM chunk name, or null if it is not one. */
export function timeFromChunkName(name: string): number | null {
  const s = name.replace(/\0/g, '').trim()
  if (!/^\d{4}$/.test(s)) return null
  const hh = Number(s.slice(0, 2)), mm = Number(s.slice(2))
  return hh < 24 && mm < 60 ? hh * 60 + mm : null
}

/**
 * Parse one 0x2F body. `state` is the weather directory the chunk sits in.
 * Returns null for a malformed chunk, and for a record whose sky gradient is
 * entirely black: those are placeholders that would paint the sky out.
 */
export function parseEnvironmentRecord(
  name: string, dir: string, state: string, body: Uint8Array,
): ZoneEnvRecord | null {
  const minutes = timeFromChunkName(name)
  if (minutes === null || body.length < ENV_RECORD_SIZE) return null
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  const skyColors: number[] = []
  const skyAltitudes: number[] = []
  for (let i = 0; i < 8; i++) {
    skyColors.push(...rgb(view, 108 + i * 4))
    skyAltitudes.push(view.getFloat32(140 + i * 4, true))
  }
  if (skyColors.every(c => c === 0)) return null
  return {
    state, dir, minutes,
    indoors: view.getUint32(0, true) === 1,
    model: light(view, 12),
    terrain: light(view, 44),
    clearColor: rgb(view, 76),
    farClip: view.getFloat32(88, true),
    skyColors,
    skyAltitudes,
  }
}

/** A sky gradient: 8 sRGB colours (flat, 3 each) and their 8 altitudes. */
export interface SkyGradient {
  colors: number[]
  altitudes: number[]
}

/**
 * The sky gradient for a time of day, interpolated between the records either
 * side of it and wrapping through midnight, as the game blends its keyframes.
 * `records` must all belong to one weather state.
 */
export function sampleSkyGradient(records: ZoneEnvRecord[], minutes: number): SkyGradient | null {
  if (records.length === 0) return null
  const sorted = [...records].sort((a, b) => a.minutes - b.minutes)
  const m = ((minutes % 1440) + 1440) % 1440
  let hi = sorted.findIndex(r => r.minutes > m)
  if (hi < 0) hi = 0
  const lo = (hi - 1 + sorted.length) % sorted.length
  const a = sorted[lo], b = sorted[hi]
  const span = ((b.minutes - a.minutes) + 1440) % 1440 || 1440
  const t = sorted.length === 1 ? 0 : (((m - a.minutes) + 1440) % 1440) / span
  const lerp = (x: number[], y: number[]) => x.map((v, i) => v + (y[i] - v) * t)
  return { colors: lerp(a.skyColors, b.skyColors), altitudes: lerp(a.skyAltitudes, b.skyAltitudes) }
}
