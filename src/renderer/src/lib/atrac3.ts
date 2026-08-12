/**
 * ATRAC3 decoder for FFXI's codec-3 BGW music, ported from FFmpeg's
 * libavcodec/atrac3.c and atrac.c.
 *
 * **Validated bit-exactly against ffmpeg**, not by ear: `scripts/atrac3.cjs` is
 * the same algorithm and `scripts/at3-oracle.cjs` decodes the same file with a
 * real ffmpeg for comparison. Over music178, music051 and music147 the two agree
 * at 106-107 dB SNR with a maximum difference of 1 LSB. ffmpeg is a development
 * tool only and is not shipped or depended on.
 *
 * FFXI's files are 44100 Hz stereo, coding mode 0 (SINGLE, *not* joint stereo —
 * ffmpeg rejects mode 1 on them outright), so each channel is an independent
 * 192-byte sound unit and there is no matrixing or channel weighting.
 */

const SAMPLES_PER_FRAME = 1024
const FRAME_BYTES = 0xc0
const N = 256
const MDCT_SIZE = 512

/**
 * Negative on purpose. FFmpeg passes 1/32768 to av_tx_init, but its
 * AV_TX_FLOAT_MDCT inverse carries the opposite sign from the textbook IMDCT
 * this port derives against, so the output comes out inverted. Measured against
 * an ffmpeg reference: as-is scores -6.0 dB SNR, negated scores 107.3 dB.
 */
const MDCT_SCALE = -1 / 32768

const HUFF: number[][][] = [
  [[31,1],[32,3],[33,3],[34,4],[35,4],[36,5],[37,5],[38,5],[39,5]],
  [[31,1],[32,3],[30,3],[33,3],[29,3]],
  [[31,1],[32,3],[30,3],[33,4],[29,4],[34,4],[28,4]],
  [[31,1],[32,3],[30,3],[33,4],[29,4],[34,5],[28,5],[35,5],[27,5]],
  [[31,2],[32,3],[30,3],[33,4],[29,4],[34,4],[28,4],[38,4],[24,4],[35,5],
   [27,5],[36,6],[26,6],[37,6],[25,6]],
  [[31,3],[32,4],[30,4],[33,4],[29,4],[34,4],[28,4],[46,4],[16,4],[35,5],
   [27,5],[36,5],[26,5],[37,5],[25,5],[38,6],[24,6],[39,6],[23,6],[40,6],
   [22,6],[41,6],[21,6],[42,7],[20,7],[43,7],[19,7],[44,7],[18,7],[45,7],[17,7]],
  [[31,3],[62,4],[0,4],[32,5],[30,5],[33,5],[29,5],[34,5],[28,5],[35,5],
   [27,5],[36,5],[26,5],[37,6],[25,6],[38,6],[24,6],[39,6],[23,6],[40,6],
   [22,6],[41,6],[21,6],[42,6],[20,6],[43,6],[19,6],[44,6],[18,6],[45,7],
   [17,7],[46,7],[16,7],[47,7],[15,7],[48,7],[14,7],[49,7],[13,7],[50,7],
   [12,7],[51,7],[11,7],[52,8],[10,8],[53,8],[9,8],[54,8],[8,8],[55,8],
   [7,8],[56,8],[6,8],[57,8],[5,8],[58,8],[4,8],[59,8],[3,8],[60,8],
   [2,8],[61,8],[1,8]],
]
/** FFmpeg passes -31 as the symbol offset to ff_vlc_init_from_lengths. */
const VLC_OFFSET = -31

