import { DatReader } from './ffxi-dat/DatReader'
import { parseTextureBlock } from './ffxi-dat/TextureParser'
import { buildBitmapFont } from './bitmapFont'

/**
 * The app's look: the game's own menu art in any of its 8 window styles
 * ("Classic"), or our own styling after the official site ("Modern").
 *
 * Classic is read from the player's install at startup, never shipped:
 *   - window style n (the in-game Window option) is file id 13 + n — ROM/0/14
 *     to ROM/0/21 — each holding the group "menu    win00" over four
 *     textures: newtex (128x128 background), corner (24x24 corners at uv
 *     1,1 / 7,1 / 1,7 / 7,7), hfr1 and vfr1 (5px edges at uv 0,1 / 0,26 and
 *     1,0 / 26,0);
 *   - ROM/119/51 holds the shared menu kit, including "font    moji", the
 *     menu font: 16px cells, 64 per row, ASCII from 0x20 at cell 0.
 * Layout facts from xim (UiResourceManager, UiElementSection — GPL, read as a
 * format reference only); the reading and the drawing here are our own.
 */

export type UiLook = 'modern' | 'classic1' | 'classic2' | 'classic3' | 'classic4' | 'classic5' | 'classic6' | 'classic7' | 'classic8'

export const UI_LOOKS: { id: UiLook; name: string }[] = [
  { id: 'classic1', name: 'Classic — Window 1' },
  { id: 'classic2', name: 'Classic — Window 2' },
  { id: 'classic3', name: 'Classic — Window 3' },
  { id: 'classic4', name: 'Classic — Window 4' },
  { id: 'classic5', name: 'Classic — Window 5' },
  { id: 'classic6', name: 'Classic — Window 6' },
  { id: 'classic7', name: 'Classic — Window 7' },
  { id: 'classic8', name: 'Classic — Window 8' },
  { id: 'modern', name: 'Modern' },
]

const LOOK_KEY = 'ffxi-explorer.uiLook'

/** The saved look, or null before the player has chosen one (first launch). */
export function savedLook(): UiLook | null {
  try {
    const v = localStorage.getItem(LOOK_KEY)
    return UI_LOOKS.some(l => l.id === v) ? (v as UiLook) : null
  } catch { return null }
}

export function saveLook(look: UiLook): void {
  try { localStorage.setItem(LOOK_KEY, look) } catch { /* the choice just will not persist */ }
}

/** The text in a Classic look: the game's menu font, or Modern's Noto Serif. */
export type UiText = 'game' | 'modern'

const TEXT_KEY = 'ffxi-explorer.uiText'

export function savedText(): UiText {
  try { return localStorage.getItem(TEXT_KEY) === 'modern' ? 'modern' : 'game' } catch { return 'game' }
}

export function saveText(text: UiText): void {
  try { localStorage.setItem(TEXT_KEY, text) } catch { /* the choice just will not persist */ }
}

export interface ClassicStyle {
  /** The frame as one 9-slice image for CSS border-image (slice 24). */
  frame: string
  /** The background tile, darkened as the game draws it. */
  background: string
}

export interface ClassicKit {
  styles: ClassicStyle[] // index 0 = window style 1
  /** The CSS family name the menu font was registered under, or null if it failed. */
  font: string | null
  /** Control art as CSS variables (--ui-capsule and friends), or empty if it failed. */
  controls: Record<string, string>
}

export const CLASSIC_FONT = 'FFXI Menu'

type Texture = { width: number; height: number; rgba: Uint8Array }

/** Every texture in a DAT, by its name (the 16-character id, trimmed and lowercased). */
function texturesOf(buffer: ArrayBuffer): Map<string, Texture> {
  const u8 = new Uint8Array(buffer), view = new DataView(buffer), reader = new DatReader(buffer)
  const out = new Map<string, Texture>()
  for (let off = 0, blocks = 0; off < u8.length - 8 && blocks < 20000; blocks++) {
    const packed = view.getUint32(off + 4, true)
    const type = packed & 0x7f, units = (packed >>> 7) & 0x7ffff
    if (type === 0x20) {
      const r = parseTextureBlock(reader, off + 16, units * 16 - 16)
      if (r) out.set(r.name.replace(/\s+/g, ' ').trim().toLowerCase(), r.texture)
    }
    if (!units) break
    off += units * 16
  }
  return out
}

function canvasOf(t: Texture, blackIsClear = false): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = t.width; c.height = t.height
  const px = new Uint8ClampedArray(t.rgba)
  // The frame pieces are opaque, silver or gold on black: the game blends
  // them so black adds nothing. Brightness becomes coverage here, with the
  // colour lifted to full so the edges do not darken.
  if (blackIsClear) {
    for (let i = 0; i < px.length; i += 4) {
      const m = Math.max(px[i], px[i + 1], px[i + 2])
      if (m) { px[i] = (px[i] * 255) / m; px[i + 1] = (px[i + 1] * 255) / m; px[i + 2] = (px[i + 2] * 255) / m }
      px[i + 3] = Math.min(px[i + 3], m)
    }
  }
  c.getContext('2d')!.putImageData(new ImageData(px, t.width, t.height), 0, 0)
  return c
}

