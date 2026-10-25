import rawSpawns from '../../../../resources/mob-spawns.json'

/**
 * Scene -> Monsters: where each zone's ordinary monsters appear and the ground
 * they wander (visual only; nothing fights).
 *
 * The client never holds monster spawns (the server sends them), so the table
 * is built from LandSandBoat's per-zone mobs.yaml and regions.yaml by
 * scripts/build-mob-spawns.cjs: appearance numbers, spawn areas and times.
 * Most monsters spawn in a region, a polygon the server picks a point in; the
 * rest at a fixed position. In game they wander near where they spawned; here
 * each wanders inside its region (or near its fixed spot), resting between
 * walks (NpcStations).
 *
 * Slots are spawns that take turns at one spot: West Ronfaure's rabbit by
 * day, bats in the evening. One member shows at a time, by the time of day.
 */

/** [index, look, where, time, slot, speed?]: where a region index or [x, y, z, facing 0-255]. */
export type MobSpawn = [number, number | number[], number | [number, number, number, number], number, number, number?]

interface ZoneMobs {
  /** Each region: its outline as x, y, z per point (zone space, Y down). */
  r: number[][]
  m: MobSpawn[]
}

const SPAWNS = rawSpawns as unknown as Record<string, ZoneMobs>

export function mobSpawns(zoneId: number): ZoneMobs {
  return SPAWNS[String(zoneId)] ?? { r: [], m: [] }
}

/**
 * Whether a spawn time is out at this hour: 1 evening (18:00-6:00), 2 night
 * (20:00-4:00), as LandSandBoat's at_evening and at_night; 0 always.
 */
export function outAt(time: number, hour: number): boolean {
  if (time === 1) return hour >= 18 || hour < 6
  if (time === 2) return hour >= 20 || hour < 4
  return true
}

/** Point in a region's outline (even-odd rule over its points' x, z). */
export function insideRegion(region: number[], x: number, z: number): boolean {
  let inside = false
  const n = region.length / 3
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = region[i * 3], zi = region[i * 3 + 2], xj = region[j * 3], zj = region[j * 3 + 2]
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside
  }
  return inside
}

/**
 * The region's own height at x, z: its outline points' heights, weighted by
 * nearness. It is the ground the server spawns on, so it tells a cave's floor
 * from the hill over it.
 */
export function regionHeight(region: number[], x: number, z: number): number {
  let sum = 0, weight = 0
  for (let i = 0; i < region.length; i += 3) {
    const d2 = (region[i] - x) ** 2 + (region[i + 2] - z) ** 2
    if (d2 < 0.01) return region[i + 1]
    sum += region[i + 1] / d2
    weight += 1 / d2
  }
  return weight ? sum / weight : 0
}

/**
 * A random point in a region, optionally within `near` units of [x, z]; null
 * after a few misses (a thin region, or `near` mostly outside it).
 */
export function pointInRegion(region: number[], from?: [number, number], near = 0): [number, number] | null {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (let i = 0; i < region.length; i += 3) {
    minX = Math.min(minX, region[i]); maxX = Math.max(maxX, region[i])
    minZ = Math.min(minZ, region[i + 2]); maxZ = Math.max(maxZ, region[i + 2])
  }
  for (let tries = 0; tries < (near > 0 ? 16 : 64); tries++) {
    let x: number, z: number
    if (from && near > 0) {
      const a = Math.random() * Math.PI * 2, d = near * (0.3 + 0.7 * Math.random())
      x = from[0] + Math.cos(a) * d; z = from[1] + Math.sin(a) * d
    } else {
      x = minX + Math.random() * (maxX - minX); z = minZ + Math.random() * (maxZ - minZ)
    }
    if (insideRegion(region, x, z)) return [x, z]
  }
  return null
}
