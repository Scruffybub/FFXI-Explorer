import { useEffect, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { ParsedZone } from '../lib/ffxi-dat'
import type { GeneratorSpawn } from '../lib/ffxi-dat/types'
import { sampleKeyFrames } from '../lib/ffxi-dat/GeneratorParser'
import { applySpawnStages } from '../lib/spawnStages'
import { GAMMA_BLEND_LAYER } from '../lib/GammaBlendPass'
import { sunDirection } from '../lib/zoneLighting'

/**
 * The zone's sky layers from <zone>/weat/<state>/: cloud canopies, the star
 * dome, and the sun and moon glows — placed by their own generators.
 *
 *   clouds (cld1, cld2)  camera-following domes, attach 0; cld1 turns slowly
 *                        (0x0B, radians per frame)
 *   stars (star/)        a camera-following dome whose alpha rides the ksta
 *                        curve: 1.34 at midnight, 0 by day
 *   sun (sun1)           attach 0xE: rides the sun's direction, disc and glow
 *                        from the MMB `sunsphere`
 *   moon halo (moon/kasa) attach 0xF: the moon's direction, `moonsphere`
 *
 * Colour: the 0x60–0x62 time-of-day curves set R, G, B (on the byte/255 scale
 * the tint stage doubles) and 0x63 multiplies alpha, sampled at the fraction of
 * the day (xim ParticleUpdaters.kt ClockValueUpdater; kuluu zone_clouds.rs, as
 * references). Blend byte 0x1E low nibble 8 is additive, 4 alpha; generators
 * without one are additive when they ride the sun or moon.
 *
 * Distances are this viewer's, not retail's: retail hangs the canopies a few
 * hundred units out, inside its short fog, and the sun and moon at 900. This
 * viewer shows terrain far past that, so the canopies are pushed out to just
 * inside the sky dome, keeping their authored proportions, as kuluu does, and
 * the sun and moon ride at a fixed fraction of it, scaled to keep retail's
 * angular size. Not drawn: the moon's phase sprite (a 0x21 sheet this viewer
 * does not parse) and the screen-space lens flare that is Ronfaure's sun disc.
 *
 * The sun mesh is two pieces: a flat disc with render state 0x0 and a glow ring
 * (0x8000) whose alpha falls 128 → 0 outward. Retail draws the sun's own disc
 * with colour writes off, only to measure how much of it is hidden for the lens
 * flare (kuluu sun_moon.rs, from xim ParticleDrawer renderHazeTexture) — so
 * only the 0x8000 glow is visible. That glow, drawn at the size the data gives
 * (70x at 900 units), fades out some 60° from the sun and whitened the whole
 * sky at noon and dusk, 2026-09-28 — something about how retail sizes or
 * blends it is still unknown. Until a reference settles it, the sun and moon
 * are drawn as modest discs (SUN_DEGREES, MOON_DEGREES) at the data's
 * positions, coloured and faded by the generators' own time-of-day curves:
 * ksr1/ksg1/ksb1 for the sun, the moon's k000 alpha. The meshes stay parsed.
 *
 * Fog: retail's canopies sit a few hundred units out, where its fog fades
 * them into the horizon. Pushed out to the dome here, they fade by the fog they
 * would have had at their retail distance — as opacity, not colour: turning the
 * rim fog-coloured left a pale band where the canopy ended, worse on the
 * additive layer.
 */

/** Retail's sun and moon distance (xim EnvironmentManager sunMoonDistance). */
const CELESTIAL_DISTANCE = 900
/** Stand-in disc sizes, across. The moon's is retail's: 3.94 × 20 at 900 (kuluu). */
const SUN_DEGREES = 3
const MOON_DEGREES = 5

/** A soft disc: solid core, feathered rim — the stand-in sun and moon. */
function discTexture(): THREE.DataTexture {
  const N = 64
  const data = new Uint8Array(N * N * 4)
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const r = Math.hypot(x + 0.5 - N / 2, y + 0.5 - N / 2) / (N / 2)
      const a = r < 0.55 ? 1 : Math.max(0, 1 - (r - 0.55) / 0.45) ** 2
      const o = (y * N + x) * 4
      data[o] = data[o + 1] = data[o + 2] = 255
      data[o + 3] = Math.round(a * 255)
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat)
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearFilter
  tex.needsUpdate = true
  return tex
}
const EFFECT_FPS = 60

interface Layer {
  mesh: THREE.Mesh
  kind: 'camera' | 'sun' | 'moon'
  base: THREE.Vector3
  rotation: THREE.Euler
  spin: [number, number, number]
  scale: THREE.Vector3
  tint: THREE.Vector4
  spawn: GeneratorSpawn
  map: THREE.Texture | null
  order: number
}

const decode = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))

