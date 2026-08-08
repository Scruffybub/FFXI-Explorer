import { useState, useEffect, useMemo, useRef } from 'react'
import { Canvas, useThree, useFrame } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import type { ParsedDatFile } from '../lib/ffxi-dat'
import { invertRigidMatrix4, poseSkeleton, skinMeshes, type SkinTarget } from '../lib/skinning'

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
 * `?modeldebug=1` logs what was built and exposes the scene, camera and
 * renderer on `window` so harnesses can inspect them.
 *
 * That hook is what found the bug this viewer was born with: the meshes were in
 * the scene, the camera was aimed at them, and `renderer.info` reported 2,358
 * triangles drawn — but every index was 0, so every triangle was degenerate and
 * covered no pixels. Nothing in three.js complains about that.
 */
const MODEL_DEBUG =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('modeldebug') === '1'

interface BuiltModel {
  meshes: THREE.Mesh[]
  center: THREE.Vector3
  radius: number
  triangles: number
  /** Per-mesh data for per-frame CPU skinning. Empty when the model has no bones. */
  skinTargets: SkinTarget[]
}

/**
 * True when a texture's alpha is a high-frequency dither rather than a cutout
 * mask.
 *
 * FFXI inherits the PS2's trick of faking translucency with a stipple pattern:
 * Gigas skin is a literal checkerboard, 50.0% of texels below the alpha
 * threshold with 100% alternation between horizontal neighbours. Alpha-testing
 * that punches out every other texel and the model renders as mesh netting.
 *
 * Alternation is the signal that alpha *coverage* alone could never provide —
 * the same distinction defeated five attempts on the zone side, where genuine
 * cutout terrain and real foliage both sit around 50% transparent. A cutout has
 * contiguous transparent regions and so alternates rarely; a dither alternates
 * almost every texel.
 */
function isDitheredAlpha(t: { width: number; height: number; rgba: Uint8Array }): boolean {
  let below = 0
  let alternations = 0
  let comparisons = 0
  for (let y = 0; y < t.height; y++) {
    for (let x = 0; x < t.width; x++) {
      const a = t.rgba[(y * t.width + x) * 4 + 3] < 128
      if (a) below++
      if (x + 1 < t.width) {
        if (a !== (t.rgba[(y * t.width + x + 1) * 4 + 3] < 128)) alternations++
        comparisons++
      }
    }
  }
  if (comparisons === 0) return false
  const share = below / (t.width * t.height)
  // Needs real transparency to matter, and needs to be flipping constantly.
  return share > 0.15 && alternations / comparisons > 0.6
}

function buildModel(dat: ParsedDatFile): BuiltModel {
  const dithered = dat.textures.map(isDitheredAlpha)
  const textures = dat.textures.map(t => {
    const tex = new THREE.DataTexture(t.rgba, t.width, t.height, THREE.RGBAFormat)
    tex.needsUpdate = true
    tex.colorSpace = THREE.SRGBColorSpace
    tex.wrapS = THREE.RepeatWrapping
    tex.wrapT = THREE.RepeatWrapping
    tex.flipY = false
    return tex
  })

  const meshes: THREE.Mesh[] = []
  const skinTargets: SkinTarget[] = []
  const bounds = new THREE.Box3()
  let triangles = 0
  let badNormals = 0

  for (const m of dat.meshes) {
    if (!m.vertices.length || !m.indices.length) continue

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(m.vertices, 3))
    if (m.uvs?.length) {
      geo.setAttribute('uv', new THREE.BufferAttribute(m.uvs, 2))
    }
    geo.setIndex(new THREE.BufferAttribute(m.indices, 1))

    // Only trust the DAT's normals if they are all usable. The zone renderer
    // hit the same thing: some FFXI meshes carry zero-length normals, and
    // normalising a zero vector gives NaN — which under a lit material renders
    // the mesh black or not at all. Invisible on a dark background either way.
    let usable = m.normals?.length === m.vertices.length
    if (usable && m.normals) {
      for (let i = 0; i < m.normals.length; i += 3) {
        const x = m.normals[i], y = m.normals[i + 1], z = m.normals[i + 2]
        const len2 = x * x + y * y + z * z
        if (!Number.isFinite(len2) || len2 < 1e-12) { usable = false; badNormals++; break }
      }
    }
    if (usable && m.normals) {
      geo.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3))
    } else {
      geo.computeVertexNormals()
    }
    geo.computeBoundingBox()
    if (geo.boundingBox) bounds.union(geo.boundingBox)
    triangles += m.indices.length / 3

    const texture = textures[m.materialIndex]
    const mat = new THREE.MeshStandardMaterial({
      map: texture ?? null,
      // Cutouts get alpha tested; dithered alpha is treated as solid, since the
      // stipple encodes translucency rather than holes. Testing it would shred
      // the surface into netting.
      alphaTest: dithered[m.materialIndex] ? 0 : 0.5,
      side: THREE.DoubleSide,
      roughness: 0.85,
      metalness: 0,
    })

    meshes.push(new THREE.Mesh(geo, mat))

    // Only meshes with bone assignments can be skinned. The parser hands back
    // bone-local positions for dual-bone vertices, which is what makes joints
    // bend correctly rather than collapsing.
    if (m.boneIndices.length >= (m.vertices.length / 3) * 4) {
      skinTargets.push({
        positions: geo.getAttribute('position').array as Float32Array,
        origPositions: m.vertices.slice(),
        boneIndices: m.boneIndices,
        dualBone: (m.dualBoneLocalPos1 && m.dualBoneLocalPos2 && m.dualBoneWeights)
          ? {
              localPos1: m.dualBoneLocalPos1,
              localPos2: m.dualBoneLocalPos2,
              weights: m.dualBoneWeights,
            }
          : undefined,
      })
    }
  }

  const center = new THREE.Vector3()
  let radius = 1
  if (!bounds.isEmpty()) {
    bounds.getCenter(center)
    radius = Math.max(bounds.getSize(new THREE.Vector3()).length() / 2, 0.001)
  }

  // Centring and the Y flip live on the wrapping groups, not baked into the
  // geometry: skinning rewrites vertex positions every frame from the parser's
  // own bind-pose and bone-local data, which would overwrite anything baked in.
  //
  // Frustum culling has to be switched off for skinned meshes. The bounding
  // sphere describes the bind pose, and a raised arm or a lunge can put geometry
  // outside it — which makes limbs blink out at the screen edge.
  for (const mesh of meshes) {
    mesh.frustumCulled = false
  }

  if (MODEL_DEBUG) {
    dat.textures.forEach((t, i) => {
      let below = 0, alternations = 0, comparisons = 0
      for (let y = 0; y < t.height; y++) {
        for (let x = 0; x < t.width; x++) {
          const a = t.rgba[(y * t.width + x) * 4 + 3]
          if (a < 128) below++
          if (x + 1 < t.width) {
            const b = t.rgba[(y * t.width + x + 1) * 4 + 3]
            if ((a < 128) !== (b < 128)) alternations++
            comparisons++
          }
        }
      }
      const px = t.width * t.height
      console.log(
        `[Model] tex${i} ${t.width}x${t.height} below128=${((below / px) * 100).toFixed(1)}% ` +
        `alternation=${((alternations / comparisons) * 100).toFixed(1)}%`,
      )
    })
    const size = bounds.isEmpty() ? new THREE.Vector3() : bounds.getSize(new THREE.Vector3())
    console.log(
      `[Model] ${meshes.length} meshes, ${Math.round(triangles)} tris, ` +
      `radius=${radius.toFixed(3)} ` +
      `size=(${size.x.toFixed(2)}, ${size.y.toFixed(2)}, ${size.z.toFixed(2)}) ` +
      `badNormals=${badNormals} ` +
      `textures=${dat.textures.map(t => `${t.width}x${t.height}`).join(',')}`,
    )
  }

  return { meshes, center, radius, triangles, skinTargets }
}

