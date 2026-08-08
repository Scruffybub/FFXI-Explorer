/**
 * Render settings for the zone viewer.
 *
 * FFXI baked all of its lighting into per-vertex colours back in 2002, so the
 * game's own look is "unlit": no light sources, just painted-on shading. The
 * viewer keeps that as the default, and can switch to a physically lit mode
 * that uses the per-vertex normals stored in the DAT files.
 */

/** What the surface inspector reports for a clicked mesh. */
export interface SurfaceInfo {
  empty?: boolean
  textureName?: string
  materialIndex?: number
  materialType?: string
  hasMap?: boolean
  blending?: string
  classifiedAsWater?: boolean
  texture?: {
    size: string
    avg: string
    avgAlpha: number
    pctOpaque: number
    pctTransparent: number
  } | null
  uvRange?: string | null
  vertexColour?: string | null
  distance?: number
  vertexCount?: number
}

export type LightingMode = 'baked' | 'lit'

export type ToneMappingMode = 'none' | 'linear' | 'reinhard' | 'cineon' | 'aces' | 'agx' | 'neutral'

export interface LightingSettings {
  mode: LightingMode

  /**
   * How much of FFXI's baked vertex colour survives in lit mode.
   * 1 = keep it all (rich, but shadows read twice), 0 = pure dynamic light.
   * Around 0.35 usually keeps the art's character without muddying new shadows.
   */
  bakedInfluence: number

  /**
   * Original mode's light rig: the game's own fixed-function model. FFXI's
   * DX8 pipeline lit zone vertices with one directional sun plus ambient,
   * using the normals stored in the DATs — the baked vertex colours are
   * multiplied on top. This is the terrain shading visible in-game.
   */
  gameSun: boolean
  gameSunIntensity: number
  gameAmbient: number

  sunIntensity: number
  sunColor: string
  /** Tie the sun's position to the time-of-day slider instead of the manual angles. */
  sunFollowsTimeOfDay: boolean
  sunAzimuth: number
  sunElevation: number

  ambientIntensity: number
  skyColor: string
  groundColor: string

  roughness: number
  metalness: number

  /**
   * Light the scene with the procedural sky itself, so surfaces pick up colour
   * from the direction they face instead of a flat two-tone ambient term.
   */
  skyIBL: boolean
  iblIntensity: number

  /** Contact-hardening shadows: sharp where objects meet, softer further away. */
  softShadows: boolean
  softShadowSize: number
  softShadowSamples: number

  shadows: boolean
  shadowMapSize: number
  /** World-space radius the shadow camera covers. Smaller = sharper shadows. */
  shadowRadius: number
  shadowBias: number
  shadowNormalBias: number
  /** Soften shadow edges (only affects the VSM/PCF-soft shadow map types). */
  shadowSoftness: number
}

/**
 * A user-placed point light. FFXI's zone files carry no light data at all, so
 * these are placed by hand — click a surface in the view to drop one where a
 * torch or brazier sits.
 */
export interface PointLightSpec {
  id: number
  position: [number, number, number]
  color: string
  intensity: number
  /** Falloff radius in world units. 0 means no limit. */
  distance: number
  decay: number
  castShadow: boolean
  /** Gentle flicker, for torches and braziers. 0 = steady. */
  flicker: number
}

export interface PointLightSettings {
  lights: PointLightSpec[]
  /** Point light that follows the camera — handy for exploring dark interiors. */
  headlamp: boolean
  headlampIntensity: number
  headlampColor: string
  headlampDistance: number
  /** Show a small marker at each light so it can be found and selected. */
  showGizmos: boolean
}

export const DEFAULT_POINT_LIGHTS: PointLightSettings = {
  lights: [],
  headlamp: false,
  headlampIntensity: 12,
  headlampColor: '#ffe9c4',
  headlampDistance: 140,
  showGizmos: true,
}

/** Sensible starting values for a newly placed light. */
export const NEW_POINT_LIGHT: Omit<PointLightSpec, 'id' | 'position'> = {
  color: '#ffb257',
  intensity: 30,
  distance: 90,
  decay: 1.6,
  castShadow: false,
  flicker: 0.25,
}

export interface PostSettings {
  enabled: boolean
  toneMapping: ToneMappingMode
  exposure: number

  smaa: boolean

