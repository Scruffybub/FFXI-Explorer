/**
 * Parses the collision mesh out of a decrypted MZB block (type 0x1C).
 *
 * FFXI stores real collision geometry in the zone file, separate from the
 * render geometry in MMB blocks. It is what the game walks and bumps against,
 * so it includes invisible walls and excludes decorative overhangs. This is
 * the same data LandSandBoat's FFXI-NavMesh-Builder turns into navmesh OBJs —
 * its zone loader skips MMB entirely with the note "dont need mmb for
 * collision mesh".
 *
 * Ported from FFXI-NavMesh-Builder `Common/dat/Types/MZB.cs`, which descends
 * from Vulture's original dat.cs via DarkStar/Topaz.
 *
 * ── Layout ──
 * The block opens with the header MzbParser.ts already reads (instance records
 * at offset 32). Collision hangs off fields further into that same header:
 *
 *   0x08          mesh section offset (scan forward in 4-byte steps while zero)
 *   0x0c, 0x0d    grid width / height bytes
 *   0x10          quadtree offset  (spatial index — unused here, see below)
 *   0x14, 0x18    maplist offset / count  (map-id visibility — unused here)
 *   mesh + 0x10   grid offset
 *
 * The grid is a 2D table of int32 offsets. Each non-zero entry points at a
 * null-terminated list of int32s: the first is packed cell coordinates, and
 * the rest are (visEntryOffset, geometryOffset) pairs. visEntry holds a 4x4
 * transform; geometry holds the vertex/normal/triangle arrays.
 *
 *   geometry + 0x00   int32  offset of vertex array (3 floats each)
 *   geometry + 0x04   int32  offset of normal array (3 floats each)
 *   geometry + 0x08   int32  offset of triangle array (4 uint16 each)
 *   geometry + 0x0c   int16  triangle count
 *   geometry + 0x0e   int16  flags — bit 0 set means "does not block line of sight"
 *
 * Vertex and normal counts are derived from the gaps between those offsets.
 * Each triangle is four uint16: three vertex indices plus one normal index,
 * every one masked & 0x3fff. The top two bits of each index are unidentified;
 * they are plausibly surface type or walkability, and are preserved per
 * triangle in `indexFlags` in case they turn out to matter for slope handling.
 *
 * ── Three deliberate deviations from the C# reference ──
 *
 * 1. Y is NOT negated here. The reference negates it to emit a Y-up OBJ. Our
 *    zone renderer instead puts the whole scene under rotation [PI,0,0], so
 *    negating would double-flip. Collision comes out in the same raw DAT space
 *    as the MMB prefab vertices and belongs under the same rotated group.
 *
 * 2. The reference's `(m[2]x + m[6]y + m[10]z + m[14]) > -99329` guard skips
 *    far-away vertices while still numbering triangle indices as though every
 *    vertex were kept, which desynchronises indices whenever it fires. We keep
 *    every vertex so indices stay aligned. Stray distant triangles are a far
 *    cheaper failure than scrambled topology.
 *
 * 3. (visEntry, geometry) pairs are deduplicated. The reference over-scans the
 *    grid by a factor of 10 per axis (a workaround its comments attribute to
 *    Port Jeuno and Chateau d'Oraguille), so one mesh is visited many times.
 *    Emitting it once keeps the triangle count honest.
 *
 * The quadtree at 0x10 is deliberately not parsed: it is a spatial index for
 * the game's own queries, and we build our own acceleration structure over the
 * finished triangle soup.
 */

/** A zone's collision geometry as a single indexed triangle soup, in raw DAT space. */
export interface ParsedCollision {
  /** Flat xyz, 3 floats per vertex. */
  vertices: Float32Array
  /** Triangle indices, 3 per face. */
  indices: Uint32Array
  /** Per-triangle geometry-header flags. Bit 0 = does not block line of sight. */
  faceFlags: Uint16Array
  /** Per-triangle top-2-bit index flags, packed as (v0<<4)|(v1<<2)|v2. Meaning unknown. */
  indexFlags: Uint8Array
}

/** Guard against a corrupt header sending us into a multi-gigabyte allocation. */
const MAX_TRIANGLES = 2_000_000

