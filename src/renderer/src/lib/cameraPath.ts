import * as THREE from 'three'

/**
 * Scene -> Camera path: views saved along a route, flown through smoothly,
 * optionally recorded to a video.
 *
 * A view is where the camera stands and which way it looks, and how many
 * seconds the flight to the next view takes. While a path plays, the player
 * (components/CameraPathPlayer) owns the camera and the usual controls step
 * aside; when it stops, they take over from wherever it ended (orbit circles
 * what it is looking at). "Go to" is a play of no length. Recording takes
 * the 3D view itself (canvas captureStream into MediaRecorder, WebM), so the
 * panels and buttons are not in the video.
 *
 * Positions follow a centripetal Catmull-Rom curve through the views, so the
 * camera sweeps through each rather than turning sharp corners; rotations
 * follow the same curve on their quaternions (kept on one side, then
 * renormalised), so turning is smooth too. The first leg eases in and the
 * last eases out.
 */

export interface CameraView {
  /** World position and orientation. */
  p: [number, number, number]
  q: [number, number, number, number]
  /** Seconds the flight to the next view takes (unused on the last). */
  seconds: number
}

interface State {
  /** Playing these views since \`startedAt\` (performance.now ms); null when not. */
  playing: { views: CameraView[]; startedAt: number; loop: boolean; record: boolean } | null
  /** Bumped whenever the player hands the camera back, so the controls restart from where it is. */
  handover: number
}

let state: State = { playing: null, handover: 0 }
const listeners = new Set<() => void>()
const set = (next: Partial<State>) => { state = { ...state, ...next }; listeners.forEach(l => l()) }

export const cameraPathStore = {
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l) } },
  get: () => state,
}

let camera: THREE.Camera | null = null
/** The zone view registers its camera; null when it closes. */
export function registerCamera(c: THREE.Camera | null): void {
  camera = c
  if (!c && state.playing) set({ playing: null })
}

/** The camera's view now, to save; null without a zone. */
export function captureView(seconds = 3): CameraView | null {
  if (!camera) return null
  const p = camera.position, q = camera.quaternion
  return { p: [p.x, p.y, p.z], q: [q.x, q.y, q.z, q.w], seconds }
}

/** Plays a path; `record` saves the flight as a video (and never loops). */
export function play(views: CameraView[], loop: boolean, record = false): void {
  if (!camera || !views.length) return
  set({ playing: { views, startedAt: performance.now(), loop: loop && !record, record } })
}

/** Stops; the camera stays where it is and the controls take over from there. */
export function stop(): void {
  if (state.playing) set({ playing: null, handover: state.handover + 1 })
}

/** Puts the camera at a view now (a play of no length). */
export function goTo(view: CameraView): void {
  if (!camera) return
  if (state.playing) set({ playing: null })
  camera.position.fromArray(view.p)
  camera.quaternion.fromArray(view.q)
  set({ handover: state.handover + 1 })
}

/** Total seconds a path takes: every leg but the last view's. */
export function pathSeconds(views: CameraView[]): number {
  return views.slice(0, -1).reduce((t, v) => t + Math.max(0.1, v.seconds), 0)
}

/** Centripetal Catmull-Rom between b and c (a and d the neighbours), at u in 0..1. */
function catmull(a: number[], b: number[], c: number[], d: number[], u: number, out: number[]): number[] {
  const dist = (x: number[], y: number[]) => Math.max(1e-4, Math.sqrt(Math.sqrt(x.reduce((s, xi, i) => s + (xi - y[i]) ** 2, 0))))
  const t1 = dist(a, b), t2 = t1 + dist(b, c), t3 = t2 + dist(c, d)
  const t = t1 + (t2 - t1) * u
  for (let i = 0; i < b.length; i++) {
    const a1 = ((t1 - t) * a[i] + t * b[i]) / t1
    const a2 = ((t2 - t) * b[i] + (t - t1) * c[i]) / (t2 - t1)
    const a3 = ((t3 - t) * c[i] + (t - t2) * d[i]) / (t3 - t2)
    const b1 = ((t2 - t) * a1 + t * a2) / t2
    const b2 = ((t3 - t) * a2 + (t - t1) * a3) / (t3 - t1)
    out[i] = ((t2 - t) * b1 + (t - t1) * b2) / (t2 - t1)
  }
  return out
}

const ease = (u: number) => u * u * (3 - 2 * u)

/**
 * The camera at \`seconds\` into a path: position and orientation. Past the
 * end, the last view.
 */
export function poseAt(views: CameraView[], seconds: number, outP: THREE.Vector3, outQ: THREE.Quaternion): void {
  if (views.length === 1) { outP.fromArray(views[0].p); outQ.fromArray(views[0].q); return }
  // Rotations on one side of the sphere, each against the last, or a turn could go the long way.
  const qs = views.map(v => v.q.slice())
  for (let i = 1; i < qs.length; i++) {
    const d = qs[i].reduce((s, x, k) => s + x * qs[i - 1][k], 0)
    if (d < 0) for (let k = 0; k < 4; k++) qs[i][k] = -qs[i][k]
  }
  let t = Math.max(0, seconds), i = 0
  while (i < views.length - 2 && t > Math.max(0.1, views[i].seconds)) { t -= Math.max(0.1, views[i].seconds); i++ }
  let u = Math.min(1, t / Math.max(0.1, views[i].seconds))
  // Ease in on the first leg and out on the last; steady between.
  if (views.length === 2) u = ease(u)
  else if (i === 0) u = 2 * ease(0.5 * u)
  else if (i === views.length - 2) u = 2 * ease(0.5 + 0.5 * u) - 1
  const at = (k: number) => Math.max(0, Math.min(views.length - 1, k))
  const p = catmull(views[at(i - 1)].p, views[i].p, views[i + 1].p, views[at(i + 2)].p, u, [0, 0, 0])
  const q = catmull(qs[at(i - 1)], qs[i], qs[i + 1], qs[at(i + 2)], u, [0, 0, 0, 0])
  outP.fromArray(p)
  outQ.fromArray(q).normalize()
}
