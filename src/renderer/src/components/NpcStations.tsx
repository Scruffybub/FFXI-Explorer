import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { Html } from '@react-three/drei'
import type { CollisionWorld } from '../lib/CollisionWorld'
import type { ParsedAnimation, ParsedZone } from '../lib/ffxi-dat'
import type { GeneratorSpawn } from '../lib/ffxi-dat/types'
import { ZoneEffects } from './WeatherParticles'
import { buildModel, type BuiltModel } from '../lib/modelBuild'
import { invertRigidMatrix4, poseSkeleton, skinMeshes, type SkinTarget } from '../lib/skinning'
import { clearNpcModels, loadNpcModel, npcNames, npcStations, type NpcModel } from '../lib/npcStations'
import { mobSpawns, outAt, pointInRegion, regionHeight } from '../lib/mobSpawns'

/** Diagnostics: ?npcfx=<n> runs only the nth NPC effect set (__npcFx), ?npcfxdrop=a,b leaves those generators out. */
const FXDBG = new URLSearchParams(window.location.search).get('npcfx')
const FXDROP = (new URLSearchParams(window.location.search).get('npcfxdrop') ?? '').split(',').filter(Boolean)
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
 *
 * Scene -> Monsters runs through here too (lib/mobSpawns): each monster
 * stands on the collision in its spawn region, rests a while, then walks to
 * another point of the region and rests again (Roam). Only those out at the
 * time of day show, one per slot. Visual only: nothing fights.
 */

/** NPCs closer than this to the camera play their idle, world units. */
const ANIMATE_RANGE = Number(new URLSearchParams(window.location.search).get('npcanim') ?? 60)
/**
 * Beyond this, an NPC is posed at the game's own motion rate, 30 times a
 * second, rather than every frame. Posing is CPU work over every vertex: in
 * Bastok Markets 15 idling NPCs of 6-8k vertices cost 134 -> 109 fps when
 * posed every frame (2026-10-25). Nearer than this, every frame stays smooth.
 */
const SMOOTH_RANGE = 20
const MOTION_STEP = 1 / 30
/**
 * NPCs further than this are not drawn: a town's 150 at ten pieces each
 * halved the frame rate from the overview, where they are specks
 * (Southern San d'Oria 177 -> 79 fps, 2026-10-25). The game draws them
 * nearer than this.
 */
const DRAW_RANGE = 100
/** Monsters further than this from the camera stop wandering until it comes nearer: nobody sees them. */
const ROAM_RANGE = DRAW_RANGE * 1.5
/** A monster's walk at LandSandBoat's usual speed 40, units a second: an unhurried wander. */
const WALK_SPEED = 1.8
/** How far a monster walks at once, and how long it rests between walks, seconds. */
const WALK_MIN = 4, WALK_MAX = 14
const REST_MIN = 4, REST_MAX = 16
/** Ground no higher or lower than this from where it stands: a cliff is not a path. */
const STEP_LIMIT = 4

/** One draw: a look's meshes that share a texture, merged. */
interface Part {
  geometry: THREE.BufferGeometry
  material: THREE.Material
  /** Each skinned source mesh's place in the merged vertices. */
  skins: { offset: number; skin: SkinTarget }[]
}

interface Template {
  /** The model as buildModel made it; kept for its textures and materials, and to dispose. */
  built: BuiltModel
  model: NpcModel
  parts: Part[]
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
  /** Seconds since it was last posed, started at random so the 30-a-second poses spread over frames. */
  since: number
  /** From the install's name file; empty when it has none. */
  name: string
  /** Where it stands and which way it faces, in the zone's own (Y down) space. */
  at: [number, number, number]
  facing: number
  /** The motion it plays now: its idle, or a monster's walk. */
  clips: ParsedAnimation[]
  roam?: Roam
}

/** A monster's wandering: where it may go, where it is going, and when. */
interface Roam {
  /** Its spawn region's outline (mobSpawns), or null for a fixed spot it wanders near. */
  region: number[] | null
  home: [number, number]
  speed: number
  /** Spawn time (0 any, 1 evening, 2 night) and slot (-1 none), for the time of day. */
  time: number
  slot: number
  active: boolean
  /** Found no floor anywhere in its region: never shown. */
  lost?: boolean
  /** Stood on the collision yet (the collision can arrive after the monsters). */
  grounded: boolean
  target: [number, number, number] | null
  /** Seconds left resting; seconds to the next ground check while walking. */
  rest: number
  groundIn: number
}

