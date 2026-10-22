import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { ParsedZone } from '../lib/ffxi-dat'

/**
 * Dynamic lighting's lamps: real three.js point lights at the zone's own
 * light sources (generator link 0x47 — see lib/zoneLamps.ts), so lamp light
 * is per pixel, follows the material, and reaches models as well as terrain.
 * Original keeps the game's per-vertex lamp light instead; Dynamic skips it
 * so lamps are not counted twice.
 *
 * A fixed pool of lights (the Lamp lights setting), re-aimed at the nearest
 * lamps to the player (the orbit target when orbiting, else the camera) every
 * few frames: three compiles its lit shaders per light count, so the pool only
 * changes with the setting — spare lights sit at zero. Lamps fade out over the
 * last third of the reach.
 *
 * Lamp shadows (the viewer's own; the game's lamps cast none): the first
 * `shadows` lights of the pool cast them, and take the nearest lamps. A
 * shadow-casting light keeps its lamp while that lamp stays among the nearest,
 * and its cube shadow map is drawn only when it moves to another lamp — the
 * zone does not move, so a map drawn once stays right. Geometry closer than
 * SHADOW_NEAR to the light is left out, so a lamp's own housing does not
 * swallow its light.
 */

/** Lamps further than this from the player are left dark. */
const REACH = 160
/** The game's ranges (2-20) suit its per-vertex light; per pixel they read small. */
const RANGE_SCALE = 2.5

const PARAMS = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null
/**
 * Candela per unit of lamp colour at Lamp brightness 1. Chosen from renders of
 * Castle Zvahl Keep at night (Moonlit Night) at 10, 25 and 60. Diagnostic
 * ?lampint=<k> overrides it.
 */
const INTENSITY = Number(PARAMS?.get('lampint')) || 40
/** Lamp shadow maps: cube face size, and the radius around the light left out. */
const SHADOW_SIZE = 512
const SHADOW_NEAR = Number(PARAMS?.get('lampnear')) || 1.5

interface Lamp { pos: THREE.Vector3; color: THREE.Color; strength: number; range: number }

export function LampLights({ zone, brightness = 1, count = 12, shadows = 0 }: {
  zone: ParsedZone; brightness?: number; count?: number; shadows?: number
}) {
  const lamps = useMemo<Lamp[]>(() => (zone.spawns ?? [])
    .filter(s => s.link === 'light' && s.pointLight)
    .map(s => {
      // Colour = tint x 2 on the byte/255 scale; split into hue and strength.
      const c = [0, 1, 2].map(k => (s.tint[k] / 255) * 2)
      const strength = Math.max(...c, 1e-3)
      return {
        pos: new THREE.Vector3(s.position[0], -s.position[1], -s.position[2]),
        color: new THREE.Color(c[0] / strength, c[1] / strength, c[2] / strength),
        strength,
        range: s.pointLight!.range * RANGE_SCALE,
      }
    }), [zone])
  const casters = Math.min(shadows, count)
  const pool = useMemo(() => Array.from({ length: Math.max(1, count) }, (_, k) => {
    const l = new THREE.PointLight(0xffffff, 0, 1, 2)
    l.castShadow = k < casters
    if (l.castShadow) {
      l.shadow.mapSize.set(SHADOW_SIZE, SHADOW_SIZE)
      l.shadow.camera.near = SHADOW_NEAR
      l.shadow.bias = -0.005
      l.shadow.autoUpdate = false
    }
    return l
  }), [count, casters])
  /** The lamp each pool light shows, -1 for none. */
  const shown = useMemo(() => new Int32Array(pool.length).fill(-1), [pool])
  const tick = useRef(0)
  const order = useMemo(() => lamps.map((_, i) => i), [lamps])
  const dist = useMemo(() => new Float32Array(lamps.length), [lamps])

  useFrame(({ camera, controls }) => {
    if (tick.current++ % 6 !== 0) return
    const target = (controls as unknown as { target?: THREE.Vector3 } | null)?.target
    const player = target ?? camera.position
    for (let i = 0; i < lamps.length; i++) dist[i] = lamps[i].pos.distanceTo(player)
    order.sort((a, b) => dist[a] - dist[b])
    // The nearest `casters` lamps go to the shadow-casting lights, each
    // keeping its lamp while it stays among them; the rest fill the pool in order.
    const assign = new Int32Array(pool.length).fill(-1)
    const near = order.slice(0, casters).filter(i => dist[i] <= REACH)
    const free: number[] = []
    for (let k = 0; k < casters; k++) {
      const at = near.indexOf(shown[k])
      if (at >= 0) { assign[k] = shown[k]; near.splice(at, 1) } else free.push(k)
    }
    for (const k of free) assign[k] = near.shift() ?? -1
    for (let k = casters, n = casters; k < pool.length; k++, n++) assign[k] = order[n] ?? -1
    for (let k = 0; k < pool.length; k++) {
      const light = pool[k]
      const i = assign[k]
      if (k < casters && i !== shown[k] && i >= 0) light.shadow.needsUpdate = true
      shown[k] = i
      if (i < 0 || dist[i] > REACH) { light.intensity = 0; continue }
      const lamp = lamps[i]
      const fade = Math.min(1, (REACH - dist[i]) / (REACH / 3))
      light.position.copy(lamp.pos)
      light.color.copy(lamp.color)
      light.distance = lamp.range
      light.intensity = INTENSITY * lamp.strength * brightness * fade
    }
  })

  return <>{pool.map((l, i) => <primitive key={i} object={l} />)}</>
}
