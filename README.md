**Work in Progress**

**Water** - Water flat-out does not render right now.

**Weather** - Weather does not render properly right now.

**Transparency** - Some zones have textures that don't render properly, primarily textures that have some sort of transparency. This includes some plants, wall textures, and ground textures.

**Unknown textures** - Some zones have models/textures/effects hidden in out-of-bounds areas.

**Weather domes** - Some zones have "domes" of weather data in the middle of the zones

**Walking mode** - Walking mode will sometimes spawn you in an area with no floor. At the moment, quickly press the "noclip" button and you will be able to fly to an area with a floor and unselect "noclip".

**Third-person walking mode** - Third person walking mode does not work properly. The characters are not animated and face the wrong direction when moving.

**Model viewer** - The model viewer has a lot of issues such as incorrect animations, incorrect file naming, UI issues.

**Area map colours** - Most area maps look right, but the ones stored in the older palette-indexed format have wrong accent colours: icons come out near-black instead of blue, and the grid letters read red instead of dark. The maps are perfectly legible, and the layout, scale and everything else is correct.


# FFXI Explorer

A standalone desktop viewer for **Final Fantasy XI**'s zones and models. Explore the game's areas via orbiting, flying, and walking
complete with full collision data. FFXI Explorer includes faithful lighting and shading faithful to the game's actual graphics, along with modern lighting, shading, and post processing features that you can use to customize and enhance your exploration of Vana'diel.

