/**
 * Zone background music: find the track, decode it, play it, loop it.
 *
 * The zone → track mapping is `resources/zone-music.json`, built from
 * LandSandBoat's `zone_settings` by `scripts/build-zone-music.cjs`. 151 of 298
 * zones have no ambient track at all, which is normal and not an error.
 */
import zoneMusicTable from '../../../../resources/zone-music.json'
import { decodeBgw, readBgwHeader, type DecodedAudio } from './bgw'

interface ZoneMusicEntry {
  name: string
  day: number
  night: number
  solo: number
  multi: number
}

const TABLE = zoneMusicTable as unknown as Record<string, ZoneMusicEntry>

/**
 * Directories to search for a track, in order.
 *
 * The sound directories overlay like the ROM directories. Two numbers exist in
 * two places — `music068` in `sound` and `sound9`, `music181` in `sound2` and
 * `sound5` — so the order is a real choice rather than a formality. Base first
 * is the conservative pick: it is the copy that has always been there. Neither
 * duplicate is an ambient zone track, so nothing currently depends on it.
 */
const SOUND_DIRS = ['sound', 'sound2', 'sound3', 'sound4', 'sound5', 'sound6', 'sound7', 'sound8', 'sound9']

/** The ambient track id for a zone, or null if the zone is silent. */
export function ambientTrackForZone(zoneId: number): number | null {
  const e = TABLE[String(zoneId)]
  if (!e) return null
  return e.day > 0 ? e.day : null
}

/** Locates a track's file, or null if this install does not have it. */
export async function findTrackPath(root: string, trackId: number): Promise<string | null> {
  const name = `music${String(trackId).padStart(3, '0')}.bgw`
  for (const dir of SOUND_DIRS) {
    const rel = `${dir}/win/music/data/${name}`
    if (await window.ffxi.fileExists(root, rel)) return rel
  }
  return null
}

export type MusicStatus =
  | { state: 'silent' }
  | { state: 'loading'; track: number }
  | { state: 'playing'; track: number; seconds: number; loops: boolean }
  | { state: 'unsupported'; track: number; codec: number }
  | { state: 'missing'; track: number }
  | { state: 'error'; track: number; message: string }

/**
 * Owns the AudioContext and whatever is currently playing.
 *
 * One track at a time. Loading is generation-guarded because zone switches can
 * outrun a decode — a 4-minute track is ~23M samples and takes a moment.
 */
export class ZoneMusicPlayer {
  private ctx: AudioContext | null = null
  private gain: GainNode | null = null
  private source: AudioBufferSourceNode | null = null
  private generation = 0
  private volume = 0.5

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext()
      this.gain = this.ctx.createGain()
      this.gain.gain.value = this.volume
      this.gain.connect(this.ctx.destination)
    }
    return this.ctx
  }

  setVolume(v: number): void {
    this.volume = v
    if (this.gain && this.ctx) {
      // A short ramp rather than a jump, or the slider clicks audibly.
      this.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02)
    }
  }

  stop(): void {
    this.generation++
    if (this.source) {
      try { this.source.stop() } catch { /* already stopped */ }
      this.source.disconnect()
      this.source = null
    }
  }

  /** Loads and plays a zone's ambient track. Safe to call on every zone change. */
  async playZone(
    root: string,
    zoneId: number,
    onStatus: (s: MusicStatus) => void,
  ): Promise<void> {
    this.stop()
    const gen = this.generation

    const track = ambientTrackForZone(zoneId)
    if (track === null) { onStatus({ state: 'silent' }); return }

    onStatus({ state: 'loading', track })
    try {
      const rel = await findTrackPath(root, track)
      if (gen !== this.generation) return
      if (!rel) { onStatus({ state: 'missing', track }); return }

      const raw = await window.ffxi.readDat(root, rel)
      if (gen !== this.generation) return
      const bytes = new Uint8Array(raw)

      const header = readBgwHeader(bytes)
      if (header && header.codec !== 0) {
        // Codec 3 is encrypted ATRAC3 — see lib/bgw.ts. Report rather than
        // fail silently, so a quiet zone can be told from a broken one.
        onStatus({ state: 'unsupported', track, codec: header.codec })
        return
      }

      const decoded = decodeBgw(bytes)
      if (gen !== this.generation) return
      if (!decoded) { onStatus({ state: 'error', track, message: 'decode failed' }); return }

      this.start(decoded)
      onStatus({
        state: 'playing',
        track,
        seconds: decoded.channels[0].length / decoded.sampleRate,
        loops: decoded.loopStartSample !== null,
      })
    } catch (err) {
      if (gen !== this.generation) return
      onStatus({ state: 'error', track, message: String(err) })
    }
  }

  private start(audio: DecodedAudio): void {
    const ctx = this.ensureContext()
    // Autoplay policy: a context created before any gesture starts suspended.
    if (ctx.state === 'suspended') void ctx.resume()

    const buffer = ctx.createBuffer(
      audio.channels.length, audio.channels[0].length, audio.sampleRate,
    )
    for (let c = 0; c < audio.channels.length; c++) {
      buffer.copyToChannel(audio.channels[c], c)
    }

    const src = ctx.createBufferSource()
    src.buffer = buffer
    if (audio.loopStartSample !== null) {
      src.loop = true
      src.loopStart = audio.loopStartSample / audio.sampleRate
      src.loopEnd = buffer.duration
    } else {
      // FFXI's own tracks all repeat; a track with no loop point restarts
      // whole rather than falling silent partway through a zone visit.
      src.loop = true
    }
    src.connect(this.gain!)
    src.start()
    this.source = src
  }

  dispose(): void {
    this.stop()
    if (this.ctx) { void this.ctx.close(); this.ctx = null; this.gain = null }
  }
}