const CLC_LENGTH_TAB = [0, 4, 3, 3, 4, 4, 5, 6]
const MANTISSA_CLC_TAB = [0, 1, -2, -1]
const MANTISSA_VLC_TAB = [0,0, 0,1, 0,-1, 1,0, -1,0, 1,1, 1,-1, -1,1, -1,-1]
const INV_MAX_QUANT = [0, 1/1.5, 1/2.5, 1/3.5, 1/4.5, 1/7.5, 1/15.5, 1/31.5]
const SUBBAND_TAB = [
  0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176,
  192, 224, 256, 288, 320, 352, 384, 416, 448, 480, 512, 576, 640, 704,
  768, 896, 1024,
]
const QMF_48TAP_HALF = [
  -0.00001461907, -0.00009205479, -0.000056157569, 0.00030117269,
  0.0002422519, -0.00085293897, -0.0005205574, 0.0020340169,
  0.00078333891, -0.0042153862, -0.00075614988, 0.0078402944,
  -0.000061169922, -0.01344162, 0.0024626821, 0.021736089,
  -0.007801671, -0.034090221, 0.01880949, 0.054326009,
  -0.043596379, -0.099384367, 0.13207909, 0.46424159,
]

const SF_TABLE = new Float32Array(64)
for (let i = 0; i < 64; i++) SF_TABLE[i] = Math.pow(2, (i - 15) / 3)

const QMF_WINDOW = new Float32Array(48)
for (let i = 0; i < 24; i++) {
  const s = QMF_48TAP_HALF[i] * 2
  QMF_WINDOW[i] = s
  QMF_WINDOW[47 - i] = s
}

const MDCT_WINDOW = new Float32Array(MDCT_SIZE)
for (let i = 0, j = 255; i < 128; i++, j--) {
  const wi = Math.sin(((i + 0.5) / 256 - 0.5) * Math.PI) + 1
  const wj = Math.sin(((j + 0.5) / 256 - 0.5) * Math.PI) + 1
  const w = 0.5 * (wi * wi + wj * wj)
  MDCT_WINDOW[i] = MDCT_WINDOW[511 - i] = wi / w
  MDCT_WINDOW[j] = MDCT_WINDOW[511 - j] = wj / w
}

/** ff_atrac_init_gain_compensation(ctx, 4, 3). */
const ID2EXP_OFFSET = 4
const LOC_SCALE = 3
const LOC_SIZE = 1 << LOC_SCALE
const GAIN_TAB1 = new Float32Array(16)
for (let i = 0; i < 16; i++) GAIN_TAB1[i] = Math.pow(2, ID2EXP_OFFSET - i)
const GAIN_TAB2 = new Float32Array(31)
for (let i = -15; i < 16; i++) GAIN_TAB2[i + 15] = Math.pow(2, (-1 / LOC_SIZE) * i)

/** Canonical Huffman: shift by the length increase, assign, increment. */
function buildVlc(pairs: number[][]): Map<number, Map<number, number>> {
  const byLen = new Map<number, Map<number, number>>()
  let code = 0
  let prevLen = 0
  for (const [sym, len] of pairs) {
    code <<= (len - prevLen)
    prevLen = len
    let m = byLen.get(len)
    if (!m) { m = new Map(); byLen.set(len, m) }
    m.set(code, sym + VLC_OFFSET)
    code++
  }
  return byLen
}
const VLC = HUFF.map(buildVlc)

class BitReader {
  private buf: Uint8Array
  private start: number
  private end: number
  private pos = 0
  constructor(buf: Uint8Array, start: number, len: number) {
    this.buf = buf; this.start = start; this.end = start + len
  }
  bit(): number {
    const byte = this.start + (this.pos >> 3)
    if (byte >= this.end) { this.pos++; return 0 }
    const b = (this.buf[byte] >> (7 - (this.pos & 7))) & 1
    this.pos++
    return b
  }
  bits(n: number): number {
    let v = 0
    for (let i = 0; i < n; i++) v = (v << 1) | this.bit()
    return v
  }
  sbits(n: number): number {
    const v = this.bits(n)
    const sign = 1 << (n - 1)
    return (v & sign) ? v - (1 << n) : v
  }
  vlc(table: Map<number, Map<number, number>>): number {
    let code = 0
    for (let len = 1; len <= 24; len++) {
      code = (code << 1) | this.bit()
      const m = table.get(len)
      if (m) { const s = m.get(code); if (s !== undefined) return s }
    }
    return 0
  }
}

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t
      t = im[i]; im[i] = im[j]; im[j] = t
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len
    const wr = Math.cos(ang), wi = Math.sin(ang)
    const half = len >> 1
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0
      for (let k = 0; k < half; k++) {
        const ur = re[i + k], ui = im[i + k]
        const vr = re[i + k + half] * cr - im[i + k + half] * ci
        const vi = re[i + k + half] * ci + im[i + k + half] * cr
        re[i + k] = ur + vr; im[i + k] = ui + vi
        re[i + k + half] = ur - vr; im[i + k + half] = ui - vi
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
}

