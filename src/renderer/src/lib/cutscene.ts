import * as THREE from 'three'
import { fileIdPath } from './fileTable'
import { opSize, ZONE_ACTOR, type EventBlock } from './eventScript'
import type { ZoneEntry } from './zoneList'
import { npcStations, sceneActors } from './npcStations'
import type { CollisionWorld } from './CollisionWorld'
import { parseAnimationDat, type ParsedAnimation } from './ffxi-dat'
import animationPaths from '../../../../resources/animation-paths.json'

/**
 * Cutscenes -> Events -> Play in zone: runs an event script in its zone.
 *
 * Stages 2 and 3a of the cutscene player (HANDOFF "Cutscene player"): the
 * text and timing, and the actors' places. Message windows wait for a click,
 * choices wait for a pick (the answer goes to zone variable 0, as the
 * game's does), waits wait, and the event's schedulers run their cameras
 * and screen fades. Every actor whose event the scene starts (0x27-0x29)
 * runs its own script alongside, as the game does: actors are placed
 * (0x36/0x37), turned (0x39, 0x4B, 0x1E, 0x4A, 0x79) and walked (0x1F,
 * 0x31, 0x5A) on the collision's floor. NpcStations and the zone's avatar
 * follow the poses. Their motions and gestures are stage 3b.
 *
 * Schedulers live in event files (an "evte" folder): type 6 blocks are
 * cameras, type 7 blocks schedulers whose commands run in turn, each starting
 * and then holding the scheduler for its delay (frames, 60 a second; the
 * delays add up to the scheduler's stated length). Command 0x04 runs a camera
 * block for its duration, 0x0F fades the screen to an RGBA colour (0x80 =
 * full). A camera block: 16 bytes, u32 key count, 12 bytes, then 48-byte
 * keys: eye x y z, lens; target x y z, 0; time 0-1, 0, 0, 0. Zone
 * coordinates, Y down. Op 0x45 and its kin load a file by number (bases from
 * XiEvents' docs, facts only); 0x2C and others then start a scheduler by name.
 *
 * Server state the script asks about (quests, missions) isn't known here:
 * unset variables read 0, which takes each script's first path.
 */

const FPS = 60
/** Scheduler-loading opcodes: the file number is base + the operand at 1. */
const LOADERS: Record<number, number> = { 0x45: 30704, 0x62: 5012, 0x9f: 51183, 0xbb: 56685, 0xc5: 67355, 0xcd: 70435, 0xd0: 70691, 0xd5: 102449 }
/** 15-byte waits and stops: the scheduler's name is at 11 (the 13-byte ones keep it at 9). */
const WAITS_15 = new Set([0x55, 0xa0, 0xa2, 0xbc, 0xc6, 0xce, 0xd1, 0xd6])
const STOPS_15 = new Set([0x52, 0xa1, 0xa3, 0xbd, 0xc7, 0xcf, 0xd2, 0xd7])
/** Instructions run per frame at most, and backward jumps per event, before it's taken for a loop on server state. */
const STEP_BUDGET = 2000
const LOOP_LIMIT = 20000
/**
 * The camera lens value: the projection's focal length in pixels of a
 * 448-line screen, so vertical FOV = 2 atan(224 / value). 350 (the common
 * one) gives 65 degrees; an estimate, see HANDOFF.
 */
const HALF_SCREEN = 224

interface CameraKey { eye: THREE.Vector3; target: THREE.Vector3; lens: number; t: number }
interface SchedCommand {
  op: number; delay: number; duration: number; name: string; rgba: [number, number, number, number]
  /** Op 0x05 (play a motion): its speed, and whether it keeps going (1 at +22: loops or holds until the next). */
  speed: number; loop: boolean
}
/** A loaded file's cameras, schedulers and animations (event files and motion files alike). */
interface Lib { cameras: Map<string, CameraKey[]>; schedulers: Map<string, SchedCommand[]>; clips: ParsedAnimation[] }
/** One motion of an actor's action, scene seconds. */
interface Segment { start: number; end: number; clips: ParsedAnimation[]; loop: boolean; speed: number }
interface Running { name: string; start: number; end: number }

export interface CutsceneMessage { speaker: string | null; text: string; choices?: string[] }
export interface CutsceneView {
  title: string
  message: CutsceneMessage | null
  /** Screen colour, a multiplier on the picture (r, g, b; 1 = unchanged) at strength a (0-1). */
  fade: [number, number, number, number]
  ended: boolean
  note: string | null
}

export interface CutsceneRequest {
  root: string
  zone: ZoneEntry
  block: EventBlock
  /** All the zone's blocks: the scene starts other actors' events (0x27-0x29). */
  blocks: EventBlock[]
  eventId: number
  offset: number
  lines: string[]
  /** NPC names by the id's low 12 bits. */
  names: Map<number, string>
  actorName: string
}

// ── The store: App and the overlay read it; the reader starts it. ──
interface State {
  request: CutsceneRequest | null
  view: CutsceneView | null
  handover: number
  /** The zone the scene is in now: its own, or another it opened (0x34/0x35: a flashback elsewhere). */
  sceneZone: number | null
  /** The hour the scene set (0x77), or null for the zone's own. */
  sceneHour: number | null
  /** Your character's race (the Character builder's), for your emotes. */
  playerRace: number
  /** The music the scene set (0x5C, the idle slots), and its volume 0-1 (0x5D). */
  sceneMusic: number | null
  sceneVolume: number
}
let state: State = { request: null, view: null, handover: 0, sceneZone: null, sceneHour: null, sceneMusic: null, sceneVolume: 1, playerRace: 1 }

