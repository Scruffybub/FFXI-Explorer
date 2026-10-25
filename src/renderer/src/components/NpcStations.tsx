import { useEffect, useMemo, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { buildModel, type BuiltModel } from '../lib/modelBuild'
import { invertRigidMatrix4, poseSkeleton, skinMeshes, type SkinTarget } from '../lib/skinning'
import { clearNpcModels, loadNpcModel, npcStations, type NpcModel } from '../lib/npcStations'

const CENSUS = new URLSearchParams(window.location.search).get('census') === '1'

/**
 * Scene -> NPCs: the zone's NPCs standing at their posts (lib/npcStations),
 * each playing its idle.
 *
 * One look is built once and shared: every Hume merchant in Bastok Markets in
 * the same clothes draws with the same materials and textures, and only the
 * vertex positions (which the CPU skinning rewrites) are copied per NPC. Only
 * NPCs in view and within ANIMATE_RANGE of the camera move; the rest hold the
 * first frame of their idle, and beyond DRAW_RANGE they are not drawn, so a
 * town of 150 costs little more than the 20 nearest.
 *
 * Positions are the zone's own coordinates (Y down), so the NPCs sit in a
 * group turned upright like the zone's, and the models, Y down too, need no
 * flip of their own.
 */

/** NPCs closer than this to the camera play their idle, world units. */
const ANIMATE_RANGE = Number(new URLSearchParams(window.location.search).get('npcanim') ?? 60)
/**
 * NPCs further than this are not drawn: a town's 150 at ten pieces each
 * halved the frame rate from the overview, where they are specks
 * (Southern San d'Oria 177 -> 79 fps, 2026-10-25). The game draws them
 * nearer than this.
 */
const DRAW_RANGE = 100

interface Template {
  built: BuiltModel
  model: NpcModel
  /** Each mesh's skinning data, or null for a mesh without bones. */
  skins: (SkinTarget | null)[]
  inverseBind: number[][] | null
}

interface Placed {
  template: Template
  group: THREE.Group
  geometries: THREE.BufferGeometry[]
  skins: SkinTarget[]
  /** World position and reach, for the view and distance tests. */
  sphere: THREE.Sphere
  /** Seconds into its idle, started at random so a crowd does not sway in step. */
  t: number
  posed: boolean
}

function makeTemplate(model: NpcModel): Template {
  const built = buildModel(model.model)
  const skins = built.meshes.map(mesh => {
    const positions = mesh.geometry.getAttribute('position').array
    return built.skinTargets.find(s => s.positions === positions) ?? null
  })
  return { built, model, skins, inverseBind: model.model.skeleton?.matrices.map(invertRigidMatrix4) ?? null }
}

function place(template: Template, x: number, y: number, z: number, facing: number): Placed {
  const group = new THREE.Group()
  group.position.set(x, y, z)
  // facing 0-255 is a full turn clockwise from east (+X; north is +Z, so 64
  // faces south). The models face their own +X.
  group.rotation.y = (facing / 256) * Math.PI * 2
  const geometries: THREE.BufferGeometry[] = []
  const skins: SkinTarget[] = []
  template.built.meshes.forEach((mesh, i) => {
    const skin = template.skins[i]
    const geometry = skin ? mesh.geometry.clone() : mesh.geometry
    if (skin) {
      geometries.push(geometry)
      skins.push({ ...skin, positions: geometry.getAttribute('position').array as Float32Array })
    }
    const copy = new THREE.Mesh(geometry, mesh.material)
    copy.frustumCulled = false
    group.add(copy)
  })
  // The zone's group turns Y and Z over; the sphere is tested in the world.
  const sphere = new THREE.Sphere(new THREE.Vector3(x, -y, -z), Math.max(template.built.radius * 1.5, 1))
  return { template, group, geometries, skins, sphere, t: Math.random() * 10, posed: false }
}

export function NpcStations({ root, zoneId }: { root: string; zoneId: number }) {
  const holder = useMemo(() => {
    const g = new THREE.Group()
    g.rotation.x = Math.PI
    return g
  }, [])
  const [placed, setPlaced] = useState<Placed[]>([])
  const camera = useThree(st => st.camera)

  useEffect(() => {
    let cancelled = false
    const stations = npcStations(zoneId)
    const templates = new Map<NpcModel, Template>()
    const all: Placed[] = []
    const failed: unknown[] = []
    void Promise.all(stations.map(async ([index, x, y, z, facing, look]) => {
      const model = await loadNpcModel(root, look)
      if (cancelled) return
      if (!model) { failed.push([index, look]); return }
      let template = templates.get(model)
      if (!template) { template = makeTemplate(model); templates.set(model, template) }
      const npc = place(template, x, y, z, facing)
      holder.add(npc.group)
      all.push(npc)
    })).then(() => {
      if (cancelled) return
      setPlaced(all)
      if (CENSUS) {
        ;(window as unknown as Record<string, unknown>).__npcs = () => ({
          zone: zoneId, stations: stations.length, placed: all.length, failed: failed.length, failedLooks: failed, looks: templates.size,
          shown: all.filter(n => n.group.visible).length,
        })
        // ?census=1&campos=..: the camera `dist` units in front of NPC i, looking at it.
        ;(window as unknown as Record<string, unknown>).__npcView = (i: number, dist = 4, height = 1.6) => {
          const n = all[i]
          if (!n) return null
          const yaw = n.group.rotation.y
          const c = n.sphere.center
          // In the world the model's +X turns by -yaw (the zone group flips Y and Z).
          camera.position.set(c.x + Math.cos(yaw) * dist, c.y + height, c.z + Math.sin(yaw) * dist)
          camera.lookAt(c.x, c.y + height * 0.7, c.z)
          return { i, at: c.toArray().map(v => +v.toFixed(1)), facing: +yaw.toFixed(2) }
        }
      }
    })
    return () => {
      cancelled = true
      for (const npc of all) {
        holder.remove(npc.group)
        for (const g of npc.geometries) g.dispose()
      }
      for (const t of templates.values()) {
        for (const mesh of t.built.meshes) {
          mesh.geometry.dispose()
          const mat = mesh.material as THREE.MeshStandardMaterial
          mat.map?.dispose()
          mat.dispose()
        }
      }
      setPlaced([])
      clearNpcModels()
    }
  }, [root, zoneId, holder, camera])

  const frustum = useMemo(() => new THREE.Frustum(), [])
  const viewProjection = useMemo(() => new THREE.Matrix4(), [])
  useFrame(({ camera }, delta) => {
    if (!placed.length) return
    viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    frustum.setFromProjectionMatrix(viewProjection)
    for (const npc of placed) {
      const distance = npc.sphere.center.distanceTo(camera.position)
      const inView = distance < DRAW_RANGE && frustum.intersectsSphere(npc.sphere)
      npc.group.visible = inView
      if (!inView) continue
      const { model, inverseBind } = npc.template
      const skeleton = model.model.skeleton
      if (!skeleton || !inverseBind || !npc.skins.length) continue
      // Without an idle it is posed once, in its bind pose: unposed, the
      // parser's bone-local vertices would draw collapsed.
      const near = model.idle.length > 0 && distance < ANIMATE_RANGE
      if (!near && npc.posed) continue
      if (near) npc.t += delta
      skinMeshes(npc.skins, poseSkeleton(skeleton, model.idle, inverseBind, npc.t))
      for (const g of npc.geometries) g.getAttribute('position').needsUpdate = true
      npc.posed = true
    }
  })

  return <primitive object={holder} />
}
