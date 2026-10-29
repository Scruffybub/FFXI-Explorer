import type { ParsedZone } from './ffxi-dat'

/**
 * Town interiors. FFXI keeps the inside of a town's shops and houses out of
 * the zone's model: each room is a file of its own (blocks named r_<n><town>:
 * r_2b for Bastok Markets' rooms), placed in the zone's own coordinates, and
 * the game opens the one the player walks into (and events open theirs with
 * op 0x75, XiZone::OpenIndoor: file 100 + the room number). Without them the
 * viewer showed shops as black holes and NPCs standing in nothing.
 *
 * The files by zone, found by scanning the install for zone-geometry files
 * with r_ names and matching each to the zone whose NPC posts fall inside its
 * rooms (2026-10-26): every group matched one zone, e.g. 14 r_2b files ->
 * Bastok Markets, 34 of its NPCs inside. Selbina's five rooms are named r_1s
 * like Southern San d'Oria's, hence a table rather than the names.
 */
const ROOMS: Record<number, number[]> = {
  230: [426, 427, 428, 429, 430, 431, 432, 433, 435, 436, 437, 438, 439, 440, 441, 442, 443, 444],
  231: range(449, 461),
  232: [464, 465, 467, 468, 469],
  233: range(471, 476),
  234: [359, 360, 361, 362, 363, 367, 368, 369, 370, 371],
  235: range(374, 387),
  236: range(415, 423),
  237: [393, 394, 395, 396, 397, 398, ...range(400, 411)],
  238: [479, ...range(481, 499)],
  239: range(501, 507),
  240: [...range(508, 513), 516],
  241: range(517, 524),
  242: range(525, 528),
  243: [...range(531, 536), ...range(538, 541)],
  244: range(543, 552),
  245: range(554, 566),
  246: [...range(568, 577), ...range(595, 598)],
  248: [580, 581, 582, 584, 585],
  249: [587, 588, 589, 590, 591, 593],
}

function range(a: number, b: number): number[] {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i)
}

/** The file numbers of a zone's rooms (none outside the towns). */
export function roomFileIds(zoneId: number): number[] {
  return ROOMS[zoneId] ?? []
}

/**
 * Adds rooms to the zone: their placed meshes and textures, indices shifted
 * past the zone's own. Only meshes a room places come along (an unplaced
 * prefab would draw at the origin); the rooms' lamps and lights don't.
 */
export function mergeRooms(zone: ParsedZone, rooms: ParsedZone[]): void {
  if (!rooms.length) return
  // The outdoor model's stand-ins for the interiors go: dark boxes seen
  // through doorways, named room_a.. (Bastok Markets, black), room01.. (Mines),
  // room-hanyou (Mhaura). Left in, they cut black shapes across the rooms.
  zone.instances = zone.instances.filter(i => !/^room/i.test(zone.prefabs[i.meshIndex]?.meshName ?? ''))
  for (const room of rooms) {
    const tOff = zone.textures.length
    const remap = new Map<number, number>()
    for (const inst of room.instances) {
      let to = remap.get(inst.meshIndex)
      if (to === undefined) {
        const p = room.prefabs[inst.meshIndex]
        if (!p) continue
        to = zone.prefabs.length
        zone.prefabs.push({ ...p, materialIndex: p.materialIndex >= 0 ? p.materialIndex + tOff : p.materialIndex })
        remap.set(inst.meshIndex, to)
      }
      zone.instances.push({ meshIndex: to, transform: inst.transform })
    }
    zone.textures.push(...room.textures)
    zone.textureNames.push(...room.textureNames)
  }
}