Everything is read straight out of your own local FFXI installation. Nothing is
uploaded, and no server or account is involved. The only network request it ever
makes is an optional check for a newer version — see [Updates](#updates).

![Version](https://img.shields.io/badge/version-0.1.0-blue) ![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)

---

## What's in it

**Zone viewer** — all 285 zones, from West Ronfaure to Reisenjima, each labelled
with the expansion it shipped with. Orbit, fly, or **walk** them in first or
third person, standing on FFXI's own collision mesh.

**Lighting** — *Original* reproduces the 2002 look faithfully (baked vertex
colours, plus the game's own fixed-function sun). *Dynamic* lights the same
geometry using the per-vertex normals in the DAT files, with real shadows,
hand-placed point lights and image-based sky lighting.

**Post-processing** — ambient occlusion, bloom, SMAA, depth of field, colour
grading, vignette, and a choice of tone-mapping curves.

**Model viewer** — 2,473 NPC, monster and object models with their animations,
plus a character builder that assembles a player character from a race skeleton
and eight equipment slots, with real item names. The character you build is the
one you walk zones as.

**Zone music** — the game's own BGW tracks, decoded in-app. Both codecs play:
PS-ADPCM, and ATRAC3 via a from-source decoder validated against ffmpeg.

**Map view** — a top-down orthographic capture with no perspective distortion,
for shaping a zone into a map.

**Area maps** — the game's own parchment maps, in **Models → Maps**. 191 zones
have them, dungeons a page per floor, and any of them can be saved as a PNG.

**Weather geometry** — every zone carries sky and weather meshes the client
swaps between at runtime. They can be picked and drawn.

---

## Installing

Grab a build from [Releases](../../releases):

| File | What it is |
|---|---|
| `FFXI-Explorer-0.1.0-setup.exe` | Installer. Lets you pick a location, adds a Start-menu entry, uninstalls cleanly |
| `FFXI-Explorer-0.1.0-portable.exe` | Single file, nothing installed. Just run it |

**Windows will warn you.** The build is unsigned — a code-signing certificate
costs a few hundred dollars a year — so SmartScreen shows "Windows protected
your PC". Click **More info → Run anyway**. If you would rather not, the
build-from-source instructions below produce the same application.

Windows x64 only.

### Finding your game

On first launch it locates your FFXI installation automatically from the
PlayOnline registry keys and the usual install paths. If it can't find one, it
asks you to pick the folder — the one containing `ROM`, `ROM2`–`ROM9` and
`VTABLE.DAT`. Your choice is remembered.

An installation inside `C:\Program Files (x86)` is completely fine. That path is
blocked in browsers by the File System Access sandbox, which is exactly why this
is a desktop application: it reads the files directly.

---

## Using it

### Cameras

**Orbit** drags to rotate, scrolls to zoom. **Fly** captures the mouse on click:
`WASD` to move, `E`/`Space` up, `Q`/`Shift` down, scroll to change speed, `Esc`
to release. **Walk** puts you on the ground: `WASD` to walk, `Shift` to run,
`Esc` to release. Walk mode has step-up, slope limits, wall sliding and a noclip
toggle, and can follow you in third person.

### Lighting modes

*Original* reproduces the look from 2002. *Dynamic* replaces it with real lights, and the
**Keep baked shading** slider decides how much of the original art survives
underneath: at 1.0 the old shadows multiply against the new ones and everything
reads twice as dark, at 0 you get pure dynamic light and lose some character.
Around 0.25–0.4 is usually the balance.

Six presets cover the common looks: Original (2002), Midday Sun, Golden Hour,
Moonlit Night, Overcast and Clay Render.

### Point lights

The zone files contain no light data at all, so torches and braziers are placed
by hand. In Dynamic mode, open **Point lights → Place a light**, then click a
surface. Each light has colour, intensity, range, falloff and a flicker amount;
the **headlamp** is a light attached to the camera, which is the quickest way to
explore a dark interior. Lights are lost when you change zone.

### Presentation

The floating buttons at the top right of the view cover **Hide panels** (`F10`),
**Fullscreen** (`F11`) and **Screenshot** (`F12`), which saves a PNG of the 3D
view at window resolution with no UI in the frame. **Inspect** reports what a
clicked surface actually is — texture, material, blend flags, UV range.

Every setting has an ⓘ beside it explaining what it does.

---

## Updates

A couple of seconds after launch, the app asks GitHub for the latest release
number. If it is newer than the version you are running, a popup offers to
download it: an installed copy downloads the installer and runs it, a portable
copy downloads the new exe and opens its folder, since a running portable
executable cannot replace itself.

That request is the only thing this app ever sends over the network. It carries
no information about you, your machine or your game — it asks for a version
number and nothing else — and a failed check is silent rather than an error box.
Turn it off in **Scene panel → Updates → Check on startup**, which also holds a
**Check now** button and the version you are running.

---

## Building from source

Requires Node.js 20+ and a Windows machine for the packaging step.

```bash
npm install
npx electron-vite dev                             # run against the dev server
npx electron-vite build                           # compile main, preload, renderer
npx electron-builder --win --config electron-builder.yml   # installers into release/
```

**Producing a release build with the icon** takes three steps rather than one,
because embedding an icon needs `signAndEditExecutable`, and turning that on
makes electron-builder unpack a bundle containing macOS symlinks that Windows
will not create without elevated privileges:

```bash
npx electron-vite build
npx electron-builder --win dir --config electron-builder.yml
node scripts/set-icon.cjs                          # stamps build/icon.ico via rcedit
npx electron-builder --prepackaged release/win-unpacked --win portable nsis --config electron-builder.yml
```

`scripts/make-icon.cjs <source.png>` regenerates `build/icon.ico` if the artwork
changes.

The renderer can be deep-linked for testing:
`index.html?zone=<id>&preset=<index>`, and most settings can be overridden by
query parameter (`scene_cameraMode=walk`, `light_mode=lit`, `scene_anisotropy=8`).
`scripts/` holds the verification harnesses.

---

## Credits

The DAT parsing originates from
[Vanalytics](https://github.com/Soverance/Vanalytics) by Soverance (MIT), which
builds on FFXI community reverse-engineering — notably
[GalkaReeve's mapViewer](https://github.com/GalkaReeve) for the zone geometry,
mesh and animation block structures, and
[LandSandBoat](https://github.com/LandSandBoat/server) for the zone, item and
music tables. The ATRAC3 decoder is ported from FFmpeg, and the MZB collision
layout was worked out against LandSandBoat's NavMesh Builder.

## Licence

MIT, except the ATRAC3 decoder ported from FFmpeg, which stays LGPL-2.1-or-later.
See [LICENSE](LICENSE) and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

FINAL FANTASY XI is a registered trademark of Square Enix Holdings Co., Ltd.
This project is not affiliated with or endorsed by Square Enix, and distributes
no game assets — it reads the files you already own, locally.
