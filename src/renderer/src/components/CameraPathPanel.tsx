import { useEffect, useState, useSyncExternalStore } from 'react'
import { cameraPathStore, captureView, goTo, pathSeconds, play, stop, type CameraView } from '../lib/cameraPath'

const KEY = 'ffxi-explorer.cameraPath.'

function load(zoneId: number | undefined): CameraView[] {
  if (zoneId === undefined) return []
  try {
    const raw = localStorage.getItem(KEY + zoneId)
    const views = raw ? (JSON.parse(raw) as CameraView[]) : []
    return Array.isArray(views) ? views.filter(v => Array.isArray(v.p) && Array.isArray(v.q)) : []
  } catch { return [] }
}

/**
 * Scene -> Camera path (lib/cameraPath): save views, set how long each leg
 * takes, play the flight, loop it or record it as a video. Views are kept per
 * zone on this computer.
 */
export function CameraPathPanel({ zoneId }: { zoneId: number | undefined }) {
  const [views, setViews] = useState<CameraView[]>(() => load(zoneId))
  const [loop, setLoop] = useState(false)
  const { playing } = useSyncExternalStore(cameraPathStore.subscribe, cameraPathStore.get)

  useEffect(() => { setViews(load(zoneId)) }, [zoneId])
  const save = (next: CameraView[]) => {
    setViews(next)
    if (zoneId === undefined) return
    try {
      if (next.length) localStorage.setItem(KEY + zoneId, JSON.stringify(next))
      else localStorage.removeItem(KEY + zoneId)
    } catch { /* the views still work this session */ }
  }

  const add = () => {
    const v = captureView(views.at(-1)?.seconds ?? 3)
    if (v) save([...views, v])
  }
  const total = pathSeconds(views)

  return (
    <>
      <button className="place-btn" onClick={add} disabled={!!playing}>Add this view</button>
      {views.length > 0 && (
        <ul className="light-list camera-views">
          {views.map((v, i) => (
            <li key={i}>
              <button onClick={() => goTo(v)} disabled={!!playing} title="Put the camera at this view">
                <span>View {i + 1}</span>
              </button>
              {i < views.length - 1 ? (
                <label className="camera-seconds" title="Seconds the flight to the next view takes">
                  <input
                    type="number" min={0.5} max={120} step={0.5} value={v.seconds}
                    disabled={!!playing}
                    onChange={e => {
                      const s = Math.min(120, Math.max(0.5, Number(e.target.value) || 0.5))
                      save(views.map((w, k) => (k === i ? { ...w, seconds: s } : w)))
                    }}
                  />
                  s
                </label>
              ) : <span className="camera-seconds end">end</span>}
              <button className="remove" onClick={() => save(views.filter((_, k) => k !== i))} disabled={!!playing} title="Remove this view">×</button>
            </li>
          ))}
        </ul>
      )}
      {views.length >= 2 && (
        <>
          <div className="camera-actions">
            {playing ? (
              <button className="place-btn active" onClick={stop}>{playing.record ? 'Stop recording' : 'Stop'}</button>
            ) : (
              <>
                <button className="place-btn" onClick={() => play(views, loop)}>Play</button>
                <button className="place-btn" onClick={() => play(views, false, true)} title="Play the path once and save it as a WebM video of the 3D view">Record video</button>
              </>
            )}
          </div>
          <label className="control toggle">
            <input type="checkbox" checked={loop} onChange={e => setLoop(e.target.checked)} />
            <span>Loop</span>
          </label>
          <p className="note small">{views.length} views · {total.toFixed(1)} seconds</p>
        </>
      )}
      {views.length > 0 && !playing && (
        <button className="place-btn" onClick={() => save([])}>Clear the path</button>
      )}
    </>
  )
}
