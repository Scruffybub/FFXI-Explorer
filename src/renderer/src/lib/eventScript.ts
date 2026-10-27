/**
 * Cutscenes -> Events: the zones' event scripts, read into steps a person can
 * follow (who says what, choices, waits, camera and actor actions).
 *
 * A zone's event file (zone-seed-data.csv EVENTS) is a u32 block count, a
 * u32 size per block, then the blocks: u32 actor (an NPC's server id;
 * 0x7FFFFFF0 holds the zone's own scenes), u32 event count, u16 entry
 * offsets, u16 event ids, u32 reference count + u32 references (constants:
 * message numbers, item ids...), u32 code size and the byte code. The zone's
 * dialogue (DIALOG) is u32 size ^ 0x10000000, u32 line offsets ^ 0x80808080,
 * and text bytes ^ 0x80 with inline codes.
 *
 * Opcode sizes and meanings are facts from atom0s' XiEvents documentation
 * (AGPL-3.0; read as a description of the format, no code taken; see
 * THIRD-PARTY-NOTICES). An operand is a u16: with 0x8000 set it names a
 * reference (a constant); otherwise a work variable the server or script
 * fills, so its value isn't known here.
 */

/** Opcode sizes 0x00-0xD9 when fixed; 0 = set by the sub-code in the next byte (VARIABLE). */
const FIXED = [
  1, 3, 8, 5, 3, 3, 3, 5, 5, 5, 5, 3, 3, 5, 5, 5, 5, 5, 3, 5, 5, 5, 7, 7, 7, 5, 3, 1, 3, 3, 5, 0,
  2, 1, 2, 1, 7, 1, 1, 7, 7, 7, 6, 7, 13, 13, 1, 6, 1, 0, 3, 2, 3, 3, 7, 9, 3, 3, 7, 11, 7, 7, 7, 7,
  9, 9, 1, 2, 5, 17, 0, 0, 3, 7, 9, 7, 1, 1, 6, 3, 13, 13, 15, 13, 13, 15, 5, 3, 1, 0, 0, 15, 0, 5, 5, 0,
  0, 2, 17, 3, 11, 11, 15, 5, 1, 4, 7, 9, 9, 7, 7, 1, 1, 0, 0, 11, 2, 0, 5, 5, 1, 0, 0, 5, 6, 3, 0, 1,
  5, 6, 7, 3, 1, 1, 6, 2, 2, 3, 1, 25, 0, 5, 1, 1, 1, 3, 6, 3, 6, 3, 1, 5, 1, 5, 1, 1, 3, 0, 2, 17,
  15, 15, 15, 15, 2, 2, 0, 0, 6, 3, 17, 0, 0, 12, 0, 8, 12, 4, 0, 0, 0, 4, 0, 0, 27, 8, 13, 17, 15, 15, 3, 0,
  3, 5, 0, 7, 11, 17, 15, 15, 7, 1, 0, 0, 0, 17, 15, 15, 17, 15, 15, 6, 0, 17, 15, 15, 0, 2,
]

