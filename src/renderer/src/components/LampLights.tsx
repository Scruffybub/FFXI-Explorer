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

interface Lamp { pos: THREE.Vector3; color: THREE.Color; strength: number; range: number }

export function LampLights({ zone, brightness = 1, count = 12 }: { zone: ParsedZone; brightness?: number; count?: number }) {
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
  const pool = useMemo(() => Array.from({ length: Math.max(1, count) }, () => {
    const l = new THREE.PointLight(0xffffff, 0, 1, 2)
    l.castShadow = false
    return l
  }), [count])
  const tick = useRef(0)
  const order = useMemo(() => lamps.map((_, i) => i), [lamps])
  const dist = useMemo(() => new Float32Array(lamps.length), [lamps])

  useFrame(({ camera, controls }) => {
    if (tick.current++ % 6 !== 0) return
    const target = (controls as unknown as { target?: THREE.Vector3 } | null)?.target
    const player = target ?? camera.position
    for (let i = 0; i < lamps.length; i++) dist[i] = lamps[i].pos.distanceTo(player)
    order.sort((a, b) => dist[a] - dist[b])
    for (let k = 0; k < pool.length; k++) {
      const light = pool[k]
      const i = order[k]
      if (i === undefined || dist[i] > REACH) { light.intensity = 0; continue }
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
