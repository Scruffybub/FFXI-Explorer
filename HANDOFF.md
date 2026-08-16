# FFXI Zone Viewer — Development Handoff

Context for continuing work in a fresh session.
Written 2026-08-03; substantially revised 2026-08-08 and 2026-08-15.

---

## 0. Start here — state of play

Last worked 2026-08-15. Everything below is committed and pushed; the packaged
exe in `release/` is current.

**Read §2 (how to debug this) before changing anything.** Nearly every hour lost
on this project went to theorising instead of measuring.

### The one rule this session kept proving

**Verify the way the user will see it.** Two separate failures came from
forgetting that:

- A full session's work never reached Ryan because `npm run build` only feeds
  `out/` and the headless harness. He runs `release/*.exe`. **Repackage before
  claiming anything is done** (`npx electron-builder --win portable --config
  electron-builder.yml`).
- The overlay-blend regression — geometry popping in and out as the camera
  moved — **rendered perfectly in every screenshot the harness took**. Motion
  artefacts are invisible to a still frame. Anything touching materials,
  transparency or draw order needs checking in motion, by hand.

### What is live and worth picking up

| | Status |
|---|---|
| **4c — pale ground squares** | **Mostly fixed, still open, and the fix now ships OFF by default** (2026-08-15, Ryan's call). Ryan: "still some squares in Gustaberg, although much less than before." Cause, fix and the default flip are in §4c; the remainder is unexplained |
| **4e — white screen with bloom** | Not reproduced. Needs Ryan to say *where* in a zone it happens, then it can be driven headlessly |
| **4a / 4b — water, cutout alpha** | Both downstream of the alpha question. **Read §5a first** — three readings of the alpha channel have been eliminated by measurement, and §5's old lead is superseded |
| **Diorama** | The last unstarted roadmap item, and the only one that builds rather than debugs |

### Finished this session, do not redo

- **Zone music** — mapping, PS-ADPCM, and a full ATRAC3 port validated
  bit-exactly against ffmpeg. All 74 ambient tracks play. §6.
- **Map view** — orthographic top-down capture, fog suppressed. §3.
- **Weather** — geometry fully identified; parked because FFXI ships no
  placement for it. §0b, and do not tune it further without new information.
- Panel clipping, and the hidden-panels/fullscreen viewport collapse. §3.

### Diagnostics available

All are query params on the built app; `scripts/smoke.cjs` passes them through
`EXTRA_QUERY` and its console filter already includes every tag below.

| Switch | What it gives |
|---|---|
| `?census=1` | `[CENSUS]`, `[BLENDHIST]`, `[ALPHAHIST]`, `[CUTOUT]`, `[UVALPHA]`, `[UVSTRADDLE]`, and exposes **`window.__zoneData`** — the whole parsed zone, for any harness |
| `?pick=<substr>` `?pickaxis=` | Draw only matching prefabs, framed. How the weather geometry was identified |
| `?valpha=off\|direct\|double` | Override the terrain-overlay alpha reading |
| `?uvfix=1` | Tested and rejected for 4c; kept so it is not retried |
| `?blendexp=1\|2` | Global blend-flag experiment; made things worse, see §4f |
| `?music=1` | Start music at launch; every state change logs `[MUSIC]` |
| `?nowater=1` `?nounref=1` `?walkdebug=1` `?modeldebug=1` | Older switches, still good |

---

## 0b. Weather — identified, built, and deliberately parked

**The census is done and the geometry is identified. What remains is deciding
how to present it — and that is blocked, see below.**

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

**3. All of it is a parked prefab library, not placed scenery.** This is the
single most important thing on this page and it was established last, by
measuring centres rather than reading names.

Every unreferenced group in every zone measured sits **at the zone origin**.
Misareaux Coast spans x[-560,840] z[-563,760]; its unreferenced groups centre
at: `effect` (4,-5,1), `clod`/`wind` (2,-17,-3), `bahakumo` (0,0,0),
`kaminari` (0,3,1), `niji` (0,-17,-12). Riverne's spread out to at most 23 units
from origin against a zone spanning x[-884,966].

That is the "area where the dome used to be" Ryan described: a storage yard at
the origin holding everything the client instantiates at runtime — weather
states, effects, cutscene geometry. **Their placement is not in the MZB instance
list**, so drawing any of them at identity piles them at the origin. That is
exactly the artifact in Ryan's rainbow screenshot.

**A correction, because it shaped a code decision.** An earlier revision of this
file claimed Riverne's 142 unreferenced `model  …` prefabs (`ba_wal01`,
`lat_wf`, `jug_wk*`) *are* the floating islands, and that a filter catching
`model` would delete the zone. **That was wrong.** They cluster at the origin
like everything else; the islands come from the 18,053-entry instance list.
Rendering Riverne with `?nounref=1` — every unreferenced prefab dropped —
changes the frame by a mean absolute difference of **0.256 out of 255**.

`NEVER_WEATHER` still excludes `model`, but for the modest reason that it names
a geometry template rather than a weather state, not because the zone depends
on it.

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

**That first reading was wrong, and the correction is the useful part.**
`WATER_NAME_RE` contains `taki` and `kawa`, and `isWaterPrefab` tests **the name
only** — not the blend flag, not whether the prefab is referenced. So all nine
waterfall meshes were already going down the custom water shader, and the dark
cloth was *that shader's output*, not a missing blend mode. Proven rather than
argued: a `[BLEND]` counter reported the override applying to **0 materials**
until `?nowater=1` moved them off the water path, whereupon it applied to 9.

Two things follow, and the second is the prize.

**1. §4a's description of water selection is stale.** It says "only unreferenced
prefabs carrying blend flag `0x2000` are treated as water". The code does not do
that; `isWaterPrefab` is a name-regex test and ignores both the flag and the
instance list. Trust the code.

**2. Off the water path and drawn additively, the waterfall looks right.**
`?pick=taki&nowater=1&blend=additive&novcolor=1` renders bright translucent
wispy ribbons that read unmistakably as falling water and spray — a
transformation from the dark cloth of the default path. Measured mean abs
difference over the viewport: 2.78 against the water-shader render, where the
earlier no-op attempts sat at 1.09.

The recipe that worked, all three parts needed:

- `AdditiveBlending` with `transparent: true` — the sheet is authored to be
  added to what is behind it
- `depthWrite: false` — otherwise the ribbons occlude each other
- `alphaTest: 0` — the cutout was eating the soft edges that make it read as spray
- vertex colours dropped — FFXI stores very dark values here and they multiply
  an additive layer down to nothing

