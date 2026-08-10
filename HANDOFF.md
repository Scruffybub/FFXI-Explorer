# FFXI Zone Viewer — Development Handoff

Context for continuing work in a fresh session.
Written 2026-08-03, substantially revised 2026-08-08.

---

## 0. Start here — the next task

**Weather: the census is done and the geometry is identified. What remains is
deciding how to present it.**

Steps 1–3 of the old plan were carried out on 2026-08-09. The findings below
replace the guesswork; read them before touching anything.

### What the census established

New tooling, all of it kept:

| Switch | Effect |
|---|---|
| `?census=1` | Logs `[CENSUS]` — every unreferenced prefab with its full texture string, material index, whether that material resolves, texture size, bbox and centre |
| `?pick=<substr>` | Draws **only** prefabs whose texture string contains the substring, terrain included, and frames the camera on them. Bypasses `isSkyWeatherMesh`, so it can look at hidden geometry |
| `?pickaxis=x\|y\|z` | Overrides the view axis the pick chooses |
| `scripts/weather-census.cjs <out.json> [N \| zone names…]` | Runs the census over many zones and writes the raw JSON so the analysis can be redone without another sweep |

**1. Every texture resolves. The parser is not at fault.** Abdhaljs
Isle-Purgonorgo, Misareaux Coast and Riverne - Site #A01 report **0 prefabs with
no usable texture** between them. The old note's leading worry — that these draw
with the fallback texture — is dead. Whatever the first investigation saw as a
yellow-and-black checkered patch, it was not a texture resolution failure.
**Do not spend time on the parser.**

**2. The state/element grid holds, and it is much larger than the word list.**
Confirmed vocabulary, from the census plus visual isolation:

| Token | Meaning | Token | Meaning |
|---|---|---|---|
| `suny` | sunny | `kumo` / `kumori` | 雲 cloud / 曇り cloudy |
| `clod` | cloud | `niji` | 虹 **rainbow** |
| `thdr` / `kaminari` | thunder / 雷 | `yuh1` `yuh2` `yuhi` | 夕日 **sunset** |
| `fogd` | fog | `even` | evening |
| `mist` | mist | `taki` / `kawa` / `umi` | 滝 waterfall / 川 river / 海 sea |
| `wind` | wind | `strm` / `stomsy` | storm / storm sky |
| `fine` | fine | `tenkyu` | 天球 celestial sphere |
| `dark` | dark | `cldsea` | cloud sea |
| `star` | stars | `skywll` | sky wall |
| `warp` | warp light pillars | `baha` | Bahamut (Misareaux/Riverne only) |

**3. `model` is real zone geometry and must never be filtered.** Riverne carries
142 unreferenced `model  …` prefabs (`ba_wal01`, `lat_wf`, `jug_wk*`) that are
the floating islands themselves. Any classifier that widens to catch weather has
to leave `model` alone.

