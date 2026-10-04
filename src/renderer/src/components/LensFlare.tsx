import { useEffect, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { ParsedZone } from '../lib/ffxi-dat'
import type { GeneratorSpawn } from '../lib/ffxi-dat/types'
import { sampleKeyFrames } from '../lib/ffxi-dat/GeneratorParser'
import { applySpawnStages } from '../lib/spawnStages'
import { GAMMA_BLEND_LAYER } from '../lib/GammaBlendPass'
import { sunDirection } from '../lib/zoneLighting'
import type { CollisionWorld } from '../lib/CollisionWorld'

/**
 * The sun's and moon's lens flares: generators linking type 0x39 to a 0x21
 * sheet whose meshes lie along the line from the body's place on screen
 * through the screen centre (xim ZoneDrawer.kt drawLensFlare, as a reference).
 *
 *   West Ronfaure, sunshine: `lf01`, seventeen meshes. Mesh 0, at the sun, is
 *   the sun itself — the white disc and starburst from the bottom half of the
 *   sheet; the rest are the discs and rainbow rings across the frame. Each
 *   weather has its own sheet (`lf02` fair, `lf03` clouds and fog).
 *
 * Sizes are 32nds of the screen on each axis, so the chain stretches with the
 * aspect ratio as retail's does. Additive (SRC_ALPHA, ONE), no depth test, no
 * fog, drawn last. Colour: stage 0 is texel x vertex colour, stage 1 x the
 * generator's colour — the same stages as every generator mesh here.
 *
 * Retail scales the flare by how much of a small screen quad at the sun
 * survives the depth test. That needs a GPU query; here it is the share of a
 * ring of rays toward the sun that clear the zone's collision, and it falls to
 * nothing as the sun leaves the frame or sets. Trees are not in the collision,
 * so they do not dim it.
 */

/** Rays in the occlusion test, and their spread around the body, radians. */
const OCCLUSION_TAPS = 9
const OCCLUSION_SPREAD = 0.012
const OCCLUSION_RANGE = 4000
/** Where the camera-space quads sit; any depth inside the frustum will do. */
const FLARE_DEPTH = 2

const decode = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))

interface Element {
  mesh: THREE.Mesh
  offset: number
}

interface Flare {
  spawn: GeneratorSpawn
  moon: boolean
  elements: Element[]
  tint: THREE.Vector4
  map: THREE.Texture
  /** Body on screen, 0..1 with y down. */
  screen: THREE.Vector2
  /** The generator's alpha, and the share of the body the terrain leaves. */
  alpha: number
  strength: number
}

function buildFlares(zone: ParsedZone, state: string): Flare[] {
  const inState = new RegExp(`(^|/)weat/${state}(/|$)`)
  const out: Flare[] = []
  for (const sp of zone.spawns ?? []) {
    if (sp.link !== 'flare' || !inState.test(sp.dir) || (sp.attach !== 0xe && sp.attach !== 0xf)) continue
    const p = zone.prefabs[sp.prefabIndices[0]]
    const tex = p ? zone.textures[p.materialIndex] : undefined
    if (!p?.flare || !tex) continue

    const map = new THREE.DataTexture(new Uint8Array(tex.rgba), tex.width, tex.height, THREE.RGBAFormat)
    map.magFilter = THREE.LinearFilter
    map.minFilter = THREE.LinearFilter
    map.generateMipmaps = false
    map.flipY = false
    map.colorSpace = THREE.SRGBColorSpace
    map.needsUpdate = true

    const material = new THREE.MeshBasicMaterial({
      map, vertexColors: true, transparent: true, depthTest: false, depthWrite: false,
      side: THREE.DoubleSide, fog: false, blending: THREE.AdditiveBlending,
    })
    const tint = applySpawnStages(material, sp.tint, false)

    const elements: Element[] = []
    for (const m of p.flare) {
      const n = m.vertices.length / 3
      let extent = 0
      for (let i = 0; i < m.vertices.length; i++) extent = Math.max(extent, Math.abs(m.vertices[i]))
      if (n === 0 || extent === 0) continue // padding: retail draws these at no size
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.Float32BufferAttribute(m.vertices, 3))
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(m.uvs, 2))
      const col = new Float32Array(n * 4)
      for (let v = 0; v < n; v++) {
        for (let c = 0; c < 3; c++) col[v * 4 + c] = decode(m.colors[v * 4 + c] * 2)
        col[v * 4 + 3] = Math.min(1, m.colors[v * 4 + 3] * 2)
      }
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 4))
      const mesh = new THREE.Mesh(geo, material)
      mesh.frustumCulled = false
      mesh.matrixAutoUpdate = false
      mesh.layers.set(GAMMA_BLEND_LAYER)
      mesh.renderOrder = 1000
      elements.push({ mesh, offset: m.offset })
    }
    if (elements.length) {
      out.push({ spawn: sp, moon: sp.attach === 0xf, elements, tint, map, screen: new THREE.Vector2(), alpha: 0, strength: 0 })
    }
  }
  return out
}