/*
 * DCT-IV via one 2N-point FFT:
 *   u[m] = Re{ exp(-i.pi.(m+1/2)/(2N)) . sum_k X[k] exp(-i.pi.(m+1/2)k/N) }
 * Folding the half-bin shift into the input as Y[k] = X[k].exp(-i.pi.k/(2N))
 * makes the inner sum a plain 2N-point DFT of a zero-padded Y.
 */
const _fre = new Float64Array(2 * N)
const _fim = new Float64Array(2 * N)
const _inRe = new Float64Array(N)
const _inIm = new Float64Array(N)
const _outRe = new Float64Array(N)
const _outIm = new Float64Array(N)
for (let k = 0; k < N; k++) {
  const a = -Math.PI * k / (2 * N)
  _inRe[k] = Math.cos(a); _inIm[k] = Math.sin(a)
}
for (let m = 0; m < N; m++) {
  const b = -Math.PI * (m + 0.5) / (2 * N)
  _outRe[m] = Math.cos(b); _outIm[m] = Math.sin(b)
}
const _u = new Float64Array(N)

function imdct(X: Float64Array, out: Float64Array): void {
  for (let k = 0; k < N; k++) {
    _fre[k] = X[k] * _inRe[k]
    _fim[k] = X[k] * _inIm[k]
  }
  _fre.fill(0, N); _fim.fill(0, N)
  fft(_fre, _fim)
  for (let m = 0; m < N; m++) _u[m] = _fre[m] * _outRe[m] - _fim[m] * _outIm[m]

  // DCT-IV symmetries u[2N-1-m] = -u[m] and u[m+2N] = -u[m], with m = n + N/2.
  const half = N / 2
  for (let n = 0; n < half; n++) out[n] = _u[n + half] * MDCT_SCALE
  for (let n = half; n < N + half; n++) out[n] = -_u[3 * half - 1 - n] * MDCT_SCALE
  for (let n = N + half; n < 2 * N; n++) out[n] = -_u[n - 3 * half] * MDCT_SCALE
}

const _subbandVlcIndex = new Int32Array(32)
const _sfIndex = new Int32Array(32)
const _mantissas = new Int32Array(128)
const _bandFlags = new Int32Array(4)
const _tonalMantissa = new Int32Array(8)

function readQuantSpectralCoeffs(
  br: BitReader, selector: number, codingFlag: number,
  mantissas: Int32Array, numCodes: number,
): void {
  if (selector === 1) numCodes = Math.floor(numCodes / 2)
  if (codingFlag !== 0) {
    const numBits = CLC_LENGTH_TAB[selector]
    if (selector > 1) {
      for (let i = 0; i < numCodes; i++) mantissas[i] = numBits ? br.sbits(numBits) : 0
    } else {
      for (let i = 0; i < numCodes; i++) {
        const code = numBits ? br.bits(numBits) : 0
        mantissas[i * 2] = MANTISSA_CLC_TAB[code >> 2]
        mantissas[i * 2 + 1] = MANTISSA_CLC_TAB[code & 3]
      }
    }
  } else {
    const tab = VLC[selector - 1]
    if (selector !== 1) {
      for (let i = 0; i < numCodes; i++) mantissas[i] = br.vlc(tab)
    } else {
      for (let i = 0; i < numCodes; i++) {
        const s = br.vlc(tab)
        mantissas[i * 2] = MANTISSA_VLC_TAB[s * 2]
        mantissas[i * 2 + 1] = MANTISSA_VLC_TAB[s * 2 + 1]
      }
    }
  }
}

