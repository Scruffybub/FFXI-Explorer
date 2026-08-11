/**
 * Decodes an FFXI BGW music file to a WAV.
 *
 *   node scripts/bgw-decode.cjs <in.bgw> <out.wav>
 *   node scripts/bgw-decode.cjs --survey        # codec census over the install
 *
 * Header layout and the PS-ADPCM maths follow vgmstream's `meta/bgw.c` and
 * `coding/psx_decoder.c` (decode_psx_configurable). Fields:
 *
 *   0x00  "BGMStream"
 *   0x0C  codec        0 = PS-ADPCM, 3 = ATRAC3 (XOR-encrypted)
 *   0x10  file size    matches the file on disk; a cheap integrity check
 *   0x14  track id     the number in the filename, so the file self-identifies
 *   0x18  block size   frames per channel
 *   0x1C  loop start   in frames; <= 0 means no loop
 *   0x20  sample rate  obfuscated: (u32@0x20 + u32@0x24) & 0x7FFFFFFF
 *   0x28  data offset  0x30 in every real file
 *   0x2E  channels
 *   0x2F  block align  samples per frame
 *
 * The frame size is `blockAlign / 2 + 1` bytes: one header byte carrying the
 * filter index and shift, then nibbles, two samples per byte, low nibble first.
 * Note this is NOT standard 16-byte PS-ADPCM — there is no flag byte, and the
 * frame size varies per file (4, 8, 16, 32, 64, 128 seen).
 *
 * Channels are interleaved one frame at a time.
 */
const fs = require('fs')
const path = require('path')

const COEF = [
  [0, 0], [60, 0], [115, -52], [98, -55], [122, -60],
]

function readHeader(buf) {
  if (buf.toString('latin1', 0, 9) !== 'BGMStream') return null
  return {
    codec: buf.readUInt32LE(0x0c),
    fileSize: buf.readUInt32LE(0x10),
    trackId: buf.readUInt32LE(0x14),
    blockSize: buf.readUInt32LE(0x18),
    loopStart: buf.readInt32LE(0x1c),
    sampleRate: ((buf.readUInt32LE(0x20) + buf.readUInt32LE(0x24)) >>> 0) & 0x7fffffff,
    dataOffset: buf.readUInt32LE(0x28),
    channels: buf.readInt8(0x2e),
    blockAlign: buf.readUInt8(0x2f),
  }
}

/** Returns Int16Array per channel. */
function decodePsAdpcm(buf, h) {
  const frameSize = (h.blockAlign >> 1) + 1
  const samplesPerFrame = (frameSize - 1) * 2
  const frames = h.blockSize
  const out = []
  for (let c = 0; c < h.channels; c++) out.push(new Int16Array(frames * samplesPerFrame))

  const hist1 = new Int32Array(h.channels)
  const hist2 = new Int32Array(h.channels)

  let off = h.dataOffset
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < h.channels; c++) {
      if (off + frameSize > buf.length) return out
      const head = buf[off]
      let coefIndex = (head >> 4) & 0xf
      let shift = head & 0xf
      // vgmstream clamps rather than failing; a handful of frames carry junk.
      if (coefIndex > 5) coefIndex = 0
      if (shift > 12) shift = 9
      // The shift is used directly. vgmstream's *standard* decode_psx does
      // `shift_factor = 20 - shift_factor` because it sign-extends the nibble
      // differently; decode_psx_configurable has no such line. Borrowing it
      // decodes cleanly but ~12x too quiet — peak 2603 of 32767 instead of
      // 31333 — which is what caught it.
      const shiftFactor = shift
      const c0 = COEF[coefIndex][0]
      const c1 = COEF[coefIndex][1]
      let h1 = hist1[c], h2 = hist2[c]
      const base = f * samplesPerFrame
      const chan = out[c]

      for (let i = 0; i < samplesPerFrame; i++) {
        const nibbles = buf[off + 1 + (i >> 1)]
        let s = (i & 1) ? (nibbles >> 4) & 0x0f : nibbles & 0x0f
        // 16-bit sign extend, then scale
        s = ((s << 12) & 0xf000)
        s = (s << 16) >> 16
        s = s >> shiftFactor
        s = s + ((c0 * h1 + c1 * h2) >> 6)
        if (s > 32767) s = 32767
        else if (s < -32768) s = -32768
        chan[base + i] = s
        h2 = h1
        h1 = s
      }
      hist1[c] = h1
      hist2[c] = h2
      off += frameSize
    }
  }
  return out
}

