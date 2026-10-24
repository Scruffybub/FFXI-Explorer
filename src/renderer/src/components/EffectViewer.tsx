import { useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import type { ParsedAnimation, ParsedDatFile, ParsedZone } from '../lib/ffxi-dat'
import type { RoutineCommand, EffectRoutine } from '../lib/ffxi-dat/EffectRoutineParser'
import type { GeneratorSpawn } from '../lib/ffxi-dat/types'
import type { ModelSettings } from '../lib/settings'
import { buildModel, type BuiltModel } from '../lib/modelBuild'
import { childEvents } from '../lib/weatherEvents'
import { playSound } from '../lib/footstepSounds'
import { RendererSettings } from './ModelViewer'
import { invertRigidMatrix4, poseSkeleton, skinMeshes } from '../lib/skinning'
import { EffectParticles } from './WeatherParticles'
import { GAMMA_BLEND_LAYER } from '../lib/GammaBlendPass'

/**
 * Models → Effects: a caster and a target on a stage, and a spell's effect
 * file played between them.
 *
 * The effect file is read as a small zone (parseZoneFile): its generators,
 * meshes, sprites, keyframes and sound pointers, and its routines (block
 * 0x07). Play runs the `main` routine (xim EffectDisplayer) with the caster as
 * its actor:
 *
 *   generator  start it for `duration` frames, posting one emission per its
 *              own interval, at the actor's joint its header names — attach
 *              1 the caster's (joint 0), 2 the target's (joint 1)
 *   routine    run another routine of this file, from now; op 0x09 swaps
 *              caster and target. Routines from elsewhere (the shared damage
 *              reaction `mdam`) are skipped.
 *   sound      play its sound pointer
 *
 * Before the script, the caster casts: the race file's cast routine for the
 * magic type (chant motion, casting circle) runs for CAST_SECONDS; the
 * spell's script then calls the release routines. Every motion is one a
 * routine names (characterModel loadCastClips). Joints are read from the
 * live pose. Rings (link 0x24) are built by ZoneFile.
 *
 * Beams (attach 3/6) are stretched between the actors and caster-attached
 * effects turn with the caster (ChildEvent basis). Not yet (2026-10-24):
 * songs' and geomancy's casts, pitch in beams, distortion and weighted meshes.
 */

const EFFECT_FPS = 60
/** How long the caster chants before the spell goes off, seconds (the game's cast times vary; Cure's is 2). */
const CAST_SECONDS = 2.5
const EMPTY_ZONE: ParsedZone = { prefabs: [], instances: [], textures: [], textureNames: [], collision: null, environment: [], spawns: [] }
/** Caster and target stand this far apart, world units (a little under casting range). */
const SPACING = 4.5

/**
 * How far a model reaches ahead of its origin (its +X, the way it faces) and
 * how tall it is, from its vertices: the 98th percentile, since some models
 * park hidden parts thousands of units away. A behemoth stood on top of the
 * caster at a fixed spacing.
 */
function modelReach(model: ParsedDatFile): { front: number; height: number } {
  const xs: number[] = [], ys: number[] = []
  for (const m of model.meshes) {
    for (let i = 0; i < m.vertices.length; i += 9) { xs.push(m.vertices[i]); ys.push(-m.vertices[i + 1]) }
  }
  if (!xs.length) return { front: 0.5, height: 2 }
  const at = (v: number[], q: number) => v.sort((a, b) => a - b)[Math.min(v.length - 1, Math.floor(v.length * q))]
  return { front: Math.max(0.3, at(xs, 0.98)), height: Math.max(0.5, at(ys, 0.98) - at(ys, 0.02)) }
}

/** Puts the camera back far enough for both actors, looking at their middle. */
function FrameStage({ gap, height }: { gap: number; height: number }) {
  const camera = useThree(st => st.camera)
  const controls = useThree(st => st.controls) as unknown as { target?: THREE.Vector3; update?: () => void } | null
  useEffect(() => {
    const look = Math.min(height * 0.45, 4)
    camera.position.set(0, look + 1.2, Math.max(8.5, gap * 1.2 + height * 0.8))
    controls?.target?.set(0, look, 0)
    controls?.update?.()
  }, [camera, controls, gap, height])
  return null
}

export interface EffectBundle {
  zone: ParsedZone
  /** Install-relative path, for the readout. */
  path: string
  /** The caster race's file (cast and release routines) and the shared ROM/0/0.DAT, read the same way. */
  race: ParsedZone | null
  shared: ParsedZone | null
  /** The race's cast routine for the spell's magic type (spellList castRoutine); none for skills. */
  castRoutine: string | null
  /** Motions in the effect file itself: a weapon skill's own (Fast Blade b00?, b02?). */
  motions: ParsedAnimation[]
}

/** One placed actor: where its joints are in the world, and what it plays. */
interface Stage {
  joint(index: number, out: THREE.Vector3): THREE.Vector3
  /** How far the model is turned about the vertical, world radians. */
  yaw: number
  /**
   * Plays a motion now: looping, held on its last frame until told otherwise,
   * or once and then back to idle.
   */
  play(clips: ParsedAnimation[], mode: 'loop' | 'hold' | 'once'): void
}

/** Seconds one pass of a motion takes: its longest part, 30 frames a second times its speed. */
const motionSeconds = (clips: ParsedAnimation[]) =>
  clips.reduce((m, c) => Math.max(m, Math.max(c.frameCount - 1, 0) / (30 * (c.speed || 1))), 0)

/**
 * A model standing on the ground at `x`, turned to `yaw`, posed on the CPU
 * like ModelViewer's Animator but driven from outside: idle by default,
 * another motion when `play` is called. Its joint references (SkeletonParser
 * jointRefs) are read from the live pose, so an effect on the hands follows
 * the hands.
 */
function Actor({ model, idle, x, yaw, onStage }: {
  model: ParsedDatFile
  /** What it does when not told otherwise; none stands in bind pose. */
  idle: ParsedAnimation[]
  x: number
  yaw: number
  onStage: (stage: Stage | null) => void
}) {
  const [built, setBuilt] = useState<BuiltModel | null>(null)
  useEffect(() => {
    const next = buildModel(model)
    setBuilt(next)
    return () => {
      for (const mesh of next.meshes) {
        mesh.geometry.dispose()
        const mat = mesh.material as THREE.MeshStandardMaterial
        mat.map?.dispose()
        mat.dispose()
      }
    }
  }, [model])
  const inverseBind = useMemo(() => model.skeleton?.matrices.map(invertRigidMatrix4) ?? null, [model.skeleton])
  const motion = useRef<{ clips: ParsedAnimation[]; mode: 'loop' | 'hold' | 'once'; t: number }>({ clips: idle, mode: 'loop', t: 0 })
  useEffect(() => { motion.current = { clips: idle, mode: 'loop', t: 0 } }, [idle])
  const pose = useRef<number[][] | null>(null)
  // Model space is Y down, so the lowest point is the largest y: lift by it.
  const lift = built ? built.bounds.max.y : 0
  useEffect(() => {
    if (!built) { onStage(null); return }
    const placed = new THREE.Matrix4()
      .makeTranslation(x, 0, 0)
      .multiply(new THREE.Matrix4().makeRotationY(yaw))
      .multiply(new THREE.Matrix4().makeRotationX(Math.PI))
      .multiply(new THREE.Matrix4().makeTranslation(0, -lift, 0))
    const refs = model.skeleton?.jointRefs ?? []
    onStage({
      yaw,
      joint(index, out) {
        const ref = refs[index]
        const m = ref ? (pose.current ?? model.skeleton?.matrices)?.[ref.bone] : undefined
        if (!ref || !m) return out.set(0, lift, 0).applyMatrix4(placed)
        const [ox, oy, oz] = ref.offset
        out.set(
          ox * m[0] + oy * m[4] + oz * m[8] + m[12],
          ox * m[1] + oy * m[5] + oz * m[9] + m[13],
          ox * m[2] + oy * m[6] + oz * m[10] + m[14],
        )
        return out.applyMatrix4(placed)
      },
      play(clips, mode) { motion.current = clips.length ? { clips, mode, t: 0 } : { clips: idle, mode: 'loop', t: 0 } },
    })
    return () => onStage(null)
  }, [built, model, x, yaw, lift, onStage, idle])
  useFrame((_, delta) => {
    const skeleton = model.skeleton
    if (!built || !skeleton || !inverseBind || built.skinTargets.length === 0) return
    const m = motion.current
    m.t += delta
    // A one-off holds its last frame a moment, then goes back to idle.
    const once = motionSeconds(m.clips)
    if (m.mode === 'once' && m.t > once + 0.15) motion.current = { clips: idle, mode: 'loop', t: 0 }
    const now = motion.current
    const time = now.mode === 'loop' ? now.t : Math.min(now.t, Math.max(once - 1 / 60, 0))
    const posed = poseSkeleton(skeleton, now.clips, inverseBind, time)
    skinMeshes(built.skinTargets, posed)
    for (const mesh of built.meshes) mesh.geometry.getAttribute('position').needsUpdate = true
    pose.current = posed.worldMats
  })
  if (!built) return null
  return (
    <group position={[x, 0, 0]} rotation={[0, yaw, 0]}>
      <group rotation={[Math.PI, 0, 0]}>
        <group position={[0, -lift, 0]}>
          {built.meshes.map((mesh, i) => <primitive key={i} object={mesh} />)}
        </group>
      </group>
    </group>
  )
}

/** A routine running: where it is in its commands, which file it came from, and who it plays for. */
interface Sequence {
  routine: EffectRoutine
  /** Index into the runner's sources: the file its generators and calls are looked up in first. */
  src: number
  index: number
  /** Effect frame the previous command ran at; the next runs `delay` after. */
  cursor: number
  caster: Stage
  target: Stage
}

/** A generator emitting: its posts until `until`, every `every` frames. */
interface Running {
  spawn: GeneratorSpawn
  at: THREE.Vector3
  /** A beam's frame (attach 3 and 6), ChildEvent basis. */
  basis?: { yaw: number; length: number }
  next: number
  until: number
}

/** Census (?census=1): what the last play did. */
interface RunLog { started: string[]; skipped: string[]; sounds: number[]; routines: string[] }

/**
 * Runs the routines. `sources` are the files to look things up in, in order:
 * the spell's own, the caster race's (its cast and release routines), and the
 * shared effects file ROM/0/0.DAT (casting circles `ner?`, release bursts
 * `eis?`, hit sparks). A routine's names are looked for in its own file
 * first, then in the others in that order.
 */
function EffectRunner({ sources, castRoutine, ownMotions, caster, target, playId, volume, casterMotions }: {
  sources: ParsedZone[]
  /** Motions the effect file carries, looked for before the race file's. */
  ownMotions: ParsedAnimation[]
  /** The race's cast routine for this magic type (`cawh`, `cabk`...), or null. */
  castRoutine: string | null
  caster: Stage | null
  target: Stage | null
  playId: number
  volume: number
  /** Every motion the caster's own files hold: a player's race file, a monster's model. */
  casterMotions: ParsedAnimation[]
}) {
  const sequences = useRef<Sequence[]>([])
  /** The effect frame the spell's script starts at, after the cast; -1 when none is waiting. */
  const scriptAt = useRef(-1)
  const running = useRef<Running[]>([])
  const pending = useRef(-1)
  const log = useRef<RunLog>({ started: [], skipped: [], sounds: [], routines: [] })
  useEffect(() => { pending.current = playId }, [playId])

  // Look-ups by name in one file: the asking folder first, then anywhere.
  const find = useMemo(() => {
    const byName = <T extends { dir: string }>(list: T[], want: string, dir: string, name: (t: T) => string): T[] => {
      const all = list.filter(t => name(t) === want)
      const local = all.filter(t => t.dir === dir)
      return local.length ? local : all
    }
    /** The first source, from `from` on and then the earlier ones, that has a match. */
    const across = <T,>(from: number, pick: (z: ParsedZone) => T[]): { src: number; hits: T[] } => {
      const order = [from, ...sources.map((_, i) => i).filter(i => i !== from)]
      for (const i of order) {
        const hits = pick(sources[i])
        if (hits.length) return { src: i, hits }
      }
      return { src: from, hits: [] }
    }
    return {
      routine: (from: number, dir: string, want: string) => across(from, z => byName(z.routines ?? [], want, dir, r => r.name)),
      spawn: (from: number, dir: string, want: string) => across(from, z => byName(z.spawns ?? [], want, dir, sp => sp.generator)),
      ambient: (from: number, dir: string, want: string) => across(from, z => byName(z.ambient ?? [], want, dir, a => a.generator)),
      sound: (from: number, dir: string, want: string) => across(from, z => byName(z.sounds ?? [], want, dir, x => x.name)),
    }
  }, [sources])

  useFrame(({ clock }) => {
    const now = clock.getElapsedTime() * EFFECT_FPS
    const startRoutine = (src: number, name: string, at: number, c: Stage, t: Stage) => {
      const r = find.routine(src, '', name)
      if (!r.hits.length) { log.current.skipped.push('routine ' + name); return false }
      sequences.current.push({ routine: r.hits[0], src: r.src, index: 0, cursor: at, caster: c, target: t })
      log.current.routines.push(name)
      return true
    }
    if (pending.current >= 0 && caster && target) {
      pending.current = -1
      running.current = []
      sequences.current = []
      log.current = { started: [], skipped: [], sounds: [], routines: [] }
      // Cast first, as the game does before the spell's own script: the
      // race's cast routine (the chant and the casting circle), for the cast
      // time. Songs and geomancy have none (their op 0x76 is not read).
      const casting = !!castRoutine && sources.length > 1 && startRoutine(1, castRoutine, now, caster, target)
      scriptAt.current = now + (casting ? CAST_SECONDS * EFFECT_FPS : 0)
    }
    if (scriptAt.current >= 0 && now >= scriptAt.current && caster && target) {
      const main = (sources[0].routines ?? []).find(r => r.name === 'main') ?? sources[0].routines?.[0]
      if (main) {
        sequences.current.push({ routine: main, src: 0, index: 0, cursor: scriptAt.current, caster, target })
        log.current.routines.push(main.name)
      }
      scriptAt.current = -1
    }
    const tmp = new THREE.Vector3()
    const run = (seq: Sequence, cmd: RoutineCommand, at: number) => {
      if (cmd.kind === 'generator') {
        const found = find.spawn(seq.src, seq.routine.dir, cmd.ref)
        for (const sp of found.hits) {
          // Attach (xim AttachType): 1 caster, 2 target, 3 caster-to-target
          // beam (from the caster), 5 caster facing the target, 6
          // target-to-caster beam (from the target), 9 the caster's weapon.
          const onCaster = sp.attach === 1 || sp.attach === 3 || sp.attach === 5 || sp.attach === 9
          const actor = onCaster ? seq.caster : seq.target
          const where = actor.joint(onCaster ? sp.joints[0] : sp.joints[1], tmp).clone()
          // A beam runs from this joint to the other actor's: its frame's X
          // axis spans the gap (world to DAT: x, -y, -z, so DAT yaw is
          // atan2(world dz, world dx)).
          let basis: Running['basis']
          if (sp.attach === 3 || sp.attach === 6) {
            const other = (onCaster ? seq.target : seq.caster).joint(onCaster ? sp.joints[1] : sp.joints[0], new THREE.Vector3())
            const d = other.sub(where)
            basis = { yaw: Math.atan2(d.z, d.x), length: Math.max(d.length(), 0.01) }
          } else if (sp.attach === 1 || sp.attach === 4 || sp.attach === 5 || sp.attach === 9) {
            // Turned with the caster (xim updateAssociatedFacing), so an effect
            // authored in front of it stays in front however the model is
            // turned. A world turn about Y is the opposite turn in DAT axes.
            basis = { yaw: -seq.caster.yaw, length: 1 }
          }
          running.current.push({ spawn: sp, at: where, basis, next: at, until: at + Math.max(cmd.duration, 0) })
          log.current.started.push(cmd.ref)
        }
        const sounds = find.ambient(seq.src, seq.routine.dir, cmd.ref).hits
        for (const s of sounds) {
          playSound(s.id, volume)
          log.current.sounds.push(s.id)
        }
        if (!found.hits.length && !sounds.length) log.current.skipped.push('gen ' + cmd.ref)
      } else if (cmd.kind === 'routine') {
        const [c, t] = cmd.onTarget ? [seq.target, seq.caster] : [seq.caster, seq.target]
        startRoutine(seq.src, cmd.ref, at, c, t)
      } else if (cmd.kind === 'ranged') {
        // The race file's lc<type> / ls<type> (xim resolveRangedEffectId): a
        // song with no instrument sings (00), geomancy rings its handbell
        // (11, RangeType.HandbellGeo), anything else throws (05).
        const code = cmd.subtype === 1 ? '00' : cmd.subtype === 2 ? '11' : '05'
        startRoutine(seq.src, (cmd.start ? 'lc' : 'ls') + code, at, seq.caster, seq.target)
      } else if (cmd.kind === 'stop') {
        running.current = running.current.filter(r => r.spawn.generator !== cmd.ref)
      } else if (cmd.kind === 'stopRoutine') {
        sequences.current = sequences.current.filter(s => s.routine.name !== cmd.ref)
      } else if (cmd.kind === 'motion') {
        // A race-file motion by name, ? any body part: stage 0 (the chant)
        // loops, a last stage 2 plays once, and stage 1 holds its end until
        // the next (white magic's raised hand waits for its recovery) — or
        // loops when the family has no stage 0 (singing is sk1, then sk2).
        const prefix = cmd.ref.replace(/\?$/, '')
        const pool = [...ownMotions, ...casterMotions]
        const clips = pool.filter(c => c.name.startsWith(prefix))
        if (!clips.length) { log.current.skipped.push('motion ' + cmd.ref); return }
        const stage = prefix[2]
        const hasStart = pool.some(c => c.name.startsWith(prefix.slice(0, 2) + '0'))
        seq.caster.play(clips, stage === '0' || (stage === '1' && !hasStart) ? 'loop' : stage === '2' ? 'once' : 'hold')
      } else if (cmd.kind === 'sound') {
        const s = find.sound(seq.src, seq.routine.dir, cmd.ref).hits[0]
        if (s) { playSound(s.id, volume); log.current.sounds.push(s.id) } else log.current.skipped.push('sound ' + cmd.ref)
      }
    }
    // Run every command whose time has come; a called routine joins the list.
    for (let k = 0; k < sequences.current.length; k++) {
      const seq = sequences.current[k]
      while (seq.index < seq.routine.commands.length) {
        const cmd = seq.routine.commands[seq.index]
        if (seq.cursor + cmd.delay > now) break
        seq.cursor += cmd.delay
        seq.index++
        if (cmd.kind === 'end') { seq.index = seq.routine.commands.length; break }
        run(seq, cmd, seq.cursor)
      }
    }
    sequences.current = sequences.current.filter(s => s.index < s.routine.commands.length)
    // Emit: one post per interval while running (a zero duration, one post).
    for (const r of running.current) {
      while (r.next <= now && r.next <= r.until) {
        childEvents.push({ name: r.spawn.generator, dir: r.spawn.dir, frame: r.next, at: r.at, basis: r.basis })
        r.next += Math.max(1, r.spawn.emission.every)
      }
    }
    running.current = running.current.filter(r => r.next <= r.until)
    if (CENSUS) (window as unknown as { __fxrun?: RunLog }).__fxrun = log.current
  })
  return null
}

/** Particles draw on the gamma-blend layer (a zone draws it in its own pass); with no passes here, the camera draws it. */
function ParticleLayer() {
  const camera = useThree(s => s.camera)
  useEffect(() => {
    camera.layers.enable(GAMMA_BLEND_LAYER)
    if (CENSUS) (window as unknown as { __fxCamera?: THREE.Camera }).__fxCamera = camera
  }, [camera])
  return null
}

const CENSUS = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('census')

export function EffectViewer({ caster, casterIdle, casterMotions, target, targetIdle, effect, playId, settings, volume }: {
  /** Who uses the effect: your character, or a monster for its moves. */
  caster: ParsedDatFile | null
  casterIdle: ParsedAnimation[]
  /** Motions the caster's routines can name (a player's race file, a monster's model). */
  casterMotions: ParsedAnimation[]
  target: ParsedDatFile | null
  targetIdle: ParsedAnimation[]
  effect: EffectBundle | null
  /** Bumped to play the effect (again). */
  playId: number
  settings: ModelSettings
  volume: number
}) {
  const [casterStage, setCasterStage] = useState<Stage | null>(null)
  const [targetStage, setTargetStage] = useState<Stage | null>(null)
  // Apart by size: each one's reach toward the other, plus room between.
  const { gap, height } = useMemo(() => {
    const a = caster ? modelReach(caster) : { front: 0.5, height: 2 }
    const b = target ? modelReach(target) : { front: 0.5, height: 2 }
    return { gap: Math.max(SPACING, a.front + b.front + 2.5), height: Math.max(a.height, b.height) }
  }, [caster, target])
  const sources = useMemo(() => effect ? [effect.zone, effect.race ?? EMPTY_ZONE, effect.shared ?? EMPTY_ZONE] : null, [effect])
  return (
    <Canvas
      camera={{ fov: 45, near: 0.05, far: 500, position: [0, 2.2, 8.5] }}
      gl={{ antialias: true }}
    >
      <color attach="background" args={[settings.background]} />
      <RendererSettings settings={settings} />
      <ParticleLayer />
      <ambientLight intensity={settings.ambientIntensity} />
      <directionalLight
        position={[Math.sin((settings.keyAzimuth * Math.PI) / 180) * 5, 5, Math.cos((settings.keyAzimuth * Math.PI) / 180) * 5]}
        intensity={settings.keyIntensity}
      />
      <directionalLight position={[-4, 2, -3]} intensity={settings.fillIntensity} />
      {settings.showGround && <gridHelper args={[24, 24, '#3a4152', '#242a36']} />}
      {/* Models face their own +X once upright (the skeleton's joint 23, "in
          front", is 1.2 out along it): the caster as authored looks at the
          target, and the target, turned half round, back at it. A half turn
          on the caster too (judged by eye, stage 1) had it facing away. */}
      {caster && <Actor model={caster} idle={casterIdle} x={-gap / 2} yaw={0} onStage={setCasterStage} />}
      {target && <Actor model={target} idle={targetIdle} x={gap / 2} yaw={Math.PI} onStage={setTargetStage} />}
      {effect && (
        <>
          <EffectParticles key={effect.path} effect={effect.zone} />
          {effect.race && <EffectParticles effect={effect.race} />}
          {effect.shared && <EffectParticles effect={effect.shared} />}
          <EffectRunner sources={sources!} castRoutine={effect.castRoutine} ownMotions={effect.motions} caster={casterStage} target={targetStage} playId={playId} volume={volume} casterMotions={casterMotions} />
        </>
      )}
      <OrbitControls makeDefault target={[0, 1, 0]} maxDistance={120} />
      <FrameStage gap={gap} height={height} />
    </Canvas>
  )
}