function decodeSpectrum(br: BitReader, output: Float64Array): number {
  const numSubbands = br.bits(5)
  const codingMode = br.bit()
  for (let i = 0; i <= numSubbands; i++) _subbandVlcIndex[i] = br.bits(3)
  for (let i = 0; i <= numSubbands; i++) {
    if (_subbandVlcIndex[i] !== 0) _sfIndex[i] = br.bits(6)
  }
  let i = 0
  for (i = 0; i <= numSubbands; i++) {
    let first = SUBBAND_TAB[i]
    const last = SUBBAND_TAB[i + 1]
    if (_subbandVlcIndex[i] !== 0) {
      readQuantSpectralCoeffs(br, _subbandVlcIndex[i], codingMode, _mantissas, last - first)
      const scale = SF_TABLE[_sfIndex[i]] * INV_MAX_QUANT[_subbandVlcIndex[i]]
      for (let j = 0; first < last; first++, j++) output[first] = _mantissas[j] * scale
    } else {
      output.fill(0, first, last)
    }
  }
  output.fill(0, SUBBAND_TAB[i], SAMPLES_PER_FRAME)
  return numSubbands
}

interface TonalComponent { pos: number; numCoefs: number; coef: Float32Array }
interface GainBand { numPoints: number; levCode: Int32Array; locCode: Int32Array }

function decodeTonalComponents(
  br: BitReader, components: TonalComponent[], numBands: number,
): number {
  const nbComponents = br.bits(5)
  if (nbComponents === 0) return 0
  const codingModeSelector = br.bits(2)
  if (codingModeSelector === 2) return -1
  let codingMode = codingModeSelector & 1
  let count = 0

  for (let i = 0; i < nbComponents; i++) {
    for (let b = 0; b <= numBands; b++) _bandFlags[b] = br.bit()
    const codedValuesPerComponent = br.bits(3)
    const quantStepIndex = br.bits(3)
    if (quantStepIndex <= 1) return -1
    if (codingModeSelector === 3) codingMode = br.bit()

    for (let b = 0; b < (numBands + 1) * 4; b++) {
      if (_bandFlags[b >> 2] === 0) continue
      const codedComponents = br.bits(3)
      for (let c = 0; c < codedComponents; c++) {
        if (count >= 64) return -1
        const cmp = components[count]
        const sfIndex = br.bits(6)
        cmp.pos = b * 64 + br.bits(6)
        const codedValues = Math.min(SAMPLES_PER_FRAME - cmp.pos, codedValuesPerComponent + 1)
        const scale = SF_TABLE[sfIndex] * INV_MAX_QUANT[quantStepIndex]
        readQuantSpectralCoeffs(br, quantStepIndex, codingMode, _tonalMantissa, codedValues)
        cmp.numCoefs = codedValues
        for (let m = 0; m < codedValues; m++) cmp.coef[m] = _tonalMantissa[m] * scale
        count++
      }
    }
  }
  return count
}

function decodeGainControl(br: BitReader, block: GainBand[], numBands: number): number {
  let b = 0
  for (b = 0; b <= numBands; b++) {
    const g = block[b]
    g.numPoints = br.bits(3)
    for (let j = 0; j < g.numPoints; j++) {
      g.levCode[j] = br.bits(4)
      g.locCode[j] = br.bits(5)
      if (j && g.locCode[j] <= g.locCode[j - 1]) return -1
    }
  }
  for (; b < 4; b++) block[b].numPoints = 0
  return 0
}

function addTonalComponents(
  spectrum: Float64Array, numComponents: number, components: TonalComponent[],
): number {
  let lastPos = -1
  for (let i = 0; i < numComponents; i++) {
    const c = components[i]
    lastPos = Math.max(c.pos + c.numCoefs, lastPos)
    for (let j = 0; j < c.numCoefs; j++) spectrum[c.pos + j] += c.coef[j]
  }
  return lastPos
}

