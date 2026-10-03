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
  /** Which of the generator's live particles this copy draws. */
  slot: number
  /** Position multiplier: 1, or the push-out for layers born on a spread. */
  posScale: number
}

/**
 * When each of a generator's particles was born, and where. A sky generator
 * with a life emits on its own clock (see Emission): Thunder's flashes every
 * few seconds or half a minute, Lufaise's wind streaks every 401 frames with
 * 1500-frame lives, so four overlap. Generators without a life (clouds, stars)
 * stand for good: one particle, born at once.
 */
interface Emitter {
  slots: number
  next: number
  emitted: number
  births: number[]
  offsets: THREE.Vector3[]
}

function slotCount(sp: GeneratorSpawn): number {
  if (sp.life <= 0) return 1
  return Math.max(1, Math.min(8, Math.ceil(sp.life / Math.max(1, sp.emission.every))))
}

/** Diagnostic: ?skyphi=<degrees> pins every spread's azimuth, to frame a flash. */
const FIXED_PHI = (() => {
  if (typeof window === 'undefined') return undefined
  const v = new URLSearchParams(window.location.search).get('skyphi')
  return v === null ? undefined : (Number(v) * Math.PI) / 180
})()

/** A point on a generator's spread, DAT space; see Spread. */
export function spreadOffset(s: GeneratorSpawn['spread'], out: THREE.Vector3): THREE.Vector3 {
  if (!s) return out.set(0, 0, 0)
  const phi = FIXED_PHI ?? Math.random() * 2 * Math.PI
  const r = s.baseRadius + (s.radiusVariance ? s.radiusVariance * Math.cbrt(Math.random()) : 0)
  const tilt = s.tilt + s.tiltVariance * (Math.random() * 2 - 1)
  // Rz(tilt) then Ry(phi) on (r, 0, 0), then scale, then Rz(rotZ), Ry(rotY).
  out.set(r * Math.cos(tilt), r * Math.sin(tilt), 0)
  out.set(out.x * Math.cos(phi), out.y, -out.x * Math.sin(phi))
  out.set(out.x * s.axis[0], out.y * s.axis[1], out.z * s.axis[2])
  if (s.rotZ) out.applyAxisAngle(new THREE.Vector3(0, 0, 1), s.rotZ)
  if (s.rotY) out.applyAxisAngle(new THREE.Vector3(0, 1, 0), s.rotY)
  return out
}

/** Diagnostic: ?skyonly=cld1,kat2 draws only the named sky generators. */
const SKY_ONLY = typeof window !== 'undefined'
  ? (new URLSearchParams(window.location.search).get('skyonly') ?? '').split(',').filter(Boolean)
  : []

const decode = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))

