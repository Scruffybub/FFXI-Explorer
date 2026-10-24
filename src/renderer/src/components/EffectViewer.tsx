import { useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import type { ParsedDatFile, ParsedZone } from '../lib/ffxi-dat'
import type { RoutineCommand, EffectRoutine } from '../lib/ffxi-dat/EffectRoutineParser'
import type { GeneratorSpawn } from '../lib/ffxi-dat/types'
import type { ModelSettings } from '../lib/settings'
import { buildModel, type BuiltModel } from '../lib/modelBuild'
import { childEvents } from '../lib/weatherEvents'
import { playSound } from '../lib/footstepSounds'
import { Animator, RendererSettings } from './ModelViewer'
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
 * Stage 1 (2026-10-24): joints from the bind pose, no casting motions, no
 * facing, ring meshes (link 0x24) and other link kinds not drawn.
 */

const EFFECT_FPS = 60
/** Caster and target stand this far apart, world units (a little under casting range). */
const SPACING = 4.5

export interface EffectBundle {
  zone: ParsedZone
  /** Install-relative path, for the readout. */
  path: string
}

/** One placed actor: its model, and where its joints are in the world. */
interface Stage {
  joint(index: number, out: THREE.Vector3): THREE.Vector3
}

/**
 * A model standing on the ground at `x`, turned to `yaw`. Reports where its
 * joint references are (bind pose; SkeletonParser jointRefs), world space.
 */
function Actor({ model, x, yaw, onStage }: {
  model: ParsedDatFile
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
    const mats = model.skeleton?.matrices ?? []
    onStage({
      joint(index, out) {
        const ref = refs[index]
        const m = ref ? mats[ref.bone] : undefined
        if (!ref || !m) return out.set(0, -lift, 0).applyMatrix4(placed)
        const [ox, oy, oz] = ref.offset
        out.set(
          ox * m[0] + oy * m[4] + oz * m[8] + m[12],
          ox * m[1] + oy * m[5] + oz * m[9] + m[13],
          ox * m[2] + oy * m[6] + oz * m[10] + m[14],
        )
        return out.applyMatrix4(placed)
      },
    })
    return () => onStage(null)
  }, [built, model, x, yaw, lift, onStage])
  if (!built) return null
  return (
    <>
      <Animator built={built} model={model} playing speed={1} motion={null} />
      <group position={[x, 0, 0]} rotation={[0, yaw, 0]}>
        <group rotation={[Math.PI, 0, 0]}>
          <group position={[0, -lift, 0]}>
            {built.meshes.map((mesh, i) => <primitive key={i} object={mesh} />)}
          </group>
        </group>
      </group>
    </>
  )
}

/** A routine running: where it is in its commands, and who it plays for. */
interface Sequence {
  routine: EffectRoutine
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
  next: number
  until: number
}

/** Census (?census=1): what the last play did. */
interface RunLog { started: string[]; skipped: string[]; sounds: number[] }

function EffectRunner({ effect, caster, target, playId, volume }: {
  effect: ParsedZone
  caster: Stage | null
  target: Stage | null
  playId: number
  volume: number
}) {
  const sequences = useRef<Sequence[]>([])
  const running = useRef<Running[]>([])
  const pending = useRef(-1)
  const log = useRef<RunLog>({ started: [], skipped: [], sounds: [] })
  useEffect(() => { pending.current = playId }, [playId])

  // Look-ups by name: the routine's own folder first, then anywhere.
  const find = useMemo(() => {
    const byName = <T extends { dir: string }>(list: T[], name: (t: T) => string) => (dir: string, want: string): T[] => {
      const all = list.filter(t => name(t) === want)
      const local = all.filter(t => t.dir === dir)
      return local.length ? local : all
    }
    return {
      routine: byName(effect.routines ?? [], r => r.name),
      spawn: byName(effect.spawns ?? [], s => s.generator),
      ambient: byName(effect.ambient ?? [], s => s.generator),
      sound: byName(effect.sounds ?? [], s => s.name),
    }
  }, [effect])

  useFrame(({ clock }) => {
    const now = clock.getElapsedTime() * EFFECT_FPS
    if (pending.current >= 0 && caster && target) {
      pending.current = -1
      running.current = []
      log.current = { started: [], skipped: [], sounds: [] }
      const main = find.routine('', 'main')[0] ?? effect.routines?.[0]
      sequences.current = main ? [{ routine: main, index: 0, cursor: now, caster, target }] : []
    }
    const tmp = new THREE.Vector3()
    const run = (seq: Sequence, cmd: RoutineCommand, at: number) => {
      if (cmd.kind === 'generator') {
        const spawns = find.spawn(seq.routine.dir, cmd.ref)
        for (const sp of spawns) {
          const onCaster = sp.attach === 1 || sp.attach === 5 || sp.attach === 9
          const actor = onCaster ? seq.caster : seq.target
          const where = actor.joint(onCaster ? sp.joints[0] : sp.joints[1], tmp).clone()
          running.current.push({ spawn: sp, at: where, next: at, until: at + Math.max(cmd.duration, 0) })
          log.current.started.push(cmd.ref)
        }
        for (const s of find.ambient(seq.routine.dir, cmd.ref)) {
          playSound(s.id, volume)
          log.current.sounds.push(s.id)
        }
        if (!spawns.length && !find.ambient(seq.routine.dir, cmd.ref).length) log.current.skipped.push('gen ' + cmd.ref)
      } else if (cmd.kind === 'routine') {
        const next = find.routine(seq.routine.dir, cmd.ref)[0]
        if (!next) { log.current.skipped.push('routine ' + cmd.ref); return }
        const [c, t] = cmd.onTarget ? [seq.target, seq.caster] : [seq.caster, seq.target]
        sequences.current.push({ routine: next, index: 0, cursor: at, caster: c, target: t })
      } else if (cmd.kind === 'sound') {
        const s = find.sound(seq.routine.dir, cmd.ref)[0]
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
        childEvents.push({ name: r.spawn.generator, dir: r.spawn.dir, frame: r.next, at: r.at })
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

export function EffectViewer({ caster, target, effect, playId, settings, volume }: {
  caster: ParsedDatFile | null
  target: ParsedDatFile | null
  effect: EffectBundle | null
  /** Bumped to play the effect (again). */
  playId: number
  settings: ModelSettings
  volume: number
}) {
  const [casterStage, setCasterStage] = useState<Stage | null>(null)
  const [targetStage, setTargetStage] = useState<Stage | null>(null)
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
      {/* Both turned half round to face each other: player and monster
          models face opposite ways as authored (checked by eye, 2026-10-24). */}
      {caster && <Actor model={caster} x={-SPACING / 2} yaw={Math.PI} onStage={setCasterStage} />}
      {target && <Actor model={target} x={SPACING / 2} yaw={Math.PI} onStage={setTargetStage} />}
      {effect && (
        <>
          <EffectParticles key={effect.path} effect={effect.zone} />
          <EffectRunner effect={effect.zone} caster={casterStage} target={targetStage} playId={playId} volume={volume} />
        </>
      )}
      <OrbitControls makeDefault target={[0, 1, 0]} maxDistance={60} />
    </Canvas>
  )
}
