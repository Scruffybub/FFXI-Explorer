import type { ParsedCollision } from './CollisionParser'

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
}

export interface ZoneMeshInstance {
  meshIndex: number       // which MMB prefab (sequential MMB block order)
  transform: number[]     // 4x4 matrix (16 floats, row-major)
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
