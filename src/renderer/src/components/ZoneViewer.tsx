import { useMemo, useRef, useEffect, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import {
  EffectComposer, Bloom, SMAA, N8AO, Vignette, HueSaturation, BrightnessContrast,
  DepthOfField, Autofocus,
} from '@react-three/postprocessing'
import * as THREE from 'three'
import type { ParsedZone, ParsedDatFile } from '../lib/ffxi-dat'
import { buildModel, type BuiltModel } from '../lib/modelBuild'
import { invertRigidMatrix4, poseSkeleton, skinMeshes } from '../lib/skinning'
import { CollisionWorld } from '../lib/CollisionWorld'
import type {
  LightingSettings, PointLightSettings, PostSettings, SceneSettings, SurfaceInfo, ToneMappingMode,
} from '../lib/settings'

interface ZoneViewerProps {
  zoneData: ParsedZone
  lighting: LightingSettings
  post: PostSettings
  scene: SceneSettings
  pointLights: PointLightSettings
  selectedLightId?: number | null
  placingLight?: boolean
  onPlaceLight?: (position: [number, number, number]) => void
  inspecting?: boolean
  onInspectResult?: (info: SurfaceInfo) => void
  onFlySpeedChange?: (speed: number) => void
  /** Player character to walk around as, if one has been built. */
  character?: ParsedDatFile | null
  characterClip?: number | null
}

const TONE_MAPPING: Record<ToneMappingMode, THREE.ToneMapping> = {
  none: THREE.NoToneMapping,
  linear: THREE.LinearToneMapping,
  reinhard: THREE.ReinhardToneMapping,
  cineon: THREE.CineonToneMapping,
  aces: THREE.ACESFilmicToneMapping,
  agx: THREE.AgXToneMapping,
  neutral: THREE.NeutralToneMapping,
}

/** Returns sky colors, fog color, and exposure multiplier for a given hour (0-24) */
function getTimeOfDayParams(hour: number) {
  const h = ((hour % 24) + 24) % 24

  const keys = [
    { t: 0,  sky: [0.05, 0.05, 0.12], horizon: [0.08, 0.08, 0.15], zenith: [0.02, 0.02, 0.08], fog: '#1a1a2e', exposure: 0.25 },
    { t: 5,  sky: [0.08, 0.07, 0.18], horizon: [0.25, 0.15, 0.25], zenith: [0.04, 0.04, 0.12], fog: '#2a1a30', exposure: 0.4 },
    { t: 6,  sky: [0.35, 0.25, 0.35], horizon: [0.85, 0.45, 0.30], zenith: [0.15, 0.12, 0.30], fog: '#c8886a', exposure: 0.75 },
    { t: 7,  sky: [0.50, 0.55, 0.70], horizon: [0.90, 0.70, 0.50], zenith: [0.25, 0.30, 0.55], fog: '#d4a878', exposure: 0.95 },
    { t: 10, sky: [0.45, 0.58, 0.78], horizon: [0.72, 0.78, 0.85], zenith: [0.28, 0.38, 0.62], fog: '#b8c8d8', exposure: 1.1 },
    { t: 14, sky: [0.45, 0.58, 0.78], horizon: [0.72, 0.78, 0.85], zenith: [0.28, 0.38, 0.62], fog: '#b8c8d8', exposure: 1.1 },
    { t: 17, sky: [0.55, 0.45, 0.50], horizon: [0.90, 0.55, 0.30], zenith: [0.30, 0.25, 0.45], fog: '#d09060', exposure: 0.95 },
    { t: 18, sky: [0.40, 0.25, 0.40], horizon: [0.80, 0.35, 0.25], zenith: [0.18, 0.12, 0.32], fog: '#a06048', exposure: 0.6 },
    { t: 19, sky: [0.12, 0.10, 0.22], horizon: [0.30, 0.18, 0.25], zenith: [0.06, 0.05, 0.15], fog: '#2a1a30', exposure: 0.4 },
    { t: 21, sky: [0.05, 0.05, 0.12], horizon: [0.08, 0.08, 0.15], zenith: [0.02, 0.02, 0.08], fog: '#1a1a2e', exposure: 0.25 },
    { t: 24, sky: [0.05, 0.05, 0.12], horizon: [0.08, 0.08, 0.15], zenith: [0.02, 0.02, 0.08], fog: '#1a1a2e', exposure: 0.25 },
  ]

  let lo = keys[0], hi = keys[keys.length - 1]
  for (let i = 0; i < keys.length - 1; i++) {
    if (h >= keys[i].t && h <= keys[i + 1].t) { lo = keys[i]; hi = keys[i + 1]; break }
  }
  const span = hi.t - lo.t
  const f = span === 0 ? 0 : (h - lo.t) / span
  const lerp3 = (a: number[], b: number[]) => [
    a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f,
  ] as [number, number, number]

  const nightFactor = (() => {
    if (h >= 19 || h < 5) return 1
    if (h >= 5 && h < 7) return 1 - (h - 5) / 2
    if (h >= 17 && h < 19) return (h - 17) / 2
    return 0
  })()

  return {
    sky: lerp3(lo.sky, hi.sky),
    horizon: lerp3(lo.horizon, hi.horizon),
    zenith: lerp3(lo.zenith, hi.zenith),
    nightFactor,
    exposure: lo.exposure + (hi.exposure - lo.exposure) * f,
    fogColor: lo.fog === hi.fog ? lo.fog : (() => {
      const lc = new THREE.Color(lo.fog), hc = new THREE.Color(hi.fog)
      return '#' + lc.lerp(hc, f).getHexString()
    })(),
  }
}

interface ZoneUniforms {
  fogHeightBase: { value: number }
  fogHeightRange: { value: number }
  bakedInfluence: { value: number }
}

/**
 * Patches a zone material with:
 *  1. Height-based fog attenuation (thickest below fogHeightBase).
 *  2. Dark-transparent discard, so foliage sprite backgrounds vanish while
 *     low-alpha-but-coloured ground tiles survive.
 *  3. A blend factor on FFXI's baked vertex colours, so lit mode can dial them
 *     down instead of multiplying baked shadows on top of real ones.
 */
function patchZoneShader(
  material: THREE.Material,
  uniforms: ZoneUniforms,
  lit: boolean,
  variant: string,
  keepAlpha = false,
) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.fogHeightBase = uniforms.fogHeightBase
    shader.uniforms.fogHeightRange = uniforms.fogHeightRange
    shader.uniforms.bakedInfluence = uniforms.bakedInfluence

    shader.vertexShader = shader.vertexShader.replace(
      '#include <fog_pars_vertex>',
      `#include <fog_pars_vertex>
      varying float vWorldY;`
    )
    shader.vertexShader = shader.vertexShader.replace(
      '#include <fog_vertex>',
      `#include <fog_vertex>
      #ifdef USE_INSTANCING
        vec4 hfWorldPos = modelMatrix * instanceMatrix * vec4(position, 1.0);
      #else
        vec4 hfWorldPos = modelMatrix * vec4(position, 1.0);
      #endif
      vWorldY = hfWorldPos.y;`
    )
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <fog_pars_fragment>',
      `#include <fog_pars_fragment>
      varying float vWorldY;
      uniform float fogHeightBase;
      uniform float fogHeightRange;`
    )

    // Blend the baked vertex colour toward white so lit mode can reduce it.
    // color_fragment sits inside main(), so the uniform is declared up front
    // where it is unambiguously at global scope.
    shader.fragmentShader = `uniform float bakedInfluence;\n${shader.fragmentShader}`
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      // vColor is declared vec4 in this three.js version even without
      // USE_COLOR_ALPHA, so swizzle rather than assume a component count.
      //
      // A power curve rather than a linear blend toward white. Both reach the
      // same endpoints — influence 1 keeps the baked colour, 0 removes it — but
      // lerping crushes dark detail on the way: the pond bed's 0.07 lifts to
      // 0.675 at the default 0.35 and its depth shading disappears, whereas the
      // curve holds it at 0.394.
      // Note: vertex colours recur at exactly 128/255 and never exceed it,
      // which hints the encoding range may be 0..128 rather than 0..255. Scaling
      // by 2 was tried and reverted: it brightened lit surfaces enough to look
      // glossy, and a uniform multiply cannot change shadow contrast anyway,
      // since shadowed and lit vertices scale together.
      `#if defined( USE_COLOR_ALPHA )
        diffuseColor.rgb *= pow( max( vColor.rgb, vec3( 0.0 ) ), vec3( bakedInfluence ) );
      #elif defined( USE_COLOR )
        diffuseColor.rgb *= pow( max( vColor.rgb, vec3( 0.0 ) ), vec3( bakedInfluence ) );
      #endif`
    )

    // DXT3 alpha fix: boost alpha for any pixel that still has visible colour,
    // so only near-black transparent pixels get discarded. This works on
    // diffuseColor (the value alphaTest actually reads) rather than the
    // fragment output, which is not assigned yet at this point in the shader.
    // Both alpha overrides are skipped for meshes that blend via vertex alpha:
    // forcing opacity there would defeat the very weight we are honouring.
    if (!keepAlpha) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <alphatest_fragment>',
        `float _lum = dot( diffuseColor.rgb, vec3( 0.299, 0.587, 0.114 ) );
        if ( _lum > 0.05 ) diffuseColor.a = 1.0;
        #include <alphatest_fragment>`
      )

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <premultiplied_alpha_fragment>',
        `#include <premultiplied_alpha_fragment>
        gl_FragColor.a = 1.0;`
      )
    }
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <fog_fragment>',
      `#ifdef USE_FOG
        #ifdef FOG_EXP2
          float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
        #else
          float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
        #endif
        float heightAtten = 1.0 - smoothstep(fogHeightBase, fogHeightBase + fogHeightRange, vWorldY);
        fogFactor *= max(heightAtten, 0.06);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, clamp(fogFactor, 0.0, 1.0));
      #endif`
    )
  }
  // Distinct key per shader variant — a shared key would make three reuse the
  // wrong compiled program. This has to cover anything that rewrites the
  // shader, including PCSS, which swaps the global shadow chunk: with a fixed
  // key three would keep the stale program and the meshes vanish entirely.
  const cacheKey = `zone-shader-${lit ? 'lit' : 'basic'}-${variant}${keepAlpha ? '-va' : ''}`
  material.customProgramCacheKey = () => cacheKey
}

/** Diagnostic: skip prefabs the instance list never references. */
const SKIP_UNREFERENCED =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).has('nounref')

/** Diagnostic: render water meshes with the ordinary opaque material. */
const DISABLE_WATER_SHADER =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).has('nowater')

/**
 * Diagnostic: dump every unreferenced prefab with its full texture string,
 * material index, whether that material resolves to a real texture, and its
 * bounding size.
 *
 * This is the weather investigation's measuring instrument. FFXI parks its
 * weather domes and effect geometry in the file with no MZB instance record,
 * so the unreferenced set is where all of it lives. The texture string packs
 * two fields and the raw spacing is preserved here on purpose — the whole
 * lead is that the first field reads as a weather *state* and the second as
 * an *element* ("fogd  clod_a01", "thdr  kumori").
 *
 * `texOk` matters as much as the name: the first weather attempt drew domes
 * with the fallback texture and concluded the geometry was wrong. Whether the
 * material index resolves is the difference between a parser problem and a
 * presentation problem, and they need different fixes.
 */
const CENSUS =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).has('census')

/**
 * Diagnostic: draw *only* prefabs whose texture string contains this substring,
 * and nothing else — terrain included.
 *
 * The old `showWeather` toggle drew every weather state at once on top of the
 * zone, which is why it looked like nonsense and was removed. Isolating one
 * name is the opposite approach and the only way to tell what a given prefab
 * actually is: `pick=niji` in Misareaux Coast draws the rainbow alone against
 * an empty scene.
 *
 * When set, `isSkyWeatherMesh` is bypassed entirely, so this can look at the
 * geometry that filter normally hides.
 */
const PICK =
  typeof window !== 'undefined'
    ? (new URLSearchParams(window.location.search).get('pick') ?? '').toLowerCase()
    : ''

/**
 * Diagnostic, PICK-only: how the picked meshes composite —
 * `additive`, `alpha` or `opaque`.
 *
 * The zone renderer has no blending mode at all today: the blend flag drives
 * only `useAlpha = blending > 0`, which sets `alphaTest`, so FFXI's `0x0`,
 * `0x2000` and `0x8000` all collapse to alpha-tested opaque. That is why
 * `effect  taki`, a greyscale waterfall streak sheet, renders as dark cloth.
 */
const BLEND_MODE =
  typeof window !== 'undefined'
    ? (new URLSearchParams(window.location.search).get('blend') ?? '').toLowerCase()
    : ''

/** Diagnostic, PICK-only: drop vertex colours, which are very dark here. */
const NO_VCOLOR =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).has('novcolor')

const hasCameraOverride =
  typeof window !== 'undefined' &&
  (new URLSearchParams(window.location.search).has('yaw') ||
    new URLSearchParams(window.location.search).has('pitch') ||
    new URLSearchParams(window.location.search).has('gotowater'))

/**
 * FFXI truncates texture names to eight characters, so the full words this used
 * to look for ("river", "kawa", "taki") never appear. Real examples from the
 * zone files are "ron_riv" (Ronfaure's river), "kaw1" (kawa) and "tak_w01c"
 * (taki, a waterfall) — all of which were being drawn as ordinary opaque
 * geometry because none of them matched.
 */
/**
 * Only names that unambiguously denote a water *surface*.
 *
 * Two earlier attempts to widen this both backfired, and the failures are worth
 * recording. "ron_w01c" reads like Ronfaure water but is a large terrain mesh —
 * routing it through the transparent water material turned the zone into
 * overlapping ghosts. "ron_riv" reads like the river but is the river*bed*:
 * giving it the water shader made a patch of ground scroll in two directions.
 *
 * FFXI's eight-character texture names do not reliably say what a surface is,
 * so this stays narrow. Identifying real water surfaces needs a signal from the
 * file itself rather than the name.
 */
