import type { ParsedCollision } from './CollisionParser'
import type { Emission, Spread } from './GeneratorParser'
import type { SpriteMesh } from './SpriteParser'

export interface ParsedMesh {
  vertices: Float32Array
  normals: Float32Array
  uvs: Float32Array
  indices: Uint32Array
  boneIndices: Uint8Array
  boneWeights: Float32Array
  materialIndex: number
  /** Per-vertex bone-local positions for bone 1 (3 floats/vert). Present when mesh has MV2 vertices. */
  dualBoneLocalPos1?: Float32Array
  /** Per-vertex bone-local positions for bone 2 (3 floats/vert). Zero for MV1 vertices. */
  dualBoneLocalPos2?: Float32Array
  /** Per-vertex weights (2 floats/vert): [w1, w2]. MV1 vertices have [1, 0]. */
  dualBoneWeights?: Float32Array
}

/**
 * How a texture's alpha channel is actually used, measured from the decoded
 * pixels rather than guessed from a mesh flag.
 *
 * FFXI's DXT3 alpha is effectively binary once POLUtils' rule is applied (see
 * `decompressDXT3`): about three quarters of texels are opaque, a quarter are
 * cut clean out, and a few percent are genuinely partial. Which of those a
 * texture is made of says what material it wants — and it is a property of the
 * *texture*, where the blending flag is a property of the *mesh*. They answer
 * different questions; expect to consult both.
 */
export type AlphaClass = 'solid' | 'cutout' | 'translucent'

export interface AlphaProfile {
  cls: AlphaClass
  /** Share of texels fully clear — DXT3 nibble 0. */
  clear: number
  /** Share genuinely partial — nibbles 1-6, i.e. alpha 32..192. */
  partial: number
  /**
   * Share opaque. This counts alpha >= 224, NOT >= 250: nibbles 7 and 8 are
   * FFXI's dithered opaque pair and 7 decodes to 224. Counting only 255 would
   * put ~70% of every terrain texture in the partial bucket and classify the
   * whole world translucent.
   */
  opaque: number
}

export interface ParsedTexture {
  width: number
  height: number
  rgba: Uint8Array
  /**
   * Which decoder produced the pixels: 'dxt1', 'dxt3', 'indexed', and the
   * '-b1' variants for 0xB1 blocks that fell back to DXT.
   *
   * The parser has always set this and ZoneViewer has always read it; it was
   * simply missing from the type, which is why `tex.format` was a type error in
   * three places. It matters beyond diagnostics: palette-indexed plates are
   * stored bottom-up where DXT ones are not (see MapViewer).
   */
  format: string
  /**
   * Measured alpha usage, set by every decode path in `TextureParser` and
   * `MinimapParser` — required so a new decode path cannot silently omit it.
   */
  alphaProfile: AlphaProfile
}

export interface ParsedBone {
  parentIndex: number
  position: [number, number, number]
  rotation: [number, number, number, number]
}

export interface ParsedSkeleton {
  bones: ParsedBone[]
  /** Pre-computed world-space 4x4 matrices (row-major, 16 floats each) */
  matrices: number[][]
}

export interface ParsedDatFile {
  meshes: ParsedMesh[]
  textures: ParsedTexture[]
  skeleton: ParsedSkeleton | null
  animations: ParsedAnimation[]
}

export interface ParsedZoneMesh {
  vertices: number[]      // flat xyz (3 floats per vertex)
  normals: number[]       // flat xyz (3 floats per vertex)
  colors: number[]        // flat rgba 0.0-1.0 (4 floats per vertex)
  uvs: number[]           // flat uv (2 floats per vertex)
  indices: number[]       // triangle indices
  materialIndex: number   // texture index (sequential IMG block order)
  blending: number        // MMB blending flag (0=opaque, >0=alpha blend)
  textureName?: string    // original texture name from MMB model header
  /**
   * The MMB's own name (SMMBHeader.imgID) — what the MZB places it by. FFXI decides
   * a zone mesh's transparency from it: a leading `_` marks a cutout (foliage,
   * fences), alpha-tested at 0.375. See kuluu dat_mmb.rs submesh_alpha_mode.
   */
  meshName?: string
  /**
   * An effect mesh from a D3M chunk rather than an MMB. It has no placement of
   * its own — only generators place it — so the renderer must never draw it at
   * the origin the way it draws other unplaced prefabs.
   */
  d3m?: boolean
  /**
   * A sun or moon mesh (MMB `sunsphere` / `moonsphere` in <zone>/weat/). Only
   * sky generators place it, riding the sun or moon's direction, so like a D3M
   * it must never be drawn unplaced at the origin.
   */
  celestial?: boolean
  /** The weather state whose folder (weat/<state>/…) holds this mesh, if any. */
  weatherState?: string
  /** A 0x21 sprite quad: placed only by particle generators, like a D3M. */
  sprite?: boolean
  /** A lens-flare sheet's meshes, each with its place along the flare line. */
  flare?: SpriteMesh[]
  /**
   * A flipbook's frames — the shared snowflake `hit3` has sixteen, a 4x4 grid
   * on one sheet. A particle draws one at a time.
   */
  frames?: SpriteMesh[]
}

export interface ZoneMeshInstance {
  meshIndex: number       // which MMB prefab (sequential MMB block order)
  transform: number[]     // 4x4 matrix (16 floats, row-major)
  /** Point-light generators lighting this placement (MZB, up to four). */
  lights?: string[]
}

