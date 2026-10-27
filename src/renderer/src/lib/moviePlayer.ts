import JSMpeg from '../vendor/jsmpeg/jsmpeg.js'

/**
 * Cutscenes -> Movies: FFXI's pre-rendered movie, played from the install.
 *
 * `mov/movNNN.pmv` is "PMUS" (4 bytes, plain) and then an MPEG-1 video
 * elementary stream XOR'd with an 8-byte key, the key's position the file
 * offset mod 8 (found from runs of scrambled zeros; HANDOFF "Cutscene
 * player"). The sound is `mov/musicNNN.bgw`, a plain WAV. mov999 is the
 * opening movie: 512x336, 29.97 fps, 7:01.
 *
 * Video is decoded by jsmpeg (vendor/jsmpeg, MIT, with B-picture support and a
 * slice-end fix added; its README) fed straight from the
 * file a megabyte at a time, unscrambled on the way, never held whole; the
 * sound is the clock, and the decoder catches up to it each frame. Seeking
 * restarts the decoder at the nearest group of pictures (each opens with a
 * sequence header), found by one pass over the file when the movie opens.
 */

const KEY = [0xc2, 0xee, 0x9c, 0xd9, 0xbd, 0x6c, 0x4d, 0x72]
const FPS = 30000 / 1001
/** Keep at least this much of the stream ahead of the decoder: a whole picture must be there before it decodes. */
const AHEAD = 2 << 20
const CHUNK = 1 << 20

export interface MovieEntry { name: string; video: string; audio: string | null }

/** The install's movies: mov/movNNN.pmv, each with mov/musicNNN.bgw when there is one. */
export async function listMovies(root: string): Promise<MovieEntry[]> {
  const names = await window.ffxi.listDir(root, 'mov')
  return names.filter(n => /^mov\d+\.pmv$/i.test(n)).map(n => {
    const num = /\d+/.exec(n)![0]
    const audio = names.find(m => m.toLowerCase() === `music${num}.bgw`)
    return { name: num === '999' ? 'Opening movie' : `Movie ${num}`, video: `mov/${n}`, audio: audio ? `mov/${audio}` : null }
  })
}

const unscramble = (bytes: Uint8Array, fileOffset: number) => {
  for (let i = 0; i < bytes.length; i++) bytes[i] ^= KEY[(fileOffset + i) & 7]
}

/**
 * Each group of pictures: where it starts in the file and the display number
 * of its keyframe, the first picture a fresh decoder shows (the B-pictures
 * coded after it but shown before it need the previous group, and are skipped).
 */
interface Group { offset: number; frame: number }

export class MoviePlayer {
  private decoder: { write(pts: number, b: Uint8Array): void; decode(): boolean; connect(d: unknown): void; destroy(): void; bits: { byteLength: number; index: number } } | null = null
  private renderer: { destroy(): void } | null = null
  private groups: Group[] = []
  private size = 0
  private readPos = 0
  private frame = -1
  private ctx: AudioContext | null = null
  private gain: GainNode | null = null
  private audio: AudioBuffer | null = null
  private source: AudioBufferSourceNode | null = null
  private startedAt = 0
  private offset = 0
  private raf = 0
  private feeding: Promise<void> | null = null
  playing = false
  duration = 0
  width = 512
  height = 336
  onState?: () => void

  constructor(private root: string, private movie: MovieEntry, private canvas: HTMLCanvasElement) {}

  /** Finds the groups of pictures, decodes the sound and shows the first frame. */
  async open(progress?: (fraction: number) => void): Promise<void> {
    // pictures: coded so far; open: the group whose keyframe is still to come.
    let carry = new Uint8Array(0), at = 4, pictures = 0, open: Group | null = null
    for (;;) {
      const { bytes, size } = await window.ffxi.readRange(this.root, this.movie.video, at, 16 << 20)
      this.size = size
      const chunk = new Uint8Array(bytes)
      if (!chunk.length) break
      unscramble(chunk, at)
      const buf = new Uint8Array(carry.length + chunk.length)
      buf.set(carry); buf.set(chunk, carry.length)
      const base = at - carry.length
      for (let i = 0; i + 5 < buf.length; i++) {
        if (buf[i] !== 0 || buf[i + 1] !== 0 || buf[i + 2] !== 1) continue
        if (buf[i + 3] === 0xb3) { open = { offset: base + i, frame: pictures }; this.groups.push(open) }
        else if (buf[i + 3] === 0) {
          // Picture header: temporal reference (10 bits, display order within the group), then type.
          if (open) { open.frame += (buf[i + 4] << 2) | (buf[i + 5] >> 6); open = null }
          pictures++
        }
      }
      carry = buf.slice(buf.length - 5)
      at += chunk.length
      progress?.(at / size)
    }
    this.duration = pictures / FPS
    if (this.movie.audio) {
      this.ctx = new AudioContext()
      this.gain = this.ctx.createGain()
      this.gain.connect(this.ctx.destination)
      this.audio = await this.ctx.decodeAudioData(await window.ffxi.readDat(this.root, this.movie.audio))
      this.duration = Math.max(this.duration, this.audio.duration)
    }
    await this.restartAt(0)
    this.decodeTo(0)
  }