/** App tells the scene which race you are (the Character builder's). */
export function setCutscenePlayerRace(race: number): void {
  if (race !== state.playerRace) set({ playerRace: race })
}

/** The race's emote files (animation-paths.json "Emote"), eight emotes (em00-em07) each. Tarutaru female shares the male's. */
function emoteFile(race: number, emote: number): string | null {
  const sets = (animationPaths as unknown as Record<string, { name: string; paths: string[] }[]>)[String(race === 6 ? 5 : race)]
  const paths = sets?.find(s => s.name === 'Emote')?.paths
  return paths?.[Math.floor(emote / 8)] ?? null
}
const listeners = new Set<() => void>()
const set = (s: Partial<State>) => { state = { ...state, ...s }; listeners.forEach(f => f()) }
export const cutsceneStore = {
  get: () => state,
  subscribe: (f: () => void) => { listeners.add(f); return () => listeners.delete(f) },
}
let current: CutsceneRun | null = null

/** Asks the app to open the zone and play the event there. */
export function requestCutscene(r: CutsceneRequest): void {
  current = null
  set({ request: r, view: null, sceneZone: r.zone.id, sceneHour: null, sceneMusic: null, sceneVolume: 1 })
}
/** The run, made when the zone is ready (the player calls it). */
export function cutsceneRun(): CutsceneRun | null {
  if (!current && state.request) {
    current = new CutsceneRun(state.request)
    set({ view: current.view })
  }
  return current
}
export function stopCutscene(): void {
  current = null
  set({ request: null, view: null, handover: state.handover + 1, sceneZone: null, sceneHour: null, sceneMusic: null, sceneVolume: 1 })
}
export function advanceCutscene(): void { current?.advance() }
export function chooseCutscene(i: number): void { current?.choose(i) }

const fileCache = new Map<number | string, Promise<Lib | null>>()

/** A file's cameras, schedulers (by name) and animations: event files, motion files, emote files (by path). */
function loadEventFile(root: string, id: number | string): Promise<Lib | null> {
  let p = fileCache.get(id)
  if (!p) {
    p = (async () => {
      const path = typeof id === 'string' ? id : await fileIdPath(root, id)
      if (!path) return null
      const buf = await window.ffxi.readDat(root, path)
      const v = new DataView(buf)
      const cameras = new Map<string, CameraKey[]>(), schedulers = new Map<string, SchedCommand[]>()
      for (let at = 0; at + 16 <= buf.byteLength;) {
        const name = String.fromCharCode(...new Uint8Array(buf, at, 4)).replace(/\0.*$/, '')
        const packed = v.getUint32(at + 4, true), type = packed & 0x7f, size = ((packed >>> 7) & 0x7ffff) * 16
        if (!size) break
        if (type === 6) cameras.set(name, readCamera(v, at + 16, at + size))
        else if (type === 7) schedulers.set(name, readScheduler(v, at, at + size))
        at += size
      }
      let clips: ParsedAnimation[] = []
      try { clips = parseAnimationDat(buf) } catch { /* none */ }
      return { cameras, schedulers, clips }
    })().catch(() => null)
    fileCache.set(id, p)
  }
  return p
}

/** Zone coordinates (Y down) to the scene's (the zone is turned over about X). */
const toScene = (x: number, y: number, z: number) => new THREE.Vector3(x, -y, -z)

function readCamera(v: DataView, data: number, end: number): CameraKey[] {
  const n = v.getUint32(data + 16, true)
  const keys: CameraKey[] = []
  for (let i = 0, k = data + 32; i < n && k + 48 <= end; i++, k += 48) {
    const f = (o: number) => v.getFloat32(k + o, true)
    keys.push({ eye: toScene(f(0), f(4), f(8)), lens: f(12), target: toScene(f(16), f(20), f(24)), t: f(32) })
  }
  return keys
}

function readScheduler(v: DataView, start: number, end: number): SchedCommand[] {
  const out: SchedCommand[] = []
  let c = start + v.getUint32(start + 16 + 0x14, true)
  for (let guard = 0; guard < 256 && c + 8 <= end; guard++) {
    const op = v.getUint8(c), words = v.getUint16(c + 1, true) & 0x1f
    if (!words) break
    const args = c + 8
    const name = args + 4 <= end ? String.fromCharCode(v.getUint8(args), v.getUint8(args + 1), v.getUint8(args + 2), v.getUint8(args + 3)).replace(/\0.*$/, '') : ''
    const rgba: [number, number, number, number] = args + 4 <= end ? [v.getUint8(args), v.getUint8(args + 1), v.getUint8(args + 2), v.getUint8(args + 3)] : [0, 0, 0, 0]
    const motion = op === 0x05 && args + 24 <= end
    out.push({
      op, delay: v.getUint16(c + 4, true), duration: v.getUint16(c + 6, true), name, rgba,
      speed: motion ? v.getFloat32(args + 8, true) || 1 : 1, loop: motion && v.getUint16(args + 22, true) === 1,
    })
    if (op === 0) break
    c += words * 4
  }
  return out
}

/** Catmull-Rom through the keys' points, by the keys' 0-1 times. */
function along(keys: CameraKey[], u: number, pick: (k: CameraKey) => THREE.Vector3, out: THREE.Vector3) {
  if (keys.length === 1 || u <= keys[0].t) return out.copy(pick(keys[0]))
  let i = 0
  while (i < keys.length - 2 && u > keys[i + 1].t) i++
  const a = keys[i], b = keys[i + 1]
  if (u >= b.t && i === keys.length - 2) return out.copy(pick(b))
  const s = b.t > a.t ? (u - a.t) / (b.t - a.t) : 1
  const p0 = pick(keys[Math.max(0, i - 1)]), p1 = pick(a), p2 = pick(b), p3 = pick(keys[Math.min(keys.length - 1, i + 2)])
  const s2 = s * s, s3 = s2 * s
  for (const ax of ['x', 'y', 'z'] as const) {
    out[ax] = 0.5 * (2 * p1[ax] + (-p0[ax] + p2[ax]) * s + (2 * p0[ax] - 5 * p1[ax] + 4 * p2[ax] - p3[ax]) * s2 + (-p0[ax] + 3 * p1[ax] - 3 * p2[ax] + p3[ax]) * s3)
  }
  return out
}

