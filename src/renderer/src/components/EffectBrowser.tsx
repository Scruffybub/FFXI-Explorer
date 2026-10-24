import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { parseAnimationDat, parseDatFile, parseSystemEffects, parseZoneFile, SKELETON_PATHS, type ParsedDatFile, type ParsedZone, type SystemEffects } from '../lib/ffxi-dat'
import { MODELS } from '../lib/modelList'
import { SPELLS, SPELL_SKILLS, SPELL_EFFECT_BASE, castRoutine, type SpellEntry } from '../lib/spellList'
import { SKILL_CATEGORIES, skillOptions } from '../lib/skillList'
import { fileIdPath } from '../lib/fileTable'
import { loadCastClips, type CastClips } from '../lib/characterModel'
import type { ModelSettings } from '../lib/settings'
import { EffectViewer, type EffectBundle } from './EffectViewer'

/**
 * Models → Effects: pick a spell, a weapon skill or an ability, and your
 * character uses it on a target (EffectViewer has what it plays).
 */

/** Creature families an effect reads naturally against. */
const TARGET_CATEGORIES = new Set(['Beastmen', 'Beasts', 'Birds', 'Amorphs', 'Aquans', 'Lizards', 'Plantoids', 'Vermin', 'Undead', 'Demons', 'Dragons', 'Arcana', 'Elementals'])
const TARGETS = MODELS.filter(m => TARGET_CATEGORIES.has(m.category))
const DEFAULT_TARGET = TARGETS.find(m => m.name === 'Goblin 1') ?? TARGETS[0]
/** Effect sounds have no slider of their own yet. */
const EFFECT_VOLUME = 0.6

let systemPromise: Promise<SystemEffects | undefined> | null = null
/** The shared effects file read as a zone (its routines and generators: casting circles, release bursts), once. */
let sharedPromise: Promise<ParsedZone | null> | null = null
/** Each race's file read as a zone (its cast and release routines), once per race. */
const racePromises = new Map<number, Promise<ParsedZone | null>>()

/** One row of the list: what it is called, where its file is, and whether it is cast. */
interface Entry {
  key: string
  name: string
  detail: string
  /** The effect file: a spell's by number, a skill's by path. */
  file: { id: number } | { path: string }
  /** The race's cast routine for a spell; null for skills, which have none. */
  castRoutine: string | null
}

type Kind = 'magic' | 'skills'

