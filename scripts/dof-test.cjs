/**
 * Verifies depth of field responds to the focus-distance control: captures the
 * same view focused near and far, and reports how much the image actually
 * changed. A broken focus control produces two near-identical frames.
 *
 *   npx electron scripts/dof-test.cjs <zoneId> <outDir>
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
    if (m) { const d = m[1].trim().replace(/[\\/]+$/, ''); if (await isValidFfxiDir(d)) return d }
  } catch { /* fall through */ }
  return 'C:\\FFXI-Data'
}

function sample(img) {
  const bmp = img.getBitmap()
  const { width, height } = img.getSize()
  const x0 = Math.floor(width * 0.30), x1 = Math.floor(width * 0.78)
  const px = []
  for (let y = 0; y < height; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = (y * width + x) * 4
      px.push((bmp[i] + bmp[i + 1] + bmp[i + 2]) / 3)
    }
  }
  return { px, w: Math.ceil((x1 - x0) / 2) }
}

/** Mean absolute difference between two greyscale samples. */
function meanDiff(a, b) {
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) s += Math.abs(a[i] - b[i])
  return s / n
}

/** High-frequency energy — higher means a sharper image. */
function sharpness({ px, w }) {
  let s = 0, n = 0
  for (let i = w; i < px.length - 1; i++) {
    s += Math.abs(px[i] * 2 - px[i - 1] - px[i - w])
    n++
  }
  return s / n
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
    width: 1400, height: 820, show: false, backgroundColor: '#0b0d12',
    webPreferences: {
      preload: join(__dirname, '../out/preload/index.js'),
      sandbox: false, contextIsolation: true, nodeIntegration: false,
    },
  })

  const shoot = async (focus, tag) => {
    await win.loadFile(join(__dirname, '../out/renderer/index.html'), {
      search: `zone=${zoneId}&preset=1&post_depthOfField=true&post_dofAutofocus=false&post_dofBokehScale=8` +
              `&post_dofFocusDistance=${focus}&post_dofFocalLength=900&post_bloom=false`,
    })
    await new Promise(r => setTimeout(r, 15000))
    const img = await win.webContents.capturePage()
    await fs.writeFile(join(outDir, `dof-${tag}.png`), img.toPNG())
    const s = sample(img)
    console.log(`focus=${String(focus).padEnd(5)} sharpness=${sharpness(s).toFixed(2)}`)
    return s
  }

  const near = await shoot(60, 'near')
  const far = await shoot(3000, 'far')

  const diff = meanDiff(near.px, far.px)
  console.log(`\nmean pixel difference between near and far focus: ${diff.toFixed(2)}`)
  console.log(diff > 3
    ? 'RESULT: PASS — focus distance visibly changes the image'
    : 'RESULT: FAIL — focus distance has little or no effect')
  app.exit(0)
})