export interface CameraPose { eye: THREE.Vector3; target: THREE.Vector3; fov: number }

/** Where an actor is in the scene: zone space (Y down), facing angle in radians (looking along cos, -sin in x/z). */
export interface ActorPose {
  x: number; y: number; z: number
  yaw: number
  moving: boolean
  /** The event hide flag (0x22 for the scene's own actor, 0x4E for any): a flashback hides you. */
  hidden?: boolean
  /** A scene-only NPC; `flagged` once the script has set its hide flag itself. */
  sceneOnly?: boolean
  flagged?: boolean
  /** A player race (1-8) for an NPC dressed as one, or you: emotes come from the race's files. */
  race?: number
  /** The action it plays (tlk0, thk1..): its motions in turn. */
  action?: { name: string; segments: Segment[] }
  /** Where a walk (0x1F, 0x31, 0x5A) is headed, at speed units a second. */
  walk?: { x: number; y: number; z: number; speed: number; until: number }
}

/** The player: every id the game uses for "you" comes to this one. */
export const PLAYER = ZONE_ACTOR
const isPlayer = (id: number) => id === 0x7ffffff0 || id === 0x7fffffc0 || id === 0x7ffffff9
/**
 * What blocks a line of sight, scene space: the distance to the first drawn
 * zone mesh from `from` along `dir` within `distance`, or null. Drawn meshes,
 * not the collision: a room's shelves and pillars aren't in the zone's.
 */
export type SightRay = (from: THREE.Vector3, dir: THREE.Vector3, distance: number) => number | null

/** Speed when the script sets none (0x32 sets it: operand x 0.1 units a second). */
const WALK_SPEED = 4

/** An NPC's pose while a scene moves it, by the id's low 12 bits (its post's index); NpcStations follows it. */
export function cutsceneNpcPose(index: number): ActorPose | null {
  return current?.npcPose(index) ?? null
}
/**
 * The motion an actor plays now, and how far in (seconds): its action's
 * motion while that runs; after, its last motion if that one keeps going
 * (looping, or held on its last frame), else null for its idle.
 */
export function cutsceneMotion(pose: ActorPose): { clips: ParsedAnimation[]; time: number } | null {
  const a = pose.action, now = current?.time ?? 0
  if (!a?.segments.length) return null
  let seg = a.segments[0]
  for (const s of a.segments) if (s.start <= now) seg = s
  if (now >= seg.end && !seg.loop && seg === a.segments[a.segments.length - 1]) return null
  let time = (now - seg.start) * seg.speed
  // Held, not looped: the last frame once it has played through.
  if (!seg.loop || now < seg.end) {
    const length = Math.max(...seg.clips.map(c => (c.frameCount - 1) / (30 * (c.speed || 1))))
    if (!seg.loop && time > length) time = Math.max(0, length - 1e-3)
  }
  return { clips: seg.clips, time }
}
/** Your character's motion now (cutsceneMotion), or null. */
export function cutscenePlayerMotion(): { clips: ParsedAnimation[]; time: number } | null {
  const p = current?.poses.get(PLAYER)
  return p ? cutsceneMotion(p) : null
}

/** Your character's pose in the scene, once the script has placed you. */
export function cutscenePlayerPose(): ActorPose | null {
  return current?.poses.get(PLAYER) ?? null
}

/** One actor's script: the game runs each actor's requested events alongside the others. */
interface Thread {
  actor: number
  block: EventBlock
  pc: number
  calls: number[]
  locals: Map<number, number>
  /** Walk speed set by 0x32, units a second. */
  speed: number
  waitUntil: number
  waiting: 'read' | 'choice' | 'load' | 'walk' | 'thread' | 'zone' | null
  /** 0x28/0x29: the thread this one waits for. */
  waitFor?: Thread
  /** Its place in the actor's event list, for requested events. */
  tag?: number
  /** Requested events queue per actor: the lowest number runs (the event itself starts at 16). */
  priority: number
  order: number
  done: boolean
  loops: number
  main: boolean
}

export class CutsceneRun {
  view: CutsceneView
  private vars = new Map<number, number>()
  private now = 0
  private threads: Thread[] = []
  private order = 0
  private files: Lib[] = []
  /** Motion files loaded for each actor (0x5B, 0x66): where its actions are found first. */
  private libs = new Map<number, Lib[]>()
  /** Scene seconds (cutsceneMotion reads it). */
  get time() { return this.now }
  private running: Running[] = []
  private camera: { keys: CameraKey[]; start: number; end: number } | null = null
  private fadeFrom: [number, number, number, number] = [1, 1, 1, 0]
  private fadeTo: [number, number, number, number] = [1, 1, 1, 0]
  private fadeStart = 0
  private fadeEnd = 0
  private world: CollisionWorld | null = null
  /** Actors the scene has moved, by id (PLAYER for you). */
  readonly poses = new Map<number, ActorPose>()
  /** Where the camera rests when no scheduler drives it: in front of the event's NPC (CutscenePlayer keeps it out of walls). */
  rest: CameraPose | null = null
  /** The NPC conversation's framings, best first; CutscenePlayer takes the first the walls allow. */
  restShots: CameraPose[] = []
  restCleared = false

