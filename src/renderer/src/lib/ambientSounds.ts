import type { ZoneSound } from './ffxi-dat/types'
import { load, loopStartOf, soundContext } from './footstepSounds'

/**
 * The zone's own ambient sounds (ParsedZone.ambient): waterfalls, rivers,
 * birds, machinery, played around a listener.
 *
 * Each generator names a sound, a place and a range (xim AudioEmitter): full
 * strength within `near`, fading to nothing at `far`. An endless one loops
 * while in range; the rest play once, then again `every` frames after they
 * end (AudioRangeSetup keeps one alive at a time). A sound on a path is heard
 * from the path's nearest point, at full strength inside its radius.
 *
 * Only the loudest MAX_VOICES play at once. Positions are DAT space.
 */

const MAX_VOICES = 24
/** A sound with no range of its own carries this far (xim's cut-off for unranged one-shots). */
const DEFAULT_FAR = 25
/** Seconds a gain change glides over, so moving does not click. */
const GLIDE = 0.15

/** ?census=1: the playing set is published as window.__amb. */
const CENSUS = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('census')

interface Voice {
  src: AudioBufferSourceNode
  gain: GainNode
  ends: number
}

/** Nearest point on a path to `at`, and the distance outside its radius (0 inside). */
function nearestOnPath(path: NonNullable<ZoneSound['path']>, at: [number, number, number]): number {
  let best = Infinity
  for (const [i, j] of path.segments) {
    const a = path.points[i], b = path.points[j]
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const len2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2]
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((at[0] - a[0]) * d[0] + (at[1] - a[1]) * d[1] + (at[2] - a[2]) * d[2]) / len2)) : 0
    const c = [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t]
    const r = a[3] + (b[3] - a[3]) * t
    best = Math.min(best, Math.max(0, Math.hypot(at[0] - c[0], at[1] - c[1], at[2] - c[2]) - r))
  }
  return best
}

export class AmbientSounds {
  private readonly sounds: ZoneSound[]
  private readonly voices = new Map<number, Voice>()
  /** When each one-shot may play again, seconds on the audio clock. */
  private readonly nextAt = new Map<number, number>()
  private readonly loading = new Set<number>()
  /** Sound numbers that would not decode (missing, or a codec bgw.ts lacks). */
  private readonly failed = new Set<number>()
  private volume = 0
  private disposed = false

  constructor(sounds: ZoneSound[]) {
    // Some generators are exact copies, same sound at the same spot (West
    // Ronfaure's aose birds): one voice each, or they play doubled.
    const seen = new Set<string>()
    this.sounds = sounds.filter(s => {
      const key = s.id + '|' + s.position.map(v => v.toFixed(2)).join(',') + '|' + (s.path ? s.path.points.length : '')
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  setVolume(v: number) {
    this.volume = v
    if (v <= 0) this.stopAll()
  }

  /** Re-pick and re-level the voices for a listener at `at` (DAT space). */
  update(at: [number, number, number]) {
    if (this.disposed || this.volume <= 0) return
    const levels: { k: number; level: number }[] = []
    this.sounds.forEach((s, k) => {
      const far = s.far > 0 ? s.far : DEFAULT_FAR
      const dist = s.path
        ? nearestOnPath(s.path, at)
        : Math.hypot(at[0] - s.position[0], at[1] - s.position[1], at[2] - s.position[2])
      if (dist >= far) return
      const level = dist <= s.near ? 1 : 1 - (dist - s.near) / Math.max(far - s.near, 1e-3)
      levels.push({ k, level })
    })
    levels.sort((a, b) => b.level - a.level)
    const chosen = new Map(levels.slice(0, MAX_VOICES).map(l => [l.k, l.level]))

    const ctx = soundContext()
    const now = ctx?.currentTime ?? 0
    for (const [k, voice] of this.voices) {
      const level = chosen.get(k)
      if (level === undefined) {
        // Out of range or crowded out: a loop stops, a one-shot finishes.
        if (this.sounds[k].loop) this.stop(k)
        else voice.gain.gain.setTargetAtTime(0, now, GLIDE)
      } else {
        voice.gain.gain.setTargetAtTime(level * this.volume, now, GLIDE)
      }
    }
    for (const [k, level] of chosen) {
      if (this.voices.has(k)) continue
      const s = this.sounds[k]
      if (!s.loop && ctx && now < (this.nextAt.get(k) ?? 0)) continue
      this.start(k, level)
    }
    if (CENSUS) {
      (window as unknown as { __amb?: unknown }).__amb = {
        playing: [...this.voices.keys()].map(k => ({ id: this.sounds[k].id, gen: this.sounds[k].dir + '/' + this.sounds[k].generator, loop: this.sounds[k].loop, level: +(chosen.get(k) ?? 0).toFixed(2) })),
        inRange: levels.length,
        failed: [...this.failed],
      }
    }
  }

  private start(k: number, level: number) {
    const s = this.sounds[k]
    if (this.loading.has(k)) return
    this.loading.add(k)
    load(s.id).then(buf => {
      this.loading.delete(k)
      if (!buf) this.failed.add(s.id)
      const ctx = soundContext()
      if (!buf || !ctx || this.disposed || this.volume <= 0 || this.voices.has(k)) return
      if (ctx.state === 'suspended') ctx.resume().catch(() => {})
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.loop = s.loop
      // The header's loop point: a loop can open with a lead-in it does not repeat.
      // (loopStart is ignored unless loopEnd is set too.)
      if (s.loop) { src.loopStart = Math.min(loopStartOf(buf), buf.duration); src.loopEnd = buf.duration }
      const gain = ctx.createGain()
      gain.gain.value = level * this.volume
      src.connect(gain).connect(ctx.destination)
      src.start()
      const voice = { src, gain, ends: ctx.currentTime + buf.duration }
      this.voices.set(k, voice)
      if (!s.loop) {
        src.onended = () => {
          if (this.voices.get(k) === voice) this.voices.delete(k)
          this.nextAt.set(k, ctx.currentTime + s.every / 60)
        }
      }
    })
  }

  private stop(k: number) {
    const v = this.voices.get(k)
    if (!v) return
    this.voices.delete(k)
    const ctx = soundContext()
    if (ctx) {
      // A short fade, then stop: cutting a waveform mid-cycle clicks.
      v.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.05)
      try { v.src.stop(ctx.currentTime + 0.3) } catch { /* already stopped */ }
    }
  }

  private stopAll() {
    for (const k of [...this.voices.keys()]) this.stop(k)
  }

  dispose() {
    this.disposed = true
    this.stopAll()
  }
}
