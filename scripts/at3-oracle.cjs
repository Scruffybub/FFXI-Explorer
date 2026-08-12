/**
 * DEV TOOL. Produces a reference decode of a codec-3 (ATRAC3) BGW using an
 * external ffmpeg, so the TypeScript port in `src/renderer/src/lib/atrac3.ts`
 * has something to be checked against.
 *
 *   node scripts/at3-oracle.cjs <in.bgw> <out.wav> [ffmpegPath]
 *
 * ffmpeg is NOT shipped with the app and is not a dependency of it — this
 * exists only so the port can be validated sample-by-sample instead of by ear.
 *
 * Two steps:
 *
 * 1. Decrypt. The stream is XORed against a key built from its own first
 *    frame: take `frameSize * channels` bytes from the start of the data, then
 *    XOR the first four bytes of each channel's frame with 0xA0024E9F. Every
 *    byte is then `data[i] ^ key[i % keySize]`. From vgmstream's
 *    `meta/bgw_streamfile.h`, credited to Moogle Toolbox.
 *
 * 2. Wrap as a RIFF `.at3`, which ffmpeg reads natively. The fmt chunk carries
 *    tag 0x0270 and 14 bytes of extradata, per `atrac3_decode_init`:
 *      [0-1]   u16 always 1
 *      [2-5]   u32 samples per channel
 *      [6-7]   u16 coding mode: 0 = stereo, 1 = joint stereo
 *      [8-9]   u16 duplicate of coding mode
 *      [10-11] u16 frame factor, always 1
 *      [12-13] u16 always 0
 *    blockAlign must be 192 * channels, which is the 0xC0-per-channel frame
 *    FFXI uses.
 */
const fs = require('fs')
const { execFileSync } = require('child_process')

const FRAME_SIZE = 0xc0

function decryptAtrac3(buf, dataOffset, channels) {
  const keySize = FRAME_SIZE * channels
  const key = Buffer.from(buf.subarray(dataOffset, dataOffset + keySize))
  for (let ch = 0; ch < channels; ch++) {
    const at = FRAME_SIZE * ch
    const v = key.readUInt32BE(at) ^ 0xa0024e9f
    key.writeUInt32BE(v >>> 0, at)
  }
  const data = Buffer.from(buf.subarray(dataOffset))
  for (let i = 0; i < data.length; i++) data[i] ^= key[i % keySize]
  return data
}

function buildAt3(data, channels, sampleRate, codingMode) {
  const blockAlign = FRAME_SIZE * channels
  const extra = Buffer.alloc(14)
  extra.writeUInt16LE(1, 0)
  extra.writeUInt32LE(1024, 2)          // samples per channel
  extra.writeUInt16LE(codingMode, 6)
  extra.writeUInt16LE(codingMode, 8)
  extra.writeUInt16LE(1, 10)            // frame factor
  extra.writeUInt16LE(0, 12)

  const fmt = Buffer.alloc(18 + extra.length)
  fmt.writeUInt16LE(0x0270, 0)          // WAVE_FORMAT_SONY_SCX (ATRAC3)
  fmt.writeUInt16LE(channels, 2)
  fmt.writeUInt32LE(sampleRate, 4)
  fmt.writeUInt32LE(sampleRate * blockAlign / 1024, 8)
  fmt.writeUInt16LE(blockAlign, 12)
  fmt.writeUInt16LE(0, 14)
  fmt.writeUInt16LE(extra.length, 16)
  extra.copy(fmt, 18)

  const head = Buffer.alloc(12 + 8 + fmt.length + 8)
  let o = 0
  head.write('RIFF', o); o += 4
  head.writeUInt32LE(4 + 8 + fmt.length + 8 + data.length, o); o += 4
  head.write('WAVE', o); o += 4
  head.write('fmt ', o); o += 4
  head.writeUInt32LE(fmt.length, o); o += 4
  fmt.copy(head, o); o += fmt.length
  head.write('data', o); o += 4
  head.writeUInt32LE(data.length, o); o += 4
  return Buffer.concat([head, data])
}

const inFile = process.argv[2]
const outFile = process.argv[3]
const ffmpeg = process.argv[4] ||
  'C:/Users/ryans/AppData/Local/Temp/ffm/ffmpeg.exe'
if (!inFile || !outFile) {
  console.error('usage: node scripts/at3-oracle.cjs <in.bgw> <out.wav> [ffmpeg]')
  process.exit(1)
}

const buf = fs.readFileSync(inFile)
const codec = buf.readUInt32LE(0x0c)
const channels = buf.readInt8(0x2e)
const sampleRate = ((buf.readUInt32LE(0x20) + buf.readUInt32LE(0x24)) >>> 0) & 0x7fffffff
const dataOffset = buf.readUInt32LE(0x28)
if (codec !== 3) { console.error(`codec ${codec}, not 3`); process.exit(1) }
console.log(`codec 3  ${sampleRate} Hz  ${channels}ch  data at 0x${dataOffset.toString(16)}`)

const data = decryptAtrac3(buf, dataOffset, channels)
console.log(`decrypted ${data.length} bytes (${Math.floor(data.length / (FRAME_SIZE * channels))} frames)`)

// Which coding mode is right is not in the BGW header, so try both and keep
// whichever ffmpeg decodes with more energy and fewer errors.
let best = null
for (const mode of [0, 1]) {
  const at3 = buildAt3(data, channels, sampleRate, mode)
  const tmp = `${outFile}.mode${mode}.at3`
  const wav = `${outFile}.mode${mode}.wav`
  fs.writeFileSync(tmp, at3)
  try {
    execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', tmp, wav],
      { stdio: ['ignore', 'ignore', 'pipe'] })
    const w = fs.readFileSync(wav)
    let sum = 0, peak = 0, n = 0
    for (let i = 44; i + 1 < w.length; i += 2) {
      const v = w.readInt16LE(i); sum += v * v; n++
      const a = Math.abs(v); if (a > peak) peak = a
    }
    const rms = Math.sqrt(sum / Math.max(1, n))
    console.log(`  codingMode ${mode}: ${n} samples, rms ${rms.toFixed(1)}, peak ${peak}`)
    if (!best || rms > best.rms) best = { mode, rms, wav, peak, n }
  } catch (e) {
    console.log(`  codingMode ${mode}: ffmpeg failed — ${String(e.stderr || e).slice(0, 120)}`)
  }
  fs.unlinkSync(tmp)
}

if (!best) { console.error('no coding mode decoded'); process.exit(2) }
fs.copyFileSync(best.wav, outFile)
console.log(`chose codingMode ${best.mode} -> ${outFile}`)
