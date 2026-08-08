# FFXI Zone Viewer — Development Handoff

Context for continuing work in a fresh session. Written 2026-08-03.

---

## 1. What this is

A standalone Electron desktop viewer for Final Fantasy XI zone geometry, with
modern lighting the game never had. It reads DAT files directly from a local
FFXI installation — no server, no account, nothing uploaded.

**Location:** `C:\Users\ryans\ffxi-zone-viewer`

Built by porting the DAT parsers and zone renderer out of
[Vanalytics](https://github.com/Soverance/Vanalytics) (MIT, author invited
outside contributions), then fixing a long list of rendering bugs and adding
dynamic lighting, point lights, post-processing and a surface inspector.

Why desktop rather than web: a native app has no File System Access API sandbox,
so it reads the install inside `C:\Program Files (x86)` directly. It auto-detects
the install from the PlayOnline registry key.

### Stack

Electron 33 · React 19 · three.js 0.183 · @react-three/fiber + drei +
postprocessing · electron-vite · TypeScript.

### Key files

| Path | Role |
|---|---|
| `src/main/index.ts` | Electron main: window, native dialogs, file IPC, registry auto-detect |
| `src/preload/index.ts` | contextBridge API (`window.ffxi.*`) |
| `src/renderer/src/App.tsx` | Shell: zone list, loading, settings state, toolbar |
| `src/renderer/src/components/ZoneViewer.tsx` | **The renderer.** Everything below lives here |
| `src/renderer/src/components/ControlPanel.tsx` | Right-hand settings panel |
| `src/renderer/src/lib/settings.ts` | Settings types, defaults, presets |
| `src/renderer/src/lib/ffxi-dat/` | DAT parsers, ported verbatim from Vanalytics |
| `resources/zone-seed-data.csv` | 285-zone table (id, name, model path, map paths) |

### Build and package

```bash
npm run build                                                  # compile
npx electron-builder --win portable --config electron-builder.yml
```

Output: `release/FFXI-Zone-Viewer-1.0.0-portable.exe` (~80 MB).

Two gotchas:
- `signAndEditExecutable: false` is required in `electron-builder.yml`, otherwise
  electron-builder unpacks its winCodeSign bundle and fails without symlink
  privileges.
- **Kill any running instance before packaging.** It holds files in
  `release/win-unpacked` and the build fails with a confusing
  `ERR_ELECTRON_BUILDER_CANNOT_EXECUTE`.

---

## 2. How to debug this codebase

This is the most important section. Nearly every hour lost on this project went
to theorising instead of measuring. Every real fix came from instrumentation.

### The surface inspector

Click **Inspect** in the viewport toolbar, then click any surface. Reports
texture name, material index, material type, blending flag, whether it is
treated as water, texture size, average RGB, average alpha, **% opaque / %
clear**, UV range, vertex colour, vertex count, distance.

This is the single most valuable tool here. Several bugs were solved from one
screenshot of this panel. Ask the user for it early.

### Deep-link query parameters

The renderer reads these from `window.location.search`, so headless scripts can
drive it:

| Param | Effect |
|---|---|
| `zone=<id>` | Load a zone on startup |
| `preset=<n>` | Apply preset by index |
| `yaw=`, `pitch=` | Set camera orientation (degrees); disables the controls |
| `gotowater=1` | Park camera above the first water surface, log what is under the crosshair |
| `nowater=1` | Render water meshes with the ordinary opaque material |
| `nounref=1` | Skip prefabs the instance list never references |
| `waterdebug=1` | Force water to solid magenta — proves whether planes reach the screen |
| `post_<key>=<v>` | Override any `PostSettings` field |
| `light_<key>=<v>` | Override any `LightingSettings` field |
| `scene_<key>=<v>` | Override any `SceneSettings` field |

### Test harnesses (`scripts/`)

All launch the built app headless via Electron and capture PNGs.

