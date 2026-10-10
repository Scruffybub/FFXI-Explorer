import * as THREE from 'three'
import type { ParsedZone } from './ffxi-dat'

/**
 * The zone's lamp light: FFXI's point lights, which light the walls and
 * ground around lamps and torches.
 *
 * A point light is a generator linked to type 0x47 (GeneratorParser
 * `pointLight`: reach and quadratic fall-off; colour = its tint x 2). Every
 * placed object names up to four of them in the MZB (MzbParser `lights`), so
 * the game itself says which lights reach which mesh. Per vertex, as xim's
 * zone shader does it (format reference only):
 *
 *   light_i = clamp(N.L x colour / (quad x d^2), 0, 1), 0 beyond its range
 *
 * added to the terrain light before the vertex colour and the texture.
 *
 * The lights live in a float texture, two texels each: (position, range) and
 * (colour, quad). Each instance carries `aLamps`, four 1-based indices
 * (0 = none).
 */

export const zoneLamps = {
  uLampTex: { value: null as THREE.DataTexture | null },
  uLampOn: { value: 0 },
}

export const LAMP_VERTEX_PARS = /* glsl */ `
  attribute vec4 aLamps;
  uniform highp sampler2D uLampTex;
  uniform float uLampOn;
  varying vec3 vLampL;
`
export const LAMP_FRAGMENT_PARS = /* glsl */ `
  varying vec3 vLampL;
`

/**
 * World space, like FFXI_LIGHT_VERTEX: the zone group's flip is in
 * modelMatrix, and the outward normal is the negated attribute.
 */
export const LAMP_VERTEX = /* glsl */ `
  vLampL = vec3(0.0);
  if (uLampOn > 0.5) {
    #ifdef USE_INSTANCING
      vec3 lampW = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xyz;
      vec3 lampN = -normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
    #else
      vec3 lampW = (modelMatrix * vec4(position, 1.0)).xyz;
      vec3 lampN = -normalize(mat3(modelMatrix) * normal);
    #endif
    for (int k = 0; k < 4; k++) {
      int li = int(aLamps[k] + 0.5) - 1;
      if (li < 0) continue;
      vec4 pr = texelFetch(uLampTex, ivec2(li * 2, 0), 0);
      vec4 cq = texelFetch(uLampTex, ivec2(li * 2 + 1, 0), 0);
      vec3 toL = pr.xyz - lampW;
      float d = length(toL);
      if (d > pr.w || d < 1e-3) continue;
      float att = 1.0 / max(cq.w * d * d, 1e-3);
      float ndl = max(dot(lampN, toL / d), 0.0);
      vLampL += clamp(ndl * att * cq.rgb, 0.0, 1.0);
    }
  }
`

/** The light table texture, and each light generator name's indices in it. */
export function buildLampTexture(zone: ParsedZone): { tex: THREE.DataTexture | null; index: Map<string, number[]>; count: number } {
  const lights = (zone.spawns ?? []).filter(s => s.link === 'light' && s.pointLight)
  const index = new Map<string, number[]>()
  if (!lights.length) return { tex: null, index, count: 0 }
  const data = new Float32Array(lights.length * 2 * 4)
  lights.forEach((s, i) => {
    // DAT space -> the zone group's world: (x, -y, -z).
    data.set([s.position[0], -s.position[1], -s.position[2], s.pointLight!.range], i * 8)
    data.set([(s.tint[0] / 255) * 2, (s.tint[1] / 255) * 2, (s.tint[2] / 255) * 2, s.pointLight!.quad], i * 8 + 4)
    const list = index.get(s.generator) ?? []
    list.push(i)
    index.set(s.generator, list)
  })
  const tex = new THREE.DataTexture(data, lights.length * 2, 1, THREE.RGBAFormat, THREE.FloatType)
  tex.minFilter = tex.magFilter = THREE.NearestFilter
  tex.needsUpdate = true
  return { tex, index, count: lights.length }
}

/** An instance's lamps as the 1-based indices aLamps carries (four, 0 = none). */
export function lampSlots(names: string[] | undefined, index: Map<string, number[]>): [number, number, number, number] {
  const out: [number, number, number, number] = [0, 0, 0, 0]
  if (!names) return out
  let k = 0
  for (const n of names) for (const i of index.get(n) ?? []) {
    if (k < 4 && !out.includes(i + 1)) out[k++] = i + 1
  }
  return out
}