  constructor(private r: CutsceneRequest) {
    this.view = { title: `${r.actorName} · Event ${r.eventId}`, message: null, fade: [1, 1, 1, 0], ended: false, note: null }
    this.threads.push(this.thread(r.block.actor, r.block, r.offset, true))
    if (r.block.actor !== ZONE_ACTOR) {
      const st = npcStations(r.zone.id).find(s => s[0] === (r.block.actor & 0xfff))
      if (st) {
        this.talkTo = { x: st[1], y: st[2], z: st[3], a: (st[4] / 256) * Math.PI * 2 }
        this.standYou()
      }
    }
  }

  /** An NPC conversation's NPC: where it stands and faces. */
  private talkTo: { x: number; y: number; z: number; a: number } | null = null

  /**
   * An NPC conversation: you stand 1.8 in front of the NPC (it faces cos a,
   * -sin a in zone x/z), the first spot round it a ray reaches clear (rooms
   * are small); then the framings: over your shoulder at its face, or side-on
   * two-shots of you both. The NPC turns to you when its script talks.
   */
  private standYou() {
    const n = this.talkTo!
    const { x, y, z } = n
    let a = n.a
    if (this.sight) {
      const from = toScene(x, y - 1.0, z)
      for (const deg of [0, 30, -30, 60, -60, 90, -90, 180]) {
        const b = n.a + (deg * Math.PI) / 180
        const dir = toScene(Math.cos(b), 0, -Math.sin(b))
        if (this.sight(from, dir, 2.3) === null) { a = b; break }
      }
    }
    const dx = Math.cos(a), dz = -Math.sin(a)
    const px = x + dx * 1.8, pz = z + dz * 1.8
    this.poses.set(PLAYER, { x: px, y: this.floor(px, y, pz) ?? y, z: pz, yaw: 0, moving: false })
    this.face(PLAYER, this.r.block.actor)
    const mx = (x + px) / 2, mz = (z + pz) / 2
    this.restShots = [
      // Over your shoulder at the NPC's face.
      { eye: toScene(px + dx * 1.6 + dz * 0.5, y - 1.9, pz + dz * 1.6 - dx * 0.5), target: toScene(x, y - 1.35, z), fov: 50 },
      // Side-on two-shots, from either side, at the space between you.
      { eye: toScene(mx + dz * 3, y - 1.6, mz - dx * 3), target: toScene(mx, y - 1.3, mz), fov: 50 },
      { eye: toScene(mx - dz * 3, y - 1.6, mz + dx * 3), target: toScene(mx, y - 1.3, mz), fov: 50 },
    ]
    this.rest = this.restShots[0]
  }

  /** The collision, to stand actors on the floor (CutscenePlayer passes it). */
  setWorld(world: CollisionWorld | null, sight: SightRay | null) {
    const first = !this.sight && sight
    this.world = world
    this.sight = sight
    // Your spot in a conversation needs the walls; the NPC hasn't turned yet (the scene's first tick follows).
    if (first && this.talkTo && !this.restCleared) this.standYou()
  }
  private sight: SightRay | null = null

  private thread(actor: number, block: EventBlock, pc: number, main = false): Thread {
    return { actor, block, pc, calls: [], locals: new Map(), speed: WALK_SPEED, waitUntil: 0, waiting: null, done: false, loops: 0, main, priority: 16, order: this.order++ }
  }

  private emit(v: Partial<CutsceneView>) {
    this.view = { ...this.view, ...v }
    set({ view: this.view })
  }

  // ── Operands ──
  private get(th: Thread, x: number): number {
    if (x & 0x8000) return th.block.refs[x & 0x7fff] | 0
    if (x < 80) return th.locals.get(x) ?? 0
    return this.vars.get(x) ?? this.live(th, x)
  }
  /** The live values: 0x7F00.. the event's actor (x, y, z), 0x7F80.. the player (x, z, y); positions x 1000, facing in 4096ths. */
  private live(th: Thread, x: number): number {
    const mine = x >= 0x7f00 && x <= 0x7f03, yours = x >= 0x7f80 && x <= 0x7f83
    const p = yours ? this.poses.get(PLAYER) : mine ? this.pose(th.actor) : null
    if (!p) return 0
    const k = x & 3
    if (k === 3) return Math.round((p.yaw / (Math.PI * 2)) * 4096)
    return Math.round([p.x, yours ? p.z : p.y, yours ? p.y : p.z][k] * 1000)
  }
  private u16(th: Thread, i: number) { const c = th.block.code; return c[th.pc + i] | (c[th.pc + i + 1] << 8) }
  private u32(th: Thread, i: number) { return (this.u16(th, i) | (this.u16(th, i + 2) << 16)) >>> 0 }
  private val(th: Thread, i: number) { return this.get(th, this.u16(th, i)) }
  private put(th: Thread, i: number, value: number) {
    const x = this.u16(th, i)
    if (x & 0x8000) return
    if (x < 80) th.locals.set(x, value | 0)
    else this.vars.set(x, value | 0)
  }
  private tag(th: Thread, i: number) { const n = this.u32(th, i); return String.fromCharCode(n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24).replace(/\0.*$/, '') }
  /** An actor operand as the actor it means: "this actor", "you", or an NPC's id. */
  private who(th: Thread, i: number): number {
    const id = this.u32(th, i)
    if (id === 0x7ffffff8) return th.actor
    return isPlayer(id) ? PLAYER : id
  }

  private name(id: number): string | null {
    if (id === PLAYER) return 'You'
    return this.r.names.get(id & 0xfff) ?? null
  }

