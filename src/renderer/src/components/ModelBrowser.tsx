import { useState, useMemo, useCallback, useEffect, type ReactNode, useRef } from 'react'
import { parseDatFile, hasAnimations, type ParsedDatFile } from '../lib/ffxi-dat'
import { MODELS, MODEL_CATEGORIES, searchModels, type ModelEntry } from '../lib/modelList'
import { ModelViewer, type ModelStats } from './ModelViewer'
import ModelPanel from './ModelPanel'
import { DEFAULT_MODEL, type ModelSettings } from '../lib/settings'
import CharacterBuilder from './CharacterBuilder'
import { RACES, type CharacterSpec, type ComposedCharacter } from '../lib/characterModel'
import MapViewer from './MapViewer'
import { ZONES, type ZoneEntry } from '../lib/zoneList'
import EffectBrowser from './EffectBrowser'
import SoundBrowser from './SoundBrowser'
import CutsceneBrowser from './CutsceneBrowser'
import { exportGlb } from '../lib/gltfExport'
import { motionsOf } from '../lib/motions'
import { invertRigidMatrix4, poseSkeleton } from '../lib/skinning'
import * as THREE from 'three'

/**
 * The model viewer half of the app: its own sidebar and its own viewport,
 * swapped in wholesale when the view switch is flipped.
 *
 * Kept separate from the zone side rather than bolted onto it — the two share
 * almost nothing. No install-path handling lives here; it is passed in, because
 * the zone side already owns detection and the folder picker.
 */
type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; model: ParsedDatFile; animated: boolean }
  | { status: 'error'; message: string }