/** Variable sizes by sub-code; `d` covers the sub-codes not listed. */
const VARIABLE: Record<number, Record<number, number> & { d?: number }> = {
  0x1f: { 0: 8, d: 2 }, 0x31: { 0: 10, d: 2 }, 0x46: { 2: 4, d: 2 }, 0x47: { 0: 10, d: 2 },
  0x59: { 0: 4, 1: 8, 2: 4, 3: 8, 4: 8, 5: 7, 6: 6, 7: 4, 8: 8 },
  0x5a: { 0: 8, d: 2 },
  0x5c: { 0: 4, 1: 4, 2: 4, 3: 4, 4: 4, 5: 4, 6: 4, 7: 4, d: 6 },
  0x5f: { 0: 2, 1: 2, 2: 6, 3: 16, 4: 16, 5: 18, 6: 18, 7: 14 },
  0x60: { 0: 4, 1: 4, 2: 6, d: 2 },
  0x71: {
    0x00: 2, 0x01: 2, 0x02: 2, 0x03: 4, 0x10: 4, 0x11: 4, 0x12: 6, 0x13: 4, 0x20: 16, 0x21: 2,
    0x30: 4, 0x31: 4, 0x32: 6, 0x40: 4, 0x41: 8, 0x50: 4, 0x51: 2, 0x52: 4, 0x53: 2, 0x54: 10,
  },
  0x72: { 0: 4, 1: 6 }, 0x75: { 0: 4, d: 2 }, 0x79: { 0: 10, 1: 12, 2: 10 },
  0x7a: { 0: 6, 1: 7, 2: 6, 3: 2, 4: 8, 5: 6 },
  0x7e: { 0: 6, 1: 6, 2: 6, 3: 16, 4: 6, 5: 6, 6: 18, 7: 8, 8: 6 },
  0x8c: { 0: 8, 1: 2, 2: 12, 3: 10, 4: 10, 5: 14 },
  0x9d: {
    0x0: 8, 0x1: 8, 0x2: 6, 0x3: 8, 0x4: 8, 0x5: 8, 0x6: 8, 0x7: 8, 0x8: 23, 0x9: 9, 0xa: 10, 0xb: 10,
    0xc: 8, 0xd: 10, 0xe: 10, 0xf: 10, 0x10: 10,
  },
  0xa6: { 2: 4, d: 2 }, 0xa7: { 1: 4, d: 2 },
  0xab: { 0x11: 4, 0x14: 4, 0x15: 4, 0x16: 4, 0x17: 4, 0x18: 4, 0x1b: 6, 0x1c: 6, d: 2 },
  0xac: { 0: 4, 1: 4, 2: 6, 3: 6, 4: 8 },
  0xae: { 0: 6, 1: 8, 2: 8, 3: 8, 4: 8, 5: 10, 6: 6, 7: 10, 8: 10 },
  0xb2: { 0: 4, d: 2 },
  0xb3: { 0: 4, 1: 14, 2: 2, 3: 4, 4: 4, 5: 18, 6: 4, 7: 4, 8: 2, 9: 4 },
  0xb4: {
    0x0: 20, 0x1: 6, 0x2: 6, 0x3: 2, 0x4: 6, 0x5: 3, 0x6: 3, 0x7: 4, 0x8: 2, 0x9: 4, 0xa: 4, 0xb: 2,
    0xc: 4, 0xd: 2, 0xe: 2, 0xf: 6, 0x10: 6, 0x11: 6, 0x12: 6, 0x13: 20, 0x14: 12, 0x15: 2,
  },
  0xb6: { 0xb: 20, 0xd: 14, 0xe: 16, 0x10: 2, 0x12: 2, 0x13: 2, 0x14: 6, 0x15: 6, d: 4 },
  0xb7: { 0: 10, d: 8 }, 0xbf: { 0: 8, 0x60: 8, d: 10 }, 0xc2: { 1: 4, 2: 6, d: 2 },
  0xcc: { 0: 10, 1: 10, 2: 14, 3: 10, 0x10: 6, 0x11: 4, 0x20: 4 },
  0xd4: { 0: 8, 1: 8, 2: 8, 3: 6, 4: 12, 5: 12, d: 2 },
  0xd8: { 0: 6, 1: 8, 2: 8, 3: 8, 4: 12 },
}

/** The instruction's size at `at`, or 0 if it isn't a known one. */
export function opSize(code: Uint8Array, at: number): number {
  const op = code[at]
  if (op === undefined || op >= FIXED.length) return 0
  if (FIXED[op]) return FIXED[op]
  const v = VARIABLE[op]
  if (!v) return 0
  const sub = code[at + 1]
  return v[sub] ?? v.d ?? 0
}

export interface EventBlock {
  /** The NPC's server id, or 0x7FFFFFF0 for the zone's own scenes. */
  actor: number
  events: { id: number; offset: number }[]
  refs: Uint32Array
  code: Uint8Array
}

export const ZONE_ACTOR = 0x7ffffff0

export function parseEventFile(buf: ArrayBuffer): EventBlock[] {
  const v = new DataView(buf)
  const count = v.getUint32(0, true)
  let at = 4 + count * 4
  const blocks: EventBlock[] = []
  for (let i = 0; i < count; i++) {
    const start = at
    const actor = v.getUint32(at, true), n = v.getUint32(at + 4, true)
    let o = at + 8
    const events: EventBlock['events'] = []
    for (let e = 0; e < n; e++) events.push({ offset: v.getUint16(o + e * 2, true), id: v.getUint16(o + n * 2 + e * 2, true) })
    o += n * 4
    const nr = v.getUint32(o, true); o += 4
    const refs = new Uint32Array(nr)
    for (let r = 0; r < nr; r++) refs[r] = v.getUint32(o + r * 4, true)
    o += nr * 4
    const size = v.getUint32(o, true); o += 4
    blocks.push({ actor, events, refs, code: new Uint8Array(buf, o, size) })
    at = start + v.getUint32(4 + i * 4, true)
  }
  return blocks
}

