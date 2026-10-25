/**
 * Builds resources/mob-spawns.json: where each zone's ordinary monsters
 * appear, what they look like, and the ground they roam, for Scene ->
 * Monsters (lib/mobSpawns.ts).
 *
 *   node scripts/build-mob-spawns.cjs <LandSandBoat data/zones folder>
 *
 * The client never holds monster spawns (the server sends them), so they come
 * from LandSandBoat's per-zone mobs.yaml and regions.yaml (GPL-3.0; see
 * THIRD-PARTY-NOTICES.md). Only appearance numbers, spawn areas and times are
 * kept. Most spawns name a region, a polygon the server picks a spawn point
 * in (West Ronfaure: 450 of 480); the rest give a position. Polygons are
 * simplified to within 2 units in plan (896k points -> ~194k) and rounded to
 * whole units; each keeps its height, which picks the right floor where the
 * collision has several (a cave under a hill).
 *
 * Left out: notorious monsters, and those fished up, called, or from
 * battlefields and events; spawns the server starts by script, lottery,
 * weather or fog; placeholders at 1,1,1; looks other than a model number or
 * race and gear. Slots (spawns that take turns at one spot: West Ronfaure's
 * rabbit by day, bats in the evening) keep a slot number, so the app shows
 * one member at a time.
 *
 * Output: { "<zone id>": { r: [[x, y, z, x, y, z, ..]], m: [[index, look, where, time, slot, speed?]] } }
 * index the monster id's low 12 bits (its name in the install), look a model number or [race, face, head .. ranged]; where a region index or
 * [x, y, z, facing 0-255]; time 0 any, 1 evening (at_evening), 2 night
 * (at_night); slot an index or -1; speed LandSandBoat's when set (40 usual).
 */
const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')

const dir = process.argv[2]
if (!dir) { console.error('usage: node scripts/build-mob-spawns.cjs <LandSandBoat data/zones folder>'); process.exit(1) }

const SKIP_TYPES = new Set(['notorious', 'fished', 'battlefield', 'called', 'event', 'unused'])
const SKIP_SPAWNS = new Set(['scripted', 'lottery', 'weather', 'fog'])
const SLOTS = ['head', 'body', 'hands', 'legs', 'feet', 'main', 'sub', 'ranged']

/** Douglas-Peucker on an open run of [x, z] points. */
function simplify(pts, tol) {
  if (pts.length < 3) return pts
  const a = pts[0], b = pts[pts.length - 1]
  const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz) || 1e-9
  let far = -1, at = 0
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs(dx * (a[1] - pts[i][1]) - dz * (a[0] - pts[i][0])) / len
    if (d > far) { far = d; at = i }
  }
  if (far <= tol) return [a, b]
  return [...simplify(pts.slice(0, at + 1), tol).slice(0, -1), ...simplify(pts.slice(at), tol)]
}

/** A closed polygon, split at the point farthest from its first so both halves are open runs. */
function simplifyRing(ring, tol) {
  let far = 0
  ring.forEach((p, i) => { if (Math.hypot(p[0] - ring[0][0], p[1] - ring[0][1]) > Math.hypot(ring[far][0] - ring[0][0], ring[far][1] - ring[0][1])) far = i })
  if (far === 0) return ring
  return [...simplify(ring.slice(0, far + 1), tol).slice(0, -1), ...simplify([...ring.slice(far), ring[0]], tol).slice(0, -1)]
}

const out = {}
const skipped = {}
const skip = why => { skipped[why] = (skipped[why] || 0) + 1 }
let points = 0

for (const zone of fs.readdirSync(dir).sort()) {
  const file = path.join(dir, zone, 'mobs.yaml')
  if (!fs.existsSync(file)) continue
  const doc = yaml.load(fs.readFileSync(file, 'utf8')) ?? {}
  const templates = doc.templates ?? {}
  const regionFile = path.join(dir, zone, 'regions.yaml')
  const regions = fs.existsSync(regionFile) ? yaml.load(fs.readFileSync(regionFile, 'utf8'))?.regions ?? {} : {}
  const slotOf = new Map()
  ;(doc.slots ?? []).forEach((slot, i) => { for (const id of Object.keys(slot.members ?? {})) slotOf.set(Number(id), i) })

  const regionIndex = new Map()
  let entry = null
  for (const [key, spawn] of Object.entries(doc.spawns ?? {})) {
    const id = Number(key)
    const t = templates[spawn.template]
    if (!t) { skip('no template'); continue }
    if ((t.type ?? []).some(x => SKIP_TYPES.has(x))) { skip('type ' + t.type.join('+')); continue }
    const spawnTypes = t.attributes?.spawn?.type ?? []
    if (spawnTypes.some(x => SKIP_SPAWNS.has(x))) { skip('spawn ' + spawnTypes.join('+')); continue }
    const look = t.attributes?.render?.look
    let l
    if (look?.type === 'standard') l = look.model
    else if (look?.type === 'equipped') l = [look.race, look.face, ...SLOTS.map(s => (look[s] ?? 0) & 0xfff)]
    else { skip('look ' + look?.type); continue }

    let where
    if (spawn.region) {
      const poly = regions[spawn.region]?.poly
      if (!poly || poly.length < 3) { skip('region missing'); continue }
      if (!regionIndex.has(spawn.region)) {
        entry ??= { r: [], m: [] }
        const ring = simplifyRing(poly.map(p => [p[0], p[2], p[1]]), 2)
        regionIndex.set(spawn.region, entry.r.length)
        // Each point keeps its height, so the app can tell the floor of a cave
        // from the hill above it (King Ranperre's Tomb, 2026-10-25).
        entry.r.push(ring.flatMap(p => [Math.round(p[0]), Math.round(p[2]), Math.round(p[1])]))
        points += ring.length
      }
      where = regionIndex.get(spawn.region)
    } else if (spawn.at && !(spawn.at[0] === 1 && spawn.at[1] === 1 && spawn.at[2] === 1)) {
      const [x, y, z, rot = 0] = spawn.at
      where = [x, y, z, rot]
    } else { skip('no position'); continue }

    const time = spawnTypes.includes('at_night') ? 2 : spawnTypes.includes('at_evening') ? 1 : 0
    const row = [id & 0xfff, l, where, time, slotOf.get(id) ?? -1]
    if (t.attributes?.speed) row.push(t.attributes.speed)
    entry ??= { r: [], m: [] }
    entry.m.push(row)
    const zoneId = (id >> 12) & 0xfff
    out[zoneId] = entry
  }
}

const target = path.join(__dirname, '..', 'resources', 'mob-spawns.json')
fs.writeFileSync(target, JSON.stringify(out))
const count = Object.values(out).reduce((n, z) => n + z.m.length, 0)
console.log(count, 'monsters in', Object.keys(out).length, 'zones,', points, 'region points,', fs.statSync(target).size, 'bytes')
console.log('skipped', JSON.stringify(Object.fromEntries(Object.entries(skipped).sort((a, b) => b[1] - a[1]).slice(0, 14))))