/**
 * Deliberately narrow. Findings from repeated attempts, so they are not redone:
 *  - "ron_w01c" reads like water but is terrain; the water material turned the
 *    whole zone into overlapping ghosts.
 *  - "ron_riv" IS West Ronfaure's pond surface (confirmed by clicking it with
 *    the inspector: material 25, blending 0). But routing it through the water
 *    material renders pale stacked planes, nothing like the game, so it is left
 *    as ordinary geometry until the intended blend mode is understood. The name
 *    describes the shared texture, not the surface — it is presumably East
 *    Ronfaure's river reused here.
 *  - Classifying by texture alpha ("no opaque texels") matched 325 of 349
 *    prefabs including rails, gates and trees, so alpha does not discriminate.
 *    That most textures report near-zero opaque texels also suggests the DXT
 *    alpha decode may be wrong across the board — worth investigating.
 */
const WATER_NAME_RE =
  /water|wtr|sea_|umi_|wave|aqua|suimen|mizu|_ike|kawa|taki|falls/i

function isWaterMesh(prefab: { textureName?: string; blending: number }): boolean {
  return WATER_NAME_RE.test(prefab.textureName ?? '')
}

/**
 * Category prefixes for FFXI's own sky and weather meshes, which we replace
 * with the procedural sky. These are matched on the category field, so the
 * anchor and trailing whitespace keep them from catching ordinary geometry.
 *
 * "clod" (cloud), "mist", "rain" and "snow" were missing here. It went
 * unnoticed while unreferenced prefabs were skipped, because the weather domes
 * are stored unreferenced — once those started rendering, the cloud domes
 * appeared as large grey shells sitting in the middle of zones.
 */
const SKY_WEATHER_WORDS = [
  'aura', 'fine', 'suny', 'wind', 'star', 'moon', 'effect',
  'clod', 'mist', 'rain', 'snow', 'kumo', 'kumori', 'sora',
  // Added after a sweep found domes these never caught: tenkyu is 天球, a
  // celestial sphere, and strm is storm.
  'tenkyu', 'strm',
  // Added 2026-08-09 from the census, after Ryan photographed a rainbow and a
  // sheet of sunset glow sitting in zones that should not have been drawing.
  // niji is 虹 (rainbow); even is evening and yuh/yuhi is 夕日, the evening sun;
  // kaminari is 雷 (thunder); katn and smoke and thunder are states stored under
  // clod/wind/thdr; bahakumo is Bahamut cutscene cloud.
  'niji', 'even', 'yuh', 'yuhi', 'yuhiumi', 'kaminari', 'katn', 'smoke',
  'thunder', 'bahakumo',
]

/**
 * Categories that are never weather, whatever else the name looks like.
 *
 * `model` is real zone geometry stored unreferenced — Riverne - Site #A01 has
 * 142 such prefabs and they are the floating islands themselves. A widened
 * filter that catches `model` deletes the zone.
 */
const NEVER_WEATHER = new Set(['model'])
const SKY_WEATHER_RE = new RegExp(
  // A word on its own, or with a variant suffix like _a01, b01 or 01.
  `^(?:${SKY_WEATHER_WORDS.join('|')}|lf\\d+)(?:[a-z]?\\d+)?$`,
  'i',
)

/**
 * True for FFXI's own sky and weather meshes, which the procedural sky replaces.
 *
 * The texture string packs two fields — roughly "category  name" — and the
 * weather identity can be in **either**. Matching only the category missed a
 * lot: `fogd  clod_a01`, `dark  clod_b01`, `thdr  kumori`, `ukfi  strm` and
 * `squl  tenkyu01` are all weather domes under categories that mean nothing to
 * this list. A sweep of 18 zones found 8 still drawing one.
 *
 * Both fields are tested, split on whitespace and underscores, so `star_rivstar01`
 * and `clod_a01` reduce to `star` and `clod`.
 *
 * Matching is whole-token with only a numeric variant suffix allowed, not a
 * prefix: a bare prefix test would swallow anything named "windmill" or
 * "starboard".
 */
function isSkyWeatherMesh(prefab: { textureName?: string }): boolean {
  const raw = prefab.textureName ?? ''
  if (!raw) return false

  // The texture string is two FIXED 8-CHARACTER COLUMNS, not two whitespace-
  // separated words. Verified against all 83 distinct names in the census:
  // every one splits cleanly at index 8. Splitting on whitespace works only
  // while the first field is short enough to leave padding, and silently fails
  // whenever it fills the column — which is exactly the case for the names that
  // kept slipping through:
  //
  //   "kaminarikumori" -> "kaminari" + "kumori"    (not one 14-char word)
  //   "bahakumokum0"   -> "bahakumo" + "kum0"
  //   "star_rivstar01" -> "star_riv" + "star01"
  //   "niji    niji"   -> "niji"     + "niji"
  //
  // Underscores are still split within a field, so "star_riv" yields star, riv.
  const fields = [raw.slice(0, 8), raw.slice(8)]
  const tokens: string[] = []
  for (const field of fields) {
    for (const part of field.trim().split(/[\s_]+/)) if (part) tokens.push(part)
  }
  if (tokens.some(t => NEVER_WEATHER.has(t.toLowerCase()))) return false
  return tokens.some(t => SKY_WEATHER_RE.test(t))
}

const WATER_VERT = /* glsl */ `
  attribute vec3 color;
  varying vec2 vUv;
  varying vec3 vWorldPos;
  varying vec3 vViewDir;
  varying vec3 vWorldNormal;
  varying vec3 vColor;

  // The renderer uses a logarithmic depth buffer for these huge zones, and
  // three's built-in materials all write log-encoded depth. Without these
  // chunks the water tested conventional depth against log-encoded values —
  // an apples-to-oranges comparison that failed nearly everywhere, so the
  // water surfaces simply never appeared.
  // <common> must come first: logdepthbuf_vertex calls its
  // isPerspectiveMatrix() helper, and without it the program fails to
  // compile — which silently killed every water draw.
  #include <common>
  #include <logdepthbuf_pars_vertex>

  void main() {
    vUv = uv;
    vColor = color;
    #ifdef USE_INSTANCING
      vec4 worldPos = modelMatrix * instanceMatrix * vec4(position, 1.0);
      vWorldNormal = normalize(mat3(modelMatrix * instanceMatrix) * normal);
      vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    #else
      vec4 worldPos = modelMatrix * vec4(position, 1.0);
      vWorldNormal = normalize(mat3(modelMatrix) * normal);
      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    #endif
    vWorldPos = worldPos.xyz;
    vViewDir = normalize(cameraPosition - worldPos.xyz);
    gl_Position = projectionMatrix * mvPosition;
    #include <logdepthbuf_vertex>
  }
`

const WATER_FRAG = /* glsl */ `
  uniform sampler2D map;
  uniform float time;
  uniform float sunStrength;
  uniform vec3 sunDirection;
  uniform vec3 sunTint;
  uniform float vertexTint;

  #include <logdepthbuf_pars_fragment>

  varying vec2 vUv;
  varying vec3 vWorldPos;
  varying vec3 vViewDir;
  varying vec3 vWorldNormal;
  varying vec3 vColor;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }

  void main() {
    #include <logdepthbuf_fragment>
    vec2 uv1 = vUv + vec2(time * 0.012, time * 0.008);
    vec2 uv2 = vUv * 1.12 + vec2(-time * 0.008, time * 0.014);
    vec4 tex = mix(texture2D(map, uv1), texture2D(map, uv2), 0.5);

    // FFXI bakes very dark values into water vertex colours (around 0.07 in
    // West Ronfaure). Multiplying straight through renders the river almost
    // black, so the tint is dialled back toward white by vertexTint.
    vec3 color = tex.rgb * mix(vec3(1.0), vColor, vertexTint);

    float ripple = noise(vWorldPos.xz * 0.5 + time * 0.8);
    color += vec3(0.04) * smoothstep(0.55, 0.8, ripple);

    // A broad specular lobe was tried here and removed: water surfaces are flat,
    // so the half-vector term saturates across the whole plane at once and turns
    // the river into a sheet of white. Any sun response has to be far tighter
    // and modulated by the ripple noise, not a plain Blinn-Phong highlight.
    vec3 n = normalize(vWorldNormal);
    vec3 h = normalize(normalize(sunDirection) + normalize(vViewDir));
    float spec = pow(max(dot(n, h), 0.0), 220.0);
    color += sunTint * spec * smoothstep(0.6, 0.95, ripple) * sunStrength * 0.15;

    // Deliberately ignores the texture's own alpha. FFXI's river textures
    // decode to almost no opacity at all — ron_riv measures 0% opaque, 57%
    // fully transparent, average alpha 45/255 — so multiplying by it left the
    // surface invisible and whatever sat behind the river showed through as a
    // pale sheet. The original opaque path forced alpha to 1.0 and never hit
    // this. Opacity comes from view angle alone: clearer looking straight down,
    // more reflective at grazing angles.
    float fresnel = pow(1.0 - max(dot(normalize(vViewDir), n), 0.0), 3.0);
    float alpha = mix(0.55, 0.95, fresnel);

    #ifdef WATER_DEBUG
      // ?waterdebug=1 — unmissable solid magenta, to verify the water planes
      // actually reach the screen without having to aim the camera at them.
      gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0);
    #else
      gl_FragColor = vec4(color, alpha);
    #endif
  }
`

const WATER_DEBUG =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).has('waterdebug')

function createWaterMaterial(texture: THREE.DataTexture | null): THREE.ShaderMaterial {
  const uniforms: Record<string, { value: unknown }> = {
    time: { value: 0 },
    sunStrength: { value: 0.6 },
    sunDirection: { value: new THREE.Vector3(0.5, 1, 0.3).normalize() },
    sunTint: { value: new THREE.Color('#fff4e0') },
    vertexTint: { value: 0.35 },
  }
  if (texture) uniforms.map = { value: texture }

  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
    ...(WATER_DEBUG && { defines: { WATER_DEBUG: '' } }),
    // FFXI stores water as two coplanar passes: an opaque plane (blending 0) and
    // a translucent one (0x2000) at identical coordinates. Without an offset the
    // opaque twin wins the depth test and the water pass is never seen, since it
    // writes no depth of its own. Pull it toward the camera so it draws on top.
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  })
}

function WaterAnimator({ materials, vertexTint }: { materials: THREE.ShaderMaterial[]; vertexTint: number }) {
  useFrame(({ clock }) => {
    const t = clock.getElapsedTime()
    for (const mat of materials) {
      mat.uniforms.time.value = t
      if (mat.uniforms.vertexTint) mat.uniforms.vertexTint.value = vertexTint
    }
  })
  return null
}

/** Computes the sun direction either from the clock or from the manual angles. */
function sunDirectionFor(lighting: LightingSettings, timeOfDay: number): THREE.Vector3 {
  if (lighting.sunFollowsTimeOfDay) {
    const angle = ((timeOfDay - 6) / 12) * Math.PI
    return new THREE.Vector3(Math.cos(angle), Math.max(Math.sin(angle), 0.05), -0.3).normalize()
  }
  const az = THREE.MathUtils.degToRad(lighting.sunAzimuth)
  const el = THREE.MathUtils.degToRad(lighting.sunElevation)
  return new THREE.Vector3(
    Math.cos(el) * Math.sin(az),
    Math.max(Math.sin(el), 0.02),
    Math.cos(el) * Math.cos(az),
  ).normalize()
}

/**
 * Key light. The shadow camera is orthographic and follows the view, so a
 * modest shadow map still resolves sharp shadows across a very large zone.
 */
function SunLight({
  lighting, timeOfDay, waterMaterials,
}: {
  lighting: LightingSettings
  timeOfDay: number
  waterMaterials: THREE.ShaderMaterial[]
}) {
  const lightRef = useRef<THREE.DirectionalLight>(null)
  const targetRef = useRef(new THREE.Object3D())
  const { scene, camera } = useThree()

  useEffect(() => {
    const target = targetRef.current
    scene.add(target)
    return () => { scene.remove(target) }
  }, [scene])

  useEffect(() => {
    const light = lightRef.current
    if (!light) return
    const cam = light.shadow.camera
    const r = lighting.shadowRadius
    cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r
    cam.near = 1
    cam.far = r * 6
    cam.updateProjectionMatrix()
    light.shadow.bias = lighting.shadowBias
    light.shadow.normalBias = lighting.shadowNormalBias
    light.shadow.radius = lighting.shadowSoftness
    light.shadow.mapSize.set(lighting.shadowMapSize, lighting.shadowMapSize)
    // Force the shadow map to be reallocated at the new resolution.
    light.shadow.map?.dispose()
    light.shadow.map = null as unknown as THREE.WebGLRenderTarget
    // mode and shadows are dependencies because the light itself only exists in
    // lit mode: switching over creates it without changing any shadow setting,
    // so without these the camera kept three's tiny default bounds and no
    // shadows appeared until a slider was nudged.
  }, [
    lighting.mode, lighting.shadows,
    lighting.shadowRadius, lighting.shadowBias, lighting.shadowNormalBias,
    lighting.shadowSoftness, lighting.shadowMapSize,
  ])

  useFrame(() => {
    const light = lightRef.current
    if (!light) return

    const dir = sunDirectionFor(lighting, timeOfDay)

    // Anchor the shadow volume a little ahead of the camera so detail lands
    // where the user is actually looking.
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
    const anchor = camera.position.clone().add(forward.multiplyScalar(lighting.shadowRadius * 0.45))

    targetRef.current.position.copy(anchor)
    targetRef.current.updateMatrixWorld()
    light.position.copy(anchor).add(dir.clone().multiplyScalar(lighting.shadowRadius * 2.5))
    light.target = targetRef.current

    for (const mat of waterMaterials) {
      if (!mat.uniforms.sunDirection) continue
      ;(mat.uniforms.sunDirection.value as THREE.Vector3).copy(dir)
      ;(mat.uniforms.sunTint.value as THREE.Color).set(lighting.sunColor)
      mat.uniforms.sunStrength.value =
        lighting.mode === 'lit' ? Math.min(lighting.sunIntensity * 0.25, 1.2) : 0.35
    }
  })

  if (lighting.mode !== 'lit') return null

  return (
    <>
      <directionalLight
        ref={lightRef}
        color={lighting.sunColor}
        intensity={lighting.sunIntensity}
        castShadow={lighting.shadows}
      />
      <hemisphereLight
        color={lighting.skyColor}
        groundColor={lighting.groundColor}
        intensity={lighting.ambientIntensity}
      />
    </>
  )
}

