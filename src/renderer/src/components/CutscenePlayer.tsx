import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { advanceCutscene, chooseCutscene, cutsceneRun, cutsceneStore, stopCutscene, type CameraPose, type SightRay } from '../lib/cutscene'
import type { CollisionWorld } from '../lib/CollisionWorld'

/** A line-of-sight test against the drawn zone meshes (those carrying a prefab index), not NPCs or effects. */
function sightRay(scene: THREE.Scene): SightRay | null {
  const meshes: THREE.Object3D[] = []
  scene.traverse(o => { if (o.userData.prefabIdx !== undefined && (o as THREE.Mesh).isMesh) meshes.push(o) })
  // None yet: the zone is still building its meshes.
  if (!meshes.length) return null
  const raycaster = new THREE.Raycaster()
  const back = new THREE.Vector3(), end = new THREE.Vector3()
  // Both ways: walls are one-sided, so a ray leaving a room passes through the back of its wall.
  return (from, dir, distance) => {
    raycaster.far = distance
    raycaster.set(from, dir)
    const hit = raycaster.intersectObjects(meshes, false)[0]
    raycaster.set(end.copy(from).addScaledVector(dir, distance), back.copy(dir).negate())
    const hitBack = raycaster.intersectObjects(meshes, false)[0]
    const d = Math.min(hit ? hit.distance : Infinity, hitBack ? distance - hitBack.distance : Infinity)
    return d === Infinity ? null : d
  }
}

const CENSUS = new URLSearchParams(window.location.search).has('census')

/**
 * The NPC conversation's framing, clear of walls (NPCs often stand in small
 * rooms): the first of the run's shots (over your shoulder, then side-on
 * two-shots) with nothing between its eye and what it looks at; failing all,
 * each shot swung around its subject (40 and 80 degrees each way, then
 * behind) and pulled in short of the wall, the most open of them.
 */
function clearView(shots: CameraPose[], sight: SightRay): CameraPose {
  for (const s of shots) {
    const out = s.eye.clone().sub(s.target), want = out.length()
    if (sight(s.target, out.normalize(), want) === null) return s
  }
  let best = { pose: shots[0], clear: -1 }
  for (const s of shots) {
    const out = s.eye.clone().sub(s.target), want = out.length()
    for (const deg of [40, -40, 80, -80, 180]) {
      const dir = out.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), (deg * Math.PI) / 180).normalize()
      const hit = sight(s.target, dir, want)
      const clear = hit !== null ? Math.max(0.6, hit - 0.3) : want
      if (clear > best.clear) best = { pose: { ...s, eye: s.target.clone().addScaledVector(dir, clear) }, clear }
    }
  }
  return best.pose
}

/**
 * Inside the zone view: runs the requested event (lib/cutscene) each frame
 * and puts the camera where its schedulers say. ZoneViewer leaves its camera
 * controls out while one plays; the lens goes back when it ends.
 */
export function CutscenePlayer({ zoneId, world }: { zoneId: number | null; world: CollisionWorld | null }) {
  const { camera, scene } = useThree()
  const state = useSyncExternalStore(cutsceneStore.subscribe, cutsceneStore.get)
  // Only in the zone the scene is in (a request arrives while the last zone is still up; a flashback opens another).
  const request = state.request && state.sceneZone === zoneId ? state.request : null
  const started = useRef(false)
  const meshesDrawn = useRef(false)
  const fov = useRef<number | null>(null)
  const look = useMemo(() => new THREE.Matrix4(), [])
  const up = useMemo(() => new THREE.Vector3(0, 1, 0), [])

  useEffect(() => {
    if (!request) return
    started.current = false
    meshesDrawn.current = false
    const cam = camera as THREE.PerspectiveCamera
    fov.current = cam.fov
    if (CENSUS) (window as unknown as Record<string, unknown>).__cutscene = { run: cutsceneRun, advance: advanceCutscene, choose: chooseCutscene, stop: stopCutscene, camera: () => [...cam.position.toArray(), cam.fov] }
    return () => {
      if (fov.current !== null) { cam.fov = fov.current; cam.updateProjectionMatrix() }
    }
  }, [request, camera])

  useFrame((_, delta) => {
    if (!request) return
    const run = cutsceneRun()
    if (!run) return
    if (!started.current) {
      // The scene starts once the zone's meshes are in and drawn once (placed in the world): its framing looks for walls among them.
      const sight = sightRay(scene)
      if (!sight) return
      if (!meshesDrawn.current) { meshesDrawn.current = true; return }
      started.current = true
      run.setWorld(world, sight)
      if (CENSUS) (window as unknown as Record<string, unknown>).__sight = (f: number[], d: number[], n: number) => sight(new THREE.Vector3(...f), new THREE.Vector3(...d).normalize(), n)
      if (run.restShots.length && !run.restCleared) { run.rest = clearView(run.restShots, sight); run.restCleared = true }
      if (zoneId !== null) run.zoneReady(zoneId)
    }
    // Frame time, at most 0.1 s a frame, so a slow first frame (the zone settling in) doesn't eat the opening.
    run.tick(Math.min(delta, 0.1))
    const pose = run.cameraPose()
    if (!pose) return
    const cam = camera as THREE.PerspectiveCamera
    cam.position.copy(pose.eye)
    look.lookAt(pose.eye, pose.target, up)
    cam.quaternion.setFromRotationMatrix(look)
    if (Math.abs(cam.fov - pose.fov) > 0.01) { cam.fov = pose.fov; cam.updateProjectionMatrix() }
  })
  return null
}