  // ── Actors ──
  /** The actor's pose, starting from its post the first time the scene touches it. */
  private pose(id: number): ActorPose | null {
    let p = this.poses.get(id)
    if (!p && id === PLAYER) {
      p = { x: 0, y: 0, z: 0, yaw: 0, moving: false, hidden: true }
      this.poses.set(id, p)
    }
    if (!p && id !== PLAYER) {
      // A town NPC from its post; a scene-only one hidden until the scene shows, places or walks it.
      const st = npcStations(this.r.zone.id).find(s => s[0] === (id & 0xfff))
      const actor = st ? null : sceneActors(this.r.zone.id).find(s => s[0] === (id & 0xfff))
      const at = st ?? actor
      if (!at) return null
      p = { x: at[1], y: at[2], z: at[3], yaw: (at[4] / 256) * Math.PI * 2, moving: false, hidden: !!actor, sceneOnly: !!actor, race: Array.isArray(at[5]) ? at[5][0] : undefined }
      this.poses.set(id, p)
    }
    return p ?? null
  }
  npcPose(index: number): ActorPose | null {
    for (const [id, p] of this.poses) if (id !== PLAYER && (id & 0xfff) === index) return p
    return null
  }
  /** Places an actor, its height taken from the floor nearest the script's (the game calibrates it too). */
  private place(id: number, x: number, y: number, z: number, yaw?: number) {
    const fresh = !this.poses.has(id)
    const p = this.pose(id) ?? { x, y, z, yaw: 0, moving: false }
    // You appear where the scene first puts you (the stand-in pose is hidden until then).
    if (id === PLAYER && fresh) p.hidden = false
    // A scene-only NPC the script places is part of the scene, unless it hides it itself (the server may show it too).
    if (p.sceneOnly && !p.flagged) p.hidden = false
    p.x = x; p.z = z; p.y = this.floor(x, y, z) ?? y
    if (yaw !== undefined) p.yaw = yaw
    p.walk = undefined; p.moving = false
    this.poses.set(id, p)
  }
  private floor(x: number, y: number, z: number): number | null {
    if (!this.world) return null
    let best: number | null = null
    for (const wy of this.world.floorsAt(x, -z)) {
      const zy = -wy
      if (Math.abs(zy - y) <= 3 && (best === null || Math.abs(zy - y) < Math.abs(best - y))) best = zy
    }
    return best
  }
  /** Turns actor `a` toward actor `b` (the game's atan2(-dz, dx)). */
  private face(a: number, b: number) {
    const pa = this.pose(a), pb = this.pose(b)
    if (!pa || !pb || (pa.x === pb.x && pa.z === pb.z)) return
    pa.yaw = Math.atan2(-(pb.z - pa.z), pb.x - pa.x)
  }
  private walkTo(th: Thread, x: number, y: number, z: number, seconds?: number) {
    const p = this.pose(th.actor)
    if (!p) return
    if (p.sceneOnly && !p.flagged) p.hidden = false
    p.walk = { x, y, z, speed: th.speed, until: seconds ? this.now + seconds : Infinity }
  }
  /** Moves walking actors along, facing the way they go, on the floor. */
  private stepWalks(dt: number) {
    for (const p of this.poses.values()) {
      const w = p.walk
      if (!w) continue
      const dx = w.x - p.x, dz = w.z - p.z, d = Math.hypot(dx, dz)
      const step = w.speed * dt
      if (d <= step || this.now >= w.until) {
        p.x = w.x; p.z = w.z; p.y = this.floor(w.x, w.y, w.z) ?? w.y
        p.walk = undefined; p.moving = false
        continue
      }
      p.x += (dx / d) * step; p.z += (dz / d) * step
      p.y = this.floor(p.x, p.y, p.z) ?? p.y + (w.y - p.y) * (step / d)
      p.yaw = Math.atan2(-dz, dx)
      p.moving = true
    }
  }

  // ── Messages ──
  private say(lineIndex: number, speaker: string | null) {
    const text = this.r.lines[lineIndex] ?? ''
    const [body, options] = text.split('\u0001')
    this.emit({ message: options !== undefined ? { speaker, text: body, choices: options.split('\n').filter(Boolean) } : { speaker, text } })
  }
  /** The player read the message. */
  advance() {
    const th = this.threads.find(t => t.waiting === 'read')
    if (th) { th.waiting = null; this.emit({ message: null }) }
  }
  /** The player picked choice `i`. */
  choose(i: number) {
    const th = this.threads.find(t => t.waiting === 'choice')
    if (!th) return
    this.vars.set(4096, i)
    th.waiting = null
    this.emit({ message: null })
  }

  // ── Schedulers ──
  private async load(th: Thread, id: number) {
    th.waiting = 'load'
    const f = await loadEventFile(this.r.root, id)
    if (f) this.files.push(f)
    if (th.waiting === 'load') th.waiting = null
    return f
  }

  /**
   * An actor's action (SetAction): the scheduler `tag` from the actor's
   * motion files, else any loaded file, its motions (op 0x05, `tlk?` = every
   * body part's tlk clip in that file) played in turn, each starting and then
   * holding for its delay. False if no file has it.
   */
  private act(actor: number, tag: string, extra: Lib[] = []): boolean {
    const p = this.pose(actor)
    if (!p) return false
    const libs = [...extra, ...[...(this.libs.get(actor) ?? [])].reverse(), ...[...this.files].reverse()]
    const lib = libs.find(l => l.schedulers.has(tag))
    if (!lib) return false
    const segments: Segment[] = []
    let t = this.now
    for (const c of lib.schedulers.get(tag)!) {
      if (c.op === 0x05) {
        const stem = c.name.slice(0, 3)
        const clips = (lib.clips.some(a => a.name.startsWith(stem)) ? lib : libs.find(l => l.clips.some(a => a.name.startsWith(stem))))?.clips.filter(a => a.name.startsWith(stem)) ?? []
        if (clips.length) segments.push({ start: t, end: t + c.duration / FPS, clips, loop: c.loop, speed: c.speed })
      }
      t += c.delay / FPS
    }
    if (segments.length) p.action = { name: tag, segments }
    this.running = this.running.filter(x => x.name !== tag)
    this.running.push({ name: tag, start: this.now, end: t })
    return true
  }