function SkyAnimator({
  skyMaterial, timeOfDayRef, exposure,
}: {
  skyMaterial: THREE.ShaderMaterial
  timeOfDayRef: React.RefObject<number>
  exposure: number
}) {
  const { gl, scene } = useThree()
  useFrame(() => {
    const tod = timeOfDayRef.current
    const params = getTimeOfDayParams(tod)

    const u = skyMaterial.uniforms
    ;(u.skyColor.value as THREE.Vector3).set(...params.sky)
    ;(u.horizonColor.value as THREE.Vector3).set(...params.horizon)
    ;(u.zenithColor.value as THREE.Vector3).set(...params.zenith)
    u.nightFactor.value = params.nightFactor
    const sunAngle = ((tod - 6) / 12) * Math.PI
    ;(u.sunDir.value as THREE.Vector3).set(Math.cos(sunAngle), Math.sin(sunAngle), -0.3).normalize()

    gl.toneMappingExposure = params.exposure * exposure

    if (scene.fog) (scene.fog as THREE.FogExp2).color.set(params.fogColor)
  })
  return null
}

/**
 * The backdrop shown with the sky dome switched off.
 *
 * Either a flat colour, or that colour tinted by time of day so dusk still
 * reads as dusk. Following the clock is the older behaviour and stays the
 * default; the picker exists for screenshots against a chosen background.
 */
function BackgroundUpdater({
  timeOfDayRef, color, followTime,
}: {
  timeOfDayRef: React.RefObject<number>
  color: string
  followTime: boolean
}) {
  const { scene } = useThree()

  useEffect(() => {
    scene.background = new THREE.Color(color)
    return () => { scene.background = null }
  }, [scene, color])

  useFrame(() => {
    if (!(scene.background instanceof THREE.Color)) return
    if (!followTime) {
      scene.background.set(color)
      return
    }
    // Multiply rather than replace, so the picked colour still sets the hue
    // while the clock drives how dark it gets.
    const params = getTimeOfDayParams(timeOfDayRef.current)
    scene.background.set(color)
    scene.background.multiplyScalar(
      Math.max(params.sky[0], params.sky[1], params.sky[2]) * 2.2 + 0.15,
    )
  })

  return null
}

function SkyDome({ size, material }: { size: number; material: THREE.ShaderMaterial }) {
  const meshRef = useRef<THREE.Mesh>(null)
  useFrame(({ camera }) => {
    if (meshRef.current) meshRef.current.position.copy(camera.position)
  })
  return (
    <mesh ref={meshRef} renderOrder={-1}>
      <sphereGeometry args={[size, 32, 32]} />
      <primitive object={material} attach="material" />
    </mesh>
  )
}

function FogController({ size, density }: { size: number; density: number }) {
  const { scene } = useThree()
  useEffect(() => {
    scene.fog = new THREE.FogExp2('#b8c8d8', (density * 1.8) / size)
    return () => { scene.fog = null }
  }, [scene, size, density])
  return null
}

/**
 * User-placed point lights, plus the optional camera headlamp. Lights live in
 * world space, outside the group that flips the zone upright.
 */
function PointLights({
  settings, selectedId,
}: {
  settings: PointLightSettings
  selectedId: number | null
}) {
  const refs = useRef(new Map<number, THREE.PointLight>())
  const headlampRef = useRef<THREE.PointLight>(null)
  const { camera } = useThree()

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime()
    for (const light of settings.lights) {
      const obj = refs.current.get(light.id)
      if (!obj) continue
      if (light.flicker > 0) {
        // Two out-of-phase sines read as an irregular flame rather than a pulse.
        const f =
          Math.sin(t * 11.3 + light.id * 2.7) * 0.6 +
          Math.sin(t * 6.1 + light.id * 5.1) * 0.4
        obj.intensity = light.intensity * (1 + f * light.flicker * 0.5)
      } else {
        obj.intensity = light.intensity
      }
    }
    if (headlampRef.current) headlampRef.current.position.copy(camera.position)
  })

  return (
    <>
      {settings.lights.map(light => (
        <group key={light.id} position={light.position}>
          <pointLight
            ref={(o: THREE.PointLight | null) => {
              if (o) refs.current.set(light.id, o)
              else refs.current.delete(light.id)
            }}
            color={light.color}
            intensity={light.intensity}
            distance={light.distance}
            decay={light.decay}
            castShadow={light.castShadow}
            shadow-mapSize-width={1024}
            shadow-mapSize-height={1024}
            shadow-bias={-0.005}
          />
          {settings.showGizmos && (
            <mesh raycast={() => null}>
              <sphereGeometry args={[selectedId === light.id ? 1.6 : 1.1, 10, 10]} />
              <meshBasicMaterial
                color={light.color}
                wireframe={selectedId !== light.id}
                toneMapped={false}
              />
            </mesh>
          )}
        </group>
      ))}

      {settings.headlamp && (
        <pointLight
          ref={headlampRef}
          color={settings.headlampColor}
          intensity={settings.headlampIntensity}
          distance={settings.headlampDistance}
          decay={1.4}
        />
      )}
    </>
  )
}

/**
 * Click-to-place: raycasts the zone geometry and reports where the user
 * clicked, so a light can be dropped onto that surface.
 */
function LightPlacer({
  meshes, active, onPlace,
}: {
  meshes: THREE.InstancedMesh[]
  active: boolean
  onPlace: (position: [number, number, number]) => void
}) {
  const { camera, gl } = useThree()

  useEffect(() => {
    if (!active) return
    const el = gl.domElement
    let downAt: { x: number; y: number } | null = null

    const onDown = (e: PointerEvent) => { downAt = { x: e.clientX, y: e.clientY } }
    const onUp = (e: PointerEvent) => {
      if (!downAt) return
      // Ignore camera drags — only a near-stationary click places a light.
      const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y)
      downAt = null
      if (moved > 4) return

      const rect = el.getBoundingClientRect()
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      )
      const raycaster = new THREE.Raycaster()
      raycaster.setFromCamera(ndc, camera)
      const hits = raycaster.intersectObjects(meshes, false)
      if (!hits.length) return

      const p = hits[0].point
      // Lift the light off the surface so it doesn't sit inside the geometry.
      const n = hits[0].face?.normal
        ? hits[0].face.normal.clone().transformDirection(hits[0].object.matrixWorld)
        : new THREE.Vector3(0, 1, 0)
      const pos = p.clone().add(n.multiplyScalar(2.5))
      onPlace([pos.x, pos.y, pos.z])
    }

    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointerup', onUp)
    return () => {
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointerup', onUp)
    }
  }, [active, camera, gl, meshes, onPlace])

  return null
}

/**
 * Image-based lighting from the game's own sky. Renders the procedural sky
 * shader into a cube map, runs it through PMREM so roughness is handled
 * properly, and hands it to the scene as an environment map. Surfaces then pick
 * up sky colour from whichever direction they face — warm from a low sun, cool
 * from the opposite side — instead of the flat hemisphere term.
 *
 * Rebuilt only when the clock moves a meaningful amount; it is far too costly
 * to regenerate every frame.
 */
function SkyEnvironment({
  skyMaterial, timeOfDay, enabled, intensity,
}: {
  skyMaterial: THREE.ShaderMaterial
  timeOfDay: number
  enabled: boolean
  intensity: number
}) {
  const { gl, scene } = useThree()
  // Quarter-hour buckets keep the rebuild off the critical path while the
  // time-of-day slider is being dragged.
  const bucket = Math.round(timeOfDay * 4)

  useEffect(() => {
    if (!enabled) {
      scene.environment = null
      return
    }

    const target = new THREE.WebGLCubeRenderTarget(256)
    const cubeCamera = new THREE.CubeCamera(1, 2000, target)
    const captureScene = new THREE.Scene()
    const geometry = new THREE.SphereGeometry(800, 32, 32)
    const dome = new THREE.Mesh(geometry, skyMaterial)
    captureScene.add(dome)
    cubeCamera.update(gl, captureScene)

    const pmrem = new THREE.PMREMGenerator(gl)
    const envRT = pmrem.fromCubemap(target.texture)
    scene.environment = envRT.texture

    return () => {
      scene.environment = null
      envRT.dispose()
      pmrem.dispose()
      geometry.dispose()
      target.dispose()
    }
  }, [enabled, bucket, gl, scene, skyMaterial])

  useEffect(() => {
    scene.environmentIntensity = enabled ? intensity : 1
  }, [scene, enabled, intensity])

  return null
}

/** Diagnostic: hover the camera above a point, looking straight down at it. */
function CameraGoTo({ target }: { target: THREE.Vector3 }) {
  const { camera } = useThree()
  const done = useRef(false)
  if (!done.current) {
    done.current = true
    camera.position.set(target.x, target.y + 30, target.z + 0.01)
    camera.lookAt(target)
    camera.updateMatrixWorld()
  }
  return null
}

/**
 * Click a surface and report everything known about it: which mesh it is, the
 * texture bound to it, how that texture actually decoded, its UV range, the
 * blending flag from the DAT, and the material it ended up rendering with.
 */
function SurfaceInspector({
  meshes, zoneData, active, onResult,
}: {
  meshes: THREE.InstancedMesh[]
  zoneData: ParsedZone
  active: boolean
  onResult: (info: SurfaceInfo) => void
}) {
  const { camera, gl } = useThree()

  useEffect(() => {
    if (!active) return
    const el = gl.domElement
    let downAt: { x: number; y: number } | null = null

    const onDown = (e: PointerEvent) => { downAt = { x: e.clientX, y: e.clientY } }
    const onUp = (e: PointerEvent) => {
      if (!downAt) return
      const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y)
      downAt = null
      if (moved > 4) return

      const rect = el.getBoundingClientRect()
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      )
      const raycaster = new THREE.Raycaster()
      raycaster.setFromCamera(ndc, camera)
      const hit = raycaster.intersectObjects(meshes, false)[0]
      if (!hit) { onResult({ empty: true }); return }

      const prefabIdx = hit.object.userData.prefabIdx as number
      const prefab = zoneData.prefabs[prefabIdx]
      const matIdx = prefab?.materialIndex ?? -1
      const tex = zoneData.textures[matIdx]

      // How the texture actually decoded — a blank or fully opaque decode is
      // the difference between "wrong texture" and "texture failed to parse".
      let texInfo: SurfaceInfo['texture'] = null
      if (tex) {
        let r = 0, g = 0, b = 0, a = 0, opaque = 0, clear = 0
        const n = tex.rgba.length / 4
        for (let i = 0; i < tex.rgba.length; i += 4) {
          r += tex.rgba[i]; g += tex.rgba[i + 1]; b += tex.rgba[i + 2]; a += tex.rgba[i + 3]
          if (tex.rgba[i + 3] > 250) opaque++
          else if (tex.rgba[i + 3] < 8) clear++
        }
        texInfo = {
          size: `${tex.width}×${tex.height}`,
          avg: `${Math.round(r / n)}, ${Math.round(g / n)}, ${Math.round(b / n)}`,
          avgAlpha: Math.round(a / n),
          pctOpaque: Math.round((opaque / n) * 100),
          pctTransparent: Math.round((clear / n) * 100),
        }
      }

      // UVs outside 0..1 are normal (tiling); a collapsed range means broken UVs.
      let uvRange: string | null = null
      if (prefab?.uvs?.length) {
        let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity
        for (let i = 0; i < prefab.uvs.length; i += 2) {
          minU = Math.min(minU, prefab.uvs[i]); maxU = Math.max(maxU, prefab.uvs[i])
          minV = Math.min(minV, prefab.uvs[i + 1]); maxV = Math.max(maxV, prefab.uvs[i + 1])
        }
        uvRange = `u ${minU.toFixed(2)}…${maxU.toFixed(2)}  v ${minV.toFixed(2)}…${maxV.toFixed(2)}`
      }

      let vertexColour: string | null = null
      if (prefab?.colors?.length >= 4) {
        const c = prefab.colors
        vertexColour = `${c[0].toFixed(2)}, ${c[1].toFixed(2)}, ${c[2].toFixed(2)} (a ${c[3].toFixed(2)})`
      }

      const material = (hit.object as THREE.Mesh).material as THREE.Material
      const info: SurfaceInfo = {
        textureName: prefab?.textureName || '(blank)',
        materialIndex: matIdx,
        materialType: material.constructor.name,
        // ShaderMaterial keeps its textures in uniforms, not a .map property —
        // checking only .map reported "NO MAP" for every water surface.
        hasMap: material instanceof THREE.ShaderMaterial
          ? !!material.uniforms.map?.value
          : !!(material as THREE.MeshBasicMaterial).map,
        blending: prefab ? `${prefab.blending} (0x${prefab.blending.toString(16)})` : '?',
        classifiedAsWater: prefab ? isWaterMesh(prefab) : false,
        texture: texInfo,
        uvRange,
        vertexColour,
        distance: Math.round(hit.distance),
        vertexCount: prefab ? prefab.vertices.length / 3 : 0,
      }
      console.log('[INSPECT] ' + JSON.stringify(info))
      onResult(info)
    }

    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointerup', onUp)
    return () => {
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointerup', onUp)
    }
  }, [active, camera, gl, meshes, zoneData, onResult])

  return null
}

/**
 * Original mode's light rig — the game's own fixed-function model: one
 * directional sun evaluated per vertex against the DAT normals, plus flat
 * ambient. No shadow maps; the terrain "shadows" seen in-game are this N·L
 * term (cliff faces turned away from the sun go dark), not projected shadows.
 */
function GameSun({
  intensity, ambient, timeOfDay,
}: {
  intensity: number
  ambient: number
  timeOfDay: number
}) {
  const angle = ((timeOfDay - 6) / 12) * Math.PI
  const dir = new THREE.Vector3(
    Math.cos(angle),
    Math.max(Math.sin(angle), 0.08),
    -0.3
  ).normalize()
  // Dim the key light outside daylight hours, as the game's light table does.
  const daylight = 0.2 + 0.8 * Math.max(Math.sin(angle), 0)
  return (
    <>
      {/* Three's physical light units divide Lambert diffuse by π; the π factor
          restores the DX8 fixed-function response the sliders are scaled for. */}
      <directionalLight
        position={[dir.x * 1000, dir.y * 1000, dir.z * 1000]}
        intensity={intensity * daylight * Math.PI}
        color="#fff6e4"
      />
      <ambientLight intensity={ambient * Math.PI} color="#ffffff" />
    </>
  )
}

