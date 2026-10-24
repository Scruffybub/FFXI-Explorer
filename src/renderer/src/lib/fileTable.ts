/**
 * The game's file numbers: VTABLE.DAT says which ROM folder holds a file
 * (1 = ROM, 2 = ROM2, ..), FTABLE.DAT where in it (folder << 7 | file).
 * Read once per install.
 */

let cached: { root: string; v: Promise<Uint8Array>; f: Promise<DataView> } | null = null

/** File number -> install-relative path, or null when the tables have no such file. */
export async function fileIdPath(root: string, id: number): Promise<string | null> {
  if (cached?.root !== root) {
    cached = {
      root,
      v: window.ffxi.readDat(root, 'VTABLE.DAT').then(b => new Uint8Array(b)),
      f: window.ffxi.readDat(root, 'FTABLE.DAT').then(b => new DataView(b)),
    }
  }
  const [v, f] = await Promise.all([cached.v, cached.f])
  const rom = v[id]
  if (!rom || id * 2 + 2 > f.byteLength) return null
  const entry = f.getUint16(id * 2, true)
  return `${rom === 1 ? 'ROM' : 'ROM' + rom}/${entry >> 7}/${entry & 0x7f}.DAT`
}