/**
 * Merges meshes into one geometry: positions, normals, uvs (zero where a mesh
 * has none) and indices, each mesh's vertices after the last's.
 */
function mergeMeshes(meshes: THREE.Mesh[]): THREE.BufferGeometry {
  let vertices = 0, indices = 0
  for (const m of meshes) { vertices += m.geometry.getAttribute('position').count; indices += m.geometry.getIndex()?.count ?? 0 }
  const position = new Float32Array(vertices * 3), normal = new Float32Array(vertices * 3), uv = new Float32Array(vertices * 2)
  const index = vertices > 65535 ? new Uint32Array(indices) : new Uint16Array(indices)
  let v = 0, n = 0
  for (const m of meshes) {
    const g = m.geometry
    const p = g.getAttribute('position')
    position.set(p.array as Float32Array, v * 3)
    const nm = g.getAttribute('normal')
    if (nm) normal.set(nm.array as Float32Array, v * 3)
    const t = g.getAttribute('uv')
    if (t) uv.set(t.array as Float32Array, v * 2)
    const ix = g.getIndex()
    if (ix) for (let i = 0; i < ix.count; i++) index[n + i] = ix.getX(i) + v
    v += p.count
    n += ix?.count ?? 0
  }
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.BufferAttribute(position, 3))
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3))
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  out.setIndex(new THREE.BufferAttribute(index, 1))
  return out
}

/**
 * Builds a look once, its meshes merged by texture: every draw call cost
 * about 8 microseconds whatever it drew, and a dressed character is a dozen
 * meshes over half as many textures. In Bastok Markets the 18 NPCs on
 * screen added 214 draws and 154 -> 124 fps; with a plain material instead
 * of the lit one it was 123.5, so the draws were the cost, not the shading
 * (2026-10-25). Skinning still runs per source mesh, into its own slice of
 * the merged vertices.
 */
function makeTemplate(model: NpcModel): Template {
  const built = buildModel(model.model)
  const groups = new Map<string, THREE.Mesh[]>()
  for (const mesh of built.meshes) {
    const mat = mesh.material as THREE.MeshStandardMaterial
    const key = (mat.map?.uuid ?? 'none') + '|' + mat.alphaTest
    const list = groups.get(key)
    if (list) list.push(mesh)
    else groups.set(key, [mesh])
  }
  const parts: Part[] = []
  for (const meshes of groups.values()) {
    const skins: Part['skins'] = []
    let offset = 0
    for (const mesh of meshes) {
      const positions = mesh.geometry.getAttribute('position').array
      const skin = built.skinTargets.find(t => t.positions === positions)
      if (skin) skins.push({ offset, skin })
      offset += mesh.geometry.getAttribute('position').count
    }
    parts.push({ geometry: mergeMeshes(meshes), material: meshes[0].material as THREE.Material, skins })
  }
  return { built, model, parts, inverseBind: model.model.skeleton?.matrices.map(invertRigidMatrix4) ?? null }
}

function place(template: Template, x: number, y: number, z: number, facing: number): Placed {
  const group = new THREE.Group()
  group.position.set(x, y, z)
  // facing 0-255 is a full turn clockwise from east (+X; north is +Z, so 64
  // faces south). The models face their own +X.
  group.rotation.y = (facing / 256) * Math.PI * 2
  const geometries: THREE.BufferGeometry[] = []
  const skins: SkinTarget[] = []
  for (const part of template.parts) {
    // Skinned parts get their own vertices; still ones share the template's.
    const geometry = part.skins.length ? part.geometry.clone() : part.geometry
    if (part.skins.length) {
      geometries.push(geometry)
      const array = geometry.getAttribute('position').array as Float32Array
      for (const { offset, skin } of part.skins) {
        skins.push({ ...skin, positions: array.subarray(offset * 3, offset * 3 + skin.origPositions.length) })
      }
    }
    const copy = new THREE.Mesh(geometry, part.material)
    copy.frustumCulled = false
    copy.matrixAutoUpdate = false
    group.add(copy)
  }
  // NPCs never move: their matrices are worked out once, not every frame
  // (three's per-object matrix updates were 8% of a Bastok street frame).
  group.updateMatrix()
  group.matrixAutoUpdate = false
  // The zone's group turns Y and Z over; the sphere is tested in the world.
  const sphere = new THREE.Sphere(new THREE.Vector3(x, -y, -z), Math.max(template.built.radius * 1.5, 1))
  return { template, group, geometries, skins, sphere, t: Math.random() * 10, posed: false, since: Math.random() * MOTION_STEP, name: '', at: [x, y, z], facing: group.rotation.y, clips: template.model.idle }
}

