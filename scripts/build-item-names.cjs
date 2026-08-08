/**
 * Turns LandSandBoat's item_equipment.sql into a compact model-index → item
 * name table for the character builder.
 *
 *   node scripts/build-item-names.cjs <path-to-item_equipment.sql>
 *
 * Writes resources/item-names.json, keyed by our own slot ids (the ones in
 * characterModel.ts), then by model index, to an array of item names.
 *
 * Many items share a model — every dyed or rank variant of the same armour
 * points at one MId — so the value is a list, shortest name first, and the UI
 * shows the first with a "+N" count.
 *
 * Only names and numbers are extracted; the SQL itself is not vendored.
 */
const fs = require('fs')
const path = require('path')

const src = process.argv[2]
if (!src) {
  console.error('usage: node scripts/build-item-names.cjs <item_equipment.sql>')
  process.exit(1)
}

/**
 * LandSandBoat's `slot` is the game's equipment bitfield. Map the ones that
 * have a visible model onto the slot ids characterModel.ts uses.
 */
const SLOT_BIT_TO_ID = {
  1: 7,    // main
  2: 8,    // sub
  4: 9,    // ranged
  16: 2,   // head
  32: 3,   // body
  64: 4,   // hands
  128: 5,  // legs
  256: 6,  // feet
}

/** "hexed_haubert" → "Hexed Haubert". */
function prettify(raw) {
  return raw
    .split('_')
    .filter(Boolean)
    .map(w => (w.length <= 2 && w !== 'of' ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ')
    .replace(/\bOf\b/g, 'of')
}

const text = fs.readFileSync(src, 'utf8')
const table = {}
let rows = 0
let mapped = 0

// INSERT INTO `item_equipment` VALUES (10240,'hexed_haubert',99,0,8641,5,0,0,32,0,0,0);
const re = /INSERT INTO `item_equipment` VALUES \(([^)]*)\);/g
let m
while ((m = re.exec(text)) !== null) {
  const parts = m[1].split(',')
  if (parts.length < 9) continue
  rows++

  const name = parts[1].trim().replace(/^'|'$/g, '')
  const modelId = Number(parts[5])
  const slotBits = Number(parts[8])
  if (!name || name === 'NULL' || !Number.isFinite(modelId) || !Number.isFinite(slotBits)) continue

  // An item can be equippable in more than one slot (a weapon usable in main or
  // sub); record it under each one that has its own model space.
  for (const [bit, slotId] of Object.entries(SLOT_BIT_TO_ID)) {
    if ((slotBits & Number(bit)) === 0) continue
    const slotTable = (table[slotId] ??= {})
    const list = (slotTable[modelId] ??= [])
    const pretty = prettify(name)
    if (!list.includes(pretty)) list.push(pretty)
    mapped++
  }
}

// Shortest first: the base item reads better than "Hexed Haubert +2 (Augmented)".
for (const slotTable of Object.values(table)) {
  for (const key of Object.keys(slotTable)) {
    slotTable[key].sort((a, b) => a.length - b.length || a.localeCompare(b))
    // A handful of models are shared by dozens of items; keep it readable.
    if (slotTable[key].length > 6) slotTable[key] = slotTable[key].slice(0, 6)
  }
}

const out = path.join(__dirname, '..', 'resources', 'item-names.json')
fs.writeFileSync(out, JSON.stringify(table))

const summary = Object.entries(table)
  .map(([slot, t]) => `${slot}:${Object.keys(t).length}`)
  .sort()
  .join(' ')
console.log(`parsed ${rows} rows, ${mapped} slot mappings`)
console.log(`models per slot → ${summary}`)
console.log(`wrote ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`)
