import csvText from '../../../../resources/zone-seed-data.csv?raw'

export interface ZoneEntry {
  id: number
  name: string
  /** ROM-relative path to the zone geometry DAT, e.g. "ROM3/0/0.DAT". */
  modelPath: string
  /** Semicolon-separated ROM paths for the minimap tiles. */
  mapPaths: string[]
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
    })
  }

  return zones.sort((a, b) => a.name.localeCompare(b.name))
})()
