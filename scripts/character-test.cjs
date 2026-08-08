/**
 * Builds a player character and reports what loaded.
 *
 *   npx electron scripts/character-test.cjs <raceIndex> <outFile>
 *
 * Switches to Character mode, equips one piece in each slot, and screenshots.
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const { join } = require('path')
const { promises: fs } = require('fs')
const { execFile } = require('child_process')
const { promisify } = require('util')
const execFileAsync = promisify(execFile)

const raceIdx = Number(process.argv[2] || 0)
const outFile = process.argv[3] || join(process.cwd(), 'character.png')

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

/** Pick the nth option of a <select> the way a user would. */
function selectNth(selector, n) {
  return `
    (() => {
      const els = [...document.querySelectorAll('.builder select')];
      const el = els[${selector}];
      if (!el) return 'missing';
      const opts = [...el.options];
      const idx = Math.min(${n}, opts.length - 1);
      if (idx < 0) return 'empty';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(el, opts[idx].value);
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return opts[idx].text.slice(0, 40);
    })()
  `
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
    width: 1400, height: 900, show: true, backgroundColor: '#0b0d12',
    webPreferences: {
      preload: join(__dirname, '../out/preload/index.js'),
      sandbox: false, contextIsolation: true, nodeIntegration: false,
    },
  })

  const logs = []
  win.webContents.on('console-message', (_e, _l, msg) => logs.push(msg))

  await win.loadFile(join(__dirname, '../out/renderer/index.html'), {
    search: 'modeldebug=1',
  })
  await new Promise(r => setTimeout(r, 4000))

  await win.webContents.executeJavaScript(`
    (() => {
      const b = [...document.querySelectorAll('.view-switch button')]
        .find(x => x.textContent.trim() === 'Models');
      if (b) b.click();
      return true;
    })()
  `)
  await new Promise(r => setTimeout(r, 600))

  await win.webContents.executeJavaScript(`
    (() => {
      const b = [...document.querySelectorAll('.mode-switch button')]
        .find(x => x.textContent.trim() === 'Character');
      if (b) b.click();
      return true;
    })()
  `)
  await new Promise(r => setTimeout(r, 2500))

  // select 0 = race, 1 = face, 2..9 = the eight equipment slots
  console.log('race: ' + await win.webContents.executeJavaScript(selectNth(0, raceIdx)))
  await new Promise(r => setTimeout(r, 1500))

  for (let slot = 2; slot <= 6; slot++) {
    const label = await win.webContents.executeJavaScript(selectNth(slot, 1))
    console.log(`slot ${slot}: ${label}`)
    await new Promise(r => setTimeout(r, 1200))
  }
  await new Promise(r => setTimeout(r, 2500))

  const state = await win.webContents.executeJavaScript(`
    (() => {
      const hud = document.querySelector('.hud');
      const ph = document.querySelector('.placeholder');
      return JSON.stringify({
        hud: hud ? hud.innerText.replace(/\\n/g, ' | ') : null,
        placeholder: ph ? ph.innerText.replace(/\\n/g, ' | ') : null
      });
    })()
  `)
  console.log('STATE: ' + state)

  const image = await win.webContents.capturePage()
  await fs.writeFile(outFile, image.toPNG())
  console.log('SCREENSHOT: ' + outFile)
  for (const l of logs.filter(l => /error|Model/i.test(l)).slice(0, 8)) console.log('LOG: ' + l)
  app.exit(0)
})
