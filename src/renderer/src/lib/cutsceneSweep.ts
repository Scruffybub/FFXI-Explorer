import { ZONES } from './zoneList'
import { npcNames } from './npcStations'
import { parseDialogue, parseEventFile, readEvent, ZONE_ACTOR } from './eventScript'
import { clearCutsceneFiles, CutsceneRun, type CutsceneProbe } from './cutscene'

/**
 * The scene sweep (?census=1: window.__sweep(root, zoneId)): every event of a
 * zone run headless through the cutscene player, each message read and the
 * first choice taken at once, to find what it can't play. scripts/
 * cutscene-sweep.cjs drives it over every zone and writes the report.
 *
 * Each scene ends one way: 'ended' (its script finished), 'unreadable' (an
 * instruction the player can't size), 'server' (a loop waiting on the game
 * server), 'menu' (the first choice keeps coming back: a talk menu, not a
 * fault) or 'timeout' (still going after 15 scene minutes: what it waits on
 * is noted). Notes are what the run reported on the way (CutsceneProbe).
 */
export interface SweepRow {
  actor: number
  id: number
  lines: number
  cinematic: boolean
  result: 'ended' | 'unreadable' | 'server' | 'menu' | 'timeout' | 'crash'
  /** Scene seconds it ran. */
  time: number
  /** "kind: detail", once each. */
  notes: string[]
}

const DT = 0.25
const LIMIT = 15 * 60
const MAX_CHOICES = 40

export async function sweepZone(root: string, zoneId: number): Promise<SweepRow[]> {
  const zone = ZONES.find(z => z.id === zoneId)
  if (!zone?.events) return []
  clearCutsceneFiles()
  const [ev, dl, names] = await Promise.all([
    window.ffxi.readDat(root, zone.events),
    zone.dialog ? window.ffxi.readDat(root, zone.dialog) : Promise.resolve(null),
    npcNames(root, zone.id),
  ])
  const lines = dl ? parseDialogue(dl) : []
  const blocks = parseEventFile(ev)
  const rows: SweepRow[] = []
  let since = 0
  for (const block of blocks) {
    const actorName = block.actor === ZONE_ACTOR ? 'Zone scenes' : names.get(block.actor & 0xfff) ?? `NPC ${block.actor & 0xfff}`
    for (const e of block.events) {
      const steps = readEvent(block, e.offset)
      const notes = new Set<string>()
      const probe: CutsceneProbe = { note: (kind, detail) => { notes.add(`${kind}: ${detail}`) } }
      const row: SweepRow = {
        actor: block.actor, id: e.id,
        lines: steps.filter(s => s.kind === 'say' || s.kind === 'choice').length,
        cinematic: steps.some(s => s.kind === 'scene' || s.kind === 'camera'),
        result: 'timeout', time: 0, notes: [],
      }
      try {
        const run = new CutsceneRun({ root, zone, block, blocks, eventId: e.id, offset: e.offset, lines, names, actorName }, probe)
        let t = 0, choices = 0
        while (!run.view.ended && t < LIMIT) {
          run.tick(DT); t += DT
          await run.settle()
          const waits = run.waitingOn()
          if (waits.includes('read')) run.advance()
          if (waits.includes('choice')) {
            if (++choices > MAX_CHOICES) { row.result = 'menu'; break }
            run.choose(0)
          }
          if (waits.includes('zone') && run.sceneZone !== null) {
            if (!ZONES.some(z => z.id === run.sceneZone)) notes.add(`unknown zone: ${run.sceneZone}`)
            run.zoneReady(run.sceneZone)
          }
        }
        row.time = t
        // Shown before it was placed is fine when the scene places it later.
        for (const [id, p] of run.poses) if (!p.unplaced) notes.delete(`shown, not placed: 0x${id.toString(16).padStart(2, '0')}`)
        if (run.view.ended) {
          const n = run.view.note ?? ''
          row.result = /can.t read/.test(n) ? 'unreadable' : /server/.test(n) ? 'server' : 'ended'
        } else if (row.result === 'timeout') {
          notes.add(`waiting on: ${run.waitingOn().map(w => w ?? 'time').join(', ')}`)
        }
      } catch (err) {
        row.result = 'crash'
        notes.add(`crash: ${String(err).slice(0, 200)}`)
      }
      row.notes = [...notes]
      rows.push(row)
      // Give the window a breath now and then.
      if (++since % 40 === 0) await new Promise(r => setTimeout(r))
    }
  }
  return rows
}
