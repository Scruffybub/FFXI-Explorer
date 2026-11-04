/**
 * The game's file numbers: VTABLE.DAT says which ROM folder holds a file
 * (1 = ROM), FTABLE.DAT where in it (folder << 7 | file). Each expansion
 * keeps its own pair beside its files (ROM2/VTABLE2.DAT, FTABLE2.DAT ..
 * ROM9), over the same numbers: a file is in exactly one of them (3,234 of
 * them only in an expansion's: Promathia's cutscene files, among others).
 * Read once per install and merged.
 */

interface Table { rom: Uint8Array; entry: Uint16Array }
let cached: { root: string; table: Promise<Table> } | null = null

async function readTables(root: string): Promise<Table> {
  const pairs = await Promise.all(['', '2', '3', '4', '5', '6', '7', '8', '9'].map(n => {
    const dir = n ? `ROM${n}/` : ''
    return Promise.all([window.ffxi.readDat(root, `${dir}VTABLE${n}.DAT`), window.ffxi.readDat(root, `${dir}FTABLE${n}.DAT`)]).catch(() => null)
  }))
  const size = Math.max(...pairs.map(p => p?.[0].byteLength ?? 0))
  const rom = new Uint8Array(size), entry = new Uint16Array(size)
  for (const p of pairs) {
    if (!p) continue
    const v = new Uint8Array(p[0]), f = new DataView(p[1])
    for (let id = 0; id < v.length && id * 2 + 2 <= f.byteLength; id++) {
      if (v[id] && !rom[id]) { rom[id] = v[id]; entry[id] = f.getUint16(id * 2, true) }
    }
  }
  return { rom, entry }
}

function table(root: string): Promise<Table> {
  if (cached?.root !== root) cached = { root, table: readTables(root) }
  return cached.table
}

/** File number -> install-relative path, or null when the tables have no such file. */
export async function fileIdPath(root: string, id: number): Promise<string | null> {
  const { rom, entry } = await table(root)
  const r = rom[id]
  if (!r) return null
  return `${r === 1 ? 'ROM' : 'ROM' + r}/${entry[id] >> 7}/${entry[id] & 0x7f}.DAT`
}

/** Every file number whose entry points at `path` (install-relative; several can share one file). */
export async function fileIdsOf(root: string, path: string): Promise<number[]> {
  const m = /^ROM(\d*)\/(\d+)\/(\d+)(?:\.dat)?$/i.exec(path.replace(/\\/g, '/'))
  if (!m) return []
  const { rom, entry } = await table(root)
  const r = m[1] ? Number(m[1]) : 1
  const e = (Number(m[2]) << 7) | Number(m[3])
  const ids: number[] = []
  for (let id = 0; id < rom.length; id++) if (rom[id] === r && entry[id] === e) ids.push(id)
  return ids
}