export default function EffectBrowser({ ffxiPath, head, caster, casterRace, settings, uiHidden }: {
  ffxiPath: string
  /** The view and mode switches, shown at the top of the sidebar. */
  head: ReactNode
  caster: ParsedDatFile | null
  /** The caster's race, for its casting motions and its skills. */
  casterRace: number
  settings: ModelSettings
  uiHidden: boolean
}) {
  const [kind, setKind] = useState<Kind>('magic')
  const [search, setSearch] = useState('')
  const [group, setGroup] = useState<string | null>(null)
  const [chosen, setChosen] = useState<Entry | null>(null)
  const [effect, setEffect] = useState<EffectBundle | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [playId, setPlayId] = useState(0)
  const [targetPath, setTargetPath] = useState(DEFAULT_TARGET?.path ?? '')
  const [target, setTarget] = useState<ParsedDatFile | null>(null)
  const [cast, setCast] = useState<CastClips | null>(null)
  useEffect(() => {
    let cancelled = false
    loadCastClips(ffxiPath, casterRace).then(c => { if (!cancelled) setCast(c) }).catch(() => { if (!cancelled) setCast(null) })
    return () => { cancelled = true }
  }, [ffxiPath, casterRace])

  const entries = useMemo<Entry[]>(() => kind === 'magic'
    ? SPELLS.map((s: SpellEntry) => ({
        key: 'spell' + s.id, name: s.name, detail: `${s.skill} · ${s.element}`, file: { id: SPELL_EFFECT_BASE + s.effect }, castRoutine: castRoutine(s),
      }))
    : skillOptions(casterRace).map(s => ({
        key: s.category + '/' + s.name, name: s.name, detail: s.category, file: { path: s.path }, castRoutine: null,
      })),
  [kind, casterRace])
  const groups = kind === 'magic' ? SPELL_SKILLS : SKILL_CATEGORIES.filter(c => entries.some(e => e.detail === c))
  const groupOf = (e: Entry) => kind === 'magic' ? e.detail.split(' · ')[0] : e.detail

  const list = useMemo(() => {
    const q = search.trim().toLowerCase()
    return entries.filter(e => (!group || groupOf(e) === group) && (!q || e.name.toLowerCase().includes(q)))
  // groupOf only reads kind, already a dependency through entries.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, search, group])

  useEffect(() => {
    if (!targetPath) return
    let cancelled = false
    window.ffxi.readDat(ffxiPath, targetPath)
      .then(buf => { if (!cancelled) setTarget(parseDatFile(buf)) })
      .catch(() => { if (!cancelled) setTarget(null) })
    return () => { cancelled = true }
  }, [ffxiPath, targetPath])

  const choose = useCallback(async (e: Entry) => {
    setChosen(e)
    setError(null)
    try {
      systemPromise ??= window.ffxi.readDat(ffxiPath, 'ROM/0/0.DAT').then(parseSystemEffects).catch(() => undefined)
      const system = await systemPromise
      const path = 'path' in e.file ? e.file.path : await fileIdPath(ffxiPath, e.file.id)
      if (!path) throw new Error(`No file for ${e.name}`)
      const buffer = await window.ffxi.readDat(ffxiPath, path)
      const zone = parseZoneFile(buffer, undefined, undefined, system)
      // A weapon skill carries the caster's motions for it.
      let motions: EffectBundle['motions'] = []
      try { motions = parseAnimationDat(buffer) } catch { /* none */ }
      sharedPromise ??= window.ffxi.readDat(ffxiPath, 'ROM/0/0.DAT').then(b => parseZoneFile(b)).catch(() => null)
      const racePath = SKELETON_PATHS[casterRace]
      if (racePath && !racePromises.has(casterRace)) racePromises.set(casterRace, window.ffxi.readDat(ffxiPath, racePath).then(b => parseZoneFile(b, undefined, undefined, system)).catch(() => null))
      const [shared, race] = await Promise.all([sharedPromise, racePromises.get(casterRace) ?? null])
      setEffect({ zone, path, race, shared, castRoutine: e.castRoutine, motions })
      setPlayId(n => n + 1)
    } catch (err) {
      setEffect(null)
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [ffxiPath, casterRace])

  // ?census=1: __playSpell(name) / __playSkill(name) pick one by name, as a click would.
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('census')) return
    const w = window as unknown as { __playSpell?: (name: string) => boolean; __playSkill?: (name: string) => boolean }
    w.__playSpell = (name: string) => {
      const s = SPELLS.find(x => x.name.toLowerCase() === name.toLowerCase())
      if (s) void choose({ key: 'spell' + s.id, name: s.name, detail: s.skill, file: { id: SPELL_EFFECT_BASE + s.effect }, castRoutine: castRoutine(s) })
      return !!s
    }
    w.__playSkill = (name: string) => {
      const s = skillOptions(casterRace).find(x => x.name.toLowerCase() === name.toLowerCase())
      if (s) void choose({ key: s.category + '/' + s.name, name: s.name, detail: s.category, file: { path: s.path }, castRoutine: null })
      return !!s
    }
    return () => { delete w.__playSpell; delete w.__playSkill }
  }, [choose, casterRace])

  const switchKind = (k: Kind) => { setKind(k); setGroup(null); setSearch('') }

  return (
    <>
      <aside className="sidebar">
        <div className="sidebar-head">
          {head}
          <div className="mode-switch">
            <button className={kind === 'magic' ? 'active' : ''} onClick={() => switchKind('magic')}>Magic</button>
            <button className={kind === 'skills' ? 'active' : ''} onClick={() => switchKind('skills')}>Skills</button>
          </div>
          <input className="search" placeholder={kind === 'magic' ? 'Search spells...' : 'Search skills...'} value={search} onChange={e => setSearch(e.target.value)} />
          <select className="category-select" value={group ?? ''} onChange={e => setGroup(e.target.value || null)}>
            <option value="">{kind === 'magic' ? `All magic (${entries.length})` : `All skills (${entries.length})`}</option>
            {groups.map(k => <option key={k} value={k}>{k[0].toUpperCase() + k.slice(1)}</option>)}
          </select>
          <label className="target-pick">
            <span>Target</span>
            <select className="category-select" value={targetPath} onChange={e => setTargetPath(e.target.value)}>
              {TARGETS.map(m => <option key={m.path + m.name} value={m.path}>{m.name}</option>)}
            </select>
          </label>
        </div>
        <ul className="zone-list">
          {list.map(e => (
            <li key={e.key}>
              <button className={chosen?.key === e.key ? 'active' : ''} onClick={() => void choose(e)}>
                <span className="zone-name">{e.name}</span>
                <span className="zone-path">{e.detail}</span>
              </button>
            </li>
          ))}
          {list.length === 0 && <li className="empty">Nothing matches “{search}”.</li>}
        </ul>
      </aside>

      <main className="viewport">
        <EffectViewer caster={caster} cast={cast} target={target} effect={effect} playId={playId} settings={settings} volume={EFFECT_VOLUME} />
        {!uiHidden && (
          <div className="hud">
            <strong>{chosen ? chosen.name : kind === 'magic' ? 'Pick a spell' : 'Pick a skill'}</strong>
            <span>
              {error ?? (effect ? `${effect.path} · ${effect.zone.routines?.length ?? 0} routines · ${effect.zone.spawns?.length ?? 0} generators` : 'Your character uses it on the target.')}
            </span>
            {effect && <button className="hud-button" onClick={() => setPlayId(n => n + 1)}>Play again</button>}
          </div>
        )}
      </main>
    </>
  )
}
