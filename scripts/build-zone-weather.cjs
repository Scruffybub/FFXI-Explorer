/**
 * Builds resources/zone-weather.json: for every zone, the weather it normally
 * gets, most typical first — the ids only, no frequencies.
 *
 *   node scripts/build-zone-weather.cjs <LandSandBoat checkout> [FFXI dir]
 *
 * The checkout needs sql/zone_weather.sql, data/enums/zone.yaml and each
 * zone's data/zones/<name>/zone.yaml (a sparse clone of sql, data/zones and
 * data/enums will do).
 *
 * Sources:
 *  - Which weather occurs, and how it ranks: LandSandBoat's sql/zone_weather.sql
 *    (github.com/LandSandBoat/server, GPL-3.0), read as data. Each zone is a
 *    2160-day cycle of u16 = normal << 10 | common << 5 | rare; a non-zero day
 *    holds until the next, and the server rolls normal 50%, common 35%, rare
 *    15% (zone.cpp). Only the resulting list and its order are kept.
 *  - Fog: the server turns None/Sunshine/Clouds into Fog from 02:00 to 07:00
 *    outside cities (zone.cpp UpdateWeather, which calls the rule approximate);
 *    cities are the zones whose data/zones/<name>/zone.yaml type lists city.
 *    Here Fog counts as native when that condition can arise AND the zone's own
 *    DAT ships fog art (weat/mist), which the art team only made where it happens.
 *
 * Weather ids follow the client's table: 0 none, 1 sunshine, 2 clouds, 3 fog,
 * 4/5 fire, 6/7 water, 8/9 earth, 10/11 wind, 12/13 ice, 14/15 lightning,
 * 16/17 light, 18/19 dark (single, then double).
 */
const fs = require('fs')
const path = require('path')

const lsb = process.argv[2]
const ROOT = (process.argv[3] || 'C:/Program Files (x86)/PlayOnline/SquareEnix/FINAL FANTASY XI').replace(/[\\/]+$/, '') + '/'
if (!lsb) {
  console.log('usage: node scripts/build-zone-weather.cjs <LandSandBoat checkout> [FFXI dir]')
  process.exit(1)
}

function splitCsv(line) {
  const out = []; let cur = '', q = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++ } else q = !q }
    else if (ch === ',' && !q) { out.push(cur); cur = '' } else cur += ch
  }
  out.push(cur); return out
}
const csv = fs.readFileSync(path.join(__dirname, '../resources/zone-seed-data.csv'), 'utf8').split(/\r?\n/).filter(Boolean)
const hdr = splitCsv(csv[0])
const zones = csv.slice(1).map(splitCsv).map(f => ({
  id: Number(f[hdr.indexOf('ID')]), model: (f[hdr.indexOf('MODEL')] || '').trim(),
}))

/** Does the zone DAT ship weat/mist (or its table-2 twin mis1)? */
function hasFogArt(model) {
  if (!model) return false
  let fd
  try { fd = fs.openSync(ROOT + model, 'r') } catch { return false }
  const size = fs.fstatSync(fd).size
  const h = Buffer.alloc(8)
  const stack = []
  let off = 0, found = false
  while (off + 8 <= size && !found) {
    fs.readSync(fd, h, 0, 8, off)
    const name = h.toString('latin1', 0, 4).replace(/\0/g, '').trim()
    const packed = h.readUInt32LE(4)
    const type = packed & 0x7f, units = (packed >>> 7) & 0x7ffff
    if (!units) break
    if (type === 1) {
      if (stack[stack.length - 1] === 'weat' && (name === 'mist' || name === 'mis1')) found = true
      stack.push(name)
    } else if (type === 0) stack.pop()
    off += units * 16
  }
  fs.closeSync(fd)
  return found
}

// Cities never fog: zone ids whose zone.yaml type includes city.
const cities = new Set()
for (const line of fs.readFileSync(path.join(lsb, 'data/enums/zone.yaml'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s+([a-z0-9_]+):\s+(\d+)/)
  if (!m) continue
  const yaml = path.join(lsb, 'data/zones', m[1], 'zone.yaml')
  if (!fs.existsSync(yaml)) continue
  const type = (fs.readFileSync(yaml, 'utf8').match(/^type:\s*\[([^\]]*)\]/m) || [])[1] || ''
  if (/\bcity\b/.test(type)) cities.add(Number(m[2]))
}

const sql = fs.readFileSync(path.join(lsb, 'sql/zone_weather.sql'), 'latin1')
const out = {}
for (const m of sql.matchAll(/\((\d+),0x([0-9A-Fa-f]+)\)/g)) {
  const id = Number(m[1])
  const buf = Buffer.from(m[2], 'hex')
  const share = new Array(20).fill(0)
  let cur = null
  for (let d = 0; d < 2160 && d * 2 + 1 < buf.length; d++) {
    const v = buf.readUInt16LE(d * 2)
    if (v) cur = [v >> 10, (v >> 5) & 31, v & 31]
    if (!cur) continue
    share[cur[0]] += 0.5; share[cur[1]] += 0.35; share[cur[2]] += 0.15
  }
  const list = share.map((s, w) => [w, s]).filter(([w, s]) => s > 0 && w < 20).sort((a, b) => b[1] - a[1]).map(([w]) => w)
  if (!list.length) continue
  const zone = zones.find(z => z.id === id)
  if (!list.includes(3) && !cities.has(id) && list.some(w => w <= 2) && zone && hasFogArt(zone.model)) list.push(3)
  out[id] = list
}
const file = path.join(__dirname, '../resources/zone-weather.json')
fs.writeFileSync(file, JSON.stringify(out) + '\n')
console.log(`wrote ${Object.keys(out).length} zones to ${path.relative(process.cwd(), file)} (${cities.size} cities kept fog-free)`)