  /** Loads an actor's motion file (0x5B: the file number's range picks the table; 0x66: you and the player races, 32712 + n). */
  private async loadMotions(th: Thread, actor: number, op: number, n: number) {
    th.waiting = 'load'
    const ids = op === 0x66
      ? [32712 + n, 32360 + n * 2, 32361 + n * 2]
      : [n < 512 ? n + 32104 : n < 1024 ? n + 49135 : n < 2048 ? n + 56345 : n < 3072 ? n + 59739 : n + 66339]
    const libs = (await Promise.all(ids.map(id => loadEventFile(this.r.root, id)))).filter((l): l is Lib => !!l)
    const list = this.libs.get(actor) ?? []
    // The newer table first; the old pair only fills in what it lacks.
    list.push(...libs.reverse())
    this.libs.set(actor, list)
    if (th.waiting === 'load') th.waiting = null
  }

  /** Starts a scheduler by name from the files loaded so far; its motions, if any, go to `actor`. */
  private startScheduler(name: string, actor?: number) {
    let cmds: SchedCommand[] | undefined, cams: Map<string, CameraKey[]> | undefined, lib: Lib | undefined
    for (let i = this.files.length - 1; i >= 0 && !cmds; i--) {
      const f = this.files[i]
      if (f?.schedulers.has(name)) { cmds = f.schedulers.get(name); cams = f.cameras; lib = f }
    }
    if (!cmds) return
    if (actor !== undefined && lib && cmds.some(c => c.op === 0x05)) this.act(actor, name, [lib])
    let t = this.now
    for (const c of cmds) {
      if (c.op === 0x04) {
        const keys = cams?.get(c.name)
        if (keys?.length) this.camera = { keys, start: t, end: t + c.duration / FPS }
      } else if (c.op === 0x0f) {
        this.fadeFrom = this.fadeNow()
        // A multiplier on the picture: 0x80 = x1, alpha 0x80 = full strength.
        this.fadeTo = [c.rgba[0] / 128, c.rgba[1] / 128, c.rgba[2] / 128, Math.min(1, c.rgba[3] / 128)]
        this.fadeStart = t; this.fadeEnd = t + c.duration / FPS
      }
      t += c.delay / FPS
    }
    this.running = this.running.filter(x => x.name !== name)
    this.running.push({ name, start: this.now, end: t })
  }

  private fadeNow(): [number, number, number, number] {
    if (this.now >= this.fadeEnd) return this.fadeTo
    if (this.now <= this.fadeStart) return this.fadeFrom
    const u = (this.now - this.fadeStart) / Math.max(1e-6, this.fadeEnd - this.fadeStart)
    return this.fadeFrom.map((a, i) => a + (this.fadeTo[i] - a) * u) as [number, number, number, number]
  }

  /** The camera the cutscene wants now, or null to leave it where it is. */
  cameraPose(): CameraPose | null {
    const c = this.camera
    if (!c) return this.rest
    const u = Math.min(1, Math.max(0, (this.now - c.start) / Math.max(1e-6, c.end - c.start)))
    const eye = along(c.keys, u, k => k.eye, new THREE.Vector3())
    const target = along(c.keys, u, k => k.target, new THREE.Vector3())
    // The lens between keys: linear by time.
    let i = 0
    while (i < c.keys.length - 1 && u > c.keys[i + 1].t) i++
    const a = c.keys[i], b = c.keys[Math.min(c.keys.length - 1, i + 1)]
    const lens = b.t > a.t ? a.lens + (b.lens - a.lens) * Math.min(1, (u - a.t) / (b.t - a.t)) : a.lens
    const fov = lens > 0 ? (2 * Math.atan(HALF_SCREEN / lens) * 180) / Math.PI : 50
    return { eye, target, fov }
  }

  /** The zone the scene asked for (0x34/0x35) is up: scripts waiting for it go on. */
  zoneReady(zoneId: number) {
    if (state.sceneZone !== zoneId) return
    for (const th of this.threads) if (th.waiting === 'zone') th.waiting = null
  }

  /** Advances the scene by `dt` seconds: walks, fades, and every actor's script to its next wait. */
  tick(dt: number) {
    const t = this.now + dt
    this.now = t
    this.stepWalks(dt)
    const fade = this.fadeNow()
    if (fade.some((x, i) => Math.abs(x - this.view.fade[i]) > 0.002)) this.emit({ fade })
    if (this.view.ended) return
    // One script an actor at a time, as the game's request stack runs: the
    // most urgent (lowest priority number), the oldest of equals.
    const turn = new Map<number, Thread>()
    for (const th of this.threads) {
      if (th.done) continue
      const cur = turn.get(th.actor)
      if (!cur || th.priority < cur.priority || (th.priority === cur.priority && th.order < cur.order)) turn.set(th.actor, th)
    }
    for (const th of [...this.threads]) {
      if (th.done || turn.get(th.actor) !== th) continue
      for (let budget = STEP_BUDGET; budget > 0; budget--) {
        if (th.waiting === 'walk' && !this.pose(th.actor)?.walk) th.waiting = null
        if (th.waiting === 'thread' && th.waitFor?.done) th.waiting = null
        if (th.waiting || t < th.waitUntil) break
        const code = th.block.code
        if (th.pc >= code.length || !opSize(code, th.pc)) {
          if (th.main) return this.end('The script stopped on something this player can’t read yet.')
          th.done = true
          break
        }
        const next = this.step(th)
        if (next === 'end') {
          th.done = true
          if (th.main) return this.end(null)
          break
        }
        if (next === 'yield') break
      }
    }
    this.threads = this.threads.filter(x => !x.done || x.main)
  }

