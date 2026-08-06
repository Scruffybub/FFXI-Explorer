/**
 * Loads a zone once, then sweeps camera angles in-place and reports mean screen
 * brightness, so a blown-out white frame is detectable without eyeballing each
 * angle. Saves a PNG for any angle that blows out.
 *
 *   npx electron scripts/sweep.cjs <zoneId> <presetIndex> <outDir> [extraQuery]
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const { join } = require('path')
const { promises: fs } = require('fs')
const { execFile } = require('child_process')
const { promisify } = require('util')

const execFileAsync = promisify(execFile)

const zoneId = process.argv[2] || '87'
const presetIdx = process.argv[3] || '1'
const outDir = process.argv[4] || process.cwd()
const extraQuery = process.argv[5] || ''

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

function meanBrightness(img) {
  const bmp = img.getBitmap() // BGRA
  const { width, height } = img.getSize()
  // Sample the 3D viewport only, skipping the side panels.
  const x0 = Math.floor(width * 0.30), x1 = Math.floor(width * 0.78)
  let sum = 0, n = 0
  for (let y = 0; y < height; y += 3) {
    for (let x = x0; x < x1; x += 3) {
      const i = (y * width + x) * 4
      sum += (bmp[i] + bmp[i + 1] + bmp[i + 2]) / 3
      n++
    }
  }
  return sum / n
}

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
    width: 1100, height: 700, show: false, backgroundColor: '#0b0d12',
    webPreferences: {
      preload: join(__dirname, '../out/preload/index.js'),
      sandbox: false, contextIsolation: true, nodeIntegration: false,
    },
  })

  await win.loadFile(join(__dirname, '../out/renderer/index.html'), {
    search: `zone=${zoneId}&preset=${presetIdx}&yaw=0&pitch=0${extraQuery}`,
  })
  await new Promise(r => setTimeout(r, 14000))

  const ready = await win.webContents.executeJavaScript(
    `typeof window.__aimCamera === 'function'`
  )
  if (!ready) {
    console.log('CAMERA HOOK MISSING — zone probably did not load')
    app.exit(1)
    return
  }

  const results = []
  for (const pitch of [40, 20, 0, -20, -40]) {
    for (let yaw = 0; yaw < 360; yaw += 30) {
      await win.webContents.executeJavaScript(`window.__aimCamera(${yaw}, ${pitch})`)
      await new Promise(r => setTimeout(r, 450))
      const img = await win.webContents.capturePage()
      const mean = meanBrightness(img)
      results.push({ yaw, pitch, mean: Math.round(mean) })
      if (mean > 200) {
        await fs.writeFile(join(outDir, `white-y${yaw}-p${pitch}.png`), img.toPNG())
      }
    }
  }

  results.sort((a, b) => b.mean - a.mean)
  console.log('BRIGHTEST ANGLES (mean 0-255):')
  for (const r of results.slice(0, 12)) {
    console.log(`  yaw=${r.yaw} pitch=${r.pitch} mean=${r.mean}${r.mean > 200 ? '   <-- BLOWN OUT' : ''}`)
  }
  console.log('DARKEST: ' + JSON.stringify(results[results.length - 1]))
  app.exit(0)
})