/**
 * A mesh placed by a Generator chunk rather than by the MZB. This is how FFXI
 * positions its seas, rivers, sky layers and lamp glows — see GeneratorParser.
 */
export interface GeneratorSpawn {
  generator: string                       // 4-char generator chunk name
  dir: string                             // DAT directory, e.g. "f_ta/effe/nami" or
                                          // "f_ta/weat/suny" — one weat/ subtree per
                                          // weather state, holding its sky layers
  model: string                           // linked MMB chunk name
  prefabIndices: number[]                 // every prefab that MMB chunk produced
  position: [number, number, number]      // DAT space, like MZB transforms
  rotation: [number, number, number]      // radians
  scale: [number, number, number]
  tint: [number, number, number, number]  // raw bytes, 0x80 = identity
  uvScroll: [number, number]              // texture offset per effect frame (1/60 s)
  followCamera: boolean                   // sky layers ride with the camera
  life: number                            // frames per particle; 0 = forever
  /**
   * Resolved KeyFrame curves, flat [t0, v0, t1, v1, ...], sampled by life
   * progress. Only the channels the renderer uses are resolved. `alpha` is the
   * tint alpha on the 0..1 = byte/255 scale; `u`/`v` add to the texture offset.
   */
  curves: { alpha?: number[]; u?: number[]; v?: number[]; r?: number[]; g?: number[]; b?: number[] }
  attach: number                          // 0xE sun, 0xF moon, 0 none (body[0] low nibble)
  blend: number                           // 0x1E blend byte, -1 when absent
  /** Time-of-day curves (0x60–0x63), resolved like `curves`. */
  todCurves: { r?: number[]; g?: number[]; b?: number[]; alpha?: number[] }
  spin: [number, number, number]           // 0x0B rotation per frame, radians
  // Particle behaviour — see GeneratorParser's RawModelSpawn for each.
  link: 'mesh' | 'sprite' | 'flare' | 'light'
  billboard: number
  renderState: number
  emission: Emission
  spread: Spread | null
  velocity: [number, number, number]
  velocityVariance: [number, number, number]
  accel: [number, number, number]
  moves: boolean
  rotationVariance: [number, number, number]
  scaleVariance: [number, number, number]
  scaleVelocity: [number, number, number]
  emitRange: number
  flipbook: boolean
  screenFlash: { near: number; far: number; nearAngle: number; farAngle: number } | null
  children: { birth: string[]; expire: string[] }
  drawDistance: { near: number; far: number } | null
  /** A point light's reach and quadratic fall-off (link 'light'); see GeneratorParser. */
  pointLight: { range: number; quad: number } | null
}

/** One light set from an environment record. Colours are raw byte / 255. */
export interface ZoneEnvLight {
  sun: [number, number, number]
  moon: [number, number, number]
  ambient: [number, number, number]
  fog: [number, number, number]
  fogStart: number
  fogEnd: number
  diffuse: number                         // multiplier on sun and moon
}

/** An FFXI environment record (block 0x2F); see EnvironmentParser. */
export interface ZoneEnvRecord {
  state: string                           // weather directory: fine, clod, mist, suny…
  dir: string                             // full DAT directory, e.g. f_ro/weat/fine
  minutes: number                         // time of day, from the HHMM chunk name
  indoors: boolean
  model: ZoneEnvLight                     // light for characters and models
  terrain: ZoneEnvLight                   // light for zone geometry
  clearColor: [number, number, number]
  farClip: number
  skyColors: number[]                     // 8 × RGB, sRGB 0..1, horizon to zenith
  skyAltitudes: number[]                  // 8 fractions from horizon (0) to zenith (1)
}

export interface ParsedZone {
  prefabs: ParsedZoneMesh[]       // unique MMB mesh prefabs
  instances: ZoneMeshInstance[]    // MZB placement transforms
  textures: ParsedTexture[]       // reused from entity pipeline
  /**
   * The name each texture carries in the DAT, indexed alike to `textures`.
   * Diagnostic: a prefab's `textureName` only covers sheets some mesh uses,
   * and the effect and weather sheets merged from companion DATs are used by
   * none of them.
   */
  textureNames: string[]
  /** Meshes placed by generator chunks. Empty for zones that have none. */
  spawns: GeneratorSpawn[]
  /** How many prefabs and textures came from the shared effects file, at the end. */
  shared?: { prefabs: number; textures: number }
  /**
   * The zone's environment records (block 0x2F under <zone>/weat/<state>/):
   * sky gradient, lighting and fog per weather state and time of day.
   */
  environment: ZoneEnvRecord[]
  collision: ParsedCollision | null // MZB collision mesh, raw DAT space
}

export interface AnimationBone {
  boneIndex: number
  rotationKeyframes: Float32Array | null   // 4 floats per frame (qx,qy,qz,qw), null = use default
  rotationDefault: [number, number, number, number]
  translationKeyframes: Float32Array | null // 3 floats per frame (tx,ty,tz), null = use default
  translationDefault: [number, number, number]
  scaleKeyframes: Float32Array | null       // 3 floats per frame (sx,sy,sz), null = use default
  scaleDefault: [number, number, number]
}

export interface ParsedAnimation {
  frameCount: number
  speed: number
  bones: AnimationBone[]
}
