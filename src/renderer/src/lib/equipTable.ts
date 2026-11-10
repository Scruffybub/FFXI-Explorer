import rawFaces from '../../../../resources/face-paths.json'
import { fileIdPath, fileIdsOf } from './fileTable'
import { SKELETON_PATHS } from './ffxi-dat'

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
 * places off (2026-10-25). The Character builder uses this table too, and
 * model-dat-paths.json only as a fallback.
 */

const TYPE_SIZE = 0x1b0
const SLOT_SIZE = 0x30
const FACES = rawFaces as Record<string, { path: string }[]>

let cached: { root: string; table: Promise<DataView | null> } | null = null
let dllCached: { root: string; dll: Promise<DataView> } | null = null

/** FFXiMain.dll, read once per install for both tables. */
function gameDll(root: string): Promise<DataView> {
  if (dllCached?.root !== root) dllCached = { root, dll: window.ffxi.readDat(root, 'FFXiMain.dll').then(b => new DataView(b)) }
  return dllCached.dll
}

async function findTable(root: string): Promise<DataView | null> {
  const dll = await gameDll(root)
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

/** Body type in the table for a look's race: 1-8 as is, the children 29-31 at 9-11, the chocobos 32-36 at 12-16. */
export function bodyType(race: number): number | null {
  if (race >= 1 && race <= 8) return race
  if (race >= 29 && race <= 36) return race - 20
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

/**
 * How many models the game's table holds for a race and slot (0 face, 1 head
 * .. 8 ranged); 0 when the table was not found. Many of the higher numbers
 * are unused and point at a placeholder.
 */
export async function appearanceCount(root: string, race: number, slot: number): Promise<number> {
  const type = bodyType(race)
  const t = await table(root)
  if (!t || type === null) return 0
  let count = 0
  for (let i = 0; i < 6; i++) {
    const at = TYPE_SIZE * (type - 1) + SLOT_SIZE * slot + 8 * i
    if (at + 8 > t.byteLength) break
    if (t.getUint32(at, true)) count += t.getUint32(at + 4, true)
  }
  return count
}

/** Whether a DAT holds a texture block (type 0x20): 16-byte block headers, type in the low 7 bits, length in 16-byte units above. */
function hasTexture(dat: DataView): boolean {
  for (let at = 0; at + 8 <= dat.byteLength;) {
    const packed = dat.getUint32(at + 4, true)
    if ((packed & 0x7f) === 0x20) return true
    const units = (packed >>> 7) & 0x7ffff
    if (!units) return false
    at += units * 16
  }
  return false
}

/**
 * The faces the game keeps for NPCs (numbers 16-31 of a race's 32) that are
 * faces of their own: most of the 16 point back at a player face (Hume male
 * 17-24 are 1-8 again); Hume male has 6 others, Elvaan male 5. One more is
 * empty (Hume male 16, ROM/380/26: no texture, nothing to draw), so a face
 * must carry a texture block. Returned as face numbers, for the Character
 * builder.
 */
export async function npcFaces(root: string, race: number): Promise<number[]> {
  const player = new Set<string>()
  for (let i = 0; i < 16; i++) { const p = await appearancePath(root, race, 0, i); if (p) player.add(p) }
  const out: number[] = []
  for (let i = 16; i < 32; i++) {
    const p = await appearancePath(root, race, 0, i)
    if (!p || player.has(p)) continue
    player.add(p)
    if (hasTexture(new DataView(await window.ffxi.readDat(root, p)))) out.push(i)
  }
  return out
}

/**
 * The race file (skeleton, and for the children their idle) for any look
 * race, from the game's own per-race table in FFXiMain.dll: one u16 file
 * number per race 0-40. It is found by content, the run whose entries 1, 2,
 * 3, 7 and 8 are the player races' skeletons (SKELETON_PATHS). It gives
 * 29 Mithra child ROM/61/110, 30 Hume girl ROM/61/58, 31 Hume boy ROM/61/85
 * (skeleton "kids", motions idl0/wlk0/run0) and 32-36 the chocobos
 * ROM/169/11 (2026-10-25).
 */
let raceCached: { root: string; table: Promise<DataView | null> } | null = null

async function findRaceTable(root: string): Promise<DataView | null> {
  const dll = await gameDll(root)
  const known = await Promise.all(([[1, SKELETON_PATHS[1]], [2, SKELETON_PATHS[2]], [3, SKELETON_PATHS[3]], [7, SKELETON_PATHS[7]], [8, SKELETON_PATHS[8]]] as const)
    .map(async ([race, path]) => [race, await fileIdsOf(root, path)] as const))
  for (let at = 0; at + 82 <= dll.byteLength; at += 2) {
    if (known.every(([race, ids]) => ids.includes(dll.getUint16(at + race * 2, true)))) {
      return new DataView(dll.buffer, dll.byteOffset + at, 82)
    }
  }
  return null
}

export async function raceFilePath(root: string, race: number): Promise<string | null> {
  if (raceCached?.root !== root) raceCached = { root, table: findRaceTable(root).catch(() => null) }
  const t = await raceCached.table
  if (!t || race < 0 || race * 2 + 2 > t.byteLength) return null
  const id = t.getUint16(race * 2, true)
  return id ? fileIdPath(root, id) : null
}
