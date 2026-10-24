import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { parseDatFile, parseSystemEffects, parseZoneFile, type ParsedDatFile, type SystemEffects } from '../lib/ffxi-dat'
import { MODELS } from '../lib/modelList'
import { SPELLS, SPELL_SKILLS, SPELL_EFFECT_BASE, type SpellEntry } from '../lib/spellList'
import { fileIdPath } from '../lib/fileTable'
import type { ModelSettings } from '../lib/settings'
import { EffectViewer, type EffectBundle } from './EffectViewer'

/**
 * Models → Effects: pick a spell, and your character casts it on a target.
 * Stage 1 of the spell effect browser (EffectViewer has what it plays).
 */

/** Creature families a spell reads naturally against. */
const TARGET_CATEGORIES = new Set(['Beastmen', 'Beasts', 'Birds', 'Amorphs', 'Aquans', 'Lizards', 'Plantoids', 'Vermin', 'Undead', 'Demons', 'Dragons', 'Arcana', 'Elementals'])
const TARGETS = MODELS.filter(m => TARGET_CATEGORIES.has(m.category))
const DEFAULT_TARGET = TARGETS.find(m => m.name === 'Goblin 1') ?? TARGETS[0]
/** Effect sounds have no slider of their own yet. */
const EFFECT_VOLUME = 0.6

let systemPromise: Promise<SystemEffects | undefined> | null = null

export default function EffectBrowser({ ffxiPath, head, caster, settings, uiHidden }: {
  ffxiPath: string
  /** The view and mode switches, shown at the top of the sidebar. */
  head: ReactNode
  caster: ParsedDatFile | null
  settings: ModelSettings
  uiHidden: boolean
}) {
  const [search, setSearch] = useState('')
  const [skill, setSkill] = useState<string | null>(null)
  const [spell, setSpell] = useState<SpellEntry | null>(null)
  const [effect, setEffect] = useState<EffectBundle | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [playId, setPlayId] = useState(0)
  const [targetPath, setTargetPath] = useState(DEFAULT_TARGET?.path ?? '')
  const [target, setTarget] = useState<ParsedDatFile | null>(null)

  const list = useMemo(() => {
    const q = search.trim().toLowerCase()
    return SPELLS.filter(s => (!skill || s.skill === skill) && (!q || s.name.toLowerCase().includes(q)))
  }, [search, skill])

  useEffect(() => {
    if (!targetPath) return
    let cancelled = false
    window.ffxi.readDat(ffxiPath, targetPath)
      .then(buf => { if (!cancelled) setTarget(parseDatFile(buf)) })
      .catch(() => { if (!cancelled) setTarget(null) })
    return () => { cancelled = true }
  }, [ffxiPath, targetPath])

  const choose = useCallback(async (s: SpellEntry) => {
    setSpell(s)
    setError(null)
    try {
      systemPromise ??= window.ffxi.readDat(ffxiPath, 'ROM/0/0.DAT').then(parseSystemEffects).catch(() => undefined)
      const system = await systemPromise
      const path = await fileIdPath(ffxiPath, SPELL_EFFECT_BASE + s.effect)
      if (!path) throw new Error(`No file for effect ${s.effect}`)
      const zone = parseZoneFile(await window.ffxi.readDat(ffxiPath, path), undefined, undefined, system)
      setEffect({ zone, path })
      setPlayId(n => n + 1)
    } catch (e) {
      setEffect(null)
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [ffxiPath])

  // ?census=1: __playSpell(name) picks a spell by name, as a click would.
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('census')) return
    const w = window as unknown as { __playSpell?: (name: string) => boolean }
    w.__playSpell = (name: string) => {
      const s = SPELLS.find(x => x.name.toLowerCase() === name.toLowerCase())
      if (s) void choose(s)
      return !!s
    }
    return () => { delete w.__playSpell }
  }, [choose])

  return (
    <>
      <aside className="sidebar">
        <div className="sidebar-head">
          {head}
          <input className="search" placeholder="Search spells..." value={search} onChange={e => setSearch(e.target.value)} />
          <select className="category-select" value={skill ?? ''} onChange={e => setSkill(e.target.value || null)}>
            <option value="">All magic ({SPELLS.length})</option>
            {SPELL_SKILLS.map(k => <option key={k} value={k}>{k[0].toUpperCase() + k.slice(1)}</option>)}
          </select>
          <label className="target-pick">
            <span>Target</span>
            <select className="category-select" value={targetPath} onChange={e => setTargetPath(e.target.value)}>
              {TARGETS.map(m => <option key={m.path + m.name} value={m.path}>{m.name}</option>)}
            </select>
          </label>
        </div>
        <ul className="zone-list">
          {list.map(s => (
            <li key={s.id}>
              <button className={spell?.id === s.id ? 'active' : ''} onClick={() => void choose(s)}>
                <span className="zone-name">{s.name}</span>
                <span className="zone-path">{s.skill} · {s.element}</span>
              </button>
            </li>
          ))}
          {list.length === 0 && <li className="empty">No spells match “{search}”.</li>}
        </ul>
      </aside>

      <main className="viewport">
        <EffectViewer caster={caster} target={target} effect={effect} playId={playId} settings={settings} volume={EFFECT_VOLUME} />
        {!uiHidden && (
          <div className="hud">
            <strong>{spell ? spell.name : 'Pick a spell'}</strong>
            <span>
              {error ?? (effect ? `${effect.path} · ${effect.zone.routines?.length ?? 0} routines · ${effect.zone.spawns?.length ?? 0} generators` : 'Your character casts it on the target.')}
            </span>
            {effect && <button className="hud-button" onClick={() => setPlayId(n => n + 1)}>Play again</button>}
          </div>
        )}
      </main>
    </>
  )
}