/**
 * The collision's floor under zone-space x, z nearest height `y` (zone
 * space, Y down), within `reach`; null if none. Every floor in the column
 * is looked at: the first one down from above was the hill over King
 * Ranperre's Tomb, and its monsters stood on the roof (Ryan, 2026-10-25).
 * The collision is in the world, where Y and Z are turned over.
 */
function floorAt(world: CollisionWorld, x: number, y: number, z: number, reach = STEP_LIMIT * 2): number | null {
  let best: number | null = null
  for (const wy of world.floorsAt(x, -z)) {
    const zy = -wy
    if (Math.abs(zy - y) <= reach && (best === null || Math.abs(zy - y) < Math.abs(best - y))) best = zy
  }
  return best
}

/** Moves a monster's group to where it is now. */
function moveTo(npc: Placed, x: number, y: number, z: number, facing: number): void {
  npc.at = [x, y, z]
  npc.facing = facing
  npc.group.position.set(x, y, z)
  npc.group.rotation.y = facing
  npc.group.updateMatrix()
  npc.sphere.center.set(x, -y, -z)
}

/** One frame of a monster's wandering: rest, pick somewhere, walk there. */
function roamStep(npc: Placed, world: CollisionWorld | null | undefined, delta: number): void {
  const r = npc.roam!
  const [x, y, z] = npc.at
  if (world && !r.grounded) {
    // The floor nearest the region's own height there. A spot over water or a
    // gap in the collision has none: try others in the region, and keep the
    // monster out of sight if none has one.
    r.grounded = true
    for (let tries = 0; tries < 8; tries++) {
      const p: [number, number] | null = tries === 0 ? [x, z] : r.region ? pointInRegion(r.region) : null
      if (!p) break
      const fy = floorAt(world, p[0], r.region ? regionHeight(r.region, p[0], p[1]) : y, p[1], 12)
      if (fy !== null) { moveTo(npc, p[0], fy, p[1], npc.facing); r.home = p; return }
    }
    r.lost = true
    return
  }
  if (!r.target) {
    r.rest -= delta
    if (r.rest > 0) return
    const near = WALK_MIN + Math.random() * (WALK_MAX - WALK_MIN)
    let to: [number, number] | null
    if (r.region) {
      to = pointInRegion(r.region, [x, z], near)
    } else {
      const a = Math.random() * Math.PI * 2, d = Math.random() * 6
      to = [r.home[0] + Math.cos(a) * d, r.home[1] + Math.sin(a) * d]
    }
    const ty = to && world ? floorAt(world, to[0], npc.at[1], to[1]) : to ? npc.at[1] : null
    if (!to || ty === null || Math.abs(ty - npc.at[1]) > STEP_LIMIT) { r.rest = 0.5 + Math.random(); return }
    r.target = [to[0], ty, to[1]]
    npc.clips = npc.template.model.walk.length ? npc.template.model.walk : npc.template.model.idle
    return
  }
  const [tx, ty, tz] = r.target
  const dx = tx - x, dz = tz - z
  const dist = Math.hypot(dx, dz)
  const step = r.speed * delta
  // Model +X turned by facing points along (cos, -sin) in zone x, z.
  const want = Math.atan2(-dz, dx)
  let turn = want - npc.facing
  turn = Math.atan2(Math.sin(turn), Math.cos(turn))
  const facing = npc.facing + Math.sign(turn) * Math.min(Math.abs(turn), 5 * delta)
  if (dist <= step) {
    moveTo(npc, tx, ty, tz, facing)
    r.target = null
    r.rest = REST_MIN + Math.random() * (REST_MAX - REST_MIN)
    npc.clips = npc.template.model.idle
    return
  }
  const nx = x + (dx / dist) * step, nz = z + (dz / dist) * step
  let ny = y
  r.groundIn -= delta
  if (world && r.groundIn <= 0) {
    r.groundIn = 0.25
    const fy = floorAt(world, nx, y, nz)
    if (fy !== null && Math.abs(fy - y) < 1.5) ny = fy
  }
  moveTo(npc, nx, ny, nz, facing)
}

/**
 * Which monsters are out at this hour: in a slot, the one whose time it is
 * (a timed member when its time has come, else an untimed one); outside a
 * slot, any whose time it is.
 */