/**
 * The screen colour (scheduler op 0x0F) multiplies the picture, 0x80 = x1:
 * fade-out is x0 (black), fade-in x1, the flashback's "sepi" x(1.28, 1.03,
 * 0.78). Above 1 is past what a colour layer can do, so the zone's canvas
 * takes an SVG colour matrix while it isn't x1.
 */
function useScreenTint(holder: React.RefObject<HTMLDivElement | null>, fade: [number, number, number, number] | undefined) {
  const [r, g, b, a] = fade ?? [1, 1, 1, 0]
  const k = [r, g, b].map(c => 1 + (c - 1) * a)
  const identity = k.every(c => Math.abs(c - 1) < 0.002)
  useEffect(() => {
    const canvas = holder.current?.parentElement?.querySelector('canvas')
    if (!canvas) return
    canvas.style.filter = identity ? '' : 'url(#cutscene-tint)'
    return () => { canvas.style.filter = '' }
  }, [holder, identity])
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden>
      <filter id="cutscene-tint" colorInterpolationFilters="sRGB">
        <feColorMatrix type="matrix" values={`${k[0]} 0 0 0 0  0 ${k[1]} 0 0 0  0 0 ${k[2]} 0 0  0 0 0 1 0`} />
      </filter>
    </svg>
  )
}

/** Over the zone view: the screen colour, the message window and the choices. */
export function CutsceneOverlay() {
  const { request, view } = useSyncExternalStore(cutsceneStore.subscribe, cutsceneStore.get)
  const holder = useRef<HTMLDivElement>(null)
  const tint = useScreenTint(holder, view?.fade)
  const msg = view?.message
  // Enter or Space: next line. 1-9: a choice. Esc: stop.
  useEffect(() => {
    if (!request) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input, select, textarea')) return
      if (e.key === 'Escape') { e.preventDefault(); stopCutscene() }
      else if ((e.key === 'Enter' || e.key === ' ') && msg && !msg.choices) { e.preventDefault(); advanceCutscene() }
      else if (msg?.choices && /^[1-9]$/.test(e.key) && Number(e.key) <= msg.choices.length) chooseCutscene(Number(e.key) - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [request, msg])
  if (!request) return null
  const click = () => { if (msg && !msg.choices) advanceCutscene() }
  return (
    <div className="cutscene-overlay" onClick={click} ref={holder}>
      {tint}
      <div className="cutscene-bar" onClick={e => e.stopPropagation()}>
        <span>{view?.title ?? 'Starting…'}</span>
        <button onClick={stopCutscene}>{view?.ended ? 'Close' : 'Stop'}</button>
      </div>
      {msg && (
        <div className="cutscene-message" onClick={e => { e.stopPropagation(); click() }}>
          {msg.speaker && <b>{msg.speaker}</b>}
          <p>{msg.text}</p>
          {msg.choices ? (
            <ol>
              {msg.choices.map((c, i) => <li key={i}><button onClick={() => chooseCutscene(i)}>{c}</button></li>)}
            </ol>
          ) : <span className="cutscene-next">▼</span>}
        </div>
      )}
      {view?.ended && (
        <div className="cutscene-message cutscene-end" onClick={e => e.stopPropagation()}>
          <p>{view.note ?? 'The event has ended.'}</p>
          <button className="place-btn" onClick={stopCutscene}>Back to the zone</button>
        </div>
      )}
    </div>
  )
}
