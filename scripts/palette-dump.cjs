/**
 * Walk a map DAT's block table and dump its palette, so the channel order can
 * be read off rather than guessed.
 *
 *   node scripts/palette-dump.cjs "<ffxi>/ROM/18/80.DAT"
 *
 * This is what settled the maps being pink: byte 0 is 0x80 in all 256 entries,
 * which is alpha, not blue. See HANDOFF.
 */
// Walk a map DAT's block table the way MinimapParser does, then dump the
// palette bytes so the channel order can be read off rather than guessed.
const fs = require('fs')

const file = process.argv[2]
const b = fs.readFileSync(file)
console.log(`${file}  ${b.length} bytes`)

const DATHEAD = 8
const PADDING = 8
let offset = 0
let found = null

while (offset < b.length - DATHEAD) {
  const packed = b.readUInt32LE(offset + 4)
  const type = packed & 0x7f
  const nextUnits = (packed >> 7) & 0x7ffff
  const blockSize = nextUnits * 16
  if (nextUnits === 0) break
  if (type === 0x20) {
    const dataOffset = offset + DATHEAD + PADDING
    if (b[dataOffset] === 0xb1) { found = dataOffset; break }
  }
  offset += blockSize
}

if (found === null) { console.log('no 0xB1 texture block found'); process.exit(1) }

const id = b.subarray(found + 1, found + 17).toString('latin1').replace(/\0+$/, '')
const w = b.readInt32LE(found + 0x15)
const h = b.readInt32LE(found + 0x19)
console.log(`block at ${found}: id="${id}" ${w}x${h}`)

const pal = found + 64
console.log('palette entries 0-11, raw bytes:')
for (let i = 0; i < 12; i++) {
  const o = pal + i * 4
  console.log('  ' + String(i).padStart(3) + ': ' +
    [b[o], b[o + 1], b[o + 2], b[o + 3]].map(v => v.toString(16).padStart(2, '0')).join(' '))
}

// Which byte position looks like alpha? The one that is constant-ish at 0x80
// for opaque entries, per FFXI's convention.
for (let pos = 0; pos < 4; pos++) {
  const counts = {}
  for (let i = 0; i < 256; i++) {
    const v = b[pal + i * 4 + pos]
    counts[v] = (counts[v] || 0) + 1
  }
  const top = Object.entries(counts).sort((a, c) => c[1] - a[1]).slice(0, 3)
    .map(([v, n]) => `0x${Number(v).toString(16)}×${n}`).join(' ')
  const distinct = Object.keys(counts).length
  console.log(`byte ${pos}: ${distinct} distinct values, most common ${top}`)
}

// The parchment is the most-used colour in the image; show its raw entry.
const pixels = pal + 1024
const use = new Array(256).fill(0)
for (let i = 0; i < w * h; i++) use[b[pixels + i]]++
const common = use.map((n, i) => [i, n]).sort((a, c) => c[1] - a[1]).slice(0, 4)
console.log('most-used palette indices (should be parchment):')
for (const [i, n] of common) {
  const o = pal + i * 4
  console.log(`  idx ${i} used ${(100 * n / (w * h)).toFixed(1)}% raw ` +
    [b[o], b[o + 1], b[o + 2], b[o + 3]].map(v => v.toString(16).padStart(2, '0')).join(' '))
}