  /** A fresh decoder at the group holding `frame`. */
  private async restartAt(frame: number): Promise<void> {
    this.decoder?.destroy()
    let g = this.groups[0]
    for (const x of this.groups) { if (x.frame <= frame) g = x; else break }
    // One renderer for the movie's life: destroying WebGL's would lose the canvas's context.
    if (!this.renderer) {
      const R = JSMpeg.Renderer.WebGL.IsSupported() ? JSMpeg.Renderer.WebGL : JSMpeg.Renderer.Canvas2D
      this.renderer = new R({ canvas: this.canvas })
    }
    this.decoder = new JSMpeg.Decoder.MPEG1Video({ streaming: true, videoBufferSize: 8 << 20, decodeFirstFrame: false })
    // Counts pictures as they're shown: with B-pictures, decode order isn't display order.
    const r = this.renderer as unknown as { resize(w: number, h: number): void; render(y: Uint8Array, cr: Uint8Array, cb: Uint8Array, full: boolean): void }
    this.decoder!.connect({ resize: (w: number, h: number) => r.resize(w, h), render: (y: Uint8Array, cr: Uint8Array, cb: Uint8Array, full: boolean) => { this.frame++; r.render(y, cr, cb, full) } })
    this.readPos = g?.offset ?? 4
    this.frame = (g?.frame ?? 0) - 1
    await this.feed()
  }

  /** Keeps AHEAD bytes of the stream in the decoder. */
  private async feed(): Promise<void> {
    const d = this.decoder
    while (d && this.readPos < this.size && d.bits.byteLength - (d.bits.index >> 3) < AHEAD) {
      const { bytes } = await window.ffxi.readRange(this.root, this.movie.video, this.readPos, CHUNK)
      const chunk = new Uint8Array(bytes)
      if (!chunk.length) break
      unscramble(chunk, this.readPos)
      if (d !== this.decoder) return
      d.write(0, chunk)
      this.readPos += chunk.length
    }
  }

  /** Decodes up to `frame`, drawing each picture shown; stops when the buffer runs low. */
  private decodeTo(frame: number): void {
    const d = this.decoder
    if (!d) return
    let budget = 8
    while (this.frame < frame && budget-- > 0) {
      const ahead = d.bits.byteLength - (d.bits.index >> 3)
      if (ahead < AHEAD / 2 && this.readPos < this.size) break
      if (!d.decode()) break
    }
    if (!this.feeding) this.feeding = this.feed().finally(() => { this.feeding = null })
  }

  get time(): number {
    if (!this.playing || !this.ctx) return this.offset
    return Math.min(this.duration, this.offset + (this.ctx.currentTime - this.startedAt))
  }

  play(): void {
    if (this.playing) return
    if (this.ctx && this.audio && this.gain) {
      if (this.ctx.state === 'suspended') void this.ctx.resume()
      const s = this.ctx.createBufferSource()
      s.buffer = this.audio
      s.connect(this.gain)
      s.start(0, this.offset)
      this.source = s
      this.startedAt = this.ctx.currentTime
    }
    this.playing = true
    const tick = () => {
      if (!this.playing) return
      const t = this.time
      this.decodeTo(Math.floor(t * FPS))
      if (t >= this.duration - 0.05) { this.pause(); this.offset = 0 }
      this.onState?.()
      this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)
    this.onState?.()
  }

  pause(): void {
    this.offset = this.time
    this.playing = false
    cancelAnimationFrame(this.raf)
    try { this.source?.stop() } catch { /* stopped */ }
    this.source = null
    this.onState?.()
  }

  async seek(seconds: number): Promise<void> {
    const was = this.playing
    if (was) this.pause()
    this.offset = Math.max(0, Math.min(seconds, this.duration - 0.1))
    const target = Math.floor(this.offset * FPS)
    await this.restartAt(target)
    // Decode from the group's first picture up to the target, a few at a time.
    while (this.frame < target) {
      const before = this.frame
      this.decodeTo(target)
      if (this.frame === before) await this.feed()
      if (this.frame === before && this.readPos >= this.size) break
    }
    if (was) this.play()
    this.onState?.()
  }

  setVolume(v: number): void { if (this.gain) this.gain.gain.value = v }

  /** Frames decoded so far (for checks). */
  get decodedFrame(): number { return this.frame }

  dispose(): void {
    this.pause()
    this.decoder?.destroy()
    this.renderer?.destroy()
    void this.ctx?.close()
  }
}