function gainCompensation(
  inBuf: Float64Array, prev: Float32Array, gcNow: GainBand, gcNext: GainBand,
  numSamples: number, out: Float32Array, outOff: number,
): void {
  const gcScale = gcNext.numPoints ? GAIN_TAB1[gcNext.levCode[0]] : 1
  let pos = 0
  if (!gcNow.numPoints) {
    for (; pos < numSamples; pos++) out[outOff + pos] = inBuf[pos] * gcScale + prev[pos]
  } else {
    for (let i = 0; i < gcNow.numPoints; i++) {
      const lastpos = gcNow.locCode[i] << LOC_SCALE
      let lev = GAIN_TAB1[gcNow.levCode[i]]
      const next = (i + 1 < gcNow.numPoints) ? gcNow.levCode[i + 1] : ID2EXP_OFFSET
      const gainInc = GAIN_TAB2[next - gcNow.levCode[i] + 15]
      for (; pos < lastpos; pos++) out[outOff + pos] = (inBuf[pos] * gcScale + prev[pos]) * lev
      for (; pos < lastpos + LOC_SIZE; pos++) {
        out[outOff + pos] = (inBuf[pos] * gcScale + prev[pos]) * lev
        lev *= gainInc
      }
    }
    for (; pos < numSamples; pos++) out[outOff + pos] = inBuf[pos] * gcScale + prev[pos]
  }
  for (let i = 0; i < numSamples; i++) prev[i] = inBuf[numSamples + i]
}

const _qmfTemp = new Float32Array(2 * 512 + 46)

function iqmf(
  buf: Float32Array, loOff: number, hiOff: number, nIn: number,
  outBuf: Float32Array, outOff: number, delay: Float32Array,
): void {
  _qmfTemp.set(delay.subarray(0, 46), 0)
  const p3 = 46
  for (let i = 0; i < nIn; i += 2) {
    _qmfTemp[p3 + 2 * i + 0] = buf[loOff + i] + buf[hiOff + i]
    _qmfTemp[p3 + 2 * i + 1] = buf[loOff + i] - buf[hiOff + i]
    _qmfTemp[p3 + 2 * i + 2] = buf[loOff + i + 1] + buf[hiOff + i + 1]
    _qmfTemp[p3 + 2 * i + 3] = buf[loOff + i + 1] - buf[hiOff + i + 1]
  }
  let p1 = 0
  let o = outOff
  for (let j = nIn; j !== 0; j--) {
    let s1 = 0, s2 = 0
    for (let i = 0; i < 48; i += 2) {
      s1 += _qmfTemp[p1 + i] * QMF_WINDOW[i]
      s2 += _qmfTemp[p1 + i + 1] * QMF_WINDOW[i + 1]
    }
    outBuf[o] = s2
    outBuf[o + 1] = s1
    p1 += 2
    o += 2
  }
  for (let i = 0; i < 46; i++) delay[i] = _qmfTemp[nIn * 2 + i]
}

interface ChannelState {
  gainBlock: GainBand[][]
  gcBlkSwitch: number
  prevFrame: Float32Array
  imdctBuf: Float64Array
  spectrum: Float64Array
  components: TonalComponent[]
  delay1: Float32Array
  delay2: Float32Array
  delay3: Float32Array
}

function newChannelState(): ChannelState {
  const mkGain = (): GainBand[] => Array.from({ length: 4 }, () => ({
    numPoints: 0, levCode: new Int32Array(8), locCode: new Int32Array(8),
  }))
  return {
    gainBlock: [mkGain(), mkGain()],
    gcBlkSwitch: 0,
    prevFrame: new Float32Array(SAMPLES_PER_FRAME),
    imdctBuf: new Float64Array(MDCT_SIZE),
    spectrum: new Float64Array(SAMPLES_PER_FRAME),
    components: Array.from({ length: 64 }, () => ({
      pos: 0, numCoefs: 0, coef: new Float32Array(8),
    })),
    delay1: new Float32Array(46),
    delay2: new Float32Array(46),
    delay3: new Float32Array(46),
  }
}

const _bandIn = new Float64Array(N)