/** The game's frame pieces drawn into one 58x58 image: 24px corners around a 10px middle. */
function frameImage(corner: Texture, hfr: Texture, vfr: Texture): string {
  const s = 24, m = 10, W = s * 2 + m
  const c = document.createElement('canvas'); c.width = c.height = W
  const g = c.getContext('2d')!
  const co = canvasOf(corner, true), h = canvasOf(hfr, true), v = canvasOf(vfr, true)
  g.drawImage(co, 1, 1, s, s, 0, 0, s, s)
  g.drawImage(co, 7, 1, s, s, W - s, 0, s, s)
  g.drawImage(co, 1, 7, s, s, 0, W - s, s, s)
  g.drawImage(co, 7, 7, s, s, W - s, W - s, s, s)
  g.drawImage(h, 0, 1, m, 5, s, 0, m, 5)
  g.drawImage(h, 0, 26, m, 5, s, W - 5, m, 5)
  g.drawImage(v, 1, 0, 5, m, 0, s, 5, m)
  g.drawImage(v, 26, 0, 5, m, W - 5, s, 5, m)
  return c.toDataURL()
}

/**
 * The background tile at the brightness it reads at in game. The element's
 * vertex colour is 64/128 — half — over the world; over our flat panels 0.62
 * matched the in-game windows better by eye (mockup, 2026-10-17).
 */
function backgroundImage(t: Texture): string {
  const c = canvasOf(t), g = c.getContext('2d')!
  const d = g.getImageData(0, 0, t.width, t.height)
  for (let i = 0; i < d.data.length; i += 4) {
    d.data[i] *= 0.62; d.data[i + 1] *= 0.62; d.data[i + 2] *= 0.62; d.data[i + 3] = 255
  }
  g.putImageData(d, 0, 0)
  return c.toDataURL()
}

/** A region of a texture as its own canvas, black made clear and tinted (0..1 per channel). */
function piece(t: Texture, x: number, y: number, w: number, h: number, tint: number[], alpha: number): HTMLCanvasElement {
  const src = canvasOf(t, true)
  const c = document.createElement('canvas'); c.width = w; c.height = h
  const g = c.getContext('2d')!
  g.drawImage(src, x, y, w, h, 0, 0, w, h)
  const d = g.getImageData(0, 0, w, h)
  for (let i = 0; i < d.data.length; i += 4) {
    d.data[i] *= tint[0]; d.data[i + 1] *= tint[1]; d.data[i + 2] *= tint[2]; d.data[i + 3] *= alpha
  }
  g.putImageData(d, 0, 0)
  return c
}

function mirrored(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement('canvas'); c.width = src.width; c.height = src.height
  const g = c.getContext('2d')!
  g.translate(src.width, 0); g.scale(-1, 1); g.drawImage(src, 0, 0)
  return c
}

/**
 * The menu kit's controls (ROM/119/51), as the game's own menus use them
 * (element groups "menu    framesus" / "windowps"):
 *   buttonto  every menu row is a capsule: its left end at uv 16,0 (48x16)
 *             and its right end at uv 0,16 (40x16), joined into one 88x16
 *             bar, drawn over a dark plate and then again tinted 96,96,127 —
 *             the blue-silver sheen of FFXI's menu entries;
 *             uv 0,0 (15x15) is the round bullet;
 *   colorbal  the coloured orbs, blue first at 0,0 (16x16);
 *   hnf999    the scroll bar ("menu    scroll"): track uv 56,0 (8x64, drawn
 *             at 32/128), caps uv 48,0 and 48,4 (8x4), fill uv 58,0 (4x64);
 *   yubi      the pointing hand ("menu    yubi"): uv 6,0 (26x32), drawn
 *             mirrored so it points up and left; the fingertip lands at 5,1.
 * Black is clear in all of them (the game blends it away).
 */
function controlArt(tex: Map<string, Texture>): Record<string, string> {
  const btn = tex.get('menu buttonto'), orbs = tex.get('menu colorbal')
  const bar = tex.get('menu hnf999'), hand = tex.get('menu yubi')
  if (!btn || !orbs) return {}
  const tint = [96 / 127, 96 / 127, 1]
  const capsule = (alpha: number) => {
    const c = document.createElement('canvas'); c.width = 88; c.height = 16
    const g = c.getContext('2d')!
    g.drawImage(piece(btn, 16, 0, 48, 16, tint, alpha), 0, 0)
    g.drawImage(piece(btn, 0, 16, 40, 16, tint, alpha), 48, 0)
    return `url(${c.toDataURL()})`
  }
  const one = (c: HTMLCanvasElement) => `url(${c.toDataURL()})`
  return {
    '--ui-capsule': capsule(0.42),
    '--ui-capsule-lit': capsule(1),
    '--ui-bullet': one(piece(btn, 0, 0, 15, 15, [0.55, 0.55, 0.62], 0.75)),
    '--ui-bullet-lit': one(piece(btn, 0, 0, 15, 15, tint, 1)),
    '--ui-orb': one(piece(orbs, 0, 0, 16, 16, [1, 1, 1], 1)),
    ...(bar ? {
      '--ui-scroll-track': one(piece(bar, 56, 0, 8, 64, [1, 1, 1], 0.3)),
      '--ui-scroll-top': one(piece(bar, 48, 0, 8, 4, [1, 1, 1], 1)),
      '--ui-scroll-bottom': one(piece(bar, 48, 4, 8, 4, [1, 1, 1], 1)),
      '--ui-scroll-fill': one(piece(bar, 58, 0, 4, 64, [1, 1, 1], 0.9)),
    } : {}),
    ...(hand ? { '--ui-hand': `${one(mirrored(piece(hand, 6, 0, 26, 32, [1, 1, 1], 1)))} 5 1, pointer` } : {}),
  }
}