| Script | Purpose |
|---|---|
| `smoke.cjs <zone> <preset> <out> [waitMs]` | Load, screenshot, report page state and filtered console output |
| `sweep.cjs <zone> <preset> <outDir>` | Sweep camera angles, report mean brightness, flag blown-out frames |
| `preset-test.cjs <zone> <outDir>` | Click through presets, measure colourfulness — catches settings leaking between presets |
| `dof-test.cjs <zone> <outDir>` | Capture near vs far focus, measure sharpness difference |
| `pointlight-test.cjs <zone> <out>` | Drive real click-to-place with synthetic input events |

`smoke.cjs` filters console output through a regex near the bottom — edit it to
surface whatever you are hunting. **Include shader errors in that filter.** A
silent `useProgram: program not valid` hid a broken water shader for days.

Set `EXTRA_QUERY` to append query params, e.g.
`EXTRA_QUERY="&gotowater=1&post_bloom=false" npx electron scripts/smoke.cjs 100 0 out.png`.

Console output contains ANSI escapes that can break `grep`; pipe through
`tr -cd '\11\12\15\40-\176'` first.

### Comparing screenshots numerically

Several conclusions came from measuring image differences rather than eyeballing
them. A small Electron script using `nativeImage.createFromPath(...).getBitmap()`
and averaging channel differences over the viewport region (x from 30% to 78% of
width, to skip the side panels) is enough. Eyes are unreliable for "did this
change anything?" — twice I reported a difference that measurement showed was
under 8%.

---

## 3. Solved problems and why the fixes work

Do not undo these without reading the reasoning. Several look arbitrary.

### FFXI stores normals with the opposite handedness from positions

The `rotation={[Math.PI,0,0]}` that puts a zone the right way up leaves normals
pointing *into* surfaces. All three components are negated for non-water meshes.
Without this, every upward-facing surface renders black under any lit material.
Water keeps raw normals — its fresnel was tuned against them.

This never mattered upstream because Vanalytics uses unlit `MeshBasicMaterial`,
which ignores the normal attribute entirely.

### Some meshes carry zero-length normals

Normalising a zero vector yields NaN. One NaN fragment poisons the bloom pass,
whose mipmap downsampling smears it until **the entire frame renders white**.
Symptoms were: white viewport at certain camera angles, only in lit mode,
unaffected by light intensity (NaN × 0 is NaN) or bloom threshold, and cured by
disabling bloom. Normals are sanitised at geometry build.

**Suspect NaN whenever bloom whites out a whole frame.**

### Unreferenced prefabs must be rendered

FFXI parks water planes, sky and weather domes in the file with **no MZB
instance record**. We only build meshes from the instance list, so these were
never drawn — that is why the pond had a hole in the ground. They render at
identity because their vertices are already in world space. This is what
Noesis's `-ff11renderunref` flag exists for.

### Sky and weather meshes are skipped by category prefix

`SKY_WEATHER_RE` matches the category field (before the whitespace) of the
texture name. `clod` (cloud), `mist`, `rain`, `snow`, `kumo`, `sora` were added
after the unreferenced-prefab fix made them visible as **large grey domes** in
the middle of zones. If new domes appear, Inspect them and add the prefix.

### Custom shaders must write logarithmic depth

The renderer uses `logarithmicDepthBuffer` (needed for zones tens of thousands of
units across). Every three.js built-in material writes log-encoded depth. The
hand-written water shader did not, so it tested conventional depth against
log-encoded depth and failed almost everywhere — water was invisible from every
angle.

Fixed by including `<logdepthbuf_pars_vertex>`, `<logdepthbuf_vertex>`,
`<logdepthbuf_pars_fragment>`, `<logdepthbuf_fragment>` — **and
`#include <common>` first**, because `logdepthbuf_vertex` calls
`isPerspectiveMatrix()` which lives there. Without `common` the program fails
`VALIDATE_STATUS` and every draw is silently dropped.

### Depth-based post-processing needs a linear depth buffer

Depth of field and ambient occlusion both reconstruct position from depth and
cannot read a logarithmic buffer. `needsLinearDepth` switches the renderer when
either is enabled, which remounts the Canvas — so `CameraPersistence` saves and
restores the camera pose across that remount, otherwise toggling DoF threw the
view back to the zone default.

### Ambient occlusion was gated off entirely

It was `instanceCount < 2000`. West Ronfaure has 13,115 instances, so AO was
silently disabled in every real zone and its controls did nothing. Gate removed;
N8AO's cost is screen-space and barely depends on scene complexity.