interface CameraPose { pos: THREE.Vector3; quat: THREE.Quaternion }

/**
 * Carries the camera across a Canvas remount. Switching depth of field on or
 * off has to rebuild the renderer (it needs a different depth buffer), and
 * without this the view would snap back to the zone's default framing.
 */
function CameraPersistence({ store }: { store: React.MutableRefObject<CameraPose | null> }) {
  const { camera } = useThree()
  const restored = useRef(false)

  // Restored during render rather than in an effect so the controls, which read
  // the camera while they render, see the restored pose rather than the default.
  if (!restored.current) {
    restored.current = true
    if (store.current) {
      camera.position.copy(store.current.pos)
      camera.quaternion.copy(store.current.quat)
      camera.updateMatrixWorld()
    }
  }

  useEffect(() => () => {
    store.current = { pos: camera.position.clone(), quat: camera.quaternion.clone() }
  }, [camera, store])

  return null
}

/**
 * Deep-link camera orientation (?yaw=&pitch= in degrees). Used to reproduce
 * view-dependent rendering issues at a known angle.
 */
function CameraOrientation() {
  const { camera } = useThree()
  useEffect(() => {
    const aim = (yaw: number, pitch: number) => {
      camera.quaternion.setFromEuler(
        new THREE.Euler(
          THREE.MathUtils.degToRad(pitch),
          THREE.MathUtils.degToRad(yaw),
          0,
          'YXZ'
        )
      )
    }
    const p = new URLSearchParams(window.location.search)
    aim(Number(p.get('yaw') ?? 0), Number(p.get('pitch') ?? 0))
    // Lets the sweep harness re-aim without reloading (and re-parsing) the zone.
    ;(window as unknown as { __aimCamera?: typeof aim }).__aimCamera = aim
    return () => {
      delete (window as unknown as { __aimCamera?: typeof aim }).__aimCamera
    }
  }, [camera])
  return null
}

/** Applies renderer-level settings that R3F does not expose declaratively. */
function RendererSettings({ post, shadows }: { post: PostSettings; shadows: boolean }) {
  const { gl } = useThree()
  useEffect(() => {
    gl.toneMapping = TONE_MAPPING[post.toneMapping]
    gl.shadowMap.enabled = shadows
    gl.shadowMap.type = THREE.PCFSoftShadowMap
    gl.shadowMap.needsUpdate = true
  }, [gl, post.toneMapping, shadows])
  return null
}

/**
 * Draws the MZB collision mesh as a wireframe over the zone.
 *
 * Diagnostic, and the acceptance test for the collision parser: correct
 * collision hugs the rendered ground. Anything mirrored, offset or inside-out
 * shows up immediately as wireframe that floats away from the art it should be
 * tracing.
 *
 * It draws the *same* geometry CollisionWorld raycasts against — already in
 * world space, so it sits outside the zone's PI-rotated group. That sharing is
 * deliberate: what you see is exactly what you collide with, and the two cannot
 * drift apart.
 *
 * Collision has no vertex colours or UVs, so a flat unlit material is all it
 * can take. depthTest stays on so terrain in front occludes it.
 */
function CollisionOverlay({ world }: { world: CollisionWorld | null }) {
  if (!world) return null

  return (
    <mesh geometry={world.geometry} renderOrder={999}>
      <meshBasicMaterial
        color="#00ff88"
        wireframe
        transparent
        opacity={0.55}
        side={THREE.DoubleSide}
      />
    </mesh>
  )
}

function SmartOrbitControls({ size, lookAt }: { size: number; lookAt?: THREE.Vector3 }) {
  const { camera } = useThree()
  const target = useMemo(() => {
    // Isolation mode aims at the picked geometry directly. The usual guess —
    // project forward along the camera's own facing — assumes the camera was
    // already pointed at something, which is only true for the default view.
    if (lookAt) {
      camera.lookAt(lookAt)
      return lookAt.clone()
    }
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
    const dist = Math.min(size * 0.5, 200)
    return camera.position.clone().add(dir.multiplyScalar(dist))
  }, [camera, size, lookAt])
  return <OrbitControls target={target} maxDistance={size * 5} makeDefault />
}

function FlyCamera({
  center, size, onSpeedChange,
}: {
  center: THREE.Vector3
  size: number
  onSpeedChange?: (speed: number) => void
}) {
  const { camera, gl } = useThree()
  const moveState = useRef({ forward: false, backward: false, left: false, right: false, up: false, down: false })
  const speed = useRef(size * 0.003)
  const locked = useRef(false)
  const initialized = useRef(false)
  // Yaw and pitch are the source of truth. Decomposing them back out of the
  // camera quaternion each event is ambiguous at ±90° pitch (the YXZ gimbal
  // singularity) and read back as a sudden yaw flip.
  const yaw = useRef(0)
  const pitch = useRef(0)

  useEffect(() => {
    if (!initialized.current) {
      camera.position.set(center.x, center.y + size * 0.15, center.z + size * 0.4)
      camera.lookAt(center)
      initialized.current = true
    }
    onSpeedChange?.(speed.current)

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'KeyW') moveState.current.forward = true
      if (e.code === 'KeyS') moveState.current.backward = true
      if (e.code === 'KeyA') moveState.current.left = true
      if (e.code === 'KeyD') moveState.current.right = true
      if (e.code === 'Space' || e.code === 'KeyE') moveState.current.up = true
      if (e.code === 'ShiftLeft' || e.code === 'KeyQ') moveState.current.down = true
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'KeyW') moveState.current.forward = false
      if (e.code === 'KeyS') moveState.current.backward = false
      if (e.code === 'KeyA') moveState.current.left = false
      if (e.code === 'KeyD') moveState.current.right = false
      if (e.code === 'Space' || e.code === 'KeyE') moveState.current.up = false
      if (e.code === 'ShiftLeft' || e.code === 'KeyQ') moveState.current.down = false
    }
    const onWheel = (e: WheelEvent) => {
      speed.current = Math.max(0.05, speed.current * (e.deltaY > 0 ? 1.25 : 0.8))
      onSpeedChange?.(speed.current)
    }
    const onClick = () => { gl.domElement.requestPointerLock() }
    const onPointerLockChange = () => {
      const nowLocked = !!document.pointerLockElement
      // Seed yaw/pitch from wherever the camera is currently facing, so taking
      // control never snaps the view.
      if (nowLocked && !locked.current) {
        const e = new THREE.Euler(0, 0, 0, 'YXZ').setFromQuaternion(camera.quaternion)
        yaw.current = e.y
        pitch.current = e.x
      }
      locked.current = nowLocked
    }
    const onMouseMove = (e: MouseEvent) => {
      if (!locked.current) return
      // Chromium can report a huge movement delta on the first event after
      // pointer lock engages, and again if the OS pointer wraps a screen edge.
      // Those spikes are what threw the view off with no input from the user.
      if (Math.abs(e.movementX) > 200 || Math.abs(e.movementY) > 200) return

      yaw.current -= e.movementX * 0.002
      pitch.current -= e.movementY * 0.002
      // Stop just short of vertical: at exactly ±90° the YXZ decomposition is
      // degenerate and yaw becomes undefined.
      const limit = Math.PI / 2 - 0.001
      pitch.current = Math.max(-limit, Math.min(limit, pitch.current))
      camera.quaternion.setFromEuler(new THREE.Euler(pitch.current, yaw.current, 0, 'YXZ'))
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    gl.domElement.addEventListener('wheel', onWheel)
    gl.domElement.addEventListener('click', onClick)
    document.addEventListener('pointerlockchange', onPointerLockChange)
    document.addEventListener('mousemove', onMouseMove)

    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      gl.domElement.removeEventListener('wheel', onWheel)
      gl.domElement.removeEventListener('click', onClick)
      document.removeEventListener('pointerlockchange', onPointerLockChange)
      document.removeEventListener('mousemove', onMouseMove)
      if (document.pointerLockElement) document.exitPointerLock()
    }
  }, [camera, gl, center, size, onSpeedChange])

  useFrame(() => {
    if (!locked.current) return
    const dir = new THREE.Vector3()
    const s = speed.current
    if (moveState.current.forward) dir.z -= s
    if (moveState.current.backward) dir.z += s
    if (moveState.current.left) dir.x -= s
    if (moveState.current.right) dir.x += s
    if (moveState.current.up) dir.y += s
    if (moveState.current.down) dir.y -= s
    dir.applyQuaternion(camera.quaternion)
    camera.position.add(dir)
  })

  return null
}

/**
 * Where the walking body is right now, shared between the controller and the
 * avatar that draws it.
 *
 * A ref rather than state: this changes every frame, and re-rendering React at
 * 60fps to move a character would be absurd. The controller writes, the avatar
 * reads, and three.js does the rest.
 */
export interface WalkBodyState {
  /** Feet position in world space. */
  x: number
  y: number
  z: number
  /** Facing, radians, same convention as the camera's yaw. */
  yaw: number
  moving: boolean
}

/** Body radius for wall collision. Not exposed — it is a shape, not a taste. */
const WALK_RADIUS = 0.5
/** Downward acceleration, world units per second squared. */
const WALK_GRAVITY = 20

/**
 * First-person walking. Stands on the MZB collision mesh, not the art.
 *
 * Mouse and key handling deliberately mirrors FlyCamera, including the three
 * fixes recorded in the handoff: yaw/pitch are the source of truth rather than
 * being decomposed from the camera quaternion each event, pitch is clamped just
 * short of vertical to dodge the YXZ gimbal singularity, and movement deltas
 * over 200px are dropped because Chromium spikes them after pointer lock.
 *
 * Unlike FlyCamera this is time-based, not frame-based. Gravity and step-up
 * behave differently at 30 and 144fps if you integrate per frame, and the bug
 * that produces — falling through floors only on fast machines — is miserable
 * to track down.
 */
