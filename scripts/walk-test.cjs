/**
 * Exercises walking for real: enters walk mode, captures the pointer with a
 * synthetic click, holds W, and reports where the body ended up.
 *
 * Standing still is easy to fake — this is the test that says the controller
 * moves, follows terrain, and does not fall through the world.
 *
 *   npx electron scripts/walk-test.cjs <zoneId> <outFile> [holdMs]
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const { join } = require('path')
const { promises: fs } = require('fs')
const { execFile } = require('child_process')
const { promisify } = require('util')

const execFileAsync = promisify(execFile)

const zoneId = process.argv[2] || '100'
const outFile = process.argv[3] || join(process.cwd(), 'walk.png')
const holdMs = Number(process.argv[4] || 4000)

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
    width: 1500, height: 850, show: true, backgroundColor: '#0b0d12',
    webPreferences: {
      preload: join(__dirname, '../out/preload/index.js'),
      sandbox: false, contextIsolation: true, nodeIntegration: false,
      // The window is shown deliberately. Chromium throttles rAF in a hidden
      // window no matter what backgroundThrottling says, which starves the
      // controller to a few frames per second and makes correct physics look
      // broken. show:true is the only thing that gives real frame rates.
      backgroundThrottling: false,
    },
  })

  const logs = []
  win.webContents.on('console-message', (_e, _l, msg) => logs.push(msg))

  await win.loadFile(join(__dirname, '../out/renderer/index.html'), {
    search: `zone=${zoneId}&preset=0&scene_cameraMode=walk&walkdebug=1`,
  })
  await new Promise(r => setTimeout(r, 15000))

  // Pointer lock only engages from a real click on the canvas.
  const rect = await win.webContents.executeJavaScript(`
    (() => { const c = document.querySelector('canvas'); const r = c.getBoundingClientRect();
      return JSON.stringify({x: r.left + r.width/2, y: r.top + r.height/2}); })()
  `)
  const { x, y } = JSON.parse(rect)
  const px = Math.round(x), py = Math.round(y)
  win.webContents.sendInputEvent({ type: 'mouseDown', x: px, y: py, button: 'left', clickCount: 1 })
  await new Promise(r => setTimeout(r, 100))
  win.webContents.sendInputEvent({ type: 'mouseUp', x: px, y: py, button: 'left', clickCount: 1 })
  await new Promise(r => setTimeout(r, 1200))

  const before = logs.filter(l => l.includes('[Walk] pos')).slice(-1)[0] || 'none'
  console.log('BEFORE: ' + before)

  // Hold W. keyDown must repeat: the renderer tracks key state, but the OS
  // would otherwise deliver a single press and nothing to sustain it.
  const deadline = Date.now() + holdMs
  while (Date.now() < deadline) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'w' })
    await new Promise(r => setTimeout(r, 60))
  }
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'w' })
  await new Promise(r => setTimeout(r, 800))

  const after = logs.filter(l => l.includes('[Walk] pos')).slice(-1)[0] || 'none'
  console.log('AFTER:  ' + after)

  const image = await win.webContents.capturePage()
  await fs.writeFile(outFile, image.toPNG())
  console.log('SCREENSHOT: ' + outFile)

  const walkLogs = logs.filter(l => /\[Walk\] pos/.test(l))
  console.log(`LOGCOUNT: total=${logs.length} walkPos=${walkLogs.length}`)
  for (const l of logs.filter(l => /\[Collision\]|\[Walk\] spawn/.test(l))) {
    console.log('LOG: ' + l)
  }
  for (const l of walkLogs.slice(-14)) console.log('TAIL: ' + l)
  for (const l of logs.filter(l => /probe|fell out/.test(l)).slice(0, 12)) console.log('PROBE: ' + l)

  app.exit(0)
})