export function parseMzbCollision(data: Uint8Array): ParsedCollision | null {
  if (data.length < 0x20) return null

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)

  const i32 = (off: number): number =>
    off >= 0 && off + 4 <= data.length ? view.getInt32(off, true) : 0
  const i16 = (off: number): number =>
    off >= 0 && off + 2 <= data.length ? view.getInt16(off, true) : 0
  const u16 = (off: number): number =>
    off >= 0 && off + 2 <= data.length ? view.getUint16(off, true) : 0
  const f32 = (off: number): number =>
    off >= 0 && off + 4 <= data.length ? view.getFloat32(off, true) : 0

  // ── Mesh section offset: scan forward while zero (the reference's ship fix) ──
  let meshOffset = 0
  for (let probe = 8; probe + 4 <= data.length && probe < 0x40; probe += 4) {
    const candidate = i32(probe)
    if (candidate !== 0) {
      meshOffset = candidate
      break
    }
  }
  if (meshOffset <= 0 || meshOffset >= data.length) return null

  // The reference walks the mesh section here via ParseMesh(), but that
  // function only advances a cursor and discards what it reads — every
  // triangle it emits comes from the grid below. Skipped as dead code.

  const gridOffset = i32(meshOffset + 0x10)
  if (gridOffset <= 0 || gridOffset >= data.length) return null

  const positions: number[] = []
  const indices: number[] = []
  const faceFlags: number[] = []
  const indexFlags: number[] = []
  const seen = new Set<number>()

  /** Read the 4x4 at visEntry and emit the geometry block's triangles through it. */
  const emitGridMesh = (visEntryOffset: number, geometryOffset: number): void => {
    // 16 floats. Index arithmetic below mirrors the reference exactly rather
    // than reasoning about row- vs column-major, which is easy to get subtly
    // wrong and hard to see in a wireframe.
    const m: number[] = new Array(16)
    for (let i = 0; i < 16; i++) m[i] = f32(visEntryOffset + i * 4)

    const vertsOff = i32(geometryOffset + 0x00)
    const normsOff = i32(geometryOffset + 0x04)
    const trisOff = i32(geometryOffset + 0x08)
    const triCount = i16(geometryOffset + 0x0c)
    const flags = i16(geometryOffset + 0x0e)

    if (triCount <= 0) return
    if (vertsOff <= 0 || normsOff <= vertsOff || trisOff <= normsOff) return
    if (trisOff >= data.length) return

    const vertCount = (normsOff - vertsOff) / 12
    if (vertCount <= 0 || !Number.isInteger(vertCount)) return
    if (indices.length / 3 + triCount > MAX_TRIANGLES) return

    const baseVert = positions.length / 3

    for (let i = 0; i < vertCount; i++) {
      const x = f32(vertsOff + (i * 3 + 0) * 4)
      const y = f32(vertsOff + (i * 3 + 1) * 4)
      const z = f32(vertsOff + (i * 3 + 2) * 4)
      // Deviation 1: no Y negation — see the header comment.
      positions.push(
        m[0] * x + m[4] * y + m[8] * z + m[12],
        m[1] * x + m[5] * y + m[9] * z + m[13],
        m[2] * x + m[6] * y + m[10] * z + m[14],
      )
    }

    // Winding follows the sign of the transform's upper 3x3 determinant:
    // a mirrored instance needs its triangles reversed or every face points
    // the wrong way.
    const det =
      m[0] * (m[5] * m[10] - m[6] * m[9]) -
      m[1] * (m[4] * m[10] - m[6] * m[8]) +
      m[2] * (m[4] * m[9] - m[5] * m[8])
    const mirrored = det > 0

    for (let i = 0; i < triCount; i++) {
      const base = trisOff + i * 4 * 2
      const raw0 = u16(base + 0)
      const raw1 = u16(base + 2)
      const raw2 = u16(base + 4)

      const a = raw0 & 0x3fff
      const b = raw1 & 0x3fff
      const c = raw2 & 0x3fff
      if (a >= vertCount || b >= vertCount || c >= vertCount) continue

      if (mirrored) {
        indices.push(baseVert + c, baseVert + b, baseVert + a)
      } else {
        indices.push(baseVert + a, baseVert + b, baseVert + c)
      }
      faceFlags.push(flags & 0xffff)
      indexFlags.push(
        (((raw0 >> 14) & 3) << 4) | (((raw1 >> 14) & 3) << 2) | ((raw2 >> 14) & 3),
      )
    }
  }

  /** Walk one grid cell's null-terminated offset list. */
  const parseGridEntry = (entryOffset: number): void => {
    if (entryOffset <= 0 || entryOffset >= data.length) return

    const entries: number[] = []
    let cursor = entryOffset
    while (cursor + 4 <= data.length) {
      const value = i32(cursor)
      if (value === 0) break
      entries.push(value)
      cursor += 4
      if (entries.length > 4096) break // corrupt list guard
    }
    if (entries.length < 3) return

    // entries[0] packs the cell's own coordinates and flags; pairs follow.
    for (let i = 1; i + 1 < entries.length; i += 2) {
      const visEntryOffset = entries[i]
      const geometryOffset = entries[i + 1]
      if (
        visEntryOffset <= 0 ||
        geometryOffset <= 0 ||
        visEntryOffset >= data.length ||
        geometryOffset >= data.length
      ) {
        break
      }
      // Deviation 3: the grid over-scan revisits the same mesh many times.
      const key = visEntryOffset * 0x100000000 + geometryOffset
      if (seen.has(key)) continue
      seen.add(key)
      emitGridMesh(visEntryOffset, geometryOffset)
    }
  }

  // ── Walk the grid ──
  // Retains the reference's x10 over-scan. It reads grid slots past the real
  // grid, which is why deduplication above matters; bounds checks keep it safe.
  const gridWidth = data[0x0c] * 10
  const gridHeight = data[0x0d] * 10
  if (gridWidth > 0 && gridHeight > 0) {
    for (let y = 0; y < gridHeight * 10; y++) {
      for (let x = 0; x < gridWidth * 10; x++) {
        const slot = (y * gridWidth * 10 + x) * 4
        if (slot <= 0 || gridOffset + slot + 4 > data.length) continue
        const entryOffset = i32(gridOffset + slot)
        if (entryOffset > 0 && entryOffset < data.length) {
          parseGridEntry(entryOffset)
        }
      }
    }
  }

  if (indices.length === 0) return null

  return {
    vertices: new Float32Array(positions),
    indices: new Uint32Array(indices),
    faceFlags: new Uint16Array(faceFlags),
    indexFlags: new Uint8Array(indexFlags),
  }
}