function decodeChannelSoundUnit(
  br: BitReader, snd: ChannelState, out: Float32Array,
): number {
  const gain1 = snd.gainBlock[snd.gcBlkSwitch]
  const gain2 = snd.gainBlock[1 - snd.gcBlkSwitch]

  if (br.bits(6) !== 0x28) return -1
  const bandsCoded = br.bits(2)
  if (decodeGainControl(br, gain2, bandsCoded) < 0) return -1
  const numComponents = decodeTonalComponents(br, snd.components, bandsCoded)
  if (numComponents < 0) return -1
  const numSubbands = decodeSpectrum(br, snd.spectrum)
  const lastTonal = addTonalComponents(snd.spectrum, numComponents, snd.components)

  let numBands = (SUBBAND_TAB[numSubbands + 1] - 1) >> 8
  if (lastTonal >= 0) numBands = Math.max((lastTonal + 256) >> 8, numBands)

  for (let band = 0; band < 4; band++) {
    if (band <= numBands) {
      for (let i = 0; i < N; i++) _bandIn[i] = snd.spectrum[band * 256 + i]
      // Odd bands are stored spectrally reversed, an artefact of the QMF.
      if (band & 1) {
        for (let i = 0; i < 128; i++) {
          const t = _bandIn[i]; _bandIn[i] = _bandIn[255 - i]; _bandIn[255 - i] = t
        }
      }
      imdct(_bandIn, snd.imdctBuf)
      for (let i = 0; i < MDCT_SIZE; i++) snd.imdctBuf[i] *= MDCT_WINDOW[i]
    } else {
      snd.imdctBuf.fill(0)
    }
    gainCompensation(
      snd.imdctBuf, snd.prevFrame.subarray(band * 256, band * 256 + 256),
      gain1[band], gain2[band], 256, out, band * 256,
    )
  }
  snd.gcBlkSwitch ^= 1
  return 0
}

/**
 * Decrypts the stream in place. The key is the file's own first frame with the
 * first four bytes of each channel XORed by 0xA0024E9F; every byte is then
 * XORed against it cyclically. From vgmstream's meta/bgw_streamfile.h,
 * credited to Moogle Toolbox.
 */
function decrypt(data: Uint8Array, channels: number): void {
  const keySize = FRAME_BYTES * channels
  const key = data.slice(0, keySize)
  const kv = new DataView(key.buffer, key.byteOffset, key.byteLength)
  for (let ch = 0; ch < channels; ch++) {
    const at = FRAME_BYTES * ch
    kv.setUint32(at, (kv.getUint32(at, false) ^ 0xa0024e9f) >>> 0, false)
  }
  for (let i = 0; i < data.length; i++) data[i] ^= key[i % keySize]
}

export interface DecodedAtrac3 {
  channels: Float32Array[]
  sampleRate: number
}

/**
 * Decodes a whole codec-3 BGW. Returns one Float32Array per channel in -1..1.
 * About 2.7s for a four-minute track, so call it off the critical path.
 */
export function decodeAtrac3Bgw(buf: Uint8Array): DecodedAtrac3 | null {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (dv.getUint32(0x0c, true) !== 3) return null
  const channels = dv.getInt8(0x2e)
  if (channels < 1 || channels > 2) return null
  const sampleRate = ((dv.getUint32(0x20, true) + dv.getUint32(0x24, true)) >>> 0) & 0x7fffffff
  const dataOffset = dv.getUint32(0x28, true)

  const data = buf.slice(dataOffset)
  decrypt(data, channels)

  const blockAlign = FRAME_BYTES * channels
  const frames = Math.floor(data.length / blockAlign)
  const states = Array.from({ length: channels }, newChannelState)
  const out = Array.from({ length: channels },
    () => new Float32Array(frames * SAMPLES_PER_FRAME))
  const work = new Float32Array(SAMPLES_PER_FRAME)

  for (let f = 0; f < frames; f++) {
    for (let ch = 0; ch < channels; ch++) {
      const br = new BitReader(data, f * blockAlign + ch * FRAME_BYTES, FRAME_BYTES)
      if (decodeChannelSoundUnit(br, states[ch], work) < 0) work.fill(0)
      const s = states[ch]
      iqmf(work, 0, 256, 256, work, 0, s.delay1)
      iqmf(work, 768, 512, 256, work, 512, s.delay2)
      iqmf(work, 0, 512, 512, out[ch].subarray(f * SAMPLES_PER_FRAME), 0, s.delay3)
    }
  }
  return { channels: out, sampleRate }
}
