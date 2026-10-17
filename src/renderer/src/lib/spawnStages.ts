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
 * sun, stars) carry their own time-of-day colour instead, and a generator
 * without render-state bit 0x0001 is unlit in the game too (xim
 * ParticleInitializers.kt lightingEnabled; D3D passes the colour through when
 * lighting is off).
 *
 * FFXI_LIGHT_VERTEX negates the normal to undo the flip ZoneViewer gives every
 * prefab it does not take for water. Prefabs it does (`rawNormals`) keep the
 * DAT's normals and must not be negated again: they faced down, missed the sun
 * and kept only the ambient, about a third of their light. Foret de
 * Hennetiel's magenta rivers drew near-black indigo (Ryan's in-game
 * screenshot, 2026-10-11).
 */
/**
 * D3D's subtractive blend (blend byte low nibble 1 or 2): screen − source x
 * alpha, screen alpha kept. three's SubtractiveBlending needs premultiplied
 * alpha; without it three sets no blend function at all, so the mesh drew with
 * whatever the previous draw had left — Riverne's map3 and Lufaise's wind
 * darkening changed with draw order, 2026-10-04.
 */
export function setSubtractive(mat: THREE.Material): void {
  mat.blending = THREE.CustomBlending
  mat.blendEquation = THREE.ReverseSubtractEquation
  mat.blendSrc = THREE.SrcAlphaFactor
  mat.blendDst = THREE.OneFactor
  mat.blendEquationAlpha = THREE.AddEquation
  mat.blendSrcAlpha = THREE.ZeroFactor
  mat.blendDstAlpha = THREE.OneFactor
}

/**
 * The texel an untextured generator mesh (blank texture name) stands on.
 * Judged, not decoded: these meshes carry soft-edged vertex alpha and zero
 * UVs, so their whole look is texel x colour x tint.
 *
 *   glows   lamp light pools and window glows (additive): grey 0x80, the
 *           game's identity. Bastok Markets' arcade lamp (vertex 0.69, tint
 *           205,138,68) then comes out amber (1, 0.75, 0.37) in the game's
 *           maths; on white it saturated to a pale yellow.
 *   water   the water's colour layers (Bastok's rvcol, allcol, funmiz, Port
 *           Bastok's col1, Windurst's wt*; the caller decides, by water folder
 *           or a flat sheet — WeatherParticles colourSheet): black. White
 *           laid milk over every canal; black darkens them into the near-black
 *           water the game shows (2026-10-10).
 *
 * Before this they took the zone's most-used texture, which scrolled one
 * texel at a time across their zero UVs: Bastok's canals and fountain flashed
 * through its colours (Ryan, 2026-10-10). Applied to the material colour,
 * ahead of the stages. ?untex=grey|white|black forces one.
 */
export function untexturedTexel(mat: THREE.MeshBasicMaterial, glow: boolean): void {
  const force = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('untex') : null
  const v = force === 'white' ? 1 : force === 'black' ? 0 : force === 'grey' ? 0.5 : glow ? 0.5 : 0
  mat.color.setRGB(v, v, v, THREE.SRGBColorSpace)
}

export function applySpawnStages(mat: THREE.MeshBasicMaterial, tint: number[], lit = true, rawNormals = false): THREE.Vector4 {
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
      .replace('#include <fog_vertex>', `#include <fog_vertex>\n${rawNormals ? FFXI_LIGHT_VERTEX.split('-normalize(').join('normalize(') : FFXI_LIGHT_VERTEX}`)
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
  mat.customProgramCacheKey = () => (lit ? (rawNormals ? 'genspawn-stages-raw' : 'genspawn-stages') : 'genspawn-stages-unlit')
  return uTint
}
