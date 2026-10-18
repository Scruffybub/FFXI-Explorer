import { useState, useEffect, useMemo, useRef } from 'react'
import { Canvas, useThree, useFrame } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import type { ParsedDatFile } from '../lib/ffxi-dat'
import { invertRigidMatrix4, poseSkeleton, skinMeshes } from '../lib/skinning'
import { clipsForMotion } from '../lib/motions'
import type { ModelSettings, ToneMappingMode } from '../lib/settings'
import { buildModel, MODEL_DEBUG, type BuiltModel } from '../lib/modelBuild'

/**
 * Renders a single parsed model DAT.
 *
 * Deliberately simple next to ZoneViewer: one model, orbit controls, neutral
 * studio lighting. None of the zone renderer's machinery applies here — there
 * is no MZB instance list, no water, no sky, and the scale is metres rather
 * than the thousands of units a zone spans.
 *
 * Meshes arrive in bind pose: `parseVertexBlock` transforms vertices into world
 * space using the skeleton's bind-pose matrices. When the DAT carries animation
 * blocks, `Animator` re-skins those vertices on the CPU every frame — see
 * `lib/skinning.ts` for why that happens on the CPU rather than in a shader.
 */

/**
 * Advances the animation and rewrites skinned vertex positions each frame.
 *
 * Inverse bind matrices are computed once per model — they depend only on the
 * skeleton, and inverting 69 matrices every frame is pure waste.
 */
function Animator({
  built, model, playing, speed, motion, onFrame, onPosed,
}: {
  built: BuiltModel
  model: ParsedDatFile
  playing: boolean
  speed: number
  /** Which motion to play (lib/motions.ts), or null for the model's first — idle when it has one. */
  motion: string | null
  onFrame?: (frame: number, total: number) => void
  /** The posed model's bounds, once per motion, for framing. */
  onPosed?: (box: THREE.Box3) => void
}) {
  const time = useRef(0)
  const measured = useRef<unknown>(null)
  const inverseBind = useMemo(
    () => model.skeleton?.matrices.map(invertRigidMatrix4) ?? null,
    [model.skeleton],
  )

  // A motion's clips compose by bone — upper body, lower body — so they play
  // together. The other motions in the file are left out.
  const clips = useMemo(() => clipsForMotion(model.animations, motion), [model.animations, motion])

  useFrame((_, delta) => {
    const skeleton = model.skeleton
    if (!skeleton || !inverseBind || clips.length === 0) return
    if (built.skinTargets.length === 0) return

    if (playing) time.current += delta * speed

    const pose = poseSkeleton(skeleton, clips, inverseBind, time.current)
    skinMeshes(built.skinTargets, pose)

    for (const mesh of built.meshes) {
      const attr = mesh.geometry.getAttribute('position')
      attr.needsUpdate = true
    }

    // Frame the pose, not the rest pose: a motion can carry the whole body
    // well away from where it rests (Aern 1 hovers, its head cut off by a
    // camera framed on the rest pose). Measured once per motion.
    // Points parked far away are left out: the game hides parts by moving
    // their bones off into the distance (Elvaan M 12's idle puts 45 vertices
    // 80,000 units out), and framing them shrank the model to nothing.
    if (onPosed && measured.current !== clips) {
      measured.current = clips
      const box = new THREE.Box3()
      const p = new THREE.Vector3()
      const limit = built.radius * 10
      for (const mesh of built.meshes) {
        const pos = mesh.geometry.getAttribute('position')
        for (let i = 0; i < pos.count; i++) {
          p.fromBufferAttribute(pos, i)
          if (p.distanceTo(built.center) <= limit) box.expandByPoint(p)
        }
      }
      if (!box.isEmpty()) onPosed(box)
    }

    const clip = clips[0]
    if (onFrame && clip.frameCount > 1) {
      const total = clip.frameCount - 1
      onFrame(((time.current * clip.speed * 30) % total + total) % total, total)
    }
  })

  return null
}

/**
 * Pulls the camera back to suit the model's size. FFXI models run from a rat to
 * a dragon, so a fixed distance is useless across that range.
 */
function FrameCamera({ radius }: { radius: number }) {
  const { camera, scene, gl } = useThree()
  useEffect(() => {
    if (!MODEL_DEBUG) return
    const w = window as unknown as {
      __modelScene?: THREE.Scene
      __modelCam?: THREE.Camera
      __modelGl?: THREE.WebGLRenderer
    }
    w.__modelScene = scene
    w.__modelCam = camera
    w.__modelGl = gl
  }, [scene, camera, gl])
  useEffect(() => {
    const dist = radius * 3.2
    camera.position.set(0, 0, dist)
    camera.near = Math.max(radius / 100, 0.001)
    camera.far = Math.max(1000, dist * 20)
    camera.lookAt(0, 0, 0)
    camera.updateProjectionMatrix()
  }, [camera, radius])
  return null
}

const TONE_MAPPING: Record<ToneMappingMode, THREE.ToneMapping> = {
  none: THREE.NoToneMapping,
  linear: THREE.LinearToneMapping,
  reinhard: THREE.ReinhardToneMapping,
  cineon: THREE.CineonToneMapping,
  aces: THREE.ACESFilmicToneMapping,
  agx: THREE.AgXToneMapping,
  neutral: THREE.NeutralToneMapping,
}

