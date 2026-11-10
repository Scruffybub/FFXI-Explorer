import rawStations from '../../../../resources/npc-stations.json'
import rawActors from '../../../../resources/npc-actors.json'
import rawMarks from '../../../../resources/npc-marks.json'
import rawLsbNames from '../../../../resources/npc-names-lsb.json'
import { parseAnimationDat, parseDatFile, parseZoneFile, SKELETON_PATHS, type ParsedAnimation, type ParsedDatFile, type ParsedZone } from './ffxi-dat'
import { composeCharacter, loadMovementClips } from './characterModel'
import { appearancePath, raceFilePath } from './equipTable'
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
 * Children (races 29-31) and chocobos (32-36, LandSandBoat's "face" byte;
 * their parts are gear in body types 12-16) take their skeleton and idle from
 * their race file (equipTable raceFilePath). LandSandBoat's "automaton" looks
 * are model numbers (Al Zahbi's Mamool Ja standards).
 *
 * Not yet: effects
 * NPC files start from a routine rather than by themselves, sitting and
 * other poses from the table's animation numbers.
 */

/** [index, x, y, z, facing 0-255, look]: look a model number or [race, face, head .. ranged]. */
export type NpcStation = [number, number, number, number, number, number | number[]]

const STATIONS = rawStations as unknown as Record<string, NpcStation[]>
const ACTORS = rawActors as unknown as Record<string, NpcStation[]>
const MARKS = rawMarks as unknown as Record<string, NpcMark[]>

/**
 * The zone's scene-only NPCs (cutscene-only and hidden in LandSandBoat's
 * data): hidden in the town, shown only when a scene shows them.
 */
/** Actors with nothing to draw (markers, doors, ships): index, x, y, z, facing (-1 for no position), and a door's id (MZB +0x34). */
export type NpcMark = [number, number, number, number, number, string?]
export function npcMarks(zoneId: number): NpcMark[] {
  return MARKS[String(zoneId)] ?? []
}

/** A cutscene-only NPC's name from LandSandBoat, for the ones the game's own list leaves out. */
const LSB_NAMES = rawLsbNames as unknown as Record<string, Record<string, string>>
export function lsbName(zoneId: number, index: number): string | null {
  return LSB_NAMES[String(zoneId)]?.[String(index)] ?? null
}

export function sceneActors(zoneId: number): NpcStation[] {
  return ACTORS[String(zoneId)] ?? []
}

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
  /** Its walk, for a roaming monster (mobSpawns); empty when it has none (it glides in its idle). */
  walk: ParsedAnimation[]
  /** Its talking jaw (mou4: one bone, a two-second open and close), laid over it while it speaks in a cutscene. */
  mouth: ParsedAnimation[]
  /** Its eyelids (eye3: two bones, a blink), laid over it every few seconds. */
  blink: ParsedAnimation[]
  /**
   * The file read as a small zone when it carries generators that run by
   * themselves: a Home Point crystal's glow and motes (model 51, `bind`),
   * a gathering point's sparkle (`kira/act_`). Their positions are the
   * NPC's own, from its feet (NpcStations places them).
   */
  effects: ParsedZone | null
}

/** Equipment slot ids (characterModel SLOTS) in the look's order. */
const LOOK_SLOTS = [2, 3, 4, 5, 6, 7, 8, 9]

async function loadLook(root: string, look: number | number[]): Promise<NpcModel | null> {
  if (typeof look === 'number') {
    const path = await fileIdPath(root, npcModelFileId(look))
    if (!path) return null
    const buffer = await window.ffxi.readDat(root, path)
    const model = parseDatFile(buffer)
    if (!model.meshes.length) return null
    let effects: ParsedZone | null = null
    try {
      const zone = parseZoneFile(buffer)
      const idle = idleGenerators(zone)
      const spawns = zone.spawns?.filter(sp => sp.emission.autoRun && (!idle || idle.has(sp.generator))) ?? []
      if (spawns.length) effects = { ...zone, spawns }
    } catch { /* a model without effects */ }
    const walk = model.animations.filter(c => c.name.startsWith('wlk'))
    return { model, idle: clipsForMotion(model.animations, null), walk, mouth: model.animations.filter(c => c.name.startsWith('mou')), blink: model.animations.filter(c => c.name.startsWith('eye')), effects }
  }
  const [race, face, ...gear] = look
  const paths = {
    face: await appearancePath(root, race, 0, face),
    gear: Object.fromEntries(await Promise.all(LOOK_SLOTS.map(async (slot, i) => [slot, await appearancePath(root, race, i + 1, gear[i] ?? 0)] as const))),
  }
  // The children (29-31) have no entry in SKELETON_PATHS or the animation
  // list: their race file holds the skeleton and the idle (idl0).
  const own = SKELETON_PATHS[race] ? null : await raceFilePath(root, race)
  if (!SKELETON_PATHS[race] && !own) return null
  const model = await composeCharacter(root, { race, face, equipment: {}, animation: null, paths, skeletonPath: own ?? undefined })
  if (!model.meshes.length) return null
  if (own) {
    const clips = parseAnimationDat(await window.ffxi.readDat(root, own))
    return { model, idle: clips.filter(c => c.name.startsWith('idl')), walk: clips.filter(c => c.name.startsWith('wlk')), mouth: clips.filter(c => c.name.startsWith('mou')), blink: clips.filter(c => c.name.startsWith('eye')), effects: null }
  }
  const moves = await loadMovementClips(root, race)
  const faceClips = await raceFace(root, race)
  return { model, idle: moves?.idle ?? [], walk: moves?.walk ?? [], mouth: faceClips.mouth, blink: faceClips.blink, effects: null }
}