### Depth of field focus was in the wrong units

`focusDistance` is normalised depth across near..far, meaningless to dial in on a
zone with a 10,000-unit far plane. Now uses `worldFocusDistance` /
`worldFocusRange` (real world units), with autofocus on view centre by default.
The effect is built inside a memo, so its React `key` includes the focus values
to force a rebuild — otherwise the sliders move and nothing changes.

### Presets must apply over defaults, not current state

Presets list only what they change. Merging onto current state leaked the
previous preset's values — picking Clay Render then Original left the view
greyscale, because Original never mentions saturation. They now apply over
`DEFAULT_*`, with camera mode and wireframe deliberately preserved.

### Fly camera direction jumps

Three causes, all fixed: pitch was clamped to *exactly* ±90° (the YXZ gimbal
singularity, where yaw becomes undefined); angles were round-tripped through the
camera quaternion each event, reading that ambiguity back as a yaw flip; and
Chromium reports huge `movementX/Y` spikes on the first event after pointer lock.
Yaw and pitch are now the source of truth, clamped just short of vertical, with
deltas over 200 px ignored.

### Original mode's terrain shading

FFXI's DX8 fixed-function pipeline lit zone vertices with one directional sun
plus ambient against the DAT normals, with baked vertex colours multiplied on
top. `MeshLambertMaterial` is the closest three.js analogue. This is why the
files carry per-vertex normals at all — a purely baked renderer would have no
use for them. Defaults `gameSunIntensity: 0.68`, `gameAmbient: 0.42` were tuned
against in-game screenshots.

### Collision geometry is in the MZB block, not the render geometry

FFXI ships real collision data — what the game actually walks and bumps
against, including invisible walls and excluding decoration. It lives in the
**same MZB block** `MzbParser.ts` already decrypts, behind header fields that
parser ignores. `CollisionParser.ts` reads it.

Reference: `Common/dat/Types/MZB.cs` in LandSandBoat/FFXI-NavMesh-Builder, which
descends from Vulture's dat.cs. Its zone loader skips MMB entirely — *"dont need
mmb for collision mesh"*.

Three deliberate deviations from that reference, all documented at length in the
file header. Do not "fix" them back:

- **Y is not negated.** The reference negates it to emit a Y-up OBJ; we live
  under `rotation={[Math.PI,0,0]}`, so negating would double-flip.
- **Every vertex is kept.** The reference's `> -99329` cull skips vertices while
  still numbering indices as though all were kept — it desynchronises topology
  whenever it fires.
- **(visEntry, geometry) pairs are deduplicated.** The reference over-scans the
  grid 10× per axis; without dedup the same mesh is emitted many times over.

Its `ParseMesh()` is dead code — it advances a cursor and discards what it reads.
All geometry comes from the grid entries.

Verified across four zones, including the two the reference's comments flag as
problem cases: West Ronfaure 429,001 tris, North Gustaberg 587,475, Port Jeuno
96,491, Chateau d'Oraguille 34,112. Bounds stay inside plausible zone extents,
which is the cheap check that the grid over-scan is not reading junk offsets.

**Turn on "Show collision" in the Scene section** (or `scene_showCollision=true`)
to draw it as a green wireframe. Correct collision hugs the rendered ground;
anything mirrored or offset floats visibly away from the art.

### Walking mode stands on the collision mesh