/** The zone's dialogue lines, inline codes rendered (see renderLine). */
export function parseDialogue(buf: ArrayBuffer): string[] {
  const b = new Uint8Array(buf)
  const v = new DataView(buf)
  const n = (v.getUint32(4, true) ^ 0x80808080) >>> 2
  const offsets: number[] = []
  for (let i = 0; i < n; i++) offsets.push(((v.getUint32(4 + i * 4, true) ^ 0x80808080) >>> 0) + 4)
  const lines: string[] = []
  for (let i = 0; i < n; i++) {
    const raw = b.slice(offsets[i], i + 1 < n ? offsets[i + 1] : b.length)
    for (let j = 0; j < raw.length; j++) raw[j] ^= 0x80
    lines.push(renderLine(raw))
  }
  return lines
}

const ELEMENTS = ['Fire', 'Ice', 'Wind', 'Earth', 'Lightning', 'Water', 'Light', 'Dark']
const sjis = new TextDecoder('shift_jis')

/**
 * A dialogue line as text. Codes as found in the files: 07 new line, 00 or
 * 7F 31 the end of a window, 08 the player's name, 18/1C n a name the game
 * fills in, 0A n a number, 01 L .. (L + 2 bytes) a value from a table (an
 * item, key item or place), 0C n / 7F 92 n / 7F 85 pick one of the [a/b]
 * that follows, 0B the start of a list of choices, 1E/1F n colours, EF n an
 * element's icon, bytes 0x81-0x9F and 0xE0-0xEF Shift-JIS pairs.
 */
export function renderLine(t: Uint8Array): string {
  let s = ''
  for (let j = 0; j < t.length; j++) {
    const c = t[j]
    if (c === 0) break
    if (c === 0x07) s += '\n'
    else if (c === 0x08) s += '{player}'
    else if (c === 0x18 || c === 0x1c) { s += '{name}'; j++ }
    else if (c === 0x0a) { s += '{#}'; j++ }
    else if (c === 0x01) { s += '{…}'; j += (t[j + 1] ?? 0) + 1 }
    else if (c === 0x0c || c === 0x1e || c === 0x1f) j++
    else if (c === 0x0b) s += '\u0001'
    else if (c === 0x7f) {
      const k = t[j + 1]
      if (k === 0x31) break
      j += k >= 0x80 && k !== 0x85 ? 2 : 1
    } else if (c === 0xef) { s += `[${ELEMENTS[(t[j + 1] - 0x1f) & 7]}]`; j++ }
    else if ((c >= 0x81 && c <= 0x9f) || (c >= 0xe0 && c <= 0xfc)) {
      if (c === 0x87 && (t[j + 1] === 0xb2 || t[j + 1] === 0xb3)) { j++; continue }
      s += sjis.decode(t.subarray(j, j + 2)); j++
    } else if (c >= 0x20 && c < 0x7f) s += String.fromCharCode(c)
  }
  return s.trimEnd()
}

/** One instruction, described. */
export interface Step {
  at: number
  op: number
  bytes: Uint8Array
  kind: 'say' | 'choice' | 'flow' | 'wait' | 'actor' | 'camera' | 'scene' | 'end' | 'other' | 'unknown'
  text: string
  /** Dialogue line, when the message number is a constant. */
  line?: number
  /** Who speaks: an actor id, or 'npc' for the event's own NPC. */
  speaker?: number | 'npc'
  /** Addresses this step may continue at besides the next one. */
  jumps?: number[]
  /** No fall-through to the next instruction. */
  stops?: boolean
}

