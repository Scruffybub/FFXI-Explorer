import type { DecodedAudio } from './bgw'

/**
 * Models -> Sounds -> Export: decoded game audio to a file.
 *
 * - **WAV**: 16-bit PCM, exact.
 * - **FLAC**: lossless and about half the size; encoded here (fixed
 *   predictors of order 0-4, Rice-coded residuals in partitions), so no
 *   third-party encoder or licence is involved. Chromium decodes the result
 *   back sample for sample, which is how it is checked.
 * - **Ogg Opus**: small and lossy (160 kbit/s), encoded by Chromium's own
 *   WebCodecs Opus encoder at 48 kHz (resampled with an OfflineAudioContext),
 *   wrapped in Ogg pages here.
 *
 * Music can go out once, or arranged the way game music is usually ripped:
 * the intro, the loop twice, then the loop again fading out over 10 seconds.
 */

export type ExportFormat = 'wav' | 'flac' | 'opus'

/** The samples to write: once as decoded, or the intro + loop x2 + a 10-second fade. */
export function arrange(audio: DecodedAudio, loopTwice: boolean): DecodedAudio {
  const length = audio.channels[0].length
  const loop = audio.loopStartSample
  if (!loopTwice || loop === null || loop >= length - audio.sampleRate) return audio
  const body = length - loop
  const fade = Math.min(body, audio.sampleRate * 10)
  const total = length + body + fade
  const channels = audio.channels.map(src => {
    const out = new Float32Array(total)
    out.set(src, 0)
    out.set(src.subarray(loop), length)
    for (let i = 0; i < fade; i++) out[length + body + i] = src[loop + i] * (1 - i / fade)
    return out
  })
  return { channels, sampleRate: audio.sampleRate, loopStartSample: null }
}

const to16 = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v * 32767)))

export function encodeWav(audio: DecodedAudio): ArrayBuffer {
  const ch = audio.channels.length, n = audio.channels[0].length
  const buf = new ArrayBuffer(44 + n * ch * 2)
  const v = new DataView(buf)
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  str(0, 'RIFF'); v.setUint32(4, 36 + n * ch * 2, true); str(8, 'WAVE')
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true)
  v.setUint32(24, audio.sampleRate, true); v.setUint32(28, audio.sampleRate * ch * 2, true)
  v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true)
  str(36, 'data'); v.setUint32(40, n * ch * 2, true)
  let o = 44
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { v.setInt16(o, to16(audio.channels[c][i]), true); o += 2 }
  return buf
}

// ── FLAC ────────────────────────────────────────────────────────────────

class BitWriter {
  bytes = new Uint8Array(1 << 16)
  len = 0
  private acc = 0
  private bits = 0
  private grow(need: number) {
    if (this.len + need <= this.bytes.length) return
    const next = new Uint8Array(Math.max(this.bytes.length * 2, this.len + need + 1024))
    next.set(this.bytes.subarray(0, this.len)); this.bytes = next
  }
  /** Writes the low \`n\` bits of \`value\` (n <= 24), most significant first. */
  write(value: number, n: number) {
    this.acc = (this.acc << n) | (value & ((1 << n) - 1))
    this.bits += n
    this.grow(4)
    while (this.bits >= 8) { this.bits -= 8; this.bytes[this.len++] = (this.acc >>> this.bits) & 0xff }
    this.acc &= (1 << this.bits) - 1
  }
  writeLong(value: number, n: number) { if (n > 24) { this.write(Math.floor(value / 2 ** 24), n - 24); this.write(value % 2 ** 24, 24) } else this.write(value, n) }
  unary(q: number) { while (q >= 24) { this.write(0, 24); q -= 24 } this.write(1, q + 1) }
  align() { if (this.bits) this.write(0, 8 - this.bits) }
}

const CRC8 = new Uint8Array(256), CRC16 = new Uint16Array(256)
for (let i = 0; i < 256; i++) {
  let c = i
  for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff
  CRC8[i] = c
  let d = i << 8
  for (let k = 0; k < 8; k++) d = d & 0x8000 ? ((d << 1) ^ 0x8005) & 0xffff : (d << 1) & 0xffff
  CRC16[i] = d
}
const crc8 = (b: Uint8Array, from: number, to: number) => { let c = 0; for (let i = from; i < to; i++) c = CRC8[c ^ b[i]]; return c }
const crc16 = (b: Uint8Array, from: number, to: number) => { let c = 0; for (let i = from; i < to; i++) c = ((c << 8) & 0xffff) ^ CRC16[(c >> 8) ^ b[i]]; return c }