function buildLayers(zone: ParsedZone, state: string, radius: number): Layer[] {
  const inState = new RegExp(`(^|/)weat/${state}(/(star|moon))?$`)
  const layers: Layer[] = []
  for (const sp of zone.spawns ?? []) {
    if (!inState.test(sp.dir)) continue
    const kind = sp.attach === 0xe ? 'sun' : sp.attach === 0xf ? 'moon' : sp.followCamera ? 'camera' : null
    if (!kind) continue
    if (kind !== 'camera') {
      // One stand-in disc per sun or moon generator; see the note above.
      if (layers.some(l => l.kind === kind)) continue
      const deg = kind === 'sun' ? SUN_DEGREES : MOON_DEGREES
      const size = 2 * radius * 0.8 * Math.tan(((deg / 2) * Math.PI) / 180)
      const geo = new THREE.PlaneGeometry(1, 1)
      geo.rotateY(Math.PI / 2) // face +X, the axis turned to the camera
      const map = discTexture()
      const mat = new THREE.MeshBasicMaterial({
        map, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
        blending: THREE.AdditiveBlending,
      })
      const tint = applySpawnStages(mat, sp.tint, false)
      const mesh = new THREE.Mesh(geo, mat)
      mesh.frustumCulled = false
      mesh.matrixAutoUpdate = false
      mesh.layers.set(GAMMA_BLEND_LAYER)
      mesh.renderOrder = -30
      layers.push({
        mesh, kind, spawn: sp, tint, map, order: -30,
        scale: new THREE.Vector3(size, size, size),
        base: new THREE.Vector3(), rotation: new THREE.Euler(), spin: [0, 0, 0],
      })
      continue
    }
    for (const pi of sp.prefabIndices) {
      const p = zone.prefabs[pi]
      if (!p || !p.indices.length) continue
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.Float32BufferAttribute(p.vertices, 3))
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(p.uvs, 2))
      // Stage 0's MODULATE2X folded in, as for generator water: vertex colour
      // x2, gamma-decoded; vertex alpha x2, a weight.
      const n = p.vertices.length / 3
      const col = new Float32Array(n * 4)
      for (let v = 0; v < n; v++) {
        for (let c = 0; c < 3; c++) col[v * 4 + c] = decode((p.colors[v * 4 + c] ?? 0.5) * 2)
        col[v * 4 + 3] = Math.min(1, (p.colors[v * 4 + 3] ?? 0.5) * 2)
      }
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 4))
      geo.setIndex(p.indices)

      // Blank-named meshes (the sun and moon glows) are untextured: vertex
      // colour and alpha carry the whole gradient.
      const tex = p.textureName?.trim() ? zone.textures[p.materialIndex] : undefined
      let map: THREE.DataTexture | null = null
      if (tex) {
        map = new THREE.DataTexture(new Uint8Array(tex.rgba), tex.width, tex.height, THREE.RGBAFormat)
        map.wrapS = map.wrapT = THREE.RepeatWrapping
        map.magFilter = THREE.LinearFilter
        map.minFilter = THREE.LinearMipmapLinearFilter
        map.generateMipmaps = true
        map.flipY = false
        map.colorSpace = THREE.SRGBColorSpace
        map.needsUpdate = true
      }
      const additive = sp.blend >= 0 ? (sp.blend & 0x0f) === 8 : kind !== 'camera'
      const mat = new THREE.MeshBasicMaterial({
        ...(map && { map }),
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: kind === 'camera',
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      })
      const tint = applySpawnStages(mat, sp.tint, false)
      const fogScale = { value: 1 }
      if (kind === 'camera') {
        // Linear fog on the depth the layer would have had at its authored size.
        const stages = mat.onBeforeCompile
        mat.onBeforeCompile = (shader, renderer) => {
          stages(shader, renderer)
          shader.uniforms.uSkyFogScale = fogScale
          shader.fragmentShader = shader.fragmentShader
            .replace('void main() {', 'uniform float uSkyFogScale;\nvoid main() {')
            .replace('#include <fog_fragment>', [
              '#ifdef USE_FOG',
              '  float skyFog = clamp((vFogDepth * uSkyFogScale - fogNear) / max(fogFar - fogNear, 0.0001), 0.0, 1.0);',
              '  gl_FragColor.a *= 1.0 - skyFog;',
              '#endif',
            ].join('\n'))
        }
        mat.customProgramCacheKey = () => 'genspawn-stages-unlit-skyfog'
      }
      const mesh = new THREE.Mesh(geo, mat)
      mesh.frustumCulled = false
      mesh.matrixAutoUpdate = false
      mesh.layers.set(GAMMA_BLEND_LAYER)
      const isStar = /\/star$/.test(sp.dir)
      // Back to front: stars, then the sun and moon, then clouds, then the world.
      mesh.renderOrder = isStar ? -40 : kind === 'camera' ? -20 : -30

      const scale = new THREE.Vector3(...sp.scale)
      if (kind === 'camera') {
        // Push the rim out to just inside the dome, keeping proportions.
        let half = 0
        for (let v = 0; v < n; v++) half = Math.max(half, Math.abs(p.vertices[v * 3]), Math.abs(p.vertices[v * 3 + 2]))
        const rim = half * Math.max(sp.scale[0], sp.scale[2])
        const target = radius * (isStar ? 0.95 : 0.85)
        if (rim > 1) {
          const k = Math.max(1, target / rim)
          scale.multiplyScalar(k)
          fogScale.value = 1 / k
        }
      } else {
        scale.multiplyScalar((radius * 0.8) / CELESTIAL_DISTANCE)
      }
      layers.push({
        mesh, kind, spawn: sp, tint, map, scale,
        base: new THREE.Vector3(...sp.position),
        rotation: new THREE.Euler(sp.rotation[0], sp.rotation[1], sp.rotation[2], 'ZYX'),
        spin: sp.spin ?? [0, 0, 0],
        order: mesh.renderOrder,
      })
    }
  }
  return layers
}