/** File id -> path, from VTABLE (which ROM) and FTABLE (folder << 7 | file). */
async function fileIdPath(root: string, id: number, tables: { v?: Uint8Array; f?: DataView }): Promise<string | null> {
  tables.v ??= new Uint8Array(await window.ffxi.readDat(root, 'VTABLE.DAT'))
  tables.f ??= new DataView(await window.ffxi.readDat(root, 'FTABLE.DAT'))
  const rom = tables.v[id]
  if (!rom || id * 2 + 2 > tables.f.byteLength) return null
  const entry = tables.f.getUint16(id * 2, true)
  return `${rom === 1 ? 'ROM' : 'ROM' + rom}/${entry >> 7}/${entry & 0x7f}.DAT`
}

let kitPromise: Promise<ClassicKit> | null = null

/** Reads the 8 window styles and the menu font once; later calls share the result. */
export function loadClassicKit(root: string): Promise<ClassicKit> {
  kitPromise ??= (async () => {
    const tables = {}
    const styles: ClassicStyle[] = []
    for (let n = 1; n <= 8; n++) {
      const path = (await fileIdPath(root, 13 + n, tables).catch(() => null)) ?? `ROM/0/${13 + n}.DAT`
      const tex = texturesOf(await window.ffxi.readDat(root, path))
      const get = (name: string) => {
        const t = tex.get('menu ' + name)
        if (!t) throw new Error(`window style ${n}: no ${name} in ${path}`)
        return t
      }
      styles.push({ frame: frameImage(get('corner'), get('hfr1'), get('vfr1')), background: backgroundImage(get('newtex')) })
    }
    let font: string | null = null
    let controls: Record<string, string> = {}
    try {
      const kitTex = texturesOf(await window.ffxi.readDat(root, 'ROM/119/51.DAT'))
      try { controls = controlArt(kitTex) } catch (e) { console.warn('[uiLook] control art not built:', e) }
      const moji = kitTex.get('font moji')
      if (moji) {
        const cells = new Map<number, number>()
        for (let c = 0x20; c <= 0x7e; c++) cells.set(c, c - 0x20)
        // The glyphs are opaque: white letters inside a baked black outline.
        // Counting the outline as ink drew every letter a pixel too bold; the
        // stylesheet puts a dark outline back with a text shadow.
        const ttf = buildBitmapFont({ rgba: moji.rgba, width: moji.width, cell: 16, columns: 64, cells, minLuma: 112 }, CLASSIC_FONT)
        const face = new FontFace(CLASSIC_FONT, ttf)
        await face.load()
        document.fonts.add(face)
        font = CLASSIC_FONT
      }
    } catch (e) {
      console.warn('[uiLook] menu font not built:', e)
    }
    return { styles, font, controls }
  })()
  kitPromise.catch(() => { kitPromise = null })
  return kitPromise
}

/** The CSS variables one classic style needs, for the root or a preview card. */
export function classicVars(style: ClassicStyle): Record<string, string> {
  return { '--win-frame': `url(${style.frame})`, '--win-bg': `url(${style.background})` }
}

/**
 * Applies a look to the document: `data-look` on <html> picks the stylesheet
 * rules (classic | modern), and a classic look sets its frame and background.
 * Classic without its kit (no install read yet, or a failed read) falls back
 * to Modern rather than showing half a look.
 */
export function applyLook(look: UiLook, kit: ClassicKit | null, text: UiText = 'game'): void {
  const root = document.documentElement
  const n = look.startsWith('classic') ? Number(look.slice(7)) : 0
  if (n && kit) {
    root.dataset.look = 'classic'
    for (const [k, v] of Object.entries({ ...classicVars(kit.styles[n - 1]), ...kit.controls })) root.style.setProperty(k, v)
    // data-look-font: game (the menu font), modern (Noto Serif over the game's
    // windows), or fallback (the menu font could not be built).
    root.dataset.lookFont = text === 'modern' ? 'modern' : kit.font ? 'game' : 'fallback'
  } else {
    root.dataset.look = 'modern'
    for (const k of ['--win-frame', '--win-bg', ...Object.keys(kit?.controls ?? {})]) root.style.removeProperty(k)
    delete root.dataset.lookFont
  }
}
