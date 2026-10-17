/**
 * A TrueType font built from a bitmap glyph sheet, so the game's own menu font
 * can be used like any other web font: every label in the app picks it up from
 * CSS, and characters the sheet lacks fall back to the next font in the stack.
 *
 * Each glyph pixel above the alpha threshold becomes a square; runs of pixels
 * in a row are merged, and identical runs in consecutive rows are merged into
 * one taller rectangle, so the outline has few seams. One pixel is 64 units on
 * a 1024-unit em, so at 16px (the sheet's own cell) a pixel is a screen pixel.
 *
 * Only the tables Chromium's font sanitiser requires are written: head, hhea,
 * maxp, OS/2, hmtx, cmap (format 4), loca, glyf, name and post.
 */

export interface GlyphSheet {
  rgba: Uint8Array
  width: number
  /** Cell size in pixels and cells per row. */
  cell: number
  columns: number
  /** Character code -> cell index. */
  cells: Map<number, number>
  /** Pixels at or above this alpha are ink. */
  threshold?: number
  /**
   * Also require this brightness (0-255). The game's menu font is opaque white
   * letters with a black outline baked in; only the white is the letter.
   */
  minLuma?: number
  /** Advance for a cell with no ink (the space). */
  blankAdvance?: number
}

const UNIT = 64

interface Glyph {
  code: number
  advance: number
  rects: [number, number, number, number][] // x0, y0, x1, y1 in font units, y up
}

/** Ink columns, rows and the rectangles of one cell, measured from the sheet. */
function readGlyph(sheet: GlyphSheet, code: number, index: number, baseline: number): Glyph {
  const { width, cell, columns } = sheet
  const cx = (index % columns) * cell, cy = Math.floor(index / columns) * cell
  const ink = (x: number, y: number) => isInk(sheet, ((cy + y) * width + cx + x) * 4)
  let lo = cell, hi = -1
  for (let x = 0; x < cell; x++) for (let y = 0; y < cell; y++) if (ink(x, y)) { lo = Math.min(lo, x); hi = Math.max(hi, x) }
  if (hi < 0) return { code, advance: (sheet.blankAdvance ?? 4) * UNIT, rects: [] }

  // Runs per row, then merged down while the next row has the same run.
  const open = new Map<string, [number, number, number]>() // "x0,x1" -> [x0, x1, topRow]
  const rects: Glyph['rects'] = []
  const close = (x0: number, x1: number, top: number, bottom: number) =>
    rects.push([(x0 - lo) * UNIT, (baseline - bottom) * UNIT, (x1 - lo) * UNIT, (baseline - top) * UNIT])
  for (let y = 0; y <= cell; y++) {
    const runs = new Set<string>()
    if (y < cell) {
      for (let x = 0; x < cell; ) {
        if (!ink(x, y)) { x++; continue }
        let e = x
        while (e < cell && ink(e, y)) e++
        runs.add(`${x},${e}`)
        x = e
      }
    }
    for (const [k, [x0, x1, top]] of open) if (!runs.has(k)) { close(x0, x1, top, y); open.delete(k) }
    for (const k of runs) if (!open.has(k)) { const [x0, x1] = k.split(',').map(Number); open.set(k, [x0, x1, y]) }
  }
  return { code, advance: (hi - lo + 2) * UNIT, rects }
}

function isInk(sheet: GlyphSheet, o: number): boolean {
  const p = sheet.rgba
  if (p[o + 3] < (sheet.threshold ?? 96)) return false
  return !sheet.minLuma || (p[o] + p[o + 1] + p[o + 2]) / 3 >= sheet.minLuma
}

class Writer {
  private bytes: number[] = []
  u8(v: number) { this.bytes.push(v & 0xff); return this }
  u16(v: number) { return this.u8(v >> 8).u8(v) }
  i16(v: number) { return this.u16(v < 0 ? v + 0x10000 : v) }
  u32(v: number) { return this.u16(Math.floor(v / 0x10000) & 0xffff).u16(v & 0xffff) }
  tag(s: string) { for (const c of s) this.u8(c.charCodeAt(0)); return this }
  pad4() { while (this.bytes.length % 4) this.u8(0); return this }
  get length() { return this.bytes.length }
  out() { return Uint8Array.from(this.bytes) }
}

