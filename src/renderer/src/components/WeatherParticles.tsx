import { useEffect, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { ParsedZone } from '../lib/ffxi-dat'
import type { GeneratorSpawn } from '../lib/ffxi-dat/types'
import { sampleKeyFrames } from '../lib/ffxi-dat/GeneratorParser'
import { applySpawnStages, setSubtractive } from '../lib/spawnStages'
import { GAMMA_BLEND_LAYER } from '../lib/GammaBlendPass'
import { spreadOffset } from './SkyLayers'
import { childEvents, pruneChildEvents } from '../lib/weatherEvents'

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
 *   Uleguerand Range, snow: `snow` links the shared snowflake `hit3` from
 *     ROM/0/0.DAT (see ZoneFile parseSystemEffects), a 16-frame flipbook; it
 *     is born 10 ahead of the view and drifts; 19 placed flurries emit only
 *     within 30 units (generator updater 0x0A)
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
/**
 * Strength of the rain mist: large billboarded puffs (Jugner's rai2, the
 * placed rai3-5 / ~1r*). Additive, 30 at a time in front of the camera, they
 * read too strong at the data's own alpha; Ryan chose 35%, then 20% after trying it, from 100/60/35/20%
 * renders of Jugner, 2026-10-09 — by eye, no retail reference. ?wxmist=<k>
 * overrides it.
 */
const MIST_STRENGTH = (() => {
  const v = typeof window !== 'undefined' ? Number(new URLSearchParams(window.location.search).get('wxmist')) : NaN
  return Number.isFinite(v) && v > 0 ? v : 0.2
})()
const isMist = (sp: GeneratorSpawn) => (sp.billboard & 1) !== 0 && Math.max(...sp.scale.map(Math.abs)) >= 2
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
  /** 1 once a particle's expiry has been handled (its children started). */
  expired: Uint8Array
  cursor: number
  /** A flipbook's frames, as uv offsets from frame 0; null for one frame. */
  frameOffsets: Float32Array | null
  uvOffset: THREE.InstancedBufferAttribute
}

/**
 * The weather's own folder, and its sub-folders' generators that run by
 * themselves (emission flag 0x10). Tavnazian Safehold keeps its thunder in
 * weat/thdr/wez4; the ones without the flag wait to be spawned by something
 * (Lufaise's scheduled strikes in kmi1, kmi2) and are left out.
 */
function weatherPick(state: string): (sp: GeneratorSpawn) => boolean {
  const top = new RegExp(`(^|/)weat/${state}$`)
  const sub = new RegExp(`(^|/)weat/${state}/`)
  return sp => top.test(sp.dir) || (sub.test(sp.dir) && sp.emission.autoRun)
}

/**
 * The zone's own ambient effects: every generator outside the weather that
 * runs by itself and stands in the world — lamp and torch flames, fires,
 * sparkles, smoke, waterfall spray. Hit sparks, footsteps (fser, fses) and
 * door effects never set the auto-run flag; they wait to be triggered.
 */
const zonePick = (sp: GeneratorSpawn) =>
  sp.emission.autoRun && sp.attach === 0 && !sp.followCamera && !/(^|\/)weat(\/|$)/.test(sp.dir)