/** Fixed-predictor residual of \`order\` at i. */
function residual(x: Int32Array, i: number, order: number): number {
  switch (order) {
    case 0: return x[i]
    case 1: return x[i] - x[i - 1]
    case 2: return x[i] - 2 * x[i - 1] + x[i - 2]
    case 3: return x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3]
    default: return x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4]
  }
}

/** The Rice parameter (0-14) that writes these folded residuals in the fewest bits. */
function riceBits(u: Uint32Array, count: number): number {
  let best = 0, bestBits = Infinity
  for (let k = 0; k <= 14; k++) {
    let bits = 0
    for (let i = 0; i < count; i++) bits += (u[i] >>> k) + 1 + k
    if (bits < bestBits) { bestBits = bits; best = k }
  }
  return best
}

function writeSubframe(w: BitWriter, x: Int32Array) {
  const n = x.length
  // The fixed predictor order whose residuals are smallest.
  let best = 0, bestSum = Infinity
  for (let order = 0; order <= Math.min(4, n - 1); order++) {
    let s = 0
    for (let i = order; i < n; i++) s += Math.abs(residual(x, i, order))
    if (s < bestSum) { bestSum = s; best = order }
  }
  w.write(0, 1); w.write(0b001000 | best, 6); w.write(0, 1)
  for (let i = 0; i < best; i++) w.write(x[i], 16)
  // Residual: Rice, 4-bit parameters, partitions of 2^p blocks.
  let p = 0
  while (p < 8 && n % (1 << (p + 1)) === 0 && n >> (p + 1) > best && n >> (p + 1) >= 64) p++
  w.write(0, 2); w.write(p, 4)
  const per = n >> p
  for (let part = 0; part < 1 << p; part++) {
    const from = part === 0 ? best : part * per, to = (part + 1) * per
    const folded = new Uint32Array(to - from)
    for (let i = from; i < to; i++) { const r = residual(x, i, best); folded[i - from] = r < 0 ? -2 * r - 1 : 2 * r }
    const k = riceBits(folded, folded.length)
    w.write(k, 4)
    for (const u of folded) {
      w.unary(Math.floor(u / (1 << k)))
      if (k) w.write(u & ((1 << k) - 1), k)
    }
  }
}

export function encodeFlac(audio: DecodedAudio): ArrayBuffer {
  const ch = audio.channels.length, n = audio.channels[0].length, rate = audio.sampleRate
  const BLOCK = 4096
  const w = new BitWriter()
  // "fLaC", then STREAMINFO as the only (last) metadata block.
  for (const c of 'fLaC') w.write(c.charCodeAt(0), 8)
  w.write(0x80, 8); w.write(34, 24)
  w.write(BLOCK, 16); w.write(BLOCK, 16); w.write(0, 24); w.write(0, 24)
  w.write(rate, 20); w.write(ch - 1, 3); w.write(15, 5); w.writeLong(n, 36)
  for (let i = 0; i < 16; i++) w.write(0, 8)  // MD5 unknown: allowed as zeros
  const pcm = audio.channels.map(c => { const o = new Int32Array(c.length); for (let i = 0; i < c.length; i++) o[i] = to16(c[i]); return o })
  for (let frame = 0, at = 0; at < n; frame++, at += BLOCK) {
    const size = Math.min(BLOCK, n - at)
    const start = w.len
    w.write(0xfff8, 16)
    w.write(size === BLOCK ? 0b1100 : 0b0111, 4)  // 4096, or a 16-bit size at the end of the header
    w.write(0, 4)  // sample rate from STREAMINFO
    w.write(ch - 1, 4); w.write(0b100, 3); w.write(0, 1)  // independent channels, 16-bit
    // Frame number, UTF-8 style.
    if (frame < 0x80) w.write(frame, 8)
    else if (frame < 0x800) { w.write(0xc0 | (frame >> 6), 8); w.write(0x80 | (frame & 0x3f), 8) }
    else if (frame < 0x10000) { w.write(0xe0 | (frame >> 12), 8); w.write(0x80 | ((frame >> 6) & 0x3f), 8); w.write(0x80 | (frame & 0x3f), 8) }
    else { w.write(0xf0 | (frame >> 18), 8); w.write(0x80 | ((frame >> 12) & 0x3f), 8); w.write(0x80 | ((frame >> 6) & 0x3f), 8); w.write(0x80 | (frame & 0x3f), 8) }
    if (size !== BLOCK) w.write(size - 1, 16)
    w.write(crc8(w.bytes, start, w.len), 8)
    for (const c of pcm) writeSubframe(w, c.subarray(at, at + size))
    w.align()
    w.write(crc16(w.bytes, start, w.len), 16)
  }
  return w.bytes.slice(0, w.len).buffer
}

// ── Ogg Opus ────────────────────────────────────────────────────────────