function checksum(b: Uint8Array): number {
  let sum = 0
  for (let i = 0; i < b.length; i += 4) {
    sum = (sum + ((b[i] << 24) | ((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0))) >>> 0
  }
  return sum
}

export function buildBitmapFont(sheet: GlyphSheet, family: string): ArrayBuffer {
  // The baseline sits under the capitals: the lowest ink row of "H", plus one.
  const hIndex = sheet.cells.get(0x48)
  let baseline = sheet.cell - 3
  if (hIndex !== undefined) {
    const { width, cell, columns } = sheet
    const cx = (hIndex % columns) * cell, cy = Math.floor(hIndex / columns) * cell
    for (let y = cell - 1; y >= 0; y--) {
      let any = false
      for (let x = 0; x < cell; x++) if (isInk(sheet, ((cy + y) * width + cx + x) * 4)) any = true
      if (any) { baseline = y + 1; break }
    }
  }
  const ascent = baseline * UNIT, descent = (sheet.cell - baseline) * UNIT
  const glyphs: Glyph[] = [{ code: -1, advance: 8 * UNIT, rects: [] }] // .notdef
  for (const [code, index] of [...sheet.cells].sort((a, b) => a[0] - b[0])) glyphs.push(readGlyph(sheet, code, index, baseline))

  // glyf + loca
  const glyf = new Writer(), offsets: number[] = []
  let maxPoints = 0, maxContours = 0
  let xMin = 0, yMin = 0, xMax = 0, yMax = 0
  for (const g of glyphs) {
    offsets.push(glyf.length)
    if (!g.rects.length) continue
    const bx0 = Math.min(...g.rects.map(r => r[0])), by0 = Math.min(...g.rects.map(r => r[1]))
    const bx1 = Math.max(...g.rects.map(r => r[2])), by1 = Math.max(...g.rects.map(r => r[3]))
    xMin = Math.min(xMin, bx0); yMin = Math.min(yMin, by0); xMax = Math.max(xMax, bx1); yMax = Math.max(yMax, by1)
    glyf.i16(g.rects.length).i16(bx0).i16(by0).i16(bx1).i16(by1)
    g.rects.forEach((_, i) => glyf.u16(i * 4 + 3))
    glyf.u16(0) // no instructions
    const pts: [number, number][] = []
    // Clockwise in y-up space: top-left, top-right, bottom-right, bottom-left.
    for (const [x0, y0, x1, y1] of g.rects) pts.push([x0, y1], [x1, y1], [x1, y0], [x0, y0])
    for (let i = 0; i < pts.length; i++) glyf.u8(0x01) // on-curve, full-size deltas
    let px = 0
    for (const [x] of pts) { glyf.i16(x - px); px = x }
    let py = 0
    for (const [, y] of pts) { glyf.i16(y - py); py = y }
    glyf.pad4()
    maxPoints = Math.max(maxPoints, pts.length)
    maxContours = Math.max(maxContours, g.rects.length)
  }
  offsets.push(glyf.length)
  const loca = new Writer()
  for (const o of offsets) loca.u32(o)

  const n = glyphs.length
  const advMax = Math.max(...glyphs.map(g => g.advance))

  const head = new Writer()
    .u32(0x00010000).u32(0x00010000).u32(0) // version, revision, checkSumAdjustment (patched below)
    .u32(0x5f0f3cf5).u16(0x000b).u16(16 * UNIT)
    .u32(0).u32(0).u32(0).u32(0) // created, modified
    .i16(xMin).i16(yMin).i16(xMax).i16(yMax)
    .u16(0).u16(8).i16(2).i16(1).i16(0)

  const hhea = new Writer()
    .u32(0x00010000).i16(ascent).i16(-descent).i16(0).u16(advMax)
    .i16(0).i16(0).i16(xMax).i16(1).i16(0).i16(0)
    .i16(0).i16(0).i16(0).i16(0).i16(0).u16(n)

  const maxp = new Writer()
    .u32(0x00010000).u16(n).u16(maxPoints).u16(maxContours).u16(0).u16(0)
    .u16(2).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0)

  const codes = glyphs.slice(1).map(g => g.code)
  const os2 = new Writer()
    .u16(4).i16(Math.round(glyphs.reduce((s, g) => s + g.advance, 0) / n)).u16(400).u16(5).u16(0)
    .i16(650).i16(600).i16(0).i16(140).i16(650).i16(600).i16(0).i16(480).i16(50).i16(260)
    .i16(0).u8(0).u8(0).u8(0).u8(0).u8(0).u8(0).u8(0).u8(0).u8(0).u8(0) // family class, panose
    .u32(1).u32(0).u32(0).u32(0).tag('NONE').u16(0x40)
    .u16(Math.min(...codes)).u16(Math.min(0xffff, Math.max(...codes)))
    .i16(ascent).i16(-descent).i16(0).u16(ascent).u16(descent)
    .u32(1).u32(0).i16(Math.round(ascent * 0.6)).i16(ascent).u16(0).u16(32).u16(1)

  const hmtx = new Writer()
  for (const g of glyphs) hmtx.u16(g.advance).i16(g.rects.length ? Math.min(...g.rects.map(r => r[0])) : 0)

  // cmap: one format-4 segment per character, then the 0xFFFF terminator.
  const segs = codes.map((c, i) => ({ start: c, end: c, delta: (i + 1 - c) & 0xffff }))
  segs.push({ start: 0xffff, end: 0xffff, delta: 1 })
  const segX2 = segs.length * 2
  const entry = 2 ** Math.floor(Math.log2(segs.length))
  const sub = new Writer().u16(4).u16(16 + segs.length * 8).u16(0)
    .u16(segX2).u16(entry * 2).u16(Math.log2(entry)).u16(segX2 - entry * 2)
  segs.forEach(s => sub.u16(s.end)); sub.u16(0)
  segs.forEach(s => sub.u16(s.start))
  segs.forEach(s => sub.u16(s.delta))
  segs.forEach(() => sub.u16(0))
  const cmap = new Writer().u16(0).u16(1).u16(3).u16(1).u32(12)
  for (const b of sub.out()) cmap.u8(b)

  const names: [number, string][] = [[1, family], [2, 'Regular'], [4, family], [6, family.replace(/[^A-Za-z0-9]/g, '')]]
  const name = new Writer().u16(0).u16(names.length).u16(6 + names.length * 12)
  let strOff = 0
  for (const [id, s] of names) { name.u16(3).u16(1).u16(0x409).u16(id).u16(s.length * 2).u16(strOff); strOff += s.length * 2 }
  for (const [, s] of names) for (const c of s) name.u16(c.charCodeAt(0))

  const post = new Writer().u32(0x00030000).u32(0).i16(-UNIT * 2).i16(UNIT).u32(0).u32(0).u32(0).u32(0).u32(0)

  const tables: [string, Uint8Array][] = ([
    ['OS/2', os2], ['cmap', cmap], ['glyf', glyf], ['head', head], ['hhea', hhea],
    ['hmtx', hmtx], ['loca', loca], ['maxp', maxp], ['name', name], ['post', post],
  ] as [string, Writer][]).map(([t, w]) => [t, w.out()])

  const numTables = tables.length
  const sr = 2 ** Math.floor(Math.log2(numTables)) * 16
  const font = new Writer().u32(0x00010000).u16(numTables).u16(sr).u16(Math.log2(sr / 16)).u16(numTables * 16 - sr)
  let offset = 12 + numTables * 16
  const placed: { at: number; data: Uint8Array }[] = []
  for (const [t, data] of tables) {
    font.tag(t).u32(checksum(data)).u32(offset).u32(data.length)
    placed.push({ at: offset, data })
    offset += Math.ceil(data.length / 4) * 4
  }
  const out = new Uint8Array(offset)
  out.set(font.out(), 0)
  for (const p of placed) out.set(p.data, p.at)
  // head.checkSumAdjustment = 0xB1B0AFBA - checksum(font)
  const headAt = placed[tables.findIndex(t => t[0] === 'head')].at
  const adj = (0xb1b0afba - checksum(out)) >>> 0
  out[headAt + 8] = adj >>> 24; out[headAt + 9] = (adj >>> 16) & 0xff; out[headAt + 10] = (adj >>> 8) & 0xff; out[headAt + 11] = adj & 0xff
  return out.buffer
}
