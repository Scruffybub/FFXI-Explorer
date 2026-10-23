/**
 * The zone's triggered effects that sit in the world — Castle Zvahl's door
 * shimmers, La Theine's rainbow, Whitegate's effe/funs, Misareaux's
 * effe/umi1 — and which of them
 * the user is playing. The game starts these from events (a door opening, the
 * weather clearing); the viewer has no events, so Scene → Triggered effects
 * lists them with Play and Go to.
 *
 * A plain store between the panel (outside the canvas) and the particle field
 * (inside it): TriggeredEffects publishes the list, the panel reads it with
 * useSyncExternalStore and sends play/stop/go-to, and the field picks those up
 * each frame.
 */

export interface TriggerGroup {
  /** The DAT folder, e.g. `f_ri/effe/niji` or `d_zv/door/_4iy/mit8`. */
  dir: string
  /** What the panel shows. */
  label: string
  /** Where it plays, world space, or null when it has no place of its own. */
  at: [number, number, number] | null
  /**
   * How far it reaches from `at`, world units: Go to stands back by this.
   * La Theine's rainbow is a 440-unit billboard; a door shimmer a few units.
   */
  size: number
}

interface State { groups: TriggerGroup[]; running: ReadonlySet<string> }

let state: State = { groups: [], running: new Set() }
const listeners = new Set<() => void>()
const emit = (next: State) => { state = next; listeners.forEach(l => l()) }

export const triggerStore = {
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l) } },
  get: () => state,
}

/** Commands for the particle field, taken once each. */
export const triggerCommands: { goTo: TriggerGroup | null } = { goTo: null }

export function setTriggerGroups(groups: TriggerGroup[]) {
  emit({ groups, running: new Set() })
}

export function playTrigger(dir: string, on: boolean) {
  const running = new Set(state.running)
  if (on) running.add(dir)
  else running.delete(dir)
  emit({ ...state, running })
}

export function goToTrigger(group: TriggerGroup) {
  triggerCommands.goTo = group
}

/**
 * Names the panel can say plainly — only the certain ones (niji is Japanese
 * for rainbow); anything else shows its folder.
 */
const NAMES: [RegExp, string][] = [
  [/(^|\/)niji$/, 'Rainbow'],
  [/(^|\/)door\//, 'Door'],
]

export function triggerLabel(dir: string): string {
  const rel = dir.split('/').slice(1).join('/')
  for (const [re, name] of NAMES) if (re.test(dir)) return `${name} (${rel})`
  return rel
}