  ao: boolean
  aoIntensity: number
  aoRadius: number

  bloom: boolean
  bloomIntensity: number
  bloomThreshold: number

  colorGrade: boolean
  saturation: number
  contrast: number
  brightness: number

  vignette: boolean
  vignetteDarkness: number

  depthOfField: boolean
  /** Focus on whatever sits at the centre of the view. */
  dofAutofocus: boolean
  /** Distance to the focal plane, in world units. Used when autofocus is off. */
  dofFocusDistance: number
  /** How quickly things fall out of focus either side of that plane. */
  dofFocalLength: number
  dofBokehScale: number
}

export interface SceneSettings {
  timeOfDay: number
  fogDensity: number
  cameraMode: 'orbit' | 'fly' | 'walk'
  showSky: boolean

  /** Camera height above the ground you are standing on, in world units. */
  walkEyeHeight: number
  /** Horizontal walking speed, world units per second. */
  walkSpeed: number
  /** Speed multiplier while the run key is held. */
  walkRunMultiplier: number
  /** Ledges up to this height are climbed without a jump. */
  walkStepHeight: number
  /** Steepest ground you can stand on, degrees from horizontal. */
  walkSlopeLimit: number
  /** Detach from the ground and move freely, ignoring collision. */
  walkNoclip: boolean
  /** How much of FFXI's baked vertex colour tints water surfaces. */
  waterTint: number
  wireframe: boolean
  /** Draw the MZB collision mesh over the zone — what walking actually stands on. */
  showCollision: boolean
}

export const DEFAULT_LIGHTING: LightingSettings = {
  mode: 'baked',
  bakedInfluence: 0.35,

  gameSun: true,
  gameSunIntensity: 0.68,
  gameAmbient: 0.42,

  sunIntensity: 2.2,
  sunColor: '#fff4e0',
  sunFollowsTimeOfDay: true,
  sunAzimuth: 135,
  sunElevation: 45,

  ambientIntensity: 0.6,
  skyColor: '#9dc4ff',
  groundColor: '#4a4032',

  roughness: 0.85,
  metalness: 0.0,

  skyIBL: false,
  iblIntensity: 0.8,

  softShadows: false,
  softShadowSize: 18,
  softShadowSamples: 12,

  shadows: true,
  shadowMapSize: 2048,
  shadowRadius: 500,
  shadowBias: -0.0005,
  shadowNormalBias: 0.6,
  shadowSoftness: 4,
}

export const DEFAULT_POST: PostSettings = {
  enabled: true,
  toneMapping: 'aces',
  exposure: 1.1,

  smaa: true,

  ao: true,
  aoIntensity: 1.5,
  aoRadius: 2,

  bloom: true,
  bloomIntensity: 0.3,
  bloomThreshold: 0.8,

  colorGrade: true,
  saturation: 0.2,
  contrast: 0.08,
  brightness: 0.0,

  vignette: true,
  vignetteDarkness: 0.4,

  depthOfField: false,
  dofAutofocus: true,
  dofFocusDistance: 800,
  dofFocalLength: 900,
  dofBokehScale: 4,
}

export const DEFAULT_SCENE: SceneSettings = {
  timeOfDay: 12,
  fogDensity: 0.35,
  cameraMode: 'orbit',
  showSky: true,
  waterTint: 0.35,
  wireframe: false,
  showCollision: false,

  // FFXI's world unit reads as roughly a metre: Chateau d'Oraguille's collision
  // spans 28 units across its floors, West Ronfaure ~1200 corner to corner. So
  // 2.0 is about the asked-for 6ft eye height. Adjust here if that reads wrong
  // in a zone you know well — it is one constant, not a calibration exercise.
  walkEyeHeight: 2.0,
  // Tuned by eye against the game. Started at 3.0 (the fly camera's slowest
  // speed, 0.05 per *frame* at 60fps) and raised to 5.0, which reads as FFXI's
  // pace. Walking is time-based, so this does not drift with refresh rate.
  walkSpeed: 5.0,
  walkRunMultiplier: 2.5,
  walkStepHeight: 0.6,
  walkSlopeLimit: 50,
  walkNoclip: false,
}

/** Presets that show off what the lighting controls can do. */
export interface Preset {
  name: string
  description: string
  lighting: Partial<LightingSettings>
  post: Partial<PostSettings>
  scene: Partial<SceneSettings>
}

