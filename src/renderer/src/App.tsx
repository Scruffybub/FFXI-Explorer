import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { ZONES, type ZoneEntry } from './lib/zoneList'
import { parseZoneFile, parseTexturesFromDat, type ParsedZone } from './lib/ffxi-dat'
import ZoneViewer from './components/ZoneViewer'
import ControlPanel from './components/ControlPanel'
import {
  DEFAULT_LIGHTING, DEFAULT_POST, DEFAULT_SCENE, DEFAULT_POINT_LIGHTS,
  NEW_POINT_LIGHT, PRESETS,
  type LightingSettings, type PointLightSettings, type PointLightSpec,
  type PostSettings, type SceneSettings, type SurfaceInfo,
} from './lib/settings'

type LoadState =
  | { status: 'idle' }
  | { status: 'loading'; message: string }
  | { status: 'ready'; zone: ParsedZone }
  | { status: 'error'; message: string }

export default function App() {
  const [ffxiPath, setFfxiPath] = useState<string | null>(null)
  const [detecting, setDetecting] = useState(true)
  const [pickError, setPickError] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<ZoneEntry | null>(null)
  const [load, setLoad] = useState<LoadState>({ status: 'idle' })

  const [lighting, setLighting] = useState<LightingSettings>(DEFAULT_LIGHTING)
  const [post, setPost] = useState<PostSettings>(DEFAULT_POST)
  const [scene, setScene] = useState<SceneSettings>(DEFAULT_SCENE)
  const [pointLights, setPointLights] = useState<PointLightSettings>(DEFAULT_POINT_LIGHTS)
  const [selectedLightId, setSelectedLightId] = useState<number | null>(null)
  const [placingLight, setPlacingLight] = useState(false)
  const nextLightId = useRef(1)

  const [inspecting, setInspecting] = useState(false)
  const [surfaceInfo, setSurfaceInfo] = useState<SurfaceInfo | null>(null)

  const [uiHidden, setUiHidden] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  // Find a remembered or auto-detected install on first launch.
  useEffect(() => {
    let cancelled = false
    window.ffxi.autoDetect()
      .then(path => { if (!cancelled) { setFfxiPath(path); setDetecting(false) } })
      .catch(() => { if (!cancelled) setDetecting(false) })
    return () => { cancelled = true }
  }, [])

  const handlePick = useCallback(async () => {
    setPickError(null)
    const result = await window.ffxi.pickDirectory()
    if (result.status === 'ok') {
      setFfxiPath(result.path)
    } else if (result.status === 'invalid') {
      setPickError(
        `That folder doesn't look like an FFXI installation. Expected to find ROM, ROM2 and VTABLE.DAT inside it.`
      )
    }
  }, [])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return ZONES
    return ZONES.filter(z => z.name.toLowerCase().includes(q))
  }, [search])

  const loadZone = useCallback(async (zone: ZoneEntry) => {
    if (!ffxiPath) return
    setSelected(zone)
    setLoad({ status: 'loading', message: `Reading ${zone.modelPath}...` })

    try {
      const buffer = await window.ffxi.readDat(ffxiPath, zone.modelPath)

      // Some zones keep textures in a companion DAT beside the geometry.
      let supplemental: Map<string, import('./lib/ffxi-dat').ParsedTexture> | undefined
      const texturePath = zone.modelPath.replace(/(\d+)\.DAT$/i, (_m, n) => `${Number(n) + 1}.DAT`)
      if (texturePath !== zone.modelPath && await window.ffxi.fileExists(ffxiPath, texturePath)) {
        try {
          const texBuf = await window.ffxi.readDat(ffxiPath, texturePath)
          supplemental = parseTexturesFromDat(texBuf)
        } catch { /* optional */ }
      }

      setLoad({ status: 'loading', message: 'Parsing geometry...' })
      // Yield so the loading message paints before the parse blocks the thread.
      await new Promise(r => setTimeout(r, 16))

      const parsed = parseZoneFile(buffer, msg => {
        setLoad({ status: 'loading', message: msg })
      }, supplemental)

      if (parsed.prefabs.length === 0 || parsed.instances.length === 0) {
        setLoad({ status: 'error', message: 'This zone file contains no renderable geometry.' })
        return
      }

      setLoad({ status: 'ready', zone: parsed })
    } catch (err) {
      setLoad({
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }, [ffxiPath])

  // Deep link: index.html?zone=<id>[&preset=<n>] opens straight into a zone.
  useEffect(() => {
    if (!ffxiPath || selected) return
    const params = new URLSearchParams(window.location.search)
    const zoneId = params.get('zone')
    if (!zoneId) return
    const zone = ZONES.find(z => z.id === Number(zoneId))
    if (zone) void loadZone(zone)
  }, [ffxiPath, selected, loadZone])

  // Diagnostic hook: parse an arbitrary DAT and report what it holds, so
  // adjacent zone files can be checked for geometry the model DAT lacks.
  useEffect(() => {
    if (!ffxiPath) return
    ;(window as unknown as Record<string, unknown>).__probeDat = async (rel: string) => {
      try {
        if (!(await window.ffxi.fileExists(ffxiPath, rel))) return { rel, exists: false }
        const buf = await window.ffxi.readDat(ffxiPath, rel)
        let zone: ParsedZone | null = null
        try { zone = parseZoneFile(buf) } catch { /* not a zone file */ }
        let texNames: string[] = []
        try { texNames = Array.from(parseTexturesFromDat(buf).keys()) } catch { /* none */ }
        return {
          rel,
          exists: true,
          bytes: buf.byteLength,
          prefabs: zone?.prefabs.length ?? 0,
          instances: zone?.instances.length ?? 0,
          zoneTextures: zone?.textures.length ?? 0,
          prefabTexNames: Array.from(new Set((zone?.prefabs ?? []).map(p => p.textureName).filter(Boolean))),
          standaloneTexNames: texNames,
        }
      } catch (e) {
        return { rel, error: e instanceof Error ? e.message : String(e) }
      }
    }
  }, [ffxiPath])

  const applyPreset = useCallback((index: number) => {
    const preset = PRESETS[index]
    if (!preset) return
    // Apply over the defaults rather than the current settings. Presets only
    // list what they change, so merging onto whatever was already set would
    // leak the previous preset's values through — picking Clay Render and then
    // Original used to leave the view desaturated, because Original never
    // mentions saturation.
    setLighting({ ...DEFAULT_LIGHTING, ...preset.lighting })
    setPost({ ...DEFAULT_POST, ...preset.post })
    // Camera mode and wireframe are navigation choices rather than part of the
    // preset's look, so they survive a preset change.
    setScene(s => ({
      ...DEFAULT_SCENE,
      ...preset.scene,
      cameraMode: s.cameraMode,
      wireframe: s.wireframe,
    }))
  }, [])

  const resetAll = useCallback(() => {
    setLighting(DEFAULT_LIGHTING)
    setPost(DEFAULT_POST)
    setScene(DEFAULT_SCENE)
    setPointLights(DEFAULT_POINT_LIGHTS)
    setSelectedLightId(null)
    setPlacingLight(false)
  }, [])

  const placeLight = useCallback((position: [number, number, number]) => {
    const id = nextLightId.current++
    setPointLights(s => ({ ...s, lights: [...s.lights, { ...NEW_POINT_LIGHT, id, position }] }))
    setSelectedLightId(id)
    setPlacingLight(false)
  }, [])

  const updateLight = useCallback((id: number, patch: Partial<PointLightSpec>) => {
    setPointLights(s => ({
      ...s,
      lights: s.lights.map(l => (l.id === id ? { ...l, ...patch } : l)),
    }))
  }, [])

  const removeLight = useCallback((id: number) => {
    setPointLights(s => ({ ...s, lights: s.lights.filter(l => l.id !== id) }))
    setSelectedLightId(cur => (cur === id ? null : cur))
  }, [])

  // ── Presentation: hide the panels, go fullscreen, grab a screenshot ────
  const toggleFullscreen = useCallback(async () => {
    const next = !(await window.ffxi.isFullscreen())
    await window.ffxi.setFullscreen(next)
    setFullscreen(next)
    // Fullscreen is for looking at the render, so clear the panels with it.
    setUiHidden(next)
  }, [])

  const takeScreenshot = useCallback(async () => {
    const canvas = document.querySelector('canvas')
    if (!canvas) return
    const name = `${(selected?.name ?? 'zone').replace(/[^\w-]+/g, '-')}.png`
    const saved = await window.ffxi.saveScreenshot(canvas.toDataURL('image/png'), name)
    if (saved) {
      setToast(`Saved to ${saved}`)
      setTimeout(() => setToast(null), 4000)
    }
  }, [selected])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F11') { e.preventDefault(); void toggleFullscreen() }
      else if (e.key === 'F10') { e.preventDefault(); setUiHidden(h => !h) }
      else if (e.key === 'F12') { e.preventDefault(); void takeScreenshot() }
      else if (e.key === 'Escape' && inspecting) { setInspecting(false) }
      else if (e.key === 'Escape' && fullscreen) { void toggleFullscreen() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleFullscreen, takeScreenshot, fullscreen, inspecting])

  // Placement uses plain clicks, which would otherwise also orbit the camera.
  // Escape is the way out if the user changes their mind.
  useEffect(() => {
    if (!placingLight) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPlacingLight(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [placingLight])

  // Apply a preset named in the deep link once a zone has finished loading.
  // Individual settings can then be overridden with post_<key>/light_<key>
  // query params, which is how the diagnostic harness isolates one effect.
  useEffect(() => {
    if (load.status !== 'ready') return
    const params = new URLSearchParams(window.location.search)
    const presetIdx = params.get('preset')
    if (presetIdx !== null) applyPreset(Number(presetIdx))

    const coerce = (v: string): boolean | number => {
      if (v === 'true') return true
      if (v === 'false') return false
      return Number(v)
    }
    const postPatch: Record<string, boolean | number> = {}
    const lightPatch: Record<string, boolean | number> = {}
    const scenePatch: Record<string, boolean | number> = {}
    params.forEach((value, key) => {
      if (key.startsWith('post_')) postPatch[key.slice(5)] = coerce(value)
      if (key.startsWith('light_')) lightPatch[key.slice(6)] = coerce(value)
      if (key.startsWith('scene_')) scenePatch[key.slice(6)] = coerce(value)
    })
    if (Object.keys(postPatch).length) setPost(p => ({ ...p, ...postPatch }))
    if (Object.keys(lightPatch).length) setLighting(l => ({ ...l, ...lightPatch }))
    if (Object.keys(scenePatch).length) setScene(sc => ({ ...sc, ...scenePatch }))
    // Only run on the first successful load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load.status])

  // ── First run: no install located ──────────────────────────────────────
  if (detecting) {
    return (
      <div className="setup">
        <div className="setup-card">
          <h1>FFXI Zone Viewer</h1>
          <p>Looking for your Final Fantasy XI installation...</p>
        </div>
      </div>
    )
  }

  if (!ffxiPath) {
    return (
      <div className="setup">
        <div className="setup-card">
          <h1>FFXI Zone Viewer</h1>
          <p>
            Point the viewer at your Final Fantasy XI folder — the one containing
            <code>ROM</code>, <code>ROM2</code>–<code>ROM9</code> and <code>VTABLE.DAT</code>.
          </p>
          <p className="muted">
            Game files are read directly from disk and never leave your computer.
            Installing inside <code>Program Files</code> is fine here.
          </p>
          {pickError && <div className="error-box">{pickError}</div>}
          <button className="primary" onClick={handlePick}>Choose FFXI folder</button>
        </div>
      </div>
    )
  }

  // ── Main UI ────────────────────────────────────────────────────────────
  return (
    <div className={`app ${uiHidden ? 'ui-hidden' : ''}`}>
      <aside className="sidebar">
        <div className="sidebar-head">
          <h1>Zones</h1>
          <input
            className="search"
            placeholder="Search zones..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <div className="path" title={ffxiPath}>
            <span>{ffxiPath}</span>
            <button onClick={handlePick} title="Choose a different folder">Change</button>
          </div>
        </div>
        <ul className="zone-list">
          {filtered.map(zone => (
            <li key={zone.id}>
              <button
                className={selected?.id === zone.id ? 'active' : ''}
                onClick={() => loadZone(zone)}
              >
                <span className="zone-name">{zone.name}</span>
                <span className="zone-path">{zone.modelPath}</span>
              </button>
            </li>
          ))}
          {filtered.length === 0 && <li className="empty">No zones match “{search}”.</li>}
        </ul>
      </aside>

      <main className="viewport">
        {load.status === 'idle' && (
          <div className="placeholder">
            <h2>Select a zone</h2>
            <p>{ZONES.length} zones available. Pick one from the list to render it.</p>
          </div>
        )}
        {load.status === 'loading' && (
          <div className="placeholder">
            <div className="spinner" />
            <p>{load.message}</p>
          </div>
        )}
        {load.status === 'error' && (
          <div className="placeholder">
            <h2>Could not load {selected?.name}</h2>
            <p className="error-text">{load.message}</p>
          </div>
        )}
        {load.status === 'ready' && (
          <ZoneViewer
            key={selected?.id}
            zoneData={load.zone}
            lighting={lighting}
            post={post}
            scene={scene}
            pointLights={pointLights}
            selectedLightId={selectedLightId}
            placingLight={placingLight}
            onPlaceLight={placeLight}
            inspecting={inspecting}
            onInspectResult={setSurfaceInfo}
          />
        )}

        {load.status === 'ready' && (
          <div className="view-tools">
            <button onClick={() => setUiHidden(h => !h)} title="Hide the panels (F10)">
              {uiHidden ? 'Show panels' : 'Hide panels'}
            </button>
            <button onClick={toggleFullscreen} title="Fullscreen (F11, Esc to exit)">
              {fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            </button>
            <button onClick={takeScreenshot} title="Save a PNG of the view (F12)">
              Screenshot
            </button>
            <button
              className={inspecting ? 'on' : ''}
              onClick={() => { setInspecting(v => !v); setSurfaceInfo(null) }}
              title="Click a surface to see its texture and material"
            >
              {inspecting ? 'Inspecting…' : 'Inspect'}
            </button>
          </div>
        )}

        {toast && <div className="toast">{toast}</div>}

        {inspecting && load.status === 'ready' && !surfaceInfo && (
          <div className="placing-hint">Click any surface to inspect it — Esc to stop</div>
        )}

        {surfaceInfo && (
          <div className="inspector">
            <div className="inspector-head">
              <strong>Surface</strong>
              <button onClick={() => setSurfaceInfo(null)}>×</button>
            </div>
            {surfaceInfo.empty ? (
              <p className="note small">Nothing under the cursor there.</p>
            ) : (
              <dl>
                <dt>Texture name</dt><dd>{surfaceInfo.textureName}</dd>
                <dt>Material index</dt><dd>{surfaceInfo.materialIndex}</dd>
                <dt>Renders as</dt>
                <dd>{surfaceInfo.materialType}{surfaceInfo.hasMap ? ' + map' : ' — NO MAP'}</dd>
                <dt>Blending flag</dt><dd>{surfaceInfo.blending}</dd>
                <dt>Treated as water</dt><dd>{surfaceInfo.classifiedAsWater ? 'yes' : 'no'}</dd>
                {surfaceInfo.texture ? (
                  <>
                    <dt>Texture size</dt><dd>{surfaceInfo.texture.size}</dd>
                    <dt>Average RGB</dt><dd>{surfaceInfo.texture.avg}</dd>
                    <dt>Average alpha</dt><dd>{surfaceInfo.texture.avgAlpha} / 255</dd>
                    <dt>Opaque / clear</dt>
                    <dd>{surfaceInfo.texture.pctOpaque}% / {surfaceInfo.texture.pctTransparent}%</dd>
                  </>
                ) : (
                  <><dt>Texture</dt><dd className="warn">none resolved</dd></>
                )}
                <dt>UV range</dt><dd>{surfaceInfo.uvRange ?? '—'}</dd>
                <dt>Vertex colour</dt><dd>{surfaceInfo.vertexColour ?? '—'}</dd>
                <dt>Vertices</dt><dd>{surfaceInfo.vertexCount}</dd>
                <dt>Distance</dt><dd>{surfaceInfo.distance}</dd>
              </dl>
            )}
          </div>
        )}

        {placingLight && load.status === 'ready' && (
          <div className="placing-hint">
            Click a surface to place a light — Esc to cancel
          </div>
        )}

        {load.status === 'ready' && selected && (
          <div className="hud">
            <strong>{selected.name}</strong>
            <span>
              {load.zone.instances.length.toLocaleString()} objects ·{' '}
              {load.zone.prefabs.length.toLocaleString()} meshes ·{' '}
              {load.zone.textures.length.toLocaleString()} textures
            </span>
          </div>
        )}
      </main>

      <ControlPanel
        lighting={lighting}
        post={post}
        scene={scene}
        pointLights={pointLights}
        selectedLightId={selectedLightId}
        placingLight={placingLight}
        onLighting={patch => setLighting(l => ({ ...l, ...patch }))}
        onPost={patch => setPost(p => ({ ...p, ...patch }))}
        onScene={patch => setScene(s => ({ ...s, ...patch }))}
        onPointLights={patch => setPointLights(s => ({ ...s, ...patch }))}
        onUpdateLight={updateLight}
        onRemoveLight={removeLight}
        onSelectLight={setSelectedLightId}
        onTogglePlacing={() => setPlacingLight(p => !p)}
        onPreset={applyPreset}
        onReset={resetAll}
      />
    </div>
  )
}
