/**
 * Verification harness: lists every control the settings panel renders, in
 * order, with whether it carries an info icon — so a refactor can be checked
 * for having quietly dropped one. Prints "type | label | info".
 *
 *   npx electron scripts/panel-inventory.cjs
 *   EXTRA_QUERY="&light_mode=lit&scene_cameraMode=walk" npx electron scripts/panel-inventory.cjs
 *
 * Controls behind a condition only appear when that condition holds, which is
 * what EXTRA_QUERY is for: one run in the default state and one with lit mode,
 * walk mode and the optional effects on covers nearly all of them.
 */
const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const { join } = require('path')
const { promises: fs } = require('fs')
const { execFile } = require('child_process')
const { promisify } = require('util')
const execFileAsync = promisify(execFile)

async function detect() {
  try {
    const { stdout } = await execFileAsync('reg', ['query', 'HKLM\\SOFTWARE\\WOW6432Node\\PlayOnlineUS\\InstallFolder', '/v', '0001'])
    const m = stdout.match(/REG_SZ\s+(.+)/)
    if (m) return m[1].trim().replace(/[\\/]+$/, '')
  } catch { /* ignore */ }
  return 'C:\\Program Files (x86)\\PlayOnline\\SquareEnix\\FINAL FANTASY XI'
}

app.whenReady().then(async () => {
  ipcMain.handle('ffxi:autoDetect', () => detect())
  ipcMain.handle('ffxi:pickDirectory', () => ({ status: 'cancelled' }))
  ipcMain.handle('ffxi:readDat', async (_e, root, rel) =>
    fs.readFile(join(root, ...rel.replace(/\\/g, '/').split('/'))))
  ipcMain.handle('ffxi:fileExists', async (_e, root, rel) => {
    try { await fs.stat(join(root, ...rel.replace(/\\/g, '/').split('/'))); return true } catch { return false }
  })

  const win = new BrowserWindow({
    width: 1600, height: 900, show: false,
    webPreferences: {
      preload: process.env.APP_PRELOAD || join(__dirname, '../out/preload/index.js'),
      sandbox: false, contextIsolation: true, nodeIntegration: false,
    },
  })
  await win.loadFile(process.env.APP_HTML || join(__dirname, '../out/renderer/index.html'), {
    search: 'zone=100&preset=0' + (process.env.EXTRA_QUERY || ''),
  })
  await new Promise(r => setTimeout(r, 14000))

  const list = await win.webContents.executeJavaScript(`
    (() => {
      const out = []
      const panel = document.querySelector('.panel')
      if (!panel) return 'NO PANEL'
      for (const el of panel.querySelectorAll('.section-head, .control, select, .note')) {
        // Strip the info icon's own text, so labels compare against the
        // inventory taken before the icons existed.
        const labelOf = e => {
          const c = e.cloneNode(true)
          c.querySelectorAll('.info').forEach(i => i.remove())
          const span = c.querySelector('span')
          return span ? span.textContent.trim() : ''
        }
        if (el.matches('.section-head')) {
          out.push('SECTION | ' + labelOf(el))
        } else if (el.matches('.control')) {
          const type = el.querySelector('input[type=range]') ? 'slider'
            : el.querySelector('input[type=checkbox]') ? 'toggle'
            : el.querySelector('input[type=color]') ? 'color'
            : el.querySelector('select') ? 'select' : 'other'
          const label = labelOf(el)
          const info = el.querySelector('.info') ? 'info' : '-'
          out.push(type + ' | ' + label + ' | ' + info)
        } else if (el.matches('.note')) {
          out.push('NOTE | ' + el.textContent.trim().slice(0, 60).replace(/\\s+/g, ' '))
        }
      }
      return out.join('\\n')
    })()
  `)
  console.log('--- INVENTORY START ---')
  console.log(list)
  console.log('--- INVENTORY END ---')
  app.exit(0)
})
dialog.showErrorBox = (t, c) => console.log('DIALOG ' + t + c)
