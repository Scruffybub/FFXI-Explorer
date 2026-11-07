import csvText from '../../../../resources/zone-seed-data.csv?raw'

export interface ZoneEntry {
  id: number
  name: string
  /** ROM-relative path to the zone geometry DAT, e.g. "ROM3/0/0.DAT". */
  modelPath: string
  /** Semicolon-separated ROM paths for the minimap tiles. */
  mapPaths: string[]
  /** The zone's event scripts and their dialogue (Cutscenes -> Events), when it has them. */
  events?: string
  dialog?: string
}

/**
 * Splits a CSV line, honouring double-quoted fields (zone names contain commas).
 */
function splitCsvLine(line: string): string[] {
  const fields: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  fields.push(current)
  return fields
}

/**
 * The zone table shipped with the app. This is the same data the web version
 * fetches from its API, bundled here so the viewer needs no server at all.
 */
export const ZONES: ZoneEntry[] = (() => {
  const lines = csvText.split(/\r?\n/).filter(l => l.trim().length > 0)
  const header = splitCsvLine(lines[0])
  const idx = {
    id: header.indexOf('ID'),
    name: header.indexOf('NAME'),
    model: header.indexOf('MODEL'),
    maps: header.indexOf('MAP_PATHS'),
    events: header.indexOf('EVENTS'),
    dialog: header.indexOf('DIALOG'),
  }

  const zones: ZoneEntry[] = []
  for (let i = 1; i < lines.length; i++) {
    const f = splitCsvLine(lines[i])
    const id = Number(f[idx.id])
    const name = (f[idx.name] ?? '').trim()
    const modelPath = (f[idx.model] ?? '').trim()

    // Zones with no geometry path can't be rendered; "unknown" is a placeholder row.
    if (!Number.isFinite(id) || !modelPath || !name || name === 'unknown') continue

    zones.push({
      id,
      name,
      modelPath,
      mapPaths: (f[idx.maps] ?? '').split(';').map(s => s.trim()).filter(Boolean),
      events: f[idx.events]?.trim() || undefined,
      dialog: f[idx.dialog]?.trim() || undefined,
    })
  }

  return zones.sort((a, b) => a.name.localeCompare(b.name))
})()

/**
 * Places only scenes open (op 0x34), kept off the zone list: no zone id the
 * server knows, no NPCs of their own. Their file numbers are 100 + the id, the
 * rule of the first 256 zones. Scenes also ask for ids 542, 594 and 700-745,
 * which have no drawable geometry there; those scenes stay where they are.
 */
const SCENE_ZONE_FILES: Record<number, string> = {
  516: 'ROM2/15/122', 517: 'ROM2/15/123', 519: 'ROM2/16/2',
  540: 'ROM3/0/47', 541: 'ROM3/0/48', 543: 'ROM3/0/50', 544: 'ROM3/0/51', 545: 'ROM3/0/52', 546: 'ROM3/3/83',
  559: 'ROM4/5/7', 584: 'ROM9/5/48', 593: 'ROM9/6/116',
}
/** A zone by id, the scene-only places too. */
export function zoneById(id: number): ZoneEntry | undefined {
  const path = SCENE_ZONE_FILES[id]
  return ZONES.find(z => z.id === id) ?? (path ? { id, name: 'Scene area ' + id, modelPath: path + '.DAT', mapPaths: [] } : undefined)
}
