import raw from '../../../../resources/scene-names.json'

/**
 * Which quest or mission an event belongs to (resources/scene-names.json,
 * built by scripts/build-scene-names.cjs from LandSandBoat's server scripts:
 * the game's files only number their events). 5,541 of them: the quest and
 * mission scenes; NPCs' everyday talk has none.
 */
export interface SceneName {
  title: string
  kind: 'quest' | 'mission'
  /** The mission's expansion or nation, or the quest log's area. */
  log: string
  /** The NPC the server script starts it from, when it says. */
  npc: string | null
}

const SCENES = (raw as unknown as { scenes: Record<string, [string, 'quest' | 'mission', string, string?]> }).scenes

export function sceneName(zoneId: number, eventId: number): SceneName | null {
  const s = SCENES[`${zoneId}:${eventId}`]
  return s ? { title: s[0], kind: s[1], log: s[2], npc: s[3] ?? null } : null
}

/** "Aht Urhgan quest", "Chains of Promathia mission". */
export const sceneKind = (s: SceneName) => `${s.log} ${s.kind}`
