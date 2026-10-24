/**
 * Builds resources/spell-effects.json: each spell's id, name, effect number
 * (its effect file is 0xAF0 + that, lib/spellList.ts), magic skill, element
 * and valid targets.
 *
 *   node scripts/build-spell-effects.cjs <LandSandBoat sql/spell_list.sql>
 *
 * The client never says which effect a spell plays (the server sends it), so
 * the numbers come from LandSandBoat (GPL-3.0; see THIRD-PARTY-NOTICES.md).
 * Only those facts are kept, not the SQL.
 */
const fs = require('fs')
const inp = process.argv[2]
const out = require('path').join(__dirname, '..', 'resources', 'spell-effects.json')
const sql = fs.readFileSync(inp, 'utf8')
const vars = {}
for (const m of sql.matchAll(/SET @(\w+)\s*=\s*(\d+);/g)) vars[m[1]] = Number(m[2])
const skillNames = Object.fromEntries(Object.entries(vars).filter(([k]) => k.startsWith('SKILL_')).map(([k, v]) => [v, k.slice(6).toLowerCase().replace(/_/g, ' ')]))
const elementNames = Object.fromEntries(Object.entries(vars).filter(([k]) => k.startsWith('ELEMENT_')).map(([k, v]) => [v, k.slice(8).toLowerCase()]))
const roman = /^(i|ii|iii|iv|v|vi)$/
const title = s => s.split('_').map(w => roman.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
const rows = []
for (const m of sql.matchAll(/INSERT INTO `spell_list` VALUES \((.*)\);/g)) {
  // Split on commas outside quotes.
  const f = m[1].match(/'(?:[^'\\]|\\.)*'|[^,]+/g).map(x => x.trim())
  const val = x => x.startsWith('@') ? vars[x.slice(1)] : x.startsWith("'") ? x.slice(1, -1) : Number(x)
  const [id, name, , , , element, , targets, skill] = f.map(val)
  const animation = val(f[14])
  rows.push({ id, name: title(name), effect: animation, skill: skillNames[skill] ?? String(skill), element: elementNames[element] ?? String(element), targets })
}
fs.writeFileSync(out, JSON.stringify(rows))
console.log(rows.length, 'spells; sample', JSON.stringify(rows.slice(0, 3)), JSON.stringify(rows.find(r => r.id === 144)))
console.log('skills', [...new Set(rows.map(r => r.skill))].join(', '))
