/**
 * Build `build/icon.ico` from a square source PNG.
 *
 *   npx electron scripts/make-icon.cjs <source.png> [out.ico]
 *
 * Why this exists rather than letting electron-builder convert a PNG: it never
 * gets that far on this machine. Embedding an icon needs `signAndEditExecutable`
 * on, which makes electron-builder unpack its winCodeSign bundle, and that
 * bundle contains two macOS symlinks (libcrypto/libssl dylibs) that Windows
 * refuses to create without SeCreateSymbolicLinkPrivilege — admin, or Developer
 * Mode. The extraction fails, is retried into a fresh temp directory, and never
 * promotes to a usable cache, so the build dies. See scripts/set-icon.cjs for
 * the other half of the workaround.
 *
 * Resizing uses Electron's own nativeImage, so there is no image dependency to
 * install. Frames are stored as PNG inside the ICO, which Windows has supported
 * at every size since Vista and this app requires Windows 10 anyway.
 */
const { app, nativeImage } = require('electron')
const fs = require('fs')
const { join } = require('path')

const SIZES = [16, 24, 32, 48, 64, 128, 256]

const src = process.argv[2]
const out = process.argv[3] || join(__dirname, '../build/icon.ico')

if (!src) {
  console.error('usage: npx electron scripts/make-icon.cjs <source.png> [out.ico]')
  process.exit(2)
}

app.whenReady().then(() => {
  const source = nativeImage.createFromPath(src)
  if (source.isEmpty()) {
    console.error('ERROR: could not read ' + src)
    app.exit(1)
    return
  }
  const { width, height } = source.getSize()
  if (width !== height) {
    console.log(`NOTE: source is ${width}x${height}, not square — Windows will letterbox it.`)
  }
  if (width < 256 || height < 256) {
    console.log(`NOTE: source is only ${width}x${height}; 256x256 or larger keeps the large icon sharp.`)
  }

  const frames = SIZES.map(size => ({
    size,
    png: source.resize({ width: size, height: size, quality: 'best' }).toPNG(),
  }))

  // ICONDIR: reserved(2) type(2) count(2), then one 16-byte ICONDIRENTRY each.
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)          // 1 = icon
  header.writeUInt16LE(frames.length, 4)

  const entries = []
  const images = []
  let offset = 6 + frames.length * 16
  for (const { size, png } of frames) {
    const entry = Buffer.alloc(16)
    entry.writeUInt8(size === 256 ? 0 : size, 0)   // 0 means 256
    entry.writeUInt8(size === 256 ? 0 : size, 1)
    entry.writeUInt8(0, 2)            // palette size, 0 for truecolour
    entry.writeUInt8(0, 3)            // reserved
    entry.writeUInt16LE(1, 4)         // colour planes
    entry.writeUInt16LE(32, 6)        // bits per pixel
    entry.writeUInt32LE(png.length, 8)
    entry.writeUInt32LE(offset, 12)
    entries.push(entry)
    images.push(png)
    offset += png.length
  }

  const ico = Buffer.concat([header, ...entries, ...images])
  fs.mkdirSync(join(out, '..'), { recursive: true })
  fs.writeFileSync(out, ico)

  // Read it back, so a malformed file is caught here rather than in the build.
  const check = nativeImage.createFromPath(out)
  const checkSize = check.getSize()
  console.log(`WROTE ${out}`)
  console.log(`  ${frames.length} frames: ${SIZES.join(', ')}`)
  console.log(`  ${(ico.length / 1024).toFixed(1)} KB, reads back as ${checkSize.width}x${checkSize.height}` +
    (check.isEmpty() ? ' — EMPTY, the file is malformed' : ''))
  app.exit(check.isEmpty() ? 1 : 0)
})
