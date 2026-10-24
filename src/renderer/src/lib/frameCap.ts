/**
 * Interface → Frame rate limit: draw at most this many frames a second, or 0
 * for as fast as the screen refreshes (the default). Saves power and heat on
 * laptops; ZoneViewer's FrameCap pauses three's own loop and advances it on a
 * timer. Per viewer, in localStorage; a missing or blocked store means no limit.
 */

const KEY = 'ffxi-explorer.frameCap'
export const FRAME_CAPS = [0, 30, 60, 120] as const

function load(): number {
  try {
    const v = Number(localStorage.getItem(KEY))
    return (FRAME_CAPS as readonly number[]).includes(v) ? v : 0
  } catch {
    return 0
  }
}

let cap = load()
const listeners = new Set<() => void>()

export const frameCapStore = {
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l) } },
  get: () => cap,
}

export function setFrameCap(v: number) {
  cap = v
  try { localStorage.setItem(KEY, String(v)) } catch { /* stays for this session */ }
  listeners.forEach(l => l())
}