**A caution that cost a round of debugging:** `alphaTest` and `vertexColors` are
shader *defines* (`USE_ALPHATEST`, `USE_COLOR`). Changing them after the
material is constructed does nothing at all without `material.needsUpdate =
true`. Three renders came back numerically identical before that was added.

**Not yet made global, deliberately.** `0x8000` is carried by the weather domes,
the cloud layers and the rainbow as well, and `taki`/`kawa` currently divert to
the water shader before any of this is reached. Deciding what the flag means for
all of them is the next call, and it is Ryan's.

### Should any of this be visible? Not yet — placement is the missing half

Ryan asked directly whether the waterfall is supposed to show in the app. As
things stand, **no**, and the centre measurements above are why: it is parked at
the origin, not standing on a cliff. Drawing it in an ordinary zone view puts a
waterfall in a heap at the zone centre.

So the work splits cleanly in two, and only one half is done:

| | Status |
|---|---|
| **Appearance** — make a prefab look like what it is | Solved for the waterfall: additive, no depth write, no alpha test, no vertex colour |
| **Placement** — know where each one goes | **Not started, and not in the MZB instance list** |

Until placement is answered, everything here belongs behind `?pick=`, which is
why the blend overrides are gated that way. The honest summary is that the
weather geometry is fully identified and can be made to look right, and that
what is missing is the data saying where and when the client puts it.

**Looked for, 2026-08-09. The zone file does not contain it.**

Two diagnostics were added to `ZoneFile.ts`, both permanent:

| Log | Reports |
|---|---|
| `[MZBMATCH]` | how many MZB entries matched an MMB name, and which names were dropped |
| `[MMBNAMES]` | MMB blocks that **no** MZB entry ever names |
| `[ORPHANSRC]` | unreferenced prefabs grouped by the MMB block they came from |

The MZB instance list is the only placement data in a zone file, and it never
names the weather geometry. Misareaux Coast: **60 of 274 MMB block names are
never referenced**, and they are exactly the set in question — `niji`,
`clod_a01`, `suny_a01`, `yuhi`, `kum0/1/2`, `thunder1`, `smoke01`, `star`,
`kmi1/2/3`, `hamo`. Riverne: 131 of 266.

`[ORPHANSRC]` closes the loop: every unreferenced prefab traces back to one of
those blocks. It also reveals what the MMB block name actually is — **the second
column of the texture string**. Texture `niji    niji` comes from MMB block
`niji`; `clod    clod_a01` from block `clod_a01`. So field 2 names the *element*
mesh and field 1 is the *state* it belongs to, which is the two-column reading
confirmed from the other direction.

The MZB entries that go the other way — naming blocks we have no MMB for — are
collision proxies, not visuals: `hit_32c_coi1`, `col_kabe`,
`kabe-atariyou` (壁 = wall, "for wall collision"), and `x`-prefixed names.
Dropping them is correct.

**Conclusion: FFXI does not ship placement for this geometry in the zone file.**
It is a library the client instantiates at runtime — weather by state, effects
by trigger. Anything that places it here is our invention, and that is a design
decision rather than a parsing one.

**A separate population hides in the same set.** Riverne's never-named list is
full of `_h`/`_l` suffixed names — `_rat_w04_h`, `_tab_sugi1_h`, `bah_iwa2_l` —
which read as high/low **LOD variants** rather than weather. If the client picks
a detail level at runtime from a base name, those are unreferenced for an
entirely different reason and should not be swept up with the weather.
Unconfirmed; the `_h`/`_l` pairing is the only evidence so far.

**A caution about the diagnostics themselves.** The first run of `[MMBNAMES]`
reported `never named: 0`, which would have meant the opposite conclusion. That
was a bug in the diagnostic — a `String.replace` that silently failed to apply,
leaving a set-difference computed against the wrong collection. It was caught
only because the number contradicted `[ORPHANSRC]`. When two diagnostics
disagree, suspect the diagnostic before the data.

### The weather state selector — built 2026-08-09

**Scene panel → Weather → State.** A per-zone dropdown listing the states that
zone actually carries geometry for, plus a "Follow camera" toggle. Misareaux
Coast offers 12: `bahakumo`, `clod`, `effect`, `fogd`, `kaminari`, `mist`,
`niji`, `star`, `suny`, `thdr`, `wind`, `yuhiumi`. `WEATHER_LABELS` in
`ControlPanel.tsx` gives readable names and **falls back to the raw token**
rather than hiding anything the vocabulary does not cover yet.

How it works, and why:

- Weather geometry is now **built** rather than skipped, tagged with
  `userData.weatherState`, and starts hidden. Switching state flips
  `mesh.visible` — no rebuild, because a rebuild takes seconds and makes
  flicking between states unusable.
- Default is None, and the default frame is **byte-identical** to before the
  change (mean absolute difference 0.000). Nothing draws until you choose.
- One state at a time, which is the whole point. The old `showWeather` drew
  every state at once and that is why it looked like nonsense.

**Follow camera only applies in walk mode, and that was measured, not assumed.**
Centring a 241-unit dome on the camera in orbit or fly parks it behind you and
it disappears entirely — mean absolute difference **0.000** against the
no-weather frame, where leaving it at the origin gives 0.274. Orbit and fly put
the camera outside the zone looking in; walk is the one mode where the camera is
a person standing in the world.

In walk mode it works: Misareaux with `thdr` drops mean frame brightness from
94.8 to 22.0, a difference of **75.8**, and reads as a dark churning storm sky
overhead. `suny` gives 67.1.

**What is still wrong with it — Ryan's verdict, 2026-08-09: "none of them seem
to work properly."** Treat that as the status. The selector is mechanically
correct and the geometry is the right geometry, but no state yet reads as
convincing weather. Known contributors:

- The layers are flat sheets, not a closed dome, so a hard-edged polygon cuts
  across the sky at their boundary.
- Height is left at the authored value; nothing knows how far overhead a layer
  should sit.
- Scale is untouched. A 241-unit sheet may want scaling to the draw distance.
- Placement is our invention throughout, flagged in the toggle's own hint.

**`effect` is not a weather state and should probably not be in this list.**
Ryan found the Misareaux waterfall rendering under "Effects (mixed)", which is
correct behaviour but confusing framing: `effect` is the catch-all *category*
holding waterfalls, rivers, sea and the rainbow, not a weather condition the
client picks between. It earns its place for now only because it is a
convenient way to see that geometry. If the weather list is ever cleaned up,
split `effect` into its own control rather than deleting it.

