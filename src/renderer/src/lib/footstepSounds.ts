import { decodeSpw } from './bgw'

/**
 * Footstep sounds: the zone's own, from its fses folder (sound pointers
 * `0T11`.., block 0x3D), played as a foot lands.
 *
 * The name is "0", the ground type in hex, then two digits xim takes from the
 * feet equipment's info block (movement character, shake factor + 1). That
 * block is not read yet, so every character wears "11", the first set.
 *
 * Sound effects are .spw files (lib/bgw.ts decodeSpw) in the sound folders,
 * which overlay like the ROM folders: the first that has the file wins.
 * Decoded once and kept.
 */

const SOUND_DIRS = ['sound', 'sound2', 'sound3', 'sound4', 'sound5', 'sound6', 'sound7', 'sound8', 'sound9']

/** ?census=1: every sound played is logged to window.__sfx (length, peak). */
const CENSUS = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('census')

let root: string | null = null
let ctx: AudioContext | null = null
const buffers = new Map<number, Promise<AudioBuffer | null>>()

/** The FFXI install the sounds are read from (App sets it with the path). */
export function setSoundRoot(path: string | null) {
  if (path !== root) buffers.clear()
  root = path
}

function load(id: number): Promise<AudioBuffer | null> {
  let p = buffers.get(id)
  if (p) return p
  p = (async () => {
    if (!root) return null
    const folder = String(Math.floor(id / 1000)).padStart(3, '0')
    const file = String(id).padStart(6, '0')
    for (const dir of SOUND_DIRS) {
      const rel = `${dir}/win/se/se${folder}/se${file}.spw`
      if (!(await window.ffxi.fileExists(root, rel))) continue
      const decoded = decodeSpw(new Uint8Array(await window.ffxi.readDat(root, rel)))
      if (!decoded) return null
      ctx ??= new AudioContext()
      const length = decoded.channels[0].length
      const buf = ctx.createBuffer(decoded.channels.length, length, decoded.sampleRate)
      decoded.channels.forEach((c, i) => buf.copyToChannel(c as Float32Array<ArrayBuffer>, i))
      return buf
    }
    return null
  })().catch(() => null)
  buffers.set(id, p)
  return p
}

/** The sound for a footfall on this ground, if the zone has one. */
export function footstepSoundId(sounds: { dir: string; name: string; id: number }[] | undefined, terrain: number): number | null {
  const name = `0${terrain.toString(16)}11`
  return sounds?.find(s => /(^|\/)fses$/.test(s.dir) && s.name === name)?.id ?? null
}

/** Plays a sound effect at `volume` (0-1). Missing or undecodable sounds stay silent. */
export function playSound(id: number, volume: number) {
  if (volume <= 0 || !root) return
  load(id).then(buf => {
    if (!buf || !ctx) return
    if (ctx.state === 'suspended') ctx.resume().catch(() => {})
    if (CENSUS) {
      const d = buf.getChannelData(0)
      let peak = 0
      for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]))
      ;((window as unknown as { __sfx?: unknown[] }).__sfx ??= []).push({ id, seconds: +buf.duration.toFixed(3), rate: buf.sampleRate, peak: +peak.toFixed(3) })
    }
    const src = ctx.createBufferSource()
    src.buffer = buf
    const gain = ctx.createGain()
    gain.gain.value = volume
    src.connect(gain).connect(ctx.destination)
    src.start()
  })
}
