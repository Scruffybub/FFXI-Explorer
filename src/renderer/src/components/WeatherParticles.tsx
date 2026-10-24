import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { ParsedZone } from '../lib/ffxi-dat'
import type { GeneratorSpawn } from '../lib/ffxi-dat/types'
import { sampleKeyFrames } from '../lib/ffxi-dat/GeneratorParser'
import { applySpawnStages, setSubtractive, untexturedTexel } from '../lib/spawnStages'
import { GAMMA_BLEND_LAYER } from '../lib/GammaBlendPass'
import { HAZE_LAYER, HAZE_FRAGMENT, HAZE_PARS, hazeUniforms } from '../lib/HazePass'
import { spreadOffset } from './SkyLayers'
import { childEvents, pruneChildEvents } from '../lib/weatherEvents'
import { curveStart, rotationOrder } from '../lib/ximRules'
import { setTriggerGroups, triggerCommands, triggerLabel, triggerStore } from '../lib/triggeredEffects'

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
const isMist = (sp: GeneratorSpawn) =>
  sp.link === 'sprite' && (sp.billboard & 1) !== 0 && Math.max(...sp.scale.map(Math.abs)) >= 2
const FLIP = new THREE.Matrix4().makeRotationX(Math.PI)
/** Turns a headed particle (the footprint) from its authored facing to the walker's. */
const HEADING_OFFSET = Number(typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('headoff') : null) || Math.PI / 2

const decode = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))

/** One generator in a system: its own clock and its own run of particle slots. */
interface Emitter {
  spawn: GeneratorSpawn
  /** First slot, and how many it owns. */
  first: number
  capacity: number
  perEmission: number
  next: number
  cursor: number
}

/**
 * One draw: every generator that shares a model, a blend and a tint (Zone
 * effects batches them — Outer Ra'Kaznar's 797 mesh effects are 14 such sets),
 * or a single generator (the weather's).
 */