function chooseOut(mobs: Placed[], hour: number): void {
  const slots = new Map<number, Placed[]>()
  for (const m of mobs) {
    const r = m.roam!
    if (r.slot < 0) { r.active = outAt(r.time, hour); continue }
    const list = slots.get(r.slot)
    if (list) list.push(m)
    else slots.set(r.slot, [m])
  }
  for (const members of slots.values()) {
    const pick = members.find(m => m.roam!.time > 0 && outAt(m.roam!.time, hour)) ?? members.find(m => m.roam!.time === 0)
    for (const m of members) m.roam!.active = m === pick
  }
}

/**
 * An NPC model's idle generators copied to every NPC wearing it, as a small
 * zone Zone effects can run: each copy moved from the NPC's model space to
 * the zone (turned with the NPC) and unattached, as the zone's own effects
 * are. A generator attached to the NPC (1, or 2 on the other joint) sits at
 * the joint its header names, as the idle's first frame poses it, plus its
 * own offset: a Waypoint's glow belongs inside its ring (joint 43, bone 1,
 * which the idle lifts off the ground), not on the ground below it.
 */
function effectsAt(effects: ParsedZone, npcs: Placed[]): ParsedZone {
  const spawns: GeneratorSpawn[] = []
  for (const npc of npcs) {
    const c = Math.cos(npc.facing), sn = Math.sin(npc.facing)
    const skeleton = npc.template.model.model.skeleton
    const inverseBind = npc.template.inverseBind
    const mats = skeleton && inverseBind ? poseSkeleton(skeleton, npc.template.model.idle, inverseBind, 0).worldMats : skeleton?.matrices
    for (const sp of effects.spawns ?? []) {
      if (FXDROP.includes(sp.generator)) continue
      let [ox, oy, oz] = sp.position
      const joint = sp.attach === 1 ? sp.joints[0] : sp.attach === 2 ? sp.joints[1] : -1
      const ref = joint >= 0 ? skeleton?.jointRefs?.[joint] : undefined
      const m = ref ? mats?.[ref.bone] : undefined
      if (ref && m) {
        const [jx, jy, jz] = ref.offset
        ox += jx * m[0] + jy * m[4] + jz * m[8] + m[12]
        oy += jx * m[1] + jy * m[5] + jz * m[9] + m[13]
        oz += jx * m[2] + jy * m[6] + jz * m[10] + m[14]
      }
      spawns.push({
        ...sp,
        attach: 0,
        position: [npc.at[0] + ox * c + oz * sn, npc.at[1] + oy, npc.at[2] - ox * sn + oz * c],
        rotation: [sp.rotation[0], sp.rotation[1] + npc.facing, sp.rotation[2]],
      })
    }
  }
  return { ...effects, spawns }
}

