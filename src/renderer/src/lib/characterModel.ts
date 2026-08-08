import rawEquip from '../../../../resources/model-dat-paths.json'
import rawFaces from '../../../../resources/face-paths.json'
import {
  parseDatFile, parseSkeletonDat, SKELETON_PATHS,
  type ParsedDatFile, type ParsedMesh, type ParsedTexture,
} from './ffxi-dat'

/**
 * Builds a player character out of a race skeleton plus equipment DATs.
 *
 * Unlike an NPC or monster — which is one self-contained DAT with its own
 * skeleton — a player character is assembled at runtime. The race skeleton is a
 * separate file, and every visible piece is its own DAT whose vertices are
 * transformed into place by that skeleton's bind-pose matrices. That is exactly
 * what `parseDatFile`'s `skelMatrices` argument is for.
 *
 * Path tables come from Vanalytics: `model-dat-paths.json` keyed `"race:slot"`
 * and `face-paths.json` keyed by race.
 */

export interface RaceEntry { id: number; name: string }

/** Matches the skeleton table in SkeletonParser. */
export const RACES: RaceEntry[] = [
  { id: 1, name: 'Hume Male' },
  { id: 2, name: 'Hume Female' },
  { id: 3, name: 'Elvaan Male' },
  { id: 4, name: 'Elvaan Female' },
  { id: 5, name: 'Tarutaru Male' },
  { id: 6, name: 'Tarutaru Female' },
  { id: 7, name: 'Mithra' },
  { id: 8, name: 'Galka' },
]

export interface SlotEntry { id: number; label: string }

/**
 * The eight slots that have a visible model, which is exactly what the game's
 * 20-byte "look" structure carries.
 *
 * Slot numbering is inferred from the path table rather than documented: the
 * counts line up unambiguously — slot 7 holds 675 models (main weapons, by far
 * the largest set) and slot 9 holds 129 (ranged, the smallest). Race 1's
 * skeleton is ROM/27/82.dat and its slot-2 models begin at ROM/27/103.dat, in
 * the same ROM directory.
 */
export const SLOTS: SlotEntry[] = [
  { id: 2, label: 'Head' },
  { id: 3, label: 'Body' },
  { id: 4, label: 'Hands' },
  { id: 5, label: 'Legs' },
  { id: 6, label: 'Feet' },
  { id: 7, label: 'Main' },
  { id: 8, label: 'Sub' },
  { id: 9, label: 'Ranged' },
]

type EquipTable = Record<string, Record<string, string>>
type FaceTable = Record<string, { name: string; path: string }[]>

const EQUIP = rawEquip as EquipTable
const FACES = rawFaces as FaceTable

export interface ModelOption { index: number; path: string }

/** Every model available for a race and slot, ordered by model index. */
export function equipOptions(race: number, slot: number): ModelOption[] {
  const table = EQUIP[`${race}:${slot}`]
  if (!table) return []
  return Object.entries(table)
    .map(([index, path]) => ({ index: Number(index), path }))
    .sort((a, b) => a.index - b.index)
}

export function faceOptions(race: number): { name: string; path: string }[] {
  return FACES[String(race)] ?? []
}

/** Which pieces the character is wearing. Slot id → model index. */
export type Equipment = Record<number, number | null>

export interface CharacterSpec {
  race: number
  /** Index into `faceOptions(race)`, or null for no face. */
  face: number | null
  equipment: Equipment
}

export interface ComposedCharacter extends ParsedDatFile {
  /** What actually loaded, for reporting failures without failing the build. */
  loaded: { label: string; path: string; meshes: number }[]
  failed: { label: string; path: string; reason: string }[]
}

/**
 * Load and merge every piece of a character.
 *
 * A piece that fails to load is reported rather than thrown: a missing hand
 * model should not cost you the rest of the character.
 */
export async function composeCharacter(
  ffxiPath: string,
  spec: CharacterSpec,
): Promise<ComposedCharacter> {
  const skeletonPath = SKELETON_PATHS[spec.race]
  if (!skeletonPath) throw new Error(`No skeleton known for race ${spec.race}`)

  const skelBuffer = await window.ffxi.readDat(ffxiPath, skeletonPath)
  const skeleton = parseSkeletonDat(skelBuffer)
  if (!skeleton) throw new Error(`Could not parse the skeleton at ${skeletonPath}`)

  const pieces: { label: string; path: string }[] = []

  const faces = faceOptions(spec.race)
  if (spec.face !== null && faces[spec.face]) {
    pieces.push({ label: 'Face', path: faces[spec.face].path })
  }
  for (const slot of SLOTS) {
    const chosen = spec.equipment[slot.id]
    if (chosen == null) continue
    const table = EQUIP[`${spec.race}:${slot.id}`]
    const path = table?.[String(chosen)]
    if (path) pieces.push({ label: slot.label, path })
  }

  const meshes: ParsedMesh[] = []
  const textures: ParsedTexture[] = []
  const loaded: ComposedCharacter['loaded'] = []
  const failed: ComposedCharacter['failed'] = []

  for (const piece of pieces) {
    try {
      const buffer = await window.ffxi.readDat(ffxiPath, piece.path)
      const part = parseDatFile(buffer, skeleton.matrices)
      if (part.meshes.length === 0) {
        failed.push({ ...piece, reason: 'no mesh blocks' })
        continue
      }
      // Texture indices are per-file, so they have to be rebased as the pools
      // are concatenated or every piece would sample the first one's textures.
      const base = textures.length
      textures.push(...part.textures)
      for (const m of part.meshes) {
        meshes.push({ ...m, materialIndex: m.materialIndex + base })
      }
      loaded.push({ ...piece, meshes: part.meshes.length })
    } catch (err) {
      failed.push({ ...piece, reason: String(err) })
    }
  }

  // Equipment DATs carry no animation; player animations live in separate files
  // (Vanalytics' animation-paths.json), which is a later step.
  return { meshes, textures, skeleton, animations: [], loaded, failed }
}