**Do not tune this further without new information.** Everything remaining is
guesswork about intent, and the project's own history is that guesswork costs
more than it returns. The unblocking fact would be placement or scale data, and
§0 records that the zone file does not contain it.

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
| `src/renderer/src/lib/zoneExpansion.ts` | Which expansion a zone shipped with, derived from its ROM archive |
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
| `expansion-check.cjs` | Read the expansion tag the sidebar renders for all 285 zones and cross-check it against the CSV's archive and the name rules |
| `panel-inventory.cjs` | List every control the settings panel renders, with whether it has an info icon. `EXTRA_QUERY` reveals the conditional ones |

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

### The in-game area maps — Models → Maps

**Where they live was never a mystery; the answer was already in the repo.**
`resources/zone-seed-data.csv` has a `MAP_PATHS` column, `lib/zoneList.ts` has
always parsed it into `ZoneEntry.mapPaths`, and nothing had ever read it. **191
of the 285 zones carry map pages.**

Each listed DAT holds one 512×512 texture whose id names it:
`menumap m_<zone>_<page>`, or `ex4_datam_<zone>_<page>` for the expansion maps.
Zones with floors get a page each — Castle Oztroja's are 1-6 plus 15.

Three things that cost a measurement each:

- **A row lists its counterpart's maps too.** North Gustaberg's entry carries
  both `m_106_00` and `ex4_datam_088_00`, and 88 is North Gustaberg [S], which
  has its own row listing the same pair. `MapViewer` filters pages by the zone
  id in the name, falling back to showing everything if none match.
- **Palette-indexed plates are stored bottom-up; DXT ones are not.** Castle
  Oztroja's floor 1 is `indexed` and came out mirrored-looking until all four
  orientations were rendered and read: only the vertical flip puts the banner at
  the top, the grid letters A-O left to right and the compass at bottom right.
  North Gustaberg's is `dxt3` and is correct untouched.
- **`parseMinimapDat` already existed and already handled both**, exported from
  `lib/ffxi-dat/index.ts` and used by nothing. An earlier session built the
  parser and never wired a UI to it. Use it rather than `parseTexturesFromDat`,
  which does *not* flip.

**The palette is ARGB, and reading it as BGRA is what made every map pink.**
One little-endian word per entry: alpha, then blue, green, red. Read as BGRA,
the *constant* alpha byte lands in blue — pinning it at 128 — and the real red
lands in alpha, so the parchment came out pink, the red "Valkurm Dunes" label
purple, and the torn edges' opacity tracked their redness.

Measured in Selbina's `m_248_00` rather than guessed, and the measurement is
worth repeating if this is ever doubted:

- byte 0 holds `0x80` in **all 256 entries**. A colour channel does not do that;
  FFXI's fully-opaque alpha does.
- the parchment entry is `80 9e ca d6`. As A,B,G,R that is **(214, 202, 158)**,
  the warm tan the game shows. As BGRA it is a light blue nobody has ever seen
  on a Vana'diel map.

Alpha doubles on the way out, since `0x80` is the opaque end.

**A lead, unmeasured, and now a strong one.** `TextureParser.parseB1Texture`
carries **the same two bugs**: it reads the palette as BGRA with alpha at byte 3,
and it does not flip the rows. Whatever it decodes is upside down with blue
pinned to 128. Nobody has checked which zone or model textures are 0xB1
palette-indexed, or whether three's `flipY` cancels the flip in 3D — but the
README already lists textures rendering wrongly as a known issue, and this is
the first concrete candidate. Start there.

`ParsedTexture.format` is now declared. The parser had always set it and
ZoneViewer had always read it, so `tex.format` was a type error in three places
— that is five of the fourteen pre-existing `tsc` errors gone.

### The update check is hand-rolled, and deliberately

`src/main/updates.ts` asks the GitHub releases API for the latest tag a couple
of seconds after launch, and the renderer shows `UpdateNotice` only if it is
newer. **electron-updater was rejected for two concrete reasons**: the packaged
app ships `out/**` and `package.json` only — `node_modules` is not packaged — so
a main-process dependency has to end up bundled into the main chunk to exist at
runtime; and electron-updater cannot install a **portable** build at all, which
is the artifact most people will run.

How each artifact updates: an installed build downloads the `-setup.exe`, spawns
it detached and quits so the installer can replace files it was holding open. A
portable build downloads the `-portable.exe` and opens its folder, because a
running portable exe cannot overwrite itself — `process.env.PORTABLE_EXECUTABLE_FILE`
is how it tells which it is.

Things worth keeping:

- **Every failure is silent.** GitHub unreachable, offline, rate-limited, repo
  private — all log `[UPDATE]` and show nothing. Verified against the private
  repo, which answers 404: `[UPDATE] check failed: HTTP 404` and no popup. It
  will start working the moment the repo goes public, with no code change.
- **Downloads are size-checked** against what the release advertised, and only
  `github.com` / `objects.githubusercontent.com` hosts are accepted, on the
  original request and on every redirect.
- **The preference lives in `localStorage`, not `SceneSettings`** — presets
  apply over `DEFAULT_SCENE`, so a preset click would otherwise silently
  re-enable a check the user turned off.
- **`isNewer` is split into `src/main/version.ts`** so it can be tested without
  Electron: `node scripts/version-test.cjs`, 15 cases, all passing. It is the
  one function that decides whether every user gets nagged, and a mistake there
  is invisible in a screenshot.
- **`?updatetest=1`** shows the popup against a fabricated release, so the UI
  can be exercised without publishing one. Its asset is null, so nothing
  downloads.

**The README's "no internet connection is involved" claim was true and is not
any more.** It now says the version check is the only request the app makes, and
points at the toggle. Keep that honest if this ever grows.

### The app icon needs a three-step build, and a plain repackage loses it

**If you rebuild with `electron-builder --win` alone, the icon silently reverts
to Electron's default atom.** The release build is:

```
npx electron-vite build
npx electron-builder --win dir --config electron-builder.yml
node scripts/set-icon.cjs
npx electron-builder --prepackaged release/win-unpacked --win portable nsis --config electron-builder.yml
```

