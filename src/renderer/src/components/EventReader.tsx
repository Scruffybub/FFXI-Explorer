import { useEffect, useMemo, useState } from 'react'
import type { ZoneEntry } from '../lib/zoneList'
import { npcNames } from '../lib/npcStations'
import { actorLabel, parseDialogue, parseEventFile, readEvent, ZONE_ACTOR, type EventBlock, type Step } from '../lib/eventScript'

interface EventEntry { id: number; offset: number; steps: Step[]; lines: number; scenes: number }
interface ActorEntry { actor: number; name: string; block: EventBlock; events: EventEntry[] }

/** Readable names for the common actions; the rest show their four-letter tag. */
const ACTIONS: [RegExp, string][] = [[/^fdo/, 'fade out'], [/^fdi/, 'fade in'], [/^tlk/, 'talk gesture'], [/^thk/, 'thinking gesture']]
const actionName = (t: string) => ACTIONS.find(([re]) => re.test(t))?.[1] ?? t

/**
 * Models -> Cutscenes -> Events (lib/eventScript): a zone's scripts, by NPC
 * and the zone's own scenes, read as steps: who says what, the player's
 * choices, waits, camera and actor actions. Branches rest on the server's
 * state (quests, missions, the player's answers), so every path is listed.
 */
export default function EventReader({ root, zone }: { root: string; zone: ZoneEntry }) {
  const [actors, setActors] = useState<ActorEntry[] | null>(null)
  const [lines, setLines] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [chosen, setChosen] = useState<{ actor: ActorEntry; event: EventEntry } | null>(null)
  const [all, setAll] = useState(false)
  const [quiet, setQuiet] = useState(true)

  useEffect(() => {
    let live = true
    setActors(null); setChosen(null); setError(null)
    void (async () => {
      try {
        const [ev, dl, names] = await Promise.all([
          window.ffxi.readDat(root, zone.events!),
          zone.dialog ? window.ffxi.readDat(root, zone.dialog) : Promise.resolve(null),
          npcNames(root, zone.id),
        ])
        const text = dl ? parseDialogue(dl) : []
        const list: ActorEntry[] = parseEventFile(ev).map(block => {
          const name = block.actor === ZONE_ACTOR ? 'Zone scenes' : names.get(block.actor & 0xfff) ?? `NPC ${block.actor & 0xfff}`
          const events = block.events.map(e => {
            const steps = readEvent(block, e.offset)
            return {
              id: e.id, offset: e.offset, steps,
              lines: steps.filter(s => s.kind === 'say' || s.kind === 'choice').length,
              scenes: steps.filter(s => s.kind === 'scene' || s.kind === 'camera').length,
            }
          })
          return { actor: block.actor, name, block, events }
        })
        if (!live) return
        // The zone's scenes first, then the NPCs by name.
        list.sort((a, b) => (a.actor === ZONE_ACTOR ? -1 : b.actor === ZONE_ACTOR ? 1 : a.name.localeCompare(b.name)))
        setLines(text); setActors(list)
        const first = list.find(a => a.events.some(e => e.lines))
        const ev0 = first?.events.find(e => e.lines)
        if (first && ev0) setChosen({ actor: first, event: ev0 })
      } catch (err) { if (live) setError(String(err)) }
    })()
    return () => { live = false }
  }, [root, zone])

  const nameOf = useMemo(() => {
    const byIndex = new Map(actors?.map(a => [a.actor, a.name]))
    return (id: number, self?: ActorEntry) => {
      if (id === 0x7ffffff8 && self) return self.actor === ZONE_ACTOR ? 'you' : self.name
      return actorLabel(id) ?? byIndex.get(id) ?? `NPC ${id & 0xfff}`
    }
  }, [actors])

  if (error) return <div className="placeholder"><h2>Couldn't read this zone's events</h2><p className="error-text">{error}</p></div>
  if (!actors) return <div className="placeholder"><h2>Reading {zone.name}…</h2></div>

  // 65534/65535 are default handlers: listed when they speak, or with everything.
  const shown = actors.map(a => ({ ...a, events: a.events.filter(e => all || e.lines || (e.scenes && e.id < 0xfffe)) })).filter(a => a.events.length)
  const total = actors.reduce((n, a) => n + a.events.length, 0)

  return (
    <div className="event-view">
      <div className="event-list">
        <h2>{zone.name}</h2>
        <p className="event-note">{total} events from {actors.length} sources. Only the server knows which a player sees when; every path is shown.</p>
        <label className="event-toggle"><input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)} /> Include events with no lines</label>
        {shown.map(a => (
          <div key={a.actor} className="event-actor">
            <div className="event-actor-name">{a.name}</div>
            {a.events.map(e => (
              <button
                key={e.id + ':' + e.offset}
                className={chosen?.event === e ? 'active' : ''}
                onClick={() => setChosen({ actor: a, event: e })}
              >
                Event {e.id}
                <span>{e.lines ? `${e.lines} line${e.lines === 1 ? '' : 's'}` : ''}{e.lines && e.scenes ? ' · ' : ''}{e.scenes ? 'scene' : ''}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="event-script">
        {chosen ? (
          <>
            <div className="event-script-head">
              <h3>{chosen.actor.name} · Event {chosen.event.id}</h3>
              <label className="event-toggle"><input type="checkbox" checked={!quiet} onChange={e => setQuiet(!e.target.checked)} /> Show every step</label>
            </div>
            <Script steps={chosen.event.steps} lines={lines} actor={chosen.actor} nameOf={nameOf} quiet={quiet} />
          </>
        ) : <p className="event-note">Pick an event.</p>}
      </div>
    </div>
  )
}

function Script({ steps, lines, actor, nameOf, quiet }: {
  steps: Step[]; lines: string[]; actor: ActorEntry; nameOf: (id: number, self?: ActorEntry) => string; quiet: boolean
}) {
  // Branch targets get a label so "go to" reads.
  const targets = new Set(steps.flatMap(s => s.jumps ?? []))
  const names = (t: string) => t.replace(/@([0-9a-f]+)/g, (_, h) => nameOf(parseInt(h, 16), actor)).replace(/"([^"]{1,8})"/g, (_, tag) => `“${actionName(tag)}”`)
  return (
    <ol className="event-steps">
      {steps.map(s => {
        if (quiet && (s.kind === 'other' || s.kind === 'unknown')) return null
        const label = targets.has(s.at) ? <span className="ev-label">{s.at.toString(16).padStart(4, '0')}</span> : null
        if (s.kind === 'say' || s.kind === 'choice') {
          const text = s.line !== undefined ? lines[s.line] ?? `(line ${s.line})` : '(a line the server picks)'
          const speaker = s.speaker === 'npc' ? (actor.actor === ZONE_ACTOR ? null : actor.name) : s.speaker !== undefined ? nameOf(s.speaker, actor) : null
          if (s.kind === 'choice') {
            const [prompt, options = ''] = text.split('\u0001')
            return (
              <li key={s.at} className="ev-step ev-choice">{label}
                <div>{prompt && <p>{prompt}</p>}<ul>{options.split('\n').filter(Boolean).map((o, i) => <li key={i}>{o}</li>)}</ul></div>
              </li>
            )
          }
          return (
            <li key={s.at} className="ev-step ev-say">{label}
              <div>{speaker && <b>{speaker}</b>}<p>{text.replace(/\u0001/g, '')}</p></div>
            </li>
          )
        }
        return <li key={s.at} className={`ev-step ev-${s.kind}`}>{label}<span>{names(s.text)}</span></li>
      })}
    </ol>
  )
}