**4. The two-field theory is proven by a duplicate.** Misareaux holds the same
rainbow mesh twice — `effect  niji` (#581, caught by the filter) and
`niji  niji` (#502, missed). Same size, same 88 vertices, same 32×32 texture.
The identity really can sit in either field, and the current word list only
catches it in one.

### What each thing turned out to be

Verified by isolating it with `?pick=` and looking:

- **Misareaux's rainbow** is `niji  niji` — a flat card, 0 units thick in X,
  90×95. It renders correctly and beautifully. This is what Ryan photographed;
  it is visible in the zone today because `niji` is not in the word list.
- **Purgonorgo's "lava"** is not lava. It is `even  yuh1` / `even  yuh2` /
  `even  kuro` — **evening/sunset sky glow**, built as flat concentric annular
  sectors lying horizontally (height 0–1). Orange with red streaks, plus brown
  and mottled bands. Seen from below in a zone it reads as sunset colour across
  the sky; seen from above in isolation it is obviously a set of rings.
- **Riverne's `kumo  skywll`** (50 prefabs) is the **cloud sea floor** the
  floating islands sit above.
- **`cldsea  rond`** is a shallow cloud **basin**, not a funnel — checked from
  the side with `pickaxis=x`. `cldsea  stomsy` is a storm cloud disc,
  `cldsea  rfrecsn` a layered cloud sheet.

**The tornado Ryan reports in Riverne - Site #A01 has not been found yet.**
Ruled out by looking: `stomsy`, `rond`, `kumo`, `rfrecsn`. Still unexamined
there: `1clod`, `ligthdr  limg` / `ligthdr  light`, `cldsea  fine_a01`,
`cldsea  skywll`, and the **unnamed** prefabs. Note an unnamed prefab of exactly
162×49×260 with 387 vertices appears in *all three* zones with identical
geometry but a different material each time — it is shared, not zone scenery,
and `?pick=` cannot select it because an empty name matches everything. Give the
pick an index form (`pick=#448`) before chasing it.

### The leak is fixed; the feature is not

The filter was widened on 2026-08-09 using the 8-column split, adding the
confirmed weather-state words (`niji`, `even`, `yuh`, `yuhi`, `yuhiumi`,
`kaminari`, `katn`, `smoke`, `thunder`, `bahakumo`) plus a `NEVER_WEATHER` guard
that can never match `model`. Measured against the same three zones:

| Zone | Newly hidden | Notes |
|---|---|---|
| Abdhaljs Isle-Purgonorgo | 14 | the sunset glow planes Ryan photographed |
| Misareaux Coast | 55 | the rainbow, 20 lightning, 30 Bahamut cloud, thunder, smoke |
| Riverne - Site #A01 | **0** | deliberately untouched |
| `model` prefabs hidden | **0 of 158** | across all three; no regression |

Riverne is left alone on purpose. Its `cldsea` and `kumo  skywll` meshes are the
sea of clouds the floating islands sit above — the zone's defining feature, and
almost certainly meant to be visible. Verified by screenshot after the change:
islands and cloud sea both intact.

### Water lives in this set too — relevant to 4a

Answering Ryan's question directly: **yes, there is water geometry parked with
the weather.** Misareaux Coast alone carries, all currently *hidden* because
their first field is `effect`:

| Name | Count | Size | Reading |
|---|---|---|---|
| `effect  taki` | 9 | up to 27×76×49 | 滝 waterfall — tall, clearly a falls |
| `effect  kawa` | 8 | ~50×0×34 | 川 river — flat cards |
| `effect  umi2` / `umi3` | 5 | ~69×0×33 | 海 sea |
| `yuhiumi yuh1` | 2 | 11×0×22 | sunset over sea |

Purgonorgo adds `effect  umi1`. **This is a live lead for open problem 4a**
("water does not look like the game"). If FFXI's rivers and waterfalls get their
look from these effect overlays rather than from the base surface, then every
attempt so far has been tuning the wrong mesh.

**`?pick=taki` was run, 2026-08-09. The waterfall is real.** Nine tall vertical
ribbons of varying length, the longest falling 120 units, arranged down a cliff
face — unmistakably a waterfall, correctly shaped and positioned, textured from
a 256×256 sheet that resolves fine.

It renders as **dark grey cloth**, and the reason is a genuine gap in the
renderer rather than anything to do with this geometry:

> **There is no blending mode anywhere in the zone renderer.** The only thing
> the blend flag does is `const useAlpha = prefab.blending > 0`, which turns on
> `alphaTest: 0.1` — a *cutout*. `transparent` is never set and
> `THREE.AdditiveBlending` is never used. So every one of FFXI's three observed
> modes (`0x0` opaque, `0x2000` translucent, `0x8000`) collapses to
> "alpha-tested opaque".

A greyscale streak texture drawn as alpha-tested opaque geometry is exactly dark
cloth. Drawn additively — which is what a `0x8000` greyscale streak sheet is for
— it would brighten what is behind it and read as falling water.

This is one finding that touches 4a and 4b at once, and it is the first
explanation of the water problem that is not about the water shader. **Blast
radius is the caution**: `0x8000` is carried by the weather domes, the cloud
layers and the rainbow as well, so changing its handling globally changes many
zones at once. Test it behind `?pick=` first.

### What is left to decide

The geometry is reachable, textured and identified. The open question is
presentation, and it is a design question as much as a technical one:

1. **Widen the filter** so the leaked effects (`niji`, `even`, `cldsea`, `warp`,
   `kaminari*`, `baha*`, `yuhiumi`) stop drawing in ordinary zone views —
   without catching `model`. Ryan's screenshots are that bug.
2. **Add a weather-state selector** that draws one state's geometry deliberately.
   The vocabulary above makes the states enumerable.

Do not restore the old `showWeather` toggle as-is. It drew every state at once
and was removed for good reason.

---

## 1. What this is

A standalone Electron desktop viewer for Final Fantasy XI, with modern lighting
the game never had. It reads DAT files directly from a local FFXI installation —
no server, no account, nothing uploaded.

**Location:** `C:\Users\ryans\ffxi-zone-viewer`
**Repo:** `Scruffybub/FFXI-Explorer` on GitHub — **private, deliberately.** FFXI
tooling is a grey area with Square Enix. Do not make it public without asking.

It has grown past its name. Three things live here now:

- **Zone viewer** — 285 zones, orbit / fly / **walk** cameras. Walking stands on
  FFXI's own MZB collision mesh, in first or third person.
- **Model viewer** — 2,473 NPC, monster and object models, animated; plus a
  **character builder** that assembles a player character from a race skeleton
  and equipment DATs, with item names and ~300 animation sets per race.
- **Shared character** — the character you build is the one you walk around
  zones as. `charSpec` lives in `App.tsx` for exactly that reason.

Roadmap status: walking (1a and 1b) done, model viewer done, **diorama not
started** — place a posed, equipped character in a zone for stills. It shares
most of its machinery with third-person walking.

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
| `src/renderer/src/App.tsx` | Shell: view switch, zone list, settings state, **the shared character** |
| `src/renderer/src/components/ZoneViewer.tsx` | **The zone renderer.** Walk controller and `Avatar` live here |
| `src/renderer/src/components/ControlPanel.tsx` | Zone settings panel |
| `src/renderer/src/components/ModelBrowser.tsx` | Model viewer half: sidebar, viewport, Browse/Character modes |
| `src/renderer/src/components/ModelViewer.tsx` | Single-model canvas and `Animator` |
| `src/renderer/src/components/ModelPanel.tsx` | Model settings panel (clip, studio lighting) |
| `src/renderer/src/components/CharacterBuilder.tsx` | Race, face, eight equipment slots, animation set |
| `src/renderer/src/lib/settings.ts` | Settings types, defaults, presets |
| `src/renderer/src/lib/modelBuild.ts` | DAT → three.js meshes. **Shared** by model viewer and zone avatar |
| `src/renderer/src/lib/skinning.ts` | CPU skinning maths, split from React so it can be tested |
| `src/renderer/src/lib/characterModel.ts` | Assembles a player character; equipment, face and animation tables |
| `src/renderer/src/lib/CollisionWorld.ts` | Collision BVH: ground, wall rays, sphere depenetration |
| `src/renderer/src/lib/ffxi-dat/` | DAT parsers, ported from Vanalytics |
| `resources/zone-seed-data.csv` | 285-zone table (id, name, model path, map paths) |
| `resources/model-dat-paths.json` | Equipment models keyed `"race:slot"` → index → path |
| `resources/item-names.json` | Model index → item names, built by `scripts/build-item-names.cjs` |
| `resources/animation-paths.json` | ~300 animation sets per race |
| `resources/npc-model-paths.json` | 2,473 named NPC/monster models |

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
| `walkdebug=1` | Log body state twice a second, and accept keys **without pointer lock** (a synthetic click cannot engage lock headlessly) |
| `modeldebug=1` | Log what the model builder produced, and expose `window.__modelScene`, `__modelCam`, `__modelGl` |
| `post_<key>=<v>` | Override any `PostSettings` field |
| `light_<key>=<v>` | Override any `LightingSettings` field |
| `scene_<key>=<v>` | Override any `SceneSettings` field |

Values are coerced: `true`/`false` become booleans, clean numbers become numbers,
**and anything else stays a string**. That last part was a bug — a bare `Number()`
turned `scene_cameraMode=walk`, tone-mapping names and colours like
`light_sunColor=#fff4e0` all into `NaN`, silently.

### Test harnesses (`scripts/`)

All launch the built app headless via Electron and capture PNGs.

| Script | Purpose |
|---|---|
| `smoke.cjs <zone> <preset> <out> [waitMs]` | Load, screenshot, report page state and filtered console output |
| `sweep.cjs <zone> <preset> <outDir>` | Sweep camera angles, report mean brightness, flag blown-out frames |
| `preset-test.cjs <zone> <outDir>` | Click through presets, measure colourfulness — catches settings leaking between presets |
| `dof-test.cjs <zone> <outDir>` | Capture near vs far focus, measure sharpness difference |
| `pointlight-test.cjs <zone> <out>` | Drive real click-to-place with synthetic input events |
| `walk-test.cjs <zone> <out> [holdMs]` | Enter walk mode, hold W, report where the body ended up. **Must run with `show: true`** |
| `orphan-sweep.cjs [count] [waitMs]` | Load many zones, report the largest unreferenced prefab still drawn in each — how stray domes are found |
| `model-test.cjs <name> <out>` | Load a model, dump the three.js scene graph, screenshot |
| `character-test.cjs <raceIdx> <out>` | Build a player character with equipment, report what loaded |
| `character-anim-test.cjs <animIdx> <out>` | Equip and animate a character, measure vertex motion |
| `build-item-names.cjs <item_equipment.sql>` | Regenerate `resources/item-names.json` (not a test; a data build step) |

**`walk-test.cjs` and the other movement harnesses need `show: true`.** Chromium
throttles `requestAnimationFrame` in a hidden window regardless of
`backgroundThrottling`, which starves the controller to a few frames a second
and makes correct physics look broken. That cost a round of false debugging.

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

### The texture string is two fixed 8-character columns

**Established 2026-08-09, and it retires a heuristic.** The two fields are not
whitespace-separated words — they are fixed-width columns, field 1 at offsets
0–7 and field 2 from offset 8. Checked against all 83 distinct names in the
census: **83 of 83 split cleanly at index 8.**

Splitting on whitespace only works while field 1 is short enough to leave
padding. When it fills the column the two fields run together and the old
splitter saw one long nonsense word — which is precisely the set of names that
kept slipping through the filter:

| Raw string | Actually | Not |
|---|---|---|
| `kaminarikumori` | `kaminari` + `kumori` | one 14-char word |
| `bahakumokum0` | `bahakumo` + `kum0` | one 12-char word |
| `star_rivstar01` | `star_riv` + `star01` | `star_rivstar01` |
| `niji    niji` | `niji` + `niji` | (whitespace worked here by luck) |

`isSkyWeatherMesh` now slices at 8, then splits each field on underscores, so
`star_riv` still yields `star` and `riv`. Do not go back to a whitespace split.

### Sky and weather meshes are skipped by name, in either field

The texture string packs two fields, roughly `category  name`, and **the weather
identity can be in either**. The original filter only tested the category, which
left domes in a lot of zones: `fogd  clod_a01`, `dark  clod_b01`, `thdr  kumori`,
`ukfi  strm`, `squl  tenkyu01` — all weather, under categories that mean nothing
to the word list. `star_rivstar01` missed too, because the pattern required
whitespace and that name uses an underscore.

`isSkyWeatherMesh` now splits on whitespace *and* underscores and tests every
part. Matching is whole-token with only a numeric variant suffix allowed
(`clod_a01` → `clod`, `tenkyu01` → `tenkyu`), deliberately **not** a prefix
match — a prefix test would swallow anything named "windmill" or "starboard".
`tenkyu` is 天球, a celestial sphere; `strm` is storm.

**Do not fix this by eye, one zone at a time.** `scripts/orphan-sweep.cjs` loads
many zones and reports the largest unreferenced prefab still being drawn in each,
which is the shape a stray dome takes. Across 18 zones it went from 8 flagged to
3, and the 3 survivors are flat (`unk3`, height 1 — water) or thin (`spclr`), and
render correctly. Verified visually before and after in Abdhaljs
Isle-Purgonorgo, plus Bearclaw Pinnacle and Misareaux Coast (previously 6
flags) for over-removal.

An unnamed prefab of exactly 162×49×260 shows up in two unrelated zones and is
still drawn. It is not a dome in either — both render correctly — but if a dome
with no texture name ever turns up, that is the thing to look at first; no
vocabulary can catch it.

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

**The body owns its position; the camera is an output.** `feetRef` is the source
of truth. The controller originally read `camera.position` back each frame and
subtracted eye height — a stable loop only while the camera sits exactly on the
head. Third person puts it metres behind, so the body teleported to where the
camera had been, the camera moved back again, and the pair marched across the
zone at the camera distance per frame: measured 370 units per half-second with
no input at all, falling the whole way. Never derive the body from the camera.

Third person orbits the head using the same yaw/pitch, and the avatar faces its
direction of travel rather than the camera, so turning the view swings the
camera around a character that keeps walking where it was walking.

`Avatar` draws whatever character the model viewer built — `charSpec` lives in
`App` precisely so both halves share one character. Its feet sit on the ground
via `-bounds.max.y`, not the bounding-sphere radius: that radius is a diagonal
and floats the model. The animation only advances while moving, because no idle
clip has been identified yet and a walk cycle playing on the spot looks worse
than a held pose.

**No animation in `animation-paths.json` is named "walk" or "idle".** The
categories label *sets*, not individual motions, and the base movement clips sit
unlabelled inside the Battle/Motion sets. Identifying them needs someone to look
at them; a script cannot tell a walk cycle from a bow.

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

**Dithered alpha is not a cutout mask.** FFXI inherits the PS2 trick of faking
translucency with a stipple pattern — Gigas skin measures 50.0% of texels below
the alpha threshold with **100% alternation** between horizontal neighbours.
Alpha-testing that shreds the model into netting. `isDitheredAlpha()` treats
above 15% transparent *and* above 60% alternation as solid.

Alternation is the signal alpha coverage alone cannot give, and it is worth
remembering for open problem 4b: five attempts failed there because they all
measured *how much* was transparent, and genuine cutouts and terrain sit in the
same band. A cutout has contiguous transparent regions and rarely alternates.

### Player characters are assembled, not loaded

`lib/characterModel.ts` builds a PC from a race skeleton plus one DAT per
visible piece. Unlike an NPC or monster — one self-contained file with its own
skeleton — a character's skeleton is a separate file and every piece is
transformed into place by its bind-pose matrices. That is what
`parseDatFile`'s `skelMatrices` argument exists for.

Tables: `resources/model-dat-paths.json` keyed `"race:slot"` → model index →
path, and `face-paths.json` keyed by race. Both from Vanalytics.

**Slot numbering is inferred, not documented.** Slots 2–9 are the eight visible
slots the game's 20-byte "look" struct carries. The counts settle it: slot 7 has
675 models (main weapons, the largest set) and slot 9 has 129 (ranged, the
smallest). Race 1's skeleton is `ROM/27/82.dat` and its slot-2 models start at
`ROM/27/103.dat`, the same ROM directory. Order taken as head, body, hands,
legs, feet, main, sub, ranged.

**Model index 0 is "nothing equipped"** — it parses with no mesh blocks, so the
Head slot reports as failed when you select it. That is correct game behaviour,
not a bug.

Texture indices are per-file and get rebased as pools are concatenated, or every
piece would sample the first one's textures. A piece that fails to load is
reported rather than thrown: a missing glove should not cost the character.

**Player animations come from separate files.** Equipment DATs carry none, so a
composed character needs its own animation source: `animation-paths.json`, keyed
by race, ~300 sets across 24 categories. A set can span ten DATs ("Battle" does)
and each can hold several blocks, so a set yields many clips.

Because of that, selecting a character animation defaults the clip picker to the
*first* clip rather than "all together". Composing is right inside one NPC DAT —
there the blocks are an upper/lower body split of a single pose — and meaningless
across a set of separate animations.

Race 6 (Tarutaru Female) has no animation table and falls back to race 5, the
same sharing `SKELETON_PATHS` already does for the skeleton.

**Item names** come from LandSandBoat's `item_equipment` table, which carries an
`MId` and a slot bitfield per item. `scripts/build-item-names.cjs` turns that SQL
into `resources/item-names.json` (170 KB); the SQL itself is not vendored. Slot
bits map 1→main, 2→sub, 4→ranged, 16→head, 32→body, 64→hands, 128→legs,
256→feet, which independently confirms the inferred slot numbering above: body
model 5 resolves to Chainmail / Hexed Haubert, and the source row for
`hexed_haubert` is indeed `MId 5, slot 32`.

Many items share one model, so the label shows the shortest name plus
`(N more)` — **not** `+N`, because FFXI's own item names end in +1/+2/+3 and that
suffix reads as a rank.

### Animation playback

`AnimationParser.ts` reads 0x2B blocks; `lib/skinning.ts` holds the maths, split
from React so it can be tested alone. Skinning runs on the **CPU** because
`parseVertexBlock` hands back vertices already in world space plus per-vertex
bone-local positions — rebuilding that into a three.js SkinnedMesh would mean
undoing work the parser already did.

Details that matter:

- Keyframe indices count floats from the start of the descriptor array, so the
  pool is interleaved after it, not a separate section.
- An index of 0 means constant, and takes the descriptor's stored default. Not a
  hardcoded 0 or 1 — a constant quaternion component of each is a wildly
  different pose.
- Composition order is `animQ * bindQ`, because R(A)*R(B) = R(B*A).
- Dual-bone vertices weight the *translation* too (the homogeneous coordinate
  carries the weight). Treating it as a plain lerp pulls joints inward.
- **Frustum culling is off for skinned meshes.** The bounding sphere describes
  the bind pose, so a raised arm can leave it and blink out at the screen edge.

Verified by sampling vertex positions 0.9s apart: Goblin 1 moves a maximum of
0.108 units against a model radius of 1.05, with no non-finite values.

One real bug found on the way: creating three.js resources in `useMemo` and
disposing them in a `useEffect` cleanup is broken under StrictMode — React runs
the cleanup on its simulated unmount, disposing everything, then remounts and
renders the disposed resources. Build and dispose in the *same* effect.

### Weather: the geometry is there, the presentation is not

**Answered by census, not speculation.** Every zone carries a small, consistent
set of sky/weather prefabs, all of them *unreferenced* (zero instances):

| Zone | Prefabs | Categories |
|---|---|---|
| West Ronfaure | 19 | effect 8, star 4, clod 2, mist 2, suny 2, fine 1 |
| South Gustaberg | 17 | effect 6, star 4, suny 2, mist 2, clod 2, fine 1 |
| Port Jeuno | 15 | star 4, effect 4, suny 2, mist 2, clod 2, fine 1 |

The same six categories in the same rough proportions everywhere, which reads as
a per-zone set of weather *states* — sunny, fine, cloud, mist, stars — that the
game swaps between, rather than geometry meant to be drawn all at once.

A toggle to render them was built, measured and then **removed at the user's
request** — the investigation is the part worth keeping, not the feature.

It did render: unreferenced prefabs went from 36 to 55 in West Ronfaure, exactly
the 19 the census counts, so nothing was being silently dropped. But what drew
was a small yellow-and-black checkered patch on the terrain — the fallback-
texture look — not a dome. **The data is reachable; presenting it as weather is
an unsolved and separate problem.**

If this is picked up again, do not start by rewriting the parser. Render those
prefabs, Inspect one, and establish first whether the texture genuinely fails to
resolve or whether they need a transform the instance list would normally have
supplied. Those are different fixes. The removed implementation was a one-line
escape in the prefab loop (`if (isSkyWeatherMesh(prefab)) continue`) plus a
census of the skipped categories; see the commit that removed it.

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

### 4e. White screen with bloom, in some places — NOT reproduced

Ryan reports that with post-processing on, the view sometimes goes pure white in
some places in a zone; screenshot supplied for Riverne - Site #A01.

The obvious suspect is the documented one — a NaN fragment smeared white by
bloom's mipmap downsampling (§3, "Some meshes carry zero-length normals").
**A NaN was looked for and not found**, so do not assume that is the cause:

- `[NANSCAN]` (new) sanitises and counts non-finite **positions, UVs and vertex
  colours** at geometry build, alongside the normals that were already handled.
  It reports **nothing** in Riverne, Misareaux, Purgonorgo or zone 100 — those
  attributes are entirely finite. The guard is kept as cheap insurance, but it
  did not fire.
- Census bounds confirm it independently: 0 non-finite of 479 unreferenced
  prefabs.
- `sweep.cjs` over Riverne peaks at mean brightness **193**, under the 200
  blow-out threshold, so an in-place angle sweep from spawn does not reproduce
  it. It is **position**-dependent, not angle-dependent, and the sweep only
  rotates where it stands.
- Suppressing every unreferenced prefab (`?nounref=1`) moves the peak from 193
  to 189, so the stray cloud geometry is not driving it either.

What has **not** been tested, and is now the strongest remaining candidate: the
**hand-written water shader**. It computes in GLSL, so a NaN born there is
invisible to `[NANSCAN]`, which only checks attributes. Riverne carries water
prefabs (blend `0x2000`: `jug_wk01/02/03/07`, `rat_w02c`), and that shader has
form — it silently dropped every draw for days over the log-depth bug.

**The decisive test needs a reproduction, which needs Ryan.** When it next
happens, the bisect is two switches: `?nowater=1` (water drawn with the ordinary
opaque material — if the white goes, it is the water shader) and toggling Bloom
off (confirms bloom is the amplifier rather than the source).

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

> **Partly resolved, 2026-08-08.** The DXT3 alpha *decode itself was checked and
> is correct*: nibble order and the `(a << 4) | a` expansion in
> `decompressDXT3` both match the reference. If alpha is still wrong it is about
> *which bytes reach that function* — the A1/81/B1 header offsets, or the
> `guessCompressedLayout` fallback that infers the pixel offset by working
> backwards from the end of the block. That fallback is the shakier code. Do not
> re-check the nibbles.
>
> **A better lead for 4b now exists.** Model textures turned out to use PS2-style
> *dithered* alpha — a literal checkerboard, measured at 50.0% of texels below
> threshold with **100% alternation** between horizontal neighbours. The fix was
> `isDitheredAlpha` in `lib/modelBuild.ts`, which separates a stipple from a
> cutout by *alternation rate* rather than transparent share.
>
> That is exactly the signal 4b has been missing. All five failed attempts there
> measured **how much** was transparent, and genuine cutouts and terrain sit in
> the same band. A cutout has contiguous transparent regions and rarely
> alternates. **Try the alternation metric on terrain textures.** It cost one
> measurement to find and it works on model art.

The original note follows.

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

- **Zone music.** Ryan's request, 2026-08-09: play a zone's music while it is
  loaded. A first look says this is very achievable. The music is **not** inside
  the ROM DAT archives — it is ordinary files on disk at
  `<install>/sound<N>/win/music/data/musicNNN.bgw`, **224 of them** across
  `sound`, `sound2`…`sound9` (111 in `sound` alone). They open with the ASCII
  magic `BGMStream`. Alongside them are ~11,800 `.spw` files, which are sound
  effects rather than music.

  What is not yet known, and should be established before any player is written:
  (a) what the BGW container actually holds — streamed ADPCM is the likely
  answer, and if so it needs decoding to PCM before the Web Audio API will take
  it; (b) which `musicNNN` belongs to which zone. The zone→music mapping is not
  in the seed CSV, and LandSandBoat's zone tables are the obvious place to look,
  the same source `resources/item-names.json` came from. Do the mapping first —
  a decoder with nothing to point it at proves nothing.

  Electron can read these directly through the existing `ffxi:readDat` IPC path;
  it takes a root plus a relative path and does not care that the file is not a
  DAT.

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
