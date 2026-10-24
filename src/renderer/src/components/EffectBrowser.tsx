import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { parseAnimationDat, parseDatFile, parseSystemEffects, parseZoneFile, SKELETON_PATHS, type ParsedAnimation, type ParsedDatFile, type ParsedZone, type SystemEffects } from '../lib/ffxi-dat'
import { MODELS } from '../lib/modelList'
import { SPELLS, SPELL_SKILLS, SPELL_EFFECT_BASE, castRoutine } from '../lib/spellList'
import { JOB_ABILITIES, MONSTER_MOVES, SKILL_CATEGORIES, abilityFileId, monsterMoveFileId, movesForCreature, skillOptions } from '../lib/skillList'
import { fileIdPath } from '../lib/fileTable'
import { clipsForMotion } from '../lib/motions'
import { loadCastClips, type CastClips } from '../lib/characterModel'
import type { ModelSettings } from '../lib/settings'
import { EffectViewer, type EffectBundle } from './EffectViewer'

/**
 * Models → Effects: pick a spell, a weapon skill or ability, or a monster's
 * move, and see it used (EffectViewer has what it plays). Spells and skills
 * are your character's, used on a monster; a monster move is the picked
 * monster's, used on your character.
 */

/** Creature families: targets for your character, and the users of monster moves. */
const CREATURE_CATEGORIES = new Set(['Beastmen', 'Beasts', 'Birds', 'Amorphs', 'Aquans', 'Lizards', 'Plantoids', 'Vermin', 'Undead', 'Demons', 'Dragons', 'Arcana', 'Elementals'])
const CREATURES = MODELS.filter(m => CREATURE_CATEGORIES.has(m.category))
// A full monster file (ROM/6/1): mesh, skeleton, its fighting motions and
// routines. Some catalogue entries (Goblin 1, ROM/3/59) are light models with
// only a walk and an idle, and their moves play without motions.
const DEFAULT_CREATURE = CREATURES.find(m => m.name === 'Goblin 12') ?? CREATURES[0]
/** Effect sounds have no slider of their own yet. */
const EFFECT_VOLUME = 0.6
const NONE: ParsedAnimation[] = []

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
  /** The list's grouping: magic skill, weapon type or job, or none. */
  group: string
  /** The effect file: by number, or a skill's by path. */
  file: { id: number } | { path: string }
  /** The race's cast routine for a spell; null for the rest, which have none. */
  castRoutine: string | null
  /** A monster move's id, for matching it to a creature's family. */
  moveId?: number
}

type Kind = 'magic' | 'skills' | 'monster'

const spellEntries: Entry[] = SPELLS.map(s => ({
  key: 'spell' + s.id, name: s.name, detail: `${s.skill} · ${s.element}`, group: s.skill,
  file: { id: SPELL_EFFECT_BASE + s.effect }, castRoutine: castRoutine(s),
}))
const abilityEntries: Entry[] = JOB_ABILITIES.map(a => ({
  key: 'ability' + a.id, name: a.name, detail: `${a.job} ability`, group: a.job ?? '',
  file: { id: abilityFileId(a) }, castRoutine: null,
}))
const moveEntries: Entry[] = MONSTER_MOVES.map(m => ({
  key: 'move' + m.id, name: m.name, detail: 'monster move', group: '',
  file: { id: monsterMoveFileId(m) }, castRoutine: null, moveId: m.id,
}))