const OGG_CRC = new Uint32Array(256)
for (let i = 0; i < 256; i++) { let c = i << 24; for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1; OGG_CRC[i] = c >>> 0 }

function oggPage(packet: Uint8Array, granule: number, serial: number, seq: number, flags: number): Uint8Array {
  const segments: number[] = []
  let left = packet.length
  while (left >= 255) { segments.push(255); left -= 255 }
  segments.push(left)
  const page = new Uint8Array(27 + segments.length + packet.length)
  const v = new DataView(page.buffer)
  page.set([0x4f, 0x67, 0x67, 0x53], 0)
  page[5] = flags
  v.setUint32(6, granule % 2 ** 32, true); v.setUint32(10, Math.floor(granule / 2 ** 32), true)
  v.setUint32(14, serial, true); v.setUint32(18, seq, true)
  page[26] = segments.length
  page.set(segments, 27)
  page.set(packet, 27 + segments.length)
  let crc = 0
  for (const b of page) crc = ((crc << 8) ^ OGG_CRC[((crc >>> 24) ^ b) & 0xff]) >>> 0
  v.setUint32(22, crc, true)
  return page
}

export async function encodeOggOpus(audio: DecodedAudio): Promise<ArrayBuffer> {
  const channels = Math.min(2, audio.channels.length)
  // Opus runs at 48 kHz: resample through an OfflineAudioContext.
  const frames48 = Math.ceil(audio.channels[0].length * 48000 / audio.sampleRate)
  const off = new OfflineAudioContext(channels, frames48, 48000)
  const src = off.createBuffer(channels, audio.channels[0].length, audio.sampleRate)
  for (let c = 0; c < channels; c++) src.copyToChannel(audio.channels[c] as Float32Array<ArrayBuffer>, c)
  const node = off.createBufferSource(); node.buffer = src; node.connect(off.destination); node.start()
  const pcm = await off.startRendering()

  const packets: { data: Uint8Array; samples: number }[] = []
  let failure: unknown = null
  const encoder = new AudioEncoder({
    output: chunk => {
      const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data)
      packets.push({ data, samples: Math.round((chunk.duration ?? 20000) * 48000 / 1e6) })
    },
    error: e => { failure = e },
  })
  encoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: channels, bitrate: 160_000 })
  const STEP = 48000  // a second at a time
  for (let at = 0; at < pcm.length; at += STEP) {
    const n = Math.min(STEP, pcm.length - at)
    const planar = new Float32Array(n * channels)
    for (let c = 0; c < channels; c++) planar.set(pcm.getChannelData(c).subarray(at, at + n), c * n)
    encoder.encode(new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: n, numberOfChannels: channels, timestamp: Math.round(at * 1e6 / 48000), data: planar }))
  }
  await encoder.flush()
  encoder.close()
  if (failure) throw failure

  const PRE_SKIP = 312  // libopus's usual encoder delay at 48 kHz
  const head = new Uint8Array(19)
  const hv = new DataView(head.buffer)
  head.set([...'OpusHead'].map(c => c.charCodeAt(0)), 0)
  head[8] = 1; head[9] = channels; hv.setUint16(10, PRE_SKIP, true); hv.setUint32(12, audio.sampleRate, true); hv.setInt16(16, 0, true); head[18] = 0
  const vendor = 'FFXI Explorer'
  const tags = new Uint8Array(8 + 4 + vendor.length + 4)
  const tv = new DataView(tags.buffer)
  tags.set([...'OpusTags'].map(c => c.charCodeAt(0)), 0)
  tv.setUint32(8, vendor.length, true); tags.set([...vendor].map(c => c.charCodeAt(0)), 12); tv.setUint32(12 + vendor.length, 0, true)

  const serial = (Math.random() * 2 ** 32) >>> 0
  const pages: Uint8Array[] = [oggPage(head, 0, serial, 0, 0x02), oggPage(tags, 0, serial, 1, 0)]
  // The last page's granule is the true end, so players trim the final packet's padding.
  let granule = 0
  const end = PRE_SKIP + pcm.length
  packets.forEach((p, i) => {
    granule += p.samples
    const last = i === packets.length - 1
    pages.push(oggPage(p.data, last ? Math.min(granule, end) : granule, serial, i + 2, last ? 0x04 : 0))
  })
  const out = new Uint8Array(pages.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of pages) { out.set(p, o); o += p.length }
  return out.buffer
}

export async function encodeAudio(audio: DecodedAudio, format: ExportFormat): Promise<ArrayBuffer> {
  if (format === 'wav') return encodeWav(audio)
  if (format === 'flac') return encodeFlac(audio)
  return encodeOggOpus(audio)
}
