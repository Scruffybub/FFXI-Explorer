/**
 * Verifies animation actually deforms the mesh: samples vertex positions at two
 * moments and reports how far they moved. A still model reports ~0.
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const { join } = require('path')
const { promises: fs } = require('fs')
const { execFile } = require('child_process')
const { promisify } = require('util')
const execFileAsync = promisify(execFile)

const wanted = (process.argv[2] || 'goblin').toLowerCase()
const outFile = process.argv[3] || join(process.cwd(), 'anim.png')

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

const SAMPLE = `
(() => {
  const s = window.__modelScene;
  if (!s) return JSON.stringify({ error: 'no scene' });
  const out = [];
  s.traverse(function (o) {
    if (!o.isMesh) return;
    const p = o.geometry.attributes.position;
    if (!p) return;
    const take = [];
    for (let k = 0; k < Math.min(40, p.count); k++) {
      take.push(p.getX(k), p.getY(k), p.getZ(k));
    }
    out.push(take);
  });
  return JSON.stringify(out);
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
    width: 1400, height: 900, show: true, backgroundColor: '#0b0d12',
    webPreferences: {
      preload: join(__dirname, '../out/preload/index.js'),
      sandbox: false, contextIsolation: true, nodeIntegration: false,
    },
  })

  const logs = []
  win.webContents.on('console-message', (_e, _l, msg) => logs.push(msg))

  await win.loadFile(
    'C:\\Users\\ryans\\ffxi-zone-viewer\\out\\renderer\\index.html',
    { search: 'modeldebug=1' },
  )
  await new Promise(r => setTimeout(r, 4000))

  await win.webContents.executeJavaScript(`
    (() => {
      const b = [...document.querySelectorAll('.view-switch button')]
        .find(x => x.textContent.trim() === 'Models');
      if (b) b.click();
      return true;
    })()
  `)
  await new Promise(r => setTimeout(r, 700))

  await win.webContents.executeJavaScript(`
    (() => {
      const input = document.querySelector('.search');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(wanted)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `)
  await new Promise(r => setTimeout(r, 700))

  const picked = await win.webContents.executeJavaScript(`
    (() => {
      const f = document.querySelector('.zone-list li button');
      if (!f) return null;
      const n = f.querySelector('.zone-name').textContent;
      f.click();
      return n;
    })()
  `)
  console.log('picked: ' + picked)
  await new Promise(r => setTimeout(r, 5000))

  const a = JSON.parse(await win.webContents.executeJavaScript(SAMPLE))
  await new Promise(r => setTimeout(r, 900))
  const b = JSON.parse(await win.webContents.executeJavaScript(SAMPLE))

  if (a.error || b.error) {
    console.log('SAMPLE ERROR: ' + JSON.stringify(a.error || b.error))
  } else {
    let maxDelta = 0, totalDelta = 0, n = 0, nan = 0
    for (let m = 0; m < Math.min(a.length, b.length); m++) {
      for (let i = 0; i < Math.min(a[m].length, b[m].length); i += 3) {
        const dx = b[m][i] - a[m][i]
        const dy = b[m][i + 1] - a[m][i + 1]
        const dz = b[m][i + 2] - a[m][i + 2]
        if (!isFinite(dx) || !isFinite(dy) || !isFinite(dz)) { nan++; continue }
        const d = Math.hypot(dx, dy, dz)
        if (d > maxDelta) maxDelta = d
        totalDelta += d
        n++
      }
    }
    console.log(`MOTION: meshes=${a.length} sampled=${n} maxDelta=${maxDelta.toFixed(4)} ` +
      `meanDelta=${(totalDelta / Math.max(n, 1)).toFixed(4)} nonFinite=${nan}`)
  }

  const image = await win.webContents.capturePage()
  await fs.writeFile(outFile, image.toPNG())
  console.log('SCREENSHOT: ' + outFile)
  for (const l of logs.filter(l => /error|Model/i.test(l)).slice(0, 6)) console.log('LOG: ' + l)
  app.exit(0)
})
