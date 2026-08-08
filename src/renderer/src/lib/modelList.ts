import rawModels from '../../../../resources/npc-model-paths.json'

/**
 * The catalogue of NPC, monster and object models, with the ROM path of each.
 *
 * From Vanalytics (`public/data/npc-model-paths.json`) — 2,473 entries across 27
 * categories. Bundled at build time like the zone list, so the viewer needs no
 * network and no sidecar file.
 */
export interface ModelEntry {
  name: string
  category: string
  /** ROM-relative path, e.g. "ROM/250/79.dat". */
  path: string
}

export const MODELS: ModelEntry[] = (rawModels as ModelEntry[]).filter(
  m => m && m.name && m.path,
)

/** Category names, in descending order of how many models they hold. */
export const MODEL_CATEGORIES: string[] = (() => {
  const counts = new Map<string, number>()
  for (const m of MODELS) counts.set(m.category, (counts.get(m.category) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name)
})()

/** Case-insensitive search over name and category. */
export function searchModels(query: string, category: string | null): ModelEntry[] {
  const q = query.trim().toLowerCase()
  return MODELS.filter(m => {
    if (category && m.category !== category) return false
    if (!q) return true
    return m.name.toLowerCase().includes(q) || m.category.toLowerCase().includes(q)
  })
}
