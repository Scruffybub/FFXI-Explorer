/**
 * Names the game's event scenes after the quest or mission they belong to.
 *
 *   node scripts/build-scene-names.cjs <LandSandBoat checkout>
 *
 * The game's event files number their scenes and nothing more; which quest
 * or mission plays which number is the server's to know. LandSandBoat's
 * scripts (GPL-3.0; see THIRD-PARTY-NOTICES.md) say it: each quest and
 * mission file names the zone ([xi.zone.X]) and the event numbers it starts
 * there (progressEvent(n), cutscene(n), onEventFinish [n]), and the older
 * zone scripts (scripts/zones/<zone>/npcs) start events beside the quest or
 * mission they test. Only those facts are kept: zone, event number, the
 * quest or mission's title, its log, and the NPC. No code is copied.
 *
 * Writes resources/scene-names.json:
 *   { scenes: { "<zone id>:<event id>": [title, kind, log, npc?] } }
 * kind is "mission" or "quest"; log the mission's expansion (or nation) or
 * the quest log's area: "<log> <kind>" reads, e.g. "Aht Urhgan quest". Missions win over quests, and the quest and mission files
 * over the zone scripts' guesses.
 */
const fs = require('fs')
const path = require('path')

const lsb = process.argv[2]
if (!lsb) { console.error('usage: node scripts/build-scene-names.cjs <LandSandBoat checkout>'); process.exit(1) }
const scripts = path.join(lsb, 'scripts')

// Zone names to ids, from our zone table: upper-case letters and digits only on both sides.
const key = s => s.toUpperCase().replace(/[^A-Z0-9]/g, '')
const zoneIds = new Map()
for (const line of fs.readFileSync(path.join(__dirname, '..', 'resources', 'zone-seed-data.csv'), 'utf8').split(/\r?\n/).slice(1)) {
  const m = line.match(/^(\d+),("(?:[^"]|"")*"|[^,]*)/)
  if (m) zoneIds.set(key(m[2].replace(/^"|"$/g, '')), Number(m[1]))
}
const unmatched = new Set()
const zoneId = name => {
  const id = zoneIds.get(key(name))
  if (id === undefined) unmatched.add(name)
  return id
}

const MISSION_LOGS = {
  sandoria: "San d'Oria", bastok: 'Bastok', windurst: 'Windurst',
  zilart: 'Rise of the Zilart', rotz: 'Rise of the Zilart', cop: 'Chains of Promathia', toau: 'Treasures of Aht Urhgan',
  wotg: 'Wings of the Goddess', acp: 'A Crystalline Prophecy', amk: "A Moogle Kupo d'Etat", asa: 'A Shantotto Ascension',
  soa: 'Seekers of Adoulin', rov: "Rhapsodies of Vana'diel", tvr: 'The Voracious Resurgence', assault: 'Assault', campaign: 'Campaign',
}
const QUEST_LOGS = {
  sandoria: "San d'Oria", bastok: 'Bastok', windurst: 'Windurst', jeuno: 'Jeuno', otherAreas: 'Other Areas', outlands: 'Outlands',
  ahtUrhgan: 'Aht Urhgan', crystalWar: 'Crystal War', abyssea: 'Abyssea', adoulin: 'Adoulin', coalition: 'Coalition', hiddenQuests: 'Hidden',
}

// Titles by constant (xi.quest.id.bastok.A_FLASH_IN_THE_PAN), from the quest and mission files' headers.
const titles = new Map()
const titleCase = c => c.toLowerCase().split('_').map(w => w && w[0].toUpperCase() + w.slice(1)).join(' ')

const EVENT = /\b(?:progressEvent|event|progressCutscene|cutscene|startEvent|startCutscene|startOptionalCutscene|progressOptionalCutscene|importantEvent|replaceEvent|priorityEvent)\(\s*(0x[0-9a-fA-F]+|\d+)/g
const FINISH = /\[(0x[0-9a-fA-F]+|\d+)\]\s*=\s*function\s*\(\s*player\s*,\s*csid/g
const REF = /xi\.(quest|mission)\.id\.(\w+)\.(\w+)/

const scenes = {}
function put(zone, event, entry) {
  if (zone === undefined || !Number.isFinite(event)) return
  const k = `${zone}:${event}`
  const had = scenes[k]
  // Missions over quests; the quest and mission files over the zone scripts' guesses.
  if (had && had.rank <= entry.rank) return
  scenes[k] = entry
}

/** An NPC's script name as shown: qm12 is a ??? marker, a bare number no name at all. */
const npcName = s => /^qm(\d|_|$)/i.test(s) ? '???' : /^[\s_\d]+$/.test(s) ? null : s.replace(/_/g, ' ')

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.lua')) out.push(p)
  }
  return out
}