export interface RaceFace { mouth: ParsedAnimation[]; blink: ParsedAnimation[] }
const faces = new Map<string, Promise<RaceFace>>()

/** A player race's talking jaw (mou4) and blink (eye3), from its race file (SKELETON_PATHS): NPCs dressed as one, and you. */
export function raceFace(root: string, race: number): Promise<RaceFace> {
  const key = root + '|' + race
  let p = faces.get(key)
  if (!p) {
    const path = SKELETON_PATHS[race]
    const none: RaceFace = { mouth: [], blink: [] }
    p = path
      ? window.ffxi.readDat(root, path).then(b => {
        const clips = parseAnimationDat(b)
        return { mouth: clips.filter(c => c.name.startsWith('mou')), blink: clips.filter(c => c.name.startsWith('eye')) }
      }).catch(() => none)
      : Promise.resolve(none)
    faces.set(key, p)
  }
  return p
}

/** Routines an NPC runs as it appears and stands (xim: efon and pop0 on spawn, @scd looped). */
const SPAWN_ROUTINES = ['init', 'aper', 'efon', 'pop0', '@scd']

/**
 * The generators an NPC file's spawn routines start, following the routines
 * they call and link; null when the file has none of those routines (its
 * self-running generators are then all on). Self-running alone is not enough:
 * a Synergy furnace's eight elemental streams are all flagged so, but only
 * its feeding routines (ef81..ef88) start them; drawn at once they included
 * the dark element's black blade (2026-10-25). A Home Point's `aper` starts
 * its crystal; a gathering point's init links str0, which starts its sparkle.
 */
function idleGenerators(zone: ParsedZone): Set<string> | null {
  const routines = zone.routines ?? []
  const byName = new Map(routines.map(r => [r.name, r]))
  const start = routines.filter(r => SPAWN_ROUTINES.includes(r.name))
  if (!start.length) return null
  const seen = new Set(start)
  const out = new Set<string>()
  for (let i = 0; i < start.length; i++) {
    for (const c of start[i].commands) {
      if (c.kind === 'generator') out.add(c.ref)
      if (c.kind !== 'routine' && c.kind !== 'link') continue
      const next = byName.get(c.ref)
      if (next && !seen.has(next)) { seen.add(next); start.push(next) }
    }
  }
  return out
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

/**
 * The zone's NPC names, from the install: file 0x1A40 + zone (zones above
 * 0xFF: 0x151DB + zone - 0x100), 32-byte entries of a 28-byte name and the
 * NPC's full id (xim ZoneNpcTableProvider). Keyed by the id's low 12 bits,
 * the index npc-stations.json keeps. Bastok Markets' starts "none",
 * Horatius, Samia, Malene, as LandSandBoat numbers them.
 */
export async function npcNames(root: string, zoneId: number): Promise<Map<number, string>> {
  const names = new Map<number, string>()
  const path = await fileIdPath(root, zoneId < 0x100 ? 0x1a40 + zoneId : 0x151db + zoneId - 0x100)
  if (!path) return names
  const bytes = new Uint8Array(await window.ffxi.readDat(root, path))
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let at = 0; at + 32 <= bytes.length; at += 32) {
    let end = at
    while (end < at + 28 && bytes[end] !== 0) end++
    const name = String.fromCharCode(...bytes.subarray(at, end))
    if (name) names.set(view.getUint32(at + 28, true) & 0xfff, name)
  }
  return names
}