export default function EffectBrowser({ ffxiPath, head, caster, casterRace, settings, uiHidden }: {
  ffxiPath: string
  /** The view and mode switches, shown at the top of the sidebar. */
  head: ReactNode
  /** Your character, from the Character tab. */
  caster: ParsedDatFile | null
  /** Its race, for its casting motions and its skills. */
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
  const [creaturePath, setCreaturePath] = useState(DEFAULT_CREATURE?.path ?? '')
  const [creature, setCreature] = useState<ParsedDatFile | null>(null)
  const [cast, setCast] = useState<CastClips | null>(null)
  /** Monster moves whose effect file exists in this install (about 84%). */
  const [movesHere, setMovesHere] = useState<Set<string> | null>(null)
  /** Monster moves: only the picked creature's family's (LandSandBoat mob_skill_lists). */
  const [ownMoves, setOwnMoves] = useState(true)
  const creatureName = CREATURES.find(m => m.path === creaturePath)?.name ?? ''
  const family = useMemo(() => movesForCreature(creatureName), [creatureName])
  useEffect(() => {
    let cancelled = false
    loadCastClips(ffxiPath, casterRace).then(c => { if (!cancelled) setCast(c) }).catch(() => { if (!cancelled) setCast(null) })
    return () => { cancelled = true }
  }, [ffxiPath, casterRace])
  useEffect(() => {
    if (kind !== 'monster' || movesHere) return
    let cancelled = false
    Promise.all(moveEntries.map(async e => ((await fileIdPath(ffxiPath, (e.file as { id: number }).id)) ? e.key : null)))
      .then(keys => { if (!cancelled) setMovesHere(new Set(keys.filter((k): k is string => !!k))) })
      .catch(() => { if (!cancelled) setMovesHere(new Set()) })
    return () => { cancelled = true }
  }, [kind, movesHere, ffxiPath])

  const entries = useMemo<Entry[]>(() => {
    if (kind === 'magic') return spellEntries
    if (kind === 'monster') {
      if (!movesHere) return []
      const here = moveEntries.filter(e => movesHere.has(e.key))
      return ownMoves && family ? here.filter(e => e.moveId !== undefined && family.ids.has(e.moveId)) : here
    }
    // Weapon skills and the race's few listed abilities, then every job ability.
    const listed = skillOptions(casterRace).map(s => ({
      key: s.category + '/' + s.name, name: s.name, detail: s.category, group: s.category, file: { path: s.path }, castRoutine: null,
    }))
    const names = new Set(listed.map(e => e.name.toLowerCase()))
    return [...listed, ...abilityEntries.filter(e => !names.has(e.name.toLowerCase()))]
  }, [kind, casterRace, movesHere, ownMoves, family])
  const groups = kind === 'magic' ? SPELL_SKILLS
    : kind === 'skills' ? [...SKILL_CATEGORIES, ...new Set(abilityEntries.map(e => e.group))].filter(g => entries.some(e => e.group === g))
    : []

  const list = useMemo(() => {
    const q = search.trim().toLowerCase()
    return entries.filter(e => (!group || e.group === group) && (!q || e.name.toLowerCase().includes(q)))
  }, [entries, search, group])

  useEffect(() => {
    if (!creaturePath) return
    let cancelled = false
    window.ffxi.readDat(ffxiPath, creaturePath)
      .then(buf => { if (!cancelled) setCreature(parseDatFile(buf)) })
      .catch(() => { if (!cancelled) setCreature(null) })
    return () => { cancelled = true }
  }, [ffxiPath, creaturePath])

  const choose = useCallback(async (e: Entry, as: Kind) => {
    setChosen(e)
    setError(null)
    try {
      systemPromise ??= window.ffxi.readDat(ffxiPath, 'ROM/0/0.DAT').then(parseSystemEffects).catch(() => undefined)
      const system = await systemPromise
      const path = 'path' in e.file ? e.file.path : await fileIdPath(ffxiPath, e.file.id)
      if (!path) throw new Error(`No effect file for ${e.name} in this install`)
      const buffer = await window.ffxi.readDat(ffxiPath, path)
      const zone = parseZoneFile(buffer, undefined, undefined, system)
      // A weapon skill carries the caster's motions for it.
      let motions: ParsedAnimation[] = []
      try { motions = parseAnimationDat(buffer) } catch { /* none */ }
      sharedPromise ??= window.ffxi.readDat(ffxiPath, 'ROM/0/0.DAT').then(b => parseZoneFile(b)).catch(() => null)
      // The user's own file, for the routines its scripts call: a player's
      // race file, or the monster's model.
      let own: Promise<ParsedZone | null>
      if (as === 'monster') {
        own = window.ffxi.readDat(ffxiPath, creaturePath).then(b => parseZoneFile(b, undefined, undefined, system)).catch(() => null)
      } else {
        const racePath = SKELETON_PATHS[casterRace]
        if (racePath && !racePromises.has(casterRace)) racePromises.set(casterRace, window.ffxi.readDat(ffxiPath, racePath).then(b => parseZoneFile(b, undefined, undefined, system)).catch(() => null))
        own = racePromises.get(casterRace) ?? Promise.resolve(null)
      }
      const [shared, race] = await Promise.all([sharedPromise, own])
      setEffect({ zone, path, race, shared, castRoutine: e.castRoutine, motions })
      setPlayId(n => n + 1)
    } catch (err) {
      setEffect(null)
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [ffxiPath, casterRace, creaturePath])

  // ?census=1: __playSpell / __playSkill / __playMove(name) pick one by name, as a click would.
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('census')) return
    const w = window as unknown as Record<string, unknown>
    const by = (list: Entry[], as: Kind) => (name: string) => {
      const e = list.find(x => x.name.toLowerCase() === name.toLowerCase())
      if (e) { setKind(as); void choose(e, as) }
      return !!e
    }
    w.__playSpell = by(spellEntries, 'magic')
    w.__playSkill = by([...skillOptions(casterRace).map(s => ({ key: s.category + '/' + s.name, name: s.name, detail: s.category, group: s.category, file: { path: s.path }, castRoutine: null })), ...abilityEntries], 'skills')
    w.__playMove = by(moveEntries, 'monster')
    return () => { delete w.__playSpell; delete w.__playSkill; delete w.__playMove }
  }, [choose, casterRace])

  const switchKind = (k: Kind) => { setKind(k); setGroup(null); setSearch('') }
  const monster = kind === 'monster'
  // Who stands where: your character uses spells and skills on the creature;
  // the creature uses its moves on your character.
  const creatureIdle = useMemo(() => (creature ? clipsForMotion(creature.animations, null) : NONE), [creature])
  const user = monster ? creature : caster
  const userIdle = monster ? creatureIdle : (cast?.idle ?? NONE)
  const userMotions = monster ? (creature?.animations ?? NONE) : (cast?.motions ?? NONE)
  const target = monster ? caster : creature
  const targetIdle = monster ? (cast?.idle ?? NONE) : creatureIdle

  return (
    <>
      <aside className="sidebar">
        <div className="sidebar-head">
          {head}
          <div className="mode-switch">
            <button className={kind === 'magic' ? 'active' : ''} onClick={() => switchKind('magic')}>Magic</button>
            <button className={kind === 'skills' ? 'active' : ''} onClick={() => switchKind('skills')}>Skills</button>
            <button className={kind === 'monster' ? 'active' : ''} onClick={() => switchKind('monster')}>Monster</button>
          </div>
          <input className="search" placeholder={kind === 'magic' ? 'Search spells...' : kind === 'skills' ? 'Search skills...' : 'Search moves...'} value={search} onChange={e => setSearch(e.target.value)} />
          {groups.length > 0 && (
            <select className="category-select" value={group ?? ''} onChange={e => setGroup(e.target.value || null)}>
              <option value="">All ({entries.length})</option>
              {groups.map(k => <option key={k} value={k}>{k[0].toUpperCase() + k.slice(1)}</option>)}
            </select>
          )}
          {monster && (
            <label className="toggle-row">
              <input type="checkbox" checked={ownMoves} onChange={e => setOwnMoves(e.target.checked)} />
              <span>{family ? `Only ${family.family}'s moves` : 'No move list for this creature: all moves'}</span>
            </label>
          )}
          <label className="target-pick">
            <span>{monster ? 'User' : 'Target'}</span>
            <select className="category-select" value={creaturePath} onChange={e => setCreaturePath(e.target.value)}>
              {CREATURES.map(m => <option key={m.path + m.name} value={m.path}>{m.name}</option>)}
            </select>
          </label>
        </div>
        <ul className="zone-list">
          {list.map(e => (
            <li key={e.key}>
              <button className={chosen?.key === e.key ? 'active' : ''} onClick={() => void choose(e, kind)}>
                <span className="zone-name">{e.name}</span>
                <span className="zone-path">{e.detail}</span>
              </button>
            </li>
          ))}
          {monster && !movesHere && <li className="empty">Finding the moves this install has…</li>}
          {list.length === 0 && (!monster || movesHere) && <li className="empty">Nothing matches “{search}”.</li>}
        </ul>
      </aside>

      <main className="viewport">
        <EffectViewer
          caster={user} casterIdle={userIdle} casterMotions={userMotions}
          target={target} targetIdle={targetIdle}
          effect={effect} playId={playId} settings={settings} volume={EFFECT_VOLUME}
        />
        {!uiHidden && (
          <div className="hud">
            <strong>{chosen ? chosen.name : kind === 'magic' ? 'Pick a spell' : kind === 'skills' ? 'Pick a skill' : 'Pick a move'}</strong>
            <span>
              {error ?? (effect ? `${effect.path} · ${effect.zone.routines?.length ?? 0} routines · ${effect.zone.spawns?.length ?? 0} generators`
                : monster ? 'The monster uses it on your character.' : 'Your character uses it on the target.')}
              {monster && creature && creature.animations.length < 5 && ' · This model has no fighting motions: try another variant of it.'}
            </span>
            {effect && <button className="hud-button" onClick={() => setPlayId(n => n + 1)}>Play again</button>}
          </div>
        )}
      </main>
    </>
  )
}