export default function ModelBrowser({
  ffxiPath, viewSwitch, uiHidden, spec, onSpec, character, motion, onMotion,
}: {
  ffxiPath: string
  viewSwitch: ReactNode
  uiHidden: boolean
  spec: CharacterSpec
  onSpec: (updater: (s: CharacterSpec) => CharacterSpec) => void
  character: ComposedCharacter | null
  motion: string | null
  onMotion: (key: string | null) => void
}) {
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState<string | null>(null)
  const [selected, setSelected] = useState<ModelEntry | null>(null)
  const [load, setLoad] = useState<LoadState>({ status: 'idle' })
  const [stats, setStats] = useState<ModelStats | null>(null)
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useState(1)
  // Models -> Frame: where the motion is (read ten times a second, not every
  // frame, so the panel does not re-render at the frame rate) and a jump to make.
  const [frame, setFrame] = useState<{ frame: number; total: number } | null>(null)
  const [seek, setSeek] = useState<{ frame: number; id: number } | null>(null)
  const lastFrame = useRef(0)
  const onFrame = useCallback((f: number, total: number) => {
    const now = performance.now()
    if (now - lastFrame.current < 100) return
    lastFrame.current = now
    setFrame(prev => (prev && Math.floor(prev.frame) === Math.floor(f) && prev.total === total ? prev : { frame: f, total }))
  }, [])
  const onSeek = useCallback((f: number) => {
    setPlaying(false)
    setSeek(s => ({ frame: f, id: (s?.id ?? 0) + 1 }))
    setFrame(prev => (prev ? { ...prev, frame: f } : prev))
  }, [])
  const [settings, setSettings] = useState<ModelSettings>(DEFAULT_MODEL)

  const [mode, setMode] = useState<'browse' | 'character' | 'maps' | 'effects' | 'sounds' | 'cutscenes'>('browse')

  // Models -> Export glTF (lib/gltfExport): the model on screen, rigged, with its motions.
  const [exporting, setExporting] = useState(false)
  const [exportNote, setExportNote] = useState<string | null>(null)
  const exportModel = useCallback(async (model: ParsedDatFile, name: string) => {
    setExporting(true)
    setExportNote(null)
    try {
      const glb = await exportGlb(model, name)
      const file = name.replace(/[^\w' -]+/g, '').trim().replace(/\s+/g, '-') || 'model'
      const saved = await window.ffxi.saveFile(glb, file + '.glb', 'glTF model', 'glb')
      if (saved) setExportNote('Saved ' + saved.split(/[\\/]/).pop())
    } catch (err) {
      setExportNote('Export failed: ' + String(err))
    } finally {
      setExporting(false)
    }
  }, [])

  // ?census=1: export what is on screen and read it back as a glTF loader would (no save dialog).
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('census')) return
    const model = mode === 'character' ? character : load.status === 'ready' ? load.model : null
    ;(window as unknown as Record<string, unknown>).__gltfCheck = async (motionName?: string, at = 0.4) => {
      if (!model) return null
      const glb = await exportGlb(model, 'check')
      const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js')
      const gltf = await new GLTFLoader().parseAsync(glb, '')
      // A motion played in the file against the viewer's own pose: each bone's
      // world position, the file's upright, the viewer's Y-down turned over.
      if (motionName && model.skeleton) {
        const clip = gltf.animations.find(c => c.name === motionName)
        const motion = motionsOf(model.animations).find(m => m.label === motionName || m.key === motionName)
        if (!clip || !motion) return { error: 'no motion ' + motionName }
        const mixer = new THREE.AnimationMixer(gltf.scene)
        mixer.clipAction(clip).play()
        mixer.setTime(at)
        gltf.scene.updateMatrixWorld(true)
        const ib = model.skeleton.matrices.map(invertRigidMatrix4)
        const pose = poseSkeleton(model.skeleton, motion.clips, ib, at).worldMats
        let worst = 0, found = 0, moved = 0
        const p = new THREE.Vector3()
        pose.forEach((m, i) => {
          const bone = gltf.scene.getObjectByName('bone_' + i)
          if (!bone) return
          found++
          bone.getWorldPosition(p)
          if (Math.hypot(m[12] - model.skeleton!.matrices[i][12], m[13] - model.skeleton!.matrices[i][13], m[14] - model.skeleton!.matrices[i][14]) > 0.01) moved++
          worst = Math.max(worst, Math.hypot(p.x - m[12], p.y + m[13], p.z + m[14]))
        })
        // ?census: the file itself drawn in this pose, as an image, to see the skin bend.
        // The page's security policy stops the loader decoding the file's images
        // (blob URLs); decode them here instead, as glTF says (row 0 at v = 0).
        const bin = new Uint8Array(glb, 20 + new DataView(glb).getUint32(12, true) + 8)
        const doc = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, new DataView(glb).getUint32(12, true))))
        const images = await Promise.all(doc.images.map(async (im: { bufferView: number }) => {
          const bv = doc.bufferViews[im.bufferView]
          const tex = new THREE.Texture(await createImageBitmap(new Blob([bin.slice(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength)]), { premultiplyAlpha: "none" }))
          tex.flipY = false; tex.colorSpace = THREE.SRGBColorSpace; tex.needsUpdate = true
          return tex
        }))
        gltf.scene.traverse(o => {
          const mesh = o as THREE.Mesh
          if (!mesh.isMesh) return
          const mat = mesh.material as THREE.MeshStandardMaterial
          const index = gltf.parser.associations.get(mat)?.materials
          const t = index !== undefined ? doc.materials[index]?.pbrMetallicRoughness?.baseColorTexture?.index : undefined
          if (t !== undefined) { mat.map = images[doc.textures[t].source]; mat.needsUpdate = true }
        })
        const canvas = document.createElement('canvas')
        canvas.width = 480; canvas.height = 480
        const r = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true })
        const view = new THREE.Scene()
        view.background = new THREE.Color('#26303f')
        view.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.5), gltf.scene)
        const box = new THREE.Box3().setFromObject(gltf.scene), c = box.getCenter(new THREE.Vector3()), h = box.getSize(new THREE.Vector3()).length()
        const cam = new THREE.PerspectiveCamera(35, 1, 0.01, 100)
        cam.position.set(c.x + h * 0.9, c.y + h * 0.3, c.z + h * 1.4)
        cam.lookAt(c)
        r.render(view, cam)
        const image = canvas.toDataURL('image/png')
        r.dispose()
        return { motion: motionName, at, bones: pose.length, found, movedFromRest: moved, worstBoneOffset: +worst.toFixed(4), image }
      }
      let skinned = 0, meshes = 0, bones = 0
      gltf.scene.traverse(o => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned++; if ((o as THREE.Mesh).isMesh) meshes++; if ((o as THREE.Bone).isBone) bones++ })
      const json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, new DataView(glb).getUint32(12, true))))
      let mapped = 0
      gltf.scene.traverse(o => { const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined; if (m?.map?.image) mapped++ })
      const box = new THREE.Box3().setFromObject(gltf.scene)
      return { images: json.images?.length ?? 0, textures: json.textures?.length ?? 0, materials: json.materials?.map((m: { alphaMode?: string; pbrMetallicRoughness?: { baseColorTexture?: unknown } }) => (m.pbrMetallicRoughness?.baseColorTexture ? 'tex' : 'none') + '/' + (m.alphaMode ?? 'OPAQUE')), loadedWithMap: mapped, bytes: glb.byteLength, meshes, skinned, bones, animations: gltf.animations.map(a => a.name + ':' + a.duration.toFixed(2)), size: box.getSize(new THREE.Vector3()).toArray().map(v => +v.toFixed(2)), min: box.min.toArray().map(v => +v.toFixed(2)) }
    }
  }, [mode, character, load])

  // Only zones the table actually lists map pages for; 'unknown' rows and a
  // handful of instanced areas carry none.
  const [mapZone, setMapZone] = useState<ZoneEntry | null>(null)
  const [mapSearch, setMapSearch] = useState('')
  const mapZones = useMemo(() => ZONES.filter(z => z.mapPaths.length > 0), [])
  const mapZonesFiltered = useMemo(() => {
    const q = mapSearch.trim().toLowerCase()
    return q ? mapZones.filter(z => z.name.toLowerCase().includes(q)) : mapZones
  }, [mapZones, mapSearch])

  const filtered = useMemo(
    // The whole list: 2,467 rows draw quickly, and a cap at 400 hid most
    // models unless you searched for them.
    () => searchModels(search, category),
    [search, category],
  )

  const loadModel = useCallback(async (entry: ModelEntry) => {
    setSelected(entry)
    setLoad({ status: 'loading' })
    setStats(null)
    try {
      const buffer = await window.ffxi.readDat(ffxiPath, entry.path)
      const parsed = parseDatFile(buffer)
      if (parsed.meshes.length === 0) {
        setLoad({
          status: 'error',
          message: 'That DAT parsed, but holds no mesh blocks. It may be a placeholder entry.',
        })
        return
      }
      setLoad({ status: 'ready', model: parsed, animated: hasAnimations(buffer) })
    } catch (err) {
      setLoad({ status: 'error', message: String(err) })
    }
  }, [ffxiPath])

  // ?census=1: window.__loadModel(i) opens MODELS[i], __modelStatus() reports
  // the load, for the model sweep (one thumbnail per model).
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('census')) return
    const w = window as unknown as { __loadModel?: (i: number) => void }
    w.__loadModel = (i: number) => { void loadModel(MODELS[i]) }
    return () => { delete w.__loadModel }
  }, [loadModel])
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('census')) return
    ;(window as unknown as { __modelStatus?: () => string }).__modelStatus = () =>
      load.status === 'error' ? 'error: ' + load.message : load.status
  }, [load])

  const onStats = useCallback((s: ModelStats | null) => setStats(s), [])

  // Keyed on the outfit so the viewer rebuilds when a piece changes, but not
  // when a lighting slider moves.
  const charKey = useMemo(
    () => `${spec.race}/${spec.face}/${JSON.stringify(spec.equipment)}`,
    [spec],
  )
  const activeModel = mode === 'character'
    ? (character)
    : (load.status === 'ready' ? load.model : null)

  const modeSwitch = (
          <div className="mode-switch">
            <button
              className={mode === 'browse' ? 'active' : ''}
              onClick={() => setMode('browse')}
            >
              Browse
            </button>
            <button
              className={mode === 'character' ? 'active' : ''}
              onClick={() => setMode('character')}
            >
              Character
            </button>
            <button
              className={mode === 'maps' ? 'active' : ''}
              onClick={() => setMode('maps')}
            >
              Maps
            </button>
            <button
              className={mode === 'effects' ? 'active' : ''}
              onClick={() => setMode('effects')}
            >
              Effects
            </button>
            <button
              className={mode === 'sounds' ? 'active' : ''}
              onClick={() => setMode('sounds')}
            >
              Sounds
            </button>
            <button
              className={mode === 'cutscenes' ? 'active' : ''}
              onClick={() => setMode('cutscenes')}
            >
              Cutscenes
            </button>
          </div>
  )

  if (mode === 'cutscenes') {
    return <CutsceneBrowser ffxiPath={ffxiPath} head={<>{viewSwitch}{modeSwitch}</>} />
  }

  if (mode === 'sounds') {
    return <SoundBrowser ffxiPath={ffxiPath} head={<>{viewSwitch}{modeSwitch}</>} />
  }

  if (mode === 'effects') {
    return (
      <>
        <EffectBrowser
          ffxiPath={ffxiPath}
          head={<>{viewSwitch}{modeSwitch}</>}
          caster={character}
          casterRace={spec.race}
          settings={settings}
          uiHidden={uiHidden}
        />
        {!uiHidden && (
          <ModelPanel
            settings={settings}
            onChange={patch => setSettings(s => ({ ...s, ...patch }))}
            animations={[]}
            motion={null}
            onMotionChange={() => {}}
            playing={playing}
            onPlayingChange={setPlaying}
            speed={speed}
            onSpeedChange={setSpeed}
          />
        )}
      </>
    )
  }

  return (
    <>
      <aside className="sidebar">
        <div className="sidebar-head">
          {viewSwitch}
          {modeSwitch}
          {mode === 'maps' && (
            <input
              className="search"
              placeholder="Search zones..."
              value={mapSearch}
              onChange={e => setMapSearch(e.target.value)}
            />
          )}
          {mode === 'browse' && (
            <>
              <input
                className="search"
                placeholder="Search models..."
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
              <select
                className="category-select"
                value={category ?? ''}
                onChange={e => setCategory(e.target.value || null)}
              >
                <option value="">All categories ({MODELS.length})</option>
                {MODEL_CATEGORIES.map(c => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </>
          )}
        </div>

        {mode === 'character' && (
          <div className="builder-scroll">
            <CharacterBuilder
              ffxiPath={ffxiPath}
              spec={spec}
              onChange={patch => onSpec(s => ({ ...s, ...patch }))}
              onClear={() => onSpec(s => ({ ...s, equipment: {} }))}
            />
          </div>
        )}

        {mode === 'maps' && (
          <ul className="zone-list">
            {mapZonesFiltered.map(z => (
              <li key={z.id}>
                <button
                  className={mapZone?.id === z.id ? 'active' : ''}
                  onClick={() => setMapZone(z)}
                >
                  <span className="zone-name">{z.name}</span>
                  <span className="zone-meta">
                    <span className="zone-path">
                      {z.mapPaths.length} page{z.mapPaths.length === 1 ? '' : 's'}
                    </span>
                    <span className="zone-expansion">{z.id}</span>
                  </span>
                </button>
              </li>
            ))}
            {mapZonesFiltered.length === 0 && (
              <li className="empty">No zones match “{mapSearch}”.</li>
            )}
          </ul>
        )}

        {mode === 'browse' && (
        <ul className="zone-list">
          {filtered.map(m => (
            <li key={`${m.category}/${m.name}/${m.path}`}>
              <button
                className={selected?.path === m.path && selected?.name === m.name ? 'active' : ''}
                onClick={() => loadModel(m)}
              >
                <span className="zone-name">{m.name}</span>
                <span className="zone-path">{m.category} · {m.path}</span>
              </button>
            </li>
          ))}
          {filtered.length === 0 && (
            <li className="empty">No models match “{search}”.</li>
          )}
        </ul>
        )}
      </aside>

      <main className="viewport">
        {mode === 'maps' ? (
          <MapViewer ffxiPath={ffxiPath} zone={mapZone} uiHidden={uiHidden} />
        ) : mode === 'character' ? (
          <>
            {character === null && (
              <div className="placeholder">
                <div className="spinner" />
                <p>Assembling character...</p>
              </div>
            )}
            {false && (
              <div className="placeholder">
                <h2>Could not build the character</h2>
                <p className="error-text">{''}</p>
              </div>
            )}
            {character !== null && character.meshes.length === 0 && (
              <div className="placeholder">
                <h2>Nothing to show</h2>
                <p>Pick a face or an equipment piece to start building.</p>
              </div>
            )}
            {character !== null && character.meshes.length > 0 && (
              <>
                <ModelViewer
                  // Rebuild only when the outfit changes, not on every setting.
                  key={charKey}
                  model={character}
                  settings={settings}
                  onStats={onStats}
                  playing={playing}
                  speed={speed}
                  motion={motion}
                  onFrame={onFrame}
                  seek={seek}
                />
                {!uiHidden && (
                  <ExportButton
                    busy={exporting} note={exportNote}
                    onExport={() => void exportModel(character, RACES.find(r => r.id === spec.race)?.name ?? 'Character')}
                  />
                )}
                {!uiHidden && (
                  <div className="hud">
                    <strong>
                      {RACES.find(r => r.id === spec.race)?.name}
                    </strong>
                    {stats && (
                      <span>
                        {stats.triangles.toLocaleString()} triangles · {stats.meshes} meshes ·{' '}
                        {character.loaded.length} piece
                        {character.loaded.length === 1 ? '' : 's'}
                        {character.failed.length > 0
                          ? ` · failed: ${character.failed.map(f => f.label).join(', ')}`
                          : ''}
                      </span>
                    )}
                  </div>
                )}
              </>
            )}
          </>
        ) : (
        <>
        {load.status === 'idle' && (
          <div className="placeholder">
            <h2>Select a model</h2>
            <p>{MODELS.length} NPC, monster and object models available.</p>
          </div>
        )}
        {load.status === 'loading' && (
          <div className="placeholder">
            <div className="spinner" />
            <p>Loading {selected?.name}...</p>
          </div>
        )}
        {load.status === 'error' && (
          <div className="placeholder">
            <h2>Could not load {selected?.name}</h2>
            <p className="error-text">{load.message}</p>
          </div>
        )}
        {load.status === 'ready' && (
          <>
            <ModelViewer
              key={`${selected?.path}/${selected?.name}`}
              model={load.model}
              settings={settings}
              onStats={onStats}
              playing={playing}
              speed={speed}
              motion={motion}
              onFrame={onFrame}
              seek={seek}
            />
            {!uiHidden && (
              <ExportButton
                busy={exporting} note={exportNote}
                onExport={() => void exportModel(load.model, selected?.name ?? 'Model')}
              />
            )}
            {!uiHidden && (
              <div className="hud">
                <strong>{selected?.name}</strong>
                {stats && (
                  <span>
                    {stats.triangles.toLocaleString()} triangles · {stats.meshes} meshes ·{' '}
                    {stats.textures} textures
                    {stats.hasSkeleton ? ` · ${stats.bones} bones` : ' · no skeleton'}
                    {stats.animations > 0
                      ? ` · ${stats.animations} anim clip${stats.animations > 1 ? 's' : ''}`
                      : ''}
                  </span>
                )}
              </div>
            )}
          </>
        )}
        </>
        )}
      </main>

      {/* The model panel is lighting and animation, neither of which means
          anything for a flat map plate, so maps mode leaves it out. */}
      {!uiHidden && mode !== 'maps' && (
        <ModelPanel
          settings={settings}
          onChange={patch => setSettings(s => ({ ...s, ...patch }))}
          animations={activeModel?.animations ?? []}
          motion={motion}
          onMotionChange={onMotion}
          playing={playing}
          onPlayingChange={setPlaying}
          speed={speed}
          onSpeedChange={setSpeed}
          frame={frame}
          onSeek={onSeek}
        />
      )}
    </>
  )
}

/**
 * Export glTF, top right of the model view like the zone view's tools. The
 * note under it says where the file went, or why it did not.
 */
function ExportButton({ busy, note, onExport }: { busy: boolean; note: string | null; onExport: () => void }) {
  return (
    <div className="view-tools model-tools">
      <button
        onClick={onExport}
        disabled={busy}
        title="Save this model as a .glb file (glTF) for Blender and other 3D tools: rigged to its skeleton, with every motion it has, textures included. It is Square Enix's artwork from your own game, for your own use."
      >
        {busy ? 'Exporting…' : 'Export glTF'}
      </button>
      {note && <span className="model-tools-note">{note}</span>}
    </div>
  )
}