export function LensFlare({
  zone, state, timeOfDayRef, collision,
}: {
  zone: ParsedZone
  state: string
  timeOfDayRef: React.RefObject<number>
  collision: CollisionWorld | null
}) {
  const flares = useMemo(() => {
    const f = buildFlares(zone, state)
    if (f.length) {
      console.log(`[FLARE] ${f.length} lens flares for ${state}: ` +
        f.map(x => `${x.spawn.generator}(${x.moon ? 'moon' : 'sun'}, ${x.elements.length} elements)`).join(' '))
    }
    return f
  }, [zone, state])

  useEffect(() => () => {
    for (const f of flares) {
      for (const e of f.elements) e.mesh.geometry.dispose()
      ;(f.elements[0]?.mesh.material as THREE.Material | undefined)?.dispose()
      f.map.dispose()
    }
  }, [flares])

  const tmp = useMemo(() => ({
    dir: new THREE.Vector3(), tap: new THREE.Vector3(), side: new THREE.Vector3(), up: new THREE.Vector3(),
    p: new THREE.Vector3(), local: new THREE.Matrix4(),
    x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0),
  }), [])

  // Occlusion and colour, once a frame. The screen position is taken at draw
  // time (below), against the camera actually used, so the chain cannot lag.
  useFrame(({ camera }) => {
    const minutes = (timeOfDayRef.current ?? 12) * 60
    const day = (((minutes % 1440) + 1440) % 1440) / 1440
    for (const f of flares) {
      sunDirection(minutes, tmp.dir)
      if (f.moon) tmp.dir.negate()
      let visible = 0
      if (tmp.dir.y > 0) {
        if (!collision) visible = OCCLUSION_TAPS
        else {
          tmp.side.crossVectors(tmp.dir, Math.abs(tmp.dir.y) > 0.99 ? tmp.x : tmp.y).normalize()
          tmp.up.crossVectors(tmp.side, tmp.dir).normalize()
          for (let i = 0; i < OCCLUSION_TAPS; i++) {
            const a = (i / (OCCLUSION_TAPS - 1)) * Math.PI * 2
            const r = i === 0 ? 0 : OCCLUSION_SPREAD
            tmp.tap.copy(tmp.dir).addScaledVector(tmp.side, Math.cos(a) * r).addScaledVector(tmp.up, Math.sin(a) * r).normalize()
            if (!collision.castRay(camera.position, tmp.tap, OCCLUSION_RANGE)) visible++
          }
        }
      }
      f.strength = visible / OCCLUSION_TAPS
      const sp = f.spawn
      const t = sp.todCurves
      const channel = (curve: number[] | undefined, byte: number) =>
        decode(curve ? 2 * sampleKeyFrames(curve, day) : byte / 128)
      f.tint.set(
        channel(t.r, sp.tint[0]), channel(t.g, sp.tint[1]), channel(t.b, sp.tint[2]),
        0,
      )
      f.alpha = (sp.tint[3] / 128) * (t.alpha ? sampleKeyFrames(t.alpha, day) : 1)
    }
  })

  // Place every element when it is drawn.
  useEffect(() => {
    for (const f of flares) {
      for (const e of f.elements) {
        e.mesh.onBeforeRender = (_r, _s, camera) => {
          const cam = camera as THREE.PerspectiveCamera
          // The body on screen, from its direction alone.
          const minutes = (timeOfDayRef.current ?? 12) * 60
          sunDirection(minutes, tmp.dir)
          if (f.moon) tmp.dir.negate()
          tmp.p.copy(cam.position).addScaledVector(tmp.dir, 1000).project(cam)
          const behind = tmp.dir.dot(cam.getWorldDirection(tmp.tap)) <= 0
          // Off the frame, retail's test quad finds no pixels: fade out over
          // the last tenth of the screen beyond the edge.
          const out = Math.max(Math.abs(tmp.p.x), Math.abs(tmp.p.y)) - 1
          const edge = behind ? 0 : 1 - Math.min(1, Math.max(0, out / 0.2))
          const sx = (tmp.p.x + 1) / 2, sy = (1 - tmp.p.y) / 2
          // Along the line from the body through the centre to its mirror.
          const px = sx * (1 - e.offset) + (1 - sx) * e.offset
          const py = sy * (1 - e.offset) + (1 - sy) * e.offset
          const halfH = FLARE_DEPTH * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)
          const halfW = halfH * cam.aspect
          // Camera space: x right, y up; the sheet's y runs down, in 32nds.
          tmp.local.makeScale(halfW / 16, -halfH / 16, 1)
            .setPosition((px * 2 - 1) * halfW, (1 - py * 2) * halfH, -FLARE_DEPTH)
          e.mesh.matrixWorld.multiplyMatrices(cam.matrixWorld, tmp.local)
          f.screen.set(sx, sy)
          f.tint.w = f.alpha * f.strength * edge
        }
      }
    }
  }, [flares, timeOfDayRef, tmp])

  return (
    <group>
      {flares.flatMap((f, i) => f.elements.map((e, j) => <primitive key={i + '-' + j} object={e.mesh} />))}
    </group>
  )
}