interface System {
  /** The first emitter's generator: what the batch shares. */
  spawn: GeneratorSpawn
  emitters: Emitter[]
  /** Each slot's emitter. */
  owner: Uint16Array
  mesh: THREE.InstancedMesh
  alpha: THREE.InstancedBufferAttribute
  maps: THREE.Texture[]
  capacity: number
  // Particle state, DAT space (camera-relative for camera followers).
  pos: Float32Array
  vel: Float32Array
  scl: Float32Array
  rot: Float32Array
  born: Float32Array
  /** A world heading a triggered post gave the particle (a footprint), NaN for none. */
  heading: Float32Array
  /** 1 once a particle's expiry has been handled (its children started). */
  expired: Uint8Array
  /** A flipbook's frames, as uv offsets from frame 0; null for one frame. */
  frameOffsets: Float32Array | null
  uvOffset: THREE.InstancedBufferAttribute
  /** A mesh whose texture scrolls (0x27/0x28, or u/v life curves). */
  scrolls: boolean
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
  sp.emission.autoRun && sp.attach === 0 && !sp.followCamera && !/(^|\/)weat(\/|$)/.test(sp.dir) &&
  !sp.dir.startsWith('<system>')

/**
 * The zone's mesh effects that Zone effects draws: lamp glows and light cones,
 * crystals, warp shimmer — every auto-run mesh outside the water. Generator
 * water hides its own copy of these while Zone effects is on.
 *
 * Water is a folder holding a scrolling sheet (seas, rivers, falls, lava), and
 * everything else in that folder: the sea's flat colour layer, foam, bubbles.
 * Those are layered under and over the scrolling sheets in Generator water's
 * own order; drawn here, Port Bastok's colour layer (esea/col1, x100, depth
 * write) covered the sea in brown (Ryan, 2026-10-10). Every water folder in the
 * four Bastok zones holds a scrolling sheet and no lamp folder does; the names
 * alone do not tell them apart (a census of all zones found water under
 * effe/kawa, seae, umi*, mizu, taki, lights under ligh, ramp, lamp, ligt).
 */
export function zoneMeshPicker(zone: ParsedZone): (sp: GeneratorSpawn) => boolean {
  const water = waterFolders(zone)
  return sp => sp.link === 'mesh' && zonePick(sp) && !water.has(sp.dir) &&
    !sp.prefabIndices.some(i => colourSheet(zone, i)) && !sceneryModel(sp)
}

/**
 * A model a generator places as scenery (a mode/ folder, not additive):
 * Beaucedine Glacier's entrance walls and windows (mode/entr, blend 0x44,
 * render state 0x1801 — lit, texture alpha ignored), Bastok's windmill,
 * Metalworks' water wheel. Drawn as particles they lost their texture alpha
 * and faded out (effects sweep, 2026-10-11); they stay with Generator water.
 * Additive ones in mode/ are lamps (East Ronfaure's mode/ligh) and stay here.
 */
function sceneryModel(sp: GeneratorSpawn): boolean {
  const additive = sp.blend < 0 || (sp.blend & 0x0f) === 8
  return /(^|\/)mode(\/|$)/.test(sp.dir) && !additive
}

/**
 * An untextured, flat, level mesh: a water colour layer. Windurst Waters' and
 * Northern San d'Oria's canal layers (wt00..wt12), Davoi's river (rvme),
 * Jugner's ponds (ike) — some in folders with no scrolling sheet at all, so
 * the folder rule missed them and Zone effects lit Windurst's canals in white
 * patches (2026-10-10). A census of all zones found every lamp glow among the
 * untextured meshes is a volume — a cone, a box, a shell round the lamp.
 * Flat: the vertical extent under 5% of the horizontal.
 */
export function colourSheet(zone: ParsedZone, prefabIdx: number): boolean {
  const p = zone.prefabs[prefabIdx]
  if (!p?.untextured || p.vertices.length < 9) return false
  let y0 = Infinity, y1 = -Infinity, x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity
  for (let k = 0; k < p.vertices.length; k += 3) {
    x0 = Math.min(x0, p.vertices[k]); x1 = Math.max(x1, p.vertices[k])
    y0 = Math.min(y0, p.vertices[k + 1]); y1 = Math.max(y1, p.vertices[k + 1])
    z0 = Math.min(z0, p.vertices[k + 2]); z1 = Math.max(z1, p.vertices[k + 2])
  }
  return y1 - y0 < 0.05 * Math.max(x1 - x0, z1 - z0)
}

/** The DAT folders that hold water: any with a mesh that scrolls its texture. */
export function waterFolders(zone: ParsedZone): Set<string> {
  return new Set((zone.spawns ?? [])
    .filter(sp => sp.link === 'mesh' && (sp.uvScroll[0] || sp.uvScroll[1]))
    .map(sp => sp.dir))
}

/** An effect's sheet. Clamped unless the mesh tiles or scrolls it. */
function sheetTexture(tex: ParsedZone['textures'][number] | undefined, wrap: boolean, mips: boolean): THREE.DataTexture | null {
  // An MMB with a blank texture name draws colour only.
  if (!tex) return null
  const map = new THREE.DataTexture(new Uint8Array(tex.rgba), tex.width, tex.height, THREE.RGBAFormat)
  map.magFilter = THREE.LinearFilter
  // No mipmaps for sprites: the rain sheet is a few hairline streaks, and
  // averaging them down for a distant quad left nothing to see.
  map.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter
  map.generateMipmaps = mips
  if (wrap) map.wrapS = map.wrapT = THREE.RepeatWrapping
  map.flipY = false
  map.colorSpace = THREE.SRGBColorSpace
  map.needsUpdate = true
  return map
}

function particleMaterial(sp: GeneratorSpawn, map: THREE.Texture | null, isMesh: boolean): THREE.MeshBasicMaterial {
  const nib = sp.blend >= 0 ? sp.blend & 0x0f : 8
  const subtract = nib === 1 || nib === 2
  const blending = nib === 8 ? THREE.AdditiveBlending : THREE.NormalBlending
  const mat = new THREE.MeshBasicMaterial({
    map, vertexColors: true, transparent: true, side: THREE.DoubleSide,
    // Setup flag 0x1000: the particle writes depth (xim depthMask). Mesh
    // effects only; the sprites keep the look already checked against the game.
    depthWrite: isMesh && (sp.billboard & 0x1000) !== 0,
    fog: blending === THREE.NormalBlending && !subtract, blending,
  })
  if (subtract) setSubtractive(mat)
  if (!map) untexturedTexel(mat, blending === THREE.AdditiveBlending)
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
  return mat
}

/**
 * A distortion generator (linked type 0x22) carries no mesh: Altepa's heat
 * dis1 throws one off near the camera every few frames, each about 12 x 7.
 * Each is drawn as a soft round patch, a unit across, full strength in the
 * middle and none at the rim (vertex alpha on the 0x80 = identity scale).
 */
function hazePatch(pos: number[], uv: number[], col: number[], idx: number[]): void {
  const N = 8, base = pos.length / 3
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
    const x = i / N - 0.5, y = j / N - 0.5
    const r = Math.min(1, Math.hypot(x, y) * 2)
    pos.push(x, y, 0)
    uv.push(i / N, j / N)
    col.push(1, 1, 1, (1 - r * r) * (1 - r * r))
  }
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const a = base + j * (N + 1) + i, b = a + 1, c = a + N + 1, d = c + 1
    idx.push(a, c, b, b, c, d)
  }
}

