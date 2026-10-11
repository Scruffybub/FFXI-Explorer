import * as THREE from 'three'
import { Pass } from 'postprocessing'

/**
 * Heat shimmer: FFXI's haze effects (render state 0x10, xim hazeEffect) draw
 * the screen behind them, bent. Fire shimmer, desert heat.
 *
 * xim's order, followed here (format and behaviour reference only; the bend
 * itself is this project's own): after the scene and the generator layer, the
 * frame is copied aside, then the haze meshes are drawn into the frame, each
 * pixel showing the copy a few pixels off. Drawn into the frame itself, they
 * keep its depth buffer, so a wall still hides the shimmer behind it.
 *
 * A haze material (WeatherParticles hazeMaterial) works out its strength the
 * way any effect works out its alpha — texture, vertex colour, tint, life
 * curve — and turns it into how far the copy is shifted. Strength 0 copies the
 * pixel exactly, so a haze mesh's soft edges vanish into the picture.
 */
export const HAZE_LAYER = 6

/** Shared by every haze material. */
export const hazeUniforms = {
  tHaze: { value: null as THREE.Texture | null },
  /** Scene -> Heat shimmer: pixels at full strength. */
  uHazePx: { value: 2 },
  uHazeRes: { value: new THREE.Vector2(1, 1) },
  uHazeTime: { value: 0 },
}

const PARAMS = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null
/**
 * Diagnostic ?hazepx=<n>: overrides Scene -> Heat shimmer (pixels at full
 * strength; 2 by default — Ryan's pick after 8 and 4, 2026-10-11).
 */
export const HAZE_PX_OVERRIDE = Number(PARAMS?.get('hazepx')) || null

/** GLSL for the end of a haze material's fragment shader. ?hazedebug=1 paints the strength red. */
export const HAZE_FRAGMENT = /* glsl */ `
  {
    float hazeK = clamp(gl_FragColor.a, 0.0, 1.0);
    vec2 hazeP = gl_FragCoord.xy;
    // Two slow waves across each other: rising heat bends sideways more
    // than up and down.
    vec2 hazeOff = vec2(
      sin(hazeP.y * 0.11 + uHazeTime * 6.0) + 0.5 * sin(hazeP.y * 0.031 - uHazeTime * 3.1),
      0.6 * cos(hazeP.x * 0.083 + uHazeTime * 4.3)
    ) * uHazePx * hazeK;
    // Colour and alpha both from the copy: the frame's alpha is not 1
    // everywhere (the sky), and writing 1 drew the haze meshes' outlines as
    // faint lighter rectangles.
    gl_FragColor = texture2D(tHaze, (hazeP + hazeOff) / uHazeRes);
    ${PARAMS?.has('hazedebug') ? 'gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(1.0, 0.0, 0.0), hazeK);' : ''}
  }
`
export const HAZE_PARS = /* glsl */ `
  uniform sampler2D tHaze;
  uniform vec2 uHazeRes;
  uniform float uHazeTime;
  uniform float uHazePx;
`

export class HazePass extends Pass {
  private readonly target: THREE.WebGLRenderTarget
  private readonly copy = new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false, toneMapped: false })
  private readonly quad: THREE.Mesh
  private readonly quadScene = new THREE.Scene()
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly clock = new THREE.Clock()

  constructor(private readonly worldScene: THREE.Scene, private readonly worldCamera: THREE.Camera) {
    super('HazePass')
    // Draws into the frame it is given and hands that on.
    this.needsSwap = false
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false })
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.copy)
    this.quad.frustumCulled = false
    this.quadScene.add(this.quad)
  }

  override render(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget): void {
    const autoClear = renderer.autoClear
    const shadowAuto = renderer.shadowMap.autoUpdate
    const mask = this.worldCamera.layers.mask
    const background = this.worldScene.background
    renderer.autoClear = false

    // 1. The frame, set aside.
    this.copy.map = inputBuffer.texture
    renderer.setRenderTarget(this.target)
    renderer.render(this.quadScene, this.quadCamera)

    // 2. The haze meshes, drawn into the frame from the copy.
    hazeUniforms.tHaze.value = this.target.texture
    hazeUniforms.uHazeRes.value.set(inputBuffer.width, inputBuffer.height)
    hazeUniforms.uHazeTime.value = this.clock.getElapsedTime()
    this.worldCamera.layers.set(HAZE_LAYER)
    this.worldScene.background = null
    renderer.shadowMap.autoUpdate = false
    renderer.setRenderTarget(inputBuffer)
    renderer.render(this.worldScene, this.worldCamera)
    renderer.shadowMap.autoUpdate = shadowAuto
    this.worldScene.background = background
    this.worldCamera.layers.mask = mask

    // Last in the chain (it never is today): show the frame.
    if (this.renderToScreen) {
      this.copy.map = inputBuffer.texture
      renderer.setRenderTarget(null)
      renderer.render(this.quadScene, this.quadCamera)
    }
    renderer.autoClear = autoClear
  }

  override setSize(width: number, height: number): void {
    this.target.setSize(width, height)
  }

  override dispose(): void {
    this.target.dispose()
    this.copy.dispose()
    this.quad.geometry.dispose()
    super.dispose()
  }
}
