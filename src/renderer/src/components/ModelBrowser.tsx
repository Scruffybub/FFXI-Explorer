import { useState, useMemo, useCallback, type ReactNode } from 'react'
import { parseDatFile, hasAnimations, type ParsedDatFile } from '../lib/ffxi-dat'
import { MODELS, MODEL_CATEGORIES, searchModels, type ModelEntry } from '../lib/modelList'
import { ModelViewer, type ModelStats } from './ModelViewer'
import ModelPanel from './ModelPanel'
import { DEFAULT_MODEL, type ModelSettings } from '../lib/settings'

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
  ffxiPath, viewSwitch, uiHidden,
}: {
  ffxiPath: string
  viewSwitch: ReactNode
  uiHidden: boolean
}) {
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState<string | null>(null)
  const [selected, setSelected] = useState<ModelEntry | null>(null)
  const [load, setLoad] = useState<LoadState>({ status: 'idle' })
  const [stats, setStats] = useState<ModelStats | null>(null)
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useState(1)
  const [clipIndex, setClipIndex] = useState<number | null>(null)
  const [settings, setSettings] = useState<ModelSettings>(DEFAULT_MODEL)

  const filtered = useMemo(
    () => searchModels(search, category).slice(0, 400),
    [search, category],
  )
  const totalMatches = useMemo(
    () => searchModels(search, category).length,
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

  const onStats = useCallback((s: ModelStats | null) => setStats(s), [])

  return (
    <>
      <aside className="sidebar">
        <div className="sidebar-head">
          {viewSwitch}
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
        </div>
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
          {totalMatches > filtered.length && (
            <li className="empty">
              Showing {filtered.length} of {totalMatches}. Narrow the search to see more.
            </li>
          )}
        </ul>
      </aside>

      <main className="viewport">
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
              clipIndex={clipIndex}
            />
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
      </main>

      {!uiHidden && (
        <ModelPanel
          settings={settings}
          onChange={patch => setSettings(s => ({ ...s, ...patch }))}
          animations={load.status === 'ready' ? load.model.animations : []}
          clipIndex={clipIndex}
          onClipChange={setClipIndex}
          playing={playing}
          onPlayingChange={setPlaying}
          speed={speed}
          onSpeedChange={setSpeed}
        />
      )}
    </>
  )
}