/** Applies renderer-level settings that are not React props on the Canvas. */
function RendererSettings({ settings }: { settings: ModelSettings }) {
  const { gl, invalidate } = useThree()
  useEffect(() => {
    gl.toneMapping = TONE_MAPPING[settings.toneMapping]
    gl.toneMappingExposure = settings.exposure
    invalidate()
  }, [gl, invalidate, settings.toneMapping, settings.exposure])
  return null
}

export interface ModelStats {
  meshes: number
  triangles: number
  textures: number
  hasSkeleton: boolean
  bones: number
  animations: number
}

export function ModelViewer({
  model, settings, onStats, playing = true, speed = 1, motion = null, onFrame,
}: {
  model: ParsedDatFile | null
  settings: ModelSettings
  onStats?: (stats: ModelStats | null) => void
  playing?: boolean
  speed?: number
  motion?: string | null
  onFrame?: (frame: number, total: number) => void
}) {
  // Build and dispose in the *same* effect, so the two are always paired.
  //
  // The obvious version — useMemo to build, useEffect to dispose — is broken
  // under StrictMode, and silently: React mounts, runs the cleanup on its
  // simulated unmount (disposing every geometry and material), then remounts
  // and renders the now-disposed resources. Nothing draws, no error, no warning.
  // Building inside the effect means the second mount builds fresh resources.
  const [built, setBuilt] = useState<BuiltModel | null>(null)

  useEffect(() => {
    if (!model) {
      setBuilt(null)
      return
    }
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

  useEffect(() => {
    if (!model || !built) {
      onStats?.(null)
      return
    }
    onStats?.({
      meshes: built.meshes.length,
      triangles: Math.round(built.triangles),
      textures: model.textures.length,
      hasSkeleton: !!model.skeleton,
      bones: model.skeleton?.bones.length ?? 0,
      animations: model.animations.length,
    })
  }, [model, built, onStats])

  // Material tweaks apply in place rather than rebuilding the model — a rebuild
  // would reallocate every geometry and restart the animation.
  useEffect(() => {
    if (!built) return
    for (const mesh of built.meshes) {
      const mat = mesh.material as THREE.MeshStandardMaterial
      mat.wireframe = settings.wireframe
      mat.roughness = settings.roughness
      mat.needsUpdate = true
    }
  }, [built, settings.wireframe, settings.roughness])

  // The posed bounds when the motion has been measured, else the rest pose.
  const [posed, setPosed] = useState<{ center: THREE.Vector3; radius: number } | null>(null)
  useEffect(() => { setPosed(null) }, [built, motion])
  const onPosed = useMemo(() => (box: THREE.Box3) => {
    const sphere = box.getBoundingSphere(new THREE.Sphere())
    setPosed({ center: sphere.center, radius: Math.max(sphere.radius, 0.01) })
  }, [])
  const center = posed?.center ?? built?.center
  const radius = posed?.radius ?? built?.radius ?? 1

  // Frame the model regardless of its size: FFXI models range from a rat to a
  // dragon, and a fixed camera distance is useless across that span.
  const dist = built ? radius * 3.2 : 5

  return (
    <Canvas
      camera={{ fov: 45, near: 0.01, far: Math.max(1000, dist * 10), position: [0, 0, dist] }}
      gl={{ antialias: true }}
      onCreated={({ gl }) => {
        gl.toneMapping = TONE_MAPPING[settings.toneMapping]
        gl.toneMappingExposure = settings.exposure
      }}
    >
      <color attach="background" args={[settings.background]} />
      <RendererSettings settings={settings} />

      {/* Three-point studio rig — enough to read shape without flattening the
          texture, which already carries most of FFXI's shading. */}
      <ambientLight intensity={settings.ambientIntensity} />
      <directionalLight
        position={[
          Math.sin((settings.keyAzimuth * Math.PI) / 180) * 5,
          5,
          Math.cos((settings.keyAzimuth * Math.PI) / 180) * 5,
        ]}
        intensity={settings.keyIntensity}
      />
      <directionalLight position={[-4, 2, -3]} intensity={settings.fillIntensity} />

      {built && settings.showGround && (
        <gridHelper
          args={[radius * 8, 20, '#3a4152', '#242a36']}
          position={[0, -radius, 0]}
        />
      )}

      {/* The model is built in an effect, so it does not exist when the Canvas
          creates its camera. This reframes once it arrives. */}
      {built && <FrameCamera radius={radius} />}

      {built && model && (
        <Animator
          built={built}
          model={model}
          playing={playing}
          speed={speed}
          motion={motion}
          onFrame={onFrame}
          onPosed={onPosed}
        />
      )}

      {/* Two groups: centre the model in its own space, then flip Y. Doing it
          the other way round swings the recentred model back off-origin. */}
      {built && (
        <group rotation={[Math.PI, 0, 0]}>
          <group position={[-center!.x, -center!.y, -center!.z]}>
            {built.meshes.map((mesh, i) => (
              <primitive key={i} object={mesh} />
            ))}
          </group>
        </group>
      )}

      <OrbitControls
        makeDefault
        target={[0, 0, 0]}
        minDistance={built ? radius * 0.3 : 0.5}
        maxDistance={dist * 6}
      />
    </Canvas>
  )
}