function WalkCamera({
  world, center, size, scene, body,
}: {
  world: CollisionWorld | null
  center: THREE.Vector3
  size: number
  scene: SceneSettings
  body?: React.RefObject<WalkBodyState>
}) {
  const { camera, gl } = useThree()
  const move = useRef({ forward: false, backward: false, left: false, right: false, run: false, ascend: false })
  const locked = useRef(false)
  const placed = useRef(false)
  const yaw = useRef(0)
  const pitch = useRef(0)
  const velocityY = useRef(0)
  const grounded = useRef(false)
  /** Authoritative feet position. The camera is derived from this, not vice versa. */
  const feetRef = useRef(new THREE.Vector3())
  const debugAccum = useRef(0)
  const wallProbeLog = useRef(0)
  /** Last place we were solidly on the ground, for fall recovery. */
  const lastGrounded = useRef<THREE.Vector3 | null>(null)
  /** Below this height you have left the world; derived from collision bounds. */
  const floorLimit = useRef(-Infinity)
  const debugWalk = useMemo(
    () => new URLSearchParams(window.location.search).get('walkdebug') === '1',
    [],
  )

  // Read tuning through a ref so changing a slider does not tear down the
  // pointer-lock listeners and drop the user out of the view mid-walk.
  const tuning = useRef(scene)
  tuning.current = scene

  useEffect(() => {
    // Snap straight to the ground under the middle of the zone rather than
    // spawning high and falling: the zone's bounding-box centre can easily be
    // underground, and from there "fall until you land" never terminates.
    if (!placed.current) {
      const topY = center.y + size
      let eyeY = center.y + size * 0.05
      if (world) {
        const from = new THREE.Vector3(center.x, topY, center.z)
        const hit = world.groundBelow(from, size * 2.5)
        if (hit) eyeY = hit.y + tuning.current.walkEyeHeight
        console.log(
          `[Walk] spawn from (${center.x.toFixed(1)}, ${topY.toFixed(1)}, ${center.z.toFixed(1)}) ` +
          `size=${size.toFixed(1)} hit=${hit ? hit.y.toFixed(2) : 'none'} eyeY=${eyeY.toFixed(2)}`,
        )
      }
      camera.position.set(center.x, eyeY, center.z)
      feetRef.current.set(center.x, eyeY - tuning.current.walkEyeHeight, center.z)
      // A generous margin below the collision's own lowest point: anything
      // further down is unambiguously outside the world.
      if (world) {
        const bs = world.geometry.boundingSphere
        floorLimit.current = bs ? bs.center.y - bs.radius - 50 : -Infinity
      }
      const e = new THREE.Euler(0, 0, 0, 'YXZ').setFromQuaternion(camera.quaternion)
      yaw.current = e.y
      pitch.current = 0
      camera.quaternion.setFromEuler(new THREE.Euler(0, yaw.current, 0, 'YXZ'))
      placed.current = true
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'KeyW') move.current.forward = true
      if (e.code === 'KeyS') move.current.backward = true
      if (e.code === 'KeyA') move.current.left = true
      if (e.code === 'KeyD') move.current.right = true
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') move.current.run = true
      if (e.code === 'Space') move.current.ascend = true
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'KeyW') move.current.forward = false
      if (e.code === 'KeyS') move.current.backward = false
      if (e.code === 'KeyA') move.current.left = false
      if (e.code === 'KeyD') move.current.right = false
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') move.current.run = false
      if (e.code === 'Space') move.current.ascend = false
    }
    const onClick = () => { gl.domElement.requestPointerLock() }
    const onPointerLockChange = () => {
      const nowLocked = !!document.pointerLockElement
      if (nowLocked && !locked.current) {
        const e = new THREE.Euler(0, 0, 0, 'YXZ').setFromQuaternion(camera.quaternion)
        yaw.current = e.y
        pitch.current = e.x
      }
      locked.current = nowLocked
    }
    const onMouseMove = (e: MouseEvent) => {
      if (!locked.current) return
      if (Math.abs(e.movementX) > 200 || Math.abs(e.movementY) > 200) return
      yaw.current -= e.movementX * 0.002
      pitch.current -= e.movementY * 0.002
      const limit = Math.PI / 2 - 0.001
      pitch.current = Math.max(-limit, Math.min(limit, pitch.current))
      camera.quaternion.setFromEuler(new THREE.Euler(pitch.current, yaw.current, 0, 'YXZ'))
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    gl.domElement.addEventListener('click', onClick)
    document.addEventListener('pointerlockchange', onPointerLockChange)
    document.addEventListener('mousemove', onMouseMove)

    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      gl.domElement.removeEventListener('click', onClick)
      document.removeEventListener('pointerlockchange', onPointerLockChange)
      document.removeEventListener('mousemove', onMouseMove)
      if (document.pointerLockElement) document.exitPointerLock()
    }
  }, [camera, gl, center, size, world])

  useFrame((_, rawDelta) => {
    // Physics runs whether or not the mouse is captured — only *input* needs
    // the lock. Otherwise you hang in mid-air until you click, and the mode
    // cannot be exercised headlessly.
    //
    // walkdebug also accepts keys without pointer lock: a synthetic click in a
    // headless window does not engage lock, so the movement path would be
    // untestable otherwise. Pointer lock itself is unchanged in normal use.
    const active = locked.current || debugWalk
    // A long frame (alt-tab, a zone load) must not teleport you through a wall.
    const dt = Math.min(rawDelta, 0.1)
    const t = tuning.current

    // ── Intent, flattened to the ground plane ──
    // Using the full camera quaternion would make looking up fly you upward.
    const speed = t.walkSpeed * (move.current.run ? t.walkRunMultiplier : 1)
    const forward = new THREE.Vector3(-Math.sin(yaw.current), 0, -Math.cos(yaw.current))
    const right = new THREE.Vector3(Math.cos(yaw.current), 0, -Math.sin(yaw.current))
    const wish = new THREE.Vector3()
    if (active) {
      if (move.current.forward) wish.add(forward)
      if (move.current.backward) wish.sub(forward)
      if (move.current.right) wish.add(right)
      if (move.current.left) wish.sub(right)
    }
    if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(speed * dt)

    if (t.walkNoclip || !world) {
      // Noclip flies along the true view direction, including pitch, and Space
      // rises — otherwise you cannot get out of a pit you clipped into.
      const free = new THREE.Vector3()
      const viewFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
      const viewRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion)
      if (active) {
      if (move.current.forward) free.add(viewFwd)
      if (move.current.backward) free.sub(viewFwd)
      if (move.current.right) free.add(viewRight)
      if (move.current.left) free.sub(viewRight)
      if (move.current.ascend) free.y += 1
      }
      if (free.lengthSq() > 0) free.normalize().multiplyScalar(speed * dt)
      feetRef.current.add(free)
      camera.position.copy(feetRef.current).setY(feetRef.current.y + t.walkEyeHeight)
      velocityY.current = 0
      return
    }

    // The body owns its position; the camera is an output, never the source.
    //
    // This used to read `camera.position` back each frame, which is a stable
    // loop only while the camera sits exactly on the head. In third person the
    // camera is metres behind the body, so the body teleported to where the
    // camera was, the camera moved back again, and the pair marched off across
    // the zone at the camera distance per frame.
    const feet = feetRef.current.clone()

    // ── Horizontal move, sliding along walls ──
    // Two passes: the first stops the move at a wall, the second lets the
    // remainder slide along it. Without the second pass you stick on contact
    // and inside corners feel like glue.
    // Probe at several heights up the body, not one.
    //
    // A floor-like hit disqualifies only *that ray*; the next height up still
    // gets to see the wall behind it. Skipping the whole probe on the first
    // floor-like hit is what let you walk through walls: on rocky ground the
    // low ray hits the walkable slope directly ahead, so the real wall was
    // never tested. Measured in South Gustaberg, every direction returned
    // |normal.y| between 0.64 and 0.88 — all above cos(50°) = 0.643, so every
    // probe bailed out. Walking through the wall then dropped you, because
    // inside the rock there is no floor underneath.
    //
    // Walkable ground belongs to the step-up and gravity code. This only blocks
    // on surfaces too steep to climb.
    const slopeCos = Math.cos((t.walkSlopeLimit * Math.PI) / 180)
    const probeHeights = [
      Math.max(t.walkStepHeight, 0.1) + 0.1,
      t.walkEyeHeight * 0.5,
      t.walkEyeHeight * 0.9,
    ]
    for (let pass = 0; pass < 2 && wish.lengthSq() > 1e-10; pass++) {
      const dist = wish.length()
      const dir = wish.clone().normalize()

      let wallNormal: THREE.Vector3 | null = null
      let nearest = Infinity
      for (const h of probeHeights) {
        const origin = new THREE.Vector3(feet.x, feet.y + h, feet.z)
        const hit = world.castRay(origin, dir, dist + WALK_RADIUS)
        if (!hit) continue
        if (Math.abs(hit.normal.y) >= slopeCos) continue // walkable, not a wall
        if (hit.distance < nearest) {
          nearest = hit.distance
          wallNormal = hit.normal.clone()
        }
      }

      if (debugWalk && wallProbeLog.current < 30) {
        wallProbeLog.current++
        console.log(
          `[Walk] probe pass=${pass} reach=${(dist + WALK_RADIUS).toFixed(2)} ` +
          `wall=${wallNormal ? `d=${nearest.toFixed(2)} ny=${wallNormal.y.toFixed(2)}` : 'none'}`,
        )
      }

      if (!wallNormal) break

      // Collision normals are not reliably oriented, so turn it against travel
      // before projecting — otherwise the slide can shove you into the wall.
      const n = wallNormal
      n.y = 0
      if (n.lengthSq() < 1e-8) break
      n.normalize()
      if (wish.dot(n) > 0) n.negate()
      const into = wish.dot(n)
      if (into >= 0) break
      wish.addScaledVector(n, -into)
    }
    feet.x += wish.x
    feet.z += wish.z

    // ── Depenetration ──
    // The ray probe above stops you walking *into* a wall head-on, but it
    // cannot stop you sliding into one at an angle: once the slide leaves you
    // travelling nearly parallel, the ray no longer hits and the body creeps
    // sideways through the geometry. This gives the body volume and pushes it
    // back out, whatever direction it arrived from.
    //
    // Two heights, because a single sphere at mid-body can slip under a low
    // lip or over a high one.
    // Iterated: one push resolves a simple wall, but in a corner or a crevice
    // escaping one face can leave you touching another, so it repeats until
    // clear. Three passes is plenty for shallow contact and bounds the cost.
    const pushProbe = new THREE.Vector3()
    for (const h of [t.walkEyeHeight * 0.45, t.walkEyeHeight * 0.85]) {
      for (let iter = 0; iter < 3; iter++) {
        pushProbe.set(feet.x, feet.y + h, feet.z)
        const push = world.depenetrate(pushProbe, WALK_RADIUS, slopeCos)
        if (!push) break
        feet.x += push.x
        feet.z += push.z
        if (debugWalk && wallProbeLog.current < 30) {
          wallProbeLog.current++
          console.log(
            `[Walk] depenetrate h=${h.toFixed(2)} iter=${iter} ` +
            `push=(${push.x.toFixed(3)}, ${push.z.toFixed(3)})`,
          )
        }
      }
    }

    // ── Ground ──
    // Search from step height above the feet so small ledges are climbed, and
    // far enough below to catch the floor after a drop.
    const searchTop = new THREE.Vector3(feet.x, feet.y + t.walkStepHeight + 0.05, feet.z)
    const fallReach = Math.max(2, Math.abs(velocityY.current) * dt + 2)
    const ground = world.groundBelow(searchTop, t.walkStepHeight + 0.05 + fallReach)

    if (ground) {
      const slopeOk =
        ground.normal.y >= Math.cos((t.walkSlopeLimit * Math.PI) / 180)
      const rise = ground.y - feet.y

      if (rise <= t.walkStepHeight + 0.05 && slopeOk) {
        // Standing, or stepping up onto something low.
        feet.y = ground.y
        velocityY.current = 0
        grounded.current = true
      } else {
        // Falling, or the surface is too steep to accept as footing.
        velocityY.current -= WALK_GRAVITY * dt
        feet.y += velocityY.current * dt
        if (feet.y < ground.y && slopeOk) {
          feet.y = ground.y
          velocityY.current = 0
          grounded.current = true
        } else {
          grounded.current = false
        }
      }
    } else {
      // Nothing underneath — a hole in the collision, or off the edge.
      velocityY.current -= WALK_GRAVITY * dt
      feet.y += velocityY.current * dt
      grounded.current = false
    }

    // Falling out of the world is recoverable rather than terminal. Collision
    // has gaps, and without this the only way back is toggling noclip.
    if (feet.y < floorLimit.current && lastGrounded.current) {
      feet.copy(lastGrounded.current)
      velocityY.current = 0
      grounded.current = true
      if (debugWalk) console.log('[Walk] fell out of the world — restored last footing')
    } else if (grounded.current) {
      if (!lastGrounded.current) lastGrounded.current = new THREE.Vector3()
      lastGrounded.current.copy(feet)
    }

    feetRef.current.copy(feet)

    // Publish the body before moving the camera, so the avatar and the camera
    // agree on where "here" is within a single frame.
    if (body) {
      body.current.x = feet.x
      body.current.y = feet.y
      body.current.z = feet.z
      body.current.moving = wish.lengthSq() > 1e-10
      // The avatar faces where it is going, not where the camera looks, so
      // turning the camera in third person orbits rather than spinning the body.
      if (body.current.moving) {
        body.current.yaw = Math.atan2(wish.x, wish.z)
      } else if (!t.walkThirdPerson) {
        body.current.yaw = yaw.current
      }
    }

    if (t.walkThirdPerson) {
      // Orbit the head: yaw and pitch aim the camera at the body from behind
      // rather than out of its eyes.
      const pivotY = feet.y + t.walkEyeHeight
      const cp = Math.cos(pitch.current)
      const dir = new THREE.Vector3(
        -Math.sin(yaw.current) * cp,
        Math.sin(pitch.current),
        -Math.cos(yaw.current) * cp,
      )
      camera.position.set(
        feet.x - dir.x * t.walkCameraDistance,
        pivotY - dir.y * t.walkCameraDistance + t.walkCameraHeight,
        feet.z - dir.z * t.walkCameraDistance,
      )
      camera.lookAt(feet.x, pivotY, feet.z)
    } else {
      camera.position.set(feet.x, feet.y + t.walkEyeHeight, feet.z)
    }

    // ?walkdebug=1 reports the body state once a second. There is no other way
    // to see what the controller is doing from a headless run.
    if (debugWalk) {
      debugAccum.current += dt
      if (debugAccum.current >= 0.5) {
        debugAccum.current = 0
        console.log(
          `[Walk] pos(${feet.x.toFixed(1)}, ${feet.y.toFixed(2)}, ${feet.z.toFixed(1)}) ` +
          `grounded=${grounded.current} vy=${velocityY.current.toFixed(2)} ` +
          `locked=${locked.current} moving=${wish.lengthSq() > 0}`,
        )
      }
    }
  })

  return null
}

/**
 * The player character, drawn at the walking body's position.
 *
 * Reads the body ref every frame rather than taking props, so moving does not
 * re-render React. Skinning is the same CPU path the model viewer uses — see
 * `lib/skinning.ts` — which is why the character looks identical in both.
 *
 * Model space is metres and the zone is thousands of units across, but they
 * share a scale: a 2-unit-tall character is right for a 2-unit eye height.
 */
function Avatar({
  character, body, playing, speed, clipIndex,
}: {
  character: ParsedDatFile
  body: React.RefObject<WalkBodyState>
  playing: boolean
  speed: number
  clipIndex: number | null
}) {
  const group = useRef<THREE.Group>(null)
  const time = useRef(0)
  const [built, setBuilt] = useState<BuiltModel | null>(null)

  // Build and dispose in one effect — the StrictMode trap documented in
  // ModelViewer applies here identically.
  useEffect(() => {
    const next = buildModel(character)
    setBuilt(next)
    return () => {
      for (const mesh of next.meshes) {
        mesh.geometry.dispose()
        const mat = mesh.material as THREE.MeshStandardMaterial
        mat.map?.dispose()
        mat.dispose()
      }
    }
  }, [character])

  const inverseBind = useMemo(
    () => character.skeleton?.matrices.map(invertRigidMatrix4) ?? null,
    [character.skeleton],
  )
  const clips = useMemo(
    () => (clipIndex === null
      ? character.animations
      : character.animations.slice(clipIndex, clipIndex + 1)),
    [character.animations, clipIndex],
  )

  useFrame((_, delta) => {
    if (!group.current) return
    const b = body.current

    group.current.position.set(b.x, b.y, b.z)
    // The model is authored facing -Z and the meshes sit under a PI flip, so
    // the body's yaw goes on straight.
    group.current.rotation.y = b.yaw

    if (!built || !character.skeleton || !inverseBind || clips.length === 0) return
    // Freeze the animation when standing still: without a proper idle clip,
    // a walk cycle playing on the spot looks worse than a static pose.
    if (playing && b.moving) time.current += delta * speed

    const pose = poseSkeleton(character.skeleton, clips, inverseBind, time.current)
    skinMeshes(built.skinTargets, pose)
    for (const mesh of built.meshes) {
      mesh.geometry.getAttribute('position').needsUpdate = true
    }
  })

  if (!built) return null

  return (
    <group ref={group}>
      {/* Same two-group arrangement as the model viewer: centre horizontally,
          then flip. The vertical offset puts the model's feet on the ground
          rather than its centre. */}
      <group rotation={[Math.PI, 0, 0]}>
        {/* Feet on the ground, not the centre. Under the PI flip a model-space
            Y becomes world -Y, so the lowest world point sits at zero when the
            offset is -bounds.max.y. Using the bounding-sphere radius instead
            floated the character, since that radius is a diagonal. */}
        <group position={[-built.center.x, -built.bounds.max.y, -built.center.z]}>
          {built.meshes.map((mesh, i) => (
            <primitive key={i} object={mesh} />
          ))}
        </group>
      </group>
    </group>
  )
}

