import * as THREE from 'three'
import type { ZoneEnvLight, ZoneEnvRecord } from './ffxi-dat/types'

/**
 * FFXI's zone lighting, driven by the zone's environment records (0x2F).
 *
 * FFXI lights terrain with Direct3D 8 fixed-function vertex lighting: the vertex
 * colour is the material, the zone's ambient plus a sun and a moon are the
 * lights, and the result — saturated — feeds a MODULATE2X texture stage:
 *
 *   lit = saturate(vertexColour × (ambient + N·Lsun × sun + N·Lmoon × moon))
 *   out = saturate(2 × texel × lit)                          (all in gamma)
 *
 * Generator meshes (water) take the same light into their first stage. The
 * colour conversions below are xim's (EnvironmentSection.kt ambientToColor,
 * diffuseToColor), and the stage chain kuluu-ffxi's (zone_ffxi.wgsl); both GPL
 * and read as references only.
 */

/** Shared by every zone and generator material; set once a frame. */
export const ffxiLight = {
  uFfxiAmb: { value: new THREE.Vector3(0.5, 0.5, 0.5) },
  uFfxiSun: { value: new THREE.Vector3() },
  uFfxiSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uFfxiMoon: { value: new THREE.Vector3() },
  uFfxiMoonDir: { value: new THREE.Vector3(0, -1, 0) },
  /** 1 while Zone weather drives the lighting; generator shaders check it. */
  uFfxiLightOn: { value: 0 },
}

/**
 * How far Zone weather's fog start has been moved out from the camera (to the
 * orbit target; see ZoneWeatherAnimator). Sky layers subtract it, since their
 * fade stands for retail's distances, not the viewer's camera.
 */
export const zoneFogShift = { value: 0 }

/** Uniform declarations for either stage. */
export const FFXI_LIGHT_PARS = /* glsl */ `
  uniform vec3 uFfxiAmb;
  uniform vec3 uFfxiSun;
  uniform vec3 uFfxiSunDir;
  uniform vec3 uFfxiMoon;
  uniform vec3 uFfxiMoonDir;
  uniform float uFfxiLightOn;
  varying vec3 vFfxiL;
`

/**
 * Vertex-stage irradiance, like the fixed-function pipeline: per vertex, from
 * the world-space normal. Zone geometry sits under a group rotated by π about
 * X, which modelMatrix carries, so this normal is already world space.
 *
 * Negated: ZoneViewer flips every non-water normal when it builds the geometry
 * (the DAT's point up; the stored ones point down), and the double-sided
 * three.js materials hid that by flipping back-facing normals themselves.
 * Unflipped, the sun and moon lit nothing and midnight went black, 2026-09-28.
 */
export const FFXI_LIGHT_VERTEX = /* glsl */ `
  #ifdef USE_INSTANCING
    vec3 ffN = -normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  #else
    vec3 ffN = -normalize(mat3(modelMatrix) * normal);
  #endif
  vFfxiL = uFfxiAmb
    + max(dot(ffN, uFfxiSunDir), 0.0) * uFfxiSun
    + max(dot(ffN, uFfxiMoonDir), 0.0) * uFfxiMoon;
`

const BIAS = [1.4, 1.36, 1.45]
const BIAS_BELOW = 0xcc / 0xff

/** Ambient as the game uses it: bias × byte / 510, capped at 0.5 (the stage doubles it). */
function ambient(c: [number, number, number]): number[] {
  const bias = c.every(v => v < BIAS_BELOW) ? BIAS : [1, 1, 1]
  return c.map((v, i) => Math.min(0.5, (bias[i] * v) / 2))
}

/** Sun or moon: byte / 255 × the record's multiplier, biased when every channel is dim. */
function diffuse(c: [number, number, number], mul: number): number[] {
  const d = c.map(v => v * mul)
  if (d.every(v => v < BIAS_BELOW)) return d.map((v, i) => Math.min(1, Math.max(0, v * BIAS[i])))
  return d
}

export interface ZoneEnvSample {
  ambient: number[]
  sun: number[]
  moon: number[]
  fogColor: number[]                 // sRGB 0..1
  fogStart: number
  fogEnd: number
}

function convert(l: ZoneEnvLight): ZoneEnvSample {
  return {
    ambient: ambient(l.ambient),
    sun: diffuse(l.sun, l.diffuse),
    moon: diffuse(l.moon, l.diffuse),
    fogColor: [...l.fog],
    fogStart: l.fogStart,
    fogEnd: l.fogEnd,
  }
}

/**
 * Terrain light and fog for a time of day: each record converted, then blended
 * between the two either side of the hour, wrapping midnight — as xim's
 * EnvironmentManager interpolates converted lighting rather than raw bytes.
 */
export function sampleTerrainLight(records: ZoneEnvRecord[], minutes: number): ZoneEnvSample | null {
  if (records.length === 0) return null
  const sorted = [...records].sort((a, b) => a.minutes - b.minutes)
  const m = ((minutes % 1440) + 1440) % 1440
  let hi = sorted.findIndex(r => r.minutes > m)
  if (hi < 0) hi = 0
  const lo = (hi - 1 + sorted.length) % sorted.length
  const a = convert(sorted[lo].terrain), b = convert(sorted[hi].terrain)
  const span = ((sorted[hi].minutes - sorted[lo].minutes) + 1440) % 1440 || 1440
  const t = sorted.length === 1 ? 0 : (((m - sorted[lo].minutes) + 1440) % 1440) / span
  const mix = (x: number[], y: number[]) => x.map((v, i) => v + (y[i] - v) * t)
  const num = (x: number, y: number) => x + (y - x) * t
  return {
    ambient: mix(a.ambient, b.ambient),
    sun: mix(a.sun, b.sun),
    moon: mix(a.moon, b.moon),
    fogColor: mix(a.fogColor, b.fogColor),
    fogStart: num(a.fogStart, b.fogStart),
    fogEnd: num(a.fogEnd, b.fogEnd),
  }
}

/**
 * Where the sun is, as a world-space direction toward it. The game turns it at
 * a quarter circle per six hours: (sin a, cos a, 0) in its Y-down space with
 * a = seconds × (π/2) / 6 h (xim getDirectionOfSunDiffuseLight) — overhead at
 * noon, on the horizon at 06:00 and 18:00, straight down at midnight. The moon
 * is opposite. Converted to this viewer's Y-up world: (x, −y, z → −z).
 */
export function sunDirection(minutes: number, out: THREE.Vector3): THREE.Vector3 {
  const a = (minutes * Math.PI) / 720
  return out.set(Math.sin(a), -Math.cos(a), 0)
}