// 1. The quest and mission files.
for (const kind of ['mission', 'quest']) {
  for (const file of walk(path.join(scripts, kind + 's'))) {
    const text = fs.readFileSync(file, 'utf8')
    const head = text.split('\n').slice(0, 4).filter(l => /^--\s*\S/.test(l) && !/^-+$/.test(l.trim())).map(l => l.replace(/^--\s*/, '').trim())
    const decl = text.match(kind === 'mission' ? /Mission:new\(\s*xi\.mission\.log_id\.(\w+)\s*,\s*xi\.mission\.id\.(\w+)\.(\w+)/ : /Quest:new\(\s*xi\.questLog\.(\w+)\s*,\s*xi\.quest\.id\.(\w+)\.(\w+)/)
    if (!decl) continue
    const area = decl[2], constant = decl[3]
    let title = head[0] && !/^(Log ID|Area|NOTE)/i.test(head[0]) ? head[0] : titleCase(constant)
    // A mission's number line ("Promathia 1-1") rides along.
    if (kind === 'mission' && head[1] && /\d+-\d+/.test(head[1])) title = `${title} (${head[1].match(/\d+-\d+/)[0]})`
    const log = kind === 'mission' ? MISSION_LOGS[area] ?? area : QUEST_LOGS[area] ?? area
    titles.set(`${kind}.${area}.${constant}`, [title, log])
    let zone, npc = null
    for (const line of text.split('\n')) {
      const z = line.match(/^\s*\[xi\.zone\.(\w+)\]\s*=/)
      if (z) { zone = zoneId(z[1]); npc = null; continue }
      const n = line.match(/^\s*\['([^']+)'\]\s*=/)
      if (n) npc = npcName(n[1])
      for (const re of [EVENT, FINISH]) {
        re.lastIndex = 0
        for (let m; (m = re.exec(line));) put(zone, Number(m[1]), { title, kind, log, npc, rank: kind === 'mission' ? 0 : 1 })
      }
    }
  }
}

// 2. The zone scripts: an event started beside a quest or mission test belongs to it (a guess, ranked last).
for (const zdir of fs.readdirSync(path.join(scripts, 'zones'), { withFileTypes: true })) {
  if (!zdir.isDirectory()) continue
  const zone = zoneId(zdir.name)
  for (const file of walk(path.join(scripts, 'zones', zdir.name))) {
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    const npc = /[\\/]npcs[\\/]/.test(file) ? npcName(path.basename(file, '.lua')) : null
    lines.forEach((line, i) => {
      EVENT.lastIndex = 0
      for (let m; (m = EVENT.exec(line));) {
        // The nearest quest or mission named on this line or the 12 before it, within the same handler.
        let ref = null
        for (let j = i; j >= Math.max(0, i - 12) && !ref; j--) {
          if (j < i && /^\S*(entity\.on|local function|function )/.test(lines[j])) break
          ref = lines[j].match(REF)
        }
        if (!ref) continue
        const t = titles.get(`${ref[1]}.${ref[2]}.${ref[3]}`)
        const log = t?.[1] ?? (ref[1] === 'mission' ? MISSION_LOGS[ref[2]] : QUEST_LOGS[ref[2]]) ?? ref[2]
        put(zone, Number(m[1]), { title: t?.[0] ?? titleCase(ref[3]), kind: ref[1], log, npc, rank: 2 })
      }
    })
  }
}

const out = {}
for (const k of Object.keys(scenes).sort((a, b) => { const [za, ea] = a.split(':').map(Number), [zb, eb] = b.split(':').map(Number); return za - zb || ea - eb })) {
  const s = scenes[k]
  out[k] = s.npc ? [s.title, s.kind, s.log, s.npc] : [s.title, s.kind, s.log]
}
const dest = path.join(__dirname, '..', 'resources', 'scene-names.json')
fs.writeFileSync(dest, JSON.stringify({ source: 'LandSandBoat scripts (GPL-3.0), facts only: zone, event number, quest or mission title and log', scenes: out }))
const by = r => Object.values(scenes).filter(s => s.rank === r).length
console.log(`${Object.keys(out).length} scenes named: ${by(0)} from mission files, ${by(1)} from quest files, ${by(2)} from zone scripts`)
if (unmatched.size) console.log('zone names not matched:', [...unmatched].join(', '))