/** Post-processing stack. Rebuilt when the set of enabled effects changes. */
function PostStack({ post }: { post: PostSettings }) {
  // N8AO is expensive; skip it on very large zones regardless of the setting.
  // No instance-count gate. This used to be `instanceCount < 2000`, which meant
  // AO was silently off in every real zone — West Ronfaure alone has 13,115
  // instances — so the control did nothing. N8AO's cost is screen-space and
  // largely independent of scene complexity, so the gate bought little anyway.
  const aoAllowed = post.ao
  const effects: React.ReactElement[] = []

  if (post.smaa) effects.push(<SMAA key="smaa" />)
  if (aoAllowed) {
    effects.push(
      <N8AO key="ao" aoRadius={post.aoRadius} intensity={post.aoIntensity} distanceFalloff={0.5} halfRes />
    )
  }
  if (post.bloom) {
    effects.push(
      <Bloom key="bloom" luminanceThreshold={post.bloomThreshold} luminanceSmoothing={0.4}
        intensity={post.bloomIntensity} mipmapBlur />
    )
  }
  if (post.depthOfField) {
    // worldFocusDistance/worldFocusRange take plain world units, unlike the
    // normalised focusDistance/focalLength pair. The key forces the effect to
    // be rebuilt when they change — the wrapper builds the effect in a memo,
    // so without this the sliders move but the render never updates.
    const dofKey =
      `dof-${post.dofAutofocus ? 'auto' : Math.round(post.dofFocusDistance)}` +
      `-${Math.round(post.dofFocalLength)}-${post.dofBokehScale}`

    effects.push(
      post.dofAutofocus ? (
        // Reads the depth buffer at the centre of the view and focuses there,
        // which is the only practical way to focus in a zone whose geometry
        // sits thousands of units from the camera.
        <Autofocus
          key={dofKey}
          mouse={false}
          smoothTime={0.35}
          bokehScale={post.dofBokehScale}
          worldFocusRange={post.dofFocalLength}
        />
      ) : (
        <DepthOfField
          key={dofKey}
          worldFocusDistance={post.dofFocusDistance}
          worldFocusRange={post.dofFocalLength}
          bokehScale={post.dofBokehScale}
        />
      )
    )
  }
  if (post.colorGrade) {
    effects.push(<HueSaturation key="hs" saturation={post.saturation} />)
    effects.push(<BrightnessContrast key="bc" contrast={post.contrast} brightness={post.brightness} />)
  }
  if (post.vignette) {
    effects.push(<Vignette key="vig" offset={0.3} darkness={post.vignetteDarkness} />)
  }

  if (!post.enabled || effects.length === 0) return null

  // Keyed on which effects are enabled, not on their settings — otherwise
  // dragging a slider would tear down and rebuild the whole composer.
  const composerKey = [
    post.smaa && 'smaa', aoAllowed && 'ao', post.bloom && 'bloom',
    post.depthOfField && 'dof', post.colorGrade && 'grade', post.vignette && 'vignette',
  ].filter(Boolean).join('-')

  return (
    <EffectComposer key={composerKey} multisampling={0}>
      {effects}
    </EffectComposer>
  )
}