  private end(note: string | null) {
    this.emit({ ended: true, message: null, note })
  }

  /**
   * Starts actor `id`'s event number `tag` (its place in the actor's event
   * list, as the game's ReqSet takes it), unless that one is running already.
   */
  private request(id: number, tag: number, priority: number): Thread | null {
    const block = this.r.blocks.find(b => (id === PLAYER ? b.actor === ZONE_ACTOR : b.actor === id))
    const ev = block?.events[tag]
    if (!block || !ev) return null
    const running = this.threads.find(x => !x.done && x.actor === id && x.tag === tag)
    if (running) return running
    const th = this.thread(id, block, ev.offset)
    th.tag = tag
    th.priority = priority
    this.threads.push(th)
    return th
  }

  /** One instruction: moves pc; 'yield' gives the frame back. */
  private step(th: Thread): 'go' | 'yield' | 'end' {
    const code = th.block.code
    const op = code[th.pc], sub = code[th.pc + 1]
    const size = opSize(code, th.pc)
    const goTo = (target: number) => {
      if (target <= th.pc && ++th.loops > LOOP_LIMIT) {
        if (th.main) this.end('The script waits on the game server here, so it stops.')
        return 'end' as const
      }
      th.pc = target
      return 'go' as const
    }
    switch (op) {
      case 0x00: return 'end'
      case 0x21: th.pc += size; return th.main ? 'end' : 'go'
      case 0x01: return goTo(this.u16(th, 1))
      case 0x1a: th.calls.push(th.pc + size); return goTo(this.u16(th, 1))
      case 0x1b: return th.calls.length ? goTo(th.calls.pop()!) : 'end'
      case 0x02: {
        const a = this.val(th, 1), b = this.val(th, 3)
        // Each kind jumps when its test holds, except kind 0, which falls through when equal.
        const k = code[th.pc + 5] & 15
        const jump = [a !== b, a === b, a <= b, a >= b, a < b, a > b, (a & b) === 0, a === b, (a | b) === 0, (a & b) === 0][k] ?? true
        return jump ? goTo(this.u16(th, 6)) : (th.pc += size, 'go')
      }
      case 0x3e: {
        const bit = this.val(th, 3), word = this.get(th, this.u16(th, 1) + (bit >> 5))
        return word & (1 << (bit & 31)) ? (th.pc += size, 'go') : goTo(this.u16(th, 5))
      }
      case 0x44: th.pc += size; return 'go'   // "is this actor here": take it as yes
      case 0x03: this.put(th, 1, this.val(th, 3)); break
      case 0x05: this.put(th, 1, 1); break
      case 0x06: this.put(th, 1, 0); break
      case 0x07: this.put(th, 1, this.val(th, 1) + this.val(th, 3)); break
      case 0x08: this.put(th, 1, this.val(th, 1) - this.val(th, 3)); break
      case 0x09: this.put(th, 1, this.val(th, 1) | (1 << this.val(th, 3))); break
      case 0x0a: this.put(th, 1, this.val(th, 1) & ~(1 << this.val(th, 3))); break
      case 0x0b: this.put(th, 1, this.val(th, 1) + 1); break
      case 0x0c: this.put(th, 1, this.val(th, 1) - 1); break
      case 0x0d: this.put(th, 1, this.val(th, 1) & this.val(th, 3)); break
      case 0x0e: this.put(th, 1, this.val(th, 1) | this.val(th, 3)); break
      case 0x1c: {
        // Wait (frames): the first visit sets the time, the next finds it passed.
        th.pc += size
        th.waitUntil = this.now + Math.max(0, this.val(th, 1)) / FPS
        return 'yield'
      }
      case 0x1d: this.say(this.val(th, 1), th.actor === PLAYER ? null : this.name(th.actor) ?? this.r.actorName); break
      case 0x2b: this.say(this.val(th, 5), this.name(this.who(th, 1))); break
      case 0x48: case 0x49: this.say(this.val(th, op === 0x48 ? 1 : 5), null); break
      case 0xb0: if (!sub) this.say(this.val(th, 10), this.name(this.who(th, 2))); break
      case 0x23: th.pc += size; th.waiting = 'read'; return 'yield'
      case 0x24: this.say(this.val(th, 1), null); break
      case 0x25: case 0x7f: th.pc += size; th.waiting = 'choice'; return 'yield'
      // Other actors' events: 0x27 starts one, 0x28 and 0x29 start one and wait for it.
      case 0x27: case 0x28: case 0x29: {
        const other = this.request(this.who(th, 2), code[th.pc + 6], sub)
        th.pc += size
        if (other && op !== 0x27) { th.waitFor = other; th.waiting = 'thread'; return 'yield' }
        return 'go'
      }
      // Positions: x, z, y in thousandths; facing in 4096ths of a turn.
      case 0x36: this.place(th.actor, this.val(th, 1) / 1000, this.val(th, 5) / 1000, this.val(th, 3) / 1000); break
      case 0x37: this.place(th.actor, this.val(th, 1) / 1000, this.val(th, 5) / 1000, this.val(th, 3) / 1000, (this.val(th, 7) / 4096) * Math.PI * 2); break
      case 0x39: { const p = this.pose(th.actor); if (p) p.yaw = (this.val(th, 1) / 4096) * Math.PI * 2; break }
      case 0x4b: { const p = this.pose(this.who(th, 1)); if (p) p.yaw = (this.val(th, 5) / 4096) * Math.PI * 2; break }
      case 0x1e: this.face(th.actor, this.who(th, 1)); break
      case 0x4a: this.face(this.who(th, 1), this.who(th, 5)); break
      case 0x79: if (sub !== 2) this.face(this.who(th, 2), this.who(th, 6)); break
      case 0x3a: { const p = this.pose(this.who(th, 1)); this.put(th, 5, p ? Math.round((p.yaw / (Math.PI * 2)) * 4096) : 0); break }
      case 0x3b: {
        const p = this.pose(this.who(th, 1))
        this.put(th, 5, p ? Math.round(p.x * 1000) : 0); this.put(th, 7, p ? Math.round(p.z * 1000) : 0); this.put(th, 9, p ? Math.round(p.y * 1000) : 0)
        break
      }
      case 0x32: th.speed = this.val(th, 1) / 10 || WALK_SPEED; break
      // Another zone for the scene (0x34; 0x35 the same without closing the first): the app opens it, the script waits.
      case 0x34: case 0x35: {
        const zone = this.val(th, 1)
        th.pc += size
        if (zone !== state.sceneZone) { set({ sceneZone: zone }); th.waiting = 'zone'; return 'yield' }
        return 'go'
      }
      // The hour (and weather, not kept) for the scene; 255 leaves it.
      case 0x77: { const h = this.val(th, 1); if (h !== 255) set({ sceneHour: h }); break }
      case 0x78: set({ sceneHour: null }); break
      // Music: 0x5C sets a slot's song (0 day, 1 night idle; the rest are battle, mount, death); 0x5D the volume, of 127.
      case 0x5c: if ((sub & 7) <= 1) { const song = this.val(th, 2); if (song > 0 && song !== state.sceneMusic) set({ sceneMusic: song }) } break
      case 0x5d: set({ sceneVolume: Math.max(0, Math.min(1, this.val(th, 1) / 127)) }); break
      // An emote: the actor's race's emote files list them bow, point, salute, kneel, laugh, cry, no, yes,
      // wave.. eight a file (em00-em07); the scripts count from 1 (1 = bow, their most used).
      case 0x6e: {
        const actor = this.who(th, 1), n = Math.max(0, this.val(th, 5) - 1)
        const race = actor === PLAYER ? state.playerRace : this.pose(actor)?.race
        const path = race ? emoteFile(race, n) : null
        if (path) void loadEventFile(this.r.root, path).then(lib => { if (lib) this.act(actor, 'em0' + (n % 8), [lib]) })
        break
      }
      case 0x22: { const p = this.pose(th.actor); if (p) { p.hidden = !!(sub & 1); p.flagged = true } break }
      case 0x4e: { const p = this.pose(this.who(th, 2)); if (p) { p.hidden = !!(sub & 1); p.flagged = true } break }
      // Walks: sub-code 0 sets the goal (x, z, y; 0x31 a time too), 1 waits until there.
      case 0x1f: case 0x31: case 0x5a:
        if (sub === 0) this.walkTo(th, this.val(th, 2) / 1000, this.val(th, 6) / 1000, this.val(th, 4) / 1000, op === 0x31 ? this.val(th, 8) / 1000 : undefined)
        else { th.pc += size; if (this.pose(th.actor)?.walk) { th.waiting = 'walk'; return 'yield' } return 'go' }
        break
      // An actor's action by name (0x2C); a zone's (0x2D) are scene schedulers.
      case 0x2c: if (!this.act(this.who(th, 1), this.tag(th, 9))) this.startScheduler(this.tag(th, 9), this.who(th, 1)); break
      case 0x2d: this.startScheduler(this.tag(th, 9)); break
      // Motion files for an actor, then its action from them ("xxxx" = load only).
      case 0x5b: case 0x66: {
        const actor = this.who(th, 3), tag = this.tag(th, 11), n = this.val(th, 1)
        th.pc += size
        void this.loadMotions(th, actor, op, n).then(() => { if (tag && tag !== 'xxxx') this.act(actor, tag) })
        return 'yield'
      }
      case 0x50: case 0x51: this.stopScheduler(this.tag(th, 9), this.who(th, 1)); break
      case 0x53: case 0x54: return this.waitScheduler(th, this.tag(th, 9), size)
      default:
        if (op in LOADERS) {
          const tag = this.tag(th, 11)
          let n = this.val(th, 1)
          if (op === 0x45) n = n >= 600 ? n + 39643 : n >= 300 ? n + 25937 : n
          const id = LOADERS[op] + n
          th.pc += size
          const actor = this.who(th, 3)
          void this.load(th, id).then(() => this.startScheduler(tag, actor))
          return 'yield'
        }
        if (WAITS_15.has(op)) return this.waitScheduler(th, this.tag(th, 11), size)
        if (STOPS_15.has(op)) this.stopScheduler(this.tag(th, 11), this.who(th, 3))
        if (op === 0x46 && sub === 0) this.camera = null
    }
    th.pc += size
    return 'go'
  }

  private stopScheduler(name: string, actor?: number) {
    this.running = this.running.filter(x => x.name !== name)
    const p = actor !== undefined ? this.poses.get(actor) : undefined
    if (p?.action?.name === name) p.action = undefined
  }

  private waitScheduler(th: Thread, name: string, size: number): 'go' | 'yield' {
    const r = this.running.find(x => x.name === name)
    th.pc += size
    if (r && r.end > this.now) { th.waitUntil = r.end; return 'yield' }
    return 'go'
  }
}