export const PRESETS: Preset[] = [
  {
    name: 'Original (2002)',
    description: "FFXI's baked vertex lighting, exactly as the game renders it",
    lighting: { mode: 'baked' },
    post: { enabled: true, ao: true, bloom: true, colorGrade: true, vignette: true, depthOfField: false, toneMapping: 'aces', exposure: 1.1 },
    scene: { timeOfDay: 12, fogDensity: 0.35 },
  },
  {
    name: 'Midday Sun',
    description: 'Hard dynamic sunlight with crisp shadows',
    lighting: {
      mode: 'lit', bakedInfluence: 0.3, sunIntensity: 3.0, sunColor: '#fff6e6',
      sunFollowsTimeOfDay: false, sunElevation: 62, sunAzimuth: 140,
      ambientIntensity: 0.5, shadows: true, shadowMapSize: 2048, shadowRadius: 500,
      roughness: 0.85,
    },
    post: { enabled: true, ao: true, aoIntensity: 1.2, bloom: true, bloomIntensity: 0.25, exposure: 1.0 },
    scene: { timeOfDay: 12, fogDensity: 0.25 },
  },
  {
    name: 'Golden Hour',
    description: 'Low warm sun, long shadows, heavy bloom',
    lighting: {
      mode: 'lit', bakedInfluence: 0.25, sunIntensity: 3.4, sunColor: '#ffb066',
      sunFollowsTimeOfDay: false, sunElevation: 11, sunAzimuth: 95,
      ambientIntensity: 0.42, skyColor: '#ffc48a', groundColor: '#3a2a1e',
      shadows: true, shadowMapSize: 4096, shadowRadius: 500, roughness: 0.8,
    },
    post: { enabled: true, ao: true, aoIntensity: 1.6, bloom: true, bloomIntensity: 0.55, bloomThreshold: 0.62, saturation: 0.28, exposure: 1.15 },
    scene: { timeOfDay: 17.2, fogDensity: 0.5 },
  },
  {
    name: 'Moonlit Night',
    description: 'Cool dim key light with deep ambient shadow',
    lighting: {
      mode: 'lit', bakedInfluence: 0.4, sunIntensity: 0.9, sunColor: '#9fb6ff',
      sunFollowsTimeOfDay: false, sunElevation: 34, sunAzimuth: 250,
      ambientIntensity: 0.28, skyColor: '#2a3a6b', groundColor: '#12161f',
      shadows: true, shadowMapSize: 2048, shadowRadius: 500, roughness: 0.9,
    },
    post: { enabled: true, ao: true, aoIntensity: 2.0, bloom: true, bloomIntensity: 0.45, bloomThreshold: 0.7, saturation: -0.1, exposure: 1.35 },
    scene: { timeOfDay: 0.5, fogDensity: 0.6 },
  },
  {
    name: 'Overcast',
    description: 'Soft shadowless sky light, good for reading geometry',
    lighting: {
      mode: 'lit', bakedInfluence: 0.2, sunIntensity: 0.7, sunColor: '#e8eef5',
      sunFollowsTimeOfDay: false, sunElevation: 70, sunAzimuth: 180,
      ambientIntensity: 1.5, skyColor: '#cdd8e6', groundColor: '#6b6a66',
      shadows: false, roughness: 0.95,
    },
    post: { enabled: true, ao: true, aoIntensity: 2.2, bloom: false, saturation: -0.05, contrast: 0.05, exposure: 1.0 },
    scene: { timeOfDay: 12, fogDensity: 0.3 },
  },
  {
    name: 'Clay Render',
    description: 'Untextured neutral shading to inspect pure geometry',
    lighting: {
      mode: 'lit', bakedInfluence: 0, sunIntensity: 2.6, sunColor: '#ffffff',
      sunFollowsTimeOfDay: false, sunElevation: 50, sunAzimuth: 130,
      ambientIntensity: 0.75, skyColor: '#ffffff', groundColor: '#808080',
      shadows: true, shadowMapSize: 2048, roughness: 1.0, metalness: 0,
    },
    post: { enabled: true, ao: true, aoIntensity: 2.5, bloom: false, saturation: -1, contrast: 0.1, vignette: true, exposure: 1.0 },
    scene: { fogDensity: 0 },
  },
]
