/**
 * Verification harness: launches the built app, loads a zone, waits for the
 * renderer to settle, writes a PNG, and exits.
 *
 *   npx electron scripts/smoke.cjs <zoneId> <presetIndex> <outFile> [waitMs]
 */
const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const { join } = require('path')
const { promises: fs } = require('fs')
const { execFile } = require('child_process')
const { promisify } = require('util')

const execFileAsync = promisify(execFile)

const zoneId = process.argv[2] || '103'
const presetIdx = process.argv[3] || '0'
const outFile = process.argv[4] || join(process.cwd(), 'smoke.png')
const waitMs = Number(process.argv[5] || 9000)

const VALIDATION_ENTRIES = ['ROM', 'ROM2', 'VTABLE.DAT']

async function isValidFfxiDir(dir) {
  for (const entry of VALIDATION_ENTRIES) {
    try { await fs.stat(join(dir, entry)) } catch { return false }
  }
  return true
}

async function autoDetectFfxiPath() {
  const keys = [
    'HKLM\\SOFTWARE\\WOW6432Node\\PlayOnlineUS\\InstallFolder',
    'HKLM\\SOFTWARE\\WOW6432Node\\PlayOnlineEU\\InstallFolder',
  ]
  for (const key of keys) {
    try {
      const { stdout } = await execFileAsync('reg', ['query', key, '/v', '0001'])
      const m = stdout.match(/REG_SZ\s+(.+)/)
      if (m) {
        const dir = m[1].trim().replace(/[\\/]+$/, '')
        if (await isValidFfxiDir(dir)) return dir
      }
    } catch { /* next */ }
  }
  for (const dir of ['C:\\FFXI-Data', 'C:\\Program Files (x86)\\PlayOnline\\SquareEnix\\FINAL FANTASY XI']) {
    if (await isValidFfxiDir(dir)) return dir
  }
  return null
}

app.whenReady().then(async () => {
  ipcMain.handle('ffxi:autoDetect', () => autoDetectFfxiPath())
  ipcMain.handle('ffxi:pickDirectory', () => ({ status: 'cancelled' }))
  ipcMain.handle('ffxi:readDat', async (_e, root, rel) => {
    return fs.readFile(join(root, ...rel.replace(/\\/g, '/').split('/')))
  })
  ipcMain.handle('ffxi:fileExists', async (_e, root, rel) => {
    try { await fs.stat(join(root, ...rel.replace(/\\/g, '/').split('/'))); return true }
    catch { return false }
  })

  const win = new BrowserWindow({
    width: 1600,
    height: 900,
    show: false,
    backgroundColor: '#0b0d12',
    webPreferences: {
      preload: join(__dirname, '../out/preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  const logs = []
  win.webContents.on('console-message', (_e, level, message) => {
    logs.push(`[${level}] ${message}`)
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    console.log('RENDERER GONE:', JSON.stringify(details))
  })

  await win.loadFile(join(__dirname, '../out/renderer/index.html'), {
    search: `zone=${zoneId}&preset=${presetIdx}${process.env.EXTRA_QUERY || ''}`,
  })

  await new Promise(r => setTimeout(r, waitMs))

  // Report what the page actually shows, so a blank render is obvious.
  const state = await win.webContents.executeJavaScript(`
    (() => {
      const hud = document.querySelector('.hud');
      const ph = document.querySelector('.placeholder');
      const canvas = document.querySelector('canvas');
      return JSON.stringify({
        href: window.location.href,
        search: window.location.search,
        hud: hud ? hud.innerText.replace(/\\n/g, ' | ') : null,
        placeholder: ph ? ph.innerText.replace(/\\n/g, ' | ') : null,
        canvas: canvas ? canvas.width + 'x' + canvas.height : null,
        zoneCount: document.querySelectorAll('.zone-list li').length,
      });
    })()
  `)
  console.log('PAGE STATE: ' + state)

  const image = await win.webContents.capturePage()
  await fs.writeFile(outFile, image.toPNG())
  console.log('SCREENSHOT: ' + outFile)

  // Widen this to surface whatever you are hunting. Shader compile failures are
  // permanently in the list: a silent "program not valid" hid a broken water
  // shader for days, because a failed program drops its draws without erroring.
  const errors = logs.filter(l =>
    /MUSIC|WEATHER|ORPHANSRC|MZBMATCH|MMBNAMES|BLEND|NANSCAN|CUTOUT|Collision|Walk|unreferenced|ORPHANS|PICK|CENSUS|program not valid|VALIDATE_STATUS|shader|THREE\.\w+Error|Warning:/i.test(l),
  )
  if (errors.length) console.log('CONSOLE ERRORS:\n' + errors.slice(0, 25).join('\n'))
  else console.log('No console errors.')

  app.exit(0)
})

// Never block on a dialog during an automated run.
dialog.showErrorBox = (title, content) => console.log('DIALOG: ' + title + ' — ' + content)