function writeWav(file, channels, sampleRate) {
  const n = channels[0].length
  const ch = channels.length
  const dataBytes = n * ch * 2
  const buf = Buffer.alloc(44 + dataBytes)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataBytes, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(ch, 22); buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * ch * 2, 28); buf.writeUInt16LE(ch * 2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36); buf.writeUInt32LE(dataBytes, 40)
  let o = 44
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) { buf.writeInt16LE(channels[c][i], o); o += 2 }
  }
  fs.writeFileSync(file, buf)
  return dataBytes
}

function stats(channels) {
  let sum = 0, peak = 0, n = 0, clipped = 0
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i]
      sum += v * v; n++
      const a = Math.abs(v)
      if (a > peak) peak = a
      if (a >= 32767) clipped++
    }
  }
  return { rms: Math.sqrt(sum / n), peak, clipped, samples: n }
}

if (process.argv[2] === '--survey') {
  const FF = process.argv[3] ||
    'C:/Program Files (x86)/PlayOnline/SquareEnix/FINAL FANTASY XI'
  const found = []
  const walk = p => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const q = path.join(p, e.name)
      if (e.isDirectory()) { try { walk(q) } catch { /* skip */ } }
      else if (/^music\d+\.bgw$/i.test(e.name)) found.push(q)
    }
  }
  for (const d of fs.readdirSync(FF)) {
    if (/^(sound\d*|mov)$/i.test(d)) { try { walk(path.join(FF, d)) } catch { /* skip */ } }
  }
  const tally = {}
  for (const f of found) {
    const fd = fs.openSync(f, 'r'); const b = Buffer.alloc(0x30)
    fs.readSync(fd, b, 0, 0x30, 0); fs.closeSync(fd)
    const h = readHeader(b)
    const key = h ? `codec ${h.codec}` : 'not a BGW'
    tally[key] = (tally[key] || 0) + 1
  }
  console.log(`${found.length} files:`, JSON.stringify(tally))
  process.exit(0)
}

const inFile = process.argv[2]
const outFile = process.argv[3]
if (!inFile) {
  console.error('usage: node scripts/bgw-decode.cjs <in.bgw> <out.wav>')
  process.exit(1)
}

const buf = fs.readFileSync(inFile)
const h = readHeader(buf)
if (!h) { console.error('not a BGW (bad magic)'); process.exit(1) }

console.log(`track ${h.trackId}  codec ${h.codec}  ${h.sampleRate} Hz  ` +
  `${h.channels}ch  blockAlign ${h.blockAlign}  frames ${h.blockSize}  ` +
  `loopStart ${h.loopStart}  dataOffset 0x${h.dataOffset.toString(16)}`)
if (h.fileSize !== buf.length) {
  console.log(`  ! header size ${h.fileSize} != actual ${buf.length}`)
}

if (h.codec === 3) {
  console.error('codec 3 is XOR-encrypted ATRAC3 — decryption is trivial but ' +
    'decoding ATRAC3 needs a real decoder. Not supported here.')
  process.exit(2)
}
if (h.codec !== 0) { console.error(`unknown codec ${h.codec}`); process.exit(1) }

const channels = decodePsAdpcm(buf, h)
const st = stats(channels)
const seconds = channels[0].length / h.sampleRate
console.log(`decoded ${st.samples} samples (${seconds.toFixed(1)}s)  ` +
  `rms ${st.rms.toFixed(1)}  peak ${st.peak}  clipped ${st.clipped} ` +
  `(${(100 * st.clipped / st.samples).toFixed(3)}%)`)

if (outFile) {
  const bytes = writeWav(outFile, channels, h.sampleRate)
  console.log(`wrote ${outFile} — ${(bytes / 1048576).toFixed(1)} MB`)
}
