# jsmpeg (vendored, modified)

Built from the readable `src/` of [phoboslab/jsmpeg](https://github.com/phoboslab/jsmpeg)
at commit `924acfbd96fdf15e6748d1368a36d79d8f4cecf6` (2022-09-20), MIT licence
(`LICENSE`, Copyright (c) 2017 Dominic Szablewski), by `scripts/build-jsmpeg.cjs`:
only `jsmpeg.js`, `buffer.js`, `decoder.js`, `mpeg1.js`, `webgl.js` and
`canvas2d.js` (no player, sources, demuxer, audio or WASM), as one ES module.

Changed (each marked `FFXI Explorer` in `jsmpeg.js`; the build script says why):

1. **End of slice.** A slice ends where the next 23 bits are zero, MPEG-1's
   rule. jsmpeg looked for `00 00 01` at the next byte, and FFXI's encoder pads
   zero bytes before start codes, so jsmpeg read past slice ends and drew garbage.
2. **B-pictures.** jsmpeg skipped them; two thirds of the opening movie's
   pictures are B. Added backward and averaged prediction, a third reference
   buffer and display reordering.
3. The automatic `<div class="jsmpeg">` scan at load is removed.

Checked against ffmpeg on two stretches of the opening movie (its start and
halfway), 90 frames each: every frame within rounding of ffmpeg's (mean
difference under 0.25 of 255, worst 6).

Used by `lib/moviePlayer.ts` (see HANDOFF "Cutscene player"). To rebuild, fetch
those six files at that commit and run `node scripts/build-jsmpeg.cjs <folder>`.
