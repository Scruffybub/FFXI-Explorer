import * as THREE from 'three'
import { GAMMA_OUT_GLSL, gammaOutUniform } from './GammaBlendPass'
import { ffxiLight, FFXI_LIGHT_PARS, FFXI_LIGHT_VERTEX } from './zoneLighting'

/**
 * FFXI's two texture stages for generator-drawn meshes, as a material patch.
 *
 *   stage 0  texture x vertex colour, MODULATE2X — the doubling is already in
 *            the vertex colour, which arrives on the 0x80 = identity scale
 *   stage 1  x tint: MODULATE2X on colour, MODULATE4X on alpha
 *
 * With the tint also on the 0x80 scale, alpha carries one more doubling than
 * colour. D3D saturates each stage, so the clamp sits between them — clamping
 * only at the end, or before the texel multiply, gives different answers.
 * From kuluu-ffxi particle_sim.rs (CMoD3m.cpp ZeroOneTSS; the MMB branch of
 * ZoneRenderer::DoD3mDraw uses the same stage ops). The first pass missed the
 * alpha doubling, which left the sea foam at 3-6% opacity where the table puts
 * it at 6-9%.
 *
 * The material itself is white and fully opaque; the tint arrives as a uniform
 * so the stage-0 clamp can happen before it is applied.
 *
 * `lit` false leaves Zone weather's terrain light out: the sky layers (clouds,
 * sun, stars) carry their own time-of-day colour instead.
 */
export function applySpawnStages(mat: THREE.MeshBasicMaterial, tint: number[], lit = true): THREE.Vector4 {
  const decode = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
  // Colour is gamma-authored; alpha is a weight and is not.
  const uTint = new THREE.Vector4(
    decode(tint[0] / 128), decode(tint[1] / 128), decode(tint[2] / 128), tint[3] / 128)
  mat.onBeforeCompile = shader => {
    shader.uniforms.uSpawnTint = { value: uTint }
    shader.uniforms.uGammaOut = gammaOutUniform
    Object.assign(shader.uniforms, ffxiLight)
    // Zone weather lights generator meshes like terrain: FFXI multiplies the
    // same irradiance into their first stage (kuluu zone_ffxi.wgsl generator
    // chain). In gamma that is × light; these colours are linear, so × light^2.2.
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', `${FFXI_LIGHT_PARS}\nvoid main() {`)
      .replace('#include <fog_vertex>', `#include <fog_vertex>\n${FFXI_LIGHT_VERTEX}`)
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `uniform vec4 uSpawnTint;\n${GAMMA_OUT_GLSL.pars}\n${FFXI_LIGHT_PARS}\nvoid main() {`)
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>\n${GAMMA_OUT_GLSL.main}`)
      .replace('#include <color_fragment>', [
        '#include <color_fragment>',
        ...(lit ? ['if (uFfxiLightOn > 0.5) diffuseColor.rgb *= pow(max(vFfxiL, vec3(0.0)), vec3(2.2));'] : []),
        'vec4 spawnStage0 = clamp(diffuseColor, 0.0, 1.0);',
        'diffuseColor = clamp(vec4(spawnStage0.rgb * uSpawnTint.rgb,',
        '  spawnStage0.a * uSpawnTint.a * 2.0), 0.0, 1.0);',
      ].join('\n'))
  }
  mat.customProgramCacheKey = () => (lit ? 'genspawn-stages' : 'genspawn-stages-unlit')
  return uTint
}
