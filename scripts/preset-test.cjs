/**
 * Checks that presets are self-contained: switching to one and then to another
 * must not leave the first preset's settings behind. Measures on-screen
 * colourfulness so a stuck greyscale view is caught automatically.
 *
 *   npx electron scripts/preset-test.cjs <zoneId> <outDir>
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const { join } = require('path')
const { promises: fs } = require('fs')
const { execFile } = require('child_process')
const { promisify } = require('util')

const execFileAsync = promisify(execFile)

const zoneId = process.argv[2] || '100'
const outDir = process.argv[3] || process.cwd()

async function isValidFfxiDir(dir) {
  for (const e of ['ROM', 'ROM2', 'VTABLE.DAT']) {
    try { await fs.stat(join(dir, e)) } catch { return false }
  }
  return true
}

async function detect() {
  try {
    const { stdout } = await execFileAsync('reg',
      ['query', 'HKLM\\SOFTWARE\\WOW6432Node\\PlayOnlineUS\\InstallFolder', '/v', '0001'])
    const m = stdout.match(/REG_SZ\s+(.+)/)
    if (m) {
      const d = m[1].trim().replace(/[\\/]+$/, '')
      if (await isValidFfxiDir(d)) return d
    }
  } catch { /* fall through */ }
  return 'C:\\FFXI-Data'
}

/** Mean per-pixel (max channel - min channel) across the 3D viewport. ~0 = greyscale. */
function colourfulness(img) {
  const bmp = img.getBitmap()
  const { width, height } = img.getSize()
  const x0 = Math.floor(width * 0.30), x1 = Math.floor(width * 0.78)
  let sum = 0, n = 0
  for (let y = 0; y < height; y += 3) {
    for (let x = x0; x < x1; x += 3) {
      const i = (y * width + x) * 4
      const b = bmp[i], g = bmp[i + 1], r = bmp[i + 2]
      sum += Math.max(r, g, b) - Math.min(r, g, b)
      n++
    }
  }
  return sum / n
}

const clickPreset = name => `
  (() => {
    const b = [...document.querySelectorAll('.preset')].find(x => x.textContent.trim() === ${JSON.stringify(name)});
    if (!b) return false;
    b.click();
    return true;
  })()
`

const readSetting = label => `
  (() => {
    const rows = [...document.querySelectorAll('.control')];
    for (const r of rows) {
      const spans = r.querySelectorAll('.control-row span');
      if (spans.length >= 2 && spans[0].textContent.trim() === ${JSON.stringify(label)}) {
        return spans[1].textContent.trim();
      }
    }
    return null;
  })()
`

app.whenReady().then(async () => {
  ipcMain.handle('ffxi:autoDetect', () => detect())
  ipcMain.handle('ffxi:pickDirectory', () => ({ status: 'cancelled' }))
  ipcMain.handle('ffxi:readDat', (_e, root, rel) =>
    fs.readFile(join(root, ...rel.replace(/\\/g, '/').split('/'))))
  ipcMain.handle('ffxi:fileExists', async (_e, root, rel) => {
    try { await fs.stat(join(root, ...rel.replace(/\\/g, '/').split('/'))); return true }
    catch { return false }
  })

  const win = new BrowserWindow({
    width: 1400, height: 820, show: false, backgroundColor: '#0b0d12',
    webPreferences: {
      preload: join(__dirname, '../out/preload/index.js'),
      sandbox: false, contextIsolation: true, nodeIntegration: false,
    },
  })

  await win.loadFile(join(__dirname, '../out/renderer/index.html'), { search: `zone=${zoneId}` })
  await new Promise(r => setTimeout(r, 16000))

  const step = async (presetName, tag) => {
    const ok = await win.webContents.executeJavaScript(clickPreset(presetName))
    if (!ok) { console.log(`could not find preset button: ${presetName}`); return null }
    await new Promise(r => setTimeout(r, 2600))
    const sat = await win.webContents.executeJavaScript(readSetting('Saturation'))
    const img = await win.webContents.capturePage()
    const c = colourfulness(img)
    await fs.writeFile(join(outDir, `preset-${tag}.png`), img.toPNG())
    console.log(`${presetName.padEnd(16)} saturation=${String(sat).padEnd(6)} colourfulness=${c.toFixed(1)}`)
    return c
  }

  // Baseline, then the greyscale preset, then back — the last value is the test.
  const before = await step('Original (2002)', 'a-original-before')
  await step('Clay Render', 'b-clay')
  const after = await step('Original (2002)', 'c-original-after')
  await step('Midday Sun', 'd-midday-after-clay')

  console.log('')
  if (before === null || after === null) {
    console.log('RESULT: INCONCLUSIVE')
  } else if (after < before * 0.5) {
    console.log(`RESULT: FAIL — colour did not return (${before.toFixed(1)} -> ${after.toFixed(1)})`)
  } else {
    console.log(`RESULT: PASS — colour restored (${before.toFixed(1)} -> ${after.toFixed(1)})`)
  }
  app.exit(0)
})