/**
 * Render state 0x10 (xim hazeEffect): the screen behind, bent — heat shimmer
 * over Lufaise's fires (fd01..03). The particle works out its alpha as usual;
 * HazePass turns it into a shift of the picture behind (HAZE_FRAGMENT). Drawn
 * plain it was an additive grey blob.
 */
function hazeMaterial(mat: THREE.MeshBasicMaterial): THREE.MeshBasicMaterial {
  mat.blending = THREE.NoBlending
  mat.depthWrite = false
  mat.fog = false
  const base = mat.onBeforeCompile
  mat.onBeforeCompile = (shader, renderer) => {
    base(shader, renderer)
    Object.assign(shader.uniforms, hazeUniforms)
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `${HAZE_PARS}\nvoid main() {`)
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>\n${HAZE_FRAGMENT}`)
  }
  mat.customProgramCacheKey = () => 'haze-particles'
  return mat
}

/**
 * `meshPick` also takes the generators that link a mesh (lamp glows, light
 * cones, fountain streams): every submesh of the MMB, one material each,
 * sharing the particles. A mesh with no life lives forever — the game emits
 * it once (xim: maxLifeSpan 0 is a singleton).
 *
 * `batch` draws generators that share a model, blend, flags and tint as one
 * system, each with its own clock — hundreds of draws down to tens.
 */
function buildSystems(
  zone: ParsedZone, pick: (sp: GeneratorSpawn) => boolean, emitScale: number,
  meshPick?: (sp: GeneratorSpawn) => boolean, batch = false,
  /** Triggered systems: room for this many bursts alive at once. */
  bursts = 0,
): System[] {
  const groups = new Map<string, GeneratorSpawn[]>()
  for (const sp of zone.spawns ?? []) {
    const isMesh = sp.link === 'mesh' && !!meshPick?.(sp)
    const isDistortion = sp.link === 'distortion' && sp.life > 0
    if (!isMesh && !isDistortion && (sp.link !== 'sprite' || sp.life <= 0)) continue
    if (!pick(sp)) continue
    // No alpha and no curve to raise it: never seen.
    if (isMesh && sp.tint[3] === 0 && !sp.curves.alpha) continue
    const key = batch
      ? [sp.link, sp.prefabIndices.join('+'), sp.blend, sp.billboard, sp.renderState, sp.followCamera,
          sp.emission.batched, sp.tint.slice(0, 3).join('.'),
          !!(sp.uvScroll[0] || sp.uvScroll[1] || sp.curves.u || sp.curves.v)].join('|')
      : String(groups.size)
    const g = groups.get(key)
    if (g) g.push(sp)
    else groups.set(key, [sp])
  }

  const out: System[] = []
  for (const group of groups.values()) {
    const sp = group[0]
    const isMesh = sp.link === 'mesh'
    const haze = sp.link === 'distortion' || (sp.renderState & 0x10) !== 0
    const pos: number[] = [], uv: number[] = [], col: number[] = [], idx: number[] = []
    const geo = new THREE.BufferGeometry()
    const maps: THREE.Texture[] = []
    const mats: THREE.MeshBasicMaterial[] = []
    let frameOffsets: Float32Array | null = null
    const scrolls = isMesh && !!(sp.uvScroll[0] || sp.uvScroll[1] || sp.curves.u || sp.curves.v)
    for (const pi of isMesh ? sp.prefabIndices : sp.prefabIndices.slice(0, 1)) {
      const p = zone.prefabs[pi]
      if (!p) continue
      // Haze needs only its strength, so a haze mesh may lack a texture (Altepa's ka01).
      const tex = isMesh && p.untextured ? undefined : zone.textures[p.materialIndex]
      if (!tex && !(isMesh && (p.untextured || haze))) continue

      // A flipbook draws one frame at a time: frame 0's quad, moved across the
      // sheet per particle. The shared snowflake `hit3` is sixteen frames of a
      // 4x4 grid; drawn whole, all sixteen stacked on every flake.
      const frame0 = p.frames?.[0]
      const verts = frame0?.vertices ?? p.vertices
      const uvs = frame0?.uvs ?? p.uvs
      const colors = frame0?.colors ?? p.colors
      const n = verts.length / 3
      const base = pos.length / 3
      pos.push(...verts)
      uv.push(...uvs)
      for (let v = 0; v < n; v++) {
        for (let c = 0; c < 3; c++) col.push(decode((colors[v * 4 + c] ?? 0.5) * 2))
        col.push(Math.min(1, (colors[v * 4 + 3] ?? 0.5) * 2))
      }
      const local = frame0 ? Array.from({ length: n }, (_, i) => i) : p.indices
      geo.addGroup(idx.length, local.length, mats.length)
      for (const i of local) idx.push(base + i)
      if (!isMesh && p.frames && p.frames.length > 1) {
        const minUv = (u: number[]) => [Math.min(...u.filter((_, i) => i % 2 === 0)), Math.min(...u.filter((_, i) => i % 2 === 1))]
        const b = minUv(uvs)
        frameOffsets = new Float32Array(p.frames.length * 2)
        p.frames.forEach((f, i) => {
          const m = minUv(f.uvs)
          frameOffsets![i * 2] = m[0] - b[0]
          frameOffsets![i * 2 + 1] = m[1] - b[1]
        })
      }
      const tiles = uvs.some(x => x < -0.001 || x > 1.001)
      const map = sheetTexture(tex, isMesh && (scrolls || tiles), isMesh)
      if (map) maps.push(map)
      mats.push(particleMaterial(sp, map, isMesh))
    }
    if (sp.link === 'distortion') {
      hazePatch(pos, uv, col, idx)
      mats.push(particleMaterial(sp, null, false))
    }
    if (!mats.length) continue
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 4))
    geo.setIndex(idx)
    if (mats.length === 1) geo.clearGroups()
    if (haze) mats.forEach(hazeMaterial)

    const emitters: Emitter[] = []
    let capacity = 0
    for (const g of group) {
      const perEmission = Math.max(1, Math.floor(Math.max(1, g.emission.count) * emitScale))
      const cap = bursts > 0 ? Math.min(MAX_PARTICLES, perEmission * bursts)
        : g.life <= 0 || g.emission.continuous ? perEmission : Math.min(MAX_PARTICLES,
          perEmission * Math.ceil((g.life + 1) / Math.max(1, g.emission.every)))
      emitters.push({ spawn: g, first: capacity, capacity: cap, perEmission, next: -1, cursor: 0 })
      capacity += cap
    }
    const owner = new Uint16Array(capacity)
    emitters.forEach((e, k) => owner.fill(k, e.first, e.first + e.capacity))
    const alpha = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1)
    geo.setAttribute('aAlpha', alpha)
    const uvOffset = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2)
    geo.setAttribute('aUvOffset', uvOffset)
    const mesh = new THREE.InstancedMesh(geo, mats.length === 1 ? mats[0] : mats, capacity)
    mesh.frustumCulled = false
    // Particles are placed by their instance matrices; the mesh stays at the origin.
    mesh.matrixAutoUpdate = false
    mesh.layers.set(haze ? HAZE_LAYER : GAMMA_BLEND_LAYER)
    mesh.renderOrder = 5
    mesh.count = 0

    out.push({
      spawn: sp, emitters, owner, mesh, alpha, maps, capacity,
      pos: new Float32Array(capacity * 3), vel: new Float32Array(capacity * 3),
      scl: new Float32Array(capacity * 3), rot: new Float32Array(capacity * 3),
      born: new Float32Array(capacity).fill(-Infinity),
      heading: new Float32Array(capacity).fill(NaN),
      expired: new Uint8Array(capacity),
      frameOffsets, uvOffset, scrolls,
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
    // Haze meshes too (Altepa's heat ka01): the sky leaves them to HazePass.
    const s = buildSystems(zone, weatherPick(state), WEATHER_EMIT_SCALE, sp => (sp.renderState & 0x10) !== 0)
    if (s.length) {
      console.log(`[WXP] ${s.length} weather particle systems for ${state}: ` +
        s.map(x => `${x.spawn.generator}(${x.emitters[0].perEmission}/${x.spawn.emission.every}f, ${x.capacity} max)`).join(' '))
    }
    // Diagnostic (?census=1): the live systems, for probes.
    if (new URLSearchParams(window.location.search).has('census')) {
      (window as unknown as { __wxp?: System[] }).__wxp = s
    }
    return s
  }, [zone, state])
  return <ParticleField systems={systems} weather />
}

/** The zone's own ambient effects, sprites and meshes (Scene → Zone effects). */
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
    // Diagnostics: ?nomeshfx=1 the sprites alone, as before the mesh effects;
    // ?onlymeshfx=1 the meshes alone; ?nobatch=1 one draw per generator.
    const q = new URLSearchParams(window.location.search)
    const pick = q.has('onlymeshfx') ? (sp: GeneratorSpawn) => sp.link === 'mesh' && zonePick(sp) : zonePick
    const s = buildSystems(zone, pick, 1, q.has('nomeshfx') ? undefined : zoneMeshPicker(zone), !q.has('nobatch'))
    console.log(`[ZFX] ${s.length} zone effect particle systems`)
    if (new URLSearchParams(window.location.search).has('census')) {
      (window as unknown as { __zfx?: System[] }).__zfx = s
    }
    return s
  }, [zone])
  return <ParticleField systems={systems} weather={false} range={range} />
}

/**
 * Effects the game starts on an event rather than on a clock.
 *
 * Footsteps (fses/fefs walking, fser/fefr running), fired by Avatar: each post
 * to `childEvents` naming one of these generators fires one emission there,
 * and its birth children with it.
 *
 * Placed ones (`placedTrigger`: doors, La Theine's rainbow, ...): listed in
 * Scene → Triggered effects (lib/triggeredEffects). Play runs a folder's root
 * generators — those no other generator in it starts — on their own clock, as
 * Zone effects runs the auto-run ones, until Stop; their children start as
 * their parents say (the rainbow's nij1 hands over to nij2 when it ends).
 */
export function TriggeredEffects({ zone, range }: { zone: ParsedZone; range: number }) {
  const systems = useMemo(() => {
    const pick = (sp: GeneratorSpawn) => (TRIGGERED.test(sp.dir) || placedTrigger(sp)) && !sp.emission.autoRun
    const s = buildSystems(zone, pick, 1, pick, false, 6)
    if (new URLSearchParams(window.location.search).has('census')) {
      (window as unknown as { __tfx?: System[] }).__tfx = s
    }
    return s
  }, [zone])
  // Starters that draw nothing themselves (no alpha, no curve; buildSystems
  // leaves them out) still start their children: sand's 0300 starts the puff
  // a301, shallow water's 0800 the splash a802 and ring a804. Posts naming
  // one are passed on to its birth children, a frame later.
  const relays = useMemo(() => {
    const drawn = new Set(systems.flatMap(s => s.emitters.map(e => e.spawn.dir + '|' + e.spawn.generator)))
    const m = new Map<string, string[]>()
    for (const sp of zone.spawns ?? []) {
      const key = sp.dir + '|' + sp.generator
      if ((TRIGGERED.test(sp.dir) || placedTrigger(sp)) && !drawn.has(key) && sp.children.birth.length) m.set(key, sp.children.birth)
    }
    return m
  }, [zone, systems])
  // The placed folders, for the panel, and each one's root generators.
  const { roots, groups } = useMemo(() => {
    const placed = (zone.spawns ?? []).filter(sp => placedTrigger(sp) && !sp.emission.autoRun)
    const started = new Set(placed.flatMap(sp => [...sp.children.birth, ...sp.children.expire].map(k => sp.dir + '|' + k)))
    const out = new Set<string>()
    const groups = new Map<string, number[][]>()
    const sizes = new Map<string, number>()
    for (const sp of placed) {
      const key = sp.dir + '|' + sp.generator
      if (started.has(key)) continue
      out.add(key)
      const list = groups.get(sp.dir) ?? []
      // Placed in the zone, not offsets from whatever starts it: Whitegate's
      // effe/funs (0,-10,0) and La Theine's effe/rott (0,-2,0) play where an
      // event puts them, and at the origin they sat inside a building.
      if (Math.hypot(...sp.position) > PLACED_MIN) list.push([sp.position[0], -sp.position[1], -sp.position[2]])
      groups.set(sp.dir, list)
      // Reach: the model's furthest vertex times the generator's scale.
      const v = zone.prefabs[sp.prefabIndices[0]]?.vertices ?? []
      let r = 0
      for (let i = 0; i < v.length; i++) r = Math.max(r, Math.abs(v[i]))
      sizes.set(sp.dir, Math.max(sizes.get(sp.dir) ?? 0, r * Math.max(...sp.scale.map(Math.abs))))
    }
    const list = [...groups].filter(([, pts]) => pts.length).map(([dir, pts]) => ({
      dir, label: triggerLabel(dir), size: sizes.get(dir) ?? 0,
      at: [0, 1, 2].map(k => pts.reduce((a, p) => a + p[k], 0) / pts.length) as [number, number, number],
    })).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
    return { roots: out, groups: list }
  }, [zone])
  useEffect(() => {
    setTriggerGroups(groups)
    return () => setTriggerGroups([])
  }, [groups])
  const running = useSyncExternalStore(triggerStore.subscribe, () => triggerStore.get().running)
  useFrame(({ camera, controls, scene }) => {
    for (let k = childEvents.length - 1; k >= 0; k--) {
      const ev = childEvents[k]
      const kids = relays.get(ev.dir + '|' + ev.name)
      if (!kids) continue
      childEvents.splice(k, 1)
      for (const name of kids) childEvents.push({ name, dir: ev.dir, frame: ev.frame, at: ev.at.clone() })
    }
    // Go to: stand back by its size, a little above, looking at its middle
    // (a billboard reaches up from its point: the rainbow rises 220 units).
    // Eight directions round it, the first with a clear view: a fixed one put
    // the camera inside a wall in Whitegate.
    const g = triggerCommands.goTo
    if (g?.at) {
      triggerCommands.goTo = null
      const [x, y0, z] = g.at
      const y = y0 + g.size * 0.4
      const d = Math.max(14, g.size * 1.3)
      const lift = Math.max(6, g.size * 0.15)
      const target = new THREE.Vector3(x, y, z)
      const solid = scene.children.filter(o => o.type === 'Group')
      const ray = new THREE.Raycaster()
      let spot: THREE.Vector3 | null = null
      for (let k = 0; k < 8 && !spot; k++) {
        const a = Math.PI / 4 + (k * Math.PI) / 4
        const p = new THREE.Vector3(x + Math.cos(a) * d, y + lift, z + Math.sin(a) * d)
        // Both ways: walls are one-sided, and a ray leaving from inside a
        // room passes out through their backs unseen.
        const blocked = (from: THREE.Vector3, to: THREE.Vector3) => {
          const dir = to.clone().sub(from)
          ray.set(from, dir.clone().normalize())
          ray.far = dir.length()
          return ray.intersectObjects(solid, true).some(h => h.object.userData.prefabIdx !== undefined)
        }
        if (!blocked(target, p) && !blocked(p, target)) spot = p
      }
      // Walled in all round: look down on it from high above.
      camera.position.copy(spot ?? new THREE.Vector3(x + 0.01, y + Math.max(40, d * 2), z + 0.01))
      const orbit = controls as unknown as { target?: THREE.Vector3; update?: () => void } | null
      orbit?.target?.set(x, y, z)
      camera.lookAt(x, y, z)
      orbit?.update?.()
    }
  })
  return <ParticleField systems={systems} weather={false} range={range} triggered running={running} roots={roots} />
}

/**
 * A triggered effect placed in the zone: not auto-run, not footsteps, weather
 * (Lufaise's strikes have their own clock) or the shared footprint.
 */
/** How far from the zone origin a triggered effect must sit to count as placed. */
const PLACED_MIN = 15

export const placedTrigger = (sp: GeneratorSpawn) =>
  !/(^|\/)(fses|fser|weat)(\/|$)/.test(sp.dir) && !sp.dir.startsWith('<system>')
const TRIGGERED = /(^|\/)(fses\/fefs|fser\/fefr)$|^<system>\/fbib$/

/** The folder holding a zone's footstep effects, walking or running. */
export function footstepDir(zone: ParsedZone, running: boolean): string | null {
  const want = running ? /(^|\/)fser\/fefr$/ : /(^|\/)fses\/fefs$/
  return (zone.spawns ?? []).find(sp => want.test(sp.dir))?.dir ?? null
}

/** Runs and draws a set of particle systems, and the screen flash they raise. */
function ParticleField({ systems, weather, range = 1, triggered = false, running, roots }: {
  systems: System[]; weather: boolean; range?: number
  /** Emit only when a child event names the generator (TriggeredEffects). */
  triggered?: boolean
  /** Triggered folders playing now: their `roots` (dir|generator) run on their own clock. */
  running?: ReadonlySet<string>
  roots?: ReadonlySet<string>
}) {
  // Folders that were playing last frame: a folder that stops is cleared, and
  // one that starts begins from its first emission.
  const wasRunning = useRef(new Set<string>())
  const flash = useMemo(() => buildFlashQuad(), [])
  useEffect(() => () => { flash.mesh.geometry.dispose(); (flash.mesh.material as THREE.Material).dispose() }, [flash])

  useEffect(() => () => {
    for (const s of systems) {
      s.mesh.geometry.dispose()
      for (const m of [s.mesh.material].flat()) m.dispose()
      for (const m of s.maps) m.dispose()
      s.mesh.dispose()
    }
  }, [systems])

  const tmp = useMemo(() => ({
    off: new THREE.Vector3(), p: new THREE.Vector3(), q: new THREE.Quaternion(), e: new THREE.Euler(0, 0, 0, 'ZYX'),
    s: new THREE.Vector3(), m: new THREE.Matrix4(), rot: new THREE.Matrix4(), yaw: new THREE.Quaternion(), up: new THREE.Vector3(0, 1, 0), zero: new THREE.Vector3(),
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
    if (running) {
      for (const dir of wasRunning.current) {
        if (running.has(dir)) continue
        for (const s of systems) for (const e of s.emitters) {
          if (e.spawn.dir !== dir) continue
          for (let i = e.first; i < e.first + e.capacity; i++) { s.born[i] = -Infinity; s.expired[i] = 1 }
        }
      }
      for (const dir of running) {
        if (wasRunning.current.has(dir)) continue
        for (const s of systems) for (const e of s.emitters) if (e.spawn.dir === dir) e.next = -1
      }
      wasRunning.current = new Set(running)
    }

    for (const s of systems) {
      // What every emitter in the system shares (the batch key).
      const sp0 = s.spawn
      // Where a particle lives (xim Particle.updateAssociatedPosition):
      //   follow       followCamera: rides the camera, in world axes
      //   bake         followCamera with render state 0x0080: born at the
      //                camera, then left in the world
      //   attached     render state 0x0400: born at a base offset turned with
      //                the view — right, up, ahead — then left in the world.
      //                Uleguerand's snow is born 10 ahead, so it always falls
      //                in front of you; in fixed world axes it fell behind
      //                whenever the camera faced the other way.
      const attached = (sp0.renderState & 0x400) !== 0
      const follow = sp0.followCamera && !attached && (sp0.renderState & 0x80) === 0
      const bake = sp0.followCamera && !attached && !follow
      const camRel = follow || bake || attached
      // Where particle i is now, in world space, for the children it starts.
      const post = (names: string[], dir: string, frame: number, i: number) => {
        const at = new THREE.Vector3(s.pos[i * 3], -s.pos[i * 3 + 1], -s.pos[i * 3 + 2])
        if (follow) at.add(camera.position)
        for (const name of names) childEvents.push({ name, dir, frame, at })
      }
      // Emit — for a placed generator with an emit range, only while the
      // camera (standing in for the player) is within it.
      for (const e of s.emitters) {
        const sp = e.spawn
        // A playing folder's roots run on their clock below, like Zone effects.
        const playing = !!running?.has(sp.dir) && !!roots?.has(sp.dir + '|' + sp.generator)
        if (triggered && !playing) {
          // One emission per post naming this generator, where it was posted,
          // left in the world (a footstep stays where the foot fell).
          for (let k = childEvents.length - 1; k >= 0; k--) {
            const ev = childEvents[k]
            if (ev.name !== sp.generator || ev.dir !== sp.dir) continue
            childEvents.splice(k, 1)
            for (let n = 0; n < e.perEmission; n++) {
              const i = e.first + e.cursor
              e.cursor = (e.cursor + 1) % e.capacity
              spreadOffset(sp.spread, tmp.off)
              s.pos[i * 3] = ev.at.x + sp.position[0] + tmp.off.x
              s.pos[i * 3 + 1] = -ev.at.y + sp.position[1] + tmp.off.y
              s.pos[i * 3 + 2] = -ev.at.z + sp.position[2] + tmp.off.z
              for (let c = 0; c < 3; c++) {
                s.vel[i * 3 + c] = sp.velocity[c] + sp.velocityVariance[c] * rand()
                s.scl[i * 3 + c] = sp.scale[c] + sp.scaleVariance[c] * Math.random()
                s.rot[i * 3 + c] = sp.rotation[c] + sp.rotationVariance[c] * rand()
              }
              s.born[i] = ev.frame
              s.expired[i] = 0
              s.heading[i] = ev.yaw ?? NaN
            }
            for (const name of sp.children.birth) childEvents.push({ name, dir: sp.dir, frame: ev.frame, at: ev.at.clone() })
          }
          continue
        }
        // A singleton (no life) is born once and stays.
        const forever = sp.life <= 0
        if (e.next < 0) e.next = frames
        if (frames - e.next > sp.emission.every * 4) e.next = frames
        const reach = sp.emitRange * range
        const culled = !forever && !camRel && reach > 0 &&
          tmp.p.set(sp.position[0], -sp.position[1], -sp.position[2]).distanceTo(player) > reach
        if (culled) e.next = frames + sp.emission.every
        // Emission flag 0x04, continuous: one at a time, the next born when
        // the last expires. Provenance's crystals emit every frame and live
        // 6000; emitted freely, 714 giant crystals stacked into white blobs
        // (effects sweep, 2026-10-11). Read from the data, not from xim.
        if (sp.emission.continuous && e.next <= frames) {
          let alive = false
          for (let i = e.first; i < e.first + e.capacity && !alive; i++) {
            const age = frames - s.born[i]
            alive = age >= 0 && (forever || age < sp.life)
          }
          if (alive) e.next = frames + 1
        }
        while (e.next <= frames) {
          for (let k = 0; k < e.perEmission; k++) {
            const i = e.first + e.cursor
            e.cursor = (e.cursor + 1) % e.capacity
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
            s.born[i] = e.next - Math.random()
            s.expired[i] = 0
            if (sp.children.birth.length) post(sp.children.birth, sp.dir, s.born[i], i)
          }
          e.next = forever ? Infinity : e.next + sp.emission.every + Math.random() * sp.emission.variance
        }
      }

      // Step and draw.
      let drawn = 0
      for (let i = 0; i < s.capacity; i++) {
        const sp = s.emitters[s.owner[i]].spawn
        const forever = sp.life <= 0
        const life = forever ? Infinity : sp.life
        const age = frames - s.born[i]
        if (age >= life && !s.expired[i]) {
          s.expired[i] = 1
          if (sp.children.expire.length) post(sp.children.expire, sp.dir, s.born[i] + life, i)
        }
        if (!(age >= 0 && age < life)) continue
        if (sp.moves) {
          for (let c = 0; c < 3; c++) {
            s.vel[i * 3 + c] += sp.accel[c] * dt
            s.pos[i * 3 + c] += s.vel[i * 3 + c] * dt
          }
        }
        for (let c = 0; c < 3; c++) s.scl[i * 3 + c] += sp.scaleVelocity[c] * dt
        // 0x0B: turns per frame (Bastok Markets' windmill).
        for (let c = 0; c < 3; c++) s.rot[i * 3 + c] += sp.spin[c] * dt

        // The curve starts from the tint's own alpha (xim's rule;
        // lib/ximRules). Triggered effects keep it under ?ximrules=0 too:
        // the footprint's curve is 0 to 0 and would never show.
        const a = sp.curves.alpha
          ? (sampleKeyFrames(sp.curves.alpha, age / life, curveStart(sp.tint[3], triggered || undefined)) * 255) / 128
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
        } else if (sp.billboard & 0x4000) {
          // xim's XZ billboard: the authored mesh, turned about the vertical
          // to face the camera (Bastok Markets' fountain streams).
          tmp.yaw.setFromAxisAngle(tmp.up, Math.atan2(camera.position.x - tmp.p.x, camera.position.z - tmp.p.z))
          tmp.e.set(s.rot[i * 3], s.rot[i * 3 + 1], s.rot[i * 3 + 2], rotationOrder(sp.billboard))
          tmp.q.setFromEuler(tmp.e)
          tmp.m.compose(tmp.zero, tmp.q, tmp.s).premultiply(FLIP).premultiply(tmp.rot.makeRotationFromQuaternion(tmp.yaw)).setPosition(tmp.p)
        } else {
          // xim: setup flag 0x0200 rotates Z-Y-X, otherwise X-Y-Z
          // (lib/ximRules). The footprint (no flag) lies flat only in X-Y-Z;
          // Z-Y-X stood it on edge.
          const order = rotationOrder(sp.billboard, triggered || undefined)
          tmp.e.set(s.rot[i * 3], s.rot[i * 3 + 1], s.rot[i * 3 + 2], order)
          tmp.q.setFromEuler(tmp.e)
          // FLIP · R · S in DAT terms, placed at the world point — turned
          // about the vertical first when a post gave it a heading.
          tmp.m.compose(tmp.zero, tmp.q, tmp.s).premultiply(FLIP)
          if (!Number.isNaN(s.heading[i])) tmp.m.premultiply(tmp.rot.makeRotationY(s.heading[i] + HEADING_OFFSET))
          tmp.m.setPosition(tmp.p)
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
            const t = age / life
            const ch = (curve: number[] | undefined, byte: number) => (curve ? sampleKeyFrames(curve, t, curveStart(byte)) : byte / 255) * 2 * k
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
          const f = sp.flipbook ? Math.min(nf - 1, Math.floor((nf + 1) * (age / life))) : 0
          s.uvOffset.setXY(drawn, s.frameOffsets[f * 2], s.frameOffsets[f * 2 + 1])
        } else if (s.scrolls) {
          // Scroll per frame, plus the u/v life curves (as SpawnAnimator).
          let ou = sp.uvScroll[0] * age
          let ov = sp.uvScroll[1] * age
          if (!forever && sp.curves.u) ou += sampleKeyFrames(sp.curves.u, age / life)
          if (!forever && sp.curves.v) ov += sampleKeyFrames(sp.curves.v, age / life)
          s.uvOffset.setXY(drawn, ou % 1, ov % 1)
        }
        drawn++
      }
      s.mesh.count = drawn
      // Nothing alive: skip the draw call (hundreds of idle lamps in a castle).
      s.mesh.visible = drawn > 0
      // Upload only the live particles: a batch's buffers hold its whole
      // capacity, and sending all of it every frame — idle lamps included —
      // was about a tenth of Outer Ra'Kaznar's frame with everything on.
      if (drawn > 0) {
        const upload = (attr: THREE.BufferAttribute) => {
          attr.clearUpdateRanges()
          attr.addUpdateRange(0, drawn * attr.itemSize)
          attr.needsUpdate = true
        }
        upload(s.mesh.instanceMatrix)
        upload(s.alpha)
        if (s.frameOffsets || s.scrolls) upload(s.uvOffset)
      }
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
