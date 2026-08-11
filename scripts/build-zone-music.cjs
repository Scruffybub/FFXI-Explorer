/**
 * Turns LandSandBoat's zone_settings.sql into a zone id → music id table.
 *
 *   node scripts/build-zone-music.cjs <path-to-zone_settings.sql>
 *
 * Writes resources/zone-music.json. Only ids and numbers are extracted; the
 * SQL itself is not vendored, the same arrangement as build-item-names.cjs.
 *
 * The SQL is public and can be fetched with:
 *   curl -o zone_settings.sql \
 *     https://raw.githubusercontent.com/LandSandBoat/server/base/sql/zone_settings.sql
 *
 * Why this file is trustworthy: 283 of the 298 zone ids in
 * resources/zone-seed-data.csv carry a name that matches LandSandBoat's for the
 * same id exactly, and the 15 that differ are rows where our CSV has no name at
 * all or a suffix differs. The two tables are the same id namespace. Separately,
 * every music id referenced by any zone resolves to a real musicNNN.bgw in the
 * install — 0 missing — which is what confirms the id is the filename number.
 *
 * What the columns mean:
 *   music_day / music_night  the ambient track. 0 means the zone is silent,
 *                            which is not an error: 151 of 298 zones are.
 *   battlesolo / battlemulti battle tracks, not ambient. Kept because they are
 *                            the reason a music id can look "unused" by zones
 *                            while still being referenced.
 *
 * In this dump music_day and music_night are never different from each other —
 * every zone with music has the same id in both. That is a property of
 * LandSandBoat's data, not proof the game never varies music by time of day.
 * Do not build a day/night crossfade on the strength of it.
 */
const fs = require('fs')
const path = require('path')

const src = process.argv[2]
if (!src) {
  console.error('usage: node scripts/build-zone-music.cjs <zone_settings.sql>')
  process.exit(1)
}

const sql = fs.readFileSync(src, 'utf8')
const re = /INSERT INTO `zone_settings` VALUES \(([^)]*)\)/g

const zones = {}
let total = 0
let withMusic = 0
let m
while ((m = re.exec(sql))) {
  // zoneid, zonetype, zoneip, zoneport, name, music_day, music_night,
  // battlesolo, battlemulti, restriction, tax, misc
  const p = m[1].split(',').map(s => s.trim().replace(/^'/, '').replace(/'$/, ''))
  const id = Number(p[0])
  const day = Number(p[5])
  const night = Number(p[6])
  const solo = Number(p[7])
  const multi = Number(p[8])
  total++
  if (!day && !night && !solo && !multi) continue
  if (day || night) withMusic++
  zones[id] = { name: p[4], day, night, solo, multi }
}

const out = path.join(__dirname, '..', 'resources', 'zone-music.json')
fs.writeFileSync(out, JSON.stringify(zones, null, 0))
console.log(
  `wrote ${path.relative(process.cwd(), out)} — ` +
  `${Object.keys(zones).length} zones with any music of ${total} rows, ` +
  `${withMusic} with an ambient track`,
)
