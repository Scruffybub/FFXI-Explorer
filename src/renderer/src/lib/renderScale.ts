/**
 * Interface → Render resolution: the share of the screen's own resolution the
 * 3D view draws at, scaled up to fill the window. 1 = full (the default).
 *
 * On built-in graphics the frame is mostly pixels: drawing West Ronfaure at 1x
 * instead of the screen's 1.5x took the Intel Arc from 103 to 170 fps
 * (2026-10-23). A per-viewer convenience, so localStorage; a missing or
 * blocked store means full resolution.
 */

const KEY = 'ffxi-explorer.renderScale'
export const RENDER_SCALES = [1, 0.85, 0.75, 0.67, 0.5] as const

function load(): number {
  try {
    const v = Number(localStorage.getItem(KEY))
    return (RENDER_SCALES as readonly number[]).includes(v) ? v : 1
  } catch {
    return 1
  }
}

let scale = load()
const listeners = new Set<() => void>()

export const renderScaleStore = {
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l) } },
  get: () => scale,
}

export function setRenderScale(v: number) {
  scale = v
  try { localStorage.setItem(KEY, String(v)) } catch { /* stays for this session */ }
  listeners.forEach(l => l())
}
