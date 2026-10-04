# Third-party notices

FFXI Explorer is MIT licensed (see `LICENSE`), but parts of it derive from other
people's work and carry their terms. This file records what came from where.

---

## ATRAC3 decoder — FFmpeg (LGPL-2.1-or-later)

**Files:** `src/renderer/src/lib/atrac3.ts`, `scripts/atrac3.cjs`

These are ports of FFmpeg's `libavcodec/atrac3.c` and `libavcodec/atrac.c` —
the bitstream reader, Huffman tables, tonal components, gain compensation,
IMDCT and QMF are all derived from that source. They are therefore derivative
works of FFmpeg and are covered by the **GNU Lesser General Public License,
version 2.1 or later**, not by this project's MIT licence.

FFmpeg is a trademark of Fabrice Bellard, originator of the FFmpeg project.
FFmpeg source: <https://ffmpeg.org/>. Licence text:
<https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html>.

What this means in practice:

- The source for these files ships in this repository, which is how the LGPL's
  source-availability requirement is met.
- Modifying them and redistributing the result is allowed under LGPL terms.
- **No FFmpeg binary is bundled or required.** The decoder is a from-source
  port that runs in the app. `ffmpeg` is used only as a development-time oracle
  to verify the port, and is not a dependency of the shipped application.

## DAT parsing — Vanalytics (MIT)

**Files:** most of `src/renderer/src/lib/ffxi-dat/`, and `resources/*.json`

The DAT file parsing originates from
[Vanalytics](https://github.com/Soverance/Vanalytics) by Soverance, MIT
licensed, along with the model, face and animation path tables in `resources/`.
Vanalytics in turn builds on FFXI community reverse-engineering work — notably
GalkaReeve's mapViewer for the zone geometry, mesh and animation block
structures.

The MIT licence requires its copyright and permission notice to travel with
derivative works; this notice serves that purpose.

## Collision parsing — LandSandBoat / Vulture (GPL-3.0, reference only)

**File:** `src/renderer/src/lib/ffxi-dat/CollisionParser.ts`

The MZB collision block layout was worked out with reference to
`Common/dat/Types/MZB.cs` in
[LandSandBoat/FFXI-NavMesh-Builder](https://github.com/LandSandBoat), which
descends from Vulture's `dat.cs`. LandSandBoat is GPL-3.0.

This implementation was written independently from the file-format facts rather
than translated line by line, and it deliberately departs from that reference in
three documented ways (Y is not negated, every vertex is kept, and
`(visEntry, geometry)` pairs are deduplicated). It is offered here as
attribution of the format research.

## Zone and item tables — LandSandBoat (GPL-3.0 source data)

**Files:** `resources/item-names.json`, `resources/zone-music.json`,
`resources/zone-weather.json`

Built by `scripts/build-item-names.cjs`, `scripts/build-zone-music.cjs` and
`scripts/build-zone-weather.cjs` from LandSandBoat's `item_equipment.sql`,
`zone_settings.sql`, `zone_weather.sql` and zone data files. Those sources are
fetched at build time and are **not vendored** in this repository; the generated
JSON contains item names, zone→music-id mappings, and each zone's list of
native weather types in order (no frequencies) extracted from them.

The underlying facts are Square Enix's game data rather than LandSandBoat's
creative work, but the extraction came from a GPL-3.0 project and is recorded
here so anyone relying on it can make their own assessment.

## File-format research — kuluu-ffxi and xim (GPL-3.0, reference only)

**Files:** `src/renderer/src/lib/ffxi-dat/GeneratorParser.ts`, `D3mParser.ts`,
`SpriteParser.ts`, `EnvironmentParser.ts`, `CollisionParser.ts` (water height),
`src/renderer/src/lib/zoneLighting.ts`, `spawnStages.ts`, `GammaBlendPass.ts`,
`src/renderer/src/components/SkyLayers.tsx`, `WeatherParticles.tsx`,
`LensFlare.tsx`, and the zone transparency rule in `ZoneViewer.tsx`

The layouts of generator chunks, D3M effect meshes, KeyFrame curves and
environment (weather) records, FFXI's texture-stage and lighting maths, and its
zone transparency rule were worked out with reference to
[kuluu-ffxi](https://github.com/jondwillis/kuluu-ffxi) and to xim in
[Heyrio/FFXI-BROWSER-GAME](https://github.com/Heyrio/FFXI-BROWSER-GAME), both
GPL-3.0. Their source was read as a description of the file formats and of the
game's behaviour; no code was copied, and these implementations were written
independently. This notice records that research.

---

## Final Fantasy XI

FINAL FANTASY XI is a registered trademark of Square Enix Holdings Co., Ltd.
This project is not affiliated with, endorsed by, or sponsored by Square Enix.

**No game assets are distributed.** The application reads zone geometry,
textures, models, animations and music from the Final Fantasy XI installation
already present on the user's own machine. Nothing is uploaded, and no server,
account or internet connection is involved.