/**
 * Advances the animation and rewrites skinned vertex positions each frame.
 *
 * Inverse bind matrices are computed once per model — they depend only on the
 * skeleton, and inverting 69 matrices every frame is pure waste.
 */
function Animator({
  built, model, playing, speed, onFrame,
}: {
  built: BuiltModel
  model: ParsedDatFile
  playing: boolean
  speed: number
  onFrame?: (frame: number, total: number) => void
}) {
  const time = useRef(0)
  const inverseBind = useMemo(
    () => model.skeleton?.matrices.map(invertRigidMatrix4) ?? null,
    [model.skeleton],
  )

  useFrame((_, delta) => {
    const skeleton = model.skeleton
    if (!skeleton || !inverseBind || model.animations.length === 0) return
    if (built.skinTargets.length === 0) return

    if (playing) time.current += delta * speed

    const pose = poseSkeleton(skeleton, model.animations, inverseBind, time.current)
    skinMeshes(built.skinTargets, pose)

    for (const mesh of built.meshes) {
      const attr = mesh.geometry.getAttribute('position')
      attr.needsUpdate = true
    }

    const clip = model.animations[0]
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

export interface ModelStats {
  meshes: number
  triangles: number
  textures: number
  hasSkeleton: boolean
  bones: number
  animations: number
}

export function ModelViewer({
  model, background, onStats, playing = true, speed = 1, onFrame,
}: {
  model: ParsedDatFile | null
  background: string
  onStats?: (stats: ModelStats | null) => void
  playing?: boolean
  speed?: number
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

  // Frame the model regardless of its size: FFXI models range from a rat to a
  // dragon, and a fixed camera distance is useless across that span.
  const dist = built ? built.radius * 3.2 : 5

  return (
    <Canvas
      camera={{ fov: 45, near: 0.01, far: Math.max(1000, dist * 10), position: [0, 0, dist] }}
      gl={{ antialias: true }}
    >
      <color attach="background" args={[background]} />

      {/* Three-point studio rig — enough to read shape without hiding texture. */}
      <ambientLight intensity={0.75} />
      <directionalLight position={[3, 5, 4]} intensity={1.5} />
      <directionalLight position={[-4, 2, -3]} intensity={0.5} />

      {/* The model is built in an effect, so it does not exist when the Canvas
          creates its camera. This reframes once it arrives. */}
      {built && <FrameCamera radius={built.radius} />}

      {built && model && (
        <Animator
          built={built}
          model={model}
          playing={playing}
          speed={speed}
          onFrame={onFrame}
        />
      )}

      {/* Two groups: centre the model in its own space, then flip Y. Doing it
          the other way round swings the recentred model back off-origin. */}
      {built && (
        <group rotation={[Math.PI, 0, 0]}>
          <group position={[-built.center.x, -built.center.y, -built.center.z]}>
            {built.meshes.map((mesh, i) => (
              <primitive key={i} object={mesh} />
            ))}
          </group>
        </group>
      )}

      <OrbitControls
        makeDefault
        target={[0, 0, 0]}
        minDistance={built ? built.radius * 0.3 : 0.5}
        maxDistance={dist * 6}
      />
    </Canvas>
  )
}
