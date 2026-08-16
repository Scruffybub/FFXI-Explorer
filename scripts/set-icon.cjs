/**
 * Stamp `build/icon.ico` onto the packaged executable with rcedit.
 *
 *   node scripts/set-icon.cjs [path-to-exe]
 *
 * The other half of the icon workaround described in scripts/make-icon.cjs:
 * electron-builder cannot do this itself here, because turning on
 * `signAndEditExecutable` makes it unpack a bundle containing macOS symlinks
 * that Windows will not create without elevated privileges. rcedit is *inside*
 * that same bundle, so this reaches for whichever copy has been extracted and
 * runs the one step that was actually wanted.
 *
 * Release build order:
 *   npx electron-vite build
 *   npx electron-builder --win dir --config electron-builder.yml
 *   node scripts/set-icon.cjs
 *   npx electron-builder --prepackaged release/win-unpacked --win portable nsis \
 *     --config electron-builder.yml
 *
 * The `--prepackaged` step is what makes this stick: it wraps the directory as
 * it now stands, icon included, instead of rebuilding it.
 */
const fs = require('fs')
const { join } = require('path')
const { execFileSync } = require('child_process')

const exePath = process.argv[2] || join(__dirname, '../release/win-unpacked/FFXI Explorer.exe')
const icoPath = join(__dirname, '../build/icon.ico')

const cacheRoot = join(
  process.env.LOCALAPPDATA || join(process.env.USERPROFILE, 'AppData/Local'),
  'electron-builder/Cache/winCodeSign',
)

/** Any extracted winCodeSign directory will do; we only want rcedit out of it. */
function findRcedit() {
  let dirs = []
  try {
    dirs = fs.readdirSync(cacheRoot).filter(d => fs.statSync(join(cacheRoot, d)).isDirectory())
  } catch {
    return null
  }
  for (const dir of dirs) {
    const candidate = join(cacheRoot, dir, 'rcedit-x64.exe')
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

if (!fs.existsSync(exePath)) {
  console.error(`ERROR: no executable at ${exePath} — run the "--win dir" build first.`)
  process.exit(1)
}
if (!fs.existsSync(icoPath)) {
  console.error(`ERROR: no icon at ${icoPath} — run scripts/make-icon.cjs first.`)
  process.exit(1)
}

const rcedit = findRcedit()
if (!rcedit) {
  console.error(
    'ERROR: no extracted rcedit found under ' + cacheRoot + '.\n' +
    'Extract one without symlinks:\n' +
    '  node_modules/7zip-bin/win/x64/7za.exe x -bd -y <hash>.7z -o<hash>\n' +
    '(the two darwin dylib errors it reports are expected and harmless)',
  )
  process.exit(1)
}

const before = fs.statSync(exePath).size
execFileSync(rcedit, [exePath, '--set-icon', icoPath], { stdio: 'inherit' })
const after = fs.statSync(exePath).size

console.log(`rcedit: ${rcedit}`)
console.log(`icon:   ${icoPath}`)
console.log(`exe:    ${exePath}`)
console.log(`size:   ${before} → ${after} bytes (${after > before ? '+' : ''}${after - before})`)
if (after === before) {
  console.error('WARNING: the executable did not change size. Verify the icon actually took.')
  process.exit(1)
}