/** Describes operands. `refs` are the block's constants. */
class Reader {
  constructor(private code: Uint8Array, private at: number, private refs: Uint32Array) {}
  u8(i: number) { return this.code[this.at + i] }
  u16(i: number) { return this.code[this.at + i] | (this.code[this.at + i + 1] << 8) }
  u32(i: number) { return (this.u16(i) | (this.u16(i + 2) << 16)) >>> 0 }
  /** A value operand: the constant, or null for a variable. */
  val(i: number): number | null {
    const x = this.u16(i)
    return x & 0x8000 ? this.refs[x & 0x7fff] ?? null : null
  }
  /** A value operand as text. */
  show(i: number): string {
    const x = this.u16(i)
    if (x & 0x8000) { const r = this.refs[x & 0x7fff]; return r === undefined ? '?' : String(r | 0) }
    if (x < 80) return `local${x}`
    if (x >= 4096 && x < 4192) return `zone${x - 4096}`
    if (x >= 4352 && x < 4448) return `saved${x - 4352}`
    if (x >= 0x7f00 && x <= 0x7f0b) return ['npc.x', 'npc.y', 'npc.z', 'npc.facing', '?', '?', 'job', 'npc.race', 'level', '?', 'npc.id', '?'][x - 0x7f00]
    if (x >= 0x7f80 && x <= 0x7f8b) return ['player.x', 'player.z', 'player.y', 'player.facing', '?', '?', 'player.job', 'player.race', 'player.level', '?', 'player.id', '?'][x - 0x7f80]
    return `var${x}`
  }
}

/** An actor operand (u32) as text: the zone's NPCs by name later; these are fixed ones. */
export function actorLabel(id: number): string | null {
  if (id === 0x7fffffc0 || id === 0x7ffffff0 || id === 0x7ffffff9) return 'you'
  if (id === 0x7ffffff8) return 'this NPC'
  if (id >= 0x7fffffc1 && id <= 0x7fffffd1) return 'a party member'
  if (id >= 0x7ffffff1 && id <= 0x7ffffff5) return 'a party member'
  return null
}

const CMP = ['==', '!=', '>', '<', '>=', '<=', 'has any of', '!=', 'or', 'has any of']

