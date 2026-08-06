/**
 * Exercises the real point-light placement path: clicks the "Place a light"
 * button, then clicks into the 3D view so the raycast runs for real.
 *
 *   npx electron scripts/pointlight-test.cjs <zoneId> <outFile>
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const { join } = require('path')
const { promises: fs } = require('fs')
const { execFile } = require('child_process')
const { promisify } = require('util')

const execFileAsync = promisify(execFile)

const zoneId = process.argv[2] || '241'
const outFile = process.argv[3] || join(process.cwd(), 'pointlight.png')

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

  const W = 1500, H = 850
  const win = new BrowserWindow({
    width: W, height: H, show: false, backgroundColor: '#0b0d12',
    webPreferences: {
      preload: join(__dirname, '../out/preload/index.js'),
      sandbox: false, contextIsolation: true, nodeIntegration: false,
    },
  })

  const logs = []
  win.webContents.on('console-message', (_e, _l, msg) => logs.push(msg))

  // Dynamic lighting with the sun almost off, so a point light is unmistakable.
  await win.loadFile(join(__dirname, '../out/renderer/index.html'), {
    search: `zone=${zoneId}&preset=1&light_sunIntensity=0.15&light_ambientIntensity=0.12&post_bloom=false`,
  })
  await new Promise(r => setTimeout(r, 16000))

  const clickedButton = await win.webContents.executeJavaScript(`
    (() => {
      const btn = [...document.querySelectorAll('button')]
        .find(b => b.textContent.trim().startsWith('Place a light'));
      if (!btn) return false;
      btn.click();
      return true;
    })()
  `)
  console.log('placement button clicked: ' + clickedButton)
  await new Promise(r => setTimeout(r, 600))

  // Click into the middle of the 3D viewport (between the two panels).
  const rect = await win.webContents.executeJavaScript(`
    (() => { const c = document.querySelector('canvas'); const r = c.getBoundingClientRect();
      return JSON.stringify({x: r.left + r.width/2, y: r.top + r.height*0.62}); })()
  `)
  const { x, y } = JSON.parse(rect)
  console.log(`clicking viewport at ${Math.round(x)},${Math.round(y)}`)

  win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
  await new Promise(r => setTimeout(r, 120))
  win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
  await new Promise(r => setTimeout(r, 2500))

  const state = await win.webContents.executeJavaScript(`
    (() => {
      const items = document.querySelectorAll('.light-list li');
      const editor = document.querySelector('.light-editor');
      return JSON.stringify({ lightCount: items.length, editorOpen: !!editor });
    })()
  `)
  console.log('PANEL STATE: ' + state)

  // Crank the placed light up so its effect is obvious in the capture.
  await win.webContents.executeJavaScript(`
    (() => {
      const sliders = [...document.querySelectorAll('.light-editor input[type=range]')];
      if (!sliders.length) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(sliders[0], '160');
      sliders[0].dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `)
  await new Promise(r => setTimeout(r, 2000))

  const img = await win.webContents.capturePage()
  await fs.writeFile(outFile, img.toPNG())
  console.log('SCREENSHOT: ' + outFile)

  const errs = logs.filter(l => /error|nan|undefined is not/i.test(l))
  console.log(errs.length ? 'LOG HITS:\n' + errs.slice(0, 8).join('\n') : 'no error logs')
  app.exit(0)
})
