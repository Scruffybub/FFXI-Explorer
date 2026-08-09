import * as THREE from 'three'
import type { ParsedDatFile } from './ffxi-dat'
import type { SkinTarget } from './skinning'

/**
 * Turns a parsed model DAT into three.js meshes ready to render and skin.
 *
 * Shared by the model viewer and by the avatar the zone viewer walks around as,
 * so a character looks identical in both. Everything FFXI-specific about
 * building these meshes — dithered alpha, unusable normals, skinning inputs —
 * lives here rather than in either component.
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
export const MODEL_DEBUG =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('modeldebug') === '1'

export interface BuiltModel {
  meshes: THREE.Mesh[]
  center: THREE.Vector3
  /** Model-space bounds, before the Y flip. */
  bounds: THREE.Box3
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

export function buildModel(dat: ParsedDatFile): BuiltModel {
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

  return { meshes, center, radius, triangles, skinTargets, bounds }
}