function buildSystems(zone: ParsedZone, pick: (sp: GeneratorSpawn) => boolean, emitScale: number): System[] {
  const out: System[] = []
  for (const sp of zone.spawns ?? []) {
    if (sp.link !== 'sprite' || sp.life <= 0) continue
    if (!pick(sp)) continue
    const p = zone.prefabs[sp.prefabIndices[0]]
    if (!p) continue
    const tex = zone.textures[p.materialIndex]
    if (!tex) continue

    // A flipbook draws one frame at a time: frame 0's quad, moved across the
    // sheet per particle. The shared snowflake `hit3` is sixteen frames of a
    // 4x4 grid; drawn whole, all sixteen stacked on every flake.
    const frame0 = p.frames?.[0]
    const verts = frame0?.vertices ?? p.vertices
    const uvs = frame0?.uvs ?? p.uvs
    const colors = frame0?.colors ?? p.colors
    const n = verts.length / 3
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
    const col = new Float32Array(n * 4)
    for (let v = 0; v < n; v++) {
      for (let c = 0; c < 3; c++) col[v * 4 + c] = decode((colors[v * 4 + c] ?? 0.5) * 2)
      col[v * 4 + 3] = Math.min(1, (colors[v * 4 + 3] ?? 0.5) * 2)
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 4))
    geo.setIndex(frame0 ? Array.from({ length: n }, (_, i) => i) : p.indices)
    let frameOffsets: Float32Array | null = null
    if (p.frames && p.frames.length > 1) {
      const minUv = (u: number[]) => [Math.min(...u.filter((_, i) => i % 2 === 0)), Math.min(...u.filter((_, i) => i % 2 === 1))]
      const base = minUv(uvs)
      frameOffsets = new Float32Array(p.frames.length * 2)
      p.frames.forEach((f, i) => {
        const m = minUv(f.uvs)
        frameOffsets![i * 2] = m[0] - base[0]
        frameOffsets![i * 2 + 1] = m[1] - base[1]
      })
    }

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
    const subtract = nib === 1 || nib === 2
    const blending = nib === 8 ? THREE.AdditiveBlending : THREE.NormalBlending
    const mat = new THREE.MeshBasicMaterial({
      map, vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      fog: blending === THREE.NormalBlending && !subtract, blending,
    })
    if (subtract) setSubtractive(mat)
    // The tint's alpha is per particle (the life curve), so the stage takes
    // it from an instance attribute instead of the uniform.
    applySpawnStages(mat, [sp.tint[0], sp.tint[1], sp.tint[2], 128], false)
    const stages = mat.onBeforeCompile
    mat.onBeforeCompile = (shader, renderer) => {
      stages(shader, renderer)
      shader.vertexShader = shader.vertexShader
        .replace('void main() {', 'attribute float aAlpha;\nattribute vec2 aUvOffset;\nvarying float vAlpha;\nvoid main() {\n  vAlpha = aAlpha;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\n  vMapUv += aUvOffset;\n#endif')
      shader.fragmentShader = shader.fragmentShader
        .replace('void main() {', 'varying float vAlpha;\nvoid main() {')
        .replace('uSpawnTint.a * 2.0', 'uSpawnTint.a * vAlpha * 2.0')
    }
    mat.customProgramCacheKey = () => 'weather-particles'

    const perEmission = Math.max(1, Math.floor(Math.max(1, sp.emission.count) * emitScale))
    const capacity = Math.min(MAX_PARTICLES,
      perEmission * Math.ceil((sp.life + 1) / Math.max(1, sp.emission.every)))
    const alpha = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1)
    geo.setAttribute('aAlpha', alpha)
    const uvOffset = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2)
    geo.setAttribute('aUvOffset', uvOffset)
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
      expired: new Uint8Array(capacity),
      frameOffsets, uvOffset,
    })
  }
  return out
}

const rand = () => Math.random() * 2 - 1

/** xim's fallOff: 1 inside `near`, linear to 0 at `far`. */
const fallOff = (x: number, near: number, far: number) =>
  x < near ? 1 : x < far ? 1 - (x - near) / (far - near) : 0

/**
 * The full-screen quad the screen flash adds (xim ScreenFlasher: the colour,
 * doubled, SRC_ALPHA + ONE). Sits in front of the camera, drawn last.
 */
function buildFlashQuad(): { mesh: THREE.Mesh; tint: THREE.Vector4 } {
  const mat = new THREE.MeshBasicMaterial({
    transparent: true, depthTest: false, depthWrite: false, fog: false, blending: THREE.AdditiveBlending,
  })
  const tint = applySpawnStages(mat, [0, 0, 0, 64], false)
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat)
  mesh.frustumCulled = false
  mesh.matrixAutoUpdate = false
  mesh.layers.set(GAMMA_BLEND_LAYER)
  mesh.renderOrder = 2000
  mesh.visible = false
  mesh.onBeforeRender = (_r, _s, camera) => {
    const cam = camera as THREE.PerspectiveCamera
    const d = 1
    const h = d * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) * 1.05
    mesh.matrixWorld.copy(cam.matrixWorld).multiply(new THREE.Matrix4().makeScale(h * cam.aspect, h, 1).setPosition(0, 0, -d))
  }
  return { mesh, tint }
}

