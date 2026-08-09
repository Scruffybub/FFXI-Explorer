/**
 * Loads many zones in one run and reports the largest unreferenced prefab still
 * being drawn in each — the shape a stray sky or weather dome takes.
 *
 *   npx electron scripts/orphan-sweep.cjs [count] [waitMs]
 *
 * Anything with a big width+depth and real height is a dome candidate; flat
 * things of similar span are usually water planes and belong.
 */
const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const { join } = require('path')
const { promises: fs } = require('fs')
const { execFile } = require('child_process')
const { promisify } = require('util')
const execFileAsync = promisify(execFile)

const count = Number(process.argv[2] || 20)
const waitMs = Number(process.argv[3] || 9000)
/** Report anything at least this wide+deep. */
const BIG = 120

async function isValidFfxiDir(dir) {
  for (const e of ['ROM', 'ROM2', 'VTABLE.DAT']) {
    try { await fs.stat(join(dir, e)) } catch { return false }
  }
  return true
}
async function detect() {
  for (const key of [
    'HKLM\\SOFTWARE\\WOW6432Node\\PlayOnlineUS\\InstallFolder',
    'HKLM\\SOFTWARE\\WOW6432Node\\PlayOnlineEU\\InstallFolder',
  ]) {
    try {
      const { stdout } = await execFileAsync('reg', ['query', key, '/v', '0001'])
      const m = stdout.match(/REG_SZ\s+(.+)/)
      if (m) {
        const d = m[1].trim().replace(/[\\/]+$/, '')
        if (await isValidFfxiDir(d)) return d
      }
    } catch { /* next */ }
  }
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
    width: 1200, height: 800, show: false, backgroundColor: '#0b0d12',
    webPreferences: {
      preload: join(__dirname, '../out/preload/index.js'),
      sandbox: false, contextIsolation: true, nodeIntegration: false,
    },
  })

  let logs = []
  win.webContents.on('console-message', (_e, _l, msg) => logs.push(msg))

  await win.loadFile(join(__dirname, '../out/renderer/index.html'))
  await new Promise(r => setTimeout(r, 3500))

  const total = await win.webContents.executeJavaScript(
    `document.querySelectorAll('.zone-list li button').length`,
  )
  const step = Math.max(1, Math.floor(total / count))
  console.log(`sweeping ${count} of ${total} zones, every ${step}`)

  const flagged = []
  for (let n = 0; n < count; n++) {
    const idx = n * step
    logs = []
    const name = await win.webContents.executeJavaScript(`
      (() => {
        const b = document.querySelectorAll('.zone-list li button')[${idx}];
        if (!b) return null;
        const n = b.querySelector('.zone-name').textContent;
        b.click();
        return n;
      })()
    `)
    if (!name) continue
    await new Promise(r => setTimeout(r, waitMs))

    const line = logs.find(l => l.includes('[ORPHANS]'))
    if (!line) { console.log(`${name}: no orphan report (failed to load?)`); continue }
    const json = line.slice(line.indexOf('['), line.lastIndexOf(']') + 1)
    let list = []
    try { list = JSON.parse(json.slice(json.indexOf('[', 1))) } catch { /* ignore */ }
    const big = list.filter(o => o.w + o.d >= BIG)
    if (big.length) {
      flagged.push({ name, big })
      console.log(`FLAG ${name}: ` + big.map(o =>
        `#${o.i} "${o.name}" ${o.w}x${o.h}x${o.d}`).join(' | '))
    } else {
      const top = list[0]
      console.log(`ok   ${name}: largest ${top ? `${top.w}x${top.h}x${top.d}` : 'none'}`)
    }
  }

  console.log(`\nSUMMARY: ${flagged.length} of ${count} zones have an unreferenced prefab >= ${BIG} across`)
  app.exit(0)
})

dialog.showErrorBox = (t, c) => console.log('DIALOG: ' + t + ' - ' + c)