/** The instruction at `at`, described. */
export function describe(code: Uint8Array, at: number, refs: Uint32Array): Step {
  const size = opSize(code, at)
  const op = code[at]
  const r = new Reader(code, at, refs)
  const bytes = code.subarray(at, at + Math.max(size, 1))
  const step = (kind: Step['kind'], text: string, more: Partial<Step> = {}): Step => ({ at, op, bytes, kind, text, ...more })
  const act = (i: number) => `@${r.u32(i).toString(16)}`
  if (!size) return step('unknown', `unknown opcode ${op.toString(16).padStart(2, '0')}`, { stops: true })
  const sub = r.u8(1)
  switch (op) {
    case 0x00: return step('end', 'End', { stops: true })
    case 0x01: return step('flow', `Go to ${hex(r.u16(1))}`, { jumps: [r.u16(1)], stops: true })
    case 0x02: {
      const c = r.u8(5) & 15
      return step('flow', `If ${r.show(1)} ${CMP[c] ?? '?'} ${r.show(3)}, else go to ${hex(r.u16(6))}`, { jumps: [r.u16(6)] })
    }
    case 0x03: return step('other', `Set ${r.show(1)} = ${r.show(3)}`)
    case 0x05: return step('other', `Set ${r.show(1)} = 1`)
    case 0x06: return step('other', `Set ${r.show(1)} = 0`)
    case 0x07: return step('other', `Set ${r.show(1)} += ${r.show(3)}`)
    case 0x08: return step('other', `Set ${r.show(1)} -= ${r.show(3)}`)
    case 0x0b: return step('other', `Add 1 to ${r.show(1)}`)
    case 0x0c: return step('other', `Take 1 from ${r.show(1)}`)
    case 0x12: case 0x13: return step('other', `Set ${r.show(1)} to a random number`)
    case 0x1a: return step('flow', `Run the part at ${hex(r.u16(1))}`, { jumps: [r.u16(1)] })
    case 0x1b: return step('flow', 'Return', { stops: true })
    case 0x1c: return step('wait', `Wait ${waitText(r.val(1))}`)
    case 0x1d: return step('say', '', { line: r.val(1) ?? undefined, speaker: 'npc' })
    case 0x1e: return step('actor', `${act(1)} turns to talk`)
    case 0x1f: case 0x31: case 0x5a:
      return sub === 0 ? step('actor', `Walk to ${r.show(2)}, ${r.show(6)}, ${r.show(4)}`) : step('wait', 'Until there')
    case 0x20: return step('scene', sub ? 'Take control from the player' : 'Give control back')
    case 0x21: return step('end', 'Event ends')
    case 0x23: return step('wait', 'Wait for the player to read')
    case 0x24: return step('choice', '', { line: r.val(1) ?? undefined })
    case 0x25: case 0x7f: return step('wait', 'Wait for the choice')
    case 0x2b: return step('say', '', { line: r.val(5) ?? undefined, speaker: r.u32(1) })
    case 0x2c: case 0x2d: return step('scene', `Action "${tag(r.u32(9))}" on ${act(1)}${r.u32(5) !== r.u32(1) ? ` toward ${act(5)}` : ''}`)
    case 0x3e: return step('flow', `If bit ${r.show(3)} of ${r.show(1)} is set, else go to ${hex(r.u16(5))}`, { jumps: [r.u16(5)] })
    case 0x43: return step('other', 'Tell the server')
    case 0x44: return step('flow', `If ${r.show(1)} is here, else go to ${hex(r.u16(3))}`, { jumps: [r.u16(3)] })
    case 0x45: return step('scene', `Action "${tag(r.u32(11))}" from ${act(3)} to ${act(7)}`)
    case 0x46: return step('camera', sub === 0 ? 'Camera back to the player' : sub === 1 ? 'Cutscene camera' : 'Check the camera')
    case 0x48: return step('say', '', { line: r.val(1) ?? undefined })
    case 0x49: return step('say', '', { line: r.val(5) ?? undefined })
    case 0x4a: return step('actor', `${act(1)} looks at ${act(5)}`)
    case 0x4b: return step('actor', `${act(1)} turns to ${r.show(5)}`)
    case 0x4c: return step('actor', 'Door opens')
    case 0x4d: return step('actor', 'Door closes')
    // 13 bytes: actors at 1 and 5, the action at 9. 15 bytes: a u16, actors at 3 and 7, the action at 11.
    case 0x50: case 0x51: return step('scene', `Stop action "${tag(r.u32(9))}"`)
    case 0x52: return step('scene', `Stop action "${tag(r.u32(11))}"`)
    case 0x53: case 0x54: return step('wait', `Until action "${tag(r.u32(9))}" ends`)
    case 0x55: return step('wait', `Until action "${tag(r.u32(11))}" ends`)
    case 0x5b: case 0x66: return step('scene', `Action "${tag(r.u32(11))}" from ${act(3)} to ${act(7)}`)
    case 0x5c: return step('scene', sub & 0x80 ? 'Change the music' : `Play music ${r.show(2)}`)
    case 0x5d: return step('scene', `Music volume to ${r.show(1)}`)
    case 0x63: return step('actor', `Play motion ${r.show(1)}`)
    case 0x67: return step('scene', 'Hide the interface')
    case 0x68: return step('scene', 'Show the interface')
    case 0x6c: return step('actor', `${act(1)} fades`)
    case 0x6e: return step('actor', `${act(1)} emotes (${r.show(5)})`)
    case 0x6f: return step('wait', 'Wait')
    case 0x77: return step('scene', `Set the time to ${r.show(1)}`)
    case 0x78: return step('scene', 'Time runs again')
    case 0x79: return step('actor', sub === 2 ? `${act(2)} looks around` : `${act(2)} turns to ${act(6)}`)
    case 0x7b: return step('actor', `${act(1)} stops talking`)
    case 0xb0: return step('say', '', { line: r.val(10) ?? undefined, speaker: r.u32(2) })
  }
  return step('other', `op ${op.toString(16).padStart(2, '0')}${FIXED[op] ? '' : '.' + sub.toString(16)}`)
}

const hex = (n: number) => n.toString(16).padStart(4, '0')
const tag = (n: number) => {
  const s = String.fromCharCode(n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24)
  return /^[\x20-\x7e]{4}$/.test(s) ? s.trim() : n.toString(16)
}
const waitText = (v: number | null) => (v === null ? 'a while' : `${(v / 60).toFixed(1)} s`)

/**
 * The event's steps: everything reachable from its entry, in address order.
 * Branches are followed both ways (their outcome rests on the server's state).
 */
export function readEvent(block: EventBlock, offset: number): Step[] {
  const seen = new Map<number, Step>()
  const todo = [offset]
  while (todo.length) {
    let at = todo.pop()!
    while (at < block.code.length && !seen.has(at)) {
      const s = describe(block.code, at, block.refs)
      seen.set(at, s)
      for (const j of s.jumps ?? []) if (!seen.has(j)) todo.push(j)
      if (s.stops) break
      at += s.bytes.length
    }
  }
  return [...seen.values()].sort((a, b) => a.at - b.at)
}