export default function ZoneViewer({
  zoneData, lighting, post, scene, pointLights,
  selectedLightId = null, placingLight = false, onPlaceLight,
  inspecting = false, onInspectResult, onFlySpeedChange,
  character = null, characterClip = null,
}: ZoneViewerProps) {
  // Where the walking body is. Written by WalkCamera, read by Avatar.
  const walkBody = useRef<WalkBodyState>({ x: 0, y: 0, z: 0, yaw: 0, moving: false })
  const zoneUniforms = useRef<ZoneUniforms>({
    fogHeightBase: { value: 0 },
    fogHeightRange: { value: 100 },
    bakedInfluence: { value: 1 },
  })

  const timeOfDayRef = useRef(scene.timeOfDay)
  timeOfDayRef.current = scene.timeOfDay

  // Lives outside the Canvas so it survives the remount that a depth-of-field
  // toggle forces. Cleared naturally when the zone changes, since App keys
  // this component on the zone id.
  const cameraPose = useRef<CameraPose | null>(null)

  // Baked colour blend is a live uniform — no material rebuild needed.
  zoneUniforms.current.bakedInfluence.value =
    lighting.mode === 'lit' ? lighting.bakedInfluence : 1

  const skyMaterial = useMemo(() => {
    const initParams = getTimeOfDayParams(12)
    return new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        skyColor: { value: new THREE.Vector3(...initParams.sky) },
        horizonColor: { value: new THREE.Vector3(...initParams.horizon) },
        zenithColor: { value: new THREE.Vector3(...initParams.zenith) },
        nightFactor: { value: initParams.nightFactor },
        sunDir: { value: new THREE.Vector3(0, 1, -0.3).normalize() },
      },
      vertexShader: `
        varying vec3 vWorldPosition;
        void main() {
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          vWorldPosition = worldPos.xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 skyColor;
        uniform vec3 horizonColor;
        uniform vec3 zenithColor;
        uniform float nightFactor;
        uniform vec3 sunDir;
        varying vec3 vWorldPosition;

        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
                     mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
        }
        float fbm(vec2 p) {
          float v = 0.0;
          v += 0.5 * noise(p); p *= 2.01;
          v += 0.25 * noise(p); p *= 2.02;
          v += 0.125 * noise(p);
          return v;
        }

        void main() {
          vec3 dir = normalize(vWorldPosition);
          float y = dir.y;
          vec3 groundColor = zenithColor * 0.3;
          vec3 color;
          if (y < 0.0) {
            float t = smoothstep(-0.4, 0.0, y);
            color = mix(groundColor, horizonColor, t);
          } else {
            float t = smoothstep(0.0, 0.4, y);
            float t2 = smoothstep(0.4, 1.0, y);
            color = mix(horizonColor, skyColor, t);
            color = mix(color, zenithColor, t2);

            if (y > 0.05) {
              vec2 uv = dir.xz / (y + 0.1) * 0.3;
              float clouds = fbm(uv * 3.0);
              clouds = smoothstep(0.35, 0.65, clouds);
              float cloudFade = smoothstep(0.05, 0.25, y) * (1.0 - smoothstep(0.6, 0.9, y));
              vec3 cloudColor = mix(vec3(0.9, 0.92, 0.95), horizonColor * 1.2, nightFactor);
              color = mix(color, cloudColor, clouds * cloudFade * 0.5 * (1.0 - nightFactor * 0.6));
            }

            if (nightFactor > 0.0 && y > 0.1) {
              float phi = atan(dir.x, dir.z);
              float theta = asin(clamp(dir.y, -1.0, 1.0));
              for (int layer = 0; layer < 2; layer++) {
                float scale = layer == 0 ? 80.0 : 140.0;
                float threshold = layer == 0 ? 0.985 : 0.99;
                vec2 sv = vec2(phi, theta) * scale + float(layer) * vec2(37.0, 13.0);
                vec2 cell = floor(sv);
                vec2 f = fract(sv) - 0.5;
                float h = hash(cell);
                if (h > threshold) {
                  float d = length(f);
                  float point = smoothstep(0.25, 0.0, d);
                  float brightness = 0.4 + 0.6 * hash(cell + vec2(7.0, 13.0));
                  color += vec3(point * brightness * nightFactor * 0.6 * smoothstep(0.1, 0.35, y));
                }
              }
            }

            float sunDot = max(dot(dir, sunDir), 0.0);
            if (sunDir.y > -0.1) {
              float sunGlow = pow(sunDot, 64.0) * 0.8;
              float sunHalo = pow(sunDot, 8.0) * 0.15;
              vec3 sunColor = mix(vec3(1.0, 0.95, 0.8), vec3(1.0, 0.5, 0.2), smoothstep(0.1, -0.05, sunDir.y));
              color += sunColor * (sunGlow + sunHalo) * (1.0 - nightFactor);
            }
            if (nightFactor > 0.3) {
              float moonDot = max(dot(dir, -sunDir), 0.0);
              float moonGlow = pow(moonDot, 128.0) * 0.6;
              float moonHalo = pow(moonDot, 16.0) * 0.08;
              color += vec3(0.7, 0.75, 0.9) * (moonGlow + moonHalo) * nightFactor;
            }
          }
          gl_FragColor = vec4(color, 1.0);
        }
      `,
    })
  }, [])

  const lit = lighting.mode === 'lit'

  // A shadow-casting point light needs the shadow map enabled even when the
  // sun's own shadows are switched off.
  const shadowsActive =
    lit && (lighting.shadows || pointLights.lights.some(l => l.castShadow))

  // Depth of field and ambient occlusion both reconstruct world position from
  // the depth buffer, and postprocessing cannot read a logarithmic one — the
  // effect comes out weak or missing entirely. Standard depth costs precision
  // on huge zones, so it is only used when one of those effects is actually on.
  const needsLinearDepth = post.enabled && (post.depthOfField || post.ao)

  // Original mode's terrain shading: the game's DX8 fixed-function pipeline
  // lit vertices with a directional sun against the DAT normals, multiplied
  // over the baked colours. Lambert is the closest three.js analogue —
  // ambient + N·L diffuse, no specular. This is why the files carry
  // per-vertex normals at all; a purely baked renderer would have no use
  // for them.
  const gameSunActive = !lit && lighting.gameSun
  const shaderVariant = gameSunActive ? 'lambert' : 'std'

  const { instancedMeshes, waterMaterials, litMaterials, disposeAll } = useMemo(() => {
    const geometries: THREE.BufferGeometry[] = []
    const materials: THREE.Material[] = []
    const waterMaterials: THREE.ShaderMaterial[] = []
    const litMaterials: THREE.MeshStandardMaterial[] = []

    const geoMap = new Map<number, THREE.BufferGeometry>()
    const matMap = new Map<number, THREE.Material>()
    const waterNames: string[] = []
    let degenerateNormals = 0
    let nonFiniteColors = 0
    let nonFiniteUvs = 0
    let nonFinitePositions = 0
    let blendApplied = 0
    let unresolvedTextures = 0
    let vertexAlphaMeshes = 0
    let uvOverflowMeshes = 0

    /**
     * Water classification is deliberately name-only while the water work is
     * parked. Every structural signal tried so far over-matches:
     *  - unreferenced + 0x2000 translucency flag: correct in West Ronfaure, but
     *    in South Gustaberg it caught 22 meshes including "gus_03", ordinary
     *    terrain, which then rendered as pale washed-out quads across the ground.
     *  - "no opaque texels" in the texture: matched 325 of 349 prefabs, and so
     *    hints the DXT alpha decode is wrong rather than that they are water.
     *
     * Naming alone also misfires ("ron_w01c" is terrain, "ron_riv" is shared
     * between zones), so this stays narrow and errs toward drawing a surface as
     * ordinary geometry. A wrong opaque surface is far less damaging than a
     * wrong translucent one.
     */
    const isWaterPrefab = (
      prefab: { textureName?: string; blending: number; materialIndex: number },
      _idx: number,
    ) => isWaterMesh(prefab)

    // Most-used texture in the zone, used when a prefab's own one is missing.
    const usage = new Map<number, number>()
    for (const p of zoneData.prefabs) {
      if (zoneData.textures[p.materialIndex]) {
        usage.set(p.materialIndex, (usage.get(p.materialIndex) ?? 0) + 1)
      }
    }
    let fallbackTextureIndex = -1
    let bestUsage = 0
    for (const [idx, count] of usage) {
      if (count > bestUsage) { bestUsage = count; fallbackTextureIndex = idx }
    }

    for (let prefabIdx = 0; prefabIdx < zoneData.prefabs.length; prefabIdx++) {
      const prefab = zoneData.prefabs[prefabIdx]
      if (PICK) {
        // Isolation mode: the pick replaces the sky/weather filter rather than
        // stacking with it, so hidden geometry can be examined.
        if (!(prefab.textureName ?? '').toLowerCase().includes(PICK)) continue
      } else if (isSkyWeatherMesh(prefab)) continue

      const isWater = isWaterPrefab(prefab, prefabIdx) && !DISABLE_WATER_SHADER

      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(prefab.vertices), 3))

      // FFXI's stored normals use the opposite handedness from its vertex
      // positions, so the Math.PI flip that puts the zone the right way up
      // leaves them pointing into surfaces instead of out of them. Without
      // this negation, lit mode renders every upward face in shadow.
      // Water keeps the raw normals — its fresnel term was tuned against them.
      //
      // Some zone meshes also carry zero-length or non-finite normals. Unlit
      // materials ignore the normal attribute entirely, so these are harmless
      // in Original mode, but any lit shader normalizes it — and normalizing a
      // zero vector yields NaN. A single NaN fragment poisons the bloom pass,
      // whose mipmap downsampling smears it across the whole frame as white.
      const normalArray = new Float32Array(prefab.normals)
      for (let i = 0; i < normalArray.length; i += 3) {
        let nx = normalArray[i], ny = normalArray[i + 1], nz = normalArray[i + 2]
        const lenSq = nx * nx + ny * ny + nz * nz
        if (!Number.isFinite(lenSq) || lenSq < 1e-12) {
          // Degenerate — substitute a valid up-facing normal.
          nx = 0; ny = 1; nz = 0
          degenerateNormals++
        } else if (!isWater) {
          nx = -nx; ny = -ny; nz = -nz
        }
        normalArray[i] = nx; normalArray[i + 1] = ny; normalArray[i + 2] = nz
      }
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normalArray, 3))

      // The fourth vertex-colour channel is a blend weight, not padding. FFXI
      // lays overlay tiles over base terrain and fades them in with it: a patch
      // whose vertices carry alpha 0.5 is meant to sit at half strength over
      // what is beneath. Discarding it drew those tiles fully opaque, which is
      // what produced the hard-edged squares. Confirmed with the inspector —
      // anomalous and correct ground share texture gus_02 and blending 0, and
      // differ only in vertex alpha (0.50 against 1.00).
      let minVertexAlpha = 1
      const vertexColors: number[] = []
      for (let i = 0; i < prefab.colors.length; i += 4) {
        const a = prefab.colors[i + 3]
        if (a < minVertexAlpha) minVertexAlpha = a
        vertexColors.push(prefab.colors[i], prefab.colors[i + 1], prefab.colors[i + 2], a)
      }
      // Only meshes that actually carry a partial weight need the blended path;
      // everything else stays opaque so terrain sorting is unaffected.
      // Kept only as a diagnostic. Treating vertex alpha as a blend weight and
      // making those meshes transparent was tried for South Gustaberg's pale
      // tiles and abandoned: 288 of 397 meshes in that zone carry alpha below
      // 1, so it does not distinguish the bad tiles from ordinary ground. As
      // with the RGB channels, 128 looks like the neutral value here rather
      // than a half-strength weight.
      if (minVertexAlpha < 0.99) vertexAlphaMeshes++

      // Normals are sanitised above because a NaN there whites out the entire
      // frame through bloom's mipmap downsampling. Positions, UVs and vertex
      // colours reach the shader too and were never checked, and any one of
      // them produces the same failure: a NaN fragment, smeared by bloom, until
      // the whole viewport renders white. This is the "white screen in some
      // places with bloom on" report — a symptom that only shows from the
      // camera angles where the offending triangle is on screen, which is why
      // an in-place angle sweep can miss it entirely.
      const colorArray = new Float32Array(vertexColors.filter((_, i) => i % 4 !== 3))
      for (let i = 0; i < colorArray.length; i++) {
        if (!Number.isFinite(colorArray[i])) { colorArray[i] = 1; nonFiniteColors++ }
      }
      const uvArray = new Float32Array(prefab.uvs)
      for (let i = 0; i < uvArray.length; i++) {
        if (!Number.isFinite(uvArray[i])) { uvArray[i] = 0; nonFiniteUvs++ }
      }
      const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute
      const posArray = posAttr.array as Float32Array
      for (let i = 0; i < posArray.length; i++) {
        if (!Number.isFinite(posArray[i])) { posArray[i] = 0; nonFinitePositions++ }
      }

      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colorArray, 3))
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvArray, 2))

      // FFXI quantises these UVs to eighths and keeps a 1/8 margin at the
      // edges, so a mesh reaching past 1.0 is reaching into a neighbouring
      // region rather than asking for a genuine tile. Under RepeatWrapping that
      // wraps to the far edge and samples the wrong part of the sheet, which is
      // what South Gustaberg's mismatched ground tiles are.
      let uvOutOfRange = false
      for (let i = 0; i < prefab.uvs.length; i++) {
        const t = prefab.uvs[i]
        if (t < -0.001 || t > 1.001) { uvOutOfRange = true; break }
      }
      if (uvOutOfRange) uvOverflowMeshes++

      let maxIndex = 0
      for (let i = 0; i < prefab.indices.length; i++) {
        if (prefab.indices[i] > maxIndex) maxIndex = prefab.indices[i]
      }
      geometry.setIndex(
        maxIndex > 65535
          ? new THREE.BufferAttribute(new Uint32Array(prefab.indices), 1)
          : new THREE.BufferAttribute(new Uint16Array(prefab.indices), 1)
      )
      geometry.computeBoundingBox()
      geometry.computeBoundingSphere()
      geometries.push(geometry)
      geoMap.set(prefabIdx, geometry)

      // A prefab whose material index does not resolve to a real texture would
      // otherwise get a material with no map at all, and MeshBasicMaterial's
      // default colour is white — which is why untextured surfaces rendered as
      // flat white sheets. Fall back to the zone's most-used texture instead.
      let tex = zoneData.textures[prefab.materialIndex]
      if (!tex) {
        unresolvedTextures++
        tex = zoneData.textures[fallbackTextureIndex]
      }
      let texture: THREE.DataTexture | null = null
      if (tex) {
        texture = new THREE.DataTexture(new Uint8Array(tex.rgba), tex.width, tex.height, THREE.RGBAFormat)
        // Repeat is correct. Clamping meshes whose UVs run past 0..1 was tried
        // for South Gustaberg's mismatched ground tiles and made things worse:
        // cliff faces smeared into long streaks, so that overflow is genuine
        // tiling. The tiles are not a UV sampling problem.
        texture.wrapS = THREE.RepeatWrapping
        texture.wrapT = THREE.RepeatWrapping
        texture.needsUpdate = true
        texture.magFilter = THREE.LinearFilter
        texture.minFilter = THREE.LinearMipmapLinearFilter
        texture.generateMipmaps = true
        texture.flipY = false
        texture.colorSpace = THREE.SRGBColorSpace
      }

      if (isWater) {
        if (prefab.textureName) waterNames.push(prefab.textureName)
        const waterMat = createWaterMaterial(texture)
        waterMaterials.push(waterMat)
        materials.push(waterMat)
        matMap.set(prefabIdx, waterMat)
      } else {
        // Alpha testing stays gated on the blending flag alone.
        //
        // Two attempts to widen it have both punched holes through terrain.
        // Enabling it for every mesh failed first. Then the share of fully
        // transparent texels looked like a clean discriminator — Lufaise's
        // waterfall "lat_wf" is 50% clear against South Gustaberg's ground
        // "gus_02" at 6% — but applying it at a 25% cutoff shot West Ronfaure's
        // grass full of holes, so its ground textures are high-clear too and
        // the measure does not separate the cases.
        //
        // The consequence is that cutouts whose blending flag is 0 still draw
        // their transparent regions as solid colour: pale slabs across Lufaise's
        // waterfall, black rectangles behind foliage. Fixing it needs a signal
        // that actually distinguishes them, and neither the blending flag nor
        // texture alpha statistics do.
        // Noesis's blendhack, applied the way it actually works: alpha test
        // broadly, but force opaque any mesh whose surface is almost entirely
        // zero-alpha. Such a mesh cannot intend transparency — it would be
        // invisible — so its alpha channel is carrying PS2 mask data instead.
        // Those are the meshes that vanish when blending is enabled globally.
        // Alpha testing is gated on the blending flag alone.
        //
        // Widening it has been attempted five ways and every one damaged the
        // zones: alpha testing everything, gating on whole-sheet clear
        // percentage, gating on a per-mesh zero-alpha share at 0.3 and 0.02,
        // and Noesis's blendhack guard forcing near-fully-transparent meshes
        // opaque. The first four shot terrain full of holes; the guard turned
        // cutout sprites into black boxes. Per-mesh measurement does not
        // separate the cases here — West Ronfaure's terrain ron_w01c measures
        // 0.50 transparent, the same as Lufaise's lat_wf waterfall.
        //
        // So cutouts whose blending flag is 0 still draw their transparent
        // regions as solid colour. Fixing that needs a signal none of the
        // alpha statistics provide; suspect the DXT3 decode first.
        const useAlpha = prefab.blending > 0
        const common = {
          ...(texture && { map: texture }),
          vertexColors: true,
          side: THREE.DoubleSide,
          wireframe: scene.wireframe,
          ...(useAlpha && {
            alphaTest: 0.1,
            polygonOffset: true,
            polygonOffsetFactor: -1,
            polygonOffsetUnits: -1,
          }),
        }

        // Unlit reproduces the game exactly; lit uses the DAT's per-vertex
        // normals so real lights and shadows have something to work with.
        const mat = lit
          ? new THREE.MeshStandardMaterial({
              ...common,
              roughness: lighting.roughness,
              metalness: lighting.metalness,
            })
          : gameSunActive
            ? new THREE.MeshLambertMaterial(common)
            : new THREE.MeshBasicMaterial(common)

        // Diagnostic: ?blend= overrides how the picked meshes composite.
        //
        // Deliberately gated behind PICK. The blend flag 0x8000 is carried by
        // the weather domes, the cloud layers and the rainbow as well as the
        // waterfall, so changing its handling globally changes many zones at
        // once — this exists to find out what the flag means before anything
        // global is decided.
        if (PICK && BLEND_MODE) {
          const m = mat as THREE.MeshBasicMaterial
          if (BLEND_MODE === 'additive') {
            // A greyscale streak sheet is authored to be added to what is
            // behind it. Depth writing goes off or the ribbons occlude each
            // other, and alphaTest goes off or the cutout eats the soft edges
            // that make it read as spray.
            m.transparent = true
            m.blending = THREE.AdditiveBlending
            m.depthWrite = false
            m.alphaTest = 0
          } else if (BLEND_MODE === 'alpha') {
            m.transparent = true
            m.blending = THREE.NormalBlending
            m.depthWrite = false
            m.alphaTest = 0
          } else if (BLEND_MODE === 'opaque') {
            m.transparent = false
            m.blending = THREE.NormalBlending
            m.alphaTest = 0
          }
          // FFXI stores very dark vertex colours on this geometry (the pond bed
          // measures 0.07), which multiplies an additive layer down to nothing.
          if (NO_VCOLOR) m.vertexColors = false
          // alphaTest and vertexColors are shader defines (USE_ALPHATEST,
          // USE_COLOR). Changing them after construction does nothing at all
          // unless the program is rebuilt.
          m.needsUpdate = true
          blendApplied++
        }

        if (lit) litMaterials.push(mat as THREE.MeshStandardMaterial)
        patchZoneShader(mat, zoneUniforms.current, lit, shaderVariant)
        materials.push(mat)
        matMap.set(prefabIdx, mat)
      }
    }

    const normalGroups = new Map<number, THREE.Matrix4[]>()
    const mirroredGroups = new Map<number, THREE.Matrix4[]>()
    for (const inst of zoneData.instances) {
      if (!geoMap.has(inst.meshIndex)) continue
      const matrix = new THREE.Matrix4().fromArray(inst.transform)
      const target = matrix.determinant() < 0 ? mirroredGroups : normalGroups
      let arr = target.get(inst.meshIndex)
      if (!arr) { arr = []; target.set(inst.meshIndex, arr) }
      arr.push(matrix)
    }

    function cloneWithFlippedWinding(src: THREE.BufferGeometry): THREE.BufferGeometry {
      const clone = src.clone()
      const index = clone.index
      if (index) {
        const arr = index.array as Uint16Array | Uint32Array
        for (let i = 0; i < arr.length; i += 3) {
          const tmp = arr[i + 1]; arr[i + 1] = arr[i + 2]; arr[i + 2] = tmp
        }
        index.needsUpdate = true
      }
      return clone
    }

    const instancedMeshes: THREE.InstancedMesh[] = []

    for (const [meshIdx, matrices] of normalGroups) {
      const geo = geoMap.get(meshIdx); const mat = matMap.get(meshIdx)
      if (!geo || !mat) continue
      const mesh = new THREE.InstancedMesh(geo, mat, matrices.length)
      mesh.userData.prefabIdx = meshIdx
      mesh.frustumCulled = false
      for (let i = 0; i < matrices.length; i++) mesh.setMatrixAt(i, matrices[i])
      mesh.instanceMatrix.needsUpdate = true
      instancedMeshes.push(mesh)
    }

    for (const [meshIdx, matrices] of mirroredGroups) {
      const geo = geoMap.get(meshIdx); const mat = matMap.get(meshIdx)
      if (!geo || !mat) continue
      const flippedGeo = cloneWithFlippedWinding(geo)
      geometries.push(flippedGeo)
      const mesh = new THREE.InstancedMesh(flippedGeo, mat, matrices.length)
      mesh.userData.prefabIdx = meshIdx
      mesh.frustumCulled = false
      for (let i = 0; i < matrices.length; i++) mesh.setMatrixAt(i, matrices[i])
      mesh.instanceMatrix.needsUpdate = true
      instancedMeshes.push(mesh)
    }

    if (degenerateNormals > 0) {
      console.log(`[ZoneViewer] replaced ${degenerateNormals} degenerate normals`)
    }
    if (PICK && BLEND_MODE) {
      console.log(`[BLEND] mode=${BLEND_MODE} novcolor=${NO_VCOLOR} applied to ${blendApplied} materials`)
    }
    if (nonFinitePositions + nonFiniteUvs + nonFiniteColors > 0) {
      console.log(
        `[NANSCAN] replaced non-finite values — positions ${nonFinitePositions}, ` +
        `uvs ${nonFiniteUvs}, colors ${nonFiniteColors}`
      )
    }
    if (CENSUS) {
      // Every unreferenced prefab, in full. This is deliberately not filtered
      // by isSkyWeatherMesh: the point is to see what that filter catches and
      // what it misses, so it has to report the skipped ones too.
      const referenced = new Set(zoneData.instances.map(i => i.meshIndex))
      const census = zoneData.prefabs
        .map((pf, i) => {
          let minX = Infinity, minY = Infinity, minZ = Infinity
          let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
          for (let v = 0; v < pf.vertices.length; v += 3) {
            const x = pf.vertices[v], y = pf.vertices[v + 1], z = pf.vertices[v + 2]
            if (x < minX) minX = x; if (x > maxX) maxX = x
            if (y < minY) minY = y; if (y > maxY) maxY = y
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
          }
          const tex = zoneData.textures[pf.materialIndex]
          return {
            i,
            // Raw, with its internal spacing intact — the two-field split is
            // the entire lead and collapsing whitespace would destroy it.
            name: pf.textureName ?? '',
            mat: pf.materialIndex,
            texOk: !!tex,
            tw: tex ? tex.width : 0,
            th: tex ? tex.height : 0,
            blend: pf.blending,
            w: Math.round(maxX - minX),
            h: Math.round(maxY - minY),
            d: Math.round(maxZ - minZ),
            // Where it is parked, in raw prefab space. Two prefabs sharing a
            // centre are the same effect in two states; a dome centred on the
            // zone origin is scenery, one parked off to the side is stored.
            cx: Math.round((minX + maxX) / 2),
            cy: Math.round((minY + maxY) / 2),
            cz: Math.round((minZ + maxZ) / 2),
            verts: pf.vertices.length / 3,
            skip: isSkyWeatherMesh(pf),
          }
        })
        .filter(o => !referenced.has(o.i))
        .sort((a, b) => (b.w + b.d) - (a.w + a.d))
      console.log(
        `[CENSUS] ${census.length} unreferenced of ${zoneData.prefabs.length} prefabs: ` +
        JSON.stringify(census)
      )
    }
    // Noesis needs a -ff11renderunref flag to show FFXI water, which suggests
    // water planes may sit in the file without the instance list referencing
    // them. We only build geometry from instances, so those would never render.
    {
      const referenced = new Set(zoneData.instances.map(i => i.meshIndex))
      // Size matters as much as the name here: sky and weather domes are
      // unreferenced prefabs that span the whole zone, and identifying them by
      // extent is more robust than collecting texture prefixes forever.
      const orphans = zoneData.prefabs
        .map((pf, i) => {
          let minX = Infinity, minY = Infinity, minZ = Infinity
          let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
          for (let v = 0; v < pf.vertices.length; v += 3) {
            const x = pf.vertices[v], y = pf.vertices[v + 1], z = pf.vertices[v + 2]
            if (x < minX) minX = x; if (x > maxX) maxX = x
            if (y < minY) minY = y; if (y > maxY) maxY = y
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
          }
          return {
            i,
            name: pf.textureName ?? '',
            blend: pf.blending,
            w: Math.round(maxX - minX),
            h: Math.round(maxY - minY),
            d: Math.round(maxZ - minZ),
            verts: pf.vertices.length / 3,
            skipped: isSkyWeatherMesh(pf),
          }
        })
        .filter(o => !referenced.has(o.i) && !o.skipped)
        .sort((a, b) => (b.w + b.d) - (a.w + a.d))
      console.log(
        `[ORPHANS] ${orphans.length} unreferenced and still drawn, largest first: ` +
        JSON.stringify(orphans.slice(0, 6))
      )
    }

    if (uvOverflowMeshes > 0) {
      console.log(`[ZoneViewer] ${uvOverflowMeshes} of ${zoneData.prefabs.length} meshes have UVs outside 0..1`)
    }
    if (vertexAlphaMeshes > 0) {
      console.log(`[ZoneViewer] ${vertexAlphaMeshes} meshes blend via vertex alpha`)
    }
    if (unresolvedTextures > 0) {
      console.log(`[ZoneViewer] ${unresolvedTextures} prefabs had no usable texture → fallback[${fallbackTextureIndex}]`)
    }
    if (waterMaterials.length > 0) {
      console.log(`[ZoneViewer] ${waterMaterials.length} water surfaces: ${waterNames.join(', ')}`)
    }

    // Unreferenced prefabs. FFXI parks its water planes in the file without an
    // entry in the instance list, which is why Noesis needs -ff11renderunref to
    // show them and why they never appeared here. Their vertices are already in
    // world space, so they render at identity.
    {
      const referenced = new Set(zoneData.instances.map(i => i.meshIndex))
      let added = 0
      for (const [prefabIdx, geo] of geoMap) {
        if (SKIP_UNREFERENCED) continue
        if (referenced.has(prefabIdx)) continue
        const mat = matMap.get(prefabIdx)
        if (!mat) continue
        const mesh = new THREE.InstancedMesh(geo, mat, 1)
        mesh.userData.textureName = zoneData.prefabs[prefabIdx]?.textureName ?? ''
        mesh.userData.matIdx = zoneData.prefabs[prefabIdx]?.materialIndex ?? -1
        mesh.frustumCulled = false
        mesh.setMatrixAt(0, new THREE.Matrix4())
        mesh.instanceMatrix.needsUpdate = true
        instancedMeshes.push(mesh)
        added++
      }
      if (added > 0) console.log(`[ZoneViewer] rendered ${added} unreferenced prefabs`)
    }

    const disposeAll = () => {
      geometries.forEach(g => g.dispose())
      materials.forEach(m => {
        const withMap = m as THREE.MeshBasicMaterial
        if ('map' in m && withMap.map) withMap.map.dispose()
        m.dispose()
      })
      instancedMeshes.forEach(m => m.dispose())
    }

    return {
      instancedMeshes, waterMaterials, litMaterials,
      totalInstances: zoneData.instances.length, disposeAll,
    }
    // Rebuild materials when PCSS is toggled so they compile against the
    // shadow chunk that is actually installed.
  }, [zoneData, lit, scene.wireframe, shaderVariant])

  // Live material tweaks that do not require rebuilding geometry.
  useEffect(() => {
    for (const mat of litMaterials) {
      mat.roughness = lighting.roughness
      mat.metalness = lighting.metalness
      mat.needsUpdate = true
    }
  }, [litMaterials, lighting.roughness, lighting.metalness])

  // Shadow casting is a per-mesh flag, toggled without a rebuild.
  useEffect(() => {
    for (const mesh of instancedMeshes) {
      mesh.castShadow = shadowsActive
      mesh.receiveShadow = shadowsActive
    }
  }, [instancedMeshes, shadowsActive])

  // Built once per zone: converts collision to world space and builds its BVH.
  // Costs a few hundred ms on a large zone, so it must not be inside a memo
  // that re-runs on settings changes.
  const collisionWorld = useMemo(() => {
    if (!zoneData.collision) return null
    const t0 = performance.now()
    const built = new CollisionWorld(zoneData.collision)
    console.log(`[Collision] BVH built in ${Math.round(performance.now() - t0)}ms`)
    return built
  }, [zoneData.collision])

  useEffect(() => {
    return () => { collisionWorld?.dispose() }
  }, [collisionWorld])

  // ?walkdebug=1 exposes the collision world so harnesses can probe it directly,
  // rather than trying to steer the player into a wall by luck.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('walkdebug') !== '1') return
    ;(window as unknown as { __collision?: CollisionWorld | null }).__collision = collisionWorld
  }, [collisionWorld])

  const { center, size, camPos, farPlane } = useMemo(() => {
    const bbox = new THREE.Box3()
    if (PICK) {
      // Isolation mode frames the picked geometry instead of the zone. The
      // bounds are otherwise built from the instance list, and everything worth
      // picking — every weather dome and effect — is unreferenced, so the
      // camera framed the whole empty zone and the subject sat off-screen.
      // Prefab vertices are already in world space, under the same Y/Z flip the
      // zone group applies.
      for (const p of zoneData.prefabs) {
        if (!(p.textureName ?? '').toLowerCase().includes(PICK)) continue
        for (let v = 0; v + 2 < p.vertices.length; v += 3) {
          bbox.expandByPoint(new THREE.Vector3(p.vertices[v], -p.vertices[v + 1], -p.vertices[v + 2]))
        }
      }
    }
    if (PICK) {
      console.log(`[PICK] "${PICK}" bounds ${bbox.isEmpty() ? 'EMPTY — falling back to zone' :
        `min(${bbox.min.x.toFixed(1)},${bbox.min.y.toFixed(1)},${bbox.min.z.toFixed(1)}) ` +
        `max(${bbox.max.x.toFixed(1)},${bbox.max.y.toFixed(1)},${bbox.max.z.toFixed(1)})`}`)
    }
    if (bbox.isEmpty()) {
      for (const inst of zoneData.instances) {
        const prefab = zoneData.prefabs[inst.meshIndex]
        if (!prefab) continue
        bbox.expandByPoint(new THREE.Vector3(inst.transform[12], -inst.transform[13], -inst.transform[14]))
      }
    }
    const center = new THREE.Vector3()
    const sizeVec = new THREE.Vector3()
    bbox.getCenter(center)
    bbox.getSize(sizeVec)
    const diagonalSize = Math.sqrt(sizeVec.x ** 2 + sizeVec.y ** 2 + sizeVec.z ** 2) || 100

    const verticalSize = sizeVec.y || 100
    zoneUniforms.current.fogHeightBase.value = center.y - verticalSize * 0.3
    zoneUniforms.current.fogHeightRange.value = verticalSize * 0.7

    // Isolation mode looks down the *thinnest* axis. Most of this geometry is a
    // flat card — the Misareaux rainbow measures 0 units across X — so the
    // default view from +Z catches it exactly edge-on and renders a scene that
    // looks empty but is not. Viewing along the degenerate axis is the only
    // angle that shows a card at all.
    let camPos: [number, number, number] = [
      center.x, center.y + diagonalSize * 0.15, center.z + diagonalSize * 0.4,
    ]
    if (PICK) {
      const dist = Math.max(diagonalSize * 0.9, 5)
      // `pickaxis` overrides the thin-axis guess. A stack of rings reads as a
      // flat annulus from above and as a funnel from the side, so which axis
      // you look down decides what the thing appears to be.
      const forced = typeof window !== 'undefined'
        ? new URLSearchParams(window.location.search).get('pickaxis')
        : null
      const thin = Math.min(sizeVec.x, sizeVec.y, sizeVec.z)
      const axis = forced ?? (thin === sizeVec.x ? 'x' : thin === sizeVec.z ? 'z' : 'y')
      if (axis === 'x') camPos = [center.x + dist, center.y, center.z]
      else if (axis === 'z') camPos = [center.x, center.y, center.z + dist]
      else camPos = [center.x, center.y + dist, center.z]
      console.log(`[PICK] camera ${camPos.map(n => n.toFixed(1)).join(',')} ` +
        `looking at ${center.toArray().map(n => n.toFixed(1)).join(',')} size ${diagonalSize.toFixed(1)}`)
    }

    return { center, size: diagonalSize, camPos, farPlane: Math.max(10000, diagonalSize * 3) }
  }, [zoneData])

  useEffect(() => () => { disposeAll() }, [disposeAll])

  // Diagnostic: ?gotowater=1 parks the camera beside the first water surface.
  // Real water planes are unreferenced prefabs carrying blend 0x2000, so the
  // centroid of their own vertices is the target — they have no instances.
  const waterFocus = useMemo(() => {
    if (typeof window === 'undefined') return null
    if (!new URLSearchParams(window.location.search).has('gotowater')) return null
    const referenced = new Set(zoneData.instances.map(i => i.meshIndex))
    for (let i = 0; i < zoneData.prefabs.length; i++) {
      const p = zoneData.prefabs[i]
      if (referenced.has(i) || (p.blending & 0x2000) === 0) continue
      const v = p.vertices
      if (v.length < 3) continue
      // First vertex rather than the centroid: one prefab can hold several
      // disjoint river segments, whose centroid lands on dry land between them.
      // Same world conversion the zone group applies: Y and Z are flipped.
      return new THREE.Vector3(v[0], -v[1], -v[2])
    }
    for (const inst of zoneData.instances) {
      const prefab = zoneData.prefabs[inst.meshIndex]
      if (!prefab || !isWaterMesh(prefab)) continue
      return new THREE.Vector3(inst.transform[12], -inst.transform[13], -inst.transform[14])
    }
    return null
  }, [zoneData])

  if (zoneData.prefabs.length === 0 || zoneData.instances.length === 0) return null

  const cx = center.x, cy = center.y, cz = center.z

  return (
    <Canvas
      camera={{ position: camPos, fov: 60, near: 1, far: farPlane }}
      // Depth of field reads the depth buffer, and postprocessing cannot
      // interpret a logarithmic one — every pixel comes back at the same
      // apparent depth, so the whole frame blurs no matter where you focus.
      // Standard depth costs some precision on huge zones, so it is only used
      // while depth of field is switched on.
      key={`canvas-${needsLinearDepth ? 'standard-depth' : 'log-depth'}`}
      gl={{
        antialias: false,
        logarithmicDepthBuffer: !needsLinearDepth,
        toneMappingExposure: post.exposure,
        // Keeps the rendered frame readable after the draw call so the
        // screenshot button can pull a PNG straight off the canvas.
        preserveDrawingBuffer: true,
      }}
      shadows={shadowsActive}
      className="viewer-canvas"
    >
      <CameraPersistence store={cameraPose} />
      <RendererSettings post={post} shadows={shadowsActive} />
      <SkyAnimator skyMaterial={skyMaterial} timeOfDayRef={timeOfDayRef} exposure={post.exposure} />
      {waterMaterials.length > 0 && (
        <WaterAnimator materials={waterMaterials} vertexTint={scene.waterTint} />
      )}

      <SkyEnvironment
        skyMaterial={skyMaterial}
        timeOfDay={scene.timeOfDay}
        enabled={lit && lighting.skyIBL}
        intensity={lighting.iblIntensity}
      />

      <SunLight lighting={lighting} timeOfDay={scene.timeOfDay} waterMaterials={waterMaterials} />

      {gameSunActive && (
        <GameSun
          intensity={lighting.gameSunIntensity}
          ambient={lighting.gameAmbient}
          timeOfDay={scene.timeOfDay}
        />
      )}

      {/* Point lights only affect lit materials — the unlit ones ignore them. */}
      {lit && <PointLights settings={pointLights} selectedId={selectedLightId} />}
      {lit && onPlaceLight && (
        <LightPlacer meshes={instancedMeshes} active={placingLight} onPlace={onPlaceLight} />
      )}

      {scene.showSky && scene.fogDensity > 0 ? (
        <>
          <SkyDome size={farPlane * 0.9} material={skyMaterial} />
          <FogController size={size} density={scene.fogDensity} />
        </>
      ) : scene.showSky ? (
        <SkyDome size={farPlane * 0.9} material={skyMaterial} />
      ) : (
        <BackgroundUpdater
          timeOfDayRef={timeOfDayRef}
          color={scene.backgroundColor}
          followTime={scene.backgroundFollowsTime}
        />
      )}

      {/* A deep-linked orientation takes over from the controls, which would
          otherwise re-aim the camera on their next update. */}
      {hasCameraOverride ? (
        <CameraOrientation />
      ) : scene.cameraMode === 'orbit' ? (
        <SmartOrbitControls size={size} lookAt={PICK ? center : undefined} />
      ) : scene.cameraMode === 'walk' ? (
        <WalkCamera world={collisionWorld} center={center} size={size} scene={scene} body={walkBody} />
      ) : (
        <FlyCamera center={center} size={size} onSpeedChange={onFlySpeedChange} />
      )}

      {waterFocus && <CameraGoTo target={waterFocus} />}
      {onInspectResult && (
        <SurfaceInspector
          meshes={instancedMeshes}
          zoneData={zoneData}
          active={inspecting}
          onResult={onInspectResult}
        />
      )}

      {/* FFXI stores Y inverted — the PI rotation puts the zone the right way up. */}
      <group rotation={[Math.PI, 0, 0]}>
        {instancedMeshes.map((mesh, i) => (
          <primitive key={i} object={mesh} />
        ))}
      </group>

      {character && scene.cameraMode === 'walk' && (
        <Avatar
          character={character}
          body={walkBody}
          playing
          speed={1}
          clipIndex={characterClip}
        />
      )}

      {/* Already world space — deliberately outside the rotated group. */}
      {scene.showCollision && <CollisionOverlay world={collisionWorld} />}

      <PostStack post={post} />
    </Canvas>
  )
}
