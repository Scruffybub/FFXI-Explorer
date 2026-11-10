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
 *
 * Also resources/npc-marks.json: { "<zone id>": [[index, x, y, z, facing], ..] },
 * the actors with nothing to draw (the invisible markers; doors, lifts and
 * ships, which are the zone's own models). Scenes turn people toward them and
 * read where they are. Facing -1 for one with no position.
 */
const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')

const dir = process.argv[2]
if (!dir) { console.error('usage: node scripts/build-npc-stations.cjs <LandSandBoat data/zones folder>'); process.exit(1) }

const SHOWN = new Set(['normal', 'update'])
const INVISIBLE = new Set([50, 52])
const SLOTS = ['head', 'body', 'hands', 'legs', 'feet', 'main', 'sub', 'ranged']
const NO_BODY = new Set(['door', 'elevator', 'ship'])

const out = {}
const actors = {}
// Cutscene-only NPCs' names, for speakers the game's own name list leaves
// out (Beaucedine [S]'s Cait Sith, Kupofried): "blank" ones are dressed and
// named by the server, door ids start with "_".
const names = {}
const marks = {}
const skipped = {}
const skip = why => { skipped[why] = (skipped[why] || 0) + 1 }
for (const zone of fs.readdirSync(dir).sort()) {
  const file = path.join(dir, zone, 'npcs.yaml')
  if (!fs.existsSync(file)) continue
  const npcs = yaml.load(fs.readFileSync(file, 'utf8'))?.npcs ?? {}
  for (const [key, e] of Object.entries(npcs)) {
    const id = Number(key)
    const look = e.render?.look
    const named = String(e.display_name ?? e.script ?? '')
    if (e.status === 'cutscene_only' && named && named !== 'blank' && !named.startsWith('_') && !named.startsWith('NPC['))
      (names[(id >> 12) & 0xfff] ??= {})[id & 0xfff] = named.replace(/_/g, ' ')
    const shown = !!e.at && SHOWN.has(e.status)
    if (!shown) skip('status ' + (e.status ?? 'none'))
    const mark = () => {
      const [x, y, z, rot = 0] = e.at ?? [0, 0, 0, -1]
      // A door's id, the 4 characters its zone model carries (MZB +0x34).
      const door = look?.type === 'door' && e.render?.door_id ? Buffer.alloc(4) : null
      if (door) door.writeUInt32LE(e.render.door_id >>> 0)
      ;(marks[(id >> 12) & 0xfff] ??= []).push([id & 0xfff, +x.toFixed(2), +y.toFixed(2), +z.toFixed(2), rot, ...(door ? [door.toString('latin1')] : [])])
    }
    let l
    if (look?.type === 'standard') {
      if (INVISIBLE.has(look.model)) { skip('invisible marker'); mark(); continue }
      l = look.model
    } else if (look?.type === 'equipped') {
      l = [look.race, look.face, ...SLOTS.map(s => (look[s] ?? 0) & 0xfff)]
    } else if (look?.type === 'chocobo') {
      // LandSandBoat's "face" byte is the chocobo's race in the game's tables
      // (32-36: race file ROM/169/11, body types 12-16); its parts are gear.
      l = [look.face, 0, ...SLOTS.map(s => (look[s] ?? 0) & 0xfff)]
    } else if (look?.type === 'automaton') {
      l = look.model
    } else { skip('look ' + look?.type); if (NO_BODY.has(look?.type)) mark(); continue }
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
const namesFile = path.join(__dirname, '..', 'resources', 'npc-names-lsb.json')
fs.writeFileSync(namesFile, JSON.stringify(names))
console.log(Object.values(names).reduce((n, v) => n + Object.keys(v).length, 0), 'cutscene-only names,', fs.statSync(namesFile).size, 'bytes')
const marksFile = path.join(__dirname, '..', 'resources', 'npc-marks.json')
fs.writeFileSync(marksFile, JSON.stringify(marks))
console.log(Object.values(marks).reduce((n, v) => n + v.length, 0), 'marks,', fs.statSync(marksFile).size, 'bytes')
