import { useEffect, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { ParsedZone } from '../lib/ffxi-dat'
import type { GeneratorSpawn } from '../lib/ffxi-dat/types'
import { sampleKeyFrames } from '../lib/ffxi-dat/GeneratorParser'
import { applySpawnStages } from '../lib/spawnStages'
import { GAMMA_BLEND_LAYER } from '../lib/GammaBlendPass'
import { spreadOffset } from './SkyLayers'

/**
 * The weather's sprite particles: rain, and the splashes and ripples that go
 * with it. Each is a generator under <zone>/weat/<state>/ that links a 0x21
 * sprite quad (link 'sprite') and emits on its own clock.
 *
 *   Jugner Forest, rain:
 *     ~1ra   the rain — 299 streaks every 20 frames, born in a 12-unit ball
 *            30 above the camera, falling at 0.3 a frame plus 0.005 a frame
 *            of gravity, for 60 frames; it rides with the camera
 *     ~1h0.. ripples on the ponds, fixed in the world, growing as they fade
 *     rai2.. mist puffs, billboarded
 *
 * Retail thins everything under weat/ to 0.3 of the authored count (kuluu
 * particle_sim.rs, from CYyGenerator::Idle), so the rain is ~89 streaks an
 * emission, ~270 at once.
 *
 * Orientation: a camera-billboard flag (0x1) faces the camera. The rain sets
 * no billboard bit but is batched; kuluu found retail's batched sprite path
 * untranscribable and billboards it, since a rain sheet fixed to a world axis
 * vanishes edge-on. Here it turns about the vertical to face the camera, which
 * keeps the streaks upright. Everything else keeps its authored rotation.
 *
 * Unlit, as retail's particles are. Additive unless the blend byte says
 * otherwise (no 0x1E byte means additive, kuluu particle_gen.rs).
 */

const EFFECT_FPS = 60
/** Retail's weather emission thinning; see above. */
const WEATHER_EMIT_SCALE = 0.3
const MAX_PARTICLES = 2000
const FLIP = new THREE.Matrix4().makeRotationX(Math.PI)

const decode = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))

interface System {
  spawn: GeneratorSpawn
  mesh: THREE.InstancedMesh
  alpha: THREE.InstancedBufferAttribute
  map: THREE.Texture | null
  perEmission: number
  capacity: number
  next: number
  // Particle state, DAT space (camera-relative for camera followers).
  pos: Float32Array
  vel: Float32Array
  scl: Float32Array
  rot: Float32Array
  born: Float32Array
  cursor: number
}

