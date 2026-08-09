import { useState, useMemo, useCallback, type ReactNode } from 'react'
import { parseDatFile, hasAnimations, type ParsedDatFile } from '../lib/ffxi-dat'
import { MODELS, MODEL_CATEGORIES, searchModels, type ModelEntry } from '../lib/modelList'
import { ModelViewer, type ModelStats } from './ModelViewer'
import ModelPanel from './ModelPanel'
import { DEFAULT_MODEL, type ModelSettings } from '../lib/settings'
import CharacterBuilder from './CharacterBuilder'
import { RACES, type CharacterSpec, type ComposedCharacter } from '../lib/characterModel'

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
  ffxiPath, viewSwitch, uiHidden, spec, onSpec, character, clipIndex, onClipIndex,
}: {
  ffxiPath: string
  viewSwitch: ReactNode
  uiHidden: boolean
  spec: CharacterSpec
  onSpec: (updater: (s: CharacterSpec) => CharacterSpec) => void
  character: ComposedCharacter | null
  clipIndex: number | null
  onClipIndex: (i: number | null) => void
}) {
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState<string | null>(null)
  const [selected, setSelected] = useState<ModelEntry | null>(null)
  const [load, setLoad] = useState<LoadState>({ status: 'idle' })
  const [stats, setStats] = useState<ModelStats | null>(null)
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useState(1)
  const [settings, setSettings] = useState<ModelSettings>(DEFAULT_MODEL)

  const [mode, setMode] = useState<'browse' | 'character'>('browse')

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

  // Keyed on the outfit so the viewer rebuilds when a piece changes, but not
  // when a lighting slider moves.
  const charKey = useMemo(
    () => `${spec.race}/${spec.face}/${JSON.stringify(spec.equipment)}`,
    [spec],
  )
  const activeModel = mode === 'character'
    ? (character)
    : (load.status === 'ready' ? load.model : null)

  return (
    <>
      <aside className="sidebar">
        <div className="sidebar-head">
          {viewSwitch}
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
          </div>
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
              spec={spec}
              onChange={patch => onSpec(s => ({ ...s, ...patch }))}
              onClear={() => onSpec(s => ({ ...s, equipment: {} }))}
            />
          </div>
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
          {totalMatches > filtered.length && (
            <li className="empty">
              Showing {filtered.length} of {totalMatches}. Narrow the search to see more.
            </li>
          )}
        </ul>
        )}
      </aside>

      <main className="viewport">
        {mode === 'character' ? (
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
                  clipIndex={clipIndex}
                />
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
        </>
        )}
      </main>

      {!uiHidden && (
        <ModelPanel
          settings={settings}
          onChange={patch => setSettings(s => ({ ...s, ...patch }))}
          animations={activeModel?.animations ?? []}
          clipIndex={clipIndex}
          onClipChange={onClipIndex}
          playing={playing}
          onPlayingChange={setPlaying}
          speed={speed}
          onSpeedChange={setSpeed}
        />
      )}
    </>
  )
}
