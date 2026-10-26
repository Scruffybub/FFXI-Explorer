import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import type { ParsedDatFile } from './ffxi-dat'
import { buildModel } from './modelBuild'
import { motionsOf } from './motions'
import { invertRigidMatrix4, localPose, poseSkeleton, skinMeshes } from './skinning'

/**
 * Models -> Export glTF: the model on screen as one .glb, rigged and with its
 * motions, ready for Blender or any glTF tool. Textures are embedded.
 *
 * - **Bones** are the skeleton's own, each at its bind-pose place relative to
 *   its parent (skinning localPose, the same transforms the viewer poses).
 * - **Vertices** are written in the bind pose and tied to up to two bones.
 *   FFXI blends a two-bone vertex from a separate position in each bone's
 *   space; glTF has one position and weights, so the bind-pose position with
 *   the same weights stands in. It matches at rest and bends very nearly the
 *   same (other FFXI exporters make the same trade).
 * - **Motions** become one animation each (Idle, Walk, Attack 1 ..), named as
 *   the Motion list names them, sampled at the game's 30 frames a second
 *   times the clip's speed. Scale keys are not written: the viewer does not
 *   play them either.
 * - **Axes**: FFXI's Y points down; a root node turns the model upright.
 *   Models face +X, as in the game.
 */
export async function exportGlb(model: ParsedDatFile, name: string): Promise<ArrayBuffer> {
  const built = buildModel(model)
  const skeleton = model.skeleton
  const root = new THREE.Group()
  root.name = name
  root.rotation.x = Math.PI

  try {
    let bones: THREE.Bone[] = []
    if (skeleton && built.skinTargets.length) {
      const inverseBind = skeleton.matrices.map(invertRigidMatrix4)
      // The parser's two-bone vertices are bone-local until posed.
      skinMeshes(built.skinTargets, poseSkeleton(skeleton, [], inverseBind, 0))

      const rest = localPose(skeleton, [], 0)
      bones = skeleton.bones.map((_, i) => {
        const bone = new THREE.Bone()
        bone.name = `bone_${i}`
        new THREE.Matrix4().fromArray(rest[i]).decompose(bone.position, bone.quaternion, bone.scale)
        return bone
      })
      skeleton.bones.forEach((b, i) => {
        const parent = b.parentIndex >= 0 && b.parentIndex < i ? bones[b.parentIndex] : root
        parent.add(bones[i])
      })
    }

    const meshes: THREE.Mesh[] = []
    for (const mesh of built.meshes) {
      const geometry = mesh.geometry.clone()
      const target = built.skinTargets.find(t => t.positions === mesh.geometry.getAttribute('position').array)
      let out: THREE.Mesh
      if (target && bones.length) {
        const count = geometry.getAttribute('position').count
        const index = new Uint16Array(count * 4)
        const weight = new Float32Array(count * 4)
        for (let v = 0; v < count; v++) {
          const b1 = Math.min(target.boneIndices[v * 4], bones.length - 1)
          const b2 = Math.min(target.boneIndices[v * 4 + 1], bones.length - 1)
          let w1 = 1, w2 = 0
          if (target.dualBone) {
            w1 = target.dualBone.weights[v * 2]
            w2 = target.dualBone.weights[v * 2 + 1]
            const sum = w1 + w2
            if (sum > 0) { w1 /= sum; w2 /= sum } else { w1 = 1; w2 = 0 }
          }
          index[v * 4] = b1
          index[v * 4 + 1] = w2 > 0 ? b2 : 0
          weight[v * 4] = w1
          weight[v * 4 + 1] = w2
        }
        geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(index, 4))
        geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weight, 4))
        out = new THREE.SkinnedMesh(geometry, mesh.material)
      } else {
        out = new THREE.Mesh(geometry, mesh.material)
      }
      out.name = `${name}_${meshes.length}`
      root.add(out)
      meshes.push(out)
    }

    root.updateMatrixWorld(true)
    if (bones.length) {
      const rig = new THREE.Skeleton(bones)
      for (const m of meshes) if (m instanceof THREE.SkinnedMesh) m.bind(rig, m.matrixWorld)
    }

    const animations = skeleton && bones.length ? motionClips(model, bones.length) : []
    const exporter = new GLTFExporter()
    const glb = await exporter.parseAsync(root, { binary: true, animations, onlyVisible: false })
    for (const m of meshes) m.geometry.dispose()
    return glb as ArrayBuffer
  } finally {
    for (const mesh of built.meshes) {
      mesh.geometry.dispose()
      const mat = mesh.material as THREE.MeshStandardMaterial
      mat.map?.dispose()
      mat.dispose()
    }
  }
}

/** One AnimationClip per motion, every driven bone's position and rotation per frame. */
function motionClips(model: ParsedDatFile, boneCount: number): THREE.AnimationClip[] {
  const skeleton = model.skeleton!
  const clips: THREE.AnimationClip[] = []
  const used = new Map<string, number>()
  for (const motion of motionsOf(model.animations)) {
    const parts = motion.clips.filter(c => c.frameCount > 1)
    if (!parts.length) continue
    // The longest part sets the length; frames step at 30 a second times its speed.
    const longest = parts.reduce((a, c) => ((c.frameCount - 1) / (c.speed || 1) > (a.frameCount - 1) / (a.speed || 1) ? c : a))
    const speed = longest.speed || 1
    const frames = longest.frameCount - 1
    const duration = frames / (30 * speed)
    const driven = new Set<number>()
    for (const c of parts) for (const b of c.bones) if (b.boneIndex >= 0 && b.boneIndex < boneCount) driven.add(b.boneIndex)

    const times = new Float32Array(frames + 1)
    const pos = new Map<number, Float32Array>(), rot = new Map<number, Float32Array>()
    for (const i of driven) { pos.set(i, new Float32Array((frames + 1) * 3)); rot.set(i, new Float32Array((frames + 1) * 4)) }
    const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3()
    for (let f = 0; f <= frames; f++) {
      // The last frame is the loop's end: sample just before it wraps to the start.
      const t = f === frames ? duration - 1e-4 : f / (30 * speed)
      times[f] = f / (30 * speed)
      const local = localPose(skeleton, parts, t)
      for (const i of driven) {
        m.fromArray(local[i]).decompose(p, q, s)
        const r = rot.get(i)!
        // Keep each rotation on the same side as the last, or players spin the long way round.
        if (f > 0 && r[(f - 1) * 4] * q.x + r[(f - 1) * 4 + 1] * q.y + r[(f - 1) * 4 + 2] * q.z + r[(f - 1) * 4 + 3] * q.w < 0) {
          q.set(-q.x, -q.y, -q.z, -q.w)
        }
        p.toArray(pos.get(i)!, f * 3)
        q.toArray(r, f * 4)
      }
    }
    const tracks: THREE.KeyframeTrack[] = []
    for (const i of driven) {
      tracks.push(new THREE.VectorKeyframeTrack(`bone_${i}.position`, times, pos.get(i)!))
      tracks.push(new THREE.QuaternionKeyframeTrack(`bone_${i}.quaternion`, times, rot.get(i)!))
    }
    // Unnamed motions keep the game's code; two can still share a name, so keep them apart.
    const label = motion.label === 'Motion' ? motion.key : motion.label
    const n = (used.get(label) ?? 0) + 1
    used.set(label, n)
    clips.push(new THREE.AnimationClip(n > 1 ? `${label} ${n}` : label, duration, tracks))
  }
  return clips
}
