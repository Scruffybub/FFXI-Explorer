# FFXI Zone Viewer

A standalone desktop viewer for Final Fantasy XI zone models, with modern
lighting, shadows, and post-processing that the game itself never had.

Zone geometry, textures and normals are read straight out of your local FFXI
installation. Nothing is uploaded, and no server, account or internet
connection is involved.

## Running it

Download `FFXI-Zone-Viewer-portable.exe` and run it. There is nothing to
install and no runtime to set up.

On first launch it looks for your FFXI installation automatically by reading the
PlayOnline registry keys and checking the usual install locations. If it can't
find one, it asks you to pick the folder — the one containing `ROM`,
`ROM2`–`ROM9` and `VTABLE.DAT`. Your choice is remembered.

An install inside `C:\Program Files (x86)` is completely fine here. That path is
blocked in browsers because of the File System Access API sandbox; a desktop app
has no such restriction and reads it directly.

## Lighting

FFXI baked all of its lighting into per-vertex colours back in 2002. There are
no light sources in the game data — the shading you see is painted on. The
viewer offers two modes:

**Original** reproduces that faithfully: unlit materials, vertex colours only.
This is what the game looks like.

**Dynamic** lights the zone properly using the per-vertex normals stored in the
DAT files, with a directional sun, hemisphere ambient, and real-time shadows.

The **Keep baked shading** slider controls how much of the original painted-on
shading survives in dynamic mode. At 1.0 the old baked shadows multiply against
your new ones and everything reads twice as dark; at 0 you get purely dynamic
light and lose some of the original art's character. Around 0.25–0.4 usually
strikes the best balance.

### Presets

| Preset | What it shows |
|---|---|
| Original (2002) | The game's own baked look |
| Midday Sun | Hard overhead key light, crisp shadows |
| Golden Hour | Low warm sun, long shadows, heavy bloom |
| Moonlit Night | Cool dim key, deep ambient shadow |
| Overcast | Soft shadowless sky light, good for reading geometry |
| Clay Render | Untextured neutral shading to inspect pure geometry |

### Point lights

FFXI's zone files contain no light data whatsoever, so torches and braziers have
to be placed by hand. In Dynamic mode, open **Point lights**, click **Place a
light**, then click a surface in the view — the light is dropped just off that
surface. `Esc` cancels placement.

Each light has colour, intensity, range, falloff, and a **flicker** amount that
drives an irregular flame-like variation. Selecting a light in the list opens its
controls and highlights its marker in the scene; **Raise / lower** nudges its
height, since a click always lands on a surface.

Point lights can cast their own shadows, but each shadow-casting point light
renders the scene six times (once per cube face), so switch that on sparingly.

The **headlamp** is a light attached to the camera — the quickest way to explore
a dark interior without placing anything.

Point lights only affect Dynamic mode. Original mode uses unlit materials, which
ignore light sources entirely.

### Shadow tuning

Shadows use a directional light whose shadow camera follows the view, so a
moderate shadow map still resolves sharp detail across a very large zone.
**Shadow range** sets how much ground around the camera receives shadows —
smaller covers less but resolves finer. If you see stripe patterns on surfaces
or shadows detaching from what casts them, raise **Bias** or **Normal bias**.

## Post-processing

Ambient occlusion (N8AO), bloom, SMAA anti-aliasing, depth of field, colour
grading, vignette, and a choice of tone mapping curves — all individually
adjustable. Ambient occlusion is skipped automatically on zones above 2000
objects to stay interactive, regardless of the setting.

## Presentation and screenshots

The floating buttons at the top-right of the view (they fade in on hover) cover
**Hide panels** (`F10`), **Fullscreen** (`F11`, `Esc` to leave) and **Screenshot**
(`F12`). Screenshot saves a PNG of the 3D view at the current window resolution,
without any UI in the frame, via a normal save dialog.

## Camera

**Orbit** drags to rotate and scrolls to zoom. **Fly** captures the mouse on
click: `W`/`A`/`S`/`D` to move, `E` or `Space` up, `Q` or `Shift` down, scroll to
change speed, `Esc` to release.

## Building from source

```bash
npm install
npm run dev          # run against the dev server
npm run build        # compile main, preload and renderer
npm run dist         # produce the portable .exe in release/
```

The renderer can also be deep-linked for testing:
`index.html?zone=<id>&preset=<index>`.

## Credits

The DAT parsing code originates from
[Vanalytics](https://github.com/Soverance/Vanalytics) by Soverance (MIT), which
in turn builds on FFXI community reverse-engineering work — notably
[GalkaReeve's mapViewer](https://github.com/GalkaReeve) for the zone geometry,
mesh and animation block structures, and
[LandSandBoat](https://github.com/LandSandBoat/server) for the zone tables.

FINAL FANTASY XI is a registered trademark of Square Enix Holdings Co., Ltd.
This project is not affiliated with or endorsed by Square Enix, and distributes
no game assets — it reads the files you already own, locally.
