/**
 * FFXI BGW music decoding.
 *
 * Layout and maths follow vgmstream's `meta/bgw.c` and
 * `coding/psx_decoder.c` (`decode_psx_configurable`). Proven against the real
 * files by `scripts/bgw-decode.cjs`, which is the same algorithm and can write
 * a WAV for listening.
 *
 * Only codec 0 (PS-ADPCM) is decoded here. Codec 3 is ATRAC3 — its *encryption*
 * is a trivial XOR against a key built from the file's own first frame, but
 * ATRAC3 itself is a Sony MDCT codec with no browser support and no small
 * implementation. 79 of 222 files are codec 3, including 31 of the 74 ambient
 * zone tracks; those zones stay silent until that is solved.
 */

/** PS-ADPCM predictor coefficients, ×64. */
const COEF: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [60, 0], [115, -52], [98, -55], [122, -60],
]

export interface BgwHeader {
  codec: number
  fileSize: number
  trackId: number
  /** Frames per channel. */
  blockSize: number
  /** In frames; <= 0 means the track does not loop. */
  loopStart: number
  sampleRate: number
  dataOffset: number
  channels: number
  /** Samples per frame. */
  blockAlign: number
}

export function readBgwHeader(buf: Uint8Array): BgwHeader | null {
  if (buf.length < 0x30) return null
  for (let i = 0; i < 9; i++) {
    if (buf[i] !== 'BGMStream'.charCodeAt(i)) return null
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  return {
    codec: dv.getUint32(0x0c, true),
    fileSize: dv.getUint32(0x10, true),
    trackId: dv.getUint32(0x14, true),
    blockSize: dv.getUint32(0x18, true),
    loopStart: dv.getInt32(0x1c, true),
    // The sample rate is genuinely obfuscated as the sum of two words.
    sampleRate: ((dv.getUint32(0x20, true) + dv.getUint32(0x24, true)) >>> 0) & 0x7fffffff,
    dataOffset: dv.getUint32(0x28, true),
    channels: dv.getInt8(0x2e),
    blockAlign: dv.getUint8(0x2f),
  }
}

export interface DecodedAudio {
  /** One Float32Array per channel, in -1..1. */
  channels: Float32Array[]
  sampleRate: number
  /** Sample index to loop back to, or null if the track does not loop. */
  loopStartSample: number | null
}

/**
 * Decodes codec 0. Returns null for anything else.
 *
 * Frames are `blockAlign / 2 + 1` bytes: **one** header byte holding the filter
 * index in the high nibble and the shift in the low, then nibbles at two
 * samples per byte, low nibble first. This is not standard 16-byte PS-ADPCM —
 * there is no flag byte, and the frame size varies per file. Channels are
 * interleaved one frame at a time.
 */
export function decodeBgw(buf: Uint8Array): DecodedAudio | null {
  const h = readBgwHeader(buf)
  if (!h || h.codec !== 0) return null
  if (h.channels < 1 || h.channels > 2) return null
  if (h.blockAlign < 2) return null

  const frameSize = (h.blockAlign >> 1) + 1
  const samplesPerFrame = (frameSize - 1) * 2
  const frames = h.blockSize
  const total = frames * samplesPerFrame

  const channels: Float32Array[] = []
  for (let c = 0; c < h.channels; c++) channels.push(new Float32Array(total))

  const hist1 = new Int32Array(h.channels)
  const hist2 = new Int32Array(h.channels)

  let off = h.dataOffset
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < h.channels; c++) {
      if (off + frameSize > buf.length) return finish(channels, h, total)
      const head = buf[off]
      let coefIndex = (head >> 4) & 0xf
      let shift = head & 0xf
      // A handful of frames carry junk here; vgmstream clamps rather than fails.
      if (coefIndex > 5) coefIndex = 0
      if (shift > 12) shift = 9
      // The shift is used directly. vgmstream's *standard* decode_psx does
      // `shift_factor = 20 - shift_factor` because it sign-extends the nibble
      // differently; decode_psx_configurable has no such line. Borrowing it
      // decodes cleanly at about a twelfth of the right amplitude, which is a
      // bug that does not announce itself — peak 2603 instead of 31260.
      const c0 = COEF[coefIndex][0]
      const c1 = COEF[coefIndex][1]
      let h1 = hist1[c]
      let h2 = hist2[c]
      const base = f * samplesPerFrame
      const chan = channels[c]

      for (let i = 0; i < samplesPerFrame; i++) {
        const nibbles = buf[off + 1 + (i >> 1)]
        let s = (i & 1) ? (nibbles >> 4) & 0x0f : nibbles & 0x0f
        s = (s << 12) & 0xf000
        s = (s << 16) >> 16          // sign-extend to 16 bits
        s = s >> shift               // scale
        s = s + ((c0 * h1 + c1 * h2) >> 6)
        if (s > 32767) s = 32767
        else if (s < -32768) s = -32768
        chan[base + i] = s / 32768
        h2 = h1
        h1 = s
      }
      hist1[c] = h1
      hist2[c] = h2
      off += frameSize
    }
  }
  return finish(channels, h, total)
}

function finish(channels: Float32Array[], h: BgwHeader, total: number): DecodedAudio {
  // vgmstream: loop_start_sample = (loop_start - 1) * block_align.
  const loop = h.loopStart > 0
    ? Math.min((h.loopStart - 1) * h.blockAlign, Math.max(0, total - 1))
    : null
  return { channels, sampleRate: h.sampleRate, loopStartSample: loop }
}
