/**
 * Effect routines (block 0x07): the scripts that time a spell's or an
 * ability's effect — which generators start when and for how long, which
 * other routines they call, which sounds play.
 *
 * Layout (xim EffectRoutineParser, format facts only): 16 zero bytes, then
 * three section offsets from the block start and a total length in frames.
 * Section 2 holds the timed commands, each
 *
 *   u8 op, u16 (low 5 bits: words in the command, counting this one), u8,
 *   u16 delay, u16 duration, then the arguments
 *
 * and runs until op 0x00. Delays are sequential: each command waits its delay
 * after the one before. Frames are 60 a second, the effect clock.
 *
 * Kept here: what stage 1 of the spell browser plays. Everything else is kept
 * as `other` so its delay still counts.
 */

export type RoutineCommand =
  /** Start a generator, emitting for `duration` frames (0: one emission). */
  | { kind: 'generator'; delay: number; duration: number; ref: string }
  /** Run another routine; `onTarget` swaps caster and target (op 0x09). */
  | { kind: 'routine'; delay: number; ref: string; onTarget: boolean }
  /** Play a sound pointer, heard from the caster or the target. */
  | { kind: 'sound'; delay: number; ref: string; onTarget: boolean; near: number; far: number }
  | { kind: 'end'; delay: number }
  | { kind: 'other'; delay: number; op: number }

export interface EffectRoutine {
  dir: string
  name: string
  /** The routine's length in frames, from its header. */
  total: number
  commands: RoutineCommand[]
}

const readName = (view: DataView, at: number) => {
  let s = ''
  for (let k = 0; k < 4; k++) {
    const c = view.getUint8(at + k)
    if (c === 0) break
    s += String.fromCharCode(c)
  }
  return s.trim()
}

/** One routine block's body (the bytes after its 16-byte header); `blockStart` is the header's offset in `view`. */
export function parseEffectRoutine(view: DataView, blockStart: number, blockEnd: number, dir: string, name: string): EffectRoutine | null {
  const data = blockStart + 16
  if (data + 0x20 > blockEnd) return null
  const sec2 = blockStart + view.getUint32(data + 0x14, true)
  const total = view.getUint32(data + 0x1c, true)
  if (sec2 < data || sec2 >= blockEnd) return null
  const commands: RoutineCommand[] = []
  let c = sec2
  for (let guard = 0; guard < 512 && c + 8 <= blockEnd; guard++) {
    const op = view.getUint8(c)
    const words = view.getUint16(c + 1, true) & 0x1f
    if (words === 0) break
    const delay = view.getUint16(c + 4, true)
    const duration = view.getUint16(c + 6, true)
    const args = c + 8
    const argWords = words - 2
    if (op === 0x00) { commands.push({ kind: 'end', delay }); break }
    if (op === 0x02 && argWords >= 1) {
      commands.push({ kind: 'generator', delay, duration, ref: readName(view, args) })
    } else if ((op === 0x03 || op === 0x09 || (op === 0x0a && argWords !== 6)) && argWords >= 1) {
      commands.push({ kind: 'routine', delay, ref: readName(view, args), onTarget: op === 0x09 })
    } else if ((op === 0x0a || op === 0x0b) && argWords >= 6) {
      commands.push({
        kind: 'sound', delay, ref: readName(view, args), onTarget: op === 0x0b,
        far: view.getFloat32(args + 12, true), near: view.getFloat32(args + 16, true),
      })
    } else {
      commands.push({ kind: 'other', delay, op })
    }
    c += words * 4
  }
  return { dir, name, total, commands }
}