function buildSystems(zone: ParsedZone, state: string): System[] {
  const inState = new RegExp(`(^|/)weat/${state}$`)
  const out: System[] = []
  for (const sp of zone.spawns ?? []) {
    if (sp.link !== 'sprite' || !inState.test(sp.dir) || sp.life <= 0) continue
    const p = zone.prefabs[sp.prefabIndices[0]]
    if (!p) continue
    const tex = zone.textures[p.materialIndex]
    if (!tex) continue

    const n = p.vertices.length / 3
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(p.vertices, 3))
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(p.uvs, 2))
    const col = new Float32Array(n * 4)
    for (let v = 0; v < n; v++) {
      for (let c = 0; c < 3; c++) col[v * 4 + c] = decode((p.colors[v * 4 + c] ?? 0.5) * 2)
      col[v * 4 + 3] = Math.min(1, (p.colors[v * 4 + 3] ?? 0.5) * 2)
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 4))
    geo.setIndex(p.indices)

    const map = new THREE.DataTexture(new Uint8Array(tex.rgba), tex.width, tex.height, THREE.RGBAFormat)
    map.magFilter = THREE.LinearFilter
    // No mipmaps: the rain sheet is a few hairline streaks, and averaging them
    // down for a distant quad left nothing to see.
    map.minFilter = THREE.LinearFilter
    map.generateMipmaps = false
    map.flipY = false
    map.colorSpace = THREE.SRGBColorSpace
    map.needsUpdate = true

    const nib = sp.blend >= 0 ? sp.blend & 0x0f : 8
    const blending = nib === 8 ? THREE.AdditiveBlending
      : nib === 1 || nib === 2 ? THREE.SubtractiveBlending
      : THREE.NormalBlending
    const mat = new THREE.MeshBasicMaterial({
      map, vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      fog: blending === THREE.NormalBlending, blending,
    })
    // The tint's alpha is per particle (the life curve), so the stage takes
    // it from an instance attribute instead of the uniform.
    applySpawnStages(mat, [sp.tint[0], sp.tint[1], sp.tint[2], 128], false)
    const stages = mat.onBeforeCompile
    mat.onBeforeCompile = (shader, renderer) => {
      stages(shader, renderer)
      shader.vertexShader = shader.vertexShader
        .replace('void main() {', 'attribute float aAlpha;\nvarying float vAlpha;\nvoid main() {\n  vAlpha = aAlpha;')
      shader.fragmentShader = shader.fragmentShader
        .replace('void main() {', 'varying float vAlpha;\nvoid main() {')
        .replace('uSpawnTint.a * 2.0', 'uSpawnTint.a * vAlpha * 2.0')
    }
    mat.customProgramCacheKey = () => 'weather-particles'

    const perEmission = Math.max(1, Math.floor(Math.max(1, sp.emission.count) * WEATHER_EMIT_SCALE))
    const capacity = Math.min(MAX_PARTICLES,
      perEmission * Math.ceil((sp.life + 1) / Math.max(1, sp.emission.every)))
    const alpha = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1)
    geo.setAttribute('aAlpha', alpha)
    const mesh = new THREE.InstancedMesh(geo, mat, capacity)
    mesh.frustumCulled = false
    mesh.layers.set(GAMMA_BLEND_LAYER)
    mesh.renderOrder = 5
    mesh.count = 0

    out.push({
      spawn: sp, mesh, alpha, map, perEmission, capacity, next: -1, cursor: 0,
      pos: new Float32Array(capacity * 3), vel: new Float32Array(capacity * 3),
      scl: new Float32Array(capacity * 3), rot: new Float32Array(capacity * 3),
      born: new Float32Array(capacity).fill(-Infinity),
    })
  }
  return out
}

const rand = () => Math.random() * 2 - 1