export function WeatherParticles({ zone, state }: { zone: ParsedZone; state: string }) {
  const systems = useMemo(() => {
    const s = buildSystems(zone, weatherPick(state), WEATHER_EMIT_SCALE)
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
  return <ParticleField systems={systems} weather />
}

/** The zone's own ambient sprite effects (Scene → Zone effects). */
export function ZoneEffects({ zone, range }: {
  zone: ParsedZone
  /**
   * Scene → Effect distance: the emit range and draw distance x this;
   * 0 = everywhere. The game's
   * own ranges (mostly 20-75) suit a camera behind the player, but orbiting
   * they lit only the point being circled. Everything at once cost ~15% of the
   * frame in the worst zone (Castle Oztroja [S], 543 systems: 56 -> 48 fps).
   */
  range: number
}) {
  const systems = useMemo(() => {
    const s = buildSystems(zone, zonePick, 1)
    console.log(`[ZFX] ${s.length} zone effect particle systems`)
    if (new URLSearchParams(window.location.search).has('census')) {
      (window as unknown as { __zfx?: System[] }).__zfx = s
    }
    return s
  }, [zone])
  return <ParticleField systems={systems} weather={false} range={range} />
}

/** Runs and draws a set of particle systems, and the screen flash they raise. */
function ParticleField({ systems, weather, range = 1 }: { systems: System[]; weather: boolean; range?: number }) {
  const flash = useMemo(() => buildFlashQuad(), [])
  useEffect(() => () => { flash.mesh.geometry.dispose(); (flash.mesh.material as THREE.Material).dispose() }, [flash])

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
    right: new THREE.Vector3(), camUp: new THREE.Vector3(), view: new THREE.Vector3(),
    flash: new THREE.Vector3(), cs: new THREE.Vector3(),
  }), [])
  const last = useMemo(() => ({ frames: -1 }), [systems])

  useFrame(({ camera, clock, controls }) => {
    const frames = clock.getElapsedTime() * EFFECT_FPS
    // Retail culls placed emitters by distance from the player. Orbiting, the
    // point being looked at stands in for the player; flying and walking, the
    // camera does.
    const target = (controls as unknown as { target?: THREE.Vector3 } | null)?.target
    const player = target ?? camera.position
    // Step size in effect frames, capped so a stall does not fling the rain.
    const dt = last.frames < 0 ? 0 : Math.min(10, frames - last.frames)
    last.frames = frames
    tmp.flash.set(0, 0, 0)
    pruneChildEvents(frames)

    for (const s of systems) {
      const sp = s.spawn
      // Where a particle lives (xim Particle.updateAssociatedPosition):
      //   follow       followCamera: rides the camera, in world axes
      //   bake         followCamera with render state 0x0080: born at the
      //                camera, then left in the world
      //   attached     render state 0x0400: born at a base offset turned with
      //                the view — right, up, ahead — then left in the world.
      //                Uleguerand's snow is born 10 ahead, so it always falls
      //                in front of you; in fixed world axes it fell behind
      //                whenever the camera faced the other way.
      const attached = (sp.renderState & 0x400) !== 0
      const follow = sp.followCamera && !attached && (sp.renderState & 0x80) === 0
      const bake = sp.followCamera && !attached && !follow
      const camRel = follow || bake || attached
      // Where particle i is now, in world space, for the children it starts.
      const post = (names: string[], dir: string, frame: number, i: number) => {
        const at = new THREE.Vector3(s.pos[i * 3], -s.pos[i * 3 + 1], -s.pos[i * 3 + 2])
        if (follow) at.add(camera.position)
        for (const name of names) childEvents.push({ name, dir, frame, at })
      }
      // Emit — for a placed generator with an emit range, only while the
      // camera (standing in for the player) is within it.
      if (s.next < 0) s.next = frames
      if (frames - s.next > sp.emission.every * 4) s.next = frames
      const reach = sp.emitRange * range
      const culled = !camRel && reach > 0 &&
        tmp.p.set(sp.position[0], -sp.position[1], -sp.position[2]).distanceTo(player) > reach
      if (culled) s.next = frames + sp.emission.every
      while (s.next <= frames) {
        for (let k = 0; k < s.perEmission; k++) {
          const i = s.cursor
          s.cursor = (s.cursor + 1) % s.capacity
          spreadOffset(sp.spread, tmp.off)
          if (attached) {
            // World point: camera + base turned with the view + spread, then
            // stored in DAT axes like every other particle (x, -y, -z).
            // Turned with the heading only: up is the world's, ahead is level.
            // With the camera's own tilt, an overview looking down put "10 up,
            // 10 ahead" in the middle of the picture, and Jugner's rain mist
            // (rai2: 30 additive puffs) whited out the view (2026-10-09).
            camera.getWorldDirection(tmp.view)
            tmp.view.y = 0
            // Straight down: the top of the screen is the heading.
            if (tmp.view.lengthSq() < 1e-6) tmp.view.set(0, 1, 0).applyQuaternion(camera.quaternion).setY(0)
            tmp.view.normalize()
            tmp.camUp.set(0, 1, 0)
            tmp.right.crossVectors(tmp.view, tmp.camUp).normalize()
            tmp.p.copy(camera.position)
              .addScaledVector(tmp.right, sp.position[0])
              .addScaledVector(tmp.camUp, -sp.position[1])
              .addScaledVector(tmp.view, sp.position[2])
            s.pos[i * 3] = tmp.p.x + tmp.off.x
            s.pos[i * 3 + 1] = -tmp.p.y + tmp.off.y
            s.pos[i * 3 + 2] = -tmp.p.z + tmp.off.z
          } else {
            s.pos[i * 3] = sp.position[0] + tmp.off.x
            s.pos[i * 3 + 1] = sp.position[1] + tmp.off.y
            s.pos[i * 3 + 2] = sp.position[2] + tmp.off.z
            if (bake) {
              s.pos[i * 3] += camera.position.x
              s.pos[i * 3 + 1] -= camera.position.y
              s.pos[i * 3 + 2] -= camera.position.z
            }
          }
          for (let c = 0; c < 3; c++) {
            s.vel[i * 3 + c] = sp.velocity[c] + sp.velocityVariance[c] * rand()
            s.scl[i * 3 + c] = sp.scale[c] + sp.scaleVariance[c] * Math.random()
            s.rot[i * 3 + c] = sp.rotation[c] + sp.rotationVariance[c] * rand()
          }
          // Spread births across the frame they share, so a batch is not a sheet.
          s.born[i] = s.next - Math.random()
          s.expired[i] = 0
          if (sp.children.birth.length) post(sp.children.birth, sp.dir, s.born[i], i)
        }
        s.next += sp.emission.every + Math.random() * sp.emission.variance
      }

      // Step and draw.
      let drawn = 0
      for (let i = 0; i < s.capacity; i++) {
        const age = frames - s.born[i]
        if (age >= sp.life && !s.expired[i]) {
          s.expired[i] = 1
          if (sp.children.expire.length) post(sp.children.expire, sp.dir, s.born[i] + sp.life, i)
        }
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
        if (follow) tmp.p.add(camera.position)
        // Section-3 0x2E draw distance: fades out, then is not drawn.
        const dd = sp.drawDistance
        // Effect distance stretches it with the emit range: nearly every zone
        // effect fades out 20-50 units from the camera, about its emit range,
        // so stretching the range alone lit nothing new (Ryan, 2026-10-10).
        const ddk = !dd || range === 0 ? 1 : fallOff(tmp.p.distanceTo(camera.position), dd.near * range, dd.far * range)
        if (ddk <= 0) continue
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
        const sf = sp.screenFlash
        if (sf) {
          // xim ScreenFlashApplier: distance falloff, then how far off the
          // centre of view on its zoomed, squared measure.
          let k = fallOff(tmp.p.distanceTo(camera.position), sf.near, sf.far)
          tmp.cs.copy(tmp.p).applyMatrix4(camera.matrixWorldInverse)
          if (k > 0 && tmp.cs.z < 0) {
            const zoom = ((camera as THREE.PerspectiveCamera).fov * 10) / tmp.cs.z
            k *= fallOff((zoom * tmp.cs.x) ** 2 + (zoom * tmp.cs.y) ** 2, sf.nearAngle, sf.farAngle)
            // Colour from the life curves (white at 0x80, fading through a
            // cold blue), on the byte/255 scale, doubled. Its alpha is 0 in
            // every shipped flash and has no curve, so it is not applied —
            // taken literally the flash would never show.
            const t = age / sp.life
            const ch = (curve: number[] | undefined, byte: number) => (curve ? sampleKeyFrames(curve, t) : byte / 255) * 2 * k
            tmp.flash.x += ch(sp.curves.r, sp.tint[0])
            tmp.flash.y += ch(sp.curves.g, sp.tint[1])
            tmp.flash.z += ch(sp.curves.b, sp.tint[2])
          }
        }
        s.alpha.setX(drawn, a * ddk * (weather && isMist(sp) ? MIST_STRENGTH : 1))
        if (s.frameOffsets) {
          // xim SpriteSheetFrameUpdater: frame floor((n + 1) x progress),
          // held on the last; without the updater, frame 0.
          const nf = s.frameOffsets.length / 2
          const f = sp.flipbook ? Math.min(nf - 1, Math.floor((nf + 1) * (age / sp.life))) : 0
          s.uvOffset.setXY(drawn, s.frameOffsets[f * 2], s.frameOffsets[f * 2 + 1])
        }
        drawn++
      }
      s.mesh.count = drawn
      // Nothing alive: skip the draw call (hundreds of idle lamps in a castle).
      s.mesh.visible = drawn > 0
      s.mesh.instanceMatrix.needsUpdate = true
      s.alpha.needsUpdate = true
      if (s.frameOffsets) s.uvOffset.needsUpdate = true
    }
    // The flash, added in gamma like the game, at most a white screen.
    const fl = Math.max(tmp.flash.x, tmp.flash.y, tmp.flash.z)
    flash.mesh.visible = fl > 0.002
    if (flash.mesh.visible) {
      flash.tint.set(decode(Math.min(1, tmp.flash.x)), decode(Math.min(1, tmp.flash.y)), decode(Math.min(1, tmp.flash.z)), 0.5)
    }
  })

  return (
    <group>
      {systems.map((s, i) => <primitive key={i} object={s.mesh} />)}
      <primitive object={flash.mesh} />
    </group>
  )
}