export function NpcStations({ root, zoneId, world, effectRange = null, npcs = true, monsters = null }: {
  root: string
  zoneId: number
  /** Scene -> NPCs. */
  npcs?: boolean
  /** Scene -> Monsters, with the hour (Scene -> Time of day) that picks who is out; null for none. */
  monsters?: { hour: number } | null
  /** Collision, so an NPC behind a wall is not named through it. */
  world?: CollisionWorld | null
  /** Scene → Effect distance when Zone effects is on; null runs no NPC effects. */
  effectRange?: number | null
}) {
  const holder = useMemo(() => {
    const g = new THREE.Group()
    g.rotation.x = Math.PI
    g.updateMatrix()
    g.matrixAutoUpdate = false
    return g
  }, [])
  const [placed, setPlaced] = useState<Placed[]>([])
  const camera = useThree(st => st.camera)

  const showMonsters = monsters !== null
  const worldRef = useRef(world)
  worldRef.current = world
  useEffect(() => {
    let cancelled = false
    const stations = npcs ? npcStations(zoneId) : []
    const mobs = showMonsters ? mobSpawns(zoneId) : { r: [] as number[][], m: [] as ReturnType<typeof mobSpawns>['m'] }
    const templates = new Map<NpcModel, Template>()
    const all: Placed[] = []
    const failed: unknown[] = []
    const names = npcNames(root, zoneId).catch(() => new Map<number, string>())
    void Promise.all(stations.map(async ([index, x, y, z, facing, look]) => {
      const model = await loadNpcModel(root, look)
      if (cancelled) return
      if (!model) { failed.push([index, look]); return }
      let template = templates.get(model)
      if (!template) { template = makeTemplate(model); templates.set(model, template) }
      const npc = place(template, x, y, z, facing)
      npc.name = (await names).get(index) ?? ''
      if (cancelled) return
      holder.add(npc.group)
      all.push(npc)
    })).then(() => Promise.all(mobs.m.map(async ([index, look, where, time, slot, speed]) => {
      const model = await loadNpcModel(root, look)
      if (cancelled) return
      if (!model) { failed.push([index, look]); return }
      let template = templates.get(model)
      if (!template) { template = makeTemplate(model); templates.set(model, template) }
      let x: number, y: number, z: number
      let region: number[] | null = null
      if (Array.isArray(where)) {
        [x, y, z] = where
      } else {
        region = mobs.r[where] ?? null
        const p = region ? pointInRegion(region) : null
        if (!region || !p) { failed.push([index, 'region']); return }
        ;[x, z] = p
        y = regionHeight(region, x, z)
      }
      const mob = place(template, x, y, z, Math.random() * 256)
      mob.name = (await names).get(index) ?? ''
      if (cancelled) return
      mob.roam = {
        region, home: [x, z], speed: WALK_SPEED * ((speed ?? 40) / 40), time, slot,
        active: true, grounded: false, target: null, rest: Math.random() * REST_MAX, groundIn: 0,
      }
      holder.add(mob.group)
      all.push(mob)
    }))).then(() => {
      if (cancelled) return
      setPlaced(all)
      if (CENSUS) {
        ;(window as unknown as Record<string, unknown>).__npcs = () => ({
          zone: zoneId, stations: stations.length, monsters: mobs.m.length, out: all.filter(n => n.roam?.active).length, walking: all.filter(n => n.roam?.target).length, placed: all.length, failed: failed.length, failedLooks: failed, looks: templates.size,
          shown: all.filter(n => n.group.visible).length,
        })
        // Grounds every monster now (normally only those near the camera) and counts what found no floor.
        ;(window as unknown as Record<string, unknown>).__mobGround = () => {
          let none = 0, moved = 0
          for (const n of all) {
            if (!n.roam || n.roam.grounded || !worldRef.current) continue
            roamStep(n, worldRef.current, 0)
            if (n.roam.lost) none++
            else moved++
          }
          // How far each stands from its region's own height there: on the wrong floor is several units.
          const off = all.filter(n => n.roam?.region && !n.roam.lost).map(n => Math.abs(n.at[1] - regionHeight(n.roam!.region!, n.at[0], n.at[2])))
          return { none, moved, total: all.filter(n => n.roam).length, over3: off.filter(d => d > 3).length, over8: off.filter(d => d > 8).length }
        }
        // ?census=1&campos=..: the camera `dist` units in front of NPC i, looking at it.
        ;(window as unknown as Record<string, unknown>).__npcView = (i: number, dist = 4, height = 1.6) => {
          const n = all[i]
          if (!n) return null
          const yaw = n.group.rotation.y
          const c = n.sphere.center
          // In the world the model's +X turns by -yaw (the zone group flips Y and Z).
          camera.position.set(c.x + Math.cos(yaw) * dist, c.y + height, c.z + Math.sin(yaw) * dist)
          camera.lookAt(c.x, c.y + height * 0.7, c.z)
          return { i, name: n.name, out: n.roam ? n.roam.active && !n.roam.lost : true, at: c.toArray().map(v => +v.toFixed(1)), facing: +yaw.toFixed(2) }
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
        for (const part of t.parts) part.geometry.dispose()
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
  }, [root, zoneId, holder, camera, npcs, showMonsters])

  // Who is out changes with the hour; checked when it moves, not every frame.
  const hour = monsters?.hour ?? 12
  useEffect(() => {
    const mobs = placed.filter(n => n.roam)
    if (mobs.length) chooseOut(mobs, hour)
  }, [placed, hour])

  const frustum = useMemo(() => new THREE.Frustum(), [])
  const viewProjection = useMemo(() => new THREE.Matrix4(), [])
  useFrame(({ camera }, delta) => {
    if (!placed.length) return
    viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    frustum.setFromProjectionMatrix(viewProjection)
    for (const npc of placed) {
      let distance = npc.sphere.center.distanceTo(camera.position)
      if (npc.roam) {
        if (!npc.roam.active || npc.roam.lost) { npc.group.visible = false; continue }
        if (distance < ROAM_RANGE) {
          roamStep(npc, world, Math.min(delta, 0.1))
          distance = npc.sphere.center.distanceTo(camera.position)
        }
      }
      const inView = distance < DRAW_RANGE && frustum.intersectsSphere(npc.sphere)
      npc.group.visible = inView
      if (!inView) continue
      const { model, inverseBind } = npc.template
      const skeleton = model.model.skeleton
      if (!skeleton || !inverseBind || !npc.skins.length) continue
      // Without an idle it is posed once, in its bind pose: unposed, the
      // parser's bone-local vertices would draw collapsed.
      const near = npc.clips.length > 0 && distance < ANIMATE_RANGE
      if (!near && npc.posed) continue
      if (near) npc.t += delta
      npc.since += delta
      if (npc.posed && distance > SMOOTH_RANGE && npc.since < MOTION_STEP) continue
      npc.since %= MOTION_STEP
      skinMeshes(npc.skins, poseSkeleton(skeleton, npc.clips, inverseBind, npc.t))
      for (const g of npc.geometries) g.getAttribute('position').needsUpdate = true
      npc.posed = true
    }
  })

  // Hovering an NPC names it, as targeting does in game: the nearest NPC mesh
  // under the pointer, unless the collision says a wall is in front.
  const gl = useThree(st => st.gl)
  const [hover, setHover] = useState<{ name: string; at: [number, number, number] } | null>(null)
  const pointer = useRef<{ x: number; y: number } | null>(null)
  useEffect(() => {
    const el = gl.domElement
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect()
      pointer.current = { x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -((e.clientY - r.top) / r.height) * 2 + 1 }
    }
    const leave = () => { pointer.current = null }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerleave', leave)
    return () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerleave', leave) }
  }, [gl])
  const raycaster = useMemo(() => new THREE.Raycaster(), [])
  const hits = useMemo<THREE.Intersection[]>(() => [], [])
  const frame = useRef(0)
  useFrame(({ camera: cam }) => {
    const p = pointer.current
    // Every third frame is plenty for a label, and the camera can move under a still pointer.
    if (++frame.current % 3 && p) return
    let best: Placed | null = null
    let bestDistance = Infinity
    if (p) {
      raycaster.setFromCamera(new THREE.Vector2(p.x, p.y), cam)
      for (const npc of placed) {
        if (!npc.name || !npc.group.visible || !raycaster.ray.intersectsSphere(npc.sphere)) continue
        hits.length = 0
        raycaster.intersectObject(npc.group, true, hits)
        if (hits.length && hits[0].distance < bestDistance) { best = npc; bestDistance = hits[0].distance }
      }
      if (best && world) {
        const wall = world.castRay(raycaster.ray.origin, raycaster.ray.direction, bestDistance)
        if (wall && wall.distance < bestDistance - 0.3) best = null
      }
    }
    if (!best) { if (hover) setHover(null); return }
    const c = best.sphere.center
    const top = -best.template.built.bounds.min.y
    if (hover?.name !== best.name || hover.at[0] !== c.x || hover.at[2] !== c.z) setHover({ name: best.name, at: [c.x, c.y + top + 0.35, c.z] })
  })

  const effectZones = useMemo(() => {
    const byModel = new Map<ParsedZone, Placed[]>()
    for (const npc of placed) {
      // Monsters move; Zone effects places its generators once.
      if (npc.roam) continue
      const fx = npc.template.model.effects
      if (!fx) continue
      const list = byModel.get(fx)
      if (list) list.push(npc)
      else byModel.set(fx, [npc])
    }
    const zones = [...byModel].map(([fx, npcs]) => effectsAt(fx, npcs))
    if (CENSUS) {
      ;(window as unknown as Record<string, unknown>).__npcFxZones = zones
      ;(window as unknown as Record<string, unknown>).__npcFx = zones.map(z => ({
        spawns: z.spawns?.length,
        gens: [...new Set(z.spawns?.map(sp => sp.dir + '/' + sp.generator + ':' + sp.link + ':' + sp.prefabIndices.length + ':' + sp.life + ':' + sp.tint[3]))],
        at: z.spawns?.[0]?.position,
      }))
    }
    return zones
  }, [placed])

  return (
    <>
      <primitive object={holder} />
      {effectRange !== null && effectZones.filter((_, i) => !FXDBG || String(i) === FXDBG).map((zone, i) => <ZoneEffects key={i} zone={zone} range={effectRange} npc />)}
      {hover && (
        <Html position={hover.at} center zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
          <div className="npc-name">{hover.name}</div>
        </Html>
      )}
    </>
  )
}
