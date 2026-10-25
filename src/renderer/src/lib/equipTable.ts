import rawFaces from '../../../../resources/face-paths.json'
import { fileIdPath, fileIdsOf } from './fileTable'

/**
 * The game's own appearance table: for each body type and slot, which file
 * holds face or gear model N. It lives in FFXiMain.dll in the install, so it
 * is read from there, never shipped.
 *
 * Layout (format facts from xim's EquipmentModelTable): 0x1B0 bytes per body
 * type, 0x30 per slot (face 0, head 1, body 2 .. ranged 8, the high nibble of
 * a gear look value), each slot up to six runs of (first file number u32,
 * count u32); model N is N places into the runs laid end to end. Body types
 * 1-8 are the player races, 9-11 the Mithra child, Hume girl and Hume boy,
 * 12-16 chocobos.
 *
 * The table's place in the DLL moves between game versions, so it is found
 * by content: the run holding the Hume male's first face (face-paths.json),
 * 32 faces long, checked against the Hume female's. Each race has 32 faces:
 * the 16 a player can pick and 16 kept for NPCs.
 *
 * Why not model-dat-paths.json (Vanalytics, keyed by item): it lists only the
 * models some item uses, and around a model it has missed, its numbering
 * drifts. Elvaan male body 101, which a San d'Oria stable hand wears, is not
 * in it, so he stood without a torso; Hume male bodies 177-191 sit five
 * places off (2026-10-25). The Character builder still uses it.
 */

const TYPE_SIZE = 0x1b0
const SLOT_SIZE = 0x30
const FACES = rawFaces as Record<string, { path: string }[]>

let cached: { root: string; table: Promise<DataView | null> } | null = null

async function findTable(root: string): Promise<DataView | null> {
  const dll = new DataView(await window.ffxi.readDat(root, 'FFXiMain.dll'))
  const first = FACES['1']?.[0]?.path
  const second = FACES['2']?.[0]?.path
  if (!first || !second) return null
  const ids = await fileIdsOf(root, first)
  const humeF = (await fileIdsOf(root, second)).map(Number)
  for (let at = 0; at + 8 <= dll.byteLength; at += 4) {
    if (dll.getUint32(at + 4, true) !== 32 || !ids.includes(dll.getUint32(at, true))) continue
    if (at + TYPE_SIZE + 4 > dll.byteLength || !humeF.includes(dll.getUint32(at + TYPE_SIZE, true))) continue
    return new DataView(dll.buffer, dll.byteOffset + at, Math.min(TYPE_SIZE * 16, dll.byteLength - at))
  }
  return null
}

function table(root: string): Promise<DataView | null> {
  if (cached?.root !== root) cached = { root, table: findTable(root).catch(() => null) }
  return cached.table
}

/** Body type in the table for a look's race: 1-8 as is, the children 29-31 at 9-11. */
export function bodyType(race: number): number | null {
  if (race >= 1 && race <= 8) return race
  if (race >= 29 && race <= 31) return race - 20
  return null
}

/**
 * The file for face or gear `index` (slot 0 face, 1 head .. 8 ranged) on a
 * race; null when the install's table has no such model or was not found.
 */
export async function appearancePath(root: string, race: number, slot: number, index: number): Promise<string | null> {
  const type = bodyType(race)
  const t = await table(root)
  if (!t || type === null) return null
  let before = 0
  for (let i = 0; i < 6; i++) {
    const at = TYPE_SIZE * (type - 1) + SLOT_SIZE * slot + 8 * i
    if (at + 8 > t.byteLength) return null
    const first = t.getUint32(at, true), count = t.getUint32(at + 4, true)
    if (!first) continue
    if (index < before + count) return fileIdPath(root, first + index - before)
    before += count
  }
  return null
}
