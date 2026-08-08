import { useState, useEffect } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import type { ParsedDatFile } from '../lib/ffxi-dat'

/**
 * Renders a single parsed model DAT.
 *
 * Deliberately simple next to ZoneViewer: one model, orbit controls, neutral
 * studio lighting. None of the zone renderer's machinery applies here — there
 * is no MZB instance list, no water, no sky, and the scale is metres rather
 * than the thousands of units a zone spans.
 *
 * Meshes arrive already posed. `parseVertexBlock` transforms vertices into
 * world space using the skeleton's bind-pose matrices, so there is no skinning
 * to do at draw time — and no animation either until `AnimationParser` is
 * ported.
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
}

function buildModel(dat: ParsedDatFile): BuiltModel {
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
      // Character and monster art leans on cutout alpha far more than terrain
      // does, and unlike the zone case these meshes have no blending flag to
      // gate on — alpha testing everything is right here.
      alphaTest: 0.5,
      side: THREE.DoubleSide,
      roughness: 0.85,
      metalness: 0,
    })

    meshes.push(new THREE.Mesh(geo, mat))
  }

  const center = new THREE.Vector3()
  let radius = 1
  if (!bounds.isEmpty()) {
    bounds.getCenter(center)
    radius = Math.max(bounds.getSize(new THREE.Vector3()).length() / 2, 0.001)
  }

  // Bake centring and the Y flip into the geometry rather than wrapping the
  // meshes in transformed groups, so each mesh is a plain scene child sitting
  // at the origin. Fewer moving parts, and the bounding spheres used for
  // frustum culling then describe where the geometry actually is.
  const toOrigin = new THREE.Matrix4()
    .makeRotationX(Math.PI)
    .multiply(new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z))
  for (const mesh of meshes) {
    mesh.geometry.applyMatrix4(toOrigin)
    mesh.geometry.computeBoundingBox()
    mesh.geometry.computeBoundingSphere()
  }

  if (MODEL_DEBUG) {
    const size = bounds.isEmpty() ? new THREE.Vector3() : bounds.getSize(new THREE.Vector3())
    console.log(
      `[Model] ${meshes.length} meshes, ${Math.round(triangles)} tris, ` +
      `radius=${radius.toFixed(3)} ` +
      `size=(${size.x.toFixed(2)}, ${size.y.toFixed(2)}, ${size.z.toFixed(2)}) ` +
      `badNormals=${badNormals} ` +
      `textures=${dat.textures.map(t => `${t.width}x${t.height}`).join(',')}`,
    )
  }

  return { meshes, center, radius, triangles }
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
}

export function ModelViewer({
  model, background, onStats,
}: {
  model: ParsedDatFile | null
  background: string
  onStats?: (stats: ModelStats | null) => void
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

      {built?.meshes.map((mesh, i) => (
        <primitive key={i} object={mesh} />
      ))}

      <OrbitControls
        makeDefault
        target={[0, 0, 0]}
        minDistance={built ? built.radius * 0.3 : 0.5}
        maxDistance={dist * 6}
      />
    </Canvas>
  )
}
