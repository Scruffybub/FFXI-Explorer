import { useEffect, useMemo, useRef, useState } from 'react'
import { parseMinimapDat } from '../lib/ffxi-dat'
import type { ZoneEntry } from '../lib/zoneList'

/**
 * The in-game area maps — the parchment plates the game shows when you open the
 * map, not the 3D geometry.
 *
 * Where they live was an open question; the answer was already in the zone
 * table. `zone-seed-data.csv` carries a `MAP_PATHS` column that nothing had ever
 * read, listing one DAT per page. Each holds a single 512x512 DXT3 texture
 * named `menumap m_<zone>_<page>` (or `ex4_datam_<zone>_<page>` for the
 * expansion maps), which the existing texture parser reads without changes.
 *
 * Zones with floors carry a page each: Castle Oztroja [S] lists thirteen.
 */

interface MapPage {
  /** The texture's own name, e.g. "menumap m_106_00". */
  name: string
  path: string
  width: number
  height: number
  rgba: Uint8ClampedArray
  /** Zone id embedded in the name, or null if it does not follow the scheme. */
  zoneId: number | null
  /** Page number embedded in the name. Real map numbers, not a sequence. */
  pageNo: number | null
  /** Decoder that produced it — decides whether the rows need flipping. */
  format: string
}

/**
 * Orientation is `parseMinimapDat`'s job, and it already gets it right.
 *
 * Palette-indexed plates are stored bottom-up and that parser flips them; DXT
 * ones are not and it leaves them alone. Confirmed independently here by
 * rendering all four orientations of Castle Oztroja's floor 1 (`m_151_01`,
 * indexed) — only the vertical flip puts the banner at the top with the title
 * the right way round, the grid letters A-O left to right and the compass at
 * bottom right. North Gustaberg's plate (`m_106_00`, DXT3) is correct untouched.
 *
 * The general `parseTexturesFromDat` does *not* flip, which is why this uses
 * the minimap parser: same files, different and correct handling.
 */

/**
 * Texture names follow `menumap m_<zone>_<page>` and `ex4_datam_<zone>_<page>`.
 *
 * The zone id matters because a row's MAP_PATHS lists the maps for *both* a
 * zone and its Wings of the Goddess past counterpart — North Gustaberg's entry
 * carries `m_106_00` and `ex4_datam_088_00`, and 88 is North Gustaberg [S],
 * which has its own row listing the same pair. Filtering by id gives each zone
 * its own maps instead of both.
 */
function describePage(name: string): { zoneId: number | null; pageNo: number | null } {
  const m = name.match(/_(\d+)_(\d+)\s*$/)
  if (!m) return { zoneId: null, pageNo: null }
  return { zoneId: Number(m[1]), pageNo: Number(m[2]) }
}

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; pages: MapPage[] }
  | { status: 'error'; message: string }

/** Fit scales to the viewport; the fixed steps are for reading fine labels. */
type Zoom = 'fit' | 1 | 2