export function WeatherParticles({ zone, state }: { zone: ParsedZone; state: string }) {
  const systems = useMemo(() => {
    const s = buildSystems(zone, state)
    if (s.length) {
      console.log(`[WXP] ${s.length} weather particle systems for ${state}: ` +
        s.map(x => `${x.spawn.generator}(${x.perEmission}/${x.spawn.emission.every}f, ${x.capacity} max)`).join(' '))
    }
    // Diagnostic (?census=1): the live systems, for probes.
    if (new URLSearchParams(window.location.search).has('census')) {
      (window as unknown as { __wxp?: System[] }).__wxp = s
    }
    return s
  }, [zone, state])

  useEffect(() => () => {
    for (const s of systems) {
      s.mesh.geometry.dispose()
      ;(s.mesh.material as THREE.Material).dispose()
      s.map?.dispose()
      s.mesh.dispose()
    }
  }, [systems])

  const tmp = useMemo(() => ({
    off: new THREE.Vector3(), p: new THREE.Vector3(), q: new THREE.Quaternion(), e: new THREE.Euler(0, 0, 0, 'ZYX'),
    s: new THREE.Vector3(), m: new THREE.Matrix4(), yaw: new THREE.Quaternion(), up: new THREE.Vector3(0, 1, 0), zero: new THREE.Vector3(),
  }), [])
  const last = useMemo(() => ({ frames: -1 }), [systems])

  useFrame(({ camera, clock }) => {
    const frames = clock.getElapsedTime() * EFFECT_FPS
    // Step size in effect frames, capped so a stall does not fling the rain.
    const dt = last.frames < 0 ? 0 : Math.min(10, frames - last.frames)
    last.frames = frames

    for (const s of systems) {
      const sp = s.spawn
      // Rides the camera: followCamera, or a camera-relative base (render
      // state 0x0400, the mist puffs). Kept in world axes, as kuluu found.
      const camRel = sp.followCamera || (sp.renderState & 0x400) !== 0
      const bake = camRel && (sp.renderState & 0x80) !== 0
      // Emit.
      if (s.next < 0) s.next = frames
      if (frames - s.next > sp.emission.every * 4) s.next = frames
      while (s.next <= frames) {
        for (let k = 0; k < s.perEmission; k++) {
          const i = s.cursor
          s.cursor = (s.cursor + 1) % s.capacity
          spreadOffset(sp.spread, tmp.off)
          s.pos[i * 3] = sp.position[0] + tmp.off.x
          s.pos[i * 3 + 1] = sp.position[1] + tmp.off.y
          s.pos[i * 3 + 2] = sp.position[2] + tmp.off.z
          if (bake) {
            // Born at the camera, then left there (render state 0x0080).
            s.pos[i * 3] += camera.position.x
            s.pos[i * 3 + 1] -= camera.position.y
            s.pos[i * 3 + 2] -= camera.position.z
          }
          for (let c = 0; c < 3; c++) {
            s.vel[i * 3 + c] = sp.velocity[c] + sp.velocityVariance[c] * rand()
            s.scl[i * 3 + c] = sp.scale[c] + sp.scaleVariance[c] * Math.random()
            s.rot[i * 3 + c] = sp.rotation[c] + sp.rotationVariance[c] * rand()
          }
          // Spread births across the frame they share, so a batch is not a sheet.
          s.born[i] = s.next - Math.random()
        }
        s.next += sp.emission.every + Math.random() * sp.emission.variance
      }

      // Step and draw.
      let drawn = 0
      for (let i = 0; i < s.capacity; i++) {
        const age = frames - s.born[i]
        if (!(age >= 0 && age < sp.life)) continue
        if (sp.moves) {
          for (let c = 0; c < 3; c++) {
            s.vel[i * 3 + c] += sp.accel[c] * dt
            s.pos[i * 3 + c] += s.vel[i * 3 + c] * dt
          }
        }
        for (let c = 0; c < 3; c++) s.scl[i * 3 + c] += sp.scaleVelocity[c] * dt

        const a = sp.curves.alpha
          ? (sampleKeyFrames(sp.curves.alpha, age / sp.life) * 255) / 128
          : sp.tint[3] / 128
        // DAT → world: x, -y, -z; camera followers ride the camera.
        tmp.p.set(s.pos[i * 3], -s.pos[i * 3 + 1], -s.pos[i * 3 + 2])
        if (camRel && !bake) tmp.p.add(camera.position)
        tmp.s.set(s.scl[i * 3], s.scl[i * 3 + 1], s.scl[i * 3 + 2])
        if (sp.billboard & 1) {
          tmp.m.compose(tmp.p, camera.quaternion, tmp.s).multiply(FLIP)
        } else if (sp.emission.batched && camRel) {
          // A curtain: upright, turned about the vertical to face the camera.
          tmp.yaw.setFromAxisAngle(tmp.up, Math.atan2(camera.position.x - tmp.p.x, camera.position.z - tmp.p.z))
          tmp.m.compose(tmp.p, tmp.yaw, tmp.s).multiply(FLIP)
        } else {
          tmp.e.set(s.rot[i * 3], s.rot[i * 3 + 1], s.rot[i * 3 + 2], 'ZYX')
          tmp.q.setFromEuler(tmp.e)
          // FLIP · R · S in DAT terms, placed at the world point.
          tmp.m.compose(tmp.zero, tmp.q, tmp.s).premultiply(FLIP).setPosition(tmp.p)
        }
        s.mesh.setMatrixAt(drawn, tmp.m)
        s.alpha.setX(drawn, a)
        drawn++
      }
      s.mesh.count = drawn
      s.mesh.instanceMatrix.needsUpdate = true
      s.alpha.needsUpdate = true
    }
  })

  return (
    <group>
      {systems.map((s, i) => <primitive key={i} object={s.mesh} />)}
    </group>
  )
}
