/**
 * Builds resources/ability-effects.json, resources/mob-skill-effects.json and
 * resources/mob-skill-lists.json:
 * each job ability's and monster move's id, name and animation number (its
 * effect file: lib/skillList.ts).
 *
 *   node scripts/build-skill-effects.cjs <LandSandBoat sql folder>
 *
 * The client never says which effect an ability or a monster move plays (the
 * server sends it), so the numbers come from LandSandBoat's abilities.sql and
 * mob_skills.sql, and which family has which from mob_skill_lists.sql
 * (GPL-3.0; see THIRD-PARTY-NOTICES.md). Only those facts are
 * kept, not the SQL. Abilities: job abilities only (actionType 6); weapon
 * skills and dances come from the animation list per race instead.
 */
const fs = require('fs')
const path = require('path')

const dir = process.argv[2]
if (!dir) { console.error('usage: node scripts/build-skill-effects.cjs <LandSandBoat sql folder>'); process.exit(1) }
const out = path.join(__dirname, '..', 'resources')

const roman = /^(i|ii|iii|iv|v|vi)$/
const title = s => s.split('_').map(w => roman.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
/** Values of each INSERT row, split on commas outside quotes. */
function rows(sql, table) {
  const re = new RegExp('INSERT INTO `' + table + '` VALUES \\((.*)\\);', 'g')
  return [...sql.matchAll(re)].map(m => m[1].match(/'(?:[^'\\]|\\.)*'|[^,]+/g).map(x => x.trim()))
}
const num = x => Number(x)
const str = x => x.replace(/^'|'$/g, '')

const JOBS = ['', 'WAR', 'MNK', 'WHM', 'BLM', 'RDM', 'THF', 'PLD', 'DRK', 'BST', 'BRD', 'RNG', 'SAM', 'NIN', 'DRG', 'SMN', 'BLU', 'COR', 'PUP', 'DNC', 'SCH', 'GEO', 'RUN']

const abilities = rows(fs.readFileSync(path.join(dir, 'abilities.sql'), 'utf8'), 'abilities')
  // Pet abilities (ids 512 up, and Concentric Pulse..) all carry animation 94,
  // the master's "command your pet" gesture, not the pet's own effect: listed,
  // they all played the same thing. The pet's own needs pet_skills.sql.
  .filter(f => num(f[12]) === 6 && num(f[9]) > 0 && num(f[9]) !== 94)
  .map(f => ({ id: num(f[0]), name: title(str(f[1])), job: JOBS[num(f[2])] ?? String(f[2]), animation: num(f[9]) }))
fs.writeFileSync(path.join(out, 'ability-effects.json'), JSON.stringify(abilities))

const mobSkills = rows(fs.readFileSync(path.join(dir, 'mob_skills.sql'), 'utf8'), 'mob_skills')
  .map(f => ({ id: num(f[0]), name: title(str(f[2])), animation: num(f[1]) }))
  .filter(s => s.name && s.animation > 0)
fs.writeFileSync(path.join(out, 'mob-skill-effects.json'), JSON.stringify(mobSkills))

console.log(abilities.length, 'job abilities;', mobSkills.length, 'monster moves')
console.log(JSON.stringify(abilities.slice(0, 2)), JSON.stringify(mobSkills.slice(0, 2)))

// Which moves each monster family has (mob_skill_lists.sql), by list name;
// lists sharing a name (two "Goblin") are merged. The browser matches a
// creature to a list by name (lib/skillList.ts movesForCreature).
const listsSql = path.join(dir, 'mob_skill_lists.sql')
if (fs.existsSync(listsSql)) {
  const lists = {}
  for (const f of rows(fs.readFileSync(listsSql, 'utf8'), 'mob_skill_lists')) {
    const name = str(f[0])
    if (!name || name === 'NULL') continue
    ;(lists[name] ??= new Set()).add(num(f[2]))
  }
  const out2 = Object.fromEntries(Object.entries(lists).map(([k, v]) => [k, [...v].sort((a, b) => a - b)]))
  fs.writeFileSync(path.join(out, 'mob-skill-lists.json'), JSON.stringify(out2))
  console.log(Object.keys(out2).length, 'monster skill lists')
}