export default function MapViewer({
  ffxiPath, zone, uiHidden,
}: {
  ffxiPath: string
  zone: ZoneEntry | null
  uiHidden: boolean
}) {
  const [load, setLoad] = useState<LoadState>({ status: 'idle' })
  const [page, setPage] = useState(0)
  const [zoom, setZoom] = useState<Zoom>('fit')
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    if (!zone) { setLoad({ status: 'idle' }); return }
    let cancelled = false
    setLoad({ status: 'loading' })
    setPage(0)

    ;(async () => {
      const pages: MapPage[] = []
      const failures: string[] = []
      for (const path of zone.mapPaths) {
        try {
          const buf = await window.ffxi.readDat(ffxiPath, path)
          const parsed = parseMinimapDat(buf)
          if (!parsed) {
            failures.push(`${path}: no map block`)
            continue
          }
          const { name, texture } = parsed
          pages.push({
            name,
            path,
            width: texture.width,
            height: texture.height,
            format: texture.format,
            rgba: new Uint8ClampedArray(texture.rgba),
            ...describePage(name),
          })
        } catch (err) {
          // One unreadable page should not cost the rest of the zone's maps.
          failures.push(`${path}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      if (cancelled) return
      if (pages.length === 0) {
        setLoad({
          status: 'error',
          message: failures.length
            ? failures.join('\n')
            : 'The listed map files hold no readable image.',
        })
        return
      }
      // Keep only this zone's own pages. A row lists its counterpart's maps too,
      // and that zone has its own row — so without this, every [S] zone and its
      // present-day twin would each show both sets. Falls back to everything if
      // nothing matches, rather than showing an empty viewer.
      const mine = pages.filter(p => p.zoneId === zone.id)
      const shown = mine.length > 0 ? mine : pages
      // Real map numbers, in order: Castle Oztroja runs 1, 2, 4, 15.
      shown.sort((a, b) => (a.pageNo ?? 0) - (b.pageNo ?? 0) || a.name.localeCompare(b.name))
      setLoad({ status: 'ready', pages: shown })
    })()

    return () => { cancelled = true }
  }, [ffxiPath, zone])

  const current = load.status === 'ready' ? load.pages[Math.min(page, load.pages.length - 1)] : null

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !current) return
    canvas.width = current.width
    canvas.height = current.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    // Built through createImageData rather than `new ImageData(rgba, …)`: the
    // parser's array is typed over ArrayBufferLike, which that constructor's
    // signature rejects.
    const image = ctx.createImageData(current.width, current.height)
    image.data.set(current.rgba)
    ctx.putImageData(image, 0, 0)
  }, [current])

  const savePng = async () => {
    const canvas = canvasRef.current
    if (!canvas || !current || !zone) return
    const safe = `${zone.name.replace(/[^\w-]+/g, '-')}-${current.name.replace(/[^\w-]+/g, '-')}.png`
    await window.ffxi.saveScreenshot(canvas.toDataURL('image/png'), safe)
  }

  /**
   * The game's own page number, not a sequence: Castle Oztroja's floors are
   * stored as 01-06 plus 15, and renumbering them 1-7 would lose that. Zones
   * with a single page are stored as 00 and never show these buttons at all.
   */
  const pageLabel = useMemo(() => (p: MapPage, i: number) =>
    p.pageNo === null ? String(i + 1) : String(p.pageNo), [])

  if (!zone) {
    return (
      <div className="placeholder">
        <h2>Select a zone</h2>
        <p>The game's own area maps, read from your installation.</p>
      </div>
    )
  }

  if (load.status === 'loading') {
    return <div className="placeholder"><div className="spinner" /><p>Reading {zone.name}…</p></div>
  }

  if (load.status === 'error') {
    return (
      <div className="placeholder">
        <h2>No map for {zone.name}</h2>
        <p className="error-text">{load.message}</p>
      </div>
    )
  }

  if (load.status !== 'ready' || !current) {
    return <div className="placeholder"><h2>Select a zone</h2></div>
  }

  return (
    <div className="map-view">
      {!uiHidden && (
        <div className="map-bar">
          <strong>{zone.name}</strong>
          {load.pages.length > 1 && (
            <span className="map-pages">
              {load.pages.map((p, i) => (
                <button
                  key={p.name}
                  className={i === page ? 'active' : ''}
                  onClick={() => setPage(i)}
                  title={`${p.name} — ${p.path}`}
                >
                  {pageLabel(p, i)}
                </button>
              ))}
            </span>
          )}
          <span className="map-zoom">
            {(['fit', 1, 2] as Zoom[]).map(z => (
              <button key={String(z)} className={zoom === z ? 'active' : ''} onClick={() => setZoom(z)}>
                {z === 'fit' ? 'Fit' : `${z * 100}%`}
              </button>
            ))}
          </span>
          <button className="map-save" onClick={savePng}>Save PNG</button>
        </div>
      )}

      <div className={`map-canvas-wrap ${zoom === 'fit' ? 'fit' : 'scroll'}`}>
        <canvas
          ref={canvasRef}
          className="map-canvas"
          style={zoom === 'fit'
            ? undefined
            : { width: current.width * zoom, height: current.height * zoom }}
        />
      </div>

      {!uiHidden && (
        <div className="hud map-hud">
          <strong>{current.name}</strong>
          <span>
            {current.width}×{current.height} · {current.path}
            {load.pages.length > 1 ? ` · page ${page + 1} of ${load.pages.length}` : ''}
          </span>
        </div>
      )}
    </div>
  )
}
