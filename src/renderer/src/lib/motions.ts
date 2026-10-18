import type { ParsedAnimation } from './ffxi-dat'

/**
 * A model's animation clips grouped into the motions they make up.
 *
 * Every clip is a block named with a three-character motion and a body-part
 * digit: "idl0" and "idl1" are the upper and lower body of one idle, "at00" is
 * the first attack. An NPC file holds a whole repertoire — Amoeban's has idle,
 * walk, run, three attacks, three spells, death and more — and the model
 * viewer used to play all of them at once by default, a jumble of every pose
 * together (README "Model viewer", 2026-10-17). A motion is the set of clips
 * that share the first three characters, played together.
 */
export interface Motion {
  key: string
  label: string
  clips: ParsedAnimation[]
}

const NAMES: Record<string, string> = {
  idl: 'Idle', wlk: 'Walk', run: 'Run', btl: 'Battle stance', ded: 'Death',
  bow: 'Bow', poi: 'Point', lau: 'Laugh', wee: 'Weep', kne: 'Kneel', nod: 'Nod',
  wav: 'Wave', clp: 'Clap', che: 'Cheer', sur: 'Surprised', sig: 'Sigh',
  ang: 'Angry', pan: 'Panic',
}
const NUMBERED: Record<string, string> = { at: 'Attack', ma: 'Magic', id: 'Idle variant' }

/** Idle first, then moving, then the rest by code (Attack 1, 2, 3 together). */
const FIRST = ['idl', 'btl', 'wlk', 'run']

function labelFor(key: string): string {
  if (NAMES[key]) return NAMES[key]
  const m = /^([a-z]{2})(\d)$/.exec(key)
  if (m && NUMBERED[m[1]]) return `${NUMBERED[m[1]]} ${Number(m[2]) + 1}`
  return 'Motion'
}

export function motionsOf(animations: ParsedAnimation[]): Motion[] {
  const groups = new Map<string, ParsedAnimation[]>()
  animations.forEach((a, i) => {
    const key = a.name && a.name.length >= 4 ? a.name.slice(0, 3) : `#${i + 1}`
    const list = groups.get(key)
    if (list) list.push(a)
    else groups.set(key, [a])
  })
  const motions = [...groups].map(([key, clips]) => ({ key, label: labelFor(key), clips }))
  const rank = (k: string) => { const i = FIRST.indexOf(k); return i < 0 ? FIRST.length : i }
  return motions.sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key))
}

/** The clips for a chosen motion; null, or a motion this model lacks, plays its first (idle when it has one). */
export function clipsForMotion(animations: ParsedAnimation[], key: string | null): ParsedAnimation[] {
  const motions = motionsOf(animations)
  return (motions.find(m => m.key === key) ?? motions[0])?.clips ?? []
}
