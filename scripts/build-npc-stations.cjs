/**
 * Builds resources/npc-stations.json: where each zone's NPCs stand, which way
 * they face and what they look like, for Scene -> NPCs (lib/npcStations.ts).
 *
 *   node scripts/build-npc-stations.cjs <LandSandBoat data/zones folder>
 *
 * The client never holds NPC positions (the server sends them), so they come
 * from LandSandBoat's per-zone data/zones/<zone>/npcs.yaml (GPL-3.0; see
 * THIRD-PARTY-NOTICES.md). Only positions, facing and appearance numbers are
 * kept; names are read from the install. Kept: NPCs with a position whose
 * status shows them (normal, update), drawn as a model (standard) or a
 * character (equipped). Left out: cutscene-only, hidden and unplaced ones
 * (no status is LandSandBoat's default, which hides: the Mog House moogle at
 * 0,0,1.5), doors, lifts and ships (the zone's own models), and the
 * invisible "???" markers (models 50 and 52: one mesh named "toum").
 *
 * Also resources/npc-actors.json, the same for the NPCs left out for their
 * status (cutscene-only and hidden ones with a position and a look): the
 * actors only a scene shows (Cutscenes -> Play in zone), such as the
 * children in Bastok Markets' puppet flashback. With them, the NPCs with a
 * look and no position at all (cutscene-only ones the scene places itself),
 * at 0, 0, 0 with facing -1 for "unplaced": a scene loads one only when its
 * scripts name it (lib/cutscene sceneCast).
 *
 * Output: { "<zone id>": [[index, x, y, z, facing, look], ..] }. index is the
 * NPC id's low 12 bits, facing 0-255 a full turn, look a model number or
 * [race, face, head, body, hands, legs, feet, main, sub, ranged].
 */
const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')

const dir = process.argv[2]
if (!dir) { console.error('usage: node scripts/build-npc-stations.cjs <LandSandBoat data/zones folder>'); process.exit(1) }

const SHOWN = new Set(['normal', 'update'])
const INVISIBLE = new Set([50, 52])
const SLOTS = ['head', 'body', 'hands', 'legs', 'feet', 'main', 'sub', 'ranged']

const out = {}
const actors = {}
const skipped = {}
const skip = why => { skipped[why] = (skipped[why] || 0) + 1 }
for (const zone of fs.readdirSync(dir).sort()) {
  const file = path.join(dir, zone, 'npcs.yaml')
  if (!fs.existsSync(file)) continue
  const npcs = yaml.load(fs.readFileSync(file, 'utf8'))?.npcs ?? {}
  for (const [key, e] of Object.entries(npcs)) {
    const id = Number(key)
    const look = e.render?.look
    const shown = !!e.at && SHOWN.has(e.status)
    if (!shown) skip('status ' + (e.status ?? 'none'))
    let l
    if (look?.type === 'standard') {
      if (INVISIBLE.has(look.model)) { skip('invisible marker'); continue }
      l = look.model
    } else if (look?.type === 'equipped') {
      l = [look.race, look.face, ...SLOTS.map(s => (look[s] ?? 0) & 0xfff)]
    } else { skip('look ' + look?.type); continue }
    const [x, y, z, rot = 0] = e.at ?? [0, 0, 0, -1]
    if (!e.at) skip('unplaced (scene actor)')
    ;((shown ? out : actors)[(id >> 12) & 0xfff] ??= []).push([id & 0xfff, x, y, z, rot, l])
  }
}

const target = path.join(__dirname, '..', 'resources', 'npc-stations.json')
fs.writeFileSync(target, JSON.stringify(out))
const count = Object.values(out).reduce((n, v) => n + v.length, 0)
console.log(count, 'NPCs in', Object.keys(out).length, 'zones,', fs.statSync(target).size, 'bytes')
console.log('skipped', JSON.stringify(skipped))
const actorsFile = path.join(__dirname, '..', 'resources', 'npc-actors.json')
fs.writeFileSync(actorsFile, JSON.stringify(actors))
console.log(Object.values(actors).reduce((n, v) => n + v.length, 0), 'scene-only actors,', fs.statSync(actorsFile).size, 'bytes')
