import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { cameraPathStore, captureView, goTo, pathSeconds, play, poseAt, registerCamera, stop } from '../lib/cameraPath'

const CENSUS = new URLSearchParams(window.location.search).has('census')

/** Bits a second for recorded video: sharp enough for a 1080p flythrough. */
const VIDEO_BITRATE = 16_000_000

/**
 * Scene -> Camera path, inside the zone view: flies the camera along the path
 * while one plays (lib/cameraPath), and records the 3D view when asked.
 * ZoneViewer leaves its camera controls out while a path plays.
 */
export function CameraPathPlayer({ name }: { name: string }) {
  const { camera, gl } = useThree()
  const { playing } = useSyncExternalStore(cameraPathStore.subscribe, cameraPathStore.get)

  useEffect(() => {
    registerCamera(camera)
    // ?census=1: drive paths from a harness; __testVideo keeps a recording in memory (no save dialog).
    if (CENSUS) (window as unknown as Record<string, unknown>).__cameraPath = { goTo, play, stop, captureView, state: cameraPathStore.get, camera: () => [...camera.position.toArray(), ...camera.quaternion.toArray()] }
    return () => registerCamera(null)
  }, [camera])

  // Recording: the canvas as a 60 fps stream, saved as WebM when the path ends.
  const recorder = useRef<MediaRecorder | null>(null)
  useEffect(() => {
    if (!playing?.record) return
    const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    const mimeType = types.find(t => MediaRecorder.isTypeSupported(t)) ?? 'video/webm'
    const chunks: Blob[] = []
    const rec = new MediaRecorder(gl.domElement.captureStream(60), { mimeType, videoBitsPerSecond: VIDEO_BITRATE })
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data) }
    rec.onstop = async () => {
      const bytes = await new Blob(chunks, { type: 'video/webm' }).arrayBuffer()
      if (CENSUS && (window as unknown as Record<string, unknown>).__testVideo) {
        ;(window as unknown as Record<string, unknown>).__lastVideo = { bytes: bytes.byteLength, head: Array.from(new Uint8Array(bytes, 0, 4)), type: mimeType }
        return
      }
      const file = name.replace(/[^\w' -]+/g, '').trim().replace(/\s+/g, '-') || 'flythrough'
      await window.ffxi.saveFile(bytes, `${file}-flythrough.webm`, 'WebM video', 'webm')
    }
    rec.start(250)
    recorder.current = rec
    return () => {
      if (rec.state !== 'inactive') rec.stop()
      recorder.current = null
    }
  }, [playing, gl, name])

  const p = useMemo(() => new THREE.Vector3(), [])
  const q = useMemo(() => new THREE.Quaternion(), [])
  useFrame(() => {
    if (!playing) return
    const total = pathSeconds(playing.views)
    let t = (performance.now() - playing.startedAt) / 1000
    if (t > total) {
      if (playing.loop && total > 0) t %= total
      else {
        poseAt(playing.views, total, p, q)
        camera.position.copy(p); camera.quaternion.copy(q)
        stop()
        return
      }
    }
    poseAt(playing.views, t, p, q)
    camera.position.copy(p)
    camera.quaternion.copy(q)
    camera.updateMatrixWorld()
  })

  return null
}