Why it cannot be one step: embedding an icon requires
`signAndEditExecutable: true`, which makes electron-builder unpack its
winCodeSign bundle, and that bundle holds two macOS symlinks
(`darwin/10.12/lib/libcrypto.dylib` and `libssl.dylib`) that Windows refuses to
create without `SeCreateSymbolicLinkPrivilege` — administrator, or Developer
Mode. 7-Zip exits non-zero, electron-builder retries into a **fresh random temp
directory** each time and never promotes one to a usable cache, so the build
dies. The dated leftovers under
`%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\` are every attempt since
2026-07-27. `signAndEditExecutable: false` in the config is what makes packaging
work at all, at the cost of the icon and the exe's version metadata.

The workaround takes the one step that was actually wanted. `rcedit` lives
*inside* that same bundle, and a copy is already extracted, so
`scripts/set-icon.cjs` finds it and stamps the icon directly;
`scripts/make-icon.cjs` builds the 7-frame `.ico` (16–256) from a PNG using
Electron's own `nativeImage` resizing, so there is no image dependency. The
`--prepackaged` step then wraps the directory as it stands rather than
rebuilding it.

Verified for 0.1.0 by extracting the icon back out of all three executables —
the app, the installer and the portable — and by **launching the packaged
portable build**, which reported a window titled "FFXI Explorer". That last
check matters: `rcedit` rewrites the resource section *after* electron-builder
writes the asar integrity resource, and a launch is the only thing that proves
it did not break startup.

If Developer Mode is ever switched on, the whole workaround can be deleted and
`signAndEditExecutable` set back to true.

### Every setting explains itself, through an info icon

`components/Info.tsx` — a lowercase "i" in a circle beside a control's name,
opening a hover popup with a sentence or two. Both panels use it: the zone
panel's 67 controls and the model panel's 12 all carry one, and the long
explanatory paragraphs that used to sit under a handful of settings are gone
into the icons. Only genuinely non-setting prose is still printed: the fly/walk
key help, the third-person animation caveat, the map-view tip, the live music
status and "this zone carries no weather geometry".

Details that are the way they are on purpose:

- **The popup is portalled to `document.body` and positioned `fixed`.** The
  panels scroll, and `overflow-y: auto` clips anything leaving the box, so a
  popup parented to the control is cut off near the panel edges.
- **It opens to the left of the whole panel, not of the icon.** Anchoring to the
  icon put the card over the control it was explaining. `Info` reads
  `closest('.panel')` for that edge.
- **`pointer-events: none`,** or moving the pointer toward the popup would
  dismiss it.
- **The icon's click handler calls `preventDefault()`.** Every icon sits inside
  a `<label>`, and clicking a label activates its control — without it, reaching
  for an explanation would toggle the setting.

**A verification trap, and the second time this project has hit it.** The popup
measured perfectly in the DOM — right rect, `visibility: visible`, parented to
body — and was **absent from the screenshot**. A hidden Electron window does not
composite newly created layers into `capturePage`. `walk-test.cjs` already needs
`show: true` for rAF; anything that appears only on interaction needs it too.

`scripts/panel-inventory.cjs` lists every control the panel renders, in order,
with whether it has an icon. Running it before and after the refactor is what
proved no control was lost: 66 labels before, the same 66 after plus the weather
**State** dropdown, which had never had a label at all.

### Anisotropic filtering

**Scene → Anisotropic filtering**, a power-of-two slider from Off to 16×,
defaulting to **16**. Stored as the sample count, so `?scene_anisotropy=8`
reads naturally. FFXI's own renderer had none of this, so Off is the authentic
setting — the presets do not override the default, which means even
Original (2002) currently renders with 16×.

Two things worth keeping:

- **Anisotropy is a sampler parameter, so three only sends it to the GPU while
  uploading a texture.** Setting `texture.anisotropy` alone changes nothing on
  screen; `texture.needsUpdate = true` is what makes it take. This is the same
  shape of trap as `alphaTest`/`vertexColors` needing `material.needsUpdate`.
- It is applied by an effect over the textures the build memo returns, **not by
  a memo dependency** — a zone rebuild costs seconds, re-uploading 53 textures
  costs milliseconds. `ZoneViewer` sits outside the Canvas and has no renderer
  to ask for `getMaxAnisotropy()`, which does not matter: three clamps the value
  to the GPU limit on upload.

Measured in West Ronfaure at eye level, Off against 16×: mean difference
1.195/255 with **14.4% of viewport pixels moving** and a peak of 238. Crops of
the distant ground confirm the direction — grass keeps its grain into the
distance instead of smearing to a flat wash.

### The expansion tag comes from the ROM archive, not a hand-written list

The sidebar shows each zone's expansion beside its DAT path. The classification
is **derived from the install**: FFXI shipped each expansion in its own archive
and the zone table's model path names it — ROM2 Zilart, ROM3 Promathia, ROM4
Aht Urhgan, ROM5 Wings, ROM9 Adoulin, plain ROM the base game.

The split is exact. ROM2 holds precisely the Zilart set (Sky, the jungles,
Altepa, Norg, Kazham, Dynamis), ROM3 the Promathia set, ROM4 ids 46-79, ROM5
every `[S]` past zone. `scripts/expansion-check.cjs` reads the tag the sidebar
actually renders for all 285 rows and cross-checks it against the archive plus
two name rules (`[S]` must be Wings, `Abyssea - ` must be Abyssea); it reports
0 disagreements.

**What the archive cannot answer.** Content from later version updates has no
archive of its own — it was appended to the base ROM under high directory
numbers (ROM/240 upward), so the archive rule alone calls it base game. Those
25 zones are listed by id in `lib/zoneExpansion.ts`. Ten are Abyssea and three
are Adoulin; the remaining thirteen (Provenance, Legion, Feretory, Escha,
Reisenjima, Desuetia, Dynamis Divergence) each came from a different year's
update and belong to no expansion, so they carry a deliberately coarse
**Update** tag. Sharpening those needs Ryan, not a guess.

Two zones read as Promathia because that is where their data sits, though their
*use* is much later: Diorama Abdhaljs-Ghelsba and Abdhaljs Isle-Purgonorgo,
both in ROM3.

**A false pass worth remembering.** The first run of the check reported "no
problems" over **zero rows** — the harness returned null from `ffxi:autoDetect`,
so the app showed its setup screen and the list never rendered, and every rule
passed vacuously. It now fails unless the rendered row count matches the CSV.

### The grid collapsed the viewport when the panels were hidden

`.app` is a three-column grid that relied on **auto-placement**, and
`.app.ui-hidden` sets `display: none` on the sidebar and panel. That removes
them from the grid entirely, so the viewport — now the first in-flow child —
auto-placed into **column 1**, which `ui-hidden` sizes to `0`.

Measured: after Hide panels the grid read `0px 1386px 0px` while `.viewport`
measured **0×837**. The canvas kept its old backing buffer and still showed a
stale image, so it looked fine until something forced a re-measure. Going
fullscreen did exactly that, which is why it took *both* buttons for the view to
vanish — and why it looked like a fullscreen bug when it was not.

Fixed by pinning columns explicitly: `.sidebar { grid-column: 1 }`,
`.viewport { grid-column: 2 }`, `.panel { grid-column: 3 }`. Verified — the
viewport now goes 826 → 1386 → 1707 across the same sequence.

### Map view: orthographic top-down capture

**Scene panel → Map view.** A toggle, a zoom slider (1.00 frames the whole
zone) and a rotation slider. `MapCamera` in `ZoneViewer.tsx` installs an
`OrthographicCamera` and takes the camera over completely — no controls run in
this mode, since anything that re-aims the camera stops the projection being a
plan view.

Why orthographic: a perspective camera has a vanishing point, so a bird's-eye
shot splays walls outward and only the centre of frame is true. Orthographic has
no vanishing point at all — parallel lines stay parallel and everything draws at
true relative size, which is what makes the capture usable as a map.

Two details worth keeping. The frustum is sized in **world units** rather than
drei's pixel default, so coverage does not change with the window size and a map
captured at one size matches one captured at another; aspect comes from the
canvas so the ground is never stretched. And `up` is set before `lookAt`, or the
view spins when the camera direction is parallel to the default up vector.

Fog is **suppressed** while map view is on, and the Scene panel says so. Fog shades by distance from the camera, which would darken one edge of what should be a flat, evenly-lit plate. It is overridden at the render rather than written into the setting, so the fog value survives and returns when map view is switched off — no save-and-restore bookkeeping to get wrong. Verified: map view with fog 4 and fog 0 produce identical frames (mean 74.8 both), while a normal view at fog 4 reads 186.4.

Pairs with the existing **Screenshot** button. Turning off Show sky and picking
a flat background gives a cleaner plate to trace over.

**Fixed scale, for stitching zones together.** `mapZoom` is a fraction of each
zone's **bounding diagonal**, so one zoom value means a different scale in every
zone — and that diagonal includes height, so even equal ground footprints differ.
Measured at zoom 1.00: Chateau d'Oraguille covers 208 units, Windurst Waters
869, Misareaux Coast 2,901 — a **14x** spread. Captures taken that way cannot be
assembled into an atlas without per-zone rescaling, and the zoom slider's 2.00
ceiling makes correcting it from the UI impossible anyway.

`scene.mapFixedScale` + `scene.mapUnits` frame a set number of world units
instead. Verified by `[MAPVIEW]`, which every map-view render now logs: those
three zones at 2,000 units all report **2.3885 units/px**, against 0.2481,
1.0378 and 3.4650 unfixed. A small zone then sits as a small object in a large
empty frame, which is what sharing a scale with Misareaux Coast actually means.

`MapCamera` reports the scale up through `onMapScale` so the panel can print
"covers W × H units at N units/px". Units per pixel is the number that decides
whether two captures stitch, and it needs the canvas size — which only exists
inside the Canvas, hence the report upward rather than a sum in the panel.

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

### 4f. Blending cannot be fixed before the alpha channel is — measured 2026-08-11

Attempted the blend-mode work and got a **negative result worth more than the
change would have been.** Two new diagnostics, both permanent:

- `[BLENDHIST]` — blend flags split by referenced vs unreferenced. **0x8000 sits
  on 27–40% of the *visible* geometry of every zone measured** (West Ronfaure 79
  of 294 referenced, zone 103 203 of 512), 0x2000 on 4–22%. A global change here
  touches a third of the world.
- `[ALPHAHIST]` — the alpha distribution across a zone's textures.

`?blendexp=N` runs the experiment globally: `1` makes 0x2000 a real alpha blend,
`2` also makes 0x8000 additive. Swept over zones 100, 103, 25, 130 from orbit
and West Ronfaure at ground level:

| View | Baseline dark px | exp1 | exp2 |
|---|---|---|---|
| West Ronfaure, walk | 10.19% | **13.35%** | **12.93%** |
| Zone 103, orbit | 0.12% | 0.19% | 0.14% (+0.08% blown) |

**Both make it worse.** Turning on transparency darkens the scene rather than
revealing anything, and additive introduces blown highlights.

**`[ALPHAHIST]` says why, and it confirms §5's standing suspicion:**

| Zone | texels ≥250 | texels ≤5 | mid-range | median per-texture mean |
|---|---|---|---|---|
| West Ronfaure | **11.19%** | 29.27% | 59.54% | 128 |
| Zone 103 | 12.02% | 44.39% | 43.59% | 92 |
| Misareaux | 12.35% | 31.01% | 56.65% | 89 |

Only about **an eighth of all texels are opaque**, and over half sit in the
mid-range. Terrain art should be overwhelmingly alpha 255 with cutouts at a hard
0. Enabling real blending against alpha of ~100/255 makes solid ground
half-transparent, which is exactly the darkening measured.

**So the order of work is fixed: alpha first, blending second.** Alpha-testing
everything — today's behaviour — survives only because a 0.1 threshold ignores
the mid-range entirely. It is the least-bad response to bad data, not a correct
choice, and no blending experiment can succeed until the data is right.

This also reframes 4a and 4b: both are downstream of the same cause, which is
why five attempts at 4b that measured *transparent share* all failed. §5 already
narrowed the suspects — not the DXT3 nibble decode, which was checked, but
**which bytes reach it**: the A1/81/B1 header offsets and the
`guessCompressedLayout` fallback that infers the pixel offset backwards from the
end of the block. Start by breaking `[ALPHAHIST]` down per texture *format* to
see whether one path produces all the mid-range alpha.

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

### 4c. MOSTLY FIXED, STILL OPEN — pale tiles are overlay layers drawn opaque

**Largely fixed 2026-08-15, but NOT closed.** Ryan, after the fix: *"there are still some squares in Gustaberg, although much less than before."* The mechanism below is right and the bulk of the artifact is gone; some remainder has a cause not yet identified. **Start here if picking 4c up: find what the surviving squares have in common that the fixed ones did not.** The obvious next cut is to dump the per-mesh vertex-alpha shape (flat vs ramp, min, max) for the meshes still showing pale, using `window.__zoneData` under `?census=1`, and compare against the ones that came good.

 Scene → **Blend terrain overlays**, **off by default as of 2026-08-15 at Ryan's request** — the fix is real but incomplete, so the shipped default is the known-good old render and the blend is opt-in until the surviving squares are understood. `?valpha=off|direct|double` overrides the toggle for testing. Verified after the flip: South Gustaberg at the default is byte-identical to `?valpha=off` (mean abs difference 0.000) and differs from `?valpha=direct` (0.101), and `[VALPHA]` no longer logs unless the toggle or the param turns it on.

**A regression followed and was fixed — read this before touching the overlay path.** Ryan reported models and texture squares popping in and out while flying around Misareaux Coast. Two causes, both mine:

1. **The overlay test was too broad.** It blended anything below full opacity, which in Misareaux is 595 of 608 meshes — 376 of them sitting at a *flat* 0.50. A constant alpha is not a fade whatever its level; only a **varying** one is. The test is now `(rawMax - rawMin) > 0.02`, which drops Misareaux to 165 of 608, South Gustaberg to 166 of 397 and West Ronfaure to 75 of 349, and the squares stay fixed.
2. **depthWrite was off.** That is the textbook setting for transparency and it is wrong here: these are terrain and foliage, not glass. Once they stop writing depth they stop occluding each other, so whatever the transparent queue draws last wins — which is exactly geometry popping in and out. It stays on; coplanar overlays do not need the ordering freedom, and polygonOffset already keeps them off their base.

Note that **motion artefacts cannot be caught by the still-frame harness**. Both of these rendered perfectly in every screenshot taken. If the overlay path is changed again, it needs checking in motion by hand.

The surprise was which reading of the alpha won. The code warned that 128 is *neutral* for the RGB channels, so `double` (opacity = min(1, a×2)) was the reasoned default — and it changed almost nothing (0.02% of pixels). **`direct` is correct**: the value is opacity as stored, so alpha is NOT on the same convention as RGB here. It removes the pale squares and moves 3.5% of the frame. Swept across West Ronfaure, zone 103, Misareaux and North Gustaberg — differences of 0.2 to 1.5 mean, no sorting artefacts, nothing broken.

The atlas hypothesis was right about the textures and wrong about the cause.

**1. `gus_02` really is an atlas.** Dumped to PNG and looked at: a 512×512 sheet
with green grass top-left and bottom-left, brown dirt through the middle, grey
rock down the right edge, and a black unused block at bottom-centre. Emphatically
not seamless. `scripts/`-adjacent dumper lives in the scratchpad; `?census=1` now
exposes `window.__zoneData` so any harness can pull textures, UVs and geometry
without a new log format each time.

**2. UV straddling is real but is NOT the cause.** `[UVSTRADDLE]` splits meshes
into inside / straddling / tiling. South Gustaberg 270/22/105, North Gustaberg
443/48/172, West Ronfaure 308/2/39 — the Gustaberg zones straddle far more, which
looked damning. `?uvfix=1` slides those rects back inside 0..1, and it fires on
exactly the 22 meshes. **The pale patches survive it unchanged.** Measured 0.41
mean difference over the frame; the artifact is untouched. Hypothesis tested and
rejected — do not re-run it.

**3. The pale tiles are FFXI's terrain overlay layer, drawn at full strength.**
Prefabs come in **pairs sharing a texture and an instance count**, one opaque and
one partial:

| prefab | texture | vertex alpha | instances |
|---|---|---|---|
| 67 | `gu_w01c` | 1.00 | 134 |
| 68 | `gu_w01c` | 0.00–0.50 | **134** |
| 12 | `gu_w11c` | 1.00 | 129 |
| 13 | `gu_w11c` | 0.50–1.00 | **129** |
| 14 | `gus_03` | 0.00–0.50 | 129 |

Across the zone: 92 prefabs at a flat 1.00, **127 at a flat 0.50**, 97 ramping
0.00–0.50. That is a base layer plus an overlay whose per-vertex alpha is the
blend weight — the standard way terrain variation was done, and exactly what the
comment at the vertex-colour code already suspected.

**4. The blend weight never reaches the GPU.**
`geometry.setAttribute('color', …, 3)` — **three components**. Alpha is parsed,
counted, and dropped. So every overlay tile draws at full strength over its base,
which is precisely a hard-edged pale square.

That also explains why the earlier attempt failed. It tried to identify bad
meshes by "alpha below 1" and found 288 of 397 — because *most* terrain carries
an overlay. The discriminator was never the point; the missing channel was.

**The fix, for whoever picks this up:** carry vertex colour as **four**
components, make overlay meshes `transparent` with opacity driven by vertex
alpha, and keep them drawing after their base (the `polygonOffset` already
applied to `useAlpha` meshes is there for exactly this z-fighting). Note
`vColor` is already declared `vec4` in this three.js version even without
`USE_COLOR_ALPHA`, so the shader patch swizzles `.rgb` — see the note in
"Smaller ones". Blast radius is wide (127 prefabs in one zone alone), so sweep
several zones before and after and compare numerically.

### 4c. South Gustaberg mismatched ground tiles (original notes)

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

## 5a. The alpha theory is wrong — the decode is fine, the *meaning* is not

**Measured 2026-08-11, and it retires the hypothesis §5 has carried for months.**
`[ALPHAHIST]` now groups by decode path (`ParsedTexture.format`), and the two
paths behave completely differently:

| Zone | path | textures | opaque | mid-range | distinct alpha levels |
|---|---|---|---|---|---|
| West Ronfaure | indexed | 14 | **100%** | 0% | **2** |
| West Ronfaure | dxt3 | 39 | **0.8%** | 66.5% | **16** |
| Zone 103 | indexed | 10 | 100% | 0% | 2 |
| Zone 103 | dxt3 | 53 | 1.9% | 48.6% | 10 |
| Misareaux | indexed | 13 | 99.5% | 0% | 2 |
| Misareaux | dxt3 | 106 | 0.8% | 64.1% | 16 |

Read that carefully, because it says the opposite of what was assumed:

- The **indexed** path is perfect — a clean 0/255 split, exactly two levels.
- The **DXT3** path yields **all 16** nibble values, which is what a *correct*
  4-bit expansion produces. Not a truncated or misaligned range.
- The **colours from those same blocks decode correctly** — zones look right. A
  wrong block layout or a mistaken format would corrupt colour first and most
  visibly, and it does not.

So the bytes reaching `decompressDXT3` are the right bytes, the nibble order is
right, and the expansion is right. **The decode is not broken.** What is broken
is the assumption that this channel means opacity.

FFXI's DXT3 alpha for terrain is **not an opacity channel**. The comment already
sitting at the `rgba[d+3]` line said as much from a different direction —
"terrain textures average ~120 alpha but carry ~6% texels at zero… the PS2
data-mask use of the alpha channel, not transparency" — and this measurement is
that observation generalised across three zones and 198 textures.

**Consequences, and they are large:**

1. **§5 below should not be pursued as written.** Re-checking A1/81/B1 header
   offsets or `guessCompressedLayout` is chasing a bug that the evidence says is
   not there. Do not spend a session on it.
2. **No blending scheme driven by this alpha can work** — see 4f. Alpha-testing
   at 0.1 is effectively "ignore the channel", which is why it is the least-bad
   behaviour rather than a correct one.
### The spatial discriminator was tried and does NOT separate — 2026-08-11

`[CUTOUT]` (in the census block) reports, per DXT3 texture, the share of texels
at alpha ≤ 16, the rate at which horizontal neighbours cross that threshold, and
`altNorm` — that rate divided by `2p(1-p)`, which is what random scatter would
give at the same share. **~1 means noise, well below 1 means contiguous blobs.**

The prediction was that terrain's data-mask alpha would be scattered (~1) and
genuine cutouts contiguous (<<1). West Ronfaure says otherwise:

| Texture | clear | altNorm |
|---|---|---|
| `ron_kab0` | 94% | **0.02** |
| `ron_riv` | 57% | 0.07 |
| `ron_ro` | 38% | 0.06 |
| `ron_w01c` (terrain) | 17% | 0.18 |
| `ron_k01c` | 87% | 0.43 |
| `hata1` | 22% | 0.08 |

**Every DXT3 texture is contiguous — 0.02 to 0.60, nothing near 1.** The metric
does not separate cutouts from terrain because there is nothing to separate:
none of this alpha is dithered. **Do not try alternation again.**

What the numbers suggest instead, and it is a hypothesis rather than a result:
several textures are **86-94% "clear"**. A sheet that is nine-tenths transparent
is not a translucent surface, it is an **atlas with a small used region and empty
space around it** — contiguous by construction. If so, alpha marks *unused sheet
area* rather than opacity, UVs address only the used part, and alpha-testing at
0.1 works precisely because it punches out regions nothing samples.

That would also join up with **4c**, whose best remaining hypothesis is already
that South Gustaberg's ground textures are atlas sub-tiles selected by UV offset.

**Tested the same day, and the atlas reading is wrong.** `[UVALPHA]` overlays
each mesh's UV bounding box on its texture and compares the clear share inside
that rectangle against the whole sheet. Over West Ronfaure's 192 non-tiling
dxt3 meshes (39 tile and cannot answer):

> **mean sheet clear 51.8% → mean sampled clear 55.7%**

Meshes do **not** avoid the clear regions; if anything they sample slightly more
of them. The decisive single case is `ron_kab0`: a sheet that is **94% clear**,
sampled over the full `uv[0,1]x[0,1]`, on geometry that renders as solid ground.
A mesh covering a 94%-transparent sheet end to end and looking correct in game
proves the game is **not treating this channel as opacity at all**.

So alpha is neither opacity nor a marker of unused sheet area. For terrain it is
data the renderer must simply ignore — which is exactly what alpha-testing at
0.1 accidentally achieves, and why nothing better has ever been found.

**One thing worth keeping from the same run**, because it supports 4c even
though it sank 4b's version: the sheets *are* internally structured. The same
`ron_w01c` texture reads **0% clear** over `uv[0.25,0.93]x[0.00,0.50]` and
**65% clear** over `uv[0.01,0.49]x[0.51,0.99]`. Sub-regions differ enormously
and different meshes address different ones. That is atlas-shaped, and 4c's
sub-tile hypothesis survives — it is *tile selection* that is suspect, not the
alpha channel.

3. **4b needs a different discriminator.** The next measurement is to split
   `[ALPHAHIST]` by *what the texture is used for* rather than how it was
   decoded: if genuine cutout sprites (foliage) show large contiguous zero
   regions while terrain shows noise-like scatter, that spatial difference is
   the separator five share-based attempts all missed. That is also exactly what
   the alternation-rate idea from the model work predicts.

## 5. The strongest open lead (superseded — read 5a first)

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

- **Zone music — PLAYING IN THE APP as of 2026-08-10.** Panel → **Music** →
  *Zone music* (off by default) plus a volume slider and a line of status.
  `lib/bgw.ts` decodes, `lib/zoneMusic.ts` resolves and plays, `App.tsx` starts
  a track per zone. `?music=1` enables it at startup for harnesses, and every
  status change logs as `[MUSIC]`.

  Verified in the built app, not just compiled:

  | Zone | Result |
  |---|---|
  | West Ronfaure (100) | track 109, playing, 263.1s, looping |
  | Misareaux Coast (25) | track 230, playing, 232.6s, looping |
  | Riverne - Site #A01 (30) | silent — correct, the zone has no ambient track |
  | Aht Urhgan Whitegate (50) | `unsupported`, codec 3 — degrades, does not error |

  **84 zones play, 64 are codec 3 and stay silent**, the rest have no track at
  all. The status line says which of those three a quiet zone is, because they
  look identical otherwise.

  Details worth keeping: volume rides the gain node so dragging the slider does
  not restart the track; loading is generation-guarded because a zone switch can
  outrun a 23M-sample decode; music is deliberately **not** in `SceneSettings`,
  since presets apply over `DEFAULT_SCENE` and clicking a preset would otherwise
  stop the music as a side effect.

  The remaining note below is the research that got here.

- **Zone music research.** Ryan's request, 2026-08-09. **The mapping is solved;
  ATRAC3 is not.**

  The music is **not** in the ROM DAT archives — it is ordinary files at
  `<install>/sound<N>/win/music/data/musicNNN.bgw`, **223 of them** spread over
  `sound`, `sound2`…`sound9`, plus `mov/music999.bgw` (80 MB, the opening
  movie). They open with the ASCII magic `BGMStream`. The ~11,800 `.spw`
  alongside them are sound effects, not music. Electron reads them through the
  existing `ffxi:readDat` IPC, which takes a root and a relative path and does
  not care that the file is not a DAT.

  **`resources/zone-music.json`** now maps zone id → `{day, night, solo, multi}`,
  built by `scripts/build-zone-music.cjs` from LandSandBoat's
  `zone_settings.sql` (fetched from GitHub, not vendored — same arrangement as
  the item names). Its columns are `music_day` / `music_night` for ambient and
  `battlesolo` / `battlemulti` for combat; **0 means silent and is not an
  error**.

  Three independent checks say the mapping is right: 283 of our 298 zone ids
  carry a name matching LandSandBoat's exactly (the 15 that differ are rows
  where our CSV has no name); **every** music id referenced by any zone resolves
  to a real file, 0 missing; and each BGW stores its own track number at offset
  **0x14** (`0x17` in music023, `0x65` in music101), so the file self-identifies.

  What the 223 files are, by role:

  | Role | Count |
  |---|---|
  | Ambient (zone) only | 42 |
  | Battle only | 23 |
  | Both ambient and battle | 32 |
  | **Referenced by no zone at all** | **126** |

  That last row is the menus, cutscenes, mog house, events and the movie —
  Ryan's point that much of the music is not zone music, quantified. Of the 298
  zones the viewer lists, **148 have an ambient track and 151 are silent**;
  Riverne - Site #A01 is one of the silent ones, carrying battle music only.
  Only **74 distinct** ambient tracks cover those 148 zones.

  Two cautions for whoever writes the loader:

  - **`musicNNN` is not unique across directories.** `music068` exists in both
    `sound` and `sound9`, `music181` in both `sound2` and `sound5`. The sound
    dirs overlay like the ROM dirs, so pick deliberately rather than taking the
    first hit; the resource stores numbers, not paths, so the app resolves them.
  - **`music_day` and `music_night` are never different in this dump.** Every
    zone with music has the same id in both. That is a property of
    LandSandBoat's data, not proof the game never varies music by time of day.
    Do not build a day/night crossfade on the strength of it.

  **The container format is solved for 143 of 222 files.**
  `scripts/bgw-decode.cjs` decodes a BGW to WAV, and `--survey` reports the
  codec census. Layout, following vgmstream's `meta/bgw.c`:

  | Offset | Field |
  |---|---|
  | 0x00 | `"BGMStream"` |
  | 0x0C | **codec** — `0` PS-ADPCM, `3` ATRAC3 (encrypted) |
  | 0x10 | file size (matches disk; cheap integrity check) |
  | 0x14 | track id |
  | 0x18 | block size = frames per channel |
  | 0x1C | loop start in frames, `<= 0` for none |
  | 0x20 | sample rate, obfuscated: `(u32@0x20 + u32@0x24) & 0x7FFFFFFF` |
  | 0x28 | data offset — `0x30` in every real file |
  | 0x2E / 0x2F | channels / block align (= samples per frame) |

  **Codec 0 (PS-ADPCM) — done. 143 files, 43 of the 74 ambient zone tracks.**
  Frames are `blockAlign / 2 + 1` bytes: **one** header byte (filter index in
  the high nibble, shift in the low), then nibbles, two samples per byte, low
  nibble first. This is *not* standard 16-byte PS-ADPCM — there is no flag byte
  and the frame size varies per file (4, 8, 16, 32, 64, 128 all seen). Channels
  interleave one frame at a time.

  **The one trap, and it decodes cleanly while being wrong.** vgmstream's
  *standard* `decode_psx` sets `shift_factor = 20 - shift_factor`;
  `decode_psx_configurable` has no such line and uses the shift directly.
  Borrowing it produces perfectly clean, correctly-shaped audio at roughly a
  twelfth of the right amplitude — peak 2603 of 32767 instead of 31260. Nothing
  errors. **Always check peak and RMS**, not just that a decode ran.

  Verified across five tracks: peaks 30953–31740 against a 32767 ceiling, no
  clipping, durations 111–302s, crest factor about 7.5 (noise sits near 3).
  Track 23 uses blockAlign 128 where the others use 16, so the variable frame
  size is exercised.

  **Codec 3 (ATRAC3) — DONE, 2026-08-10.** `src/renderer/src/lib/atrac3.ts` is a
  full port of FFmpeg's `atrac3.c` + `atrac.c`: bitstream reader, canonical
  Huffman from lengths (symbol offset **-31**), tonal components, gain
  compensation, a 512-point IMDCT and the 3-band QMF. All 74 ambient tracks now
  play; nothing is left silent for codec reasons.

  **Validated bit-exactly, not by ear.** `scripts/at3-oracle.cjs` decrypts, wraps
  the stream as a RIFF `.at3` and decodes it with a real ffmpeg;
  `scripts/atrac3.cjs` is the same algorithm as the shipped port with a
  `--selftest`. Against ffmpeg over music178, music051 and music147 the port
  agrees at **106-107 dB SNR with a maximum difference of 1 LSB**. ffmpeg is a
  development tool only — not shipped, not a dependency.

  Two traps, both of which produce plausible output rather than an error:

  - **The IMDCT sign.** FFmpeg's `AV_TX_FLOAT_MDCT` inverse carries the opposite
    sign from the textbook IMDCT, so `MDCT_SCALE` is **negative**. Uncorrected,
    the decode measured -6.0 dB SNR against the reference while having an
    identical RMS — the diff was exactly 2x the signal, which is the signature
    of a pure inversion. The internal selftest compares fast against direct and
    cannot see this; only the external oracle can.
  - **The DCT-IV.** The first attempt used half-remembered twiddles and scored
    3e-3 relative error — small enough to sound almost right. Replaced with a
    derivation that folds the half-bin shift into the input and uses one
    2N-point FFT, which now matches the direct transform to 5e-14.

  Coding mode is **0 (SINGLE), not joint stereo** — ffmpeg rejects mode 1 on
  these files with "JS mono Sound Unit id != 3" — so matrixing and channel
  weighting are absent by construction. Decode costs about 2.7s for a
  four-minute track.

  The historical note follows.

  **Codec 3 (ATRAC3) — was not done. 79 files, 31 of the 74 ambient tracks.** The
  *encryption is trivial*: XOR each byte with `key[(offset + i) % keySize]`,
  where the key is the file's own first `frameSize * channels` bytes with the
  first 4 bytes of each channel's frame XORed by `0xA0024E9F`
  (vgmstream `meta/bgw_streamfile.h`, credited to Moogle Toolbox). The hard part
  is ATRAC3 itself — a Sony MDCT codec with no browser support. Options are
  bundling FFmpeg (adds tens of MB and an LGPL question to an 80 MB app), an
  ATRAC3 decoder in WASM, or leaving those 31 zones silent. **This is a real
  decision, not a small task.**

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