`WalkCamera` in `ZoneViewer.tsx`, with queries served by `lib/CollisionWorld.ts`
(collision converted to world space once, wrapped in a three-mesh-bvh BVH —
~160ms for West Ronfaure's 429k triangles).

Things that are the way they are on purpose:

- **Time-based, not frame-based.** FlyCamera adds a per-*frame* constant, so its
  speed depends on refresh rate. Gravity and step-up integrated that way fall
  through floors on fast machines. `dt` is clamped to 0.1s so a long frame
  cannot teleport you through a wall.
- **Physics runs without pointer lock; only input needs it.** Otherwise you hang
  in mid-air until you click, and the mode cannot be driven headlessly.
- **Spawn snaps to the ground by raycast**, rather than spawning high and
  falling. A zone's bounding-box centre is often underground, and "fall until you
  land" never terminates from there.
- **The wall probe ignores floor-like normals.** A horizontal probe on rising
  ground hits the slope ahead; treating that as a wall cancels most of the
  movement, and walking uphill crawled at half speed until this check existed.
- **The overlay draws the same geometry the controller raycasts**, so what you
  see is exactly what you collide with.

`?walkdebug=1` logs body state twice a second and accepts keys without pointer
lock (a synthetic click cannot engage lock headlessly).

**`scripts/walk-test.cjs` must run with `show: true`.** Chromium throttles rAF in
a hidden window regardless of `backgroundThrottling`, which starves the
controller to a few frames a second and makes correct physics look broken — that
cost a round of false debugging. Verified in Chateau d'Oraguille: spawns at
y=11, walks off a ledge, lands at y=1.50 with `grounded=true`, and moves 1.56
units per 0.5s against a configured 3.0/sec.

**The wall probe must not give up on a floor-like hit.** The first version cast
one ray at feet+0.7 and `break`-ed out entirely when the hit looked like floor.
On rocky ground that ray hits the walkable slope rising ahead, so the wall behind
it was never tested — you walked through walls and then fell, because inside the
rock there is no floor under you. Measured in South Gustaberg: every direction
from the zone centre returns `|normal.y|` between 0.64 and 0.88, all above
cos(50°) = 0.643, so *every* probe bailed out.

Now it probes three heights and a floor-like hit disqualifies only that ray.
Against 200 steep faces, the old rule detected 172, the new one 198 — and that
understates it, because the synthetic test approaches head-on through clear air
and cannot reproduce the ground-in-the-way case that actually broke it.

**Rays alone cannot hold you out of a wall — the body needs volume.** With only
the ray probe, walking head-on into a wall worked, but approaching at an angle
you could wedge through: once sliding leaves you travelling nearly parallel to
the face, the zero-thickness ray stops hitting it while the body still overlaps,
and you creep sideways through a little each frame.

`CollisionWorld.depenetrate()` sweeps a sphere via `shapecast` and pushes it back
out, whatever direction it arrived from. Run at two heights and iterated up to
three times, because escaping one face in a corner can leave you touching
another. Floor-like faces are excluded or standing on the ground would shove you
around. Measured against 300 penetrating samples in South Gustaberg: 300 detected,
256 fully cleared after iteration (up from 166 with a single push). The remaining
44 are samples the test itself buried inside solid rock — collision normals are
unoriented, so half the probes push inward. No measurable frame-rate cost.

Collision normals are not reliably oriented, so the slide turns the normal
against travel before projecting. Skipping that can push you *into* the wall.

Falling out of the world now restores your last grounded position rather than
dropping forever.

Not yet done: no head/ceiling collision and no jump (deliberately out of scope).

### Query-param overrides were number-only

`coerce()` in `App.tsx` ran every value through `Number()`, so any string-valued
setting became `NaN` and silently did nothing — `scene_cameraMode=walk`, tone
mapping names, and colours like `light_sunColor=#fff4e0` were all affected. It
now keeps non-numeric values as strings.

### The model viewer, and the all-zero index buffer

`Models` in the top-left switch replaces the whole window: `ModelBrowser` owns
its own sidebar and viewport, sharing only the FFXI install path with the zone
side. 2,473 NPC/monster/object models from `resources/npc-model-paths.json`.

`DatFile.ts` is the loader Vanalytics had and the original port left behind —
block `0x20` textures, `0x29` bone, `0x2A` vertex, `0x2B` animation. Everything
it calls was already here and unused. Animations are detected but not decoded;
`AnimationParser.ts` is still to port, which is why models sit in bind pose.

**`MeshParser` allocated its index buffers and never filled them.** Every model
rendered nothing, in the most misleading way possible: meshes present in the
scene, camera aimed correctly, materials fine, and `renderer.info` reporting
7 draw calls and 2,358 triangles. All indices were 0, so every triangle was
degenerate and covered no pixels. three.js does not warn about this, and the
triangle counter counts *submitted* geometry, not surviving fragments.

Vanalytics never hit it because it draws these meshes non-indexed. `expandFaces`
emits one vertex per face corner already in draw order, so the indices are just
0..n-1 — now filled by `sequentialIndices()`, in a Uint32Array because expanded
character meshes can pass 65,535 corners.

Time was lost ruling out plausible-but-wrong causes here — alpha, normals,
StrictMode disposal, group transforms. What actually found it was dumping the
live scene graph and the index range. **`?modeldebug=1`** exposes
`window.__modelScene`, `__modelCam` and `__modelGl`; `scripts/model-test.cjs`
prints geometry, bounds, index ranges, canvas rects and `renderer.info`. When a
model does not appear, start there, and check `idxRange` first.

One real bug found on the way: creating three.js resources in `useMemo` and
disposing them in a `useEffect` cleanup is broken under StrictMode — React runs
the cleanup on its simulated unmount, disposing everything, then remounts and
renders the disposed resources. Build and dispose in the *same* effect.

### Smaller ones

- `vColor` is declared `vec4` in this three.js version even without
  `USE_COLOR_ALPHA` — swizzle `.rgb` when patching `color_fragment`.
- `customProgramCacheKey` must differ per shader variant, or three reuses the
  wrong compiled program and meshes vanish.
- The shadow-camera effect's deps must include `lighting.mode` and
  `lighting.shadows`; the light only exists in lit mode, so switching to it
  changed no shadow setting and the camera kept three's tiny default bounds —
  shadows only appeared after nudging a slider.
- `bakedInfluence` uses a power curve, not a linear blend toward white. Same
  endpoints, but lerping crushes dark detail: the pond bed's 0.07 lifts to 0.675
  at the default 0.35 and its depth shading vanishes, versus 0.394 on the curve.

---

## 4. Open problems

### 4a. Water does not look like the game

**Status:** parked at the user's request pending their own research.

Confirmed by inspector: West Ronfaure's pond surface is `ron_riv`, material 25,
blending 0, referenced. But routing it through the water shader renders pale
stacked planes nothing like the game, so it is left as ordinary geometry.

Currently only **unreferenced prefabs carrying blend flag `0x2000`** are treated
as water — 10 surfaces in West Ronfaure (`ron_w01c`, `ron_w03c`). They render,
but subtly.

Ruled out, do not retry:
- Texture names describe the shared *texture*, not the surface. `ron_riv` is
  presumably East Ronfaure's river texture reused. `ron_w01c` reads like water
  but is terrain — routing it through the water material turned the whole zone
  into overlapping ghosts.
- A broad specular lobe on water: flat surfaces saturate across the entire plane
  at once and the river becomes a sheet of white.
- Multiplying by the texture's own alpha: `ron_riv` decodes to 0% opaque, 57%
  clear, so the surface disappeared entirely.

The **Water tint** slider (Scene section) controls how much baked vertex colour
tints water; FFXI stores very dark values there (0.07), so a low setting keeps
rivers from going black.

### 4b. Cutout alpha — black boxes and pale slabs

Cutout art whose blending flag is `0` draws its transparent regions as solid
colour: black rectangles behind foliage sprites, pale slabs across Lufaise's
`lat_wf` waterfall.

**Five approaches have failed.** All are recorded in a comment at the `useAlpha`
line. Do not repeat them:

| Approach | Result |
|---|---|
| Alpha test every mesh | Holes through terrain |
| Gate on whole-sheet clear % (≥25%) | Holes through terrain |
| Gate on per-mesh zero-alpha share ≥0.3 | Holes through terrain |
| Same at ≥0.02 | Holes through terrain |
| Noesis blendhack guard (force opaque ≥0.9) | Cutout sprites became black boxes |

The measurement does not separate the cases: West Ronfaure's terrain `ron_w01c`
measures 0.50 transparent, the same band as genuine cutouts (`lat_wf` 0.42–0.67).
West Ronfaure's per-mesh share histogram across 349 meshes is
`161,1,9,23,35,40,21,7,15,37` (tenths) — a large opaque cluster and a long
spread, not two clean clusters.

### 4c. South Gustaberg mismatched ground tiles

Pale angular patches of the wrong ground texture. Inspector on an affected tile:
`gus_02`, material 9, blending 0, UV v to 1.13, vertex colour 0.50 — identical to
its correct neighbours in every field the panel reports **except the UV range**.

Ruled out: unreferenced geometry, the blend flag, and UV wrapping. 125 of 397
meshes have UVs past 0..1, but clamping them smeared cliff faces into long
streaks, so that overflow is genuine tiling and `RepeatWrapping` is correct.

Best remaining hypothesis: these are **atlas sub-tiles** — several ground
variants packed into one 512×512 sheet, selected by UV offset — and the parser
lands on the wrong cell. Test by dumping raw UVs for a good tile versus a bad one
and looking for a consistent fractional offset.

### 4d. Shadow strength

User reports shadows looking weaker than before; cause unconfirmed. Two
candidates, neither verified:
- `shadowRadius` default was raised 260 → 500 at the user's request. The same
  shadow map now covers ~4× the ground area, so shadows read softer. Raising
  `shadowMapSize` to 4096 offsets it.
- AO forcing a linear depth buffer. Shouldn't touch shadow mapping, which uses
  its own depth targets, but it is the other recent rendering change.

---

## 5. The strongest open lead

**The DXT3 alpha decode is probably wrong.**

Reference tools and community write-ups describe FFXI terrain textures as having
alpha uniformly `0x00` — that is why enabling blending globally made GalkaReeve's
terrain vanish, and why Noesis's blendhack works by forcing near-fully-transparent
meshes opaque.

Our parsed textures do not look like that. `gus_02` averages alpha 120/255 with
only 6% fully clear; `lat_wf` averages 60 with 50% clear. Only 37 of 349 West
Ronfaure meshes fall in the ≥0.9 transparent band the hack targets.

If our decoder produces smooth mid-range alpha where the reference produces hard
0/255, then **every alpha-driven decision in the renderer is working from wrong
data**. That would plausibly explain 4a, 4b and possibly 4c at once.

Check `decompressDXT3` in `src/renderer/src/lib/ffxi-dat/TextureParser.ts`
against a reference implementation, paying attention to the 4-bit explicit alpha
block: nibble order, and whether values are expanded `a * 17` (0–15 → 0–255) or
by some other scale. Note the **DXT1 path already contains a deliberate hack**
forcing alpha to 255 to stop terrain holes — a sign this area was papered over
rather than solved.

---

## 6. Feature ideas not started

- **Path-traced stills.** `three-gpu-pathtracer` renders progressively in WebGL —
  far too slow to fly around in, but viable as a "render high-quality still"
  button. Progressive accumulation keeps each GPU submission small, so the
  failure mode on weak hardware is slowness, not a crash; guard against WebGL
  context loss and fall back.
- **Screen-space reflections.** Not in `@react-three/postprocessing` (checked the
  exports); needs another dependency or a custom pass.
- **Volumetric light shafts.** `GodRays` is available and would suit the low-sun
  presets.
- **Lit fog.** three's fog is a flat colour blend with no concept of light;
  making point lights illuminate it means raymarched volumetrics, not a setting.
- **Contact-hardening shadows (PCSS).** Attempted and reverted: drei's
  `SoftShadows` swaps the global shadow shader chunk and collides with the custom
  shader patches, making all zone geometry vanish. Scoping the program cache key
  per shadow variant did not fix it. Needs the patching reworked.
- **Saving placed point lights per zone.** They are lost on zone switch and exit.

---

## 7. Working agreement that mattered

The user is a designer who leans on Claude for code, has played FFXI for years,
and is an excellent source of ground truth — several root causes came directly
from their observations (the two ground textures sliding in opposite directions;
the pond being in a different place than assumed; shadows existing in-game that
"baked lighting" could not explain).

What worked:
- **Measure, then change.** Every durable fix came from instrumentation. Every
  regression came from acting on a plausible theory without checking.
- **Ask for an Inspect screenshot** when something looks wrong in a specific
  place. It is faster than any amount of code reading.
- **Verify with a screenshot before claiming success**, and say plainly when
  something was not fixed.
- **Record failed approaches in the code**, with their measurements. This file
  and those comments exist because the same wrong ideas kept resurfacing.
