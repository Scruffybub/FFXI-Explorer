import rawStations from '../../../../resources/npc-stations.json'
import { parseDatFile, type ParsedAnimation, type ParsedDatFile } from './ffxi-dat'
import { composeCharacter, loadMovementClips } from './characterModel'
import { appearancePath } from './equipTable'
import { fileIdPath } from './fileTable'
import { clipsForMotion } from './motions'

/**
 * Scene -> NPCs: where each zone's NPCs stand and what they look like.
 *
 * The client never holds NPC positions (the server sends them), so the table
 * is built from LandSandBoat's per-zone npcs.yaml by
 * scripts/build-npc-stations.cjs: positions, facing and appearance numbers
 * only. A look is one of two kinds, as in the game's own appearance data:
 *
 *   a model number   the NPC is one self-contained file (merchants, moogles,
 *                    guards, crystals), file number by range below
 *   race and gear    the NPC is assembled like a player character
 *                    (characterModel composeCharacter), face and eight slots
 *
 * Model number -> file number (xim NpcTable, format facts only): under 0x5DC
 * it is 0x514 + model, under 0xBB8 0xC477 + model, under 0xC79 0x17A8B +
 * model, above that 0x180F2 + model (xim's own guess). Checked against the
 * named model list: Bastok Markets' merchants land on Hume merchant files,
 * its moogle on Moogle 1.
 *
 * The face and gear files come from the game's own table (equipTable).
 *
 * Not yet (2026-10-25): child races (29-31; no skeleton known), chocobos
 * and automatons as looks of their own, the effects some NPC files
 * carry (Home Point crystals, Planar Rifts, gathering sparkles), sitting and
 * other poses from the table's animation numbers.
 */

/** [index, x, y, z, facing 0-255, look]: look a model number or [race, face, head .. ranged]. */
export type NpcStation = [number, number, number, number, number, number | number[]]

const STATIONS = rawStations as unknown as Record<string, NpcStation[]>

export function npcStations(zoneId: number): NpcStation[] {
  return STATIONS[String(zoneId)] ?? []
}

export function npcModelFileId(model: number): number {
  if (model < 0x5dc) return 0x514 + model
  if (model < 0xbb8) return 0xc477 + model
  if (model < 0xc79) return 0x17a8b + model
  return 0x180f2 + model
}

export interface NpcModel {
  model: ParsedDatFile
  /** What it does standing at its post; none stands in bind pose. */
  idle: ParsedAnimation[]
}

/** Equipment slot ids (characterModel SLOTS) in the look's order. */
const LOOK_SLOTS = [2, 3, 4, 5, 6, 7, 8, 9]

async function loadLook(root: string, look: number | number[]): Promise<NpcModel | null> {
  if (typeof look === 'number') {
    const path = await fileIdPath(root, npcModelFileId(look))
    if (!path) return null
    const model = parseDatFile(await window.ffxi.readDat(root, path))
    return model.meshes.length ? { model, idle: clipsForMotion(model.animations, null) } : null
  }
  const [race, face, ...gear] = look
  const paths = {
    face: await appearancePath(root, race, 0, face),
    gear: Object.fromEntries(await Promise.all(LOOK_SLOTS.map(async (slot, i) => [slot, await appearancePath(root, race, i + 1, gear[i] ?? 0)] as const))),
  }
  const model = await composeCharacter(root, { race, face, equipment: {}, animation: null, paths })
  if (!model.meshes.length) return null
  const idle = (await loadMovementClips(root, race))?.idle ?? []
  return { model, idle }
}

const cache = new Map<string, Promise<NpcModel | null>>()

/** Forgets the loaded looks: a town's hundred characters, textures and all, should not outlive the zone. */
export function clearNpcModels(): void {
  cache.clear()
}

/** Loads each look once (until cleared); null when it has no file or no mesh. */
export function loadNpcModel(root: string, look: number | number[]): Promise<NpcModel | null> {
  const key = root + '|' + (typeof look === 'number' ? look : look.join(','))
  let p = cache.get(key)
  if (!p) {
    p = loadLook(root, look).catch(() => null)
    cache.set(key, p)
  }
  return p
}