function buildLayers(zone: ParsedZone, state: string, radius: number): Layer[] {
  const inState = new RegExp(`(^|/)weat/${state}(/(star|moon))?$`)
  const layers: Layer[] = []
  for (const sp of zone.spawns ?? []) {
    if (!inState.test(sp.dir)) continue
    if (sp.link === 'sprite') continue // WeatherParticles draws these
    if (SKY_ONLY.length && !SKY_ONLY.includes(sp.generator)) continue
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
        mesh, kind, spawn: sp, tint, map, order: -30, slot: 0, posScale: 1,
        scale: new THREE.Vector3(size, size, size),
        base: new THREE.Vector3(), rotation: new THREE.Euler(), spin: [0, 0, 0],
      })
      continue
    }
    const slots = slotCount(sp)
    for (let slot = 0; slot < slots; slot++) for (const pi of sp.prefabIndices) {
      const p = zone.prefabs[pi]
      if (!p || !p.indices.length) continue
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.Float32BufferAttribute(p.vertices, 3))
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(p.uvs, 2))
      // Stage 0's MODULATE2X folded in, as for generator water: vertex colour
      // x2, gamma-decoded; vertex alpha x2, a weight.
      const n = p.vertices.length / 3
      // Camera canopies also fade toward their own rim. Retail hides the rim
      // with its short fog and far clip; weathers with long fog (Lufaise's
      // thunder and wind) left it as hard lines across the sky, 2026-09-29.
      // Measured over all of the generator's pieces: a canopy can be an inner
      // disc plus an outer ring, and fading each to its own edge left a seam
      // where they meet (Lufaise's wind cld3/cld4).
      let rimHalf = 0
      if (kind === 'camera' && !sp.spread) {
        for (const qi of sp.prefabIndices) {
          const q = zone.prefabs[qi]
          if (!q) continue
          for (let v = 0; v < q.vertices.length; v += 3) rimHalf = Math.max(rimHalf, Math.hypot(q.vertices[v], q.vertices[v + 2]))
        }
      }
      const col = new Float32Array(n * 4)
      for (let v = 0; v < n; v++) {
        for (let c = 0; c < 3; c++) col[v * 4 + c] = decode((p.colors[v * 4 + c] ?? 0.5) * 2)
        let edge = 1
        if (rimHalf > 0) {
          const r = Math.hypot(p.vertices[v * 3], p.vertices[v * 3 + 2]) / rimHalf
          const t = Math.min(1, Math.max(0, (r - 0.55) / 0.4))
          edge = 1 - t * t * (3 - 2 * t)
        }
        col[v * 4 + 3] = Math.min(1, (p.colors[v * 4 + 3] ?? 0.5) * 2) * edge
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
      // Blend byte low nibble: 8 additive, 1 or 2 subtractive (the darkening
      // layers under Lufaise's wind), 4 or 6 alpha. Sun and moon default additive.
      // Without a blend byte retail's particles add (kuluu particle_gen.rs);
      // the standing canopies keep alpha, as they always have here. Thunder's
      // bolt is a particle with a life and no byte.
      const nib = sp.blend >= 0 ? sp.blend & 0x0f : kind === 'camera' && sp.life <= 0 ? 4 : 8
      const blending = nib === 8 ? THREE.AdditiveBlending
        : nib === 1 || nib === 2 ? THREE.SubtractiveBlending
        : THREE.NormalBlending
      const mat = new THREE.MeshBasicMaterial({
        ...(map && { map }),
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: kind === 'camera',
        blending,
      })
      const tint = applySpawnStages(mat, sp.tint, false)
      const fogScale = { value: 1 }
      if (kind === 'camera') {
        // Every canopy piece blends, whatever its render state, as kuluu does.
        // A canopy is an inner disc (render state 0x0) plus a 0x8000 ring;
        // drawing the 0x0 disc opaque, as the zone rule would, turned it into a
        // hard-edged slab and sunny skies overcast, 2026-09-29.
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
      // Flashes and bolts born on a spread go after the canopies: they sit in
      // the cloud layer and light it, and drawn first the clouds hid them.
      mesh.renderOrder = isStar ? -40 : kind === 'camera' ? (sp.spread ? -19 : -20) : -30

      const scale = new THREE.Vector3(...sp.scale)
      let posScale = 1
      if (kind === 'camera' && sp.spread) {
        // Born on a spread (Thunder's flashes and bolt, some 300 units out and
        // 130 up): push the whole thing out together, position and size, so
        // the flash keeps its place in the sky.
        let meshR = 0
        for (const qi of sp.prefabIndices) {
          const q = zone.prefabs[qi]
          if (!q) continue
          for (let v = 0; v < q.vertices.length; v += 3) meshR = Math.max(meshR, Math.hypot(q.vertices[v], q.vertices[v + 1], q.vertices[v + 2]))
        }
        const extent = Math.hypot(...sp.position) + sp.spread.baseRadius + sp.spread.radiusVariance +
          meshR * Math.max(...sp.scale.map(Math.abs))
        const k = Math.max(1, (radius * 0.85) / Math.max(1, extent))
        scale.multiplyScalar(k)
        posScale = k
        fogScale.value = 1 / k
      } else if (kind === 'camera') {
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
      // Render state 0x0200: no fog. Thunder's flashes light the storm
      // through it rather than fading into it.
      if (sp.renderState & 0x200) fogScale.value = 0
      layers.push({
        mesh, kind, spawn: sp, tint, map, scale, slot, posScale,
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
    // Diagnostic (?census=1): the live layers, for probes.
    if (new URLSearchParams(window.location.search).has('census')) {
      (window as unknown as { __sky?: Layer[] }).__sky = l
    }
    return l
  }, [zone, state, radius])

  // One clock per generator, shared by its pieces and copies. Rebuilt with the
  // layers, so a weather change starts every generator over, as zoning does.
  const emitters = useMemo(() => {
    const m = new Map<GeneratorSpawn, Emitter>()
    for (const l of layers) {
      if (m.has(l.spawn)) continue
      const slots = l.kind === 'camera' ? slotCount(l.spawn) : 1
      m.set(l.spawn, {
        slots, next: -1, emitted: 0, births: new Array(slots).fill(NaN),
        offsets: Array.from({ length: slots }, () => new THREE.Vector3()),
      })
    }
    if (new URLSearchParams(window.location.search).has('census')) {
      (window as unknown as { __skyEmitters?: Map<GeneratorSpawn, Emitter> }).__skyEmitters = m
    }
    return m
  }, [layers])

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
    spinE: new THREE.Euler(0, 0, 0, 'ZYX'), at: new THREE.Vector3(),
  }), [])

  useFrame(({ camera, clock }) => {
    const minutes = (timeOfDayRef.current ?? 12) * 60
    const day = (((minutes % 1440) + 1440) % 1440) / 1440
    const frames = clock.getElapsedTime() * EFFECT_FPS
    for (const [sp, em] of emitters) {
      if (sp.life <= 0) continue
      if (em.next < 0) em.next = frames
      // Catch up at most one round of slots, after a stall or a hidden tab.
      if (frames - em.next > em.slots * sp.emission.every) em.next = frames
      while (em.next <= frames) {
        const s = em.emitted++ % em.slots
        em.births[s] = em.next
        spreadOffset(sp.spread, em.offsets[s])
        em.next += sp.emission.every + Math.random() * sp.emission.variance
      }
    }
    for (const l of layers) {
      const sp = l.spawn
      const em = emitters.get(sp)!
      // A particle with a life shows only while it lives.
      let progress = 0
      if (sp.life > 0) {
        const age = frames - em.births[l.slot]
        l.mesh.visible = age >= 0 && age < sp.life
        if (!l.mesh.visible) continue
        progress = age / sp.life
      }
      const t = sp.todCurves
      const channel = (curve: number[] | undefined, byte: number) =>
        decode(curve ? 2 * sampleKeyFrames(curve, day) : byte / 128)
      l.tint.set(
        channel(t.r, sp.tint[0]), channel(t.g, sp.tint[1]), channel(t.b, sp.tint[2]),
        // Alpha: a particle-life curve (0x2D, as for the surf) replaces the
        // tint alpha when present — Lufaise's wind streaks start at 0 and
        // pulse on one — then the time-of-day curve multiplies it.
        (sp.life > 0 && sp.curves.alpha
          ? (sampleKeyFrames(sp.curves.alpha, progress) * 255) / 128
          : sp.tint[3] / 128) * (t.alpha ? sampleKeyFrames(t.alpha, day) : 1),
      )
      if (l.map && (sp.uvScroll[0] || sp.uvScroll[1])) {
        l.map.offset.set((sp.uvScroll[0] * frames) % 1, (sp.uvScroll[1] * frames) % 1)
      }

      if (l.kind === 'camera') {
        // camera · flip(DAT → world) · base · rotation (+ spin) · scale
        tmp.spinE.set(
          l.rotation.x + l.spin[0] * frames, l.rotation.y + l.spin[1] * frames, l.rotation.z + l.spin[2] * frames, 'ZYX')
        tmp.q.setFromEuler(tmp.spinE)
        tmp.at.copy(l.base)
        if (sp.spread) tmp.at.add(em.offsets[l.slot]).multiplyScalar(l.posScale)
        if (sp.billboard & 1) {
          // Faces the camera (setup flag 0x1): Thunder's bolt. The DAT's
          // y-down stays, so the bolt is not drawn upside down.
          tmp.at.set(tmp.at.x, -tmp.at.y, -tmp.at.z).add(camera.position)
          l.mesh.matrix.compose(tmp.at, camera.quaternion, l.scale).multiply(FLIP)
        } else {
          tmp.m.compose(tmp.at, tmp.q, l.scale)
          l.mesh.matrix.makeTranslation(camera.position.x, camera.position.y, camera.position.z)
            .multiply(FLIP).multiply(tmp.m)
        }
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
