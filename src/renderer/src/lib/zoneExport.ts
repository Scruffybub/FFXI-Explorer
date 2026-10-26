import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { opaqueTexture } from './gltfExport'

/**
 * Export glTF in the zone view: the zone's placed geometry as one .glb, for
 * Blender and other 3D tools. Textures and vertex colours are inside.
 *
 * It takes the meshes the zone view built (ZoneViewer registers them with
 * setZoneMeshes), so what is exported is what is drawn: the same prefabs,
 * placements, texture sheets, vertex colours and transparency choices.
 * Left out: the sky, weather layers and generator meshes (water, lamp glows),
 * which the game moves or fades and which have no fixed place.
 *
 * - Each prefab is one glTF mesh; each placement a node using it, so a tree
 *   placed 300 times is stored once. A placement whose matrix is not a plain
 *   move, turn and scale (glTF nodes cannot skew; FFXI's can) gets a copy of
 *   the mesh with the matrix baked in.
 * - Mirrored placements: the view flips their triangles to keep faces
 *   outward; glTF flips them itself for a mirrored node, so they go out as
 *   the prefab's own triangles.
 * - Materials: base colour texture x vertex colour (FFXI's baked lighting), as
 *   the game's Original look draws them; cutouts MASK, faded overlays BLEND.
 * - Axes: FFXI's Y points down; a root node turns the zone upright.
 */

let current: THREE.InstancedMesh[] = []

/** The zone view hands over the meshes it drew; [] when it closes. */
export function setZoneMeshes(meshes: THREE.InstancedMesh[]): void {
  current = meshes
}

/** Whether a zone is loaded to export. */
export function hasZoneMeshes(): boolean {
  return current.some(isPlaced)
}

/** Placed zone geometry: a prefab with placements, not sky, weather or a generator's mesh. */
function isPlaced(m: THREE.InstancedMesh): boolean {
  return m.userData.prefabIdx !== undefined && m.userData.unrefPrefab === undefined &&
    m.userData.generator === undefined && m.userData.weatherState === undefined
}

/** Geometry for export: position, normal, uv and colour only, triangles as given or turned back. */
function cleanGeometry(src: THREE.BufferGeometry, unflip: boolean): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry()
  for (const name of ['position', 'normal', 'uv', 'color']) {
    const a = src.getAttribute(name)
    if (a) out.setAttribute(name, (a as THREE.BufferAttribute).clone())
  }
  const index = src.getIndex()
  if (index) {
    const arr = (index.array as Uint16Array | Uint32Array).slice()
    if (unflip) for (let i = 0; i < arr.length; i += 3) { const t = arr[i + 1]; arr[i + 1] = arr[i + 2]; arr[i + 2] = t }
    out.setIndex(new THREE.BufferAttribute(arr, 1))
  }
  return out
}

export async function exportZoneGlb(name: string, onProgress?: (message: string) => void): Promise<{ glb: ArrayBuffer; placements: number; prefabs: number; baked: number }> {
  const meshes = current.filter(isPlaced)
  const root = new THREE.Group()
  root.name = name
  root.rotation.x = Math.PI

  const materials = new Map<THREE.Material, THREE.MeshStandardMaterial>()
  const materialFor = (src: THREE.Material): THREE.MeshStandardMaterial => {
    let m = materials.get(src)
    if (!m) {
      const s = src as THREE.MeshBasicMaterial
      m = new THREE.MeshStandardMaterial({
        // Opaque surfaces ignore alpha; write their sheets with it full (opaqueTexture).
        map: s.map ? (s.transparent || s.alphaTest > 0 ? s.map : opaqueTexture(s.map)) : null,
        vertexColors: true,
        side: THREE.DoubleSide,
        roughness: 1,
        metalness: 0,
        transparent: s.transparent,
        alphaTest: s.alphaTest,
      })
      m.name = s.map?.name || `material_${materials.size}`
      materials.set(src, m)
    }
    return m
  }

  const made: THREE.BufferGeometry[] = []
  const shared = new Map<string, THREE.BufferGeometry>()
  let placements = 0, baked = 0
  const matrix = new THREE.Matrix4(), check = new THREE.Matrix4()
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3()
  for (const mesh of meshes) {
    const material = materialFor(Array.isArray(mesh.material) ? mesh.material[0] : mesh.material)
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, matrix)
      const mirrored = matrix.determinant() < 0
      const key = mesh.userData.prefabIdx + (mirrored ? 'm' : '')
      matrix.decompose(p, q, s)
      check.compose(p, q, s)
      let skewed = false
      for (let k = 0; k < 16; k++) if (Math.abs(check.elements[k] - matrix.elements[k]) > 1e-3 * (1 + Math.abs(matrix.elements[k]))) { skewed = true; break }
      let node: THREE.Mesh
      if (skewed) {
        // glTF nodes are move-turn-scale only: bake this one's matrix into its own copy.
        const g = cleanGeometry(mesh.geometry, mirrored)
        g.applyMatrix4(matrix)
        if (mirrored) { const idx = g.getIndex()!.array as Uint16Array | Uint32Array; for (let t = 0; t < idx.length; t += 3) { const x = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = x } }
        made.push(g)
        node = new THREE.Mesh(g, material)
        baked++
      } else {
        let g = shared.get(key)
        if (!g) { g = cleanGeometry(mesh.geometry, mirrored); shared.set(key, g); made.push(g) }
        node = new THREE.Mesh(g, material)
        node.position.copy(p); node.quaternion.copy(q); node.scale.copy(s)
      }
      node.name = `prefab_${mesh.userData.prefabIdx}_${i}`
      root.add(node)
      placements++
    }
  }

  onProgress?.(`Writing ${placements.toLocaleString()} placements of ${shared.size} meshes…`)
  try {
    const glb = await new GLTFExporter().parseAsync(root, { binary: true, onlyVisible: false })
    return { glb: glb as ArrayBuffer, placements, prefabs: shared.size, baked }
  } finally {
    for (const g of made) g.dispose()
    for (const m of materials.values()) m.dispose()
  }
}
