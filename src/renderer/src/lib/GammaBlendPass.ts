import * as THREE from 'three'
import { Pass } from 'postprocessing'

/**
 * The layer generator-placed meshes live on, so the main render pass skips
 * them and GammaBlendPass can draw them on their own.
 */
export const GAMMA_BLEND_LAYER = 5

/**
 * Shared by every generator material: 1 while GammaBlendPass is drawing, when
 * the target holds gamma-encoded values and the shader must write them too.
 * Drawn straight to the canvas, three already encodes the output itself.
 */
export const gammaOutUniform = { value: 0 }

/** The sRGB curve, both ways; exact inverses, so a round trip is lossless. */
export const SRGB_GLSL = /* glsl */ `
  vec3 gbEncode(vec3 c) {
    c = max(c, vec3(0.0));
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
  }
  vec3 gbDecode(vec3 c) {
    c = max(c, vec3(0.0));
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
  }
`

/** GLSL for a generator material's last line, encoding when the pass asks. */
export const GAMMA_OUT_GLSL = {
  pars: /* glsl */ `uniform float uGammaOut;\n${SRGB_GLSL}`,
  main: /* glsl */ `if (uGammaOut > 0.5) gl_FragColor.rgb = gbEncode(gl_FragColor.rgb);`,
}

function fullscreen(fn: 'gbEncode' | 'gbDecode'): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { tSrc: { value: null } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D tSrc;
      varying vec2 vUv;
      ${SRGB_GLSL}
      void main() {
        vec4 c = texture2D(tSrc, vUv);
        gl_FragColor = vec4(${fn}(c.rgb), c.a);
      }
    `,
    depthTest: false,
    depthWrite: false,
  })
}

/**
 * Draws generator-placed meshes (water, foam) blended on gamma-encoded values,
 * the way FFXI's Direct3D 8 renderer does.
 *
 * Found at West Ronfaure's pond, 2026-09-27. The post-processing chain renders
 * into a linear HalfFloat buffer, so translucent layers blend in linear light.
 * FFXI blends the 0-255 values on screen. The pond is five pale veils over a
 * near-black bed, and linear blending drew it far too light: 66-92 where the
 * game shows 65. With post-processing off three blends in gamma already (it
 * encodes before writing to the canvas), and the pond measured 56-76. Ryan
 * judged Gustaberg's sea and surf better that way too.
 *
 * Runs straight after the RenderPass. The frame is encoded to gamma in place,
 * leaving the depth buffer intact so terrain still hides water behind it; the
 * generator layer is drawn over it with its shaders writing gamma values; the
 * result is decoded back to linear for the effects that follow.
 */
export class GammaBlendPass extends Pass {
  private readonly target: THREE.WebGLRenderTarget
  private readonly encode = fullscreen('gbEncode')
  private readonly decode = fullscreen('gbDecode')
  private readonly copy = new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false, toneMapped: false })
  private readonly quad: THREE.Mesh
  private readonly quadScene = new THREE.Scene()
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

  constructor(private readonly worldScene: THREE.Scene, private readonly worldCamera: THREE.Camera) {
    super('GammaBlendPass')
    this.needsSwap = true
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false })
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.encode)
    this.quad.frustumCulled = false
    this.quadScene.add(this.quad)
  }

  private blit(renderer: THREE.WebGLRenderer, material: THREE.Material, to: THREE.WebGLRenderTarget | null) {
    this.quad.material = material
    renderer.setRenderTarget(to)
    renderer.render(this.quadScene, this.quadCamera)
  }

  override render(
    renderer: THREE.WebGLRenderer,
    inputBuffer: THREE.WebGLRenderTarget,
    outputBuffer: THREE.WebGLRenderTarget,
  ): void {
    const autoClear = renderer.autoClear
    const shadowAuto = renderer.shadowMap.autoUpdate
    const mask = this.worldCamera.layers.mask
    const background = this.worldScene.background
    renderer.autoClear = false

    // 1-2. Encode the frame to gamma, then write it back over itself. The copy
    // back leaves the input's depth buffer untouched.
    this.encode.uniforms.tSrc.value = inputBuffer.texture
    this.blit(renderer, this.encode, this.target)
    this.copy.map = this.target.texture
    this.blit(renderer, this.copy, inputBuffer)

    // 3. The generator layer alone, writing gamma values, blended by the GPU
    // on gamma values.
    this.worldCamera.layers.set(GAMMA_BLEND_LAYER)
    this.worldScene.background = null
    renderer.shadowMap.autoUpdate = false
    gammaOutUniform.value = 1
    renderer.setRenderTarget(inputBuffer)
    renderer.render(this.worldScene, this.worldCamera)
    gammaOutUniform.value = 0
    renderer.shadowMap.autoUpdate = shadowAuto
    this.worldScene.background = background
    this.worldCamera.layers.mask = mask

    // 4. Back to linear for the rest of the chain.
    this.decode.uniforms.tSrc.value = inputBuffer.texture
    this.blit(renderer, this.decode, this.renderToScreen ? null : outputBuffer)
    renderer.autoClear = autoClear
  }

  override setSize(width: number, height: number): void {
    this.target.setSize(width, height)
  }

  override dispose(): void {
    this.target.dispose()
    this.encode.dispose()
    this.decode.dispose()
    this.copy.dispose()
    this.quad.geometry.dispose()
    super.dispose()
  }
}