const FLIP = new THREE.Matrix4().makeRotationX(Math.PI)

export function SkyLayers({
  zone, state, timeOfDayRef, radius,
}: {
  zone: ParsedZone
  state: string
  timeOfDayRef: React.RefObject<number>
  radius: number
}) {
  const layers = useMemo(() => {
    const l = buildLayers(zone, state, radius)
    console.log(`[SKY] ${l.length} sky layers for ${state}: ` +
      l.map(x => `${x.spawn.generator}(${x.kind})`).join(' '))
    return l
  }, [zone, state, radius])

  useEffect(() => () => {
    for (const l of layers) {
      l.mesh.geometry.dispose()
      ;(l.mesh.material as THREE.Material).dispose()
      l.map?.dispose()
    }
  }, [layers])

  const tmp = useMemo(() => ({
    dir: new THREE.Vector3(), m: new THREE.Matrix4(), q: new THREE.Quaternion(),
    look: new THREE.Matrix4(), up: new THREE.Vector3(0, 1, 0), p: new THREE.Vector3(),
    spinE: new THREE.Euler(0, 0, 0, 'ZYX'),
  }), [])

  useFrame(({ camera, clock }) => {
    const minutes = (timeOfDayRef.current ?? 12) * 60
    const day = (((minutes % 1440) + 1440) % 1440) / 1440
    const frames = clock.getElapsedTime() * EFFECT_FPS
    for (const l of layers) {
      const sp = l.spawn
      const t = sp.todCurves
      const channel = (curve: number[] | undefined, byte: number) =>
        decode(curve ? 2 * sampleKeyFrames(curve, day) : byte / 128)
      l.tint.set(
        channel(t.r, sp.tint[0]), channel(t.g, sp.tint[1]), channel(t.b, sp.tint[2]),
        (sp.tint[3] / 128) * (t.alpha ? sampleKeyFrames(t.alpha, day) : 1),
      )
      if (l.map && (sp.uvScroll[0] || sp.uvScroll[1])) {
        l.map.offset.set((sp.uvScroll[0] * frames) % 1, (sp.uvScroll[1] * frames) % 1)
      }

      if (l.kind === 'camera') {
        // camera · flip(DAT → world) · base · rotation (+ spin) · scale
        tmp.spinE.set(
          l.rotation.x + l.spin[0] * frames, l.rotation.y + l.spin[1] * frames, l.rotation.z + l.spin[2] * frames, 'ZYX')
        tmp.q.setFromEuler(tmp.spinE)
        tmp.m.compose(l.base, tmp.q, l.scale)
        l.mesh.matrix.makeTranslation(camera.position.x, camera.position.y, camera.position.z)
          .multiply(FLIP).multiply(tmp.m)
      } else {
        // On the sun's (or moon's) direction, its +X face turned to the camera.
        sunDirection(minutes, tmp.dir)
        if (l.kind === 'moon') tmp.dir.negate()
        tmp.p.copy(camera.position).addScaledVector(tmp.dir, radius * 0.8)
        const toCam = tmp.dir.clone().negate()
        const helper = Math.abs(toCam.y) > 0.99 ? new THREE.Vector3(1, 0, 0) : tmp.up
        const zAxis = new THREE.Vector3().crossVectors(toCam, helper).normalize()
        const yAxis = new THREE.Vector3().crossVectors(zAxis, toCam).normalize()
        tmp.look.makeBasis(toCam, yAxis, zAxis)
        l.mesh.matrix.copy(tmp.look).setPosition(tmp.p)
        l.mesh.matrix.scale(l.scale)
      }
      l.mesh.matrixWorldNeedsUpdate = true
    }
  })

  return (
    <group>
      {layers.map((l, i) => <primitive key={i} object={l.mesh} />)}
    </group>
  )
}
