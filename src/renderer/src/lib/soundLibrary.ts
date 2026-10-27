import zoneMusicTable from '../../../../resources/zone-music.json'
import { decodeSpw, type DecodedAudio } from './bgw'
import { decodeTrack } from './zoneMusic'

/**
 * Models -> Sounds: the game's music and sound effects, listed from the
 * install, decoded with the app's own decoders (bgw.ts, atrac3.ts).
 *
 * Music is <sound dir>/win/music/data/musicNNN.bgw, about 224 tracks; sound
 * effects are <sound dir>/win/se/seFFF/seNNNNNN.spw, about 11,900 in some
 * 500 folders of a thousand numbers each. The sound folders overlay like the
 * ROM folders, the first holding a number wins (zoneMusic SOUND_DIRS).
 *
 * The files carry no titles. A track is named by the zones that play it
 * (zone-music.json: day, night, solo and party battle); sound effects keep
 * their numbers.
 */

const SOUND_DIRS = ['sound', 'sound2', 'sound3', 'sound4', 'sound5', 'sound6', 'sound7', 'sound8', 'sound9']

export interface SoundEntry {
  kind: 'music' | 'effect'
  id: number
  /** Install-relative file. */
  path: string
  /** What to show: "Music 104 — Bastok Markets" or "Sound 12034". */
  label: string
  /** Effects: their folder of a thousand, for grouping. */
  folder?: number
}

interface ZoneMusicEntry { name: string; day: number; night: number; solo: number; multi: number }

/** Each track's zones and how they use it, from zone-music.json. */
function trackUses(): Map<number, string[]> {
  const uses = new Map<number, string[]>()
  const add = (id: number, what: string) => {
    if (id <= 0) return
    const list = uses.get(id) ?? []
    if (!list.includes(what)) list.push(what)
    uses.set(id, list)
  }
  for (const e of Object.values(zoneMusicTable as unknown as Record<string, ZoneMusicEntry>)) {
    const name = e.name.replace(/_/g, ' ')
    add(e.day, name)
    if (e.night !== e.day) add(e.night, name + ' (night)')
    add(e.solo, 'Battle: ' + name)
    if (e.multi !== e.solo) add(e.multi, 'Party battle: ' + name)
  }
  return uses
}

export async function listMusic(root: string): Promise<SoundEntry[]> {
  const uses = trackUses()
  const seen = new Map<number, SoundEntry>()
  for (const dir of SOUND_DIRS) {
    const names = await window.ffxi.listDir(root, `${dir}/win/music/data`)
    for (const n of names) {
      const m = /^music(\d+)\.bgw$/i.exec(n)
      if (!m) continue
      const id = Number(m[1])
      if (seen.has(id)) continue
      const zones = uses.get(id) ?? []
      const where = zones.length ? ` — ${zones.slice(0, 3).join(', ')}${zones.length > 3 ? ` +${zones.length - 3}` : ''}` : ''
      seen.set(id, { kind: 'music', id, path: `${dir}/win/music/data/${n}`, label: `Music ${id}${where}` })
    }
  }
  return [...seen.values()].sort((a, b) => a.id - b.id)
}

export async function listEffects(root: string): Promise<SoundEntry[]> {
  const seen = new Map<number, SoundEntry>()
  for (const dir of SOUND_DIRS) {
    const folders = (await window.ffxi.listDir(root, `${dir}/win/se`)).filter(n => /^se\d+\/$/i.test(n))
    for (const f of folders) {
      const names = await window.ffxi.listDir(root, `${dir}/win/se/${f}`)
      for (const n of names) {
        const m = /^se(\d+)\.spw$/i.exec(n)
        if (!m) continue
        const id = Number(m[1])
        if (seen.has(id)) continue
        seen.set(id, { kind: 'effect', id, path: `${dir}/win/se/${f}${n}`, label: `Sound ${id}`, folder: Math.floor(id / 1000) })
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.id - b.id)
}

/** Decodes a track or sound effect; a message when it cannot. */
export async function decodeSound(root: string, entry: SoundEntry): Promise<DecodedAudio | string> {
  const bytes = new Uint8Array(await window.ffxi.readDat(root, entry.path))
  if (entry.kind === 'effect') return decodeSpw(bytes) ?? 'This sound could not be decoded.'
  const r = decodeTrack(bytes)
  if (typeof r === 'number') return `This track uses a codec the app does not decode (${r}).`
  return r ?? 'This track could not be decoded.'
}
